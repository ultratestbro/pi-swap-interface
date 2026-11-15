/**
 * The token sheet's import decisions as pure functions (D39), so every state is unit-testable without rendering: where
 * a pasted EVM address is looked up, whether it already is a token on the list, the look-alike line, what an address of
 * a family that can't be imported says, the token the form picks the moment an import is confirmed, and what a pair
 * link's token key is.
 */
import type {ChainFamily, SwapToken, Token} from "../../contracts/domain";
import {CHAIN_LIST, chainBySlugWeb, importKey, importable, listedToken, lookalikeOf, parseTokenKey, shortAddress} from "../../catalog";

/** The confirmation's warning, verbatim (owner, 2026-11-15). */
export const IMPORT_WARNING =
  "Anyone can create a token with any name — including fake copies of real tokens. Check this address against the project's official sources. Swapping an unknown token can lose its value.";

/** EVM networks a pasted contract can be looked up on (the result's network chooser), catalog order. */
export const EVM_IMPORT_NETWORKS = CHAIN_LIST.filter((c) => c.family === "evm" && importable(c));

const evmSlug = (slug: string | undefined): string | undefined => {
  const c = slug ? chainBySlugWeb(slug) : undefined;
  return c?.family === "evm" && importable(c) ? c.slug : undefined;
};

/**
 * Where a pasted EVM contract is looked up first — never every network at once: the network the sheet is filtered to,
 * else (with "All networks") the other side's network, else this side's current token's, else Ethereum. A Solana mint
 * is always looked up on Solana.
 */
export function lookupNetwork(o: {family: "evm" | "solana"; sheetNet: string | null; other?: Pick<SwapToken, "chain"> | undefined; own?: Pick<SwapToken, "chain"> | undefined}): string {
  if (o.family === "solana") return "solana";
  return evmSlug(o.sheetNet ?? undefined) ?? evmSlug(o.other?.chain) ?? evmSlug(o.own?.chain) ?? "ethereum";
}

/** The token on the list (a catalog token, or one imported already) at this address on this network, if any. */
export function tokenAt(tokens: readonly SwapToken[], slug: string, address: string): SwapToken | undefined {
  const evm = chainBySlugWeb(slug)?.family === "evm";
  const a = evm ? address.toLowerCase() : address;
  return tokens.find((t) => t.chain === slug && t.contract !== null && (evm ? t.contract.toLowerCase() === a : t.contract === a));
}

/**
 * The amber line when an import reads like a listed token on its network (lookalikeOf: its symbol or name, case and
 * look-alike letters folded): which one is the listed one, by its short address, or as the network's own coin.
 */
export function lookalikeLine(t: Pick<Token, "caip2" | "symbol" | "name" | "chainName">): string | null {
  const listed = lookalikeOf(t);
  if (!listed) return null;
  return listed.contract
    ? `Not the listed ${listed.symbol} — that one's address is ${shortAddress(listed.contract)}`
    : `Not the listed ${listed.symbol} — that one is ${t.chainName}'s own coin`;
}

/**
 * Whether a token shown holds this address as its contract (any case): a pasted TON, Tron or NEAR address of a listed
 * token is that token's row, with no "can't be imported" line above the token the viewer can pick.
 */
export function showsAddress(shown: readonly Pick<SwapToken, "contract">[], address: string): boolean {
  const a = address.trim().toLowerCase();
  return shown.some((t) => t.contract !== null && t.contract.toLowerCase() === a);
}

const FAMILY_NAME: Readonly<Partial<Record<ChainFamily, string>>> = {ton: "TON", tron: "Tron", near: "NEAR", btc: "Bitcoin", zcash: "Zcash"};

/** What a pasted address of a family that can't be imported says (TON, Tron, NEAR, Bitcoin, Zcash in v1). */
export const unsupportedLine = (family: ChainFamily): string =>
  `${FAMILY_NAME[family] ?? "This network's"} tokens can't be imported yet — importing by address works on EVM networks and Solana.`;

/**
 * The token the form picks the moment an import is confirmed, before the token list has it: the network's own state
 * (connected owner, how it pays) from any token on it, its balance not read yet.
 */
export function provisional(token: Token, tokens: readonly SwapToken[]): SwapToken {
  const peer = tokens.find((t) => t.chain === token.chain);
  const owner = peer?.owner ?? null;
  return {...token, amount: "0", balance: owner ? "loading" : "none", usd: 0, owner, payMode: peer?.payMode ?? "connect"};
}

/** What a pair link's token key is (D39): a token the list has (by its key as the list writes it), one to import, or nothing usable. */
export type LinkedToken = {kind: "known"; key: string} | {kind: "import"; key: string; caip2: string; address: string} | null;

/**
 * A pair link's token key read against the list: a key the list has (an EVM address in any case; a listed Solana mint
 * as written in the catalog) is that token; an unlisted EVM contract or Solana mint not imported in this browser is an
 * import to confirm — never trusted on the link's word; anything else is ignored (the form opens on its default).
 */
export function linkedToken(key: string | undefined, byKey: ReadonlyMap<string, unknown>): LinkedToken {
  if (!key) return null;
  if (byKey.has(key)) return {kind: "known", key};
  const at = key.indexOf(":");
  const chain = at > 0 ? chainBySlugWeb(key.slice(0, at)) : undefined;
  if (!chain) return null;
  if (chain.family === "evm" && byKey.has(key.toLowerCase())) return {kind: "known", key: key.toLowerCase()};
  const listed = listedToken(chain.caip2, key.slice(at + 1));
  if (listed) return byKey.has(listed.key) ? {kind: "known", key: listed.key} : null;
  const unlisted = parseTokenKey(key);
  if (!unlisted) return null;
  const own = importKey(unlisted.chain, unlisted.address);
  return byKey.has(own) ? {kind: "known", key: own} : {kind: "import", key: own, caip2: unlisted.chain.caip2, address: unlisted.address};
}
