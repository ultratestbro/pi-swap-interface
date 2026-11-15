/**
 * What the UI knows about venues beyond the providers themselves (D17): display
 * names, which ones need a claim on arrival, and the approval spender a dry
 * quote leaves unnamed. Routing itself is the real providers' supportsRoute —
 * the mobile capability tables are not ported.
 */
import {ACROSS_NATIVE, acrossRouteOf} from "@anywalletkit/protocol-swap2-across/config";
import {acrossRouteUnpriced} from "@anywalletkit/protocol-swap2-across/pricing";
import {CF_VAULTS} from "@anywalletkit/protocol-swap2-chainflip/config";
import {ZEROEX_CHAINS, ZEROEX_PERMIT2, zeroExChain, zeroExChainId} from "@anywalletkit/protocol-swap2-0x/chains";
import {chainByCaip2Web} from "../catalog";

/** Mobile lib/swap/providers.ts PROVIDER_NAMES, plus Curve, 0x and Across. */
export const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  near_intents: "NEAR Intents",
  lifi: "LI.FI",
  thorchain: "THORChain",
  cctp: "Circle CCTP",
  usdt0: "USDT0",
  chainflip: "Chainflip",
  relay: "Relay",
  symbiosis: "Symbiosis",
  omniston: "Omniston",
  uniswap: "Uniswap",
  curve: "Curve",
  wrap: "Wrap",
  balancer: "Balancer",
  fynd: "Fynd",
  jupiter: "Jupiter",
  zeroex: "0x",
  across: "Across",
};

/** A venue's display name; unknown names pass through. */
export const providerName = (p: string): string => PROVIDER_NAMES[p] ?? p;

/**
 * Delivery needs a claim transaction on the destination (the review says "claim
 * on arrival"). Not `!!provider.buildClaim`: usdt0 has one only to retry a
 * reverted delivery.
 */
export const TWO_PHASE: ReadonlySet<string> = new Set(["cctp"]);

/**
 * Inline copy of the SDK's AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS (first entry per
 * chain, snapshot 2026-11-11), so the main bundle never imports the Omniston
 * package. providerMeta.test.ts asserts it equals the package export.
 */
export const OMNISTON_ORDER_PROTOCOL: Readonly<Record<string, string>> = {
  "eip155:1": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
  "eip155:56": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
  "eip155:137": "0xafCF681272AF10959736f45616eeCBC22D7095E2",
  "eip155:8453": "0xe7405fAcDEDB2512e91F2886BDff13231343aF5E",
  "eip155:42161": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
  "eip155:43114": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
  "eip155:196": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
  "eip155:9745": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
  "eip155:999": "0xD84778bbeEC5D2a8d17c6424249C438EC0b1ABE3",
};

/** 0x serves this EVM network (its chain table: Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, BNB Chain). */
const zeroExServes = (chain: string): boolean => !!zeroExChain(ZEROEX_CHAINS, zeroExChainId(chain));

/**
 * The spender an ERC-20 source on `chain` must be approved for when the dry
 * quote names none, or null. Omniston: its gasless order is built after the
 * quote. Chainflip: a dry quote carries no txRequest, so the vault it will call
 * (CF_VAULTS) is named here. 0x: a price (dry) answer carries no transaction;
 * its token sales approve canonical Permit2 only, never a 0x contract (the
 * Settler pulls the input through a one-time Permit2 signature, D38). Every
 * other EVM venue names txRequest.approvalAddress in its dry quote.
 */
export function orderSpender(provider: string, chain: string): string | null {
  if (provider === "omniston") return OMNISTON_ORDER_PROTOCOL[chain] ?? null;
  if (provider === "chainflip" && chain.startsWith("eip155:")) return CF_VAULTS[chain] ?? null;
  if (provider === "zeroex" && zeroExServes(chain)) return ZEROEX_PERMIT2;
  return null;
}

/**
 * Venues whose token sale is paid by a one-time Permit2 signature transfer (swap2-core 0.13.0): the wallet signs a
 * PermitTransferFrom for exactly the input first, then (unless a standing Permit2 allowance covers it) approves
 * Permit2, then sends the swap carrying the signature. The review says so (D38).
 */
export const PERMIT2_VENUES: ReadonlySet<string> = new Set(["zeroex"]);

/** One side of a pair as venueScope reads it (a SwapToken fits). */
export interface ScopeSide {
  caip2: string;
  family: string;
  symbol: string;
  /** null = the network's native coin; absent = unknown. */
  contract?: string | null;
  /** Imported by its address (D39): not in any venue's own token list. */
  imported?: boolean;
}

