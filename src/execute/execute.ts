/**
 * Sign and broadcast the reviewed swap (engine.md §8.2, ARCHITECTURE.md §3.4 and D10) — the browser's version of
 * mobile execute.ts executeSwap:
 *
 *   - called ONLY from the review's Confirm, with the signer wallets.getSigner returned (EVM: already switched);
 *   - one execution per payer and chain across tabs (Web Locks), a fresh gate per execution;
 *   - EVM smart-contract accounts are refused; the wallet's account must be the reviewed refund address (EVM,
 *     Solana, Tron, TON; NEAR: the account the wallet still lists);
 *   - a Tron wallet only signs: its account builds, checks and broadcasts the transfer (accounts/tron.ts);
 *   - the engine gets the GATED account only, `router: appRouter().only(provider)` and the reviewed `routeId` of a venue
 *     with several routes (D47: every quote of the execution, re-quotes included, asks exactly that route; the gate
 *     refuses a plan of another), `reviewExecution` = checkPlanBrowser
 *     → planWrites → arm (re-armed on a requoted plan), and never `accountChain` / `skipAccountChainCheck` (the live
 *     wallet chain is the identity the engine checks) — engineConfig below is the only place the config is built;
 *   - a TON payer's engine also gets `decodeTonBody` and `tonGasCeiling` (D35): the decoder keeps the exact BoC of a
 *     contract call, which checkPlanBrowser reads, the venue's asynchronous binding reads too (checkTonCallBinding:
 *     Omniston's escrow against the secret this browser holds and its package's verifiers), planWrites arms and the
 *     TON account signs; the TON account only signs the reviewed route's own call (tonPlan.ts tonCallOf);
 *   - the gate is disarmed whatever happens; the shared providers are never closed.
 */
