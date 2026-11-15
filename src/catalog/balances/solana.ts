/**
 * Solana balances over browser-usable public RPCs (catalog.md §5.2, D18): `getBalance` for SOL plus the owner's
 * derived associated token accounts for the catalog mints, read with `getMultipleAccounts` (jsonParsed, ≤ 10 per
 * call — publicnode's cap). Never `getTokenAccountsByOwner`: publicnode blocks indexed methods. Tokens held in a
 * non-associated account are not seen (acceptable for a swap).
 */
import {address, getAddressEncoder, getProgramDerivedAddress, type Address} from "@solana/kit";
import type {Token} from "../../contracts/domain";
import {solanaRpcUrls} from "../rpc";
import type {BalanceRead} from "./evm";

const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/**
 * Catalog mints owned by Token-2022 (mint account owners read 2026-11-11); their ATAs derive under that program.
 * A unit test pins the catalog's Solana mint list, so an SDK bump that adds a mint forces a re-check here.
 */
export const TOKEN_2022_MINTS: ReadonlySet<string> = new Set([
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", // USDG
]);

/** publicnode answers at most 10 accounts per getMultipleAccounts. */
const ACCOUNTS_PER_CALL = 10;
const TIMEOUT_MS = 10_000;

const enc = getAddressEncoder();

/**
 * The owner's associated token account for `mint`, under the mint's token program: Token-2022 for the catalog mints in
 * TOKEN_2022_MINTS and for an imported mint read as Token-2022 (`token2022`, D39), else SPL Token.
 */
export async function ataOf(owner: string, mint: string, token2022 = TOKEN_2022_MINTS.has(mint)): Promise<Address> {
  const program = token2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  const [pda] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [enc.encode(address(owner)), enc.encode(program), enc.encode(address(mint))],
  });
  return pda;
}

/** One JSON-RPC call, each runtime RPC in order until one answers with a result (balances; an import's mint read, D39). */
export async function solRpc<T>(method: string, params: unknown[]): Promise<T> {
  let last: unknown = new Error("No Solana RPC is configured.");
  for (const url of solanaRpcUrls()) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const j = (await res.json()) as {result?: T; error?: {message?: string}} | null;
      if (!res.ok || !j || j.error || j.result === undefined) throw new Error(j?.error?.message ?? `${method} HTTP ${res.status}`);
      return j.result;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** A jsonParsed account as the RPC returns it; anything unparsed (base64 data) has no `parsed`. */
type ParsedAccount = {
  owner?: string;
  data?: {parsed?: {info?: {mint?: string; owner?: string; tokenAmount?: {amount?: string}}}} | unknown[];
} | null;

const isDigits = (s: unknown): s is string => typeof s === "string" && /^\d+$/.test(s);

/**
 * SOL and catalog SPL balances of `owner`. No ATA = 0 (never created). An account that is not the expected token
 * account (wrong mint or owner — a wrong program guess) is null, i.e. unknown. Throws when a call fails on every RPC.
 */
export async function readSolanaBalances(owner: string, tokens: readonly Token[]): Promise<BalanceRead> {
  const spl = tokens.filter((t) => t.contract);
  const native = tokens.find((t) => !t.contract);
  const atas = await Promise.all(spl.map((t) => ataOf(owner, t.contract!, t.token2022 === true || TOKEN_2022_MINTS.has(t.contract!))));
  const chunks: Address[][] = [];
  for (let i = 0; i < atas.length; i += ACCOUNTS_PER_CALL) chunks.push(atas.slice(i, i + ACCOUNTS_PER_CALL));
  const [lamports, ...pages] = await Promise.all([
    native ? solRpc<{value: number}>("getBalance", [owner, {commitment: "confirmed"}]) : Promise.resolve(null),
    ...chunks.map((c) => solRpc<{value: ParsedAccount[]}>("getMultipleAccounts", [c, {encoding: "jsonParsed", commitment: "confirmed"}])),
  ]);
  const out: BalanceRead = {};
  if (native) out[native.key] = lamports && Number.isSafeInteger(lamports.value) && lamports.value >= 0 ? BigInt(lamports.value) : null;
  const accounts = pages.flatMap((p, i) => {
    const v = p?.value;
    // A short page would shift every later token onto the wrong account: treat the whole page as unknown.
    return Array.isArray(v) && v.length === chunks[i]!.length ? v : new Array<ParsedAccount | undefined>(chunks[i]!.length).fill(undefined);
  });
  spl.forEach((t, i) => {
    const acc = accounts[i];
    if (acc === null) {
      out[t.key] = 0n;
      return;
    }
    const data = acc?.data;
    const info = data && !Array.isArray(data) ? data.parsed?.info : undefined;
    const amount = info?.tokenAmount?.amount;
    out[t.key] = info?.mint === t.contract && info?.owner === owner && isDigits(amount) ? BigInt(amount) : null;
  });
  return out;
}
