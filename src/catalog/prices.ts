/**
 * USD prices with no backend (catalog.md §4, D6): DefiLlama first (keyless, CORS `*`, no 429 seen in a 20-call
 * burst), CoinGecko `simple/price` as the fallback only (keyless = ~5 calls then a 429 whose response has no CORS
 * header, so the browser sees a TypeError). Output = symbol → USD, the exact shape the router's `usdValue` and the
 * mobile code consume. No stablecoin is pinned to $1 here: the router already pars USDC/USDT/DAI when a price is
 * missing, and a real de-peg must show.
 */
import {getRuntimeConfig} from "../config";
import type {PriceMap, Token} from "../contracts/domain";

/**
 * Symbol → price id. A plain value is a CoinGecko id (DefiLlama key `coingecko:<id>`); a value with ":" is a
 * DefiLlama `<chain>:<contract>` key (no CoinGecko fallback). Source: cp0x-elysium apps/api v2Balances GECKO_IDS
 * (@756b115) plus web additions (catalog.md Appendix A). Keys = catalog symbols + shared native symbols
 * (TON/GRAM, XDAI/xDAI), so both the display symbol and the catalog symbol of a native resolve.
 */
export const PRICE_IDS: Readonly<Record<string, string>> = {
  ETH: "ethereum", WETH: "weth", BTC: "bitcoin", ZEC: "zcash", WBTC: "wrapped-bitcoin", cbBTC: "coinbase-wrapped-btc",
  BTCB: "bitcoin", BNB: "binancecoin", WBNB: "binancecoin", SOL: "solana", TON: "the-open-network",
  GRAM: "the-open-network", TRX: "tron", NEAR: "near", POL: "polygon-ecosystem-token", AVAX: "avalanche-2",
  USDT: "tether", USDC: "usd-coin", USDbC: "bridged-usd-coin-base", BUSD: "binance-usd", DAI: "dai",
  stETH: "staked-ether", wstETH: "wrapped-steth", SSV: "ssv-network", cSSV: "ssv-network", tsTON: "tonstakers",
  stSOL: "lido-staked-sol", JitoSOL: "jito-staked-sol", LINK: "chainlink", UNI: "uniswap", AAVE: "aave",
  HYPE: "hyperliquid", ARB: "arbitrum", OP: "optimism", USDe: "ethena-usde", PYUSD: "paypal-usd", USDT0: "tether",
  USDG: "global-dollar", pUSD: "usd-coin", PEPE: "pepe", CELO: "celo", ZK: "zksync", USDm: "usd-coin",
  AUSD: "usd-coin", MON: "monad", WMON: "monad", XPL: "plasma", WXPL: "plasma", LINEA: "linea", xDAI: "xdai",
  XDAI: "xdai", WXDAI: "xdai", BERA: "berachain-bera", WBERA: "berachain-bera", GNO: "gnosis", S: "sonic-3",
  wS: "sonic-3", stS: "sonic-3", SEI: "sei-network", WSEI: "sei-network", PLUME: "plume", WPLUME: "plume", OKB: "okb",
  WOKB: "okb", WLD: "worldcoin-wld", kBTC: "wrapped-bitcoin", MNT: "mantle", WMNT: "mantle",
  mETH: "mantle-staked-ether", FBTC: "ignition-fbtc", FLR: "flare-networks", WFLR: "flare-networks",
  sFLR: "sceptre-staked-flr", FXRP: "ripple", EURC: "euro-coin", cirBTC: "bitcoin", "USDC.e": "usd-coin",
  KAT: "katana-network-token", SHIB: "shiba-inu", AAVE0: "hybridge-bridged-aave", APE: "apecoin",
  "BTC.b": "bitcoin-avalanche-bridged-btc-b", COW: "cow-protocol", Cake: "pancakeswap-token", ENA: "ethena",
  ETHFI: "ether-fi", EURe: "monerium-eur-money-2", GHO: "gho", JUP: "jupiter-exchange-solana",
  LBTC: "lombard-staked-btc", LDO: "lido-dao", "M-BTC": "merlin-s-seal-btc", MEGA: "megaeth", MORPHO: "morpho",
  PENDLE: "pendle", SAFE: "safe", SKY: "sky", SolvBTC: "solv-btc", TRB: "tellor", USD1: "usd1-wlfi", USDS: "usds",
  USDY: "ondo-us-dollar-yield", VIRTUAL: "virtual-protocol", WAVAX: "wrapped-avax", WHYPE: "wrapped-hype",
  WPOL: "wmatic", XAUM: "matrixdock-gold", XAUt0: "tether-gold-tokens", YFI: "yearn-finance", ZRO: "layerzero",
  crvUSD: "crvusd", ezETH: "renzo-restaked-eth",
  frxETH: "frax-ether", frxUSD: "frax-usd", kHYPE: "kinetic-staked-hype", UBTC: "unit-bitcoin", UETH: "unit-ethereum",
  KNTQ: "kinetiq", mTBILL: "midas-mtbill", rETH: "rocket-pool-eth", reUSD: "re-protocol-reusd",
  rsETH: "kelp-dao-restaked-eth", rswETH: "restaked-swell-eth", sUSDS: "susds", sUSDe: "ethena-staked-usde",
  sfrxUSD: "staked-frax-usd", uniBTC: "universal-btc", wBETH: "wrapped-beacon-eth", weETH: "wrapped-eeth",
  xSolvBTC: "solv-protocol-solvbtc-bbn", "AAVE.e": "aave", "LINK.e": "chainlink", "UNI.e": "uniswap", "WETH.e": "weth",
  // ── web additions (not in the wallet's GECKO_IDS): catalog symbols that had no id ──
  CRV: "curve-dao-token", scrvUSD: "savings-crvusd", FDUSD: "first-digital-usd", GOMINING: "gmt-token",
  TSLAx: "tesla-xstock", NVDAx: "nvidia-xstock", AURORA: "aurora-near", LTC: "litecoin", DOGE: "dogecoin",
  XRP: "ripple", BCH: "bitcoin-cash", ATOM: "cosmos", ADA: "cardano", XLM: "stellar", APT: "aptos", SUI: "sui",
  // DefiLlama contract keys (no usable CoinGecko id there):
  iSEI: "sei:0x5Cf6826140C1C56Ff49C808A1A75407Cd1DF9423",
  brBTC: "xlayer:0xa161132371c94299d215915d4cbc3b629e2059be", // the wallet maps it to "bedrock-btc", unknown to DefiLlama
};

