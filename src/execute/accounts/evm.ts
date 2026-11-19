/**
 * The EVM engine account (engine.md §6.1, ARCHITECTURE.md D12): what swap2-core's engine calls, built over the
 * user's own wallet. Writes go to the viem WalletClient (wagmi) — this file and solana.ts are the only places in
 * the app allowed to ask a wallet to sign (ESLint, D10) and they are reached only through gateAccount (gated.ts),
 * so every write here has already consumed an armed write. Reads, gas quotes and eth_call simulation go to the
 * runtime RPC list through the SDK's WalletAccountReadOnlyEvm, never the wallet's provider.
 *
 * There is no `chain` property: the engine's account-chain check asks `getChainId()`, which is the LIVE wallet chain.
 * Before each prompt the wallet's current account and chain are checked again.
 */
import {BaseError, ChainMismatchError, getAddress, isAddress, type Address, type Hex, type PublicClient, type WalletClient} from "viem";
import {WalletAccountReadOnlyEvm, type EvmProvider, type EvmTransaction, type SimulationResult} from "@anywalletkit/wallet-evm";
import type {TokenInfo} from "@anywalletkit/core";
import type {EvmSourceSigner, EvmTransport} from "../../contracts/execution";
import {answered, refusal} from "../errors";

/** A transaction exactly as the engine hands it to the account (approve, main call, claim). */
export interface EngineEvmTx {
  to: string;
  data?: string;
  value: bigint;
  chainId?: number;
  gasLimit?: bigint;
}

/** A typed-data request as the engine builds it (domain chainId already a number, EIP712Domain stripped). */
export interface EngineTypedData {
  domain: Record<string, unknown>;
  types: Record<string, readonly {name: string; type: string}[]>;
  primaryType?: string;
  message: Record<string, unknown>;
}

/** Every member the engine touches on an EVM account (engine.md §5.2) — and nothing else. */
export interface EvmEngineAccount {
  getAddress(): Promise<string>;
  getChainId(): Promise<number>;
  getBalance(): Promise<bigint>;
  getAllowance(token: string, spender: string): Promise<bigint>;
  getTokenInfo(token: string): Promise<TokenInfo>;
  quoteSendTransaction(tx: EngineEvmTx): Promise<{fee: bigint}>;
  sendTransaction(tx: EngineEvmTx): Promise<{hash: string; fee: bigint}>;
  waitForTransaction(hash: string): Promise<void>;
  signTypedData(td: EngineTypedData): Promise<string>;
}

/** The read side over public RPC (WalletAccountReadOnlyEvm's surface the adapter needs); injectable for tests. */
export interface EvmReads {
  getBalance(): Promise<bigint>;
  getAllowance(token: string, spender: string): Promise<bigint>;
  getTokenInfo(token: string): Promise<TokenInfo>;
  quoteSendTransaction(tx: EvmTransaction): Promise<{fee: bigint}>;
  simulateTransaction(tx: EvmTransaction): Promise<SimulationResult>;
}

/** The chain reads the adapter makes itself: receipts, the head, the account's code. */
export type EvmChainReads = Pick<PublicClient, "getCode" | "getBlockNumber" | "waitForTransactionReceipt">;

/**
 * The SDK's read-only account over the runtime RPC list — reads, quotes and simulation; it never signs. With no
 * URL for the chain it reads through the catalog's public client (same config, never the wallet's provider).
 */
export function evmReads(signer: Pick<EvmSourceSigner, "owner" | "rpcUrls" | "chain" | "pub">): EvmReads {
  // A viem PublicClient's `request` is EIP-1193-shaped; the SDK's provider type names its own interface.
  const provider = signer.rpcUrls.length ? [...signer.rpcUrls] : (signer.pub as unknown as Exclude<EvmProvider, string>);
  return new WalletAccountReadOnlyEvm(signer.owner, {provider, chainId: signer.chain.id});
}

/** Wallet errors that prove nothing was broadcast (EIP-1193 / JSON-RPC codes). */
const DEFINITIVE = new Set([4001, 4100, 4200, 4900, 4901, -32601, -32602]);

/**
 * A wallet error with the engine's flags: `answered` when it proves nothing was sent, `maybeSent` for a
 * WalletConnect request that expired (the phone may still approve and broadcast it — never offer a retry).
 * Anything else is left to the engine's own heuristic.
 */
export function normalizeWalletError(e: unknown, transport: EvmTransport): unknown {
  const walk = (f: (x: unknown) => boolean): unknown => (e instanceof BaseError ? e.walk(f) : f(e) ? e : null);
  if (walk((x) => x instanceof ChainMismatchError)) return answered(e);
  const coded = walk((x) => typeof (x as {code?: unknown} | null)?.code === "number") as {code?: number} | null;
  if (coded?.code !== undefined && DEFINITIVE.has(coded.code)) return answered(e);
  if (walk((x) => (x as {name?: unknown} | null)?.name === "UserRejectedError")) return answered(e);
  if (transport === "walletconnect" && /expired|timed? ?out|timeout/i.test(String((e as Error | null)?.message ?? e)) && e && typeof e === "object")
    return Object.assign(e, {maybeSent: true});
  return e;
}

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const TX_KEYS = new Set(["to", "data", "value", "chainId", "gasLimit"]);

