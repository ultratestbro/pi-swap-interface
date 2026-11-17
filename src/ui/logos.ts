/**
 * Where every logo lives: static files under public/logos (D13), never a
 * runtime hotlink to a CMC / CoinGecko / Trust Wallet CDN (that would hand
 * every visitor's IP and token interest to them). URLs are relative, so
 * dist/ works from "/" and from a sub-path such as /ipfs/<cid>/.
 *
 * The tables mirror the bundled set of apps/mobile (756b115):
 * providers = assets/images/providers (plus Curve, rendered here the same
 * way), networks/tokens SVG = the split of the
 * generated assets/logos.ts (web3icons, MIT), token PNGs = AssetIcon.tsx
 * TOKEN_IMAGES. tests/unit/ui/logos.test.ts checks each entry has its file.
 */

/** A picture an <img> can show: `src` for 1×, `srcSet` (w descriptors) when sharper files exist. */
export interface LogoSource {
  src: string;
  srcSet?: string;
}

const BASE = "logos";

/** Venues with a bundled 32/64 px tile (opaque squares; the UI rounds the corners). */
export const PROVIDER_LOGOS: ReadonlySet<string> = new Set([
  "near_intents",
  "lifi",
  "thorchain",
  "cctp",
  "usdt0",
  "stargate",
  "chainflip",
  "relay",
  "symbiosis",
  "omniston",
  "uniswap",
  "curve",
  "balancer",
  "wrap",
  "fynd",
  "jupiter",
  "zeroex",
  "across",
]);

/** Catalog slugs with a network SVG: all 37 networks but `morph` (a monogram on mobile too). */
export const NETWORK_LOGOS: ReadonlySet<string> = new Set([
  "ethereum",
  "arbitrum",
  "optimism",
  "base",
  "polygon",
  "bsc",
  "avalanche",
  "zksync",
  "linea",
  "scroll",
  "unichain",
  "monad",
  "hyperevm",
  "gnosis",
  "sonic",
  "berachain",
  "celo",
  "plasma",
  "megaeth",
  "robinhood",
  "worldchain",
  "sei",
  "ink",
  "plume",
  "xlayer",
  "mantle",
  "katana",
  "flare",
  "arc",
  "solana",
  "ton",
  "tron",
  "bitcoin",
  "near",
  "zcash",
  "elysium",
]);

/** Upper-case symbols with a web3icons token SVG (public/logos/tokens/<SYM>.svg). */
export const TOKEN_SVGS: ReadonlySet<string> = new Set([
  "ETH", "BTC", "WBTC", "SOL", "TRX", "NEAR", "ZEC", "BNB", "POL", "AVAX", "ARB", "OP", "USDC", "USDT", "DAI", "USDE",
  "PYUSD", "FDUSD", "XAUT", "PAXG", "LINK", "UNI", "AAVE", "LDO", "CRV", "MKR", "PENDLE", "JUP", "CELO", "FLR", "MNT",
  "SEI", "GNO", "RETH", "CBETH", "MSOL", "GRT", "EUL", "LQTY", "AKT", "TORN",
]);

/**
 * Upper-case symbol → PNG stem (public/logos/tokens/png/<stem>@2x|@3x.png). These
 * win over the SVGs: the projects' own or newer marks, and a wrapped/bridged
 * token wears its underlying's (WPOL → pol, LINK.E → link, TON/GRAM → gram).
 */
