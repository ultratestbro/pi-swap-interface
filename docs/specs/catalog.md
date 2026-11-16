# cp0x Swap — catalog: chains, tokens, prices, balances (no backend)

Scope: `src/catalog/*` of the static SPA. Everything the swap screen needs to list networks and tokens,
show balances and USD values, and hand the AWK router a price map — with no cp0x-api.

Sources read (read-only), pinned:

- `~/cp0x-elysium` @ `756b115` (branch `feat/elysium`; equals `origin/main` 290312c minus one docs PR — Elysium is merged).
- AWK packages as installed there: `@anywalletkit/swap2-assets@0.3.0`, `protocol-swap2-router@0.5.4`,
  `protocol-swap2-core@0.10.3`, `protocol-swap2-jupiter@0.3.6`; `viem@2.57.10`, `@solana/kit@8.5.0`. Re-checked
  against this repo's router 0.5.5, core 0.11.0 and jupiter 0.3.7 on 2026-11-13: of what this spec reads, only
  `usdValue`'s native-fee source changed (price-only quotes, below); and against router 0.6.2, core 0.14.0 and
  jupiter 0.3.10 on 2026-11-15: unchanged (`usdValue` stays in the same `chunk-VAOFSGCX.js`).
- Every endpoint below was probed on 2026-11-11 with `Origin: https://swap.cp0x.com` (CORS preflight
  `OPTIONS` with `Access-Control-Request-Headers: content-type`, then the real request). Probe scripts are in
  Appendix B.

---

## 0. Decisions

| Topic | Decision |
|---|---|
| Chain catalog | Copy `packages/shared/src/chains.ts` **verbatim** (zero imports) to `src/catalog/chains.ts`; only fix World Chain's dead 2nd RPC. Web adds a thin `Chain` wrapper (catalog key, memo, icon) on top. |
| Token catalog | Runtime import of `@anywalletkit/swap2-assets@0.3.0` (dependency-free, browser-safe, already a dep of the router). No token list is copied. |
| Token universe | Port `apps/mobile/lib/swap/tokens.ts`: every catalog asset on a catalog chain that `@cp0x/shared` also knows (37 chains, 405 assets). `owner` is the connected wallet's address for that family, else `null` (UI asks for recipient / refund). |
| Prices | **DefiLlama** `coins.llama.fi/prices/current` as primary (keyless, `ACAO: *`, no 429 in a 20-call burst), keyed by the wallet's own CoinGecko-id map (`GECKO_IDS`) + 18 additions. CoinGecko `simple/price` is the fallback only (keyless = 5 calls then 429 for 60 s, and the 429 carries no CORS header). Output: `Record<symbol, usd>` — the exact shape the router's `usdValue` and the mobile code consume. |
| EVM balances | Own viem public clients over the catalog RPCs, one `multicall` (Multicall3 `getEthBalance` + ERC-20 `balanceOf`) per chain per owner. Multicall3 verified deployed on all 31 EVM chains (zkSync: its own address). |
| Solana balances | `solana-rpc.publicnode.com`: `getBalance` + `getMultipleAccounts` (≤10 per call) on the owner's **derived ATAs** for catalog mints. `getTokenAccountsByOwner` is blocked there; `api.mainnet-beta.solana.com` answers 403 to every browser Origin. |
| TON (later) | `tonapi.io` keyless (`/v2/accounts/{a}` + `/jettons`), CORS echoes origin. |
| Logos | Copy mobile's bundled set (`assets/logos.ts` SVGs + `assets/images/tokens/*.png`), fall back to the catalog's CMC icon URL, then a monogram. |

---

## 1. Files to copy / port