/** The engine's EVM tx shapes only: anything else (a TON body, a memo, a fee field) is not ours to send. */
function checkTx(tx: EngineEvmTx, chainId: number): void {
  const t = tx as unknown as Record<string, unknown>;
  for (const k of Object.keys(t)) if (t[k] !== undefined && !TX_KEYS.has(k)) throw refusal(`This transaction carries a field (${k}) the swap never sends — nothing was sent.`);
  if (typeof tx.to !== "string" || !isAddress(tx.to, {strict: false})) throw refusal("This transaction has no valid target — nothing was sent.");
  if (typeof tx.value !== "bigint" || tx.value < 0n) throw refusal("This transaction's value is malformed — nothing was sent.");
  if (tx.data !== undefined && (typeof tx.data !== "string" || !HEX.test(tx.data))) throw refusal("This transaction's calldata is malformed — nothing was sent.");
  if (tx.gasLimit !== undefined && (typeof tx.gasLimit !== "bigint" || tx.gasLimit <= 0n)) throw refusal("This transaction's gas limit is malformed — nothing was sent.");
  if (tx.chainId !== undefined && tx.chainId !== chainId) throw refusal(`This transaction is for chain ${tx.chainId}, not the one you're swapping on — nothing was sent.`);
}

/**
 * The wallet still shows the reviewed account (its first = selected account), on the signer's chain, and its
 * client appends no calldata (viem's dataSuffix would change what is signed). Runs on Confirm and before each prompt.
 */
export async function assertEvmWallet(signer: Pick<EvmSourceSigner, "wallet" | "owner" | "chain">): Promise<void> {
  const wallet = signer.wallet;
  const suffix = (wallet as {dataSuffix?: unknown}).dataSuffix;
  if (suffix !== undefined && suffix !== null && suffix !== "") throw refusal("This wallet connection appends data to every transaction — nothing was sent.");
  let current: string | undefined;
  let live: number;
  try {
    [current] = await wallet.getAddresses();
    live = await wallet.getChainId();
  } catch (e) {
    throw refusal("Couldn't read your wallet's account — nothing was sent. Reconnect it and try again.", e);
  }
  if (!current || !isAddress(current, {strict: false}) || getAddress(current) !== getAddress(signer.owner))
    throw refusal("Your wallet switched accounts — nothing was sent. Switch back to the account you reviewed.");
  if (live !== signer.chain.id) throw refusal(`Your wallet switched networks — nothing was sent. Switch back to ${signer.chain.name}.`);
}

/** A call the node ran and refused (swap2-core's dry-run "revert"), as against an RPC that didn't answer. */
const REVERTED = /execution reverted|\breverted\b|ExecutionReverted|ContractFunctionReverted/i;

export function isRevert(e: unknown): boolean {
  for (let x = e, i = 0; x && typeof x === "object" && i < 8; x = (x as {cause?: unknown}).cause, i++) {
    const o = x as {code?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown};
    if (o.code === 3 || REVERTED.test([o.message, o.shortMessage, o.details].filter((v) => typeof v === "string").join(" "))) return true;
  }
  return false;
}

/** How long after this execution's approval (or claim) was mined a revert may be the RPC lagging behind it. */
export const AFTER_MINED_MS = 60_000;
/** A revert in that window is asked again this often, this many times, before it stands. */
export const RECHECK_MS = 2_500;
export const RECHECKS = 2;

/**
 * Adapt a connected EVM wallet to the engine account. `reads` defaults to the SDK's read-only account over
 * `signer.rpcUrls`. The wallet must already be on `signer.chain` (wallets.getSigner switched it).
 *
 * A dry run (`quoteSendTransaction`, the engine's estimate of the call it is about to send) or the simulation before
 * sending that reverts within AFTER_MINED_MS of an approval this account saw mined is asked again, RECHECKS times
 * RECHECK_MS apart (owner 2026-11-19): the RPC answering it may not have the approval's block yet (load-balanced
 * nodes lag), and the engine refuses at once and revokes the approval it just paid for. A revert that stands is
 * refused as before; nothing is ever sent on a retry.
 */
