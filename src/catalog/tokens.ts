/**
 * The token universe of the swap pickers (catalog.md §3.4, D4): every swap2-assets entry on a listed network
 * (405 on the 37), built once at module load. Port of mobile lib/swap/tokens.ts @756b115: the web lists every
 * network (not only those a wallet has an address on) because the receive side can pay out to a typed address
 * and BTC/ZEC/… pay through a deposit address. Balances and prices are joined in `swapTokens`. No React.
 */
import {ccChain} from "@anywalletkit/swap2-assets";
import type {Balance, Chain, Owners, Pair, PayMode, PickerNetwork, PriceMap, SwapToken, Token} from "../contracts/domain";
import {CHAINS, unitsToDecimal} from "../shared";
import {CHAIN_LIST, QR_FALLBACK_FAMILIES, SIGNING_FAMILIES, chainBySlugWeb} from "./network";
import {priceFor} from "./prices";

/** The engine's "native coin" token id on every chain. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Gas tokens the catalog lists by their ERC-20 face (apps/api v2Balances NATIVE_ERC20_ALIASES): Celo's CELO and
 * Arc's USDC have no native entry, so MAX must still keep a gas reserve for them.
 */
const GAS_TOKEN_CONTRACTS: Readonly<Record<string, string>> = {
  celo: "0x471ece3750da237f93b8e339c536989b8978a438",
  arc: "0x3600000000000000000000000000000000000000",
};

/** `<slug>:<contract lowercased | "native">` — list key, balance key, hash param, test id suffix. */
export const tokenKey = (slug: string, contract: string | null): string => `${slug}:${contract ? contract.toLowerCase() : "native"}`;

/** Every catalog asset on `chains`, network display order, each network's native first, then catalog order. */
export function catalogTokens(chains: readonly Chain[] = CHAIN_LIST): Token[] {
  const out: Token[] = [];
  for (const chain of chains) {
    const assets = [...(ccChain(chain.caip2)?.assets ?? [])].sort((a, b) => Number(!!a.contract) - Number(!!b.contract));
    for (const a of assets) {
      const contract = a.contract ?? null;
      out.push({
        key: tokenKey(chain.slug, contract),
        chain: chain.slug,
        caip2: chain.caip2,
        chainName: chain.name,
        family: chain.family,
        // Natives read as the chain's own symbol (TON, not the catalog's GRAM; XDAI, not xDAI).
        symbol: contract ? a.symbol : chain.native.symbol,
        catalogSymbol: a.symbol,
        decimals: a.decimals,
        contract,
        gasToken: !contract || GAS_TOKEN_CONTRACTS[chain.slug] === contract.toLowerCase(),
        ...(a.icon ? {icon: a.icon} : {}),
      });
    }
  }
  return out;
}

/** The static catalog (405 tokens on the 37 networks; more with VITE_EXTRA_CHAINS). */
export const TOKENS: readonly Token[] = catalogTokens();

/** Token by key. */
export const TOKEN_BY_KEY: ReadonlyMap<string, Token> = new Map(TOKENS.map((t) => [t.key, t]));

const BY_CHAIN = new Map<string, Token[]>();
for (const t of TOKENS) BY_CHAIN.set(t.chain, [...(BY_CHAIN.get(t.chain) ?? []), t]);

/** A network's catalog tokens (native first) — what one balance read covers. */
export const tokensOf = (slug: string): readonly Token[] => BY_CHAIN.get(slug) ?? [];

/** The engine's destination token id: the contract, or the zero address for a native coin (every family). */
export const destTokenId = (t: Pick<Token, "contract">): string => t.contract ?? ZERO_ADDRESS;

/**
 * How `t` can be paid: a connected wallet of its family signs ("wallet"), one must be connected first ("connect"),
 * BTC/ZEC/extras — and Tron, TON or NEAR while no wallet of that family is connected — go through a deposit address
 * ("deposit"), and receive-only chains never pay.
 */
export function payModeOf(t: Pick<Token, "family">, chain: Pick<Chain, "receiveOnly"> | undefined, owners: Owners): PayMode {
  if (!chain || chain.receiveOnly) return "none";
  if (SIGNING_FAMILIES.has(t.family)) return owners[t.family] ? "wallet" : QR_FALLBACK_FAMILIES.has(t.family) ? "deposit" : "connect";
  return "deposit";
}

const NO_IMPORTED_PRICES: PriceMap = Object.freeze({});

/**
 * A token's USD price: its display symbol first (TON, XDAI), then the catalog symbol, router lookup rules. An imported
 * token (D39) only by its key in `imported` (found by its contract, `fetchImportedPrices`), never by its symbol: that is
 * its deployer's word, and a copy named "USDC" must not show USDC's price.
 */
export const tokenPrice = (
  t: Pick<Token, "key" | "symbol" | "catalogSymbol" | "imported">,
  prices: PriceMap,
  imported: PriceMap = NO_IMPORTED_PRICES,
): number | undefined => (t.imported ? imported[t.key] : (priceFor(prices, t.symbol) ?? priceFor(prices, t.catalogSymbol)));