| Source (read-only) | → web | Deps | How |
|---|---|---|---|
| `~/cp0x-elysium/packages/shared/src/chains.ts` (113 lines) | `src/catalog/chains.ts` | none | verbatim + World Chain RPC fix (§2.5). Header comment: `// copied from cp0x-elysium packages/shared/src/chains.ts @756b115`. |
| `~/cp0x-elysium/packages/shared/src/chains.test.ts` | `src/catalog/chains.test.ts` | vitest | verbatim (asserts 31 EVM + 6 non-EVM, unique ids, ≥2 RPC hosts per EVM chain, explorer routes). |
| `~/cp0x-elysium/packages/shared/src/format.ts` (51 lines) | `src/lib/format.ts` | none | verbatim: `unitsToDecimal`, `formatAmount`, `formatUsd`, `splitUsd`, `formatUsdDelta`, `formatPct`. |
| `~/cp0x-elysium/apps/mobile/lib/swap/tokens.ts` (208 lines) | `src/catalog/tokens.ts` | swap2-assets | **port** (§3.4): drop `Holding`/`Addresses`/`WalletKind`/`toRawAddress`; keep `ZERO_ADDRESS`, `destTokenId`, `matchesToken`, `PINNED_NETWORKS`, `pickerNetworks`, `pickSide`, `flipPair`, `defaultPair` semantics. |
| `~/cp0x-elysium/apps/mobile/lib/swap/tokens.test.ts` | `src/catalog/tokens.test.ts` | vitest | port the cases that don't depend on holdings/wallet kinds. |
| `~/cp0x-elysium/apps/mobile/lib/swap/gas.ts` (51 lines) | `src/swap/gas.ts` | none | verbatim (`routeGasUnits`, `gasCostUsd`, `gasPricer`, `ROUTER_RANKING`). |
| `~/cp0x-elysium/apps/mobile/lib/addressFormat.ts` (22 lines) | `src/lib/addressFormat.ts` | `ChainFamily` | verbatim (`detectAddressFamily`, `shortAddress`). |
| `~/cp0x-elysium/apps/mobile/lib/send/recipient.ts` (49 lines) | `src/lib/recipient.ts` | viem `isAddress` | verbatim (`isAddressFor`, `checkRecipient`). |
| `~/cp0x-elysium/apps/mobile/lib/swap/math.ts:105-137` | `src/swap/math.ts` | `ChainFamily` | `gasReserve`, `maxSwappable` (whole file is pure; copy if the swap spec doesn't). |
| `~/cp0x-elysium/apps/api/src/services/v2Balances.service.ts:49-189` (`GECKO_IDS`) | `src/catalog/prices.ts` | — | as `PRICE_IDS` (Appendix A, already merged with additions). |
| `~/cp0x-elysium/apps/mobile/assets/logos.ts` (87 lines, generated, MIT @web3icons/core) | `src/catalog/logos/svg.ts` | none | verbatim: `NETWORK_LOGOS` (36 of the 37 slugs — no `morph`), `TOKEN_LOGOS` (41 symbols). |
| `~/cp0x-elysium/apps/mobile/assets/images/tokens/*@2x.png` (75 logos ×3 sizes, 1.5 MB total) | `src/catalog/logos/png/` | — | `@2x` only; key map = `TOKEN_IMAGES` in `apps/mobile/components/AssetIcon.tsx:17-99`. |

Not copied: `apps/api/src/lib/multicall.ts` (hand ABI coder — viem does this), `packages/shared/src/{api,cp0x,positions}.ts` (cp0x-api shapes).

---

## 2. Chains

### 2.1 `@cp0x/shared` shape (copy as is)

`packages/shared/src/chains.ts:13-28`:

```ts
/** Key derivation family — matches @anywalletkit/keyring ChainKey. */
export type ChainFamily = "evm" | "solana" | "ton" | "tron" | "btc" | "near" | "zcash";

export interface ChainInfo {
  /** Stable slug: balances-API key, icon file name (`n-<slug>`), route param. */
  slug: string;
  caip2: string;
  name: string;
  family: ChainFamily;
  /** EVM chain id; undefined for non-EVM. */
  chainId?: number;
  native: {symbol: string; decimals: number};
  /** Public RPC fallbacks, best first. Empty when the SDK manager has its own defaults. */
  rpc: readonly string[];
  /** Human explorer base; `/tx/<hash>` and `/address/<a>` are appended. Undefined = not verified yet. */
  explorer?: string;
}
```

Exports: `EVM_CHAINS` (31), `NON_EVM_CHAINS` (6), `CHAINS` (37, display order: ethereum, arbitrum, optimism, base,
solana, ton, tron, bitcoin, near, zcash, then the other 27 EVM chains), `chainBySlug`, `chainByCaip2`, `chainById`,
`explorerTxUrl(chain, hash)` (tron → `/transaction/<h>/overview`, ton → `/transaction/<h>`, else `/tx/<h>`),
`explorerAddressUrl(chain, a)` (ton → `/<a>`, else `/address/<a>`). The file has no imports, so it is safe to copy
(it even runs under `node --experimental-strip-types`).

Fields the web app uses: all of them. `slug` = route param + logo key + `SwapToken.key` prefix; `caip2` = engine
chain id and catalog join key; `chainId` = wagmi/viem; `native` = gas price → USD, gas reserve, display symbol of
natives; `rpc` = viem transports + AWK provider `rpcUrls`; `explorer` = tx/address links.

Non-EVM rows (`chains.ts:77-84`): `solana:mainnet` (rpc publicnode, mainnet-beta), `ton:-239` (rpc `[]`),
`tron:728126428` (trongrid), `bitcoin:mainnet` (`[]`, explorer mempool.space), `near:mainnet` (fastnear),
`zcash:mainnet` (`[]`, blockchair).

### 2.2 How `@cp0x/shared` and the swap catalog differ (checked by script)

| slug | difference | consequence |
|---|---|---|
| ton | catalog native symbol `GRAM`, shared `TON` | display `TON` (mobile rule: natives show `chain.native.symbol`); engine uses `GRAM`; price map has both |
| gnosis | catalog `xDAI`, shared `XDAI` | same rule; price map has both |
| celo | catalog has **no native entry**; CELO is listed by its ERC-20 face `0x471EcE3750Da237f93B8E339c536989b8978a438` | read via `balanceOf`; mark `gasToken: true` |
| arc | catalog has **no native entry**; USDC listed as `0x3600000000000000000000000000000000000000`, 6 dec (EVM native view is 18 dec) | read via `balanceOf` (6 dec); mark `gasToken: true`; never also read `eth_getBalance` (double count, see `v2Balances.service.ts:592-607`) |
| zcash | catalog key `zec`, shared slug `zcash` | join on `caip2`, never on key |
| zksync / robinhood | labels `zkSync` / `Robinhood` vs `zkSync Era` / `Robinhood Chain` | display `ChainInfo.name` |

Catalog chains **not** in `@cp0x/shared` (mobile never shows them, `tokens.ts:57-65` drops them):
`litecoin:mainnet`, `doge:mainnet`, `xrp:mainnet` (memo), `bch:mainnet`, `cosmos:cosmoshub-4` (offrampOnly),
`cardano:mainnet`, `stellar:pubnet` (memo), `aptos:mainnet`, `sui:mainnet`. For a backend-less app they are
deposit-address sources / typed-recipient destinations; see §2.6 (phase 1.5, off by default).

### 2.3 Web `Chain` model — `src/catalog/network.ts`

```ts
import {CC_SOURCE_CHAINS} from "@anywalletkit/swap2-assets";
import {CHAINS, chainByCaip2, type ChainFamily, type ChainInfo} from "./chains";
import {EXTRA_CHAINS, type ExtraFamily} from "./extraChains";

export type Family = ChainFamily | ExtraFamily;

/** Families whose SOURCE transaction the browser can sign today. Add "ton" with TON Connect, "tron" with TronLink. */
export const SIGNING_FAMILIES: ReadonlySet<Family> = new Set<Family>(["evm", "solana"]);

export interface Chain extends Omit<ChainInfo, "family"> {
  family: Family;
  /** swap2-assets CcChain.key — "zec" for zcash. Never a join key. */
  catalogKey: string;
  /** CcChain.memo: deposits to this chain REQUIRE the memo a route returns (ton, xrp, stellar). */
  memo: boolean;
  /** CcChain.icon (Trust Wallet / DefiLlama PNG) — last-resort network logo. */
  icon?: string;
  /** CcChain.offrampOnly (cosmos): destination only. */
  receiveOnly: boolean;
}

const ORDER = new Map(CHAINS.map((c, i) => [c.caip2, i]));

export function webChains(opts: {extras?: boolean} = {}): Chain[] {
  const out: Chain[] = [];
  for (const cc of CC_SOURCE_CHAINS) {
    if (cc.hidden) continue; // none today; parked chains stay out of pickers
    const base: (Omit<ChainInfo, "family"> & {family: Family}) | undefined =
      chainByCaip2(cc.caip2) ?? (opts.extras ? EXTRA_CHAINS.find((c) => c.caip2 === cc.caip2) : undefined);
    if (!base) continue;
    out.push({...base, catalogKey: cc.key, memo: !!cc.memo, ...(cc.icon ? {icon: cc.icon} : {}), receiveOnly: !!cc.offrampOnly});
  }
  return out.sort((a, b) => (ORDER.get(a.caip2) ?? 1e3) - (ORDER.get(b.caip2) ?? 1e3));
}

export const CHAIN_LIST: readonly Chain[] = webChains({extras: import.meta.env.VITE_EXTRA_CHAINS === "1"});
export const chainBySlugWeb = (slug: string) => CHAIN_LIST.find((c) => c.slug === slug);
```

`payMode` per token is derived in §3.4 from `SIGNING_FAMILIES` + what is connected.

### 2.4 viem / wagmi chain definitions — `src/catalog/evm.ts`

viem 2.57.10 has every catalog chain id except **Elysium 99901**; don't depend on `viem/chains` names at all —
build all 31 from `EVM_CHAINS` so RPCs and multicall addresses stay the catalog's.

```ts
import {defineChain, fallback, http, type Address, type Chain as ViemChain, type Transport} from "viem";
import {EVM_CHAINS, type ChainInfo} from "./chains";

/** Multicall3: canonical everywhere; zkSync Era uses the matter-labs deployment. eth_getCode checked on all 31 chains 2026-11-11. */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_BY_SLUG: Partial<Record<string, Address>> = {zksync: "0xF9cda624FBC7e059355ce98a31693d299FACd963"};
export const multicallAddress = (slug: string): Address => MULTICALL3_BY_SLUG[slug] ?? MULTICALL3;

export function toViemChain(c: ChainInfo): ViemChain {
  return defineChain({
    id: c.chainId!,
    name: c.name,
    // All 31 are 18 at the EVM level (Arc's USDC gas token included) — wallet_addEthereumChain requires 18.
    nativeCurrency: {name: c.native.symbol, symbol: c.native.symbol, decimals: c.native.decimals},
    rpcUrls: {default: {http: [...c.rpc]}},
    ...(c.explorer ? {blockExplorers: {default: {name: c.name, url: c.explorer}}} : {}),
    contracts: {multicall3: {address: multicallAddress(c.slug)}},
  });
}

export const VIEM_CHAINS = EVM_CHAINS.map(toViemChain) as [ViemChain, ...ViemChain[]];

/** Read transport: the catalog RPCs in order, no ranking pings. */
export const transportFor = (c: ChainInfo): Transport =>
  fallback(c.rpc.map((u) => http(u, {timeout: 10_000, retryCount: 0})), {rank: false, retryCount: 1});

export const TRANSPORTS: Record<number, Transport> = Object.fromEntries(EVM_CHAINS.map((c) => [c.chainId!, transportFor(c)]));
// wagmi: createConfig({chains: VIEM_CHAINS, transports: TRANSPORTS, connectors: [...]})

/** AWK provider configs (uniswap, wrap, balancer, fynd take Record<number, string[]>; usdt0 takes Record<caip2, string[]>). */
export const RPC_URLS_BY_ID: Record<number, string[]> = Object.fromEntries(EVM_CHAINS.map((c) => [c.chainId!, [...c.rpc]]));
export const RPC_URLS_BY_CAIP2: Record<string, string[]> = Object.fromEntries(EVM_CHAINS.map((c) => [c.caip2, [...c.rpc]]));
/** cctp takes one URL per caip2. */
export const RPC_URL_BY_CAIP2: Record<string, string> = Object.fromEntries(EVM_CHAINS.map((c) => [c.caip2, c.rpc[0]!]));
```

The server builds the same maps from `evmPublicRpcUrls()` (`apps/api/src/lib/crossChain/index.ts:209-256`):
env (keyed QuickNode) first, then one public URL per chain. Every public URL there also appears in the shared
lists (plus `bsc-dataseed.binance.org` in `rpcTable`, `v2Balances.service.ts:286-327` — also CORS-OK).

### 2.5 Public RPC CORS verification

All 68 EVM RPC URLs in `chains.ts` probed (preflight + `POST eth_chainId`, chain id compared):
**67 pass, 1 fails.** The requested sample:

| chain | URL | preflight | POST | ACAO |
|---|---|---|---|---|
| ethereum | ethereum-rpc.publicnode.com | 204 | 200, id 1 | `*` |
| ethereum | eth.drpc.org | 204 | 200, id 1 | echo / `*` |
| base | base-rpc.publicnode.com · mainnet.base.org · base.drpc.org | 204 · 200 · 204 | 200, id 8453 | `*` · echo · `*` |
| arbitrum | arbitrum-one-rpc.publicnode.com · arb1.arbitrum.io/rpc · arbitrum.drpc.org | 204 | 200, id 42161 | `*` |
| bsc | bsc-rpc.publicnode.com · bsc-dataseed.bnbchain.org · bsc.drpc.org (+ bsc-dataseed.binance.org) | 204 | 200, id 56 | `*` |
| polygon | polygon-bor-rpc.publicnode.com · polygon.drpc.org | 204 | 200, id 137 | `*` |
| elysium | rpc.elysium.kinetiq.xyz · elysium-rpc.publicnode.com · elysium.drpc.org | 204 | 200, id 99901 | `*` |

Failure: **`https://worldchain-mainnet.gateway.tenderly.co`** — 404 on both OPTIONS and POST (dead, not a CORS
issue; it is World Chain's only fallback). Working replacements: `https://worldchain.drpc.org` and
`https://480.rpc.thirdweb.com` (both 200, id 480, CORS OK; `worldchain-rpc.publicnode.com` does not exist).
In the copied `chains.ts:62` use:

```ts
evm("worldchain", 480, "World Chain", ["https://worldchain-mainnet.g.alchemy.com/public", "https://worldchain.drpc.org", "https://480.rpc.thirdweb.com"], "https://worldscan.org"),
```

(Report upstream: the mobile app's World Chain nonce double-check runs on one live endpoint.)

Notes: drpc echoes the Origin on preflight and answers `*` on POST (fine). drpc's free plan refuses Solana. No
EVM endpoint returned rate-limit headers; rely on the `fallback` transport.

Non-EVM endpoints (GET or POST with Origin):

| endpoint | result |
|---|---|
| `api.trongrid.io/v1/accounts/{a}` | 200, `ACAO: *`; `POST /wallet/*` preflight 204 `*` (keyless 429s under real use — mobile proxies it) |
| `rpc.mainnet.fastnear.com`, `free.rpc.fastnear.com` (NEAR `query`) | 200, `*` |
| `mempool.space/api/address/{a}` | 200, `*` |
| `tonapi.io/v2/...` | 200, echoes origin; 8 back-to-back calls all 200 |
| `toncenter.com/api/v2/jsonRPC`, `/api/v3/...` | preflight 204 `*`; keyless ≈1 rps (3rd quick call → 429, which does carry `ACAO: *`) |

### 2.6 Extra catalog-only chains (phase 1.5, `VITE_EXTRA_CHAINS=1`) — `src/catalog/extraChains.ts`

```ts
import type {ChainInfo} from "./chains";
export type ExtraFamily = "ltc" | "doge" | "xrp" | "bch" | "cosmos" | "cardano" | "stellar" | "aptos" | "sui";
type Extra = Omit<ChainInfo, "family"> & {family: ExtraFamily; explorerTx?: (h: string) => string};
const x = (slug: string, caip2: string, name: string, family: ExtraFamily, symbol: string, decimals: number, explorer?: string, explorerTx?: (h: string) => string): Extra =>
  ({slug, caip2, name, family, native: {symbol, decimals}, rpc: [], ...(explorer ? {explorer} : {}), ...(explorerTx ? {explorerTx} : {})});
export const EXTRA_CHAINS: readonly Extra[] = [
  x("litecoin", "litecoin:mainnet", "Litecoin", "ltc", "LTC", 8, "https://blockchair.com/litecoin", (h) => `https://blockchair.com/litecoin/transaction/${h}`),
  x("doge", "doge:mainnet", "Dogecoin", "doge", "DOGE", 8, "https://blockchair.com/dogecoin", (h) => `https://blockchair.com/dogecoin/transaction/${h}`),
  x("xrp", "xrp:mainnet", "XRP", "xrp", "XRP", 6, "https://xrpscan.com"),
  x("bch", "bch:mainnet", "Bitcoin Cash", "bch", "BCH", 8, "https://blockchair.com/bitcoin-cash", (h) => `https://blockchair.com/bitcoin-cash/transaction/${h}`),
  x("cosmos", "cosmos:cosmoshub-4", "Cosmos", "cosmos", "ATOM", 6, "https://www.mintscan.io/cosmos"),
  x("cardano", "cardano:mainnet", "Cardano", "cardano", "ADA", 6, "https://cardanoscan.io", (h) => `https://cardanoscan.io/transaction/${h}`),
  x("stellar", "stellar:pubnet", "Stellar", "stellar", "XLM", 7, "https://stellar.expert/explorer/public"),
  x("aptos", "aptos:mainnet", "Aptos", "aptos", "APT", 8, "https://explorer.aptoslabs.com", (h) => `https://explorer.aptoslabs.com/txn/${h}?network=mainnet`),
  x("sui", "sui:mainnet", "Sui", "sui", "SUI", 9, "https://suiscan.xyz/mainnet"),
];
```

Native symbol/decimals are the catalog's. Explorer bases/paths are **proposals, not verified** (bot walls).
Blocking before enabling: recipient/refund validators for these families (mobile's `detectAddressFamily`
knows none of them) and the memo UI for xrp/stellar.

---

## 3. Tokens

### 3.1 `@anywalletkit/swap2-assets@0.3.0` (exact `dist/index.d.ts`)

```ts
interface CcAsset {
    symbol: string;
    /** 1Click asset id (nep141/nep245). */
    assetId: string;
    decimals: number;
    /** On-chain token id (EVM/SPL/TRC contract, TON jetton master). REQUIRED for every non-native asset —
     *  null/absent means native, and the off-ramp round trip relies on that invariant. */
    contract?: string | null;
    /** Icon URL (CoinMarketCap static CDN). */
    icon?: string;
}
interface CcChain {
    /** 1Click chain key (their SourceChain naming). */
    key: string;
    /** CAIP-2 id used across our router/config/db. */
    caip2: string;
    label: string;
    icon?: string;
    /** Deposits to this chain's address REQUIRE the memo when one is returned. */
    memo?: boolean;
    /** Parked: kept in the catalog but hidden from the deposit and off-ramp pickers. */
    hidden?: boolean;
    /** No inbound route — off-ramp destination only, hidden from deposit pickers. */
    offrampOnly?: boolean;
    assets: CcAsset[];
}
interface UnlistedAsset extends CcAsset { unlisted: true; contract: string; }

declare const CC_SOURCE_CHAINS: CcChain[];          // 46 chains, 418 assets
declare const CC_OTHER_CHAINS: CcChain[];           // all but eip155:1 (45)
declare const CC_DEPOSIT_CHAINS: CcChain[];         // minus offrampOnly (44)
declare const ETH_CAIP2 = "eip155:1";
declare const CC_DEST: { readonly caip2: "eip155:1"; readonly assetId: "nep141:eth.omft.near"; readonly decimals: 18; readonly token: "0x0000000000000000000000000000000000000000" };
declare const CATALOG_CHAIN_ALIASES: Readonly<Record<string, string>>;
// { "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "solana:mainnet", "tron:0x2b6653dc": "tron:728126428",
//   "bip122:000000000019d6689c085ae165831e93": "bitcoin:mainnet" }

declare function cmcIcon(id: number, size?: 64 | 128 | 200): string;
declare function chainIcon(slug: string): string;           // Trust Wallet raw github URL
declare function ccChain(caip2: string): CcChain | undefined;
declare function ccAsset(caip2: string, symbol: string): CcAsset | undefined;          // symbol is CASE-SENSITIVE
declare function ccAssetByToken(caip2: string, token: string): CcAsset | undefined;  // contract (case-insens.), "" or 0x0…0 = native
declare function displaySymbol(caip2: string, symbol: string): string;               // legacy → current (TON → GRAM)
declare function iconForSymbol(symbol: string): string | undefined;
declare function isTokenAddress(caip2: string, ref: string): boolean;               // EVM contract or 32-byte Solana mint only
declare function unlistedAsset(caip2: string, contract: string, decimals: number): UnlistedAsset | undefined;
declare function isUnlisted(asset: CcAsset | undefined): asset is UnlistedAsset;
declare function resolveAsset(caip2: string, ref: string, opts?: { allowUnlisted?: boolean; decimals?: number }): CcAsset | undefined;
declare function catalogChainId(caip2: string): string;
```

Import: `import {CC_SOURCE_CHAINS, ccChain, ccAsset, ccAssetByToken, catalogChainId, isTokenAddress, unlistedAsset} from "@anywalletkit/swap2-assets";`
(ESM `dist/index.js`, ~100 KB unminified, no Node APIs, `sideEffects: false`).

Behaviours checked: `ccAssetByToken(c, "")` and `(c, ZERO_ADDRESS)` return the native for every chain that has
one (SOL, BTC, GRAM, TRX, NEAR, ZEC, LTC…), `undefined` for celo/arc. `ccAsset("eip155:1","usdc")` → undefined.
Wallet Standard / WalletConnect may report `solana:5eykt4…`: pass through `catalogChainId` before any lookup.

### 3.2 What the catalog offers (the 37 chains the app shows)

Decimals come from the catalog — never assume 6 for stables (BNB Chain USDT/USDC are 18, Solana USDe 9,
TON GOMINING 18). `*` = native (no contract).

| # | slug | caip2 | n | tokens |
|---|---|---|---|---|
| 1 | ethereum | eip155:1 | 26 | ETH* USDC/6 USDT/6 wstETH stETH SSV WBTC/8 cbBTC/8 DAI LINK UNI AAVE ARB USDe PYUSD/6 BNB USDS wBETH weETH LDO SKY COW crvUSD scrvUSD CRV WETH |
| 2 | arbitrum | eip155:42161 | 22 | ETH* USDC/6 USDT0/6 WBTC/8 cbBTC/8 DAI LINK UNI AAVE ARB USDe PYUSD/6 USDS sUSDS USDG/6 ENA USDY LDO COW crvUSD CRV WETH |
| 3 | optimism | eip155:10 | 18 | ETH* USDT/6 WBTC/8 DAI LINK UNI AAVE OP USDC/6 weETH USDT0/6 ENA WLD sUSDe crvUSD scrvUSD CRV WETH |
| 4 | base | eip155:8453 | 17 | ETH* USDC/6 USDT/6 cbBTC/8 DAI LINK AAVE USDe weETH ENA MORPHO sUSDe COW crvUSD scrvUSD CRV WETH |
| 5 | solana | solana:mainnet | 14 | SOL*/9 USDC/6 USDT/6 cbBTC/8 USDe/9 PYUSD/6 USDS/6 LINK/9 WBTC/8 USD1/6 USDG/6 ENA/9 AAVE/8 USDY/6 |
| 6 | ton (memo) | ton:-239 | 9 | GRAM*/9 USDT/6 USDe/6 sUSDe/6 FDUSD/6 XAUt0/6 GOMINING/18 TSLAx/8 NVDAx/8 |
| 7 | tron | tron:728126428 | 2 | TRX*/6 USDT/6 |
| 8 | bitcoin | bitcoin:mainnet | 1 | BTC*/8 |
| 9 | near | near:mainnet | 6 | NEAR*/24 USDC/6 USDT/6 AURORA/18 ETH/18 wBTC/8 |
| 10 | zcash | zcash:mainnet | 1 | ZEC*/8 |
| 11 | polygon | eip155:137 | 15 | POL* USDT/6 USDC/6 pUSD/6 WBTC/8 DAI LINK UNI AAVE PYUSD/6 rETH ZRO crvUSD CRV WPOL |
| 12 | bsc | eip155:56 | 12 | BNB* USDT/18 USDC/18 LINK USDe wBETH weETH UNI USD1/18 AAVE USDY WBNB |
| 13 | avalanche | eip155:43114 | 12 | AVAX* USDT/6 USDC/6 LINK.e weETH UNI.e ENA AAVE.e sUSDe rsETH ZRO WAVAX |
| 14 | zksync | eip155:324 | 14 | ETH* WETH USDC/6 USDT/6 WBTC/8 ZK LINK weETH USDe ENA sUSDe Cake SolvBTC frxUSD |
| 15 | linea | eip155:59144 | 15 | ETH* WETH USDC/6 USDT/6 WBTC/8 DAI LINEA weETH sUSDe Cake M-BTC frxETH ezETH frxUSD xSolvBTC |
| 16 | scroll | eip155:534352 | 10 | ETH* USDT/6 LINK weETH ENA sUSDe ETHFI frxUSD rswETH WETH |
| 17 | unichain | eip155:130 | 11 | ETH* USDC/6 USDT0/6 WBTC/8 DAI wstETH weETH JUP/6 rETH uniBTC/8 WETH |
| 18 | monad | eip155:143 | 14 | MON* USDC/6 USDT0/6 WETH WBTC/8 AUSD/6 wstETH cbBTC/8 weETH USD1/6 sUSDe GHO SolvBTC WMON |
| 19 | hyperevm | eip155:999 | 11 | HYPE* USDC/6 USDT0/6 USDe LINK weETH AAVE0 sUSDe kHYPE SolvBTC WHYPE |
| 20 | gnosis | eip155:100 | 16 | xDAI* USDC/6 USDT/6 GNO WETH WBTC/8 EURe LINK UNI GHO crvUSD SAFE YFI COW TRB WXDAI |
| 21 | sonic | eip155:146 | 16 | S* wS USDC/6 USDT/6 WETH WBTC/8 stS LINK weETH rsETH LBTC/8 FBTC/8 PENDLE uniBTC/8 frxUSD crvUSD |
| 22 | berachain | eip155:80094 | 11 | BERA* USDT0/6 weETH sUSDe rsETH LBTC/8 SolvBTC PENDLE uniBTC/8 frxUSD WBERA |
| 23 | celo | eip155:42220 | 9 | CELO (contract, gas token) USDC/6 USDT/6 USDm WETH LINK XAUt0/6 WBTC/8 DAI |
| 24 | plasma | eip155:9745 | 11 | XPL* WXPL USDT0/6 USDe WETH LINK weETH sUSDe rsETH GHO XAUt0/6 |
| 25 | megaeth | eip155:4326 | 12 | ETH* WETH USDT0/6 USDm USDe MEGA wstETH LINK BTC.b/8 sUSDe rsETH LBTC/8 |
| 26 | robinhood | eip155:4663 | 7 | ETH* WETH USDG/6 LINK cbBTC/8 VIRTUAL APE |
| 27 | worldchain | eip155:480 | 5 | ETH* WETH USDC/6 WBTC/8 WLD |
| 28 | sei | eip155:1329 | 10 | SEI* WSEI USDC/6 USDT0/6 WETH WBTC/8 SolvBTC USDT/6 iSEI/6 fastUSD |
| 29 | ink | eip155:57073 | 14 | ETH* WETH USDC/6 USDT0/6 USDe kBTC/8 weETH USDG/6 PYUSD/6 rsETH GHO reUSD uniBTC/8 XAUt0/6 |
| 30 | plume | eip155:98866 | 9 | PLUME* WPLUME USDC/6 pUSD/6 WETH USD1 frxUSD mTBILL XAUM |
| 31 | xlayer | eip155:196 | 13 | OKB* WOKB USDT0/6 USDC/6 WETH WBTC/8 USDG/6 sUSDe rsETH uniBTC/8 frxUSD brBTC/8 sfrxUSD |
| 32 | mantle | eip155:5000 | 10 | MNT* WMNT USDC/6 USDT/6 USDT0/6 WETH WBTC/8 mETH USDe FBTC/8 |
| 33 | katana | eip155:747474 | 8 | ETH* WETH USDC.e/6 USDT/6 AUSD/6 WBTC/8 wstETH KAT |
| 34 | morph | eip155:2818 | 6 | ETH* WETH USDC/6 USDT0/6 USDC.e/6 WBTC/8 |
| 35 | flare | eip155:14 | 7 | FLR* WFLR USDT0/6 USDC.e/6 WETH FXRP/6 sFLR |
| 36 | arc | eip155:5042 | 4 | USDC/6 (contract 0x3600…, gas token) EURC/6 WETH cirBTC/8 |
| 37 | elysium | eip155:99901 | 7 | HYPE* WHYPE USDC.e/6 kHYPE UBTC/8 UETH KNTQ |

(EVM entries without `/n` are 18 decimals.) Catalog-only extras: LTC/8, DOGE/8, XRP/6 (memo), BCH/8, ATOM/6
(offrampOnly), ADA/6, XLM/7 + USDC/7 (memo), APT/8 + USDT/6 + USDC/6, SUI/9 + USDC/6.

### 3.3 How mobile builds the list (`apps/mobile/lib/swap/tokens.ts`)

- `catalogChains()` (`:57-65`): `CC_SOURCE_CHAINS` minus `hidden`/`offrampOnly`, joined to `@cp0x/shared` by
  `caip2` (drops the 9 extras), sorted by `CHAINS` order.
- `swapTokens(holdings, addresses, prices)` (`:72-120`): skips a chain when the wallet has no address for its
  family; per chain, natives first (`sort` by `!!contract`); per asset:
  - `key = \`${slug}:${contract ? contract.toLowerCase() : "native"}\`` — holdings key, route param, testID;
  - `symbol` = `contract ? a.symbol : chain.native.symbol` (TON not GRAM); `catalogSymbol = a.symbol`;
  - balance from the portfolio row with the same key (TON jettons matched by raw address; Celo's catalog
    contract falls back to the native row when symbol+decimals equal the native's) — only when decimals match;
  - `priceUsd = holding.priceUsd ?? prices[symbol] ?? prices[a.symbol]`; `usd` = holding's.
  - Result: held (by `usd` desc, then units) first, then the rest in catalog order.
- `payTokens` (`:123-125`): families the active wallet kind can sign.
- `useSwapTokens` (`lib/swap/useSwapTokens.ts:7-17`): `all`, `pay`, `receive: all`, `byKey`, `prices` from
  `useSymbolPrices()` (`GET /api/v2/prices`, 60 s stale).
- `defaultPair` (`:193-208`): asked-for pay key → most valuable payable holding → first payable native; receive =
  USDC on the same chain (its native when paying USDC) → first same-chain token → any USDC → anything else.
- Engine mapping (`lib/swap/engine.ts:120-134`): `sourceChain: from.caip2`, `sourceToken: from.catalogSymbol`,
  `destChain: to.caip2`, `destToken: destTokenId(to)` (= contract or `ZERO_ADDRESS`, also for non-EVM natives),
  `destAddress: recipient ?? to.owner`, `refundAddress: from.owner`.

### 3.4 Web model — `src/catalog/tokens.ts`

```ts
import {ccChain} from "@anywalletkit/swap2-assets";
import {unitsToDecimal} from "../lib/format";
import {CHAIN_LIST, SIGNING_FAMILIES, type Chain, type Family} from "./network";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Gas tokens the catalog lists by their ERC-20 face (apps/api v2Balances NATIVE_ERC20_ALIASES, :604-607). */
const GAS_TOKEN_CONTRACTS: Readonly<Record<string, string>> = {
  celo: "0x471ece3750da237f93b8e339c536989b8978a438",
  arc: "0x3600000000000000000000000000000000000000",
};

/** Static, from the catalog — built once at module load. */
export interface Token {
  /** `<slug>:<contract lowercased | "native">` — route param, balance key, list key. */
  key: string;
  chain: string;          // slug
  caip2: string;
  chainName: string;
  family: Family;
  /** What the user reads: the chain's own native symbol for natives (TON, XDAI), else the catalog symbol. */
  symbol: string;
  /** The catalog symbol — the engine's `sourceToken`, and the price-map key the router uses. */
  catalogSymbol: string;
  decimals: number;
  /** Contract / mint / jetton master as the catalog writes it (case preserved — Solana/TON are case-sensitive); null = native. */
  contract: string | null;
  /** Pays this chain's gas: native, or Celo CELO / Arc USDC via their ERC-20 face. MAX keeps a reserve for it. */
  gasToken: boolean;
  /** CcAsset.icon (CMC 128px) — logo fallback. */
  icon?: string;
}

/** A Token with the viewer's state. */
export interface SwapToken extends Token {
  /** Base units. "0" when unknown. */
  amount: string;
  balance: "loaded" | "loading" | "none" | "error"; // none = no address of this family connected
  priceUsd?: number;
  usd: number;
  /** Connected address of this family; null → the UI must take a recipient (receive) / refund address (deposit pay). */
  owner: string | null;
  /** How this token can be paid: signed by a connected wallet, sent to a deposit address, or not at all yet. */
  payMode: "wallet" | "connect" | "deposit" | "none";
}

export const tokenKey = (slug: string, contract: string | null) => `${slug}:${contract ? contract.toLowerCase() : "native"}`;

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

export const TOKENS: readonly Token[] = catalogTokens();
export const TOKEN_BY_KEY = new Map(TOKENS.map((t) => [t.key, t]));

export function payModeOf(t: Token, chain: Chain, owners: Partial<Record<Family, string>>): SwapToken["payMode"] {
  if (chain.receiveOnly) return "none";
  if (SIGNING_FAMILIES.has(t.family)) return owners[t.family] ? "wallet" : "connect";
  return "deposit"; // btc, zcash, ton/tron/near until their connectors ship, extras — routed only by deposit-address venues
}

export function swapTokens(
  tokens: readonly Token[],
  balances: Readonly<Record<string, {amount: string; state: SwapToken["balance"]}>>,
  prices: Readonly<Record<string, number>>,
  owners: Partial<Record<Family, string>>,
): SwapToken[] {
  const out = tokens.map((t): SwapToken => {
    const b = balances[t.key];
    const priceUsd = prices[t.symbol] ?? prices[t.catalogSymbol];
    const amount = b?.amount ?? "0";
    const usd = priceUsd !== undefined ? Number(unitsToDecimal(amount, t.decimals)) * priceUsd : 0;
    return {
      ...t,
      amount,
      balance: owners[t.family] ? (b?.state ?? "loading") : "none",
      ...(priceUsd !== undefined ? {priceUsd} : {}),
      usd,
      owner: owners[t.family] ?? null,
      payMode: payModeOf(t, CHAIN_LIST.find((c) => c.slug === t.chain)!, owners),
    };
  });
  const units = (t: SwapToken) => Number(unitsToDecimal(t.amount, t.decimals));
  const held = out.filter((t) => t.amount !== "0").sort((a, b) => b.usd - a.usd || units(b) - units(a));
  return [...held, ...out.filter((t) => t.amount === "0")];
}

/** The engine's destination token id: the contract, or the zero address for a native coin (every family). */
export const destTokenId = (t: Pick<Token, "contract">) => t.contract ?? ZERO_ADDRESS;
```

Keep from mobile unchanged (copy bodies): `matchesToken` (`:127-137`), `PINNED_NETWORKS`
(`["ethereum","solana","tron","bitcoin","ton","near"]`, `:140`), `pickerNetworks` (`:155-172`), `Pair`,
`pickSide`, `flipPair`, `defaultPair` (`:174-208`; in `defaultPair` replace `holdingKey(t) === prefer` with
`t.key === prefer`, and pass only `payMode === "wallet"` tokens as `pay` when choosing the opening pair).

Engine mapping for the web (`QuoteParams` from `@anywalletkit/protocol-swap2-core/types`):

```ts
{
  sourceChain: from.caip2,
  sourceToken: from.catalogSymbol,          // unlisted (user-added) token: its contract, plus sourceDecimals
  destChain: to.caip2,
  destToken: destTokenId(to),
  amountIn: amountIn.toString(),
  slippageBps,
  destAddress: recipient ?? to.owner!,      // to.owner null ⇒ recipient is mandatory (validate with checkRecipient)
  refundAddress: from.owner ?? refundInput, // deposit-pay sources have no owner ⇒ ask for a refund address
  dry: true,
}
```

Unlisted tokens: `isTokenAddress(caip2, ref)` accepts only an EVM contract or a Solana mint; read decimals
on-chain (`erc20Abi.decimals` / mint account `decimals`), build with `unlistedAsset(caip2, contract, decimals)`;
its `symbol` is the address itself by design. Only providers built with `allowUnlistedTokens` quote it. The app's
import by address (2026-11-15, ARCHITECTURE D39) is §3.6.

### 3.6 Imported tokens — `src/catalog/imported.ts` (ARCHITECTURE D39)

A token the catalog doesn't list, on an EVM network or Solana, pasted by its address in the token sheet:

- **Detect** — `detectTokenAddress(text)`: an EVM contract (`0x` + 40 hex, any case) or a 32-byte Solana mint, both by
  `isTokenAddress` (a 32-byte base58 key reads as Solana first); another family's address → `{family: "unsupported"}`
  (TON, Tron, NEAR, Bitcoin, Zcash: not importable in v1). `listedToken(caip2, contract)`: the catalog token there, if
  any (EVM any case, Solana exact) — then there is nothing to import.
- **Read** — `readTokenForImport(caip2, address)`, through `catalogPort.useTokenLookup` (react-query `["token-meta",
  caip2, address]` with the address `canonicalTokenAddress` — checksummed on EVM, verbatim elsewhere — so every spelling
  shares one read; 10 min; a network failure retried once): EVM the contract checksummed (viem's `call` refuses a
  mis-checksummed `to`), `eth_getCode` (code, not an EIP-7702 delegation) then `decimals()` 0x313ce567 (required,
  0..36), `symbol()` 0x95d89b41 and `name()` 0x06fdde03 (ABI `string` or legacy `bytes32`, `decodeTokenString`) over
  `publicClient(chainId)` — a call no node answered (`HttpRequestError`, `TimeoutError`, `LimitExceededRpcError`,
  `ResourceUnavailableRpcError`, JSON-RPC -32005 / -32002 / 429) is "try again" for any of the three, never "not a
  token" or a kept "UNKNOWN"; Solana one `getMultipleAccounts([mint, metaplexPda], base64)` over `solanaRpcUrls()`:
  owner SPL Token or Token-2022, `parseMint` (82 bytes, or a Token-2022 mint padded to 165 with AccountType 1 at byte
  165, bytes 82..164 zero and never 355 bytes long — Multisig::LEN, as spl-token-2022 unpacks it; initialized at 45,
  decimals at 44, ≤ 36), the name / symbol from Token-2022's
  TokenMetadata extension (TLV type 19, its mint field = the mint), else the Metaplex account (key 4, mint at 33..65,
  borsh name ≤ 64 and symbol ≤ 32 bytes, zero padding stripped), else "UNKNOWN". Texts go through `cleanTokenText`
  (control / format / private-use / default-ignorable characters and the blank-drawn U+2800 / U+1D159 stripped,
  combining-mark stacks cut to two, whitespace collapsed, symbol ≤ 20 and name ≤ 48 characters; nothing visible left —
  no letter, digit, punctuation or symbol — reads "UNKNOWN"). Errors are `TokenReadError` (`definitive` unless the RPC
  didn't answer), worded for the sheet ("No token contract at this address on Base.").
- **Model** — `importedToken(chain, contract, meta)`: a `Token` with `imported: true`, `name`, `token2022?`,
  `catalogSymbol` = the contract (checksummed on EVM, verbatim on Solana), `gasToken: false`, key `importKey` =
  `<slug>:<contract>` (lowercased on EVM, verbatim on Solana).
- **Keep** — `localStorage cp0x.swap.tokens.v1`: `[{chain, contract, symbol, name, decimals, token2022?}]`, newest
  first, ≤ `IMPORTED_TOKENS_CAP` (50); `parseImportedTokens` holds every entry to the rules again on each read;
  `addImportedToken` / `removeImportedToken`; `useImportedTokens()` (useSyncExternalStore, the `storage` event for
  other tabs); memory only on an IPFS path gateway.
- **Join** — `useSwapTokens` appends `swapTokens(imported, …, importedPrices)` after the catalog's, each with its
  `logo` once found; `tokenPrice` reads an import by its token key in `importedPrices` only (never its symbol); `matchesToken` matches its name (not its contract's middle); `balanceSpecs(owners, chains, imported)` adds a
  read per network with imports (`imported: true`, key `["bal", slug, owner, "imported", …keys]`); `ataOf(owner, mint,
  token2022)` derives an imported Token-2022 mint's account under Token-2022.
- **Look-alikes** — `lookalikeOf(token)`: the listed token on the same network whose symbol (or catalog symbol) reads
  like the import's symbol or name (`readsAs`: NFKD, combining marks stripped, look-alike letters folded by their own
  shape before case — Cyrillic, Greek, Armenian, Lisu, Cherokee (small letters as their capitals) and small capitals, a
  UTS #39 confusables subset; Greek Η → h, η → n, Μ → m, μ → u —, 0→o, 1/i/|→l, ₮→t, then lower case and everything
  but `a-z0-9` dropped). No two catalog tokens on one network read alike under it.
- **Links** — `parseTokenKey(key)`: a hash key naming an importable unlisted token, or null.
- **Price and logo (2026-11-16)** — by the contract or mint only. `importedPriceKey(t)` = `<LLAMA_CHAINS[slug]>:<contract>`;
  `fetchImportedPrices(tokens)`: one DefiLlama `prices/current/{keys}?searchWidth=6h` (`prices.defillama`), token key →
  USD, confidence ≥ 0.9, an EVM key matched in any case, a mint only as written; `useImportedPrices` (react-query
  `["imported-prices", …keys]`, 60 s). `logoUrls(t)`: EVM `token-icons.llamao.fi/icons/tokens/{chainId}/{checksummed}?h=64&w=64`
  then `raw.githubusercontent.com/trustwallet/assets/master/blockchains/{TRUST_WALLET_CHAINS[slug]}/assets/{checksummed}/logo.png`;
  Solana that repository by the mint. `fetchTokenLogo(t)`: the first raster image (png, webp, jpeg, gif, avif) ≤ 256 KB as
  a `data:` URL, `credentials: "omit"`, `referrerPolicy: "no-referrer"`; null when no source has one, a throw when one
  couldn't be reached and none answered; `useImportedLogos` (`["token-logo", key]`, the session). `useTokenLookup`'s
  found token carries its logo too (the search result and the confirmation).

### 3.5 Logos

Mirror `apps/mobile/components/AssetIcon.tsx:104-111`, add the catalog URL before the monogram:

1. `TOKEN_IMAGES[SYMBOL]` (PNG, uppercased key; wrapped/bridged tokens map to the underlying's file —
   `WPOL→pol.png`, `WXDAI→xdai.png`, `LINK.E→link.png`, `TON`/`GRAM→gram.png`, …).
2. `TOKEN_LOGOS[SYMBOL]` (SVG string), else the network SVG of the chain whose native symbol it is
   (`NATIVE_TO_CHAIN`, e.g. `HYPE→hyperevm`).
3. `Token.icon` (catalog CMC URL; all 127 distinct URLs answered 200 on 2026-11-11). 31 assets have none
   (e.g. TON USDe/sUSDe/FDUSD/XAUt0/GOMINING/TSLAx/NVDAx, NEAR ETH/wBTC, `pUSD`, `AUSD`, `WXPL`, `wS`, `stS`, `WLD`, `WOKB`, `kBTC`).
4. Monogram (first 4 chars, uppercased).

An imported token (§3.6) never goes through steps 1-3 (they would show the listed token's logo for a copy named like
it): its `logo` — a `data:image/` URL found by its contract (§3.6 "Price and logo") — else its monogram.

Network badge: `NETWORK_LOGOS[slug]` (36 slugs — all but `morph`), else `Chain.icon` (cc.icon, all 46 answered 200).

---

## 4. Prices

### 4.1 What the wallet does today

- App: `apps/mobile/lib/history/usePricer.ts:11-31` — `GET ${API_URL}/api/v2/prices` with `x-cp0x-app`, react-query
  key `["prices-v2"]`, `staleTime: 60_000`, `retry: 1` → `{prices: Record<symbol, usd>}`.
- API: `apps/api/app/api/v2/prices/route.ts` → `curatedUsdPrices()` (`v2Balances.service.ts:248-256`): one
  CoinGecko call `https://api.coingecko.com/api/v3/simple/price?ids=<all GECKO_IDS values>&vs_currencies=usd&include_24hr_change=true`
  shared by all lambdas through a Redis SWR cache (fresh 60 s, last-known on failure; `:216-233`), mapped back
  through `GECKO_IDS` (`:49-189`, 135 symbols → 108 ids). Legacy `/api/prices` = `SPOT_IDS` (12 majors) with
  stables defaulted to $1.

### 4.2 How prices are consumed (contract the web map must meet)

- Router ranking: `usdValue(prices, {gasUsd})` from `@anywalletkit/protocol-swap2-router/value`:

  ```ts
  declare function usdValue(prices: Readonly<Record<string, number>>, options?: {
      gasUsd?: (quote: Quote, params: QuoteParams) => number | null;
  }): (quote: Quote, params: QuoteParams) => number | null;
  ```

  It resolves the dest asset with `ccAssetByToken(params.destChain, params.destToken)` and prices it by the
  **catalog symbol** through `priceOf` (`dist/chunk-VAOFSGCX.js`): tries `symbol`, `SYMBOL`, then without a
  leading `w`/`W` (`WETH→ETH`); missing → `$1` only for `/^(USDC|USDT|USDT0|USD₮0|DAI|USDC\.E)$/i`, else `null`
  (that quote ranks on raw output). The declared native fee — `txRequest.nativeFee`, or `providerData.nativeFee` on a
  price-only quote with no `txRequest` (router 0.5.5: LI.FI 0.8.0 and USDT0 0.5.0 dry quotes priced for a placeholder;
  a malformed value → `null`) — is valued at the source chain's catalog native (`ccAssetByToken(sourceChain, "")`) —
  on celo/arc that is undefined → `null`.
  Mobile builds it in `lib/swap/engine.ts:66` only when the map is non-empty, with `ROUTER_RANKING`
  (`gas.ts:51`, `{weights: "price:0.7,speed:0.3,reliability:0", tieBand: 0.0005}`).
- Gas term: `gasPricer({evm, isToken}, gasPriceWei, prices[chain.native.symbol])` (`gas.ts:41-44`, wired in
  `engine.ts:104-109`; gas price = `eth_gasPrice`, 2.5 s timeout, 20 s cache). In the browser:
  `getPublicClient(config, {chainId}).getGasPrice()`.
- `quoteValues(prices, params, quotes)` (same module) for the "you lose x%" warning.
- Display: `SwapToken.priceUsd` × amount; review screen uses `prices[chain.native.symbol]` for fees.

So the web map must be keyed by catalog symbols AND shared native symbols (TON/GRAM, XDAI/xDAI) — the
`GECKO_IDS` keys already are.

### 4.3 Browser price sources — verified

| source | CORS | limits seen | fit |
|---|---|---|---|
| **DefiLlama** `GET https://coins.llama.fi/prices/current/{keys}` | `ACAO: *` (GET); `POST /prices` preflight OK | 20 rapid calls → 20×200; no rate headers; ~130–210 ms for 124 keys; URL 2 832 chars | **primary**. Keys `coingecko:<id>` or `<llamaChain>:<contract>`. Returns `{coins: {key: {price, symbol, timestamp, confidence, decimals?}}}`. All 124 keys of Appendix A priced (the wallet's raw GECKO_IDS set: 107/108, `bedrock-btc` unknown). No 24 h change (`/percentage/{keys}?period=24h` exists if ever needed). |
| CoinGecko `GET https://api.coingecko.com/api/v3/simple/price?ids=…&vs_currencies=usd` | `ACAO: *`, `cache-control: max-age=30` | **5 calls, then 429 `retry-after: 60`; the 429 has no ACAO** → browser sees a TypeError, not a status | fallback only; covers all 108 wallet ids + 24 h change |
| LI.FI `GET https://li.quest/v1/token?chain=&token=` (`priceUSD`) | `ACAO: *` | `ratelimit-limit: 100` per 60 s, **shared with LI.FI quotes**; `/v1/tokens?chains=1,8453` = 2.8 MB, all chains 1.9 MB gz | not for bulk; acceptable one-off for an unlisted token |
| Jupiter `GET https://lite-api.jup.ag/price/v3?ids=<mints>` | echoes origin | `x-ratelimit-remaining` 4→1 within 4 calls; bucket shared with Jupiter quotes/holdings | no |
| tonapi `GET https://tonapi.io/v2/rates?tokens=ton,<jetton>&currencies=usd` | echoes origin | lenient keyless | optional, TON only |

### 4.4 Implementation — `src/catalog/prices.ts`

```ts
/**
 * Symbol → price id. A plain value is a CoinGecko id (DefiLlama key `coingecko:<id>`); a value with ":" is a
 * DefiLlama `<chain>:<contract>` key (no CoinGecko fallback). Source: apps/api v2Balances GECKO_IDS (:49-189)
 * plus web additions (Appendix A). Keys = catalog symbols + shared native symbols.
 */
export const PRICE_IDS: Readonly<Record<string, string>> = { /* Appendix A */ };

const LLAMA = "https://coins.llama.fi/prices/current/";
const GECKO = "https://api.coingecko.com/api/v3/simple/price";
const llamaKey = (id: string) => (id.includes(":") ? id : `coingecko:${id}`);

function timeout(ms: number, outer?: AbortSignal): AbortSignal {
  return outer ? AbortSignal.any([outer, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

async function fromLlama(signal?: AbortSignal): Promise<Record<string, number>> {
  const keys = [...new Set(Object.values(PRICE_IDS).map(llamaKey))];
  const res = await fetch(`${LLAMA}${keys.join(",")}?searchWidth=6h`, {signal: timeout(8_000, signal)});
  if (!res.ok) throw new Error(`defillama ${res.status}`);
  const coins = ((await res.json()) as {coins?: Record<string, {price?: number}>}).coins ?? {};
  const byKey = new Map(Object.entries(coins).map(([k, v]) => [k.toLowerCase(), v.price]));
  const out: Record<string, number> = {};
  for (const [symbol, id] of Object.entries(PRICE_IDS)) {
    const p = byKey.get(llamaKey(id).toLowerCase());
    if (typeof p === "number" && Number.isFinite(p) && p > 0) out[symbol] = p;
  }
  return out;
}

async function fromGecko(signal?: AbortSignal): Promise<Record<string, number>> {
  const ids = [...new Set(Object.values(PRICE_IDS).filter((id) => !id.includes(":")))].sort();
  const res = await fetch(`${GECKO}?ids=${ids.join(",")}&vs_currencies=usd`, {signal: timeout(8_000, signal)});
  if (!res.ok) throw new Error(`coingecko ${res.status}`);
  const j = (await res.json()) as Record<string, {usd?: number}>;
  const out: Record<string, number> = {};
  for (const [symbol, id] of Object.entries(PRICE_IDS)) {
    const p = j[id]?.usd;
    if (typeof p === "number" && p > 0) out[symbol] = p;
  }
  return out;
}

/** Symbol → USD. Never throws: {} when both sources fail (the router then ranks on raw output). */
export async function fetchPrices(signal?: AbortSignal): Promise<Record<string, number>> {
  try {
    const p = await fromLlama(signal);
    if (Object.keys(p).length > 20) return p;
  } catch { /* fall through */ }
  try { return await fromGecko(signal); } catch { return {}; }
}

// React: one shared query.
// useQuery({queryKey: ["prices"], queryFn: ({signal}) => fetchPrices(signal), staleTime: 60_000,
//           refetchInterval: 60_000, refetchIntervalInBackground: false, retry: 1, placeholderData: lastKnown()})
// lastKnown(): read/write localStorage "cp0x.prices.v1" inside try/catch (per-viewer warm start only).
// Keep ONE stable object reference until data changes (mobile useSwapTokens.ts:10-12 does the same) —
// the router and the token list memoize on it.
```

Do not hard-code stables to $1 in the map: `usdValue` already pars USDC/USDT/USDT0/DAI/USDC.e when missing,
and a real de-peg should show.

Coverage (script over the whole catalog with `priceOf` semantics): every asset priced except
**`fastUSD` on Sei** (no CoinGecko id, no DefiLlama contract price). `brBTC` uses the X Layer contract key
because DefiLlama has no `coingecko:bedrock-btc`.

### 4.5 Unlisted token price (optional)

```ts
/** DefiLlama chain key per caip2 — each verified with a catalog contract on 2026-11-11. */
export const LLAMA_CHAIN: Readonly<Record<string, string>> = {
  "eip155:1": "ethereum", "eip155:42161": "arbitrum", "eip155:10": "optimism", "eip155:8453": "base",
  "eip155:137": "polygon", "eip155:56": "bsc", "eip155:43114": "avax", "eip155:324": "era",
  "eip155:59144": "linea", "eip155:534352": "scroll", "eip155:130": "unichain", "eip155:143": "monad",
  "eip155:999": "hyperliquid", "eip155:100": "xdai", "eip155:146": "sonic", "eip155:80094": "berachain",
  "eip155:42220": "celo", "eip155:9745": "plasma", "eip155:4326": "megaeth", "eip155:4663": "robinhood",
  "eip155:480": "wc", "eip155:1329": "sei", "eip155:57073": "ink", "eip155:98866": "plume_mainnet",
  "eip155:196": "xlayer", "eip155:5000": "mantle", "eip155:747474": "katana", "eip155:2818": "morph",
  "eip155:14": "flare", "eip155:5042": "arc", "eip155:99901": "elysium",
  "solana:mainnet": "solana", "ton:-239": "ton", "tron:728126428": "tron", "near:mainnet": "near",
};
// price = (await fetch(`${LLAMA}${LLAMA_CHAIN[caip2]}:${contract}`)).coins[key]?.price
```

---

## 5. Balances in the browser

Only catalog tokens (plus user-added unlisted ones). Read for every chain of a connected family, not only the
selected one, so "held first" sorting works like mobile: 31 EVM multicalls + 3 Solana calls per refresh.

### 5.1 EVM — `src/catalog/balances/evm.ts`

```ts
import {erc20Abi, multicall3Abi, type Address, type PublicClient} from "viem";
import type {ChainInfo} from "../chains";
import {multicallAddress} from "../evm";
import type {Token} from "../tokens";

/** One eth_call per chain: Multicall3.getEthBalance for the native entry, balanceOf for every contract entry.
 *  null = that read failed (show "—", not 0). Throws only when the whole call fails (fallback transport exhausted). */
export async function readEvmBalances(
  client: PublicClient, chain: ChainInfo, tokens: readonly Token[], owner: Address,
): Promise<Record<string, bigint | null>> {
  const mc = multicallAddress(chain.slug);
  const contracts = tokens.map((t) =>
    t.contract
      ? {address: t.contract as Address, abi: erc20Abi, functionName: "balanceOf", args: [owner]}
      : {address: mc, abi: multicall3Abi, functionName: "getEthBalance", args: [owner]},
  );
  const res = await client.multicall({contracts: contracts as never, allowFailure: true, multicallAddress: mc, batchSize: 4_096});
  return Object.fromEntries(tokens.map((t, i) => [t.key, res[i]!.status === "success" ? (res[i]!.result as bigint) : null]));
}
```

- `client` = `getPublicClient(wagmiConfig, {chainId})` (`@wagmi/core`) or a module-level
  `createPublicClient({chain: toViemChain(c), transport: transportFor(c)})` per chain. Never the wallet's
  EIP-1193 provider (it only serves the wallet's current chain and may prompt).
- `tokens` = `TOKENS.filter((t) => t.chain === chain.slug)`. Celo and Arc have no native entry, so their gas
  token is read with `balanceOf` at the catalog's decimals — exactly what the swap needs (6-dec USDC on Arc).
- `batchSize: 4_096` keeps the largest chain (Ethereum, 26 reads ≈ 1 KB calldata) in one call.
- Probe (viem 2.57.10, node): Ethereum 26 reads in 168 ms, Elysium 7, Arc 4, zkSync 14 (own Multicall3) — 0 failures.

### 5.2 Solana — `src/catalog/balances/solana.ts`

Verified with `Origin: https://swap.cp0x.com`:

| RPC | getBalance | getTokenAccountsByOwner | getMultipleAccounts | notes |
|---|---|---|---|---|
| `solana-rpc.publicnode.com` | 200 | **403 "Request blocked" / "Indexed requests require a personal token"** (program and mint filters; also server-side) | 200, **max 10 accounts** | `getTokenAccountBalance` also blocked; `getLatestBlockhash`, `getSignatureStatuses` (+`searchTransactionHistory`), `getRecentPrioritizationFees`, `simulateTransaction`, `sendTransaction` allowed; `ACAO: *`, allows `solana-client` header |
| `api.mainnet-beta.solana.com` | **403 "Access forbidden" for any browser Origin** (works without Origin) | 403 | 403 | unusable from a browser |
| `public.rpc.solanavibestation.com` | 200 | **200** | — | `ACAO: *`, preflight allows `Solana-Client`; unknown SLA → second endpoint only |
| `solana.drpc.org` | 400 "not available on free plan" | | | no |
| `rpc.ankr.com/solana` · `rpc.solanatracker.io/public` · `solana-mainnet.gateway.tatum.io` · onfinality public | 403 key · 401 key · paid-only · 429 at 1 rps | | | no |
| Jupiter `lite-api.jup.ag/ultra/v1/holdings/{a}` | works, echoes origin | | | shares the keyless Jupiter bucket with quotes → don't |

So: derive the owner's associated token accounts for the 13 catalog mints and read them with
`getMultipleAccounts` (`jsonParsed`). PYUSD and USDG are Token-2022 mints (owner checked on-chain); the other 11
are classic SPL. Tokens held in a non-ATA account are not seen (acceptable for a swap).

```ts
import {address, getAddressEncoder, getProgramDerivedAddress, type Address} from "@solana/kit";
import type {Token} from "../tokens";

export const SOLANA_RPCS = ["https://solana-rpc.publicnode.com", "https://public.rpc.solanavibestation.com"] as const;
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/** Catalog mints owned by Token-2022 (getMultipleAccounts owner, 2026-11-11). A test re-checks this (Appendix B). */
export const TOKEN_2022_MINTS: ReadonlySet<string> = new Set([
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", // USDG
]);
const enc = getAddressEncoder();

export async function ataOf(owner: string, mint: string): Promise<Address> {
  const program = TOKEN_2022_MINTS.has(mint) ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  const [pda] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [enc.encode(address(owner)), enc.encode(program), enc.encode(address(mint))],
  });
  return pda;
}

async function solRpc<T>(method: string, params: unknown[]): Promise<T> {
  let last: unknown;
  for (const url of SOLANA_RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}), signal: AbortSignal.timeout(10_000),
      });
      const j = (await res.json()) as {result?: T; error?: {message?: string}};
      if (j.error || j.result === undefined) throw new Error(j.error?.message ?? `${method} HTTP ${res.status}`);
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}

type ParsedTokenAccount = {data: {parsed: {info: {mint: string; tokenAmount: {amount: string; decimals: number}}}}} | null;

export async function readSolanaBalances(owner: string, tokens: readonly Token[]): Promise<Record<string, bigint | null>> {
  const spl = tokens.filter((t) => t.contract);
  const native = tokens.find((t) => !t.contract);
  const atas = await Promise.all(spl.map((t) => ataOf(owner, t.contract!)));
  const chunks: Address[][] = [];
  for (let i = 0; i < atas.length; i += 10) chunks.push(atas.slice(i, i + 10)); // publicnode cap: 10
  const [lamports, ...pages] = await Promise.all([
    solRpc<{value: number}>("getBalance", [owner, {commitment: "confirmed"}]),
    ...chunks.map((c) => solRpc<{value: ParsedTokenAccount[]}>("getMultipleAccounts", [c, {encoding: "jsonParsed", commitment: "confirmed"}])),
  ]);
  const accounts = pages.flatMap((p) => p.value);
  const out: Record<string, bigint | null> = {};
  if (native) out[native.key] = BigInt(lamports.value);
  spl.forEach((t, i) => {
    const info = accounts[i]?.data.parsed.info;
    // No ATA = 0. A mint mismatch would mean a wrong program guess — treat as unknown.
    out[t.key] = !accounts[i] ? 0n : info?.mint === t.contract ? BigInt(info.tokenAmount.amount) : null;
  });
  return out;
}
```

Probe (node, same code shape): a known exchange wallet → SOL, USDC, USDT, USD1 read via 1 + 2 calls; the
other mints "no ATA" (= 0).

The Jupiter module (`protocol-swap2-jupiter`) needs only `simulateTransaction` and `getSignatureStatuses` from its
`rpcUrls` — both allowed on publicnode; pass `rpcUrls: [...SOLANA_RPCS]`.

### 5.3 TON (later) — `src/catalog/balances/ton.ts`

```ts
const TONAPI = "https://tonapi.io/v2";

/** EQ…/UQ… (48-char base64url) or raw → "wc:hex" lowercase. tonapi reports jetton masters raw. */
export function tonToRaw(a: string): string {
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(a)) return a.toLowerCase();
  const bin = atob(a.replace(/-/g, "+").replace(/_/g, "/"));
  if (bin.length !== 36) throw new Error("bad TON address");
  const wc = (bin.charCodeAt(1) << 24) >> 24;
  let hex = "";
  for (let i = 2; i < 34; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return `${wc}:${hex}`;
}

export async function readTonBalances(owner: string, tokens: readonly Token[]): Promise<Record<string, bigint | null>> {
  const [acct, jet] = await Promise.all([
    fetch(`${TONAPI}/accounts/${encodeURIComponent(owner)}`, {signal: AbortSignal.timeout(10_000)}).then((r) => r.json() as Promise<{balance?: number | string}>),
    fetch(`${TONAPI}/accounts/${encodeURIComponent(owner)}/jettons`, {signal: AbortSignal.timeout(10_000)})
      .then((r) => r.json() as Promise<{balances?: {balance: string; jetton: {address: string; decimals: number}}[]}>),
  ]);
  const byMaster = new Map((jet.balances ?? []).map((b) => [b.jetton.address.toLowerCase(), BigInt(b.balance)]));
  return Object.fromEntries(tokens.map((t) => [t.key, t.contract ? (byMaster.get(tonToRaw(t.contract)) ?? 0n) : BigInt(acct.balance ?? 0)]));
}
```

Verified: `tonToRaw("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs")` = tonapi's
`0:b113a994…621dfe`; catalog jettons matched by raw address (tonapi's symbols differ, e.g. `USD₮`). A new,
never-deployed wallet: tonapi may 404 the account — treat as 0. (Mobile's `toRawAddress` in
`apps/mobile/lib/dapp/ton.ts:56-75` also checks the CRC; copy it if addresses come from user input.)

Tron (later): `api.trongrid.io/v1/accounts/{a}` → `data[0].balance` (sun) + `data[0].trc20[]` maps
(`v2Balances.service.ts:876-910`); keyless TronGrid 429s under load. NEAR: fastnear `query` `view_account` +
`call_function ft_balance_of` (`:912-946`). BTC/Zcash: deposit-only in the web app → no balance read.

### 5.4 Orchestration — `src/catalog/balances/index.ts`

```ts
// owners: {evm?: Address, solana?: string, ton?: string} from the connectors.
// useQueries over:
//   EVM_CHAINS (31) when owners.evm:   ["bal", slug, owners.evm]  → readEvmBalances(client(slug), chain, tokensOf(slug), owners.evm)
//   solana when owners.solana:         ["bal", "solana", owner]   → readSolanaBalances(owner, tokensOf("solana"))
//   ton when owners.ton (later):       ["bal", "ton", owner]      → readTonBalances(owner, tokensOf("ton"))
// options: staleTime 30_000, refetchOnWindowFocus true, retry 1, gcTime 5 min.
// Merge into Record<tokenKey, {amount: string; state: "loaded" | "loading" | "error"}>: bigint → toString();
// null or a failed query → state "error" (render "—", never "0", and never block the swap on it).
// Invalidate ["bal", <source slug>] after the source tx confirms, ["bal", <dest slug>] after delivery.
```

Selected chain first: render immediately from whichever query resolves; the selected pay chain's query can be
given a higher priority simply by being the one the screen mounts first.

MAX: `maxSwappable(balance, t.gasToken, gasReserve(family, chain.native.symbol, t.decimals, chainId))` — note
`t.gasToken` (not `!t.contract`), so Celo CELO and Arc USDC keep a reserve. `gasReserve`'s table
(`math.ts:105-130`) has no USDC entry → Arc falls to the default 0.05 USDC, which is fine.

---

## 6. Risks and open items

1. **Solana public RPCs are fragile from a browser.** mainnet-beta forbids browser origins; publicnode blocks
   indexed methods and caps `getMultipleAccounts` at 10. The ATA design avoids both; the only fallback that
   still serves `getTokenAccountsByOwner` is solanavibestation (no SLA). A keyed RPC would need a proxy — out of
   scope for a no-backend app; revisit if publicnode tightens further.
2. **CoinGecko keyless is per-IP 5/min-ish and its 429 is CORS-less** — a shared office NAT can lock it out;
   that is why DefiLlama is primary. If DefiLlama is down too, `{}` → no USD values, router ranks on raw output.
3. **Prices are per symbol**, not per (chain, contract): bridged/wrapped variants inherit the underlying
   (USDC.e, LINK.e, WBTC→BTC via `priceOf`'s w-strip). Matches the wallet and the router's contract.
4. `fastUSD` (Sei) has no price anywhere checked.
5. Celo/Arc gas tokens are contract entries in the catalog: use `gasToken`; `usdValue` cannot value a
   `nativeFee` on those sources (returns null for that quote).
6. World Chain's second RPC in `@cp0x/shared` is dead (404); fix in the copy and upstream.
7. Copied `chains.ts` drifts from the monorepo: keep the commit in its header; when the AWK catalog adds a
   chain, a token whose `caip2` has no `ChainInfo` silently disappears (mobile behaves the same). Add a test:
   every `CC_SOURCE_CHAINS` caip2 is in `CHAINS` or `EXTRA_CHAINS`.
8. Catalog symbols are case-sensitive (`ccAsset`), Solana/TON contracts are case-sensitive: lowercase only
   inside `Token.key`, never in `contract`.
9. Deposit-pay tokens (`payMode: "deposit"`) have no `owner`: the UI must collect a refund address, and TON /
   XRP / Stellar deposit QRs must carry the memo (`Chain.memo`).
10. Explorer link patterns for NEAR (`nearblocks.io/tx/…`) and Zcash (`blockchair.com/zcash/tx/…`) in
    `explorerTxUrl` could not be verified (bot walls); nearblocks documents `/txns/<hash>` and blockchair uses
    `/transaction/<hash>` — check in a browser before relying on them.
11. LI.FI (100 req/min) and Jupiter (tiny keyless bucket) budgets are shared with their quote calls — never use
    them for prices or balances on a timer.

---

## Appendix A — `PRICE_IDS` (152 symbols, 124 unique keys, all resolve on DefiLlama 2026-11-11)

```ts
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
  brBTC: "xlayer:0xa161132371c94299d215915d4cbc3b629e2059be", // wallet maps it to "bedrock-btc", unknown to DefiLlama
};
```

## Appendix B — re-verification

Run from any shell; `O=https://swap.cp0x.com`.

```sh
# EVM RPC CORS: preflight + eth_chainId (repeat per URL in chains.ts)
curl -s -o /dev/null -D - -X OPTIONS -H "Origin: $O" -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' https://rpc.elysium.kinetiq.xyz | grep -i access-control-allow-origin
curl -s -D - -X POST -H "Origin: $O" -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' https://rpc.elysium.kinetiq.xyz

# Multicall3 present (codeLen > 2)
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0xca11bde05977b3631167028862be2a173976ca11","latest"]}' https://rpc.elysium.kinetiq.xyz

# Solana: indexed method blocked on publicnode, getMultipleAccounts cap 10, mint owners (Token-2022 set)
curl -s -X POST -H "Origin: $O" -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getMultipleAccounts","params":[["2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo","2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH"],{"encoding":"jsonParsed"}]}' \
  https://solana-rpc.publicnode.com   # .value[].owner must be TokenzQd…

# Prices
curl -s -D - -H "Origin: $O" 'https://coins.llama.fi/prices/current/coingecko:ethereum,coingecko:the-open-network,sei:0x5Cf6826140C1C56Ff49C808A1A75407Cd1DF9423'
curl -s -D - -H "Origin: $O" 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'
```

Suggested CI test (`src/catalog/catalog.live.test.ts`, opt-in `LIVE=1`): every `PRICE_IDS` key resolves on
DefiLlama; `TOKEN_2022_MINTS` equals the set of catalog mints whose owner is Token-2022; every
`CC_SOURCE_CHAINS` caip2 maps to a `Chain`; every EVM RPC answers `eth_chainId` with its chain id.
