/**
 * What actually arrived (D41): the amount of the swap's destination token the recipient got in its delivery
 * transaction — the venue's `destHash` (for a swap on one network, the swap itself), or the claim's — read from the
 * chain, for the outcome report's "received". Best-effort: null when it can't be read (no delivery hash, a network
 * whose deliveries aren't read here, an RPC that won't answer, nothing found for the recipient).
 *
 *   EVM      an ERC-20: the Transfer logs of the token to the recipient in the receipt; the native coin: the
 *            recipient's balance at the delivery's block minus the block before, plus the fee when the recipient
 *            sent it (a swap on one network pays its own gas).
 *   Solana   the recipient's token balance after minus before (meta pre/postTokenBalances); SOL: its lamports, plus
 *            the fee when it paid it.
 *   Tron     the TRC-20 Transfer logs of the token to the recipient (gettransactioninfobyid). Native TRX: not read.
 *   Others   (TON, Bitcoin, NEAR, Zcash, …): not read.
 */
import {erc20Abi, parseEventLogs, type Hash} from "viem";
import type {SwapRecord} from "../contracts/activity";
import {base58ToBytes, catalogTokens, chainByCaip2Web, publicClient, tronPost} from "../catalog";
import {solRpc} from "../catalog/balances/solana";

/** The destination token's contract as its chain spells it; null for the native coin; undefined when unknown. */
let contracts: Map<string, string | null> | null = null;
function outContract(r: SwapRecord): string | null | undefined {
  if (r.toImportedContract) return r.toImportedContract;
  if (!r.toKey) return undefined;
  contracts ??= new Map(catalogTokens().map((t) => [t.key, t.contract]));
  return contracts.get(r.toKey);
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const positive = (v: bigint): bigint | null => (v > 0n ? v : null);

async function evmReceived(chainId: number, hash: string, recipient: string, contract: string | null): Promise<bigint | null> {
  const client = publicClient(chainId);
  const receipt = await client.getTransactionReceipt({hash: hash as Hash});
  if (receipt.status !== "success") return null;
  if (contract) {
    const transfers = parseEventLogs({abi: erc20Abi, eventName: "Transfer", logs: receipt.logs.filter((l) => same(l.address, contract))});
    return positive(transfers.reduce((sum, t) => (same(t.args.to, recipient) ? sum + t.args.value : sum), 0n));
  }
  const address = recipient as `0x${string}`;
  const [after, before] = await Promise.all([
    client.getBalance({address, blockNumber: receipt.blockNumber}),
    client.getBalance({address, blockNumber: receipt.blockNumber - 1n}),
  ]);
  // An OP-stack chain also charges the L1 data fee on top of gas (the receipt's l1Fee).
  const l1Fee = (receipt as {l1Fee?: bigint | null}).l1Fee ?? 0n;
  const fee = same(receipt.from, recipient) ? receipt.gasUsed * receipt.effectiveGasPrice + l1Fee : 0n;
  return positive(after - before + fee);
}

interface SolTokenBalance {
  owner?: string;
  mint?: string;
  uiTokenAmount?: {amount?: string};
}
interface SolTx {
  meta?: {err?: unknown; fee?: number; preBalances?: number[]; postBalances?: number[]; preTokenBalances?: SolTokenBalance[]; postTokenBalances?: SolTokenBalance[]} | null;
  transaction?: {message?: {accountKeys?: (string | {pubkey?: string})[]}};
}

async function solanaReceived(signature: string, recipient: string, contract: string | null): Promise<bigint | null> {
  const tx = await solRpc<SolTx | null>("getTransaction", [signature, {encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed"}]);
  const meta = tx?.meta;
  if (!meta || meta.err) return null;
  if (contract) {
    const held = (list: SolTokenBalance[] = []) =>
      list.filter((b) => b.owner === recipient && b.mint === contract).reduce((sum, b) => sum + BigInt(b.uiTokenAmount?.amount ?? "0"), 0n);
    return positive(held(meta.postTokenBalances) - held(meta.preTokenBalances));
  }
  const keys = (tx?.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === "string" ? k : (k.pubkey ?? "")));
  const i = keys.indexOf(recipient);
  const pre = meta.preBalances?.[i];
  const post = meta.postBalances?.[i];
  if (i < 0 || pre === undefined || post === undefined) return null;
  // The first account pays the fee.
  return positive(BigInt(post) - BigInt(pre) + (i === 0 ? BigInt(meta.fee ?? 0) : 0n));
}

/** keccak("Transfer(address,address,uint256)"). */
const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** A base58 Tron address → its 20-byte hex (no 41 prefix), lowercased. */
const tronHex = (address: string): string =>
  Array.from(base58ToBytes(address).slice(1, 21), (b) => b.toString(16).padStart(2, "0")).join("");

interface TronInfo {
  receipt?: {result?: string};
  log?: {address?: string; topics?: string[]; data?: string}[];
}

async function tronReceived(hash: string, recipient: string, contract: string | null): Promise<bigint | null> {
  if (!contract) return null;
  const info = await tronPost<TronInfo>("/wallet/gettransactioninfobyid", {value: hash.replace(/^0x/, "")});
  if (info.receipt?.result && info.receipt.result !== "SUCCESS") return null;
  const token = tronHex(contract);
  const to = tronHex(recipient);
  let sum = 0n;
  for (const l of info.log ?? []) {
    const [topic, , dest] = l.topics ?? [];
    if (!l.address?.toLowerCase().endsWith(token) || topic?.toLowerCase() !== TRANSFER_TOPIC || dest?.toLowerCase().slice(-40) !== to || !l.data) continue;
    sum += BigInt(`0x${l.data}`);
  }
  return positive(sum);
}

/** The destination token the recipient got in the swap's delivery, in base units; null when it can't be read. */
export async function readReceived(r: SwapRecord): Promise<bigint | null> {
  try {
    const hash = r.claimHash ?? r.destHash;
    const chain = chainByCaip2Web(r.toChain);
    const contract = outContract(r);
    if (!hash || !chain || contract === undefined) return null;
    if (chain.family === "evm") return chain.chainId ? await evmReceived(chain.chainId, hash, r.recipient, contract) : null;
    if (chain.family === "solana") return await solanaReceived(hash, r.recipient, contract);
    if (chain.family === "tron") return await tronReceived(hash, r.recipient, contract);
    return null;
  } catch {
    return null;
  }
}