export const TOKEN_IMAGES: Readonly<Record<string, string>> = {
  ARB: "arb", OP: "op", LDO: "ldo", COW: "cow", UNI: "uni", "UNI.E": "uni", OBOL: "obol", EUL: "eul", OGN: "ogn",
  SKY: "sky", STDRV: "stdrv", XEDEN: "xeden", SSV: "ssv", CSSV: "ssv", MORPHO: "morpho", MRPH: "morpho",
  KMNO: "kamino", MLW: "mellow", TON: "gram", GRAM: "gram", WETH: "weth", WBNB: "wbnb", WAVAX: "wavax",
  WMON: "wmon", WHYPE: "whype", WSEI: "wsei", WFLR: "wflr", WXDAI: "xdai", WPOL: "pol", "LINK.E": "link",
  "AAVE.E": "aave", AAVE0: "aave0", STETH: "steth", WSTETH: "wsteth", WBETH: "wbeth", WEETH: "weeth",
  RSETH: "rseth", METH: "meth", KHYPE: "khype", USDS: "usds", SUSDS: "susds", SUSDE: "susde", "USDC.E": "usdc",
  USDG: "usdg", USD1: "usd1", USDM: "usdm", AUSD: "ausd", PUSD: "pusd", USDY: "usdy", USDT0: "usdt0",
  FRXUSD: "frxusd", CRVUSD: "crvusd", GHO: "gho", EURC: "eurc", XAUT: "xaut", XAUT0: "xaut0", CBBTC: "cbbtc",
  CIRBTC: "cirbtc", "BTC.B": "btcb", LBTC: "lbtc", SOLVBTC: "solvbtc", UNIBTC: "unibtc", ENA: "ena",
  AURORA: "aurora", WLD: "wld", ZRO: "zro", ZK: "zk", LINEA: "linea", MEGA: "mega", SAFE: "safe", YFI: "yfi",
  HYPE: "hype", RAY: "ray", JTO: "jto", "1INCH": "1inch", STON: "ston", ACX: "acx", BAL: "bal", TSTON: "tston",
};

/**
 * Gas tokens without a logo of their own borrow their chain's (mobile
 * NATIVE_TO_CHAIN). Only the symbols that need it are listed; the ui module
 * does not import the chain catalog, and a test checks this against it.
 */
export const NATIVE_TO_CHAIN: Readonly<Record<string, string>> = {
  MON: "monad",
  S: "sonic",
  BERA: "berachain",
  XPL: "plasma",
  PLUME: "plume",
  OKB: "xlayer",
  XDAI: "gnosis",
};

/** A venue's tile at 32 px (64 px for 2× screens), or null → the initial tile. */
export function providerLogo(provider: string): LogoSource | null {
  if (!PROVIDER_LOGOS.has(provider)) return null;
  const base = `${BASE}/providers/${provider}`;
  return {src: `${base}@2x.png`, srcSet: `${base}.png 32w, ${base}@2x.png 64w`};
}

/** WalletConnect's own icon (the blue circle mark, WalletConnect/walletconnect-assets, MIT), for its connect option. */
export const WALLETCONNECT_LOGO = `${BASE}/walletconnect.svg`;

/** A network's SVG by catalog slug, or null → monogram. */
export function networkLogo(slug: string): LogoSource | null {
  return NETWORK_LOGOS.has(slug) ? {src: `${BASE}/networks/${slug}.svg`} : null;
}

/**
 * A token's bundled logo by symbol, in the mobile order: rendered PNG → web3icons
 * SVG → the chain logo of a gas token → none (monogram). All catalog tokens are
 * curated, so keying the bundled set by symbol is the wallet's rule too.
 */
export function tokenLogo(symbol: string): LogoSource | null {
  const sym = symbol.toUpperCase();
  const stem = TOKEN_IMAGES[sym];
  if (stem) {
    const base = `${BASE}/tokens/png/${stem}`;
    return {src: `${base}@2x.png`, srcSet: `${base}@2x.png 80w, ${base}@3x.png 120w`};
  }
  if (TOKEN_SVGS.has(sym)) return {src: `${BASE}/tokens/${sym}.svg`};
  const chain = NATIVE_TO_CHAIN[sym];
  return chain ? networkLogo(chain) : null;
}

/** The monogram tile's text: the first four characters, upper-cased (AssetIcon fallback). */
export function monogram(text: string): string {
  return text.slice(0, 4).toUpperCase();
}
