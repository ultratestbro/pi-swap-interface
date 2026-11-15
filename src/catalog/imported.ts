/**
 * Tokens imported by their address (D39): the token sheet reads a pasted EVM contract or Solana mint on-chain — never a
 * token list, a third-party API or a venue's word — and, once the viewer confirmed the warning, keeps it in this browser
 * only (localStorage `cp0x.swap.tokens.v1`, per network + address, capped). An imported token is never priced, never
 * shown with a logo found by its symbol, and the engine gets its contract and the decimals read here (swap2-core 0.14.0
 * `allowUnlistedTokens`; execution reads them again through the account and refuses a mismatch).
 *
 *   EVM    — eth_getCode (code, not an EIP-7702 delegation), then decimals() (0..36, required), symbol() and name()
 *            (ABI string or legacy bytes32), over the catalog's public client (the runtime RPCs; Standard's proxy RPC first).
 *   Solana — the mint account (owner SPL Token or Token-2022, initialized, decimals) and its Metaplex metadata account in
 *            one getMultipleAccounts over the runtime Solana RPCs; the name and symbol from Token-2022's metadata
 *            extension, else Metaplex, else "UNKNOWN".
 * Symbols and names are cleaned (control, bidi, zero-width and other invisible characters stripped, length-capped),
 * since a deployer writes whatever they like there. TON, Tron, NEAR, Bitcoin and Zcash aren't importable in v1.
 */
import {useSyncExternalStore} from "react";
import {checksumAddress, type Address, type PublicClient} from "viem";
import {address as solAddress, getAddressEncoder, getProgramDerivedAddress} from "@solana/kit";
import {isTokenAddress} from "@anywalletkit/swap2-assets";
import type {Chain, Token, TokenAddress} from "../contracts/domain";
import {isSharedOriginPath} from "../config";
import {detectAddressFamily} from "./address";
import {solRpc} from "./balances/solana";
import {base58ToBytes, base64ToBytes, hexToBytes} from "./bytes";
import {publicClient} from "./evm";
import {chainByCaip2Web, chainBySlugWeb} from "./network";
import {TOKENS, tokenKey} from "./tokens";

/** localStorage key of the imported tokens (D16 conveniences; every access guarded). */
export const IMPORTED_TOKENS_KEY = "cp0x.swap.tokens.v1";
/** At most this many imports are kept; the oldest go first. */
export const IMPORTED_TOKENS_CAP = 50;
/** The highest decimals a token may have here (swap2-core's toTokenDecimals bound). */
export const MAX_TOKEN_DECIMALS = 36;
/** What a missing or unreadable symbol / name shows. */
export const UNKNOWN_TOKEN_TEXT = "UNKNOWN";
const SYMBOL_MAX = 20;
const NAME_MAX = 48;

/** Networks whose tokens can be imported in v1 (D39). */
export const importable = (c: Pick<Chain, "family" | "receiveOnly"> | undefined): c is Chain =>
  !!c && !c.receiveOnly && (c.family === "evm" || c.family === "solana");

// ── addresses and keys ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The search text as a token address: an EVM contract (`0x` + 40 hex, any case — a wrong checksum is no reason to refuse
 * what the chain will answer for) or a 32-byte Solana mint, by swap2-assets' own `isTokenAddress` (the engine's test for
 * an unlisted token); an address of another family reads as "unsupported"; anything else is null.
 */
export function detectTokenAddress(input: string): TokenAddress | null {
  const a = input.trim();
  // A 32-byte base58 key is Solana's before any shape test: a short one starting with 1 or 3 also reads as Bitcoin.
  if (solanaKey(a)) return isTokenAddress("solana:mainnet", a) ? {family: "solana", address: a} : null;
  const family = detectAddressFamily(a);
  if (family === "evm") return isTokenAddress("eip155:1", a) ? {family: "evm", address: a} : null;
  return family && family !== "solana" ? {family: "unsupported", addressFamily: family} : null;
}

/** base58 that decodes to exactly 32 bytes: a Solana public key (a Bitcoin address decodes to 25). */
function solanaKey(a: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return false;
  try {
    return base58ToBytes(a).length === 32;
  } catch {
    return false;
  }
}