/** Fewer DefiLlama prices than this means a degraded answer: CoinGecko fills the gaps. */
const LLAMA_MIN = 20;
const TIMEOUT_MS = 8_000;

const llamaKey = (id: string) => (id.includes(":") ? id : `coingecko:${id}`);
const base = (u: string) => u.replace(/\/+$/, "");
const usable = (p: unknown): p is number => typeof p === "number" && Number.isFinite(p) && p > 0;

/** The outer abort (react-query's) plus our own timeout. AbortSignal.any is recent (Safari 17.4), so it is optional. */
export function withTimeout(ms: number, outer?: AbortSignal): AbortSignal {
  const own = AbortSignal.timeout(ms);
  if (!outer) return own;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([outer, own]);
  const c = new AbortController();
  const stop = () => c.abort();
  outer.addEventListener("abort", stop, {once: true});
  own.addEventListener("abort", stop, {once: true});
  return c.signal;
}

/** DefiLlama: one GET for every key, mapped back to every symbol that uses it. Keys compared case-insensitively. */
export async function fromLlama(signal?: AbortSignal): Promise<Record<string, number>> {
  const keys = [...new Set(Object.values(PRICE_IDS).map(llamaKey))].sort();
  const url = `${base(getRuntimeConfig().prices.defillama)}/prices/current/${keys.join(",")}?searchWidth=6h`;
  const res = await fetch(url, {signal: withTimeout(TIMEOUT_MS, signal)});
  if (!res.ok) throw new Error(`defillama ${res.status}`);
  const body = (await res.json()) as {coins?: Record<string, {price?: unknown} | undefined>} | null;
  const byKey = new Map(Object.entries(body?.coins ?? {}).map(([k, v]) => [k.toLowerCase(), v?.price]));
  const out: Record<string, number> = {};
  for (const [symbol, id] of Object.entries(PRICE_IDS)) {
    const p = byKey.get(llamaKey(id).toLowerCase());
    if (usable(p)) out[symbol] = p;
  }
  return out;
}