export function evmEngineAccount(signer: EvmSourceSigner, opts: {reads?: EvmReads; recheckMs?: number} = {}): EvmEngineAccount {
  const owner = getAddress(signer.owner);
  const chainId = signer.chain.id;
  const reads = opts.reads ?? evmReads(signer);
  const wallet = signer.wallet;
  const assertWallet = () => assertEvmWallet(signer);
  const recheckMs = opts.recheckMs ?? RECHECK_MS;
  let minedAt = 0;
  const justMined = () => minedAt > 0 && Date.now() - minedAt < AFTER_MINED_MS;
  const dryRun = async (tx: EvmTransaction) => {
    for (let i = 0; ; i++) {
      try {
        return await reads.quoteSendTransaction(tx);
      } catch (e) {
        if (i >= RECHECKS || !justMined() || !isRevert(e)) throw e;
        await sleep(recheckMs);
      }
    }
  };
  const simulate = async (tx: EvmTransaction) => {
    let sim = await reads.simulateTransaction(tx).catch(() => null);
    for (let i = 0; sim && !sim.ok && justMined() && i < RECHECKS; i++) {
      await sleep(recheckMs);
      sim = await reads.simulateTransaction(tx).catch(() => null);
    }
    return sim;
  };

  return {
    getAddress: async () => owner,
    getChainId: () => wallet.getChainId(),
    getBalance: () => reads.getBalance(),
    getAllowance: (token, spender) => reads.getAllowance(token, spender),
    getTokenInfo: (token) => reads.getTokenInfo(token),
    quoteSendTransaction: (tx) => dryRun(tx),
    async sendTransaction(tx) {
      checkTx(tx, chainId);
      await assertWallet();
      // Parity with wallet-evm: refuse a transaction that reverts in eth_call. A transport failure is not a refusal (the wallet simulates too).
      const sim = await simulate(tx);
      if (sim && !sim.ok) throw refusal(`The transaction would fail on-chain (${sim.reason.slice(0, 120)}) — nothing was sent.`);
      try {
        const hash = await wallet.sendTransaction({
          account: owner,
          chain: signer.chain, // viem asserts eth_chainId === chain.id once more
          to: tx.to as Address,
          ...(tx.data !== undefined ? {data: tx.data as Hex} : {}),
          value: tx.value,
          ...(tx.gasLimit !== undefined ? {gas: tx.gasLimit} : {}),
        });
        return {hash, fee: 0n};
      } catch (e) {
        throw normalizeWalletError(e, signer.transport);
      }
    },
    async waitForTransaction(hash) {
      await waitForEvmTx(signer.pub, hash as Hex);
      minedAt = Date.now();
    },
    async signTypedData(td) {
      if (!td || typeof td !== "object" || !td.primaryType || !td.domain || !td.types || !td.message)
        throw refusal("The order to sign is malformed — nothing was signed.");
      const domainChain = td.domain.chainId;
      if (domainChain !== undefined && Number(domainChain) !== chainId) throw refusal("The order names another network — nothing was signed.");
      await assertWallet();
      try {
        // viem infers typed data from a const schema; this one is runtime data the engine already checked (assertTypedOrder).
        const request = {account: owner, domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message};
        return await wallet.signTypedData(request as unknown as Parameters<WalletClient["signTypedData"]>[0]);
      } catch (e) {
        throw normalizeWalletError(e, signer.transport);
      }
    },
  };
}

/** An EIP-7702 delegation designator: 0xef0100 ‖ 20-byte delegate. The account is still an EOA. */
const DELEGATION = /^0xef0100[0-9a-fA-F]{40}$/;

/**
 * v1 refuses smart-contract accounts (engine.md §6.1): a Safe returns a safeTxHash from eth_sendTransaction (the
 * receipt never comes) and the same address on another chain may not be the user's. An RPC failure refuses too.
 */
export async function assertEoa(pub: Pick<EvmChainReads, "getCode">, owner: string, chainName: string): Promise<void> {
  let code: string | undefined;
  try {
    code = await pub.getCode({address: getAddress(owner)});
  } catch (e) {
    throw refusal(`Couldn't check your wallet account on ${chainName} — nothing was sent. Try again in a moment.`, e);
  }
  if (code && code !== "0x" && !DELEGATION.test(code))
    throw refusal("Smart-contract wallets (Safe, smart accounts) can't swap here yet — nothing was sent. Use a regular wallet account.");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait for an approval (or claim) to be mined and successful, then for a public RPC to see the next block
 * (load-balanced RPCs lag) — mobile execute.ts waitForEvmTx, plus wallet speed-up / cancel: a repriced
 * replacement counts, a cancelled or replaced one is a revert. Transport hiccups retry until the 180 s deadline,
 * so a slow RPC never makes the engine revoke a live allowance.
 */
export async function waitForEvmTx(pub: Pick<EvmChainReads, "waitForTransactionReceipt" | "getBlockNumber">, hash: Hex, budgetMs = 180_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const replaced: {reason: string | null} = {reason: null};
    try {
      const receipt = await pub.waitForTransactionReceipt({
        hash,
        timeout: Math.max(5_000, deadline - Date.now()),
        onReplaced: (r) => {
          if (r.reason !== "repriced") replaced.reason = r.reason;
        },
      });
      if (replaced.reason) throw Object.assign(new Error(`swap: ${hash} was ${replaced.reason} in the wallet — reverted`), {code: "reverted"});
      if (receipt.status !== "success") throw Object.assign(new Error(`swap: ${hash} reverted on-chain`), {code: "reverted"});
      const settleBy = Math.min(deadline, Date.now() + 20_000);
      while (Date.now() < settleBy) {
        const head = await pub.getBlockNumber({cacheTime: 0}).catch(() => 0n);
        if (head > receipt.blockNumber) break;
        await sleep(1_500);
      }
      return;
    } catch (e) {
      if ((e as {code?: unknown} | null)?.code === "reverted" || Date.now() >= deadline) throw e;
      await sleep(3_000);
    }
  }
}
