/**
 * Cancelling a resting CoW order (D49) — the activity view's "Cancel order". Like the claim (claim.ts): the
 * cancellation is built read-only first and shown; on confirm exactly ONE write is armed on a fresh gate and the
 * engine's cancelSwap2 sends it through the gated account on the order's own network.
 *
 * - A token sale (`o:<chain>:<uid>`): the free off-chain cancellation — an EIP-712 `OrderCancellations` naming only
 *   that UID, handed to the orderbook. Best effort: a solver that already holds the order may still settle it.
 * - A native-coin sale (`e:<chain>:<order>`): only on chain — eth-flow's `invalidateOrder`, which also returns the
 *   coin. It costs gas.
 *
 * What is armed is built HERE from the record's own id (the UID, the eth-flow order) and the pinned contracts, never
 * taken from the provider's answer: the provider's build must equal it, byte for byte, or nothing is signed.
 */
import type {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import {RouterSwap2Protocol} from "@anywalletkit/protocol-swap2-router/swap2/router";
import {Swap2StatusError} from "@anywalletkit/protocol-swap2-core/errors";
import {COW_DEPLOYMENTS, COW_ETH_FLOW, COW_SETTLEMENT, deploymentOf, encodeInvalidateOrder, parseCowIntent} from "@anywalletkit/protocol-swap2-cow";
import type {CancelPreview, CancelResult, EvmSourceSigner, SourceSigner} from "../contracts/execution";
import {chainByCaip2Web} from "../catalog";
import {appRouter} from "../swap";
import {assertEoa, assertEvmWallet, evmEngineAccount, type EvmReads} from "./accounts/evm";
import {gateAccount} from "./accounts/gated";
import {refusal} from "./errors";
import {createSwapGate, type ArmedWrite} from "./gate";
import {decodeSwapId} from "./ids";

/** What cancels reach that tests replace. */
export interface CancelDeps {
  /** The router the provider is looked up in; default appRouter(). */
  router?: () => CrossChainRouter;
  evmReads?: (signer: EvmSourceSigner) => EvmReads;
}

/** The cancellation this order takes, from its id alone (no provider answer): what the gate will arm. */
function expected(id: string): {chainId: number; chain: string; mode: "offchain"; uid: string} | {chainId: number; chain: string; mode: "onchain"; to: string; data: string} {
  const ref = decodeSwapId(id);
  if (!ref || ref.provider !== "cow") throw refusal("Only a CoW order can be cancelled here.");
  const intent = parseCowIntent(ref.intentId);
  if (!intent || intent.kind === "quote" || !deploymentOf(COW_DEPLOYMENTS, intent.chainId)) throw refusal("This isn't a CoW order this app placed.");
  const chain = `eip155:${intent.chainId}`;
  if (intent.kind === "order") return {chainId: intent.chainId, chain, mode: "offchain", uid: intent.uid.toLowerCase()};
  return {chainId: intent.chainId, chain, mode: "onchain", to: COW_ETH_FLOW, data: encodeInvalidateOrder(intent.data)};
}

/**
 * What cancelling the order takes now (read-only; null when there is nothing left to cancel: it settled, expired or
 * was cancelled already). `owner`: the connected wallet — the provider refuses an order another account placed.
 */
export async function previewCancel(id: string, owner: string, deps: CancelDeps = {}): Promise<CancelPreview | null> {
  const want = expected(id);
  const ref = decodeSwapId(id)!;
  const provider = (deps.router ?? appRouter)().getProvider("cow");
  if (!provider?.buildCancel) throw refusal("CoW isn't available in this build — nothing was signed.");
  const tx = await provider.buildCancel(
    {intentId: ref.intentId, ...(ref.sourceTxHash ? {sourceTxHash: ref.sourceTxHash} : {})},
    {owner, onchain: want.mode === "onchain"},
  );
  if (!tx) return null;
  const bad = () => refusal("The cancellation the venue built isn't the one this order takes — nothing was signed.");
  if (tx.chain !== want.chain || (tx.value !== undefined && tx.value !== "0")) throw bad();
  if (want.mode === "offchain") {
    if (tx.typedData === undefined || tx.data !== undefined) throw bad();
    return {chain: want.chain, mode: "offchain", to: COW_SETTLEMENT, uid: want.uid};
  }
  if (tx.typedData !== undefined || !tx.to || !tx.data) throw bad();
  if (tx.to.toLowerCase() !== want.to.toLowerCase() || tx.data.toLowerCase() !== want.data.toLowerCase()) throw bad();
  return {chain: want.chain, mode: "onchain", to: want.to, data: want.data};
}

/**
 * Cancel the order from the EVM wallet that placed it, already on the order's network. Call ONLY from the cancel's
 * confirm. Off-chain resolves once the orderbook took the cancellation; on-chain, with the transaction's hash.
 */
export async function cancelOrder(id: string, signer: SourceSigner, deps: CancelDeps = {}): Promise<CancelResult> {
  const want = expected(id);
  const chainName = chainByCaip2Web(want.chain)?.name ?? want.chain;
  if (signer.family !== "evm") throw refusal(`Connect the EVM wallet that placed the order on ${chainName} — nothing was signed.`);
  if (`eip155:${signer.chain.id}` !== want.chain) throw refusal(`Switch your wallet to ${chainName} to cancel — nothing was signed.`);
  await assertEvmWallet(signer);
  await assertEoa(signer.pub, signer.owner, chainName);
  const preview = await previewCancel(id, signer.owner, deps);
  if (!preview) throw new Swap2StatusError("swap2: nothing to cancel — the order has settled, expired or was cancelled already");

  const write: ArmedWrite =
    want.mode === "offchain"
      ? {kind: "gpv2Cancel", owner: signer.owner, chainId: want.chainId, uid: want.uid}
      : {kind: "call", to: want.to, data: want.data, value: 0n};
  const gate = createSwapGate(want.chain);
  gate.arm([write]);
  const account = gateAccount(evmEngineAccount(signer, deps.evmReads ? {reads: deps.evmReads(signer)} : {}), gate);
  const protocol = new RouterSwap2Protocol(undefined, {fromChain: want.chain, router: (deps.router ?? appRouter)().only("cow")});
  try {
    const res = await protocol.cancelSwap2(id, account, {onchain: want.mode === "onchain"});
    return res.mode === "onchain" ? {mode: "onchain", hash: res.hash, chain: res.chain} : {mode: "offchain", chain: want.chain};
  } finally {
    gate.disarm(); // never protocol.close(): the providers are shared (D2)
  }
}