/** CoinGecko: the plain ids only (contract keys are DefiLlama-only). */
export async function fromGecko(signal?: AbortSignal): Promise<Record<string, number>> {
  const ids = [...new Set(Object.values(PRICE_IDS).filter((id) => !id.includes(":")))].sort();
  const url = `${base(getRuntimeConfig().prices.coingecko)}/simple/price?ids=${ids.join(",")}&vs_currencies=usd`;
  const res = await fetch(url, {signal: withTimeout(TIMEOUT_MS, signal)});
  if (!res.ok) throw new Error(`coingecko ${res.status}`);
  const body = (await res.json()) as Record<string, {usd?: unknown} | undefined> | null;
  const out: Record<string, number> = {};
  for (const [symbol, id] of Object.entries(PRICE_IDS)) {
    const p = body?.[id]?.usd;
    if (usable(p)) out[symbol] = p;
  }
  return out;
}

/**
 * Symbol → USD. Never throws: {} when both sources fail (the router then ranks on raw output). A thin DefiLlama
 * answer is topped up from CoinGecko, DefiLlama winning where both have a price.
 */
export async function fetchPrices(signal?: AbortSignal): Promise<Record<string, number>> {
  let llama: Record<string, number> = {};
  try {
    llama = await fromLlama(signal);
    if (Object.keys(llama).length > LLAMA_MIN) return llama;
  } catch {
    // fall through to CoinGecko
  }
  try {
    return {...(await fromGecko(signal)), ...llama};
  } catch {
    return llama;
  }
}

/**
 * DefiLlama's chain key per importable network (D39), for `<chain>:<contract>` price keys. Each one checked against
 * that network's listed USDC / USDT / USDG on 2026-11-16 (a unit test holds every importable network to having one).
 */
export const LLAMA_CHAINS: Readonly<Record<string, string>> = {
  ethereum: "ethereum", arbitrum: "arbitrum", optimism: "optimism", base: "base", solana: "solana", polygon: "polygon",
  bsc: "bsc", avalanche: "avax", zksync: "era", linea: "linea", scroll: "scroll", unichain: "unichain", monad: "monad",
  hyperevm: "hyperliquid", gnosis: "xdai", sonic: "sonic", berachain: "berachain", celo: "celo", plasma: "plasma",
  megaeth: "megaeth", robinhood: "robinhood", worldchain: "wc", sei: "sei", ink: "ink", plume: "plume_mainnet",
  xlayer: "xlayer", mantle: "mantle", katana: "katana", morph: "morph", flare: "flare", arc: "arc", elysium: "elysium",
};

/** Below this DefiLlama confidence an imported token's price isn't shown: a thin pool's guess reads as "no price". */
export const IMPORTED_MIN_CONFIDENCE = 0.9;

/** An imported token's DefiLlama key, by its contract or mint — never its symbol (D39); null for a catalog token. */
export const importedPriceKey = (t: Pick<Token, "chain" | "contract" | "imported">): string | null => {
  const chain = LLAMA_CHAINS[t.chain];
  return t.imported && t.contract && chain ? `${chain}:${t.contract}` : null;
};

