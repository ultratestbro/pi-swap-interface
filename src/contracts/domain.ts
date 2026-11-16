/**
 * Domain types every module shares: networks, tokens, balances, prices.
 * Types only — no runtime code, so any module may import this file without
 * pulling another module in. Shapes follow docs/specs/catalog.md §2-3
 * (ARCHITECTURE.md "Decisions" D4-D6).
 */
import type {ChainFamily, ChainInfo} from "../shared/chains";

export type {ChainFamily, ChainInfo};

/** Catalog-only chains (phase 1.5, VITE_EXTRA_CHAINS=1): deposit sources / typed-recipient destinations, never signed here. */
export type ExtraFamily = "ltc" | "doge" | "xrp" | "bch" | "cosmos" | "cardano" | "stellar" | "aptos" | "sui";

/** Every family a token can live on. Only "evm", "solana", "tron", "ton" and "near" are signed in the browser (SIGNING_FAMILIES). */
export type Family = ChainFamily | ExtraFamily;

/** A network as the web app shows it: the @cp0x/shared row plus the swap catalog's per-chain flags. */
export interface Chain extends Omit<ChainInfo, "family"> {
  family: Family;
  /** swap2-assets CcChain.key ("zec" for zcash). Display/debug only — never a join key (join on caip2). */
  catalogKey: string;
  /** Deposits to this chain REQUIRE the memo a route returns (ton, xrp, stellar). */
  memo: boolean;
  /** CcChain.icon — kept as data; the UI never hotlinks it at runtime (D13). */
  icon?: string;
  /** CcChain.offrampOnly: destination only. */
  receiveOnly: boolean;
}

/** A catalog token, static, built once at module load from @anywalletkit/swap2-assets. */
export interface Token {
  /** `<slug>:<contract lowercased | "native">` — list key, balance key, hash-route param, data-testid suffix. */
  key: string;
  /** Chain slug. */
  chain: string;
  caip2: string;
  chainName: string;
  family: Family;
  /** What the user reads: the chain's own native symbol for natives (TON, XDAI), else the catalog symbol. */
  symbol: string;
  /** The catalog symbol — the engine's `sourceToken` and the price-map key the router uses. */
  catalogSymbol: string;
  decimals: number;
  /** Contract / mint / jetton master, case preserved (Solana/TON are case-sensitive); null = native. */
  contract: string | null;
  /** Pays this chain's gas (native, or Celo CELO / Arc USDC by their ERC-20 face): MAX keeps a reserve. */
  gasToken: boolean;
  /** CcAsset.icon (CMC URL) — data only, never hotlinked at runtime (D13). */
  icon?: string;
  /**
   * A token the viewer imported by its address (D39): read on-chain, kept in this browser only, priced and shown with a
   * logo only as found by its contract or mint, never by its symbol. Its `catalogSymbol` is its contract (the engine
   * names an unlisted token by contract or mint, with the decimals read here). Absent on every catalog token.
   */
  imported?: true;
  /** An imported token's logo, a `data:` URL found by its contract (importedLogo.ts); never stored, absent when none. */
  logo?: string;
  /** The token's on-chain name, cleaned (imported tokens only: the catalog carries none). */
  name?: string;
  /** Solana: the mint belongs to Token-2022, so its associated token accounts derive under that program (imported tokens only). */
  token2022?: true;
}

/**
 * What the token sheet's search text is when it is a token address (D39): an EVM contract (any case) or a Solana mint,
 * which can be imported, or an address of a family that can't be imported yet (TON, Tron, NEAR, Bitcoin, Zcash).
 */
export type TokenAddress = {family: "evm" | "solana"; address: string} | {family: "unsupported"; addressFamily: ChainFamily};

/** An address read on-chain for an import (D39): the token it is (not imported yet), or why it can't be, in the user's words. */
export type TokenLookup = {status: "idle"} | {status: "loading"} | {status: "found"; token: Token} | {status: "failed"; reason: string};

/** Balance read state per token. "none" = no address of this family is connected. */
export type BalanceState = "loaded" | "loading" | "none" | "error";

/** One token's balance. `amount` is base units as a decimal string; "0" when unknown — render "—" unless state is "loaded". */
export interface Balance {
  amount: string;
  state: Exclude<BalanceState, "none">;
}

/** How a token can be paid: a connected wallet signs, a wallet must be connected first, a deposit address (QR), or never. */
export type PayMode = "wallet" | "connect" | "deposit" | "none";

/** A Token with the viewer's state (balance, price, owner). What every picker, card and quote request works with. */
export interface SwapToken extends Token {
  /** Base units, "0" when unknown. */
  amount: string;
  balance: BalanceState;
  priceUsd?: number;
  usd: number;
  /** The connected wallet's address on this family; null → the UI must collect a recipient / refund address. */
  owner: string | null;
  payMode: PayMode;
}

/** Symbol → USD, keyed by catalog symbols AND shared native symbols (TON/GRAM, XDAI/xDAI). One stable object until it changes. */
export type PriceMap = Readonly<Record<string, number>>;

/** Connected addresses per family — the only source of `SwapToken.owner`. */
export type Owners = Readonly<Partial<Record<Family, string>>>;

/** The form's token pair, by `Token.key`. */
export interface Pair {
  pay: string;
  receive: string;
}

/** An address field's content for one family (mobile lib/send/recipient.ts). "name" = an ENS-style name (EVM only; swaps refuse names). */
export type RecipientCheck =
  | {kind: "empty"}
  | {kind: "address"; address: string}
  | {kind: "name"; name: string}
  | {kind: "invalid"; reason: string};

/** "Send to another address" / refund field verdict (mobile lib/swap/recipient.ts). */
export type SwapRecipient = {kind: "empty"} | {kind: "ok"; address: string} | {kind: "invalid"; reason: string};

/** One entry of the token sheet's network rail (mobile lib/swap/tokens.ts PickerNetwork). */
export interface PickerNetwork {
  slug: string;
  name: string;
  /** USD held on it among the listed tokens (0 = nothing held). */
  usd: number;
  held: boolean;
}