/** The address as kept: an EVM contract checksummed, a Solana mint verbatim (base58 is case-sensitive). */
const canonical = (family: string, a: string): string => (family === "evm" ? checksumAddress(a.toLowerCase() as Address) : a);

/**
 * An imported token's key: `<slug>:<contract>` — lowercased on EVM like every catalog key, verbatim on Solana, where a
 * lowercased mint is another (or no) address and a shared link must still name the token.
 */
export const importKey = (chain: Pick<Chain, "slug" | "family">, contract: string): string =>
  chain.family === "evm" ? tokenKey(chain.slug, contract) : `${chain.slug}:${contract}`;

const sameContract = (family: string, a: string, b: string): boolean => (family === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The catalog token at this contract on this network, if it is one (then there is nothing to import). */
export function listedToken(caip2: string, contract: string): Token | undefined {
  const chain = chainByCaip2Web(caip2);
  if (!chain) return undefined;
  return TOKENS.find((t) => t.caip2 === chain.caip2 && t.contract !== null && sameContract(chain.family, t.contract, contract));
}

/**
 * A pair link's token key that names an importable unlisted token (D39): `<slug>:<address>` on an EVM network or
 * Solana, a valid token address there, not a catalog token. null for anything else (a catalog key, a typo, TON…).
 */
export function parseTokenKey(key: string): {chain: Chain; address: string} | null {
  const at = key.indexOf(":");
  if (at <= 0) return null;
  const chain = chainBySlugWeb(key.slice(0, at));
  const address = key.slice(at + 1);
  if (!importable(chain) || !isTokenAddress(chain.caip2, address) || listedToken(chain.caip2, address)) return null;
  return {chain, address: canonical(chain.family, address)};
}

// ── text a deployer wrote ───────────────────────────────────────────────────────────────────────────────────────

/** Control, format (bidi overrides, zero-width), private-use, separator and other default-ignorable characters (Hangul fillers…). */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * A symbol or name fit to show: invisible and direction-changing characters stripped, stacks of combining marks cut to
 * two, whitespace collapsed, at most `max` characters ("…" when cut). "" when nothing readable is left.
 */
export function cleanTokenText(raw: string, max: number): string {
  const text = raw
    .normalize("NFC")
    .replace(INVISIBLE, "")
    .replace(/\p{M}{3,}/gu, (m) => Array.from(m).slice(0, 2).join(""))
    .replace(/\s+/gu, " ")
    .trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

const symbolText = (raw: string | null): string => cleanTokenText(raw ?? "", SYMBOL_MAX) || UNKNOWN_TOKEN_TEXT;
const nameText = (raw: string | null): string => cleanTokenText(raw ?? "", NAME_MAX) || UNKNOWN_TOKEN_TEXT;

/** Lenient UTF-8 (a bad byte becomes U+FFFD, which shows): the text is judged, not trusted. */
const utf8 = (b: Uint8Array): string => new TextDecoder("utf-8", {fatal: false}).decode(b);

const word = (b: Uint8Array, at: number): bigint => {
  let v = 0n;
  for (let i = at; i < at + 32; i++) v = (v << 8n) | BigInt(b[i]!);
  return v;
};

/** The first 32-byte word of an eth_call answer as a number, or null when there isn't one. */
export function decodeUint(data: string | undefined): bigint | null {
  if (!data || !/^0x[0-9a-fA-F]{64}(?:[0-9a-fA-F]{2})*$/.test(data)) return null;
  return BigInt(`0x${data.slice(2, 66)}`);
}

/**
 * An ERC-20 symbol() / name() answer: an ABI `string`, or a legacy `bytes32` (MKR, SAI) up to its first zero byte.
 * null when it is neither (empty, malformed, a length past the answer).
 */
export function decodeTokenString(data: string | undefined): string | null {
  if (!data || !/^0x(?:[0-9a-fA-F]{2})+$/.test(data)) return null;
  const b = hexToBytes(data);
  if (b.length === 32) {
    const end = b.indexOf(0);
    return utf8(b.subarray(0, end < 0 ? 32 : end));
  }
  if (b.length < 64) return null;
  const offset = word(b, 0);
  if (offset > BigInt(b.length - 32)) return null;
  const at = Number(offset);
  const len = word(b, at);
  if (len > BigInt(b.length - at - 32)) return null;
  return utf8(b.subarray(at + 32, at + 32 + Number(len)));
}

// ── what reads alike ────────────────────────────────────────────────────────────────────────────────────────────

/** Letters drawn like Latin ones (Cyrillic, Greek) and the digits read as letters, folded before comparing. */
const CONFUSABLE: Readonly<Record<string, string>> = {
  а: "a", в: "b", е: "e", ё: "e", һ: "h", н: "h", і: "l", ї: "l", ј: "j", к: "k", м: "m", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ѕ: "s", ԁ: "d", ԛ: "q", ԝ: "w", ӏ: "l",
  α: "a", β: "b", ε: "e", η: "n", ι: "l", κ: "k", μ: "m", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ζ: "z", γ: "y",
  "0": "o", "1": "l", i: "l", "|": "l",
};

/** A text as it reads: NFKC (fullwidth, ligatures), lower case, look-alike letters folded, no spaces or dots. */
export const readsAs = (text: string): string =>
  Array.from(text.normalize("NFKC").toLowerCase())
    .map((c) => CONFUSABLE[c] ?? c)
    .join("")
    .replace(/[\s.\-_]/g, "");

/**
 * The listed token an imported one reads like on the same network (D39): its symbol, or its name, reads as a catalog
 * token's symbol (case, look-alike letters and spacing folded). The confirmation then says which one is the listed one.
 */
export function lookalikeOf(t: Pick<Token, "caip2" | "symbol" | "name">, listed: readonly Token[] = TOKENS): Token | null {
  const marks = new Set([t.symbol, t.name ?? ""].filter((x) => x && x !== UNKNOWN_TOKEN_TEXT).map(readsAs));
  marks.delete("");
  if (!marks.size) return null;
  return listed.find((l) => l.caip2 === t.caip2 && !l.imported && (marks.has(readsAs(l.symbol)) || marks.has(readsAs(l.catalogSymbol)))) ?? null;
}

// ── reading a token ─────────────────────────────────────────────────────────────────────────────────────────────

/** Why an address can't be imported, in the user's words. `definitive`: asking again won't change it (not a network failure). */
export class TokenReadError extends Error {
  constructor(
    message: string,
    readonly definitive: boolean,
  ) {
    super(message);
    this.name = "TokenReadError";
  }
}

/** What a read found (decimals in 0..36, cleaned texts). */
export interface TokenMeta {
  decimals: number;
  symbol: string;
  name: string;
  token2022?: boolean;
}

/** An imported token (not yet kept) from what the chain said: the engine's sourceToken is its contract. */
export function importedToken(chain: Chain, contract: string, meta: TokenMeta): Token {
  const address = canonical(chain.family, contract);
  return {
    key: importKey(chain, address),
    chain: chain.slug,
    caip2: chain.caip2,
    chainName: chain.name,
    family: chain.family,
    symbol: meta.symbol,
    catalogSymbol: address,
    decimals: meta.decimals,
    contract: address,
    gasToken: false,
    imported: true,
    name: meta.name,
    ...(meta.token2022 ? {token2022: true as const} : {}),
  };
}

/** EIP-7702 delegation designator: an EOA that delegated its code, not a token contract. */
const DELEGATION = /^0xef0100[0-9a-fA-F]{40}$/;
const DECIMALS = "0x313ce567";
const SYMBOL = "0x95d89b41";
const NAME = "0x06fdde03";

/** A request that never reached a node (every RPC down, offline), as opposed to the contract's own answer. */
function unreachable(e: unknown): boolean {
  for (let x = e, i = 0; x && typeof x === "object" && i < 8; x = (x as {cause?: unknown}).cause, i++) {
    const name = (x as {name?: unknown}).name;
    if (name === "HttpRequestError" || name === "TimeoutError" || name === "WebSocketRequestError") return true;
    if (/failed to fetch|fetch failed|network ?error|no rpc is configured/i.test(String((x as {message?: unknown}).message ?? ""))) return true;
  }
  return false;
}

/** The read surface of a viem public client (a fake one in tests). */
export type TokenReadClient = Pick<PublicClient, "getCode" | "call">;

/** An ERC-20's decimals, symbol and name, read on `chain` (D39). Throws TokenReadError. */
export async function readEvmToken(chain: Chain, contract: string, client: TokenReadClient = publicClient(chain.chainId!)): Promise<TokenMeta> {
  const to = contract as Address;
  let code: string | undefined;
  try {
    code = await client.getCode({address: to});
  } catch {
    throw new TokenReadError(`Couldn't reach ${chain.name} to read this token — try again.`, false);
  }
  if (!code || code === "0x" || DELEGATION.test(code)) throw new TokenReadError(`No token contract at this address on ${chain.name}.`, true);
  const call = async (data: `0x${string}`) => (await client.call({to, data})).data;
  const [dec, sym, name] = await Promise.allSettled([call(DECIMALS), call(SYMBOL), call(NAME)]);
  if (dec.status === "rejected" && unreachable(dec.reason)) throw new TokenReadError(`Couldn't reach ${chain.name} to read this token — try again.`, false);
  const decimals = dec.status === "fulfilled" ? decodeUint(dec.value) : null;
  if (decimals === null) throw new TokenReadError(`This contract doesn't read as a token on ${chain.name} — it has no decimals().`, true);
  if (decimals > BigInt(MAX_TOKEN_DECIMALS)) throw new TokenReadError(`This token says it has ${decimals} decimals — more than ${MAX_TOKEN_DECIMALS}, so it can't be swapped here.`, true);
  return {
    decimals: Number(decimals),
    symbol: symbolText(sym.status === "fulfilled" ? decodeTokenString(sym.value) : null),
    name: nameText(name.status === "fulfilled" ? decodeTokenString(name.value) : null),
  };
}

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const METAPLEX_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
/** SPL mint layout: 82 bytes; Token-2022 pads a mint with extensions to 165 and marks it AccountType::Mint (1). */
const MINT_LEN = 82;
const ACCOUNT_TYPE_AT = 165;
/** Token-2022's TokenMetadata extension (ExtensionType 19). */
const EXT_TOKEN_METADATA = 19;

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + b[at + 3]! * 0x1000000;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A borsh `String` at `at` (u32 length + bytes, at most `max` bytes, inside `b`), zero padding stripped; null past the end. */
function borshString(b: Uint8Array, at: number, max = 256): {text: string; end: number} | null {
  if (at + 4 > b.length) return null;
  const len = u32(b, at);
  if (len > max || at + 4 + len > b.length) return null;
  return {text: utf8(b.subarray(at + 4, at + 4 + len)).replace(/\0+$/u, ""), end: at + 4 + len};
}

/**
 * A mint account's data: decimals and whether it is initialized, plus Token-2022's extension area. null when the bytes
 * aren't a mint of that program (a token account, a multisig, too short).
 */
export function parseMint(data: Uint8Array, token2022: boolean): {decimals: number; extensions: Uint8Array | null} | null {
  if (data.length < MINT_LEN) return null;
  let extensions: Uint8Array | null = null;
  if (data.length !== MINT_LEN) {
    if (!token2022 || data.length <= ACCOUNT_TYPE_AT || data[ACCOUNT_TYPE_AT] !== 1) return null;
    extensions = data.subarray(ACCOUNT_TYPE_AT + 1);
  }
  if (data[45] !== 1) return null;
  return {decimals: data[44]!, extensions};
}

/** Token-2022's metadata extension for `mint` (TLV type 19: update authority, mint, name, symbol, uri…), or null. */
export function token2022Metadata(extensions: Uint8Array, mint: Uint8Array): {name: string; symbol: string} | null {
  for (let at = 0; at + 4 <= extensions.length; ) {
    const type = u16(extensions, at);
    const len = u16(extensions, at + 2);
    if (type === 0) return null;
    const value = extensions.subarray(at + 4, at + 4 + len);
    if (value.length !== len) return null;
    if (type === EXT_TOKEN_METADATA) {
      if (len < 64 || !sameBytes(value.subarray(32, 64), mint)) return null;
      const name = borshString(value, 64);
      const symbol = name && borshString(value, name.end);
      return name && symbol ? {name: name.text, symbol: symbol.text} : null;
    }
    at += 4 + len;
  }
  return null;
}

/** A Metaplex metadata account (Key::MetadataV1 = 4) for `mint`: its name and symbol, or null. */
export function metaplexMetadata(data: Uint8Array, mint: Uint8Array): {name: string; symbol: string} | null {
  if (data.length < 65 || data[0] !== 4 || !sameBytes(data.subarray(33, 65), mint)) return null;
  const name = borshString(data, 65, 64);
  const symbol = name && borshString(data, name.end, 32);
  return name && symbol ? {name: name.text, symbol: symbol.text} : null;
}

type RpcAccount = {owner?: unknown; data?: unknown} | null;
const accountBytes = (a: RpcAccount): Uint8Array | null => {
  const d = a?.data;
  return Array.isArray(d) && typeof d[0] === "string" && d[1] === "base64" ? base64ToBytes(d[0]) : null;
};

/** A Solana mint's decimals and metadata, read on Solana (D39). Throws TokenReadError. */
export async function readSolanaToken(mint: string, rpc: typeof solRpc = solRpc): Promise<TokenMeta> {
  const enc = getAddressEncoder();
  const mintBytes = new Uint8Array(enc.encode(solAddress(mint)));
  const program = solAddress(METAPLEX_PROGRAM);
  const [pda] = await getProgramDerivedAddress({programAddress: program, seeds: [new TextEncoder().encode("metadata"), enc.encode(program), mintBytes]});
  let accounts: RpcAccount[];
  try {
    const res = await rpc<{value?: unknown}>("getMultipleAccounts", [[mint, pda], {encoding: "base64", commitment: "confirmed"}]);
    if (!Array.isArray(res?.value) || res.value.length !== 2) throw new Error("short answer");
    accounts = res.value as RpcAccount[];
  } catch {
    throw new TokenReadError("Couldn't reach Solana to read this token — try again.", false);
  }
  const [mintAcc, metaAcc] = accounts;
  if (!mintAcc) throw new TokenReadError("No token at this address on Solana.", true);
  const token2022 = mintAcc.owner === TOKEN_2022_PROGRAM;
  const data = mintAcc.owner === TOKEN_PROGRAM || token2022 ? accountBytes(mintAcc) : null;
  const parsed = data ? parseMint(data, token2022) : null;
  if (!parsed) throw new TokenReadError("This address isn't a token mint on Solana.", true);
  if (parsed.decimals > MAX_TOKEN_DECIMALS) throw new TokenReadError(`This token says it has ${parsed.decimals} decimals — more than ${MAX_TOKEN_DECIMALS}, so it can't be swapped here.`, true);
  const metaBytes = metaAcc?.owner === METAPLEX_PROGRAM ? accountBytes(metaAcc) : null;
  const meta = (parsed.extensions && token2022Metadata(parsed.extensions, mintBytes)) ?? (metaBytes && metaplexMetadata(metaBytes, mintBytes)) ?? null;
  return {decimals: parsed.decimals, symbol: symbolText(meta?.symbol ?? null), name: nameText(meta?.name ?? null), ...(token2022 ? {token2022: true} : {})};
}

/** The token at `address` on `caip2`, read on-chain for an import (D39). Throws TokenReadError with the user's words. */
export async function readTokenForImport(caip2: string, address: string): Promise<Token> {
  const chain = chainByCaip2Web(caip2);
  if (!importable(chain)) throw new TokenReadError("Tokens can be imported on EVM networks and Solana only for now.", true);
  if (!isTokenAddress(chain.caip2, address)) throw new TokenReadError(`That isn't a token address on ${chain.name}.`, true);
  const listed = listedToken(chain.caip2, address);
  if (listed) throw new TokenReadError(`This is the listed ${listed.symbol} — pick it from the list.`, true);
  const meta = chain.family === "evm" ? await readEvmToken(chain, address) : await readSolanaToken(address);
  return importedToken(chain, address, meta);
}

// ── kept in this browser ────────────────────────────────────────────────────────────────────────────────────────

/** One kept import as stored: the network slug, the address and what the chain said (re-checked on every read). */
interface StoredToken {
  chain: string;
  contract: string;
  symbol: string;
  name: string;
  decimals: number;
  token2022?: true;
}

const toStored = (t: Token): StoredToken => ({
  chain: t.chain,
  contract: t.contract ?? "",
  symbol: t.symbol,
  name: t.name ?? UNKNOWN_TOKEN_TEXT,
  decimals: t.decimals,
  ...(t.token2022 ? {token2022: true as const} : {}),
});

/**
 * The kept imports from their stored form, each held to the rules again — an importable network, a token address there
 * that isn't a catalog token, whole decimals in 0..36, texts cleaned — duplicates dropped, at most IMPORTED_TOKENS_CAP.
 * Anything else is dropped, never a crash.
 */
export function parseImportedTokens(raw: unknown): Token[] {
  if (!Array.isArray(raw)) return [];
  const out: Token[] = [];
  const seen = new Set<string>();
  for (const e of raw as unknown[]) {
    if (out.length >= IMPORTED_TOKENS_CAP) break;
    if (!e || typeof e !== "object") continue;
    const s = e as Partial<Record<keyof StoredToken, unknown>>;
    const chain = typeof s.chain === "string" ? chainBySlugWeb(s.chain) : undefined;
    if (!importable(chain) || typeof s.contract !== "string" || !isTokenAddress(chain.caip2, s.contract) || listedToken(chain.caip2, s.contract)) continue;
    if (typeof s.decimals !== "number" || !Number.isInteger(s.decimals) || s.decimals < 0 || s.decimals > MAX_TOKEN_DECIMALS) continue;
    const t = importedToken(chain, s.contract, {
      decimals: s.decimals,
      symbol: symbolText(typeof s.symbol === "string" ? s.symbol : null),
      name: nameText(typeof s.name === "string" ? s.name : null),
      token2022: chain.family === "solana" && s.token2022 === true,
    });
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    out.push(t);
  }
  return out;
}

/**
 * On an IPFS path gateway every site shares this origin's storage (D8): another site could plant an "import" there that
 * skipped the warning. There imports live in memory only, for the page's lifetime.
 */
const memoryOnly = (): boolean => typeof window === "undefined" || isSharedOriginPath(window.location?.pathname);

let cache: readonly Token[] | null = null;
const listeners = new Set<() => void>();
let watching = false;

function load(): readonly Token[] {
  if (memoryOnly()) return [];
  try {
    const raw = localStorage.getItem(IMPORTED_TOKENS_KEY);
    return raw ? parseImportedTokens(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** The imports kept in this browser, newest first: one stable array until it changes. */
export const importedTokens = (): readonly Token[] => (cache ??= load());

function commit(next: readonly Token[]): void {
  cache = next;
  if (!memoryOnly()) {
    try {
      localStorage.setItem(IMPORTED_TOKENS_KEY, JSON.stringify(next.map(toStored)));
    } catch {
      // Storage full or blocked: the import still holds for this page.
    }
  }
  for (const l of listeners) l();
}

/** Keep a confirmed import (newest first; the same token again moves to the top; the oldest past the cap is dropped). Held to parseImportedTokens' rules. */
export function addImportedToken(t: Token): void {
  const [checked] = parseImportedTokens([toStored(t)]);
  if (!checked) return;
  commit([checked, ...importedTokens().filter((x) => x.key !== checked.key)].slice(0, IMPORTED_TOKENS_CAP));
}

/** Forget an import. */
export function removeImportedToken(key: string): void {
  const now = importedTokens();
  if (now.some((t) => t.key === key)) commit(now.filter((t) => t.key !== key));
}

/** Another tab imported or removed one: read the store again. */
function onStorage(e: StorageEvent): void {
  if (e.key !== IMPORTED_TOKENS_KEY && e.key !== null) return;
  cache = null;
  for (const l of listeners) l();
}

/** useSyncExternalStore's subscribe: this tab's changes and other tabs' (the storage event). */
export function subscribeImported(listener: () => void): () => void {
  listeners.add(listener);
  if (!watching && typeof window !== "undefined" && !memoryOnly()) {
    window.addEventListener("storage", onStorage);
    watching = true;
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && watching) {
      window.removeEventListener("storage", onStorage);
      watching = false;
    }
  };
}

/** The imports kept in this browser, live. */
export function useImportedTokens(): readonly Token[] {
  return useSyncExternalStore(subscribeImported, importedTokens, importedTokens);
}

/** Tests only: forget the cached list (the next read loads storage again). */
export function resetImportedTokens(): void {
  cache = null;
}