/**
 * Venues that serve listed tokens only (D39): their providers resolve both sides in their own asset lists, so a token
 * imported by its address is never asked of them (each one's supportsRoute is false). Probed 2026-11-15 with dry quotes
 * for DEGEN on Base, PEPE on Ethereum and BONK on Solana: Uniswap, LI.FI, Fynd and 0x quoted them on one network, LI.FI
 * between networks (EVM and Solana, either side), Relay into one (out of one it refuses: its deposit would first swap
 * through a router it doesn't sign for), Jupiter within Solana; Curve and Balancer are asked and find no pinned pool.
 */
export const LISTED_ONLY_VENUES: ReadonlySet<string> = new Set(["usdt0", "cctp", "thorchain", "chainflip", "near_intents", "symbiosis", "omniston", "across"]);

/** Venues that also swap within one network (their own supportsSameChain); the router asks no other venue then. */
const SAME_CHAIN_VENUES: ReadonlySet<string> = new Set(["lifi", "uniswap", "curve", "wrap", "balancer", "fynd", "jupiter", "omniston", "zeroex"]);

const isSymbol = (x: ScopeSide, ...names: string[]) => names.includes(x.symbol.toUpperCase());

/**
 * Where the protocol itself goes beyond what its module serves here: CCTP to Solana; USDT0 out of Tron or TON (not
 * built in usdt0 0.5.0).
 */
const BEYOND_MODULE: Readonly<Record<"cctp" | "usdt0", ReadonlySet<string>>> = {cctp: new Set(["solana"]), usdt0: new Set(["tron", "ton"])};

/**
 * Non-EVM destinations a module reaches from some EVM networks only: USDT0's Legacy Mesh into TON and Tron
 * (providers.ts meshDestinations). Its third source, Celo, sends a USDT the catalog doesn't list, so the pickers reach
 * it from these two.
 */
const INTO_FROM: Readonly<Partial<Record<"cctp" | "usdt0", Readonly<Record<string, string>>>>> = {
  usdt0: {ton: "Ethereum or Arbitrum", tron: "Ethereum or Arbitrum"},
};

/**
 * A one-coin bridge (CCTP: USDC, USDT0: USDT), by the first reason that holds: a network outside EVM ("yet" where the
 * protocol reaches it but its module doesn't, or the networks it reaches it from), the same network, another coin, then
 * a network the module doesn't list. CCTP covers EVM networks only (19); USDT0 its 16 EVM deployments plus the mesh.
 */
function bridgeScope(provider: "cctp" | "usdt0", coin: string, symbols: readonly string[], from: ScopeSide, to: ScopeSide): string {
  const outside = from.family !== "evm" ? from : to.family !== "evm" ? to : null;
  if (outside) {
    const name = chainByCaip2Web(outside.caip2)?.name ?? outside.family;
    const into = outside === to ? INTO_FROM[provider]?.[to.family] : undefined;
    if (into) return !isSymbol(from, ...symbols) || !isSymbol(to, ...symbols) ? `Moves ${coin} only` : `Into ${name} from ${into} only`;
    return `${name} isn't supported here${BEYOND_MODULE[provider].has(outside.family) ? " yet" : ""}`;
  }
  if (from.caip2 === to.caip2) return "Between networks only";
  if (!isSymbol(from, ...symbols) || !isSymbol(to, ...symbols)) return `Moves ${coin} only`;
  return "Not on one of these networks";
}

/**
 * Across's scope for a pair it wasn't asked for, by the first reason that holds, read from its own route check
 * (protocol-swap2-across `acrossRouteOf`, `acrossRouteUnpriced`): EVM only; between networks only; its 17 pinned
 * networks; the same asset on both sides (USDC, USDT / USDT0, ETH / WETH, WBTC); ETH as a native coin only where the
 * SpokePool wraps it; WETH arrives as ETH; nothing into Ethereum yet.
 */