import type {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import {RouterSwap2Protocol, type RouterSwap2Config} from "@anywalletkit/protocol-swap2-router/swap2/router";
import type {Swap2ExecutionPlan, Swap2NativeFeeCeilingContext} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {ccAsset, ccAssetByToken, isTokenAddress} from "@anywalletkit/swap2-assets";
import type {SwapToken} from "../contracts/domain";
import type {
  EvmSourceSigner,
  ExecuteResult,
  ExecutionPhase,
  ExecutionPhaseDetail,
  NearSourceSigner,
  ReviewedSwap,
  SourceSigner,
  TronSourceSigner,
} from "../contracts/execution";
import {chainByCaip2Web, destTokenId, isAddressFor} from "../catalog";
import {appRouter} from "../swap";
import {assertEoa, assertEvmWallet, evmEngineAccount, type EvmReads} from "./accounts/evm";
import {gateAccount} from "./accounts/gated";
import {assertNearAccount, nearEngineAccount, type NearReads} from "./accounts/near";
import {signingWindow, solanaEngineAccount, type SigningWindow} from "./accounts/solana";
import {TRON_CHAIN, tronEngineAccount, type TronApi} from "./accounts/tron";
import type {TonAccountDeps} from "./accounts/ton";
import type {TonBody} from "./tonGate";
import {refusal} from "./errors";
import {
  checkPlanBrowser,
  createSwapGate,
  executionConstraints,
  planWrites,
  type Revoke,
  same,
  SwapReviewMismatch,
  TON_BODY_GAS,
  type SwapGate,
  type TronRule,
  type VenueRule,
} from "./gate";
import {swapLockName, withSwapLock} from "./locks";
import {tronRule, venueRule} from "./pins";
import {checkTonCallBinding, tonCallOf} from "./tonPlan";

/** executeSwap's input (mobile ExecuteInput with the signer instead of an account id). */
export interface ExecuteSwapInput {
  from: SwapToken;
  to: SwapToken;
  reviewed: ReviewedSwap;
  signer: SourceSigner;
  onPhase?: (phase: ExecutionPhase, detail?: ExecutionPhaseDetail) => void;
}

/** What executeSwap reaches that tests replace (no network, no wallet). Production passes nothing. */
export interface ExecuteDeps {
  /** The one-provider router; default `appRouter().only(provider)`. */
  router?: (provider: string) => CrossChainRouter;
  /** EVM reads (balance, allowance, gas quote, simulation); default the SDK's read-only account over the RPC list. */
  evmReads?: (signer: EvmSourceSigner) => EvmReads;
  /** The pause before a revert just after an approval is asked again (accounts/evm.ts RECHECK_MS). */
  evmRecheckMs?: number;
  /** The venue's EVM rule; default pins.ts. */
  venueRule?: (provider: string) => VenueRule | undefined;
  /** The venue's Tron rule; default pins.ts. */
  tronRule?: (provider: string) => TronRule | undefined;
  /** The Tron node API (reference block, dry run, broadcast); default the signer's runtime Tron API hosts. */
  tronApi?: (signer: TronSourceSigner) => TronApi;
  /** The TON account's network and clock (TonAPI, query ids); default the browser's. */
  tonAccount?: TonAccountDeps;
  /** NEAR reads (the account's NEAR, a token's storage registration); default the signer's NEAR RPCs. */
  nearReads?: (signer: NearSourceSigner) => NearReads;
}

/**
 * The engine config for one execution: the shared router narrowed to the reviewed venue, the review hook, phases and
 * the one native-fee ceiling below; for a TON payer (`decodeTonBody` given, tonGate.ts captureTonBody) also the cell
 * body's decoder and its gas ceiling, TON_BODY_GAS (0.5 TON, not the engine's default 1 TON). Deliberately has no
 * `accountChain` / `skipAccountChainCheck` (a unit test asserts the keys).
 */
export function engineConfig(o: {
  fromChain: string;
  router: CrossChainRouter;
  reviewExecution: (plan: Swap2ExecutionPlan) => void | Promise<void>;
  onExecutionPhase?: (phase: ExecutionPhase, detail?: ExecutionPhaseDetail) => void;
  decodeTonBody?: (boc: string) => TonBody;
  /** The reviewed route of a venue with several (D47): the router asks the venue for exactly it, never its default. */
  routeId?: string;
  /**
   * A side is a token imported by its address (D39): swap2-core 0.14.0's `allowUnlistedTokens`, set for that execution
   * only — a catalog pair runs with exactly the config it always had. The engine then reads the source's decimals with
   * the account's getTokenInfo and refuses ours if they differ.
   */
  unlisted?: boolean;
}): RouterSwap2Config {
  return {
    fromChain: o.fromChain,
    router: o.router,
    reviewExecution: o.reviewExecution,
    onExecutionPhase: (phase, detail) => o.onExecutionPhase?.(phase, detail),
    nativeFeeCeiling,
    ...(o.routeId !== undefined ? {routeId: o.routeId} : {}),
    ...(o.decodeTonBody ? {decodeTonBody: o.decodeTonBody, tonGasCeiling: TON_BODY_GAS} : {}),
    ...(o.unlisted ? {allowUnlistedTokens: true} : {}),
  };
}

/**
 * USDT0's Legacy Mesh into Tron (owner's decision, 2026-11-13): its LayerZero fee (≈ 0.0053 ETH on 2026-11-12, sealed
 * with the provider's 25 % headroom ≈ 0.0067 ETH; the endpoint refunds the unused part in the same transaction) is above
 * the engine's 0.005 ETH cap, so that one route may pay up to 0.01 ETH from Ethereum or Arbitrum. Celo, its third
 * source, sends a USDT the catalog doesn't list, so the pickers never reach it. Tron is LayerZero eid 30420.
 */
const TRON_MESH_FEE_CEILING: ReadonlyMap<string, bigint> = new Map([
  ["eip155:1", 10n ** 16n],
  ["eip155:42161", 10n ** 16n],
]);
const TRON_MESH_INTENT = /^usdt0-mesh:\d+:30420(?:~|$)/;

/**
 * Stargate's LayerZero messaging fee, paid in the source network's coin (sealed with headroom the endpoint refunds), is
 * above or at the engine's cap from two of its networks (2026-11-17): 0.231 AVAX from Avalanche against 0.1, and 19.4
 * POL from Polygon against 20. Those two may pay up to about twice what they charged; every other Stargate network's
 * fee is well under its default cap (0.0009–0.001 ETH, 0.0026 BNB, 4.3 MNT, 50 S, 38 XPL, 40 SEI, 130 PLUME, 671 FLR).
 */
const STARGATE_FEE_CEILING: ReadonlyMap<string, bigint> = new Map([
  ["eip155:43114", 5n * 10n ** 17n], // 0.5 AVAX
  ["eip155:137", 40n * 10n ** 18n], // 40 POL
]);

/** The engine's per-execution native-fee cap (swap2-core 0.11.0): the Tron mesh and Stargate above, the chain's default for every other route. */
export function nativeFeeCeiling({provider, intentId, fromChain, destChain}: Swap2NativeFeeCeilingContext): bigint | undefined {
  if (provider === "stargate") return STARGATE_FEE_CEILING.get(fromChain);
  return provider === "usdt0" && destChain === "tron:728126428" && TRON_MESH_INTENT.test(intentId) ? TRON_MESH_FEE_CEILING.get(fromChain) : undefined;
}

const evmId = (caip2: string) => (caip2.startsWith("eip155:") ? Number(caip2.slice("eip155:".length)) : NaN);

/** The reviewed swap, the tokens and the signer must describe the same swap before anything else runs. */
function assertCoherent({from, to, reviewed, signer}: ExecuteSwapInput): void {
  const bad = (why: string) => new SwapReviewMismatch(why);
  if (reviewed.fromChain !== from.caip2 || reviewed.destChain !== to.caip2) throw bad("the networks or the token changed");
  if ((reviewed.fromContract === null) !== (from.contract === null) || (from.contract !== null && !same(reviewed.fromContract ?? undefined, from.contract)))
    throw bad("the token you pay changed");
  if (from.imported) {
    // An imported token (D39) is named by its contract: a token address on that network that the catalog doesn't
    // list (a listed one is always named by its catalog symbol), the very contract the review showed.
    if (!from.contract || !isTokenAddress(from.caip2, from.contract) || ccAssetByToken(from.caip2, from.contract) || !same(from.contract, reviewed.fromContract ?? undefined))
      throw bad("the token you pay changed");
  } else {
    // The engine names the source by catalog symbol: it must resolve to the very token the review showed.
    const asset = ccAsset(from.caip2, from.catalogSymbol);
    const assetContract = asset?.contract ?? null;
    if (
      !asset ||
      (assetContract === null) !== (reviewed.fromContract === null) ||
      (assetContract !== null && !same(assetContract, reviewed.fromContract ?? undefined))
    )
      throw bad("the token you pay changed");
  }
  if (to.imported && (!to.contract || !isTokenAddress(to.caip2, to.contract) || ccAssetByToken(to.caip2, to.contract))) throw bad("the networks or the token changed");
  if (!same(reviewed.destToken, destTokenId(to))) throw bad("the networks or the token changed");
  if (reviewed.amountIn <= 0n) throw bad("the amount is not positive");
  if (reviewed.minOut <= 0n) throw bad("the review has no minimum to hold the route to");
  if (!Number.isInteger(reviewed.slippageBps) || reviewed.slippageBps < 0 || reviewed.slippageBps >= 10_000) throw bad("the slippage is out of range");
  if (reviewed.nativeFee < 0n) throw bad("the reviewed fee is malformed");
  if (!isAddressFor(to.family, reviewed.recipient)) throw bad(`the recipient isn't a ${to.chainName} address`);
  if (!isAddressFor(from.family, reviewed.refundAddress)) throw bad(`the refund address isn't a ${from.chainName} address`);
  if (signer.family === "evm") {
    if (from.family !== "evm") throw refusal(`Connect a wallet that signs on ${from.chainName} — nothing was sent.`);
    if (signer.chain.id !== evmId(reviewed.fromChain)) throw refusal(`Switch your wallet to ${from.chainName} to swap — nothing was sent.`);
    if (!same(signer.owner, reviewed.refundAddress)) throw bad("the connected wallet isn't the reviewed one");
  } else if (signer.family === "tron") {
    if (from.family !== "tron" || reviewed.fromChain !== TRON_CHAIN) throw refusal(`Connect a wallet that signs on ${from.chainName} — nothing was sent.`);
    if (signer.owner !== reviewed.refundAddress) throw bad("the connected wallet isn't the reviewed one");
  } else if (signer.family === "near") {
    if (from.family !== "near" || reviewed.fromChain !== "near:mainnet") throw refusal(`Connect a wallet that signs on ${from.chainName} — nothing was sent.`);
    if (signer.accountId !== reviewed.refundAddress) throw bad("the connected wallet isn't the reviewed one");
  } else if (signer.family === "solana") {
    if (from.family !== "solana" || !reviewed.fromChain.startsWith("solana:")) throw refusal(`Connect a wallet that signs on ${from.chainName} — nothing was sent.`);
    if (signer.account.address !== reviewed.refundAddress) throw bad("the connected wallet isn't the reviewed one");
  } else {
    if (from.family !== "ton" || reviewed.fromChain !== "ton:-239") throw refusal(`Connect a wallet that signs on ${from.chainName} — nothing was sent.`);
    if (signer.address !== reviewed.refundAddress) throw bad("the connected wallet isn't the reviewed one");
  }
}

/** Sign and broadcast the reviewed swap. Call ONLY from the review's Confirm. */
export async function executeSwap(input: ExecuteSwapInput, deps: ExecuteDeps = {}): Promise<ExecuteResult> {
  assertCoherent(input);
  const {from, to, reviewed} = input;
  return withSwapLock(swapLockName(reviewed.fromChain, reviewed.refundAddress), async () => {
    // A CoW signature (D48) has no engine phase of its own: the gate names it as the wallet is asked.
    const gate = createSwapGate(reviewed.fromChain, (kind) => input.onPhase?.("signing", kind === "gpv2Permit" ? {permit: true} : undefined));
    const signWindow = signingWindow();
    const account = await openAccount(input, gate, signWindow, deps);
    // A TON payer's cell body (D35): the BoC the engine is handed is what is checked, armed and signed.
    const tonBody = input.signer.family === "ton" ? (await import("./tonGate")).captureTonBody() : undefined;

    const rule = (deps.venueRule ?? venueRule)(reviewed.provider);
    const tron = (deps.tronRule ?? tronRule)(reviewed.provider);
    let depositTo: string | undefined;
    let revokes: Revoke[] = [];
    const arm = async (plan: Swap2ExecutionPlan) => {
      // The BoC the plan carries, read once: the plan check, the venue's binding and the armed write all see these bytes.
      const boc = tonBody?.boc();
      const why = checkPlanBrowser(plan, reviewed, rule, tron, tonBody) ?? (await checkTonCallBinding(plan, reviewed, boc));
      if (why) throw new SwapReviewMismatch(why);
      if (tonBody?.boc() !== boc) throw new SwapReviewMismatch("the TON contract call's body changed while it was checked");
      const planned = planWrites(plan, boc, reviewed);
      const s = plan.source;
      depositTo = s.kind === "call" ? s.to : s.kind === "token-transfer" ? s.recipient : undefined;
      // The re-quote pass spends the allowance the first pass granted: its revoke stays armed.
      if (planned.revokes.length) revokes = planned.revokes;
      gate.arm(planned.writes, revokes);
    };
    const router = deps.router ? deps.router(reviewed.provider) : appRouter().only(reviewed.provider);
    const protocol = new RouterSwap2Protocol(
      account,
      engineConfig({
        fromChain: reviewed.fromChain,
        router,
        ...(reviewed.routeId !== undefined ? {routeId: reviewed.routeId} : {}),
        reviewExecution: arm,
        ...(input.onPhase ? {onExecutionPhase: input.onPhase} : {}),
        ...(tonBody ? {decodeTonBody: tonBody.decodeTonBody} : {}),
        ...(from.imported || to.imported ? {unlisted: true} : {}),
      }),
    );
    try {
      const res = await protocol.swap2({
        // An imported source (D39) by its contract and the decimals read on-chain (the engine re-reads and compares
        // them); an imported destination's decimals hold a bridge leg's reviewed minimum (bridgeOut.destDecimals).
        ...(from.imported && from.contract ? {fromToken: from.contract, fromTokenDecimals: from.decimals} : {fromToken: from.catalogSymbol}),
        toToken: destTokenId(to),
        ...(to.imported ? {toTokenDecimals: to.decimals} : {}),
        ...(to.caip2 !== from.caip2 ? {toChain: to.caip2} : {}),
        fromTokenAmount: reviewed.amountIn,
        recipient: reviewed.recipient,
        refundAddress: reviewed.refundAddress,
        ...executionConstraints(reviewed),
      });
      return {id: res.id, ...(res.hash ? {hash: res.hash} : {}), ...(depositTo ? {depositTo} : {})};
    } finally {
      gate.disarm(); // never protocol.close(): the providers are shared (D2)
    }
  });
}

/** The raw engine account for the signer's family, checked, then gated. */
async function openAccount(input: ExecuteSwapInput, gate: SwapGate, signWindow: SigningWindow, deps: ExecuteDeps): Promise<object> {
  const {reviewed, signer, from} = input;
  if (signer.family === "evm") {
    await assertEvmWallet(signer);
    await assertEoa(signer.pub, signer.owner, chainByCaip2Web(reviewed.fromChain)?.name ?? from.chainName);
    const raw = evmEngineAccount(signer, {...(deps.evmReads ? {reads: deps.evmReads(signer)} : {}), ...(deps.evmRecheckMs !== undefined ? {recheckMs: deps.evmRecheckMs} : {})});
    if (!same(await raw.getAddress(), reviewed.refundAddress)) throw new SwapReviewMismatch("the connected wallet isn't the reviewed one");
    return gateAccount(raw, gate);
  }
  if (signer.family === "tron") {
    const raw = tronEngineAccount(signer, deps.tronApi ? {api: deps.tronApi(signer)} : {});
    if ((await raw.getAddress()) !== reviewed.refundAddress) throw new SwapReviewMismatch("the connected wallet isn't the reviewed one");
    return gateAccount(raw, gate);
  }
  if (signer.family === "ton") {
    // A lazy chunk (with @ton/core): only a TON payer loads it. It signs no contract call but the reviewed route's own.
    const {tonEngineAccount} = await import("./accounts/ton");
    const raw = tonEngineAccount(signer, deps.tonAccount ?? {}, tonCallOf(reviewed));
    if ((await raw.getAddress()) !== reviewed.refundAddress) throw new SwapReviewMismatch("the connected wallet isn't the reviewed one");
    return gateAccount(raw, gate);
  }
  if (signer.family === "near") {
    const raw = nearEngineAccount(signer, signWindow, deps.nearReads ? {reads: deps.nearReads(signer)} : {});
    if ((await raw.getAddress()) !== reviewed.refundAddress) throw new SwapReviewMismatch("the connected wallet isn't the reviewed one");
    await assertNearAccount(signer);
    return gateAccount(raw, gate, signWindow);
  }
  const raw = solanaEngineAccount(signer, signWindow);
  if ((await raw.getAddress()) !== reviewed.refundAddress) throw new SwapReviewMismatch("the connected wallet isn't the reviewed one");
  if (!signer.wallet.accounts.some((a) => a.address === reviewed.refundAddress))
    throw refusal("Your wallet switched accounts — nothing was sent. Switch back to the account you reviewed.");
  return gateAccount(raw, gate, signWindow);
}