/**
 * Tokens with the viewer's state: held first (by USD, then units), the rest in catalog order. A family with no
 * connected wallet reads balance "none" and owner null (the UI then asks for a recipient / refund address). A
 * failed read is "error" with amount "0" — render "—", never 0.
 */
export function swapTokens(
  tokens: readonly Token[],
  balances: Readonly<Record<string, Balance>>,
  prices: PriceMap,
  owners: Owners,
  importedPrices?: PriceMap,
): SwapToken[] {
  const out = tokens.map((t): SwapToken => {
    const owner = owners[t.family] ?? null;
    const b = owner ? balances[t.key] : undefined;
    const amount = b?.state === "loaded" ? b.amount : "0";
    const priceUsd = tokenPrice(t, prices, importedPrices);
    const usd = priceUsd !== undefined && amount !== "0" ? Number(unitsToDecimal(amount, t.decimals)) * priceUsd : 0;
    return {
      ...t,
      amount,
      balance: owner ? (b?.state ?? "loading") : "none",
      ...(priceUsd !== undefined ? {priceUsd} : {}),
      usd,
      owner,
      payMode: payModeOf(t, chainBySlugWeb(t.chain), owners),
    };
  });
  const units = (t: SwapToken) => Number(unitsToDecimal(t.amount, t.decimals));
  const held = out.filter((t) => t.amount !== "0").sort((a, b) => b.usd - a.usd || units(b) - units(a));
  return [...held, ...out.filter((t) => t.amount === "0")];
}

// ── mobile lib/swap/tokens.ts L127-208 (verbatim but for the noted lines) ────────────────────────────────────────

/**
 * Token search: symbol, catalog symbol, network name or slug, or a contract prefix of 4+ characters. An imported token
 * (D39) by its name instead of its catalog symbol (its contract: a prefix only, like every contract).
 */
export function matchesToken(t: SwapToken, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return (
    t.symbol.toLowerCase().includes(s) ||
    (t.imported ? !!t.name && t.name.toLowerCase().includes(s) : t.catalogSymbol.toLowerCase().includes(s)) ||
    t.chainName.toLowerCase().includes(s) ||
    t.chain.includes(s) ||
    (!!t.contract && s.length >= 4 && t.contract.toLowerCase().startsWith(s))
  );
}

/** Networks always at the top of the picker's rail, in this order. */
export const PINNED_NETWORKS: readonly string[] = ["ethereum", "solana", "tron", "bitcoin", "ton", "near"];

/**
 * The picker's network rail: every network `tokens` has, the pinned six
 * first, then networks the wallet holds something on, then the rest — the
 * last two in catalog order.
 */
export function pickerNetworks(tokens: readonly SwapToken[]): PickerNetwork[] {
  const by = new Map<string, PickerNetwork>();
  for (const t of tokens) {
    const n = by.get(t.chain) ?? {slug: t.chain, name: t.chainName, usd: 0, held: false};
    if (t.amount !== "0") {
      n.held = true;
      n.usd += t.usd;
    }
    by.set(t.chain, n);
  }
  const order = (slug: string) => {
    const pin = PINNED_NETWORKS.indexOf(slug);
    if (pin >= 0) return pin;
    const i = CHAINS.findIndex((c) => c.slug === slug);
    return PINNED_NETWORKS.length + (by.get(slug)!.held ? 0 : CHAINS.length) + (i < 0 ? CHAINS.length : i);
  };
  return [...by.values()].sort((a, b) => order(a.slug) - order(b.slug));
}

/** Picking for one side the token the other side holds swaps the two (handoff 12). */
export function pickSide(pair: Pair, side: "pay" | "receive", key: string): Pair {
  if (side === "pay") return {pay: key, receive: pair.receive === key ? pair.pay : pair.receive};
  return {receive: key, pay: pair.pay === key ? pair.receive : pair.pay};
}

/** The flip button. */
export const flipPair = (pair: Pair): Pair => ({pay: pair.receive, receive: pair.pay});

/**
 * The pair a fresh swap screen opens on: the asked-for pay token (hash
 * param), else the most valuable payable holding, else the first payable
 * native; receive = USDC on the same network (or its native coin when paying
 * USDC), else the first other token. Pass only payMode "wallet" tokens as
 * `pay` when choosing the opening pair (web: mobile also matched TON jettons
 * by their raw holdings key; web keys are the only form).
 */
export function defaultPair(pay: readonly SwapToken[], receive: readonly SwapToken[], prefer?: string): Pair | null {
  const from =
    (prefer ? pay.find((t) => t.key === prefer) : undefined) ??
    pay.find((t) => t.amount !== "0") ??
    pay.find((t) => !t.contract) ??
    pay[0];
  if (!from) return null;
  const sameChain = receive.filter((t) => t.chain === from.chain && t.key !== from.key);
  const usdc = (t: SwapToken) => t.symbol.toUpperCase() === "USDC";
  const to =
    (usdc(from) ? sameChain.find((t) => !t.contract) : sameChain.find(usdc)) ??
    sameChain[0] ??
    receive.find((t) => usdc(t) && t.key !== from.key) ??
    receive.find((t) => t.key !== from.key);
  return to ? {pay: from.key, receive: to.key} : null;
}