function acrossScope(from: ScopeSide, to: ScopeSide): string {
  if (from.family !== "evm" || to.family !== "evm") return "EVM networks only here";
  if (from.caip2 === to.caip2) return "Between networks only";
  if (from.contract === undefined || to.contract === undefined) return "Doesn't cover this pair";
  const route = acrossRouteOf(from.caip2, from.contract ?? ACROSS_NATIVE, to.caip2, to.contract ?? ACROSS_NATIVE);
  if ("code" in route) {
    switch (route.code) {
      case "chain-unsupported":
        return "Not on one of these networks";
      case "native-unsupported":
        return "Moves ETH as a native coin only";
      case "wrapped-native-destination":
        return "Delivers ETH, not WETH — pick ETH";
      case "pair-unsupported":
        return "Same token on both networks only";
      case "token-unsupported":
        return "Doesn't list one of these tokens";
    }
  }
  return acrossRouteUnpriced(route) ? "Not into Ethereum yet" : "Doesn't cover this pair";
}

/**
 * The lines that blame the tokens (or don't say), where an imported side is the reason a listed-only venue passed: they
 * read "Listed tokens only" then. A network line stands — a venue that can't serve these networks wouldn't serve the
 * pair with listed tokens either.
 */
const TOKEN_LINES: ReadonlySet<string> = new Set(["Doesn't cover this pair", "Doesn't list one of these tokens", "Moves USDC only", "Moves USDT only"]);

/** An imported side as a coin-only bridge reads it: no symbol, since a copy named USDC isn't USDC to CCTP. */
const unlisted = (x: ScopeSide): ScopeSide => (x.imported ? {...x, symbol: ""} : x);

/**
 * Why an enabled venue wasn't asked for this pair, in one honest line (the route list's "Not for this pair" group).
 * A venue that serves listed tokens only reads "Listed tokens only" for a token imported by its address (D39) — unless
 * its usual line names the networks, which stands (Omniston on Solana: "Doesn't cover these networks").
 * The decision itself is each provider's supportsRoute (D17); these lines only name the venue's scope, and stay
 * generic ("Doesn't cover this pair") where the answer is in a venue's token list — THORChain has no USDT on Solana,
 * for one, but the app would only be guessing which token is missing.
 */
export function venueScope(provider: string, from: ScopeSide, to: ScopeSide): string {
  if (!(from.imported || to.imported) || !LISTED_ONLY_VENUES.has(provider)) return usualScope(provider, from, to);
  const usual = usualScope(provider, unlisted(from), unlisted(to));
  return TOKEN_LINES.has(usual) ? "Listed tokens only" : usual;
}

/** A venue's scope line for the pair, by the first reason that holds (venueScope's, before an import's). */
function usualScope(provider: string, from: ScopeSide, to: ScopeSide): string {
  const sameNet = from.caip2 === to.caip2;
  const evm = from.family === "evm" && to.family === "evm";
  switch (provider) {
    case "uniswap":
    case "curve":
    case "balancer":
    case "fynd":
      return sameNet ? "Not on this network" : "Same-network swaps only";
    case "zeroex":
      // Same network only, on its 7 chains (Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, BNB Chain).
      if (!sameNet) return "Same-network swaps only";
      return zeroExServes(from.caip2) ? "Doesn't cover this pair" : "Not on this network";
    case "across":
      return acrossScope(from, to);
    case "wrap":
      return "Wraps only, like ETH ⇄ WETH";
    case "jupiter":
      return sameNet && from.family === "solana" ? "Doesn't list one of these tokens" : "Swaps within Solana only";
    case "cctp":
      return bridgeScope("cctp", "USDC", ["USDC"], from, to);
    case "usdt0":
      return bridgeScope("usdt0", "USDT", ["USDT", "USDT0"], from, to);
    case "relay":
      if (!evm) return "EVM networks only here";
      return sameNet ? "Between networks only" : "Not on one of these networks";
    case "lifi":
      return "Doesn't cover these networks";
    case "omniston":
      // EVM networks and TON only; its one same-network swap is TON ↔ TON; between networks it moves tokens only
      // (omnistonLazy omnistonTokenLegs).
      if (![from, to].every((x) => x.family === "evm" || x.family === "ton")) return "Doesn't cover these networks";
      if (sameNet) return from.family === "evm" ? "Between networks only" : "Doesn't cover this pair";
      return from.contract === null || to.contract === null ? "Tokens only between networks" : "Doesn't cover this pair";
    case "symbiosis":
      // Its chain table has no Solana (EVM, Tron, TON, Bitcoin); it never swaps within one network.
      if (from.family === "solana" || to.family === "solana") return "Solana isn't supported here";
      return sameNet ? "Between networks only" : "Doesn't cover this pair";
  }
  return sameNet && !SAME_CHAIN_VENUES.has(provider) ? "Between networks only" : "Doesn't cover this pair";
}