/**
 * The imported tokens' USD prices, token key → USD (D39): one DefiLlama GET for all of them, by contract or mint, so a
 * copy named "USDC" gets its own price or none — never USDC's. A price under IMPORTED_MIN_CONFIDENCE is left out. No
 * CoinGecko fallback (its contract endpoint is per network, and keyless it allows ~5 calls). Throws on a failed request
 * (react-query keeps the last good map).
 */
export async function fetchImportedPrices(tokens: readonly Token[], signal?: AbortSignal): Promise<Record<string, number>> {
  const keyed = tokens.flatMap((t) => {
    const k = importedPriceKey(t);
    return k ? [{token: t.key, key: k, evm: t.family === "evm"}] : [];
  });
  if (!keyed.length) return {};
  const keys = [...new Set(keyed.map((x) => x.key))].sort();
  const url = `${base(getRuntimeConfig().prices.defillama)}/prices/current/${keys.join(",")}?searchWidth=6h`;
  const res = await fetch(url, {signal: withTimeout(TIMEOUT_MS, signal)});
  if (!res.ok) throw new Error(`defillama ${res.status}`);
  const body = (await res.json()) as {coins?: Record<string, {price?: unknown; confidence?: unknown} | undefined>} | null;
  const coins = body?.coins ?? {};
  // A mint is case-sensitive, so only an EVM key falls back to a case-insensitive match.
  const lower = new Map(Object.entries(coins).map(([k, v]) => [k.toLowerCase(), v]));
  const out: Record<string, number> = {};
  for (const x of keyed) {
    const coin = coins[x.key] ?? (x.evm ? lower.get(x.key.toLowerCase()) : undefined);
    const p = coin?.price;
    const c = coin?.confidence;
    if (usable(p) && (typeof c !== "number" || c >= IMPORTED_MIN_CONFIDENCE)) out[x.token] = p;
  }
  return out;
}

/**
 * A symbol's price with the router's lookup rules (protocol-swap2-router `priceOf`: as written, upper-cased, then
 * without a leading w/W from 3 characters — NEAR's `wBTC` → WBTC), minus its $1 default for stables: the display
 * shows "no price" rather than a guess. Keeps the token list and the route ranking on the same numbers.
 */
export function priceFor(prices: PriceMap, symbol: string): number | undefined {
  const tries = [symbol, symbol.toUpperCase()];
  if (/^w/i.test(symbol) && symbol.length > 2) tries.push(symbol.slice(1), symbol.slice(1).toUpperCase());
  for (const t of tries) {
    const p = prices[t];
    if (usable(p)) return p;
  }
  return undefined;
}

// ── warm start (per-viewer convenience only, D16) ──

const STORE_KEY = "cp0x.prices.v1";
/** Older than this, a remembered map is not shown even as a placeholder: fee caps and warnings read it. */
const WARM_MAX_AGE_MS = 30 * 60_000;

/** The last prices this browser saw, if recent; undefined when absent, stale, unreadable or storage is blocked. */
export function lastKnownPrices(now = Date.now()): PriceMap | undefined {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as {at?: unknown; prices?: unknown} | null;
    if (!v || typeof v.at !== "number" || now - v.at > WARM_MAX_AGE_MS || now < v.at) return undefined;
    if (!v.prices || typeof v.prices !== "object") return undefined;
    const out: Record<string, number> = {};
    for (const [k, p] of Object.entries(v.prices as Record<string, unknown>)) if (usable(p) && k in PRICE_IDS) out[k] = p;
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Remember a fresh map for the next page load. Storage failures are ignored (private mode, quota). */
export function rememberPrices(prices: PriceMap, now = Date.now()): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({at: now, prices}));
  } catch {
    // per-viewer convenience only
  }
}

/** react-query's fetcher: throws when nothing could be priced, so a failed refresh keeps the last good map. */
export async function loadPrices(signal?: AbortSignal): Promise<Record<string, number>> {
  const prices = await fetchPrices(signal);
  if (!Object.keys(prices).length) throw new Error("No price source answered.");
  rememberPrices(prices);
  return prices;
}
