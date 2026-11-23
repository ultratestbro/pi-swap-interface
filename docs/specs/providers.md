# cp0x Swap: building every AWK swap2 provider in the browser

Scope: how `src/swap/providers.ts` constructs the Any Wallet Kit (AWK) swap2 providers inside the SPA, what each
one needs (options, RPCs, stores, polyfills), which live APIs answer a browser, and what is still needed from
mobile's `providers.ts`. How the router and engine drive these providers is in `engine.md`. Chain lists and RPC
tables are in `catalog.md`.

Path legend (all read-only sources):

| alias | path |
|---|---|
| `SRV` | `~/cp0x-elysium/apps/api/src/lib/crossChain/index.ts` (server construction, 429 lines) |
| `SRV-OMNI` | `~/cp0x-elysium/apps/api/src/lib/crossChain/omniston.ts` |
| `M` | `~/cp0x-elysium/apps/mobile/lib` |
| `AWK/<pkg>` | `~/cp0x-elysium/apps/mobile/node_modules/@anywalletkit/<pkg>`. These are symlinks to the zod@4 variants under `node_modules/.pnpm/@anywalletkit+<pkg>@<ver>_…/node_modules/@anywalletkit/<pkg>`. They are the exact builds to ship. |

Measured on 2026-11-11 with Node 24.22 from `/private/tmp/claude-501/pi-swap-probe/` (dry quotes only; nothing
was signed). The scripts there are `probe.mjs`, `probe2.mjs`, `approve.mjs`, `names.mjs`, `sym.mjs`, `pf.sh`
and `batch.sh`.

---

## 0. Decisions and risks at a glance

1. **All providers run locally, with no `remoteProvider`, no pins and no cp0x-api in the quote or the check.** Every
   module checks its own upstream answer before a quote is returned (LI.FI decodes the Diamond call, Relay re-hashes
   the order, Chainflip decodes SCALE, and so on). `remote` stays unset, so the engine does not ask for pins.
   `M/swap/pins.ts` is not ported. The hosted build's Standard mode (ARCHITECTURE D30) only changes where some
   requests GO — cp0x's swap-web proxy, a transport that adds cp0x's keys — never who checks the answer.
2. **Build the providers once, with one shared instance per provider.** Relay and others keep "issued quote"
   memory per instance (`preflightDeposit` checks "the request *this instance* issued"). Omniston holds a
   WebSocket. Build a `CrossChainRouter` per request over the same array. **Never call `router.close()` or
   `protocol.close()`**; close only on `pagehide`. Mobile closes its routers each time (`M/swap/engine.ts:177-179`),
   which is only safe there because remote stubs have no `close`.
3. **Default on, every mode** (`config.providers.*` flags an operator or a viewer can turn off), in ask order:
   `uniswap`, `curve`, `balancer`, `wrap`, `usdt0`, `cctp`, `thorchain`, `chainflip`, `near_intents`, `lifi`,
   `relay`, `symbiosis`, `jupiter`, `omniston`. `symbiosis`, `balancer` and `omniston` were a "stage 2" that
   defaulted off until 2026-11-12 (owner: on, as cp0x's server runs them). **`fynd` only in Standard mode** (2026-11-12): through cp0x's proxy, which holds the key, and only while
   health keys it (§4.14). **`zeroex` and `across` the same way** (2026-11-15, ARCHITECTURE D38): their local
   providers run here with every check, a placeholder key, and cp0x's proxy slot as `baseUrl` (§4.18, §4.19).
4. **Zero fees.** Every fee option is left unset (§4). This matches the server, where fees come only from
   `swapFee()`, default 0 (`SRV:254-267`).
5. **No polyfill for the MVP.** No MVP package or dependency touches `Buffer`, `process` (beyond
   `process.env.NODE_ENV`, which Vite replaces) or a Node built-in. Only Omniston (`@ton/core`, `@ton/crypto`,
   `@ston-fi/omniston-sdk`) needs `globalThis.Buffer`. It is loaded in a lazy chunk that installs the polyfill
   first (§2, §6.3).
6. **A secure context is required.** `crypto.randomUUID` (NEAR Intents and Chainflip dry quotes),
   `crypto.getRandomValues` (Omniston secrets) and `crypto.subtle` (via `@solana/kit` PDA hashing) need
   HTTPS or `localhost`. A LAN-IP dev URL (`http://192.168.x.x:5173`) breaks NEAR and Chainflip quotes with
   "crypto.randomUUID is not a function". Use `@vitejs/plugin-basic-ssl` for phone testing.
7. **CORS works for every venue the MVP needs, except the THORChain confirm node.** The second default THORNode,
   `https://thorchain.ibs.team/api`, answers the preflight with **403** and sends no ACAO on GET. THORChain
   refuses without a second operator. The fix: `nodeUrl: [THORWallet, Liquify]`, both CORS-open and
   cross-checked (§4.3). Liquify was flaky during the probe (502 after 65 s), and both nodes then briefly
   answered `refusing quote on node with stale state` (a network-side condition). THORChain is the least
   reliable MVP venue in a browser, so expect "no route" from it at times.
8. **Rate limits are per user IP in a browser, so they mostly stop mattering.** Two venues still need pacing:
   - **Symbiosis** `/v2/quote` is `ratelimit-policy: 1;w=1`. The provider fires `swap-limits` and `/v2/quote`
     back to back on a cold cache and gets "The limit of requests has been exceeded" on the first quote. Fix:
     `fetchImpl: paced(1100)` (verified).
   - **Jupiter** keyless is 0.5 RPS, so `getQuote` is wrapped with a 2.1 s gap.
9. **Durable stores live in IndexedDB** (`src/swap/stores.ts`):
   - the Relay `clearedStore` (one deposit per order across reloads; a store failure makes Relay refuse the
     signature, which is fail-closed);
   - the Omniston quote and secret stores. **The user's browser is the only holder of the HTLC secret.** If the
     tab is closed or throttled when the resolver has funded the destination escrow, the secret is never
     disclosed. The order then cancels and the input refunds after the escrow timelocks (EVM: destination
     cancel 180 s; source cancel 240 s, public at 300 s). Funds return, but the swap fails (§5.4).
10. **NEAR `suspendedChains` defaults to `{}`.** The server comment (`SRV:285-288`) says 1Click's **HOT
    omni-bridge** corridors have answered "not available" since 2026-10-16. The live value is a Vercel env var
    and is not in the repo. Today cp0x-api *and* direct 1Click quote OP, BSC and TON (HOT) dry, so prod is not
    pausing them now. `HOT_OMNI_CORRIDORS` (§4.1) holds the exact chain set to paste into the config if they
    break again.
11. **Omniston, a blocker found live**: EVM→TON quotes are refused by the SDK's audited table
    (`untrusted ton:-239 settlement contract EQDybO88l2lrrAmALRUqpmgEE_tuxk510F4Yd4xjbQZxC9IA`). cp0x-api returns
    the same refusal. EVM→EVM Omniston quotes do work. Fixed in 0.5.5 (2026-11-12): the audited TON entry is now
    the rev2 Escrow Minter `EQDybO88…` (positions pinned to code `eb503578…`); rev1 `EQAbWJ3Y…` is no longer trusted.
12. **Router timeout.** `CrossChainRouter` gives each provider 8 s in a multi-venue auction and 25 s solo
    (`AWK/protocol-swap2-router/dist/chunk-7ZUNB2U7.js:7-8`). It is not configurable. THORChain (two nodes)
    and Symbiosis (paced, up to 4 attempts) can exceed it. They simply drop out of that auction.

---

## 1. Packages and import paths

```jsonc
// package.json — exact pins (re-synced on every AWK bump; last 2026-11-20)
"dependencies": {
  "@anywalletkit/core": "0.9.0",                       // peer of every provider package
  "@anywalletkit/protocol-swap2-core": "0.16.0",       // refusal reasons (0.12.0), Permit2 transfers (0.13.0), QuoteParams.sender (0.14.0), etaSeconds may be null (0.15.0), re-quote after a failed dry run + Permit2 allowances kept + the revert named (0.16.0)
  "@anywalletkit/protocol-swap2-router": "0.7.2",      // RouteSet.refusals (0.6.0), keeps ownGasEstimate (0.6.1), nullable fastest + routes per provider (0.7.0)
  "@anywalletkit/swap2-assets": "0.3.0",
  "@anywalletkit/protocol-swap2-near-intents": "0.3.10",
  "@anywalletkit/protocol-swap2-lifi": "0.8.6",            // EVM → Solana checked (§4.2)
  "@anywalletkit/protocol-swap2-thorchain": "0.4.6",       // any ActiveVault confirms (§4.3)
  "@anywalletkit/protocol-swap2-cctp": "0.6.0",            // two routes, routeId "fast" / "standard" (D47)
  "@anywalletkit/protocol-swap2-usdt0": "0.5.6",           // Legacy Mesh into TON and Tron (§4.5)
  "@anywalletkit/protocol-swap2-chainflip": "0.4.12",
  "@anywalletkit/protocol-swap2-relay": "0.1.7",           // its fee itemized only when priced on the source chain
  "@anywalletkit/protocol-swap2-uniswap": "0.4.10",
  "@anywalletkit/protocol-swap2-curve": "0.1.9",     // added 2026-11-12 (§4.17)
  "@anywalletkit/protocol-swap2-fynd": "0.3.2",      // added 2026-11-12, Standard only (§4.14); TychoRouterV3 redeployed 2026-11-16 + Arc, Elysium (0.3.0)
  "@anywalletkit/protocol-swap2-wrap": "0.4.7",
  "@anywalletkit/protocol-swap2-jupiter": "0.3.13",
  "@anywalletkit/protocol-swap2-symbiosis": "0.1.7",   // default on since 2026-11-12
  "@anywalletkit/protocol-swap2-balancer": "0.3.12",    // default on since 2026-11-12
  "@anywalletkit/protocol-swap2-omniston": "0.5.12",    // default on since 2026-11-12 (lazy chunk); rev2 TON minter since 0.5.5
  "@anywalletkit/protocol-swap2-0x": "0.1.4",          // added 2026-11-15, Standard only (§4.18)
  "@anywalletkit/protocol-swap2-across": "0.1.3",      // added 2026-11-15, Standard only (§4.19)
  "@anywalletkit/protocol-swap2-stargate": "0.1.2",    // added 2026-11-17 (§4.20)
  "buffer": "6.0.3",                                   // only for the Omniston chunk's global polyfill
  "viem": "2.57.10"                                    // the version cp0x-elysium resolves; dedupe with wagmi
}
```

Every package is `"type": "module"` with `exports` subpaths, so use `moduleResolution: "bundler"` in tsconfig.
Every package except Omniston is `sideEffects: false`. Omniston lists `dist/{index,provider,protocol,validators}.js`
as side-effectful. Subpaths used:

| provider (`name`) | factory import | config / extras import |
|---|---|---|
| `near_intents` | `import {nearIntentsProvider, type NearIntentsProviderConfig} from "@anywalletkit/protocol-swap2-near-intents/provider"` | `/config`: `nearIntentsChainRefusal`, `NearIntentsSuspendedChains` |
| `lifi` | `import {lifiProvider, type LifiProviderConfig} from "@anywalletkit/protocol-swap2-lifi/provider"` | `/config`: `lifi`, `LIFI_SOLANA_CAIP2` |
| `thorchain` | `import {thorchainProvider, THORCHAIN_ROUTERS, type ThorchainProviderConfig} from "@anywalletkit/protocol-swap2-thorchain/provider"` | |
| `cctp` | `import {cctpProvider, type CctpProviderConfig, type CctpMode} from "@anywalletkit/protocol-swap2-cctp/provider"` | `/config`: `CCTP_DOMAINS` |
| `usdt0` | `import {usdt0Provider, type Usdt0ProviderConfig} from "@anywalletkit/protocol-swap2-usdt0/provider"` | `/config`: `USDT0_CHAINS` |
| `chainflip` | `import {chainflipProvider, type ChainflipProviderConfig} from "@anywalletkit/protocol-swap2-chainflip/provider"` | `/config`: `CF_VAULTS`, `CF_SOURCE_CHAINS` |
| `relay` | `import {relayProvider, type RelayProviderConfig, type RelayClearedStore} from "@anywalletkit/protocol-swap2-relay/provider"` | `/config`: `RELAY_CHAINS` |
| `uniswap` | `import {uniswapProvider, type UniswapProviderConfig} from "@anywalletkit/protocol-swap2-uniswap/provider"` | root: `UNISWAP_V3` |
| `curve` | `import {curveProvider, type CurveProviderConfig} from "@anywalletkit/protocol-swap2-curve/provider"` | root: `curvePins`, `CURVE_DEPLOYMENTS`, `CURVE_POOLS` |
| `fynd` | `import {fyndProvider, type FyndProviderConfig} from "@anywalletkit/protocol-swap2-fynd/provider"` | `/router`: `FYND_CHAINS`, `fyndPins` |
| `zeroex` | `import {zeroExProvider} from "@anywalletkit/protocol-swap2-0x/provider"` | `/chains`: `ZEROEX_CHAINS`, `ZEROEX_PERMIT2`, `zeroExChain(Id)`; `/settler`: `SettlerResolver`, `ZEROEX_MAX_PERMIT_SECONDS` |
| `across` | `import {acrossProvider} from "@anywalletkit/protocol-swap2-across/provider"` | `/config`: `ACROSS_CHAINS`, `ACROSS_NATIVE`, `acrossRouteOf`; `/pricing`: `acrossRouteUnpriced`; `/verify`: `acrossPins` |
| `wrap` | `import {wrapProvider, WRAPPED_NATIVE, type WrapProviderConfig} from "@anywalletkit/protocol-swap2-wrap/provider"` | |
| `cow` | `import {cowProvider} from "@anywalletkit/protocol-swap2-cow/provider"` | root: `COW_DEPLOYMENTS`, `COW_VAULT_RELAYER`, `COW_ETH_FLOW`, `deploymentOf`, `decodeEthFlowCall`; swap2-core root: `assertGpv2Order`, `assertGpv2Permit`, `isGpv2Order`, `GPV2_VAULT_RELAYER` (ARCHITECTURE D48) |
| `jupiter` | `import {jupiterProvider, type JupiterProviderConfig} from "@anywalletkit/protocol-swap2-jupiter/provider"` | |
| `symbiosis` | `import {symbiosisProvider, type SymbiosisProviderConfig} from "@anywalletkit/protocol-swap2-symbiosis/provider"` | `/config`: `symbiosisChain` |
| `balancer` | `import {balancerProvider, BALANCER_V2_CHAINS, type BalancerProviderConfig} from "@anywalletkit/protocol-swap2-balancer/provider"` | |
| `omniston` | `import {omnistonProvider, type OmnistonProviderOptions, type HtlcSecretStore, type OmnistonQuoteStore} from "@anywalletkit/protocol-swap2-omniston/provider"` | `/validators` (§4.13), `/config`: `omniston` |
| types | `import type {CrossChainProvider, Asset, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types"` | |
| router | `import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router"` | |

The `CrossChainProvider` interface is at `AWK/protocol-swap2-core/dist/types.d.ts:259-347`. `engine.md` §4.1 has
the trimmed copy.

Never import `@anywalletkit/protocol-swap2-core/server` (it uses HMAC sealing and is backend-only) or
`/remote` (nor 0x's or Across's `/remote` stubs: this page runs their local providers through cp0x's proxy, D38).

---

## 2. Runtime environment: globals, polyfills, Vite

### 2.1 What each package touches

From a grep of every `dist/*.js`, plus the dependencies they import:

| package | Node built-ins / globals | browser status |
|---|---|---|
| swap2-core, router, swap2-assets, core | `TextEncoder`; `crypto.subtle` **only in `/server`** (not imported); `AbortSignal.timeout/any` with a fallback (`swap2-core/dist/chunk-OEX7O5CL.js:136-149`) | OK |
| near-intents | `crypto.randomUUID` (dry intent ids, `chunk-4DBCMQCI.js:251`) | needs a secure context |
| chainflip | `crypto.randomUUID`, `TextEncoder`; `@noble/hashes`, `@scure/base` | needs a secure context |
| lifi, thorchain, cctp, usdt0, relay, uniswap, curve, fynd, wrap, balancer, symbiosis | none (`viem`, `@noble/curves`, `@noble/hashes`, `@scure/base`); global `fetch` | OK |
| jupiter | `@solana/kit` 8.5.0: `process.env.NODE_ENV` (Vite defines it), `globalThis.crypto` / `isSecureContext` (SHA-256 for PDAs) | needs a secure context |
| **omniston** | imports `Buffer` from the npm `buffer` package explicitly (`chunk-DMO24BFW.js:14,19`, `validators.js:569`); `crypto.getRandomValues` (HTLC secrets, `chunk-DMO24BFW.js:507`); lazy `import("@ston-fi/omniston-sdk")` (`:1476`) | see below |
| `@ton/core` 0.63.1 (CJS) | **global `Buffer`** without an import (`Buffer.from/alloc/concat/isBuffer`, 41 sites) | needs `globalThis.Buffer` |
| `@ton/crypto` 3.3.0 (CJS) | global `Buffer`; `require("jssha")`, `require("tweetnacl")` | needs `globalThis.Buffer` |
| `@ton/crypto-primitives` 2.1.0 | `require("crypto")` in `dist/node.js`; the `"browser": "./dist/browser.js"` field swaps in WebCrypto | OK (Vite honours `browser`) |
| `@ston-fi/omniston-sdk` 0.8.12 | `import WebSocket from "isomorphic-ws"`; `globalThis.Buffer` *if present* (it falls back to `atob`) | OK |
| `isomorphic-ws` 5.0.0 | `"browser": "browser.js"` → native `WebSocket`; the `ws` package is never imported in the browser build | OK |

No package imports `fs`, `path`, `http`, `net`, `process` (bare) or `ws` on the browser path.

### 2.2 Polyfill (Omniston chunk only)

```ts
// src/polyfills/buffer.ts — imported FIRST by src/swap/omniston.ts (the lazy chunk), never by the MVP bundle
import {Buffer} from "buffer";
const g = globalThis as {Buffer?: typeof Buffer};
g.Buffer ??= Buffer;
export {};
```

ES modules evaluate dependencies depth-first in source order. A static `import "../polyfills/buffer"` placed
above the Omniston imports in `src/swap/omniston.ts` therefore runs before `@ton/core` is evaluated. Most
`@ton/core` uses of `Buffer` are inside functions anyway.

### 2.3 `vite.config.ts` additions

```ts
import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // BigInt literals (100000000n) and class fields are everywhere in the AWK dist; es2022 is safe.
  build: {target: "es2022", sourcemap: true},
  esbuild: {target: "es2022"},
  resolve: {
    // pnpm: one copy of each, or instanceof checks / pinned tables diverge
    dedupe: ["viem", "@anywalletkit/core", "@anywalletkit/protocol-swap2-core", "@anywalletkit/swap2-assets"],
  },
  optimizeDeps: {
    esbuildOptions: {target: "es2022"},
    // These CJS deps are reached only through the Omniston package's own (dynamic) imports. Pre-bundle them so dev
    // does not hit a late "new dependency discovered → full reload" the first time the Omniston chunk loads.
    include: [
      "buffer",
      "@anywalletkit/protocol-swap2-omniston > @ton/core",
      "@anywalletkit/protocol-swap2-omniston > @ton/crypto",
      "@anywalletkit/protocol-swap2-omniston > @ston-fi/omniston-sdk",
    ],
  },
  // No `define: {global: ...}` and no node-polyfills plugin: nothing on the browser path needs them.
});
```

For phone testing over the LAN, add `@vitejs/plugin-basic-ssl` and run `vite --host` (see decision 6).

### 2.4 CSP `connect-src` (static host headers)

Every origin the providers call by default. Add the RPC hosts from `catalog.md` §2.5:

```
https://1click.chaindefuser.com https://li.quest https://gateway.liquify.com https://thorchain-thornode-lb-1.thorwallet.org
https://iris-api.circle.com https://scan.layerzero-api.com https://chainflip-swap.chainflip.io https://api.relay.link
https://api.jup.ag https://api.symbiosis.finance https://api-v3.balancer.fi wss://omni-ws.ston.fi https://tonapi.io
https://*.publicnode.com <every EVM/Solana RPC host in the runtime config>
```

THORChain always appends its built-in `HOSTS` to the confirm list (`chunk-EIAXGWNG.js:540`), which includes
`thorchain.ibs.team`. A CSP that leaves ibs out makes that fetch throw, the code treats it as `HostUnavailable`
and moves on, and the console shows one CSP warning. That is harmless.

A strict CSP (no inline script, no third-party scripts) is **mandatory** once Omniston is on: script access to
the IndexedDB HTLC secret before validation would let a resolver take the source escrow without delivering.

---

## 3. `RuntimeConfig` (`src/swap/runtimeConfig.ts`)

These are the fields `buildProviders` reads. Every value is public: **no keys, ever.** A key in a static bundle
is public, and every venue here quotes without one. Keys reach a provider only two ways, neither through this
config (ARCHITECTURE D30): in Standard mode cp0x's proxy adds cp0x's own keys server-side; in Custom mode the
viewer's own keys (`VenueKeys`, this browser's storage) go straight into their venue's constructor.

```ts
export type ProviderName =
  | "near_intents" | "lifi" | "thorchain" | "cctp" | "usdt0" | "chainflip" | "relay"
  | "uniswap" | "curve" | "wrap" | "jupiter" | "fynd"
  | "symbiosis" | "balancer" | "omniston" | "zeroex" | "across" | "cow";

export interface RuntimeConfig {
  /** Construct the provider at all. Every one default true (fynd, zeroex, across: Standard mode only). */
  providers: Readonly<Record<ProviderName, boolean>>;
  /** EVM JSON-RPC by chain id, tried in order (keyless public endpoints; CORS-checked). */
  evmRpc: Readonly<Record<number, readonly string[]>>;
  /** Solana JSON-RPC (Jupiter's CU simulation + getSignatureStatuses). */
  solanaRpc: readonly string[];
  /** NEAR JSON-RPC (web, 2026-11-12: a NEAR wallet's balances and deposit checks; no venue uses it; D8, D30). */
  nearRpc: readonly string[];
  /** TonAPI base for Omniston's TON validators / delivery locator (keyless). */
  tonApiUrl: string;
  /** API bases; each one is overridable (e.g. your own CORS proxy). */
  api: {
    nearIntents: string;   // NearIntentsProviderConfig.apiUrl
    lifi: string;          // LifiProviderConfig.apiUrl (must be https:)
    cctp: string;          // CctpProviderConfig.apiUrl
    layerZeroScan: string; // Usdt0ProviderConfig.scanUrl
    chainflip: string;     // ChainflipProviderConfig.apiUrl
    relay: string;         // RelayProviderConfig.baseUrl
    jupiter: string;       // JupiterProviderConfig.apiUrl
    symbiosis: string;     // SymbiosisProviderConfig.apiUrl
    balancer: string;      // BalancerProviderConfig.apiUrl
    omnistonWs: string;    // OmnistonProviderOptions.apiUrl (wss:)
    thorNodes: readonly string[];        // ThorchainProviderConfig.nodeUrl (https:, ≥ 2 operators)
    thorConfirmNodes: readonly string[]; // ThorchainProviderConfig.confirmNodeUrl ([] = "the other nodeUrl hosts")
  };
  nearIntents: {suspendedChains: Readonly<Record<string, string>>};
  cctp: {mode: "auto" | "fast" | "standard"};
  thorchain: {clientId: string};
  omniston: {maxUsd: number; evmSource: boolean};
  pacing: {symbiosisGapMs: number; jupiterGapMs: number};
  /** Web (ARCHITECTURE D7, D29): preview prices before a wallet; a viewer's saved settings may only turn it off. */
  preview: {enabled: boolean; roundsBurst: number; roundRefillMs: number};
}
```

Defaults:

```ts
/** SRV:209-252 evmPublicRpcUrls() fallback column, verbatim (the env-keyed first entries dropped).
 *  catalog.md §2.4 RPC_URLS_BY_ID is appended after these as extra fallbacks (deduped). */
export const SERVER_PUBLIC_EVM_RPC: Readonly<Record<number, string>> = {
  1: "https://ethereum-rpc.publicnode.com",
  8453: "https://base-rpc.publicnode.com",
  42161: "https://arbitrum-one-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  56: "https://bsc-rpc.publicnode.com",
  43114: "https://avalanche-c-chain-rpc.publicnode.com",
  4663: "https://rpc.mainnet.chain.robinhood.com",
  324: "https://mainnet.era.zksync.io",
  42220: "https://forno.celo.org",
  4326: "https://mainnet.megaeth.com/rpc",
  9745: "https://rpc.plasma.to",
  59144: "https://rpc.linea.build",
  146: "https://rpc.soniclabs.com",
  480: "https://worldchain-mainnet.g.alchemy.com/public",
  57073: "https://rpc-gel.inkonchain.com",
  196: "https://rpc.xlayer.tech",
  1329: "https://evm-rpc.sei-apis.com",
  98866: "https://rpc.plume.org",
  5042: "https://rpc.mainnet.arc.io",
  5000: "https://rpc.mantle.xyz",
  747474: "https://rpc.katana.network",
  2818: "https://rpc.morphl2.io",
  14: "https://flare-api.flare.network/ext/C/rpc",
  99901: "https://rpc.elysium.kinetiq.xyz",
  100: "https://gnosis-rpc.publicnode.com",
  130: "https://unichain-rpc.publicnode.com",
  143: "https://rpc.monad.xyz",
  999: "https://rpc.hyperliquid.xyz/evm",
  534352: "https://rpc.scroll.io",
  80094: "https://rpc.berachain.com",
};

import {RPC_URLS_BY_ID} from "../catalog/evm";        // catalog.md §2.4
import {SOLANA_RPCS} from "../catalog/solana";        // catalog.md: ["https://solana-rpc.publicnode.com", "https://public.rpc.solanavibestation.com"]

const mergeRpc = (): Record<number, string[]> => {
  const ids = new Set([...Object.keys(SERVER_PUBLIC_EVM_RPC), ...Object.keys(RPC_URLS_BY_ID)].map(Number));
  return Object.fromEntries([...ids].map((id) => [id, [...new Set([SERVER_PUBLIC_EVM_RPC[id], ...(RPC_URLS_BY_ID[id] ?? [])].filter((u): u is string => !!u))]]));
};

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  providers: {
    near_intents: true, lifi: true, thorchain: true, cctp: true, usdt0: true, chainflip: true, relay: true,
    uniswap: true, wrap: true, jupiter: true,
    symbiosis: false, balancer: false, omniston: false,
  },
  evmRpc: mergeRpc(),
  solanaRpc: SOLANA_RPCS,
  nearRpc: ["https://rpc.mainnet.fastnear.com"],
  tonApiUrl: "https://tonapi.io",
  api: {
    nearIntents: "https://1click.chaindefuser.com/v0",
    lifi: "https://li.quest/v1",
    cctp: "https://iris-api.circle.com",
    layerZeroScan: "https://scan.layerzero-api.com",
    chainflip: "https://chainflip-swap.chainflip.io",
    relay: "https://api.relay.link",
    jupiter: "https://api.jup.ag/swap/v2",
    symbiosis: "https://api.symbiosis.finance/crosschain",
    balancer: "https://api-v3.balancer.fi/",
    omnistonWs: "wss://omni-ws.ston.fi",
    // Liquify first; THORWallet second (it fell behind on 2026-11-12 and refuses quotes, but its vault list still
    // confirms Liquify's — see §4.3 Fragility).
    thorNodes: ["https://gateway.liquify.com/chain/thorchain_api", "https://thorchain-thornode-lb-1.thorwallet.org"],
    thorConfirmNodes: [],
  },
  nearIntents: {suspendedChains: {}},
  cctp: {mode: "auto"},
  thorchain: {clientId: "cp0x-swap"},
  omniston: {maxUsd: 1000, evmSource: true},  // 1000 = the SDK default (omniston/config maxUsd)
  pacing: {symbiosisGapMs: 1100, jupiterGapMs: 2100},
  preview: {enabled: true, roundsBurst: 5, roundRefillMs: 20_000},
};
```

Loading: start from `DEFAULT_RUNTIME_CONFIG`, then shallow-merge `import.meta.env.VITE_SWAP_CONFIG` (a JSON
string) at build time, then `/config.json` (fetched with `cache: "no-store"`, optional) at boot. Validation rules
for `parseRuntimeConfig(raw: unknown): RuntimeConfig`:

- Accept only known keys. URLs must be `https:` (`wss:` for `omnistonWs`). `thorNodes` needs ≥ 2 distinct hosts.
- `nearIntents.suspendedChains` accepts an object **or** the server's env string `"caip2=reason;caip2=reason"`.
  Port `suspendedChainsFromEnv` verbatim (`SRV:122-133`); an entry without a reason reads "paused by the app".
- **Never** let runtime config change pinned allowlists: LI.FI trusted targets, THORChain routers, Omniston
  settlement contracts and order protocols. Those stay in code. An endpoint override is lower risk because each
  module verifies the answer, with one exception: LI.FI's bridge-side destination minimum "relies on LI.FI's API
  (or your apiUrl proxy) answering honestly" (`AWK/protocol-swap2-lifi/README.md`). Overriding the LI.FI or
  THORChain endpoints is a trust decision.

**The connection layer (web, 2026-11-12; ARCHITECTURE D30).** After the layers above (and the viewer's saved
settings, D8), the page's connection mode adjusts the config the providers are built from:

| mode | `api.lifi` / `relay` / `nearIntents` / `jupiter` | `evmRpc[id]` / `solanaRpc` | `api.thorNodes` / `thorConfirmNodes` |
|---|---|---|---|
| Public (any build) | public, unchanged | public, unchanged | unchanged |
| Custom (any build) | public, unchanged (the viewer's keys go to the constructors) | the viewer's URLs FIRST, public after (with "only my RPCs": the viewer's URLs alone) | unchanged |
| Standard (built with `VITE_CP0X_API`) | `<API>/api/v2/swap-web/venue/{lifi,relay,near_intents,jupiter}` | `<API>/api/v2/swap-web/rpc/<id\|solana>` FIRST, public after | quote nodes unchanged (Liquify first); `…/venue/thornode` FIRST in the confirm list |

Standard builds the page with every proxy slot in place (providers and RPC lists are fixed per page, while the
health answer, `GET <API>/api/v2/swap-web/health`, arrives up to 3 s later); `src/config/standard.ts` then routes each
request: a venue slot carries traffic only while health calls that venue "keyed" (else the request goes to the
venue's public base, same path/query/body), an RPC slot only for the networks health lists, the THORNode slot only
while `health.thornode` is true; an unused RPC or THORNode slot fails at once without a request, so the client takes
its next URL. A venue call that fails at the proxy itself, or that the upstream answers 401/403/429 (cp0x's key or
server IP refused), is retried once at the venue and the venue stays direct (for the 429's Retry-After, at most
5 min; until 00:00 UTC after a daily-limit 429; else for the page). Not slotted: a venue the viewer's saved settings
point elsewhere, a venue that isn't built, and — against a plain-http local API — LI.FI and THORNode, whose SDKs
refuse http bases (their `allowInsecure*` escape hatches stay off). Wallets never see a proxy RPC URL (chain definitions and wagmi's
transports drop every cp0x API URL, in any mode). Only this layer adds cp0x: a cp0x API URL in any earlier layer
(VITE_SWAP_CONFIG, runtime-config.json, saved settings, Custom RPCs) is dropped at boot.

---

## 4. Per-provider construction

Every factory is a plain function that returns a plain object. `enabled` defaults to **true** in all of them
(`config.enabled ?? true`). Omniston is the exception: it is also `false` until `trustedSettlementContracts` is
non-empty (`chunk-DMO24BFW.js:2038`). The browser never passes `enabled`; a disabled provider is simply not
constructed. All option types below are copied from the installed `.d.ts`, with long comments trimmed.

### 4.1 NEAR Intents (1Click), `near_intents`

`AWK/protocol-swap2-near-intents/dist/provider.d.ts:5-26`, `config.d.ts:9-25`

```ts
interface NearIntentsProviderConfig {
  enabled?: boolean;
  apiUrl?: string;
  jwt?: string;
  feeRecipient?: string;
  feeBps?: number;
  /** Corridors the app has paused (caip2 → reason): refused up front, by name, until the app lifts them. */
  suspendedChains?: NearIntentsSuspendedChains;            // = Readonly<Record<string, string>>
  recipientType?: "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
}
declare function nearIntentsProvider(config?: NearIntentsProviderConfig): CrossChainProvider;
```

- **Browser options**: `{apiUrl: cfg.api.nearIntents, suspendedChains: cfg.nearIntents.suspendedChains}`.
  - No `jwt` of cp0x's: it stays server-side (Standard mode: cp0x's proxy adds it while 1Click is "keyed",
    ARCHITECTURE D30). Custom mode passes the viewer's own `jwt`, sent as `authorization: Bearer`; 1Click's preflight
    allows `authorization` (probe 2026-11-12). The 2026-11-11 probe showed no price difference: cp0x-api
    19 995 388 vs direct 19 995 389 out for 20 USDC Arb→OP.
  - No `feeRecipient`/`feeBps` (fee 0); the constructor throws if only one of them is set.
  - Default `recipientType`.
- **Server equivalent**: `SRV:280-289`, enabled unless `NEAR_INTENTS_ENABLED=0`.
- **Routes**: cross-chain only (`supportsSameChain` unset → the router drops it from same-chain pairs).
  - Any pair of 1Click-listed chains: EVM 1, 8453, 42161, 10, 56, 137, 100, 143, 43114, 534352, 80094, 9745,
    plus Solana, Tron, BTC, NEAR, TON, Sui, Zcash, LTC, DOGE, XRP, BCH, Cardano, Stellar and Aptos.
  - `supportsRoute` needs both tokens' 1Click `assetId` in `swap2-assets` (`chunk-4DBCMQCI.js:155-159`).
- **Execution model**: a plain send to a per-quote deposit address, with an optional memo.
  - EVM and Solana sources sign it in the wallet.
  - **BTC, ZEC, LTC, DOGE, XRP and other sources are the QR routes.** `engine.md` §9 covers them: a live quote
    with the user's refund address on the source chain, then show `depositAddress` + `depositMemo`. 1Click is the
    only MVP venue that serves those sources. THORChain needs an EVM source; Chainflip and Symbiosis BTC
    sources are off.
- **Dry quotes**: with no `refundAddress`, the provider uses its own per-namespace placeholder
  (`chunk-4DBCMQCI.js:46-62`). Dry quotes return no deposit address and an `intentId` of `dry:<uuid>`.
- **Tracking**: stateless, by deposit address (+memo) via `GET /v0/status`. `notifyDeposit` POSTs
  `/v0/deposit/submit`; it is best-effort, and required for TON sources only.
- **Stores**: none.
- **CORS**: OK. The preflight echoes `content-type,accept`.
- **Rate limit**: `x-ratelimit-limit-unauth: 1200` per 60 s, per IP.
- **The provider itself retries flaky 5xx and "no liquidity" twice (500/1000 ms).**
- **`suspendedChains`**:
  - Mechanism: `getQuote` refuses with `1Click corridor paused by the app: <chain> — <reason>` for the source
    **and** the destination (`config.js` `nearIntentsChainRefusal`). `supportsRoute` ignores suspension, so a
    paused pair still shows up as a rejection reason.
  - Current reason (`SRV:285-288`): "1Click's HOT omni-bridge corridors have answered 'not available' since
    2026-10-16; drop the entry when they quote again (the routes canary tells)". The value lives only in the
    Vercel env (`apps/api/.env.example:119-120` is empty).
  - Live today: both direct and through cp0x-api, Arb USDC → OP USDC, → BSC USDT and → TON USDT all quote, so
    prod does not suspend them now. **Default `{}`.**
  - The HOT omni corridors, from the `nep245:v2_1.omni.hot.tg:<chain>_…` asset ids in `swap2-assets` 0.3.0
    (chain codes 1117 = TON, 1100 = Stellar):

    ```ts
    export const HOT_OMNI_CORRIDORS: Readonly<Record<string, string>> = {
      "ton:-239": "HOT omni-bridge corridor paused",
      "eip155:10": "HOT omni-bridge corridor paused",
      "eip155:56": "HOT omni-bridge corridor paused",
      "eip155:137": "HOT omni-bridge corridor paused",
      "eip155:143": "HOT omni-bridge corridor paused",
      "eip155:43114": "HOT omni-bridge corridor paused",
      "eip155:534352": "HOT omni-bridge corridor paused",
      "stellar:pubnet": "HOT omni-bridge corridor paused",
    };
    ```

  - Suspension is chain-wide. Pausing `eip155:10` also blocks OP's non-HOT assets (WBTC, DAI…) on 1Click.

### 4.2 LI.FI, `lifi`

`AWK/protocol-swap2-lifi/dist/provider.d.ts:4-47`

```ts
interface LifiProviderConfig {
  enabled?: boolean;
  apiUrl?: string;                     // must be https unless allowInsecureApiUrl
  allowInsecureApiUrl?: boolean;
  apiKey?: string;
  integrator?: string;
  trustedTransactionTargets?: Readonly<Record<string, readonly string[]>>;
  trustedApprovalAddresses?: Readonly<Record<string, readonly string[]>>;
  quoteTtlMs?: number;                 // 1..60000, default ~60 s window
  defaultSlippageBps?: number;         // default 50
  chooseRoute?: (routes: readonly LifiRouteOption[], params: QuoteParams) => LifiRouteChoice | null | undefined;
  routeWideSlippage?: boolean;         // default off
}
declare function lifiProvider(config?: LifiProviderConfig): CrossChainProvider;
```

- **Browser options**: copied from `SRV:290-299`, minus the env.

  ```ts
  const LIFI_FLARE_DIAMOND = {"eip155:14": ["0x198FC70Dfe05E755C81e54bd67Bff3F729344B9b"]} as const;
  lifiProvider({apiUrl: cfg.api.lifi, trustedTransactionTargets: LIFI_FLARE_DIAMOND, trustedApprovalAddresses: LIFI_FLARE_DIAMOND});
  ```

  - No `apiKey` of cp0x's in the browser (Standard mode: cp0x's proxy adds it while LI.FI is "keyed"); Custom mode
    passes the viewer's own, sent as `x-lifi-api-key` (in LI.FI's CORS allow list). No `integrator`, so the
    `integrator` query parameter is omitted; the server keeps cp0x's integrator at 0 in LI.FI's portal.
  - No `chooseRoute`, no `routeWideSlippage`, same as the server.
  - Flare: `li.quest/v1/chains` names `0x198F…` as the Flare Diamond. The canonical `0x1231…` has no code there,
    so without the override every Flare route is refused.
- **Routes**: `supportsSameChain: true`. Every LI.FI EVM chain (31 incl. Elysium 99901, Flare 14) plus
  `solana:mainnet` (`lifi.supportsChain`).
  - **Refused by the module**: destination calls; the bridges whose facet does not bind delivery (Relay, Garden,
    deBridge DLN, ThorSwap, Squid, Symbiosis), and since 0.8.0 LI.FI Intents on every EVM-source route (its escrow
    order names its own oracles, settler and output amount: `INTENTS_UNPINNED`), all requested with `denyBridges`
    (`REFUSED_EVM_TOOLS`, `chunk-G26GE46T.js:784-786`). So Elysium (99901), which LI.FI serves cross-chain only through
    Intents, has no cross-chain LI.FI route for now; its same-chain swaps still quote. Any non-EVM destination other
    than Solana still refuses (`NON_EVM_UNREAD`).
  - **EVM → Solana is checked (lifi 0.8.0, asked since 2026-11-13).** The request asks only the bridges whose
    delivery the module reads (`allowBridges` = `SOLANA_DESTINATION_TOOLS`, `:787`: Mayan Swift / MCTP / Fast MCTP,
    Polymer CCTP, Chainflip). `solanaRecipientMismatch` (`:486-498`) then requires BridgeData to pay LI.FI's non-EVM
    placeholder on the Solana chain id, and reads the facet: Mayan's order `destAddr` = the recipient, Wormhole 1 or
    CCTP domain 5, a plain delivery of the requested mint; Polymer CCTP's `mintTo` = the recipient's USDC associated
    token account (derived on the device); Chainflip's 32-byte destination = the recipient with asset SOL/USDC/USDT.
    Deposit facets (NEARIntents, LayerSwap, Unit) and Smart Deposits are refused ("… the transaction does not bind
    it"), every other facet keeps the old refusal. The app's former narrowing (`lifiChecksRecipient`, which never asked
    LI.FI EVM → Solana under 0.7.0's blanket refusal) is gone; the app's own Solana id is `solana:mainnet`, LI.FI's.
  - Solana sources return a `serializedTx`, so the account needs `sendSerializedTransaction` (`engine.md` §6.2).
- **Execution**: EVM calldata to the Diamond. The dry quote names `approvalAddress` = the Diamond (probe:
  `0x1231DEB6…` for both `to` and approval).
- **Stores**: none. Tracking is stateless by source tx hash (`/status`).
- **CORS**: OK (`ACAO: *`, allows `x-lifi-api-key` etc.). GETs with only `accept` are simple requests.
- **Rate limit**: `ratelimit-limit: 100`, `ratelimit-reset: 60`, per IP on `/v1/tools` and `/v1/chains`. Keyless
  `/v1/quote` is far tighter, measured live on 2026-11-12: about **75 per ~2 h per IP** (`ratelimit-limit: 75`,
  `ratelimit-remaining: 0`, `retry-after: 5693`, HTTP 429 body `{"message":"Rate limit exceeded, retry in 2 hours",
  "code":1005}`). The route list refreshes every 30 s and the SDK may send two `/quote` per round (`:1132-1137` slippage
  rescale), so one open tab used it up in roughly 20–40 min; shared IPs (office NAT, VPN, CGNAT) share it. A key
  can't ship in a public static SPA. Uses global `fetch`; there is no `fetchImpl` option.
- **Cooldown (app, 2026-11-12)**: `coolDownOnRateLimit` (`providerWrappers.ts`) wraps the one shared LI.FI instance.
  On a refusal matching `RATE_LIMITED` (`refusals.ts`, the same predicate the route list's "busy" rows use:
  `/rate.?limit|too many requests|limit of requests|(?:HTTP|status|quote|build|encode|1Click|API \u2192):?\s*429\b/i` — a 429 only where the SDK
  names it as a status, never one inside an amount or a floor such as "min=429") it remembers `until = now + the
  "retry in|after N unit" wait` (`RETRY_WAIT`, the pattern the list reads; else 15 min; at most 3 h); until then `getQuote` refuses at once with "lifi: rate limit
  exceeded, retry in ~N min" and sends nothing. It never caches or returns a quote: after the wait LI.FI is asked afresh and its checks run
  again. The list reads it as "Request limit hit — back in about 2 hours" (ARCHITECTURE D28).
- **Previews (app, rewritten 2026-11-13; ARCHITECTURE D7)**: asked in a preview round only while cp0x's proxy
  carries LI.FI with cp0x's key (a Standard page, health "keyed", the slot not stopped), decided per round; there
  cp0x's daily budget (5000) caps the spend, not the keyless ~75 `/quote` per 2 h per IP. Anywhere else (Public,
  Custom with or without a viewer's key, a build without the API, health anonymous or unreachable, a stopped slot) it
  waits for the live quote: a quiet "Quoted after you connect" row, "Connect a wallet to get this quote". The
  preview's call carries a `keyedOnly` signal: the routing gives it the one direct retry after a failure at the
  proxy, once per page, then fails it WITHOUT a request from the stopped slot (the SDK's second `/quote` of that
  round, every later preview) and without a keyless retry when the proxy fails again after a short stop ran out.
  Addressing, read in 0.8.0: a dry quote's sender is `refundAddress ||` its own placeholder — EVM `0xd8dA…6045` (the
  EVM sample, `:688`) or Solana `HAgk14Jp…uT3DKpqk` (`:689`) by source (`:961`) — so it needs no real sender, and its
  checks run on the dry quote as on a live one (sender, recipient, Diamond call, approval target). A blank
  destination becomes that sender placeholder (`:962`), except EVM → Solana, which prices for its Solana placeholder
  (`dryRecipient`, `:789`): right for EVM → EVM, Solana → Solana and EVM → Solana, the wrong family for Solana → EVM,
  so the app fills a blank destination with the destination family's sample only for Solana → EVM
  (`FILLS_OTHER_FAMILY`). A dry quote priced for a placeholder (no refund, or EVM → Solana with no recipient:
  `placeholderIn`, `:790-793`) comes back **price-only**: every check ran, then the transaction is dropped
  (`providerData: {placeholder, nativeFee?}`, no `txRequest`, `:1182`), so a Standard preview's LI.FI row has no
  approval tag, the generic gas estimate and no bridge fee (the router still nets `providerData.nativeFee`, engine.md
  §2.4). Its texts can name the Solana placeholder ("the Solana transaction is paid by …, not the sender …", `:615`):
  scrubbed like the samples.

### 4.3 THORChain, `thorchain`

`AWK/protocol-swap2-thorchain/dist/provider.d.ts` (0.4.0)

```ts
declare const THORCHAIN_ROUTERS: Readonly<Record<string, readonly string[]>>;
interface ThorchainProviderConfig {
  enabled?: boolean;
  affiliate?: string;
  affiliateBps?: string;
  nodeUrl?: string | string[];          // tried in order; quote + inbound snapshot from the same host
  confirmNodeUrl?: string | string[];   // another operator must report the same vault/router
  trustedRouters?: Readonly<Record<string, readonly string[]>>;
  allowInsecureNodeUrl?: boolean;
  clientId?: string;                    // sent as x-client-id (1-128 visible ASCII; default "anywalletkit")
  tronSource?: boolean;                 // ships dark
  confirmMaxLagBlocks?: number;         // 0.4.0: skip a confirming node this far behind the quoting one (default 50)
  confirmTimeoutMs?: number;            // 0.4.0: all reads of one confirming node (default 2500, 100–8000)
}
declare const THORNODE_CONFIRM_PATHS: {lastblock, inboundAddresses, asgardVaults, mimir};  // 0.4.0, the only confirm reads
declare function thorchainProvider(config?: ThorchainProviderConfig): CrossChainProvider;
```

- **Browser options**:

  ```ts
  thorchainProvider({
    nodeUrl: [...cfg.api.thorNodes],
    ...(cfg.api.thorConfirmNodes.length ? {confirmNodeUrl: [...cfg.api.thorConfirmNodes]} : {}),
    clientId: cfg.thorchain.clientId,
    tronSource: false,
  });
  ```

  - No affiliate (fee 0). `affiliate` and `affiliateBps` must be set together or the constructor throws.
  - `tronSource: false`: there is no Tron wallet yet, and the server keeps it dark too (`SRV:300-308`).
- **Why not the defaults**: the defaults are `HOSTS = [gateway.liquify.com/chain/thorchain_api,
  thorchain.ibs.team/api]` (`chunk-EIAXGWNG.js:217-220`).
  - ibs.team returns **403 to the CORS preflight** (the request carries the custom `x-client-id`, so a preflight
    always happens) and no `Access-Control-Allow-Origin` on GET.
  - The provider needs a node *other than the quoting one* to vouch for the inbound vault and router, both at
    quote time and in `preflightDeposit`. Otherwise it refuses: "no second node answered to confirm the inbound
    vault".
- **Vault confirmation (0.4.0, `vaultVerdict`, `chunk-EIAXGWNG.js:187-214`; `confirmedElsewhere`, `:610-654`)**:
  - The quoting node answers `/thorchain/lastblock` too, read with its `inbound_addresses` (8 s each); a failed or
    malformed height makes it unavailable and the next `nodeUrl` quotes.
  - Each confirming node is read with GET on fixed paths only (`THORNODE_CONFIRM_PATHS`), no query, `redirect:
    "error"`: `lastblock` and `inbound_addresses` always; `vaults/asgard` and `mimir` only when its current inbound
    vault is not the quoted one. It confirms when the quoted vault is its current inbound address, or the source
    chain's address of an `ActiveVault` that mimir doesn't flag (`CompromisedVault-…`, `SolvencyHaltVault-…`): a vault
    rotation no longer refuses. A `RetiringVault` (or any other status) or a flagged vault refuses; a halted or
    paused source **or destination** chain refuses ("… is halted / paused on the confirming node").
  - A node more than `confirmMaxLagBlocks` (50) behind the quoting node's height, or slower than `confirmTimeoutMs`
    (2.5 s for all its reads), is skipped for the next one; all confirming nodes share an 8 s budget from the quote
    (`CONFIRM_BUDGET_MS`). New refusals: "no confirming node is within 50 blocks …", "the 8 s confirmation budget ran
    out …", "THORChain height (/thorchain/lastblock) unavailable …" (worded in `refusals.ts`). Any field of the wrong
    type in any of these answers makes that node unavailable.
- **CORS-open THORNodes found** (2026-11-11):
  - `https://thorchain-thornode-lb-1.thorwallet.org`: preflight 204, `allow-headers: …, *`, GET `ACAO: *`; the
    inbound vaults and routers match Liquify.
  - `https://gateway.liquify.com/chain/thorchain_api`: allows `x-client-id` explicitly.
  - Not usable: ninerealms (no answer), thorswap (403), publicnode (404), several others with no answer.
- **Confirm hosts** = `[...confirmNodeUrl, ...nodeUrl, ...HOSTS]` minus the quoting host
  (`chunk-EIAXGWNG.js:540`). With `nodeUrl = [Liquify, THORWallet]`, each host confirms the other. Both answer the
  three new paths with CORS (checked 2026-11-13); ibs.team still answers its preflight 403.
- **A lagging node blocks every quote** (2026-11-12): the THORWallet balancer was ~28 blocks (~3 min) behind and
  answered `/quote/swap` with `{"code":3,"message":"refusing quote on node with stale state: invalid request"}`.
  The SDK only moves to the next host on `HostUnavailable` (network error / no body), so this body became the
  user-visible refusal for every pair. Liquify now quotes first. SDK task: treat a node-side "stale state" (and
  5xx) answer as host-unavailable and try the next node (still open in 0.4.0, whose lag rule covers only confirming
  nodes).
- **Standard mode (web, 2026-11-12; ARCHITECTURE D30)**: cp0x's API forwards `GET thorchain/inbound_addresses`
  to `https://thorchain.ibs.team/api`, a third operator in sync with Liquify that browsers can't reach
  (its preflight answers 403). While `health.thornode` is true the page puts `<API>/api/v2/swap-web/venue/thornode`
  FIRST in `confirmNodeUrl`; `nodeUrl` stays `thorNodes` unchanged (Liquify, THORWallet), direct. The SDK's confirm
  list is `[...confirmNodeUrl, ...nodeUrl, ...HOSTS]` minus the quoting host, and only `nodeUrl` hosts quote, so the
  quote always comes from a node the browser reaches directly and the proxy can never both quote and confirm a vault.
  The pass-through sends no key (answers are micro-cached, identical for everyone); its `x-client-id` is allowed in
  the proxy's CORS. Any non-2xx or network error there is `HostUnavailable` to the SDK (`nodeRead`), so the next
  confirm host answers; a health without `thornode` leaves the slot unused (no request at all).
  **thorchain 0.4.0 asks this pass-through for `thorchain/lastblock` on every confirmation, and for
  `thorchain/vaults/asgard` and `thorchain/mimir` when the inbound vault rotated** (`THORNODE_CONFIRM_PATHS`, each
  GET with no query, like `inbound_addresses`). On 2026-11-13 cp0x-api allowed only `inbound_addresses` (the other
  three answered 404 "path not allowed"); its update ships separately. Until it does, the first confirmation's
  `lastblock` gets the proxy's 404, which stops the THORNode slot for the page (`clientSlotFailed`), and the SDK
  moves to its next confirm host (THORWallet or Liquify, direct): THORChain still quotes, without ibs.team, and the
  Settings line stops naming "THORChain's vault check through cp0x". One confirmation now costs the pass-through 2
  calls (4 after a rotation): the proxy's per-IP and daily THORNode limits need that headroom.
- **Fragility**:
  - Liquify was hanging (502 after 65 s) for part of the probe. Before 0.4.0 the confirm read had an 8 s timeout,
    and the router's 8 s auction cap usually ended the quote first (Liquify-first: 10.3 s). 0.4.0 gives each
    confirming node 2.5 s within one 8 s budget, and aborts with the router's signal.
  - Later both nodes answered `{"code":3,"message":"refusing quote on node with stale state"}`, a
    THORChain-side condition.
  - Optional hardening: a third operator behind your own HTTPS proxy, passed as `thorConfirmNodes` (trust
    decision).
- **Routes**: cross-chain only. Source = EVM 1, 8453, 56, 43114 (router `depositWithExpiry`); Tron only with
  `tronSource`. Destinations: those plus BTC, Tron, Solana, XRP, LTC, DOGE, BCH, ATOM. The amount must fit 8
  decimals and clear the dust/recommended minimum.
- **Execution**: router calldata to a pinned router (`THORCHAIN_ROUTERS`: ETH `0xD37B…7146`, BSC `0xb30e…f56b`,
  AVAX/BASE `0x00dc…f1d4`). The dry quote carries `txRequest` with the router (probe: `tx=0x00dc6100`). A BTC
  destination needs a user-entered BTC address. `preflightDeposit` re-checks the vault on two nodes right
  before signing.
- **Stores**: none. Tracking: `/thorchain/tx/status/{hash}`.
- **Rate limit**: not published. 429/403/5xx is treated as host-unavailable, so the next host is tried.

### 4.4 Circle CCTP V2, `cctp`

`AWK/protocol-swap2-cctp/dist/provider.d.ts:3-24`

```ts
type CctpMode = "auto" | "fast" | "standard";
interface CctpProviderConfig {
  enabled?: boolean;
  apiUrl?: string;                                   // default https://iris-api.circle.com
  mode?: CctpMode;                                   // default auto
  feeBufferPct?: number;                             // default 10
  rpcUrls?: Readonly<Record<string, string>>;        // CAIP-2 → ONE url
  quoteTtlMs?: number;                               // default 60 s
  fetchImpl?: typeof fetch;
}
declare function cctpProvider(config?: CctpProviderConfig): CrossChainProvider;
```

- **Browser options**: `{apiUrl: cfg.api.cctp, mode: cfg.cctp.mode, rpcUrls: firstUrlFor(Object.keys(CCTP_DOMAINS))}`.
  - The server passes only its keyed RPCs (6 chains, `SRV:193-205`). The browser passes the first public URL for
    **all 19 domains**: 1, 43114, 10, 42161, 8453, 137, 130, 59144, 146, 480, 143, 1329, 999, 57073, 98866, 9745,
    196, 5042, 2818.
  - With an RPC, the provider preflights the TokenMessengerV2 → MessageTransmitterV2 binding and
    `getMinFeeAmount`, and detects the mint (`usedNonces`).
  - One URL means no failover inside the SDK (a single viem `http` per chain). The web app passes
    `fetchImpl: rpcFailoverFetch(...)` (`src/swap/rpcFailover.ts`, 2026-11-12): a call that fails on that URL (non-2xx
    or a network error) is sent to the rest of the chain's runtime list; Circle's API calls pass through. So
    Standard's proxy RPC or Custom's own RPC at the head of a list falls back like every other client (ARCHITECTURE D30).
- **Routes**: cross-chain EVM USDC ↔ USDC (native Circle USDC only). `supportsRoute` checks the `"USDC"` symbol
  or the domain's USDC address.
- **Execution**: `depositForBurn` on TokenMessengerV2 `0x28b5…cf5d`, which is both `to` and `approvalAddress`
  in the dry quote (probe). **Two-phase**: `trackIntent` → `action-required` with `claim: {chain, ready}`, then
  `claimSwap2` sends `receiveMessage` from a destination-chain account. `claimTargets` comes from the provider
  itself (MessageTransmitterV2).
- **Stores**: none. Closing the tab only delays the claim; the attestation stays at Circle. An expired Fast
  message is re-attested by the provider on the next `buildClaim`.
- **CORS**: OK.
- **Rate limit**: Circle documents 35 req/s for Iris, with a 5-minute block if exceeded. Not an issue at UI
  polling rates.

### 4.5 USDT0 (LayerZero OFT), `usdt0`

`AWK/protocol-swap2-usdt0/dist/provider.d.ts:8-35` (0.5.0)

```ts
interface Usdt0ProviderConfig {
  enabled?: boolean;
  rpcUrls?: Readonly<Record<string, string | readonly string[]>>;  // REQUIRED for every chain quoted FROM
  scanUrl?: string;                                                // default https://scan.layerzero-api.com
  tonApiUrl?: string;                                              // 0.5.0, default https://tonapi.io (TON payouts)
  quoteTtlMs?: number;                                             // default 60 s
  meshDestinations?: readonly ("tron" | "ton")[];                  // 0.5.0, default ["ton"]; Tron opt-in
  fetchImpl?: typeof fetch;
}
declare function usdt0Provider(config?: Usdt0ProviderConfig): CrossChainProvider;
```

- **Browser options**: `{rpcUrls: evmRpcByCaip2(cfg.evmRpc), scanUrl: cfg.api.layerZeroScan, tonApiUrl: cfg.tonApiUrl,
  meshDestinations: ["ton", "tron"]}`. The RPC table is the full one, as the server passes it (`SRV:324-327`); viem
  `fallback(http…)` is used when there are several URLs. The mesh destinations are named rather than left to the
  SDK default, and TON payouts are checked on the operator's TonAPI (the one Omniston uses), not the SDK's default.
- **Routes**: cross-chain USDT/USDT0 among 16 chains: 1 (adapter; approve the adapter), 42161, 10, 137, 999,
  57073, 80094, 130, 1329, 9745, 143, 4326, 196, 5000, 2818, 14. `supportsRoute` is false for a source chain
  with no RPC.
  - **Legacy Mesh (0.5.0)**: USDT from Ethereum (USDT `0xdAC1…`, mesh OFT `0x1F74…dFB0`), Arbitrum (USDT0, OFT
    `0x7765…9B92`) and Celo (`0x4806…`, not in the catalog, so the pickers can't reach it) into TON USDT
    (`EQCxE6…_sDs`, on by default and named here) or Tron USDT (opt-in in the SDK, **on** here: its LayerZero fee, ≈ 0.0053 ETH
    plus 25 % headroom on 2026-11-12, is above the engine's 0.005 ETH native-fee cap, so `execute.ts`
    `nativeFeeCeiling` raises the cap to 0.01 ETH for that route alone, from Ethereum or Arbitrum; owner's decision
    2026-11-13, engine.md §4.7). Tron and TON are destinations only. Fee line "USDT0 Legacy Mesh fee"
    (≈ 3 bps), ETA 300 s from Ethereum / 90 s from Arbitrum, intent id `usdt0-mesh:<srcEid>:<dstEid>`; the amount is
    capped by the pool's credit toward the destination ("exceeds the OFT maximum"). The SDK refuses testnet-flagged
    and workchain −1 TON recipients and the zero account on every chain, which the app's address check lets through
    (worded in `refusals.ts`).
  - **Dry quotes (0.5.0)**: with no recipient or no refund the module still prices with its own stand-in (the EVM
    sample, or the zero account into Tron/TON) but returns a **price-only** quote: `providerData.placeholder`,
    `providerData.nativeFee`, no `txRequest`; `buildDeposit` and `preflightDeposit` refuse it (`chunk-7FQDRYVI.js:89`,
    `:556`, `:563`, `:586`). So a preview row shows no approval tag and the generic gas estimate; live quotes are
    unchanged.
- **Execution**: OFT `send` with `value = nativeFee` (+25 % headroom, declared as `txRequest.nativeFee`).
  - Approval only on Ethereum for the OFT path (probe: `approvalAddress = 0x6C96…1dee` = adapter); a mesh send
    approves its mesh OFT on each source (`usdt0Pins` lists them, so the gate follows).
  - Tracking a mesh send: LayerZero Scan; a TON delivery completes only once TonAPI shows the jetton paid to the
    recipient (`GET {tonApiUrl}/v2/events/{hash}`).
  - `preflightDeposit` re-prices the fee.
  - `buildClaim` exists only for a reverted delivery (`lzReceive` retry).
- **Stores**: none. Tracking: LayerZero Scan by source tx.
- **CORS**: OK. **Rate limit**: none seen.

### 4.6 Chainflip (vault swaps), `chainflip`

`AWK/protocol-swap2-chainflip/dist/provider.d.ts:3-10`

```ts
interface ChainflipProviderConfig {
  enabled?: boolean;
  apiUrl?: string;                                // default https://chainflip-swap.chainflip.io
  maxOraclePriceSlippageBps?: number | null;      // default: the quote's recommendation; null = off
}
declare function chainflipProvider(config?: ChainflipProviderConfig): CrossChainProvider;
```

- **Browser options**: `{apiUrl: cfg.api.chainflip}`. Broker commission is 0 and enforced by the decoder.
- **Routes**: cross-chain only.
  - Sources: Ethereum (ETH, USDC, USDT, WBTC) and Arbitrum (ETH, USDC, USDT). Tron (TRX, USDT) is supported by
    the module but needs a Tron wallet, so it is later.
  - Destinations: Ethereum, Arbitrum, Solana (SOL, USDC, USDT), Tron (TRX, USDT), BTC.
  - Minimums: $20 for Ethereum stables, $10 for Arbitrum/Solana/Tron stables, 40 000 sat, 30 TRX.
- **Execution**: `xSwapNative` / `xSwapToken` on `CF_VAULTS` (ETH `0xF5e1…2Bcc`, ARB `0x7900…8920`).
  - **A dry quote carries no `txRequest`** (`chunk-XUMGQNH4.js:142`; probe: `to=undefined`), so it names no
    approval spender. A review screen that shows the spender before the live quote must use
    `CF_VAULTS[sourceChain]` (§7, `orderSpender`). This is the fix for `engine.md` risk 10.
- **Stores**: none. Tracking: `GET /v2/swaps/{sourceTxHash}`.
- **CORS**: OK (`allow-headers: *`). **Rate limit**: 429 is possible; the provider retries once.

### 4.7 Relay, `relay`

`AWK/protocol-swap2-relay/dist/provider.d.ts:3-29`

```ts
interface RelayProviderConfig {
  enabled?: boolean;
  baseUrl?: string;                    // default https://api.relay.link (untrusted either way)
  apiKey?: string;                     // x-api-key — never in an app
  quoteTtlMs?: number;                 // default 60 s, at most 5 min
  fetchImpl?: typeof fetch;
  clearedStore?: RelayClearedStore;
}
interface RelayClearedStore {
  has(orderId: string): boolean | Promise<boolean>;
  add(orderId: string, expiresAtMs: number): void | Promise<void>;
}
declare function relayProvider(config?: RelayProviderConfig): CrossChainProvider;
```

- **Browser options**: `{baseUrl: cfg.api.relay, clearedStore: stores.relayCleared}`. No key of cp0x's; keyless quotes
  work (probe). Custom mode adds the viewer's `apiKey` (`x-api-key`; the SDK refuses anything but 1-256 visible ASCII,
  so Settings applies the same rule; Relay's preflight allows `x-api-key`, probe 2026-11-12). Standard mode adds
  `fetchImpl`: the proxy routing of ARCHITECTURE D30 (the other venues get it through the wrapped global fetch).
- **Routes**: cross-chain EVM ↔ EVM over the 29 pinned `RELAY_CHAINS`: 1, 10, 56, 100, 130, 137, 143, 146, 196,
  324, 480, 999, 2818, 4326, 4663, 5000, 5042, 8453, 9745, 42161, 42220, 43114, 57073, 59144, 80094, 98866,
  99901, 534352, 747474.
  - `supportsRoute` is chain-only (`chunk-BCY6ZEAE.js:163`). Unsupported inventory (ARB, POL, MNT…) is refused
    at quote time (`tx-target`).
- **Execution**: `depositNative` / `depositErc20` on RelayDepository `0x4cd0…bc31` (Mantle and Linea:
  `0x5991…ecca`). The dry quote names the depository as `approvalAddress` (probe).
  - A quote with placeholder addresses (no dest/refund given) is **never** built (`placeholder: "1"`), so always
    pass the real addresses.
- **Stores**: `clearedStore`.
  - `preflightDeposit` (`chunk-BCY6ZEAE.js:305-316`) calls `has(id)`, then the in-realm record, then
    `add(id, order.output.deadline*1000)`. That deadline is quote time + 7 days. Either call throwing refuses the
    signature.
  - The SDK also keeps a per-JS-realm in-memory record (`chunk-C3I2XYSW.js:25-38`, TTL = (600 + 2·300) s).
  - The durable store adds "survives a reload". This replaces mobile's `relayDurablePins`
    (`M/swap/pins.ts:102-147`) + `relayClearedStore` (`M/swap/relayCleared.ts:1-33`), which wrapped a *remote*
    stub's pins. Locally the provider takes the store directly. Same semantics: ids are lowercased and kept until
    `expiresAtMs`; the record is fail-closed.
  - **"Issued quote" memory is per instance**: `preflightDeposit` checks "the request this instance issued". A
    reload between quote and sign forces a re-quote; `swap2()` re-quotes live anyway.
- **Tracking**: `GET /intents/status/v3?requestId=`, display only.
- **CORS**: OK. **Rate limit**: no headers; treat it as about 1 req/s per user.

### 4.8 Uniswap v3, `uniswap`

`AWK/protocol-swap2-uniswap/dist/provider.d.ts:4-23`

```ts
interface UniswapProviderConfig {
  enabled?: boolean;
  rpcUrls: Readonly<Record<number, readonly string[]>>;   // REQUIRED; a chain without one is not offered
  defaultSlippageBps?: number;                             // default 50
  quoteTtlMs?: number;                                     // default 5 min
  deadlineSeconds?: number;                                // default 600
  deployments?: Readonly<Record<number, UniswapDeployment>>;
  refundNativeInput?: boolean;                             // default false (server: off)
}
declare function uniswapProvider(config: UniswapProviderConfig): CrossChainProvider;
```

- **Browser options**: `{rpcUrls: cfg.evmRpc}`. `refundNativeInput` stays off (`SRV:359-362`). Turning it on is
  safe locally (no ≥0.4.2 client gate), but keep parity.
- **Routes**: same-chain on the 16 `UNISWAP_V3` chains: 1, 10, 56, 130, 137, 143, 196, 324, 480, 4663, 8453,
  42161, 42220, 43114, 57073, 59144. `supportsRoute` is chain-only, so any token pair is tried.
- **RPC load**: QuoterV2 over 4 fee tiers and two-hop paths via `HOP_SYMBOLS`, as JSON-RPC **batches** of up to
  10 calls (`RPC_BATCH_MAX = 10`). All 16 primary RPCs accepted a 10-call batch (`batch.sh`). The deployment is
  verified on-chain once per chain.
- **Execution**: SwapRouter02 `multicall(deadline, …)`; the router is both `to` and `approvalAddress` (probe Base:
  `0x2626…e481`). `preflightDeposit` re-quotes.
- **Stores**: none. Tracking is by receipt over `rpcUrls`.

### 4.9 Wrap / unwrap, `wrap`

`AWK/protocol-swap2-wrap/dist/provider.d.ts:9-29`

```ts
declare const WRAPPED_NATIVE: Readonly<Record<number, {address: `0x${string}`; symbol: string}>>;
interface WrapProviderConfig {
  enabled?: boolean;
  rpcUrls: Readonly<Record<number, readonly string[]>>;   // on-chain token check + receipt tracking
  wrapped?: Readonly<Record<number, {address: `0x${string}`; symbol: string}>>;
}
declare function wrapProvider(config: WrapProviderConfig): CrossChainProvider;
```

- **Browser options**: `{rpcUrls: cfg.evmRpc}`, wrapped in `narrowRoute(…, isWrapPair)` (§6.1).
  - `supportsRoute` is chain-only (`chunk-GC6XODOS.js:106-108`). Without narrowing, every same-chain pair
    collects a "wrap: only ETH ↔ WETH" rejection. That refusal involves no I/O, but it clutters
    `RouteSet.rejections`.
  - Mobile narrowed it the same way (`M/swap/providers.ts:244-248`).
- **Routes**: same-chain native ↔ wrapped on 28 chains: 1, 10, 14, 56, 100, 130, 137, 143, 146, 196, 324, 480, 999,
  1329, 2818, 4326, 5000, 8453, 9745, 42161, 43114, 57073, 59144, 80094, 98866, 99901, 534352, 747474. The
  recipient must be the sender.
- **Execution**: `deposit()` (value) or `withdraw(amount)` on the wrapper; no approval.
- **Stores**: none.

### 4.10 Jupiter, `jupiter`

`AWK/protocol-swap2-jupiter/dist/provider.d.ts:3-18`

```ts
interface JupiterProviderConfig {
  enabled?: boolean;
  apiUrl?: string;                     // default https://api.jup.ag/swap/v2
  apiKey?: string;                     // x-api-key; keyless works at 0.5 RPS
  rpcUrls?: readonly string[];         // CU simulation + status; without: 1.4M CU and status stays pending
  maxComputeUnitPrice?: bigint;        // default 2_000_000 µlamports/CU
  computeUnitPricePercentile?: string;
  defaultSlippageBps?: number;         // default 50
}
declare function jupiterProvider(config?: JupiterProviderConfig): CrossChainProvider;
```

- **Browser options**: `withQuoteGap(jupiterProvider({apiUrl: cfg.api.jupiter, rpcUrls: cfg.solanaRpc}),
  cfg.pacing.jupiterGapMs)`.
  - No key of cp0x's (Standard mode: cp0x's proxy adds it while Jupiter is "keyed"). Custom mode passes the viewer's
    `apiKey`, sent as `x-api-key`; it makes every `/build` a preflighted request, and the preflight allows
    `x-api-key` (probe 2026-11-12; an earlier probe without the request header saw an empty `allow-headers`).
  - Platform fee 0 is enforced by the module's decoder.
- **Routes**: same-chain `solana:mainnet` only, and the recipient must be the taker.
- **Execution**: `txRequest.serializedTx` (v0). The account must implement `sendSerializedTransaction`
  (simulate, prove the balance changes, sign, broadcast). See `engine.md` §6.2: wallet-solana's
  `serializedGuardFromExecution`.
- **Quote lifetime**: 30 s, because of the blockhash.
- **Stores**: none. Tracking: `getSignatureStatuses` on `rpcUrls`. `solana-rpc.publicnode.com` allows
  `simulateTransaction` and `getSignatureStatuses` (`catalog.md`).
- **CORS**: OK (origin echoed). **Rate limit**: 0.5 RPS keyless per IP. The provider has no `fetchImpl`, so
  pace `getQuote`. Its RPC loop moves to the next URL when a call throws or the body carries `error` (every answer of
  cp0x's proxy does), so a proxy RPC first in `rpcUrls` falls back.

### 4.11 Symbiosis (default on since 2026-11-12), `symbiosis`

`AWK/protocol-swap2-symbiosis/dist/provider.d.ts:3-46`

```ts
interface SymbiosisProviderConfig {
  enabled?: boolean;
  apiUrl?: string;                     // default https://api.symbiosis.finance/crosschain
  quoteTtlMs?: number;                 // default 60 000, max 300 000
  slippageBps?: number;                // default: swap2-core suggestSlippage
  tronSource?: boolean;                // default off
  btcSource?: boolean;                 // default off
  boundSourceOnly?: boolean;           // default off
  fallbackReceiver?: string;           // required only for Tron ↔ TON
  partnerAddress?: string;
  partnerId?: string;                  // X-Partner-Id
  apiKey?: string;                     // X-Api-Key — never in an app
  tronFeeLimitCap?: bigint | number | string;
  fetchImpl?: typeof fetch;
}
declare function symbiosisProvider(config?: SymbiosisProviderConfig): CrossChainProvider;
```

- **Browser options**: `{apiUrl: cfg.api.symbiosis, tronSource: false, btcSource: false, fetchImpl:
  paced(cfg.pacing.symbiosisGapMs, extras.fetchImpl ?? ((i, init) => fetch(i, init)))}`. This matches
  `SRV:352-356`, plus pacing. No `partnerId` / `partnerAddress`, so no fee. Custom mode adds the viewer's `apiKey`
  (a Symbiosis partner key, `X-Api-Key`; the SDK refuses anything but 1-256 printable ASCII, so Settings applies the
  same rule).
- **Standard mode (2026-11-12, ARCHITECTURE D30)**: `api.symbiosis` is the proxy slot `<API>/api/v2/swap-web/venue/
  symbiosis` and `fetchImpl` hands each paced request to the proxy routing (Standard's `standardFetch`). While
  `/health` says `"symbiosis": "keyed"`, `GET /v1/swap-limits`, `POST /v2/quote` and the status calls `trackIntent`
  makes after a swap (`GET /v2/tx/<chainId>/<hash>`, `GET /v1/stucked/<EVM address>`) go to cp0x's proxy, which
  forwards them to `https://api.symbiosis.finance/crosschain/<same path>` with cp0x's partner key added server-side
  (no key in the browser); anonymous, or before/without a health answer, they go to the public base. The proxy
  forwards exactly those shapes, with no query (cp0x-api `swapWeb/venues.ts`), and `PROXIED_PATHS` in
  `src/config/standard.ts` matches them the same way: any other shape goes straight to Symbiosis and never stops the
  slot. Fallback as for LI.FI: a failure at the proxy or an upstream 401/403/429 is retried once at the public base
  and Symbiosis stays direct (until 00:00 UTC after the proxy's daily limit, else for the 429's `Retry-After`, else
  for the page). Pacing: the 1.1 s pacer stays in every mode and wraps the routing (cp0x's key allows 10 req/s,
  `ratelimit-policy: 10;w=1`, its own bucket apart from the IP's, shared by every Standard viewer). It spaces only
  starts, so a retry sent when a slow proxy failure lands could fall just before the next call's turn; the routing
  therefore sends every direct Symbiosis call through a second 1.1 s pacer of its own (`ProxyFetchDeps.direct`, built
  in `startConnection`), and the direct path stays at 1 req/s per page.
- **Rate limit, measured**:
  - `/v2/quote` and `/v1/swap` return `ratelimit-policy: 1;w=1`; `/v1/swap-limits` returns `40;w=1`.
  - Unpaced, the provider's first quote (limits fetch, then `/v2/quote` immediately) got "The limit of requests
    has been exceeded…" twice in a row.
  - Paced at 1100 ms, it got through to the provider's own verifier. On that pair the verifier refused the route
    ("the destination swap gets the released amount written at 2436, not into its amount"), which is expected
    fail-closed behaviour.
  - With up to 4 venue-avoidance attempts 1.1 s apart, Symbiosis often misses the router's 8 s window.
  - One `paced` wrapper per page (one provider instance, D2): live rounds, preview rounds and the review's re-quote
    queue in the same line, so a preview burst (5 rounds) never goes past 1 request per 1.1 s; a superseded round's
    queued call reaches `fetch` with its aborted signal and sends nothing.
  - Nothing paces across tabs (or users behind one IP). Its 429 reads as a rate limit (`RATE_LIMITED`): the SDK says
    "Symbiosis API → 429", or `Symbiosis: <the body's message>` such as the one above (`chunk-K3EPNDVO.js:176-183`), so
    the engine's venue back-off (ARCHITECTURE D29) stops asking it, 60 s doubling per repeat, in every tab that saw it.
  - Live, 2026-11-12 (Node, dry, blank destination, no refund): 100 USDT Ethereum → 95.95 USDT Tron, eta 64 s, fee
    $4; `swap-limits` then `/v2/quote` 1101 ms apart, `from` = the EVM placeholder, `to` = `TVjpch…Ftnb`.
- **Routes**: cross-chain EVM (1, 56, 43114, 137, 42161, 10, 8453) ↔ EVM, EVM ↔ Tron and EVM ↔ TON. A TON source
  (jettons only) is quoted, but it is a jetton transfer a TON wallet signs: `executionOf` reads Symbiosis as signed,
  so a QR payer gets "Needs a wallet that signs on TON" (no TON wallet here yet). No same-chain.
- **Preview** (§4.16): a dry quote fills its own placeholders for a blank address, sender included
  (`chunk-K3EPNDVO.js:257-261`): the EVM sample, `EQCD39…qB2N` for TON, `TVjpch…Ftnb` (the EVM sample in Tron form)
  for Tron (`:33-35/213`); `scrubSamples` covers all three.
- **Execution**: `metaRoute` on the pinned MetaRouterGateway (approve the same gateway), or a TON jetton
  transfer body. `preflightDeposit` re-decodes everything.
  - `providerData.serviceReverts = "1"`: a stuck swap is reverted by Symbiosis' service, not by the user's key.
    Show this in the review.
- **Stores**: none.
- **CORS**: OK. The preflight (probe 2026-11-12: `OPTIONS /v2/quote`, `Access-Control-Request-Headers:
  content-type,x-api-key`) answers 204 with `access-control-allow-origin: *` and allows `content-type,x-api-key`, so a
  viewer's own key works from the browser (Custom).

### 4.12 Balancer v2 (default on since 2026-11-12), `balancer`

`AWK/protocol-swap2-balancer/dist/provider.d.ts:4-22`

```ts
declare const BALANCER_V2_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
interface BalancerProviderConfig {
  enabled?: boolean;
  rpcUrls: Readonly<Record<number, readonly string[]>>;   // on-chain pricing (queryBatchSwap) + receipts
  apiUrl?: string;                                         // SOR (discovery only), default https://api-v3.balancer.fi/
  defaultSlippageBps?: number;
  quoteTtlMs?: number;
  deadlineSeconds?: number;
}
declare function balancerProvider(config: BalancerProviderConfig): CrossChainProvider;
```

- **Browser options**: `{rpcUrls: cfg.evmRpc, apiUrl: cfg.api.balancer}`, the same as `SRV:370-373`.
- **Routes**: same-chain on 1, 10, 100, 137, 146, 8453, 9745, 42161, 43114.
- **Execution**: Vault `batchSwap`; the Vault is both `to` and `approvalAddress` (probe). `preflightDeposit`
  re-prices the batch.
- **Stores**: none.
- **CORS**: OK (origin echoed).
- **Probe**: Base 0.001 ETH → 2.0607 USDC. Live, 2026-11-12 (Node, dry): Ethereum 0.1 WETH → 1 719.6 BAL with the
  EVM sample as recipient (one hop, 1.5 s); a blank recipient is refused.
- **Cost**: it overlaps Uniswap and LI.FI same-chain, and adds SOR + RPC load to every same-chain quote (asked right
  after Curve).
- **Preview** (§4.16): refuses a blank recipient (`chunk-XFRLZ25H.js:125`), so it gets the EVM sample; it prices with
  the Vault's `queryBatchSwap` `eth_call` (`:86-88`), sender = refund or else the recipient (`:176-178`), which moves
  nothing.

### 4.13 Omniston (default on since 2026-11-12, lazy chunk), `omniston`

`AWK/protocol-swap2-omniston/dist/provider-BQzNkVvW.d.ts:485-686` (options) and `:208-234` (stores);
`dist/validators.d.ts:73-143`.

```ts
interface OmnistonProviderOptions {
  client?: OmnistonClientLike;                 // tests
  apiUrl?: string;                             // WS, default wss://omni-ws.ston.fi
  secretStore?: HtlcSecretStore;               // default in-memory
  quoteStore?: OmnistonQuoteStore;             // default in-memory
  maxHtlcExecutions?: number;                  // 1..16 (server: 1)
  maxTonExecutionNano?: string;                // default "2000000000"
  quoteSettleMs?: number;
  enabled?: boolean;
  maxUsd?: number | string;                    // default 1000 (omniston/config)
  integratorAddress?: string;
  integratorFeePips?: number;
  trustedSettlementContracts?: Readonly<Record<string, readonly string[]>>;   // empty → provider disabled
  trustedEvmOrderProtocols?: Readonly<Record<string, readonly string[]>>;     // EVM-source orders only on chains listed
  validateTonJettonWallet?: (input: {ownerAddress: string; jettonMasterAddress: string; walletAddress: string}) => boolean | Promise<boolean>;
  validateTonSwapTarget?: (input: {address: string; protocols: readonly string[]}) => Promise<boolean> | boolean;
  validateTonSwapLeg?: (leg: TonSwapLeg) => Promise<boolean> | boolean;
  tonSwapPayloadCheck?: "report" | "enforce";
  validateTonEscrowPayload?: (input: {/* payloadBocHex, forwardPayloadBocHex, quoteId, inputUnits, … */}) => boolean | Promise<boolean>;
  validateEvmOutputPosition?: (input: {/* chain, positionAddress, factoryAddress, …, secretHash: Uint8Array */}) => boolean | Promise<boolean>;
  validateEvmInputPosition?: (input: {/* chain, positionAddress, factoryAddress, orderProtocolAddress, …  */}) => boolean | Promise<boolean>;
  validateTonOutputPosition?: (input: {/* positionAddress, protocolAddress, outputJettonMasterAddress, … */}) => boolean | Promise<boolean>;
  locateEvmDelivery?: (input: {chain: string; positionAddress: string; recipientAddress: string; tokenAddress: string; minUnits: string}) => Promise<string | null>;
  locateTonDelivery?: (input: {positionAddress: string; recipientAddress: string; jettonMasterAddress: string; minUnits: string}) => Promise<string | null>;
  closeInjectedClient?: boolean;
  trace?: (event: string, details?: Record<string, unknown>) => void;
}
interface HtlcSecretStore {
  save(quoteId: string, secretsHex: string[]): void | Promise<void>;
  load(quoteId: string): string[] | undefined | Promise<string[] | undefined>;
  clear(quoteId: string): void | Promise<void>;
}
interface OmnistonQuoteStore {
  save(quoteId: string, valueJson: string): void | Promise<void>;
  load(quoteId: string): string | undefined | Promise<string | undefined>;
  clear(quoteId: string): void | Promise<void>;
  claim?(quoteId: string, valueJson: string): boolean | Promise<boolean>;   // atomic create-if-absent
}

// /validators
declare function createOmnistonEvmOutputValidator(options?: {request?: RpcRequest; rpcUrls?: OmnistonRpcUrls; now?: () => number; onRefusal?: OmnistonEvmOutputRefusal} & OmnistonRpcQuorumOptions): (input: EvmOutputValidationInput) => Promise<boolean>;
declare function createOmnistonEvmInputValidator(options?: {request?: OmnistonRpcRequest; rpcUrls?: OmnistonRpcUrls; now?: () => number; onRefusal?: OmnistonValidatorRefusal} & OmnistonRpcQuorumOptions): (input: EvmInputValidationInput) => Promise<boolean>;
declare function createOmnistonEvmDeliveryLocator(options?: {request?: RpcRequest; rpcUrls?: OmnistonRpcUrls}): (input: {chain: string; positionAddress: string; recipientAddress: string; tokenAddress: string; minUnits: string}) => Promise<string | null>;
declare function createOmnistonTonValidators(options?: OmnistonTonValidationOptions): Required<Pick<OmnistonProviderOptions,
  "validateTonJettonWallet" | "validateTonSwapTarget" | "validateTonOutputPosition" | "validateTonSwapLeg">> & {
  validateTonEscrowPayload: (input: PayloadInput) => boolean | Promise<boolean>;
  verifyTonEscrowBuild: (input: TonEscrowBuildExpectation) => string | null;
};
declare function createOmnistonTonDeliveryLocator(options?: {fetch?: typeof fetch; tonApiUrl?: string; tonApiKey?: string; limit?: number}): (input: OmnistonTonDeliveryInput) => Promise<string | null>;
declare const AUDITED_OMNISTON_SETTLEMENT_CONTRACTS: Record<string, string[]>;
declare const AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS: Record<string, string[]>;
type OmnistonRpcUrls = Readonly<Record<string, readonly string[]>>;   // CAIP-2 → URLs, before the public fallbacks
// OmnistonTonValidationOptions: {fetch?, onRefusal?, tonApiUrl?, tonApiKey?, swapTargetInterfaces?, proxyTonMasters?,
//   escrowCodeHashes?, executionCodeHashes?, authorityKeys?, positionCodeHashes?, outputEscrowCodeHashes?,
//   trustedProtocolAddresses?, now?}   (provider-BQzNkVvW.d.ts:57-81)
```

**Browser construction.** This is `SRV:275-276` and `SRV:397-424` with the Turso stores replaced by IndexedDB
and `SRV-OMNI`'s env RPC table replaced by `cfg.evmRpc`. The full code is in §6.3.

- `trustedSettlementContracts` = `AUDITED_OMNISTON_SETTLEMENT_CONTRACTS`. `trustedEvmOrderProtocols` =
  `AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS` when `cfg.omniston.evmSource`. Neither is ever overridden from runtime
  config.
- `maxHtlcExecutions: 1`. The live TON escrow builder commits one execution hash (`SRV:404-406`).
- `maxUsd: cfg.omniston.maxUsd`. No `integratorAddress` / `integratorFeePips` (fee 0).
- `...createOmnistonTonValidators({tonApiUrl, onRefusal})`, `validateEvmOutputPosition`,
  `validateEvmInputPosition`, `locateEvmDelivery: createOmnistonEvmDeliveryLocator({rpcUrls})`,
  `locateTonDelivery: createOmnistonTonDeliveryLocator({tonApiUrl})`.
- `trace` → a bounded in-memory ring buffer + `console.debug`. It never carries secrets; expose it on the swap
  status screen ("why is this pending?").

**Do the validators run in a browser? Yes.**

- They are plain `fetch` JSON-RPC (`omnistonEvmRpcRequest`) with public fallbacks baked in: publicnode
  ETH/BSC/Base/Arb/Polygon/AVAX, `rpc.xlayer.tech`, `rpc.plasma.to`, the Robinhood RPC and
  `rpc.hyperliquid.xyz/evm`. All of them passed CORS.
- The TON side uses TonAPI REST (`tonapi.io`; CORS echoes the origin).
- Pass `rpcUrls: evmRpcByCaip2(cfg.evmRpc)`, which replaces `SRV-OMNI:24-43`. Default quorum 1 (one operator).
- Risks:
  - EVM validators run `eth_getLogs` over a lookback of up to 100 000 blocks (ARB and Robinhood; 3 000 ETH;
    20 000–40 000 elsewhere). Public RPCs may cap that range.
  - tonapi.io keyless allows about 1 RPS per IP.

**Which routes a browser can run.**

| route | wallet | status |
|---|---|---|
| EVM → EVM | approve the order protocol, sign an EIP-712 `Order`, `registerSignedOrder` | **works**: Base→Arb USDC dry quote `out=4983651`, eta 240 s |
| EVM → TON | same | was refused (`untrusted ton:-239 settlement contract EQDybO88…`, the old audited entry being rev1 `EQAbWJ3Y…`); 0.5.5 (2026-11-12) trusts the rev2 minter `EQDybO88…` instead. Not re-measured live here |
| TON → EVM, TON → TON | TON wallet (`bodyBoc`, jetton wallet) | later (TON Connect) |

The quote has no `approvalAddress`. The spender is `AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS[chain][0]` (mobile
`orderSpender`, `M/swap/providers.ts:86-101`).

**Dynamic import.** The package imports `@ton/core` statically and `@ston-fi/omniston-sdk` lazily. It pulls in
rxjs, `json-rpc-2.0`, `buffer`, `@ton/core` (~0.9 MB unminified dist) and `@ton/crypto`. Load it with
`import()` only while the flag is on, the default (§6.3). The WebSocket opens lazily on the first quote or track and
accepted a foreign `Origin` header (`ws.mjs`).

**In the app.** The stand-in is off (uncounted) until the chunk is in; a round waits up to 2 s for it (engine.ts
`LAZY_WAIT_MS`), so the page's first round asks it too. Between networks it is asked for tokens only
(`omnistonTokenLegs`): its getQuote refuses a native leg before sending anything (`chunk-DMO24BFW.js:379-382`,
`:2086-2089`) while its supportsRoute reads the chains alone. On an IPFS path gateway (`/ipfs/…`, `/ipns/…`) it is
off unless that page's operator layer turns it on: its HTLC secret would sit in storage every site there shares.

**Stores**: both are required and durable (§5).

**Preview** (§4.16): the RFQ names assets and an amount only, no address (`chunk-DMO24BFW.js:2096-2101`), and the
addresses are checked only for a live quote (`:2072-2080`, `:2093-2095`), so a dry quote needs neither a sample nor
a sender. Each dry quote is kept in the quote store with the addresses it was given (blank in a preview), 6 h.

### 4.14 Fynd, `fynd`: Standard only (rewritten 2026-11-12)

`AWK/protocol-swap2-fynd@0.3.0/dist/provider.d.ts` (chunk names below as read on 0.2.12); the SDK's requests read in `dist/chunk-6AQCGGUZ.js:71-235`.

- **Why only Standard.** The hosted API (`https://fynd-api.propellerheads.xyz`) sends no CORS headers (checked
  2026-11-12: `OPTIONS` → 404, `POST` → 401 without a key, no `Access-Control-*`), and its key is cp0x's, the
  server's `FYND_API_KEY`, shared with the cp0x wallet. A browser can't call it, and a key in the page would be
  public. So Fynd is built only on a Standard page (ARCHITECTURE D30) and asked only while `/health` says
  `venues.fynd === "keyed"`; never in Public or Custom (no Fynd key field there).
- **Browser options**: `{selfHosted, rpcUrls: cfg.evmRpc}`, no `apiKey`, no `baseUrl`, `excludeProtocols` left at
  the SDK default (`["uniswap_v4_hooks"]`). `selfHosted` maps every `FYND_CHAINS` id to
  `<API>/api/v2/swap-web/venue/fynd/<slug>`: the option for a Fynd server that needs no key from the browser, which
  is what the proxy is to the page. The SDK then posts `<url>/v1/quote` with `content-type: application/json` and no
  `authorization` (the page adds only `x-cp0x-swap-web`, D30), and standard.ts sends it to the proxy as the hosted
  API's path under its `/v1` base, `…/venue/fynd/<slug>/quote` (`proxyVenueUrl`). The proxy adds cp0x's key as the
  raw `authorization` header (the SDK sends it raw, no `Bearer`). Slugs:
  `ethereum` (1), `base` (8453), `arbitrum` (42161), `bsc` (56), `polygon` (137), `unichain` (130), `robinhood` (4663), `arc` (5042) and `elysium` (99901) since fynd 0.3.0 (the proxy's
  slugs follow, cp0x-mobile PR #93).
  No other Fynd path is called; simulation and receipts go over `rpcUrls` (Standard: the proxy RPC first).
- **Availability.** `whileLive` gates `supportsRoute` (and `supportsChain`/`supportsChainPair`) on the slot: before
  health answers, with Fynd "anonymous", or after a stop, Fynd is simply not asked (no row in the route list, not
  under "Not for this pair": `enabledVenues` reads `isLive`). `enabled()` stays the SDK's, because the engine reads
  it again once an approval is mined and would revoke the approval if it went false; nothing after the quote needs
  Fynd's API (the pre-broadcast simulation is an `eth_call`, the broadcast is the wallet's). A proxy failure or an upstream 401/403/429 stops the
  slot like any venue's (D30's durations) but is never retried direct; that round's refusal reads "Unavailable right
  now — try later".
- **Previews (app, 2026-11-13; ARCHITECTURE D7).** Asked in a preview round while the slot is live (read per round,
  after the round waits for the health answer); cp0x's daily Fynd budget (3000, shared with the cp0x wallet) caps the
  spend and D29's bucket paces each tab. Its SDK refuses a blank recipient ("recipient must be an EVM address",
  `chunk-6AQCGGUZ.js:168`), so a preview gives it the EVM sample (`FILLS_DESTINATION`); the sender is an EVM refund,
  else that recipient (`:170`), and a dry quote needs no real one: both go to the API only as the order's `sender`
  and `receiver` (`:181`), and the native-input simulation runs the quote's call from the sender with a state
  override giving it the input plus 1 ETH (`{[sender]: {balance: value + 10^18}}`, `:230-232`), so the sample needs no
  funds. A token input is not simulated at quote time. Its texts name the recipient only in "calldata pays …, not
  <receiver>" (`chunk-6WSGOEAI.js:80`, checksummed): the EVM sample, scrubbed. No check is changed; the preview is
  never reviewable (D7).
- **Routes**: same-chain, exact input, on the nine chains above. **Checks** (all the SDK's, none weakened): the
  calldata targets the pinned TychoRouterV3, is a plain `singleSwap`/`sequentialSwap`/`splitSwap`, spends exactly the
  input, pays the recipient, carries the quoted output and minimum and no client fee, and the fee breakdown adds
  up; a route through an excluded protocol is refused; a native input is simulated at quote time, every swap right
  before broadcast. The gate pins the Tycho router as call target and spender (`fyndPins`, execute/pins.ts).
- **Fynd License.** Every swap built from a Fynd quote must settle through the Tycho router for its chain, fees
  intact (the SDK only ever sends the router call Fynd encoded, and the gate allows no other target). The router may
  take its platform fee and keeps positive slippage. Whoever supplies a Fynd output (a quote, its calldata) to
  someone else to settle must give a prominent notice of those router and anti-circumvention terms (§3.4): the review
  of every Fynd route shows `fyndRouterNotice` (src/swap/venues.ts) with a link to the licence, before Confirm. A
  revenue share is owed only on revenue earned from such swaps (a fee or spread of the integrator's); cp0x Swap
  charges none.

### 4.15 Summary table

| name | same / cross | browser sources (v1) | approval in dry quote | stores | CORS | limits |
|---|---|---|---|---|---|---|
| near_intents | cross | EVM, Solana (send); BTC/ZEC/… QR | n/a (send) | – | ✓ | 1200/min |
| lifi | both (EVM → Solana via Mayan / Polymer / Chainflip only, §4.2) | EVM; Solana (serialized) | Diamond | – | ✓ | `/quote` ~75 per 2 h per IP (cooldown) |
| thorchain | cross | EVM 1, 8453, 56, 43114 | router | – | ✓ only THORWallet + Liquify | flaky nodes |
| cctp | cross (2-phase) | EVM USDC (19) | TokenMessengerV2 | – | ✓ | 35/s |
| usdt0 | cross | EVM USDT0 (16); Legacy Mesh ETH/ARB → TON, Tron | ETH adapter; mesh OFT on 1 / 42161 (/ 42220) | – | ✓ | – |
| chainflip | cross | ETH, ARB | **none (dry)** → `CF_VAULTS` | – | ✓ | 429, retries once |
| relay | cross | EVM (29) | depository | **clearedStore** | ✓ | ~1/s |
| uniswap | same | EVM (16) | SwapRouter02 | – | RPC ✓ | RPC batches |
| curve | same | EVM (8) | Router NG | – | RPC ✓ | RPC batches ≤ 10 |
| fynd† | same | EVM (7) | TychoRouterV3 | – | ✗ (proxy only) | cp0x's key |
| zeroex† | same | EVM (7), Permit2 | **none (price)** → Permit2 (`orderSpender`) | – | proxy only (key) | cp0x's key |
| across† | cross (same asset) | EVM (17 pinned) | SpokePool | – | proxy only (V5 key); `/suggested-fees` ✓ `*` | cp0x's key |
| wrap | same | EVM (28) | none | – | RPC ✓ | – |
| jupiter | same | Solana (serialized) | n/a | – | ✓ | **0.5 RPS** |
| symbiosis* | cross | EVM (7) | gateway | – | ✓ | **1 req/s** |
| balancer* | same | EVM (9) | Vault | – | ✓ | – |
| omniston* | EVM↔EVM (EVM→TON blocked) | EVM (typed order) | **none** → order protocol | **quote + secret** | ✓ (WS) | tonapi ~1 RPS |

\* default on since 2026-11-12 (a "stage 2" behind flags before). † Standard mode only (§4.14, §4.18, §4.19).

### 4.16 Preview addressing per venue (web, 2026-11-12; ARCHITECTURE D7)

A preview round prices before the user's addresses exist. The router gets the real addresses or a blank
`destAddress` and NO `refundAddress` key; per venue, the engine's delegate either skips the venue (a refusal, nothing
sent) or fills a blank destination with the destination family's sample. Each row was read in the installed dists.
LI.FI, Fynd, 0x and Across are asked only while cp0x's proxy carries them with cp0x's key (2026-11-13, 0x and Across
2026-11-15; `KEYED_PREVIEW_VENUES`, decided per round); otherwise LI.FI waits for the live quote ("Quoted after you
connect", category `deferred`) and Fynd, 0x and Across, asked by no round while their slot is off (§4.14, §4.18,
§4.19), are absent from the list.

| venue | blank `destAddress` in a dry quote | preview |
|---|---|---|
| uniswap | refuses "recipient must be an EVM address" (`chunk-6ZGWUPLL.js:145`) | fill: EVM sample |
| curve | refuses the same (`chunk-NW2OLRIK.js:789`); the sample sits only in calldata, never sent (quotes are `get_dy`) | fill: EVM sample |
| balancer | refuses the same (`chunk-XFRLZ25H.js:125`); prices with `queryBatchSwap` (`eth_call`, moves nothing), sender = refund or else the recipient (`:176-178`) | fill: EVM sample |
| wrap | quotes; compares refund with destination only when a refund is given (`chunk-GC6XODOS.js:130`) | blank; sits out on "Send to another address" (pays the signer only) |
| usdt0 | prices with its own stand-in (the EVM sample, or the zero account into Tron/TON: `chunk-7FQDRYVI.js:494`, `:285`) and returns a price-only quote, no `txRequest` (`:89`, `:556`) | blank — never filled (its stand-in is the point; the TON sample is the zero account it refuses) |
| cctp | fills its own EVM placeholder (`chunk-UPA4KJKX.js:151`) | blank |
| thorchain | sends `destination=""`, gets no memo, refuses "incomplete quote" (`chunk-EIAXGWNG.js:725/781`) | fill: destination family's sample |
| chainflip | `destAddressBytes` throws on a blank Solana destination (`chunk-SJ6UVIVY.js:119-128`) | fill: destination family's sample |
| near_intents | passes `recipient` as given (`chunk-4DBCMQCI.js:198`); refund = `refundAddress ?? its placeholder` (`:182`) | fill: destination family's sample; refund absent |
| relay | `placeholder = dry && (!destAddress \|\| !refundAddress)`, flagged, never issued (`chunk-BCY6ZEAE.js:170/276/288/306`) | blank — NEVER filled (a value would bypass that flag) |
| jupiter | taker = `refundAddress \|\| destAddress`, else its dry taker (`chunk-4V65GQY2.js:212-217`) | blank; sits out on "Send to another address" (pays the signer only) |
| lifi | `fromAddress = refund \|\| its own placeholder` (EVM = the EVM sample, Solana `HAgk…3DKpqk`, `chunk-G26GE46T.js:688-689/961`), `toAddress = dest \|\| dryRecipient` = its Solana placeholder for EVM → Solana, else `fromAddress` (`:789/962`); priced for a placeholder → price-only, no `txRequest` (`:790-793/1182`) | only through cp0x's keyed proxy (§4.2); blank where both sides are one family and for EVM → Solana, fill: EVM sample for Solana → EVM; its Solana placeholder scrubbed |
| fynd | refuses "recipient must be an EVM address" (`chunk-6AQCGGUZ.js:168`); sender = EVM refund, else the recipient (`:170`); native input simulated with a balance state override (`:230-232`) | only through cp0x's keyed proxy (§4.14); fill: EVM sample (recipient and sender) |
| symbiosis | dry: fills its own placeholders for both sides (`chunk-K3EPNDVO.js:257-261`): the EVM sample, `EQCD39…qB2N` (TON), `TVjpch…Ftnb` (Tron, `:33-35/213`); never needs a sender | blank; all three scrubbed; its one pacer keeps 1 req/s through a burst |
| omniston | the RFQ carries no address (`chunk-DMO24BFW.js:2096-2101`); addresses checked only when `dry === false` (`:2072-2080`, `:2093-2095`) | blank |
| zeroex | a dry quote's `taker` is the refund, else the recipient, only when one is an EVM address, else none: `/swap/permit2/price` without a taker (protocol-swap2-0x 0.1.1 `provider.ts` getQuote, `dist/chunk-AOJSV3QG.js:211-214`) | blank; only through cp0x's keyed proxy (§4.18) |
| across | depositor = `sender`, else the refund, else its placeholder; recipient = `destAddress`, else its placeholder (`ACROSS_PLACEHOLDER` = the EVM sample, `verify.ts` `acrossRequestOf`); a quote priced for it is never built or signed (`provider.ts` `requestOf`) | blank; only through cp0x's keyed proxy (§4.19); the placeholder scrubbed as the EVM sample |

Samples (`PREVIEW_PLACEHOLDER`, copied from near-intents `chunk-4DBCMQCI.js:46-60`; each passes the catalog's
`isAddressFor`): EVM `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`, Bitcoin `bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq`,
Solana `1nc1nerator11111111111111111111111111111111`, TON `UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ`, Tron
`TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9`, Zcash `t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua`. NEAR's `near` is not an address the
app accepts, so a pair with a NEAR side gets no preview. A real recipient or refund the user has is always passed
as is. SDK drift: blank-address handling is per provider and undocumented, so a version bump can silently drop a
venue from previews — re-read this table on every AWK bump.

### 4.17 Curve, `curve` (2026-11-12)

`AWK/protocol-swap2-curve@0.1.6/dist/provider.d.ts`: `{rpcUrls: Record<number, readonly string[]>, defaultSlippageBps?,
quoteTtlMs?, onWarning?}`.

- **Browser options**: `{rpcUrls: cfg.evmRpc}`, like Uniswap: keyless, no API, the same table in every mode (Custom:
  the viewer's RPCs first; Standard: the proxy's `/rpc/<chain>` first). MVP, default on, asked right after Uniswap.
- **Routes**: same-chain, over a pool allowlist the package pins (code hash, coins, TVL, age), one or two pools; the
  Router NG's `get_dy` for up to 30 candidates in JSON-RPC batches of at most 10, plus a 1/1000 probe for the price
  impact. Offered on Ethereum, Arbitrum, Base, OP Mainnet, Gnosis, Monad, Plasma and X Layer (a chain needs a pinned
  router, allowlisted pools and an RPC). Before first use per chain it checks the router's code hash and `version()`.
- **Execution**: the explicit-receiver `exchange` on the pinned router (`to` and the exact `approvalAddress`), a
  `min_dy` from the slippage (never 0), no gas limit (the wallet estimates); right before broadcast the call, the
  pools' code and coins and a fresh `get_dy` ≥ the minimum are checked again. The gate pins the router (`curvePins`).
- **RPC methods**: `eth_call`, `eth_getCode`, `eth_getTransactionReceipt`; the wallet's `eth_estimateGas`. A batch an
  endpoint answers in part goes to the next URL; when none answers, "no RPC answered on chain N" → "No RPC answered —
  tap refresh". No pool on the list for the pair → "No vetted Curve pool for this pair".
- **Live check (2026-11-12, public RPCs, nothing signed)**: Ethereum 1 000 USDC → 1 000.95 USDT (23 candidates, 5 HTTP
  calls, 0.4 s); Base 100 USDC → 99.98 USDbC (4pool, 0.4 s); Base 0.1 ETH → 0.0874 cbETH (wrap → cbETH/WETH, 0.2 s).

---

### 4.18 0x, `zeroex`: Standard only (2026-11-15; ARCHITECTURE D38)

`AWK/protocol-swap2-0x@0.1.1/dist/provider.d.ts`: `zeroExProvider({enabled?, apiKey?, baseUrl?, chains?, rpcUrls?,
defaultSlippageBps?, quoteTtlMs?, timeoutMs?, excludedSources?, settlerMaxAgeMs?, settlerResolver?})`, which returns
the provider plus `ownGasEstimate: true` and the `settlerResolver` it reads the registry through.

- **Why only Standard.** 0x Swap API v2 wants `0x-api-key` on every request; the key is cp0x's (`ZEROEX_API_KEY` on
  the server) and can't be in a page. So 0x is built only on a Standard page and asked only while `/health` says
  `venues.zeroex === "keyed"` (`whileLive`, as Fynd); never in Public or Custom (no 0x key field there).
- **Browser options**: `{apiKey: PROXY_KEY_PLACEHOLDER, baseUrl: <API>/api/v2/swap-web/venue/zeroex, rpcUrls:
  cfg.evmRpc}`; every other option at the module's default (slippage 50 bps when none is asked, quotes 45 s, 10 s per
  request, no excluded sources, the registry read reused 5 min). The LOCAL provider runs here, not
  `zeroExRemoteProvider`: there is no swap2 backend, and the local one keeps every check on this device. It sends the
  placeholder only to `baseUrl`, as `0x-api-key` with `0x-version: v2`, `redirect: "error"`, and refuses an answer
  that came through a redirect or from another origin; the proxy swaps the placeholder for cp0x's key.
- **Paths it calls** (all under the slot, through the global fetch, so Standard's routing): `GET /swap/permit2/price`
  for a dry quote (every round, previews included) and `GET /swap/permit2/quote` for the live one (the engine at
  Confirm), with `chainId, sellToken, buyToken, sellAmount, slippageBps`, then `taker` when an address is known
  (dry: the refund or the recipient; live: the refund, else the recipient), `recipient` on a live quote when it is not
  the taker, `excludedSources` only when configured (never here). Nothing else of 0x's API. Registry reads
  (`ownerOf(2)`, `prev(2)`, `eth_getCode`) and receipts go over `rpcUrls` (Standard: the proxy RPC first; its loop
  moves to the next URL on a failure or an unused slot).
- **Routes**: same network, exact input, on Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche and BNB Chain;
  native ↔ wrapped native is refused up front ("wrapping and unwrapping are not 0x swaps", worded as a wrap). Its
  `supportsRoute` is chain-only, so on its chains every same-network pair is asked.
- **What a quote is.** Dry (`/price`): amounts and fees only, no transaction (`SIGNED_ONLY` in webRoute.ts: a Settler
  call the wallet signs, never a deposit address), and no spender named, so `orderSpender("zeroex", chain)` names
  canonical Permit2 for a token sale (the only allowance 0x ever gets). Live (`/quote`): the Settler is read from the
  registry first over the page's RPCs and held to CREATE3 + the pinned window + code; the transaction is decoded
  (`Settler.execute`: this swap's recipient, buy token, minimum; the first action spends exactly the permit, or is
  `NATIVE_CHECK` for a native sale); the Permit2 payload is rebuilt (exact input, that Settler, ≤ 10 min). Fees: 0x's
  own fee (in the price), the network fee; an integrator fee nobody asked for refuses the quote.
- **Execution.** A token sale (swap2-core 0.13.0 Permit2 transfer): the wallet signs the rebuilt
  `PermitTransferFrom` first, then approves Permit2 for exactly the input unless it already may, then sends the
  Settler call with the signature appended, estimated from the account (`ownGasEstimate`; the quoted gas limit is
  never sent). A native sale signs nothing but the call. Right before the broadcast `preflightDeposit` reads the
  registry again and refuses a Settler no longer in it. The gate (engine.md §7.3, ARCHITECTURE D38): call targets the
  Settlers the provider's own resolver read (`zeroExSettlers`), spender Permit2 only, and exactly that permit
  (`permit2Problem`) and the call carrying exactly the signature the wallet returned for it.
- **Availability** as Fynd's: before health answers, while "anonymous", after a stop, 0x is not asked and lists no
  row; `enabled()` stays the module's. A failure at the proxy or an upstream 401/403/429 stops the slot (D30's
  durations), never retried direct; "API key rejected" / "API answered HTTP …" read "Unavailable right now — try later".
  Not a 403 whose body names one of the module's per-request refusals (`USER_NOT_AUTHORIZED`,
  `TAKER_`/`RECIPIENT_`/`BUY_TOKEN_`/`SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE`, `XSTOCKS_NOT_AUTHORIZED`: 0x doesn't serve
  that token, account or recipient — `unsupported_pair`): it goes back to the module and 0x stays on for every other
  pair (`REQUEST_REFUSALS`, standard.ts).

### 4.19 Across, `across`: Standard only (2026-11-15; ARCHITECTURE D38)

`AWK/protocol-swap2-across@0.1.0/dist/provider.d.ts`: `acrossProvider({enabled?, apiKey?, baseUrl?, suggestedFeesUrl?,
rpcUrls?, maxFeeBps?, quoteTtlMs?, timeoutMs?, fetchImpl?})`.

- **Why only Standard.** Across API V5 (`POST https://api.across.to/v1/quotes`) wants the V5 key as
  `Authorization: Bearer`; it is cp0x's (`ACROSS_API_KEY`). Built only on a Standard page, asked only while
  `/health` says `venues.across === "keyed"` (`whileLive`); never in Public or Custom.
- **Browser options**: `{apiKey: PROXY_KEY_PLACEHOLDER, baseUrl: <API>/api/v2/swap-web/venue/across, rpcUrls,
  fetchImpl}`: `rpcUrls` is ONE URL per pinned Across chain (its type), the page's first runtime URL, and `fetchImpl`
  is `rpcFailoverFetch` over each chain's whole list (as CCTP), which passes every other request — V5 and the relayer
  fee — on to the global, Standard-routed fetch. The fee cap stays the module's 10 % (`maxFeeBps` 1000), quotes 60 s,
  10 s per request. The LOCAL provider runs here: the deposit is encoded on this device from the pinned SpokePool and
  the request, and verified at build time and again in `preflightDeposit`; V5 and the relayer fee only supply numbers.
- **Paths it calls**: `POST /v1/quotes` under the slot (`accept`, `content-type: application/json`,
  `authorization: Bearer <placeholder>`, `redirect: "error"`), body `{origin: {token: {chainId, address}, depositor,
  amount}, destination: {token, recipient}, amountType: "exact_input", capabilities, authorizationPolicy, maxFee: {bps:
  5000}}`; and, straight from the browser, Across's keyless relayer fee `GET https://app.across.to/api/suggested-fees
  ?inputToken&outputToken&originChainId&destinationChainId&amount&recipient` (CORS `*`, checked 2026-11-15; no key, a
  simple request). Without that answer the module prices only the corridors its pinned floor covers, which then need
  `rpcUrls` for Ethereum and the source chain (the quote time from their latest blocks); other routes are refused.
  Status reads go over `rpcUrls` too (the deposit's receipt on the source, `fillStatuses` on the destination).
- **Routes**: EVM → EVM on its 17 pinned chains, exact input, the same asset on both sides — USDC, USDT / USDT0, ETH /
  WETH, WBTC — native ETH only where the SpokePool wraps it, WETH never as a destination (it arrives as ETH), and
  nothing into Ethereum yet. `supportsRoute` is the module's own `acrossServesRoute`, so a pair it doesn't serve is
  never asked; "Not for this pair" names why from its `acrossRouteOf` / `acrossRouteUnpriced` (ui-port §5.5).
- **What a quote is.** Dry and live alike carry the deposit call (`txRequest` to the SpokePool, `approvalAddress` the
  same SpokePool for a token), its minimum equal to its output (a relayer pays exactly `outputAmount`): the app holds
  the live one to the reviewed floor, a few bps under (`floorToleranceBps`), as the module asks. A dry quote's
  depositor and recipient are the user's, else its placeholder, and such a quote is never built. The depositor of a
  live one is the signing account (`QuoteParams.sender`, set by swap2-core 0.14.0's engine); a refund address that is
  another account is refused, which never happens here (the refund address is the connected wallet).
- **Execution and gate**: one `deposit` on the pinned SpokePool, after an exact approval of it for a token (none for
  ETH, sent as value). The gate's rule is `acrossPins` (the SpokePool as call target and spender); it takes no
  Permit2 transfer or typed order.
- **Availability** as Fynd's and 0x's; its refusals that read better than their reason are worded (ui-port §4.2).

### 4.20 Stargate, `stargate`: every mode (2026-11-17; ARCHITECTURE D40)

`AWK/protocol-swap2-stargate@0.1.0/dist/provider.d.ts`: `stargateProvider({enabled?, rpcUrls, registry?, quoteTtlMs?,
feeHeadroomBps?, compose?, nativeDrop?, …})`. Off in the package until `enabled: true`.

- **Browser options**: `{enabled: true, rpcUrls: evmRpcByCaip2(evmRpc), scanUrl: api.layerZeroScan}` (USDT0's table: Standard's
  proxy RPC first; LayerZero Scan, USDT0's too, only to find the destination transaction its status then proves).
  Keyless, no API: quotes are read from the pinned pools (`quoteOFT` / `quoteSend`) on the source and destination at
  one block each, so it needs an RPC for both networks. Compose (Taxi + a swap on Ethereum) and native drop stay off;
  Bus is retired in the package.
- **Routes**: EVM → EVM between its reviewed deployments (`stargateRegistry`: 25 pools / OFTs on 15 networks — USDC,
  USDT, ETH and the WETH OFTs), the same asset id on both sides, along a pinned TokenMessaging path; never within one
  network. Scroll is refused from 2026-12-08 (the package's sunset date). "Not for this pair" reads its registry
  (providerMeta `stargateScope`): EVM only, between networks only, "Moves USDC, USDT and ETH only", "Same token on
  both networks only", "Not between these networks"; an imported token reads "Listed tokens only" (listed-only, D39).
- **What a quote is.** One `sendToken` call on the source pool / OFT (`txRequest.to`; `approvalAddress` the same pool
  for an ERC-20, none for a native pool), `value` = the LayerZero messaging fee cap (+ the input for ETH), declared as
  `nativeFee` (the fee plus the package's 25 % headroom, refunded by the endpoint). `feeUsd` is 0 (`feeUsdKnown`
  false) and the fee is an unpriced `network` row, so the route row prices `nativeFee` itself
  (`FEE_USD_WITHOUT_BRIDGE_FEE`, as USDT0's): ≈ $1.5 from Arbitrum or Base (2026-11-17). `etaSeconds` is `null`
  (swap2-core 0.15): shown "—", never "fastest". Minimum = output (Taxi pays the quoted amount or reverts). A dry quote
  with a blank sender or recipient is priced for the package's placeholder `0x1111…1111` and carries its transaction;
  a preview is never reviewable (D7), a live quote has the user's addresses (preview.ts).
- **Native-fee cap** (engine §, `execute.ts` `nativeFeeCeiling`): the fee is above the engine's cap from Avalanche
  (0.231 AVAX vs 0.1) and at it from Polygon (19.4 POL vs 20), so a Stargate execution from those two may pay up to
  0.5 AVAX / 40 POL; the 13 others keep the chain's cap (0.0009–0.001 ETH, 0.0026 BNB, 4.3 MNT, 50 S, 38 XPL, 40 SEI,
  130 PLUME, 671 FLR measured against 0.005 ETH, 0.005 BNB, 20 MNT, 200 S, 150 XPL, 200 SEI, 500 PLUME, 1500 FLR).
- **Execution and gate**: the package checks the quote against the request and its pins, rebuilds the `sendToken`
  call and re-quotes the pool right before the broadcast. The gate's rule is the registry's lists (`stargateRegistry`
  `callTargets` / `spenders`: pools, OFTs and messaging contracts as call targets, ERC-20 pools as spenders — a
  native pool never is one), with the engine's value checks on `nativeFee`; no Permit2 transfer or typed order.
- **Status**: the package's `trackIntent`, over the same RPCs: `completed` once the destination pool's payout is
  proven from finalized receipts on both networks (≈ 15–20 min Arbitrum ↔ Base). Recovery (a cached token, an
  undelivered message) is a separate paid action the app doesn't offer.

## 5. Persistent stores (`src/swap/stores.ts`)

### 5.1 Contract

```ts
import type {RelayClearedStore} from "@anywalletkit/protocol-swap2-relay/provider";
import type {HtlcSecretStore, OmnistonQuoteStore} from "@anywalletkit/protocol-swap2-omniston/provider"; // type-only: erased

export interface ProviderStores {
  relayCleared: RelayClearedStore;
  omnistonQuotes: OmnistonQuoteStore & {claim(quoteId: string, valueJson: string): Promise<boolean>};
  omnistonSecrets: HtlcSecretStore;
  /** Resolves true once IndexedDB is open; false when it cannot be (private mode with storage blocked, etc.). */
  ready(): Promise<boolean>;
}
```

`createProviderStores()` is **synchronous**; the database opens lazily on first use. That keeps
`buildProviders()` synchronous, which `engine.md` §2.6 calls as `registry ??= buildProviders()`.

### 5.2 IndexedDB implementation

```ts
const DB_NAME = "cp0x-swap";
const DB_VERSION = 1;
const KV = "kv";                                   // {key, value, until}
const OMNISTON_TTL_MS = 6 * 60 * 60 * 1000;        // SRV:45-50 STATE_TTL_MS; > any HTLC window; = omniston CACHE_TTL_MS
const SWEEP_EVERY_MS = 60_000;                     // SRV:51-52

interface Row {key: string; value: unknown; until: number}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => r.result.createObjectStore(KV, {keyPath: "key"}).createIndex("until", "until");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("cp0x-swap storage is blocked by another tab"));
  });
}

/** One transaction; resolves when it COMMITS. Writes use durability "strict": a secret must be on disk before the
 *  order it locks is signed. */
function run<T>(db: IDBDatabase, mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV, mode, mode === "readwrite" ? {durability: "strict"} : undefined);
    let out: T | undefined;
    const req = body(tx.objectStore(KV));
    if (req) req.onsuccess = () => { out = req.result; };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("storage transaction aborted"));
  });
}

export function createProviderStores(): ProviderStores {
  let dbp: Promise<IDBDatabase> | undefined;
  let lastSweep = 0;
  const db = () => (dbp ??= openDb().then((d) => { void navigator.storage?.persist?.().catch(() => {}); return d; }));

  const sweep = async (d: IDBDatabase) => {
    const now = Date.now();
    if (now - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = now;
    await run(d, "readwrite", (s) => {
      const c = s.index("until").openCursor(IDBKeyRange.upperBound(now));
      c.onsuccess = () => { const cur = c.result; if (cur) { cur.delete(); cur.continue(); } };
    }).catch(() => {});                                   // best-effort, like SRV:60-66
  };
  const get = async (key: string): Promise<Row | undefined> => (await run<Row>(await db(), "readonly", (s) => s.get(key))) ?? undefined;
  const put = async (row: Row) => { const d = await db(); await run(d, "readwrite", (s) => s.put(row)); await sweep(d); };
  const del = async (key: string) => { await run(await db(), "readwrite", (s) => s.delete(key)); };

  // Omniston: prefixes keep the quote rows apart from the secret rows (the provider stores several keys per quote id:
  // quoteId, its binding, disclosed flags — chunk-DMO24BFW.js:1607-1633).
  const q = (id: string) => `oq:${id}`;
  const s = (id: string) => `os:${id}`;
  const r = (id: string) => `rc:${id.toLowerCase()}`;

  return {
    ready: () => db().then(() => true, () => false),
    relayCleared: {
      async has(orderId) {                            // throws → relay refuses the signature (fail closed)
        const row = await get(r(orderId));
        return !!row && row.until > Date.now();
      },
      async add(orderId, expiresAtMs) {
        await put({key: r(orderId), value: 1, until: expiresAtMs});
      },
    },
    omnistonQuotes: {
      save: (id, json) => put({key: q(id), value: json, until: Date.now() + OMNISTON_TTL_MS}),
      load: async (id) => { const row = await get(q(id)); return typeof row?.value === "string" ? row.value : undefined; },
      clear: (id) => del(q(id)),
      /** Atomic create-if-absent: IDB `add` fails with ConstraintError when the key exists (SRV:81-91 equivalent). */
      async claim(id, json) {
        const d = await db();
        const ok = await new Promise<boolean>((resolve, reject) => {
          const tx = d.transaction(KV, "readwrite", {durability: "strict"});
          let created = true;
          const req = tx.objectStore(KV).add({key: q(id), value: json, until: Date.now() + OMNISTON_TTL_MS} satisfies Row);
          req.onerror = (e) => { if (req.error?.name === "ConstraintError") { created = false; e.preventDefault(); e.stopPropagation(); } };
          tx.oncomplete = () => resolve(created);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new Error("storage transaction aborted"));
        });
        await sweep(d);
        return ok;
      },
    },
    omnistonSecrets: {
      save: (id, secretsHex) => put({key: s(id), value: [...secretsHex], until: Date.now() + OMNISTON_TTL_MS}),
      load: async (id) => { const row = await get(s(id)); return Array.isArray(row?.value) ? (row.value as string[]) : undefined; },
      clear: (id) => del(s(id)),
    },
  };
}
```

Notes:

- IndexedDB is shared by every tab of the origin, so two tabs tracking the same Omniston order may both
  disclose. Disclosure is idempotent (`disclosedKey` is recorded). Relay's `has → add` is two calls (the SDK API),
  so a cross-tab race inside one second is theoretically possible. It needs two tabs signing the same order.
- If `ready()` resolves false:
  - Relay does not fall back to its in-memory record. The store throws, so Relay refuses at preflight. That is
    mobile's fail-closed rule (`M/swap/relayCleared.ts:6-7`). Surface it as "Enable site storage to use Relay".
  - Omniston is not built (§6.3).
- The 6 h sweep never deletes a live secret. The longest EVM window is the 300 s public cancel; the timelocks
  are `EVM_TIMELOCKS = [1, 120, 240, 300, 1, 120, 180, 0]` (`chunk-DMO24BFW.js:597`).
- Omniston calls `claim` for **every** quote, dry route-list quotes included (`SRV:56-58`). Rows are small (≈1–3
  KB), and the sweep keeps the table bounded.

### 5.3 What each provider persists

| provider | durable state | if missing |
|---|---|---|
| relay | `rc:<orderId>` until the order deadline (quote + 7 d) | store throws → no signature. No store at all → in-realm memory only; a reload inside ~20 min could let a replayed order id be signed twice |
| omniston | `oq:<quoteId>` (quote/build context, JSON) and `os:<quoteId>`… (HTLC secret hex + binding + disclosed flags), 6 h | in-memory default: a reload loses the secret, the order cannot complete and refunds |
| everyone else | nothing; tracking is stateless (deposit address, source tx hash, request id, CCTP message) | the swap record (id + hashes) is the engine's concern (`engine.md` §4.6, in-flight store) |

### 5.4 Tab closed mid-swap

| provider | consequence |
|---|---|
| near_intents, lifi, relay, thorchain, chainflip, usdt0, symbiosis, uniswap, wrap, balancer, jupiter | Nothing is lost on the venue side. Once the source tx is broadcast, delivery proceeds without the page; status resumes from the persisted swap id. A close *between* signing and broadcast is the engine's `Swap2MaybeSentError` case |
| cctp | Delivery waits for the user's claim on the destination. The burn is final and the attestation stays at Circle; reopen → `action-required` → `claimSwap2`. An expired Fast attestation is re-attested by the provider |
| omniston (EVM source) | The browser is the **only** discloser. Closing or backgrounding the tab after the resolver funds the destination escrow means no disclosure. Destination cancel opens at 180 s, and the validator also refuses within 45 s of it. The resolver cancels; the source escrow is cancellable at 240 s (public at 300 s) and returns the input to the maker. **Funds come back; the swap fails.** Reopening inside the window resumes from IndexedDB (`trackIntent` reloads context and secret) and can still disclose. Clearing site data loses the secret, leading to a refund. Show a "keep this tab open" banner while an Omniston order is pending, poll on `visibilitychange`, and remember that Chrome throttles hidden-tab timers (1/min after 5 min) |

---

## 6. `src/swap/providers.ts`

If the app adopts `engine.md`'s `src/lib/swap/` layout, this file lives at `src/lib/swap/providers.ts`. Nothing
in it depends on its location.

### 6.1 Helpers

```ts
// src/swap/providerWrappers.ts
import type {Asset, CrossChainProvider, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** FIFO: calls start at least `gapMs` apart (Symbiosis fetches, Jupiter quotes). */
export function paced<A extends unknown[], R>(gapMs: number, fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  let next = 0;
  return async (...a: A) => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gapMs;
    if (at > now) await sleep(at - now);
    return fn(...a);
  };
}

/** Spaces a provider's getQuote calls (the module has no fetchImpl). Providers are closure-based object literals
 *  (no `this` in jupiter / wrap), so a spread copy is a faithful wrapper; CrossChainRouter binds each method. */
export function withQuoteGap(p: CrossChainProvider, gapMs: number): CrossChainProvider {
  const quote = paced(gapMs, (params: QuoteParams, signal?: AbortSignal) =>
    signal?.aborted ? Promise.resolve(null) : p.getQuote(params, signal));
  return {...p, getQuote: quote};
}

/** Narrow a chain-only supportsRoute (keeps RouteSet.rejections free of venues that can never serve the pair). */
export function narrowRoute(p: CrossChainProvider, pred: (from: Asset, to: Asset) => boolean): CrossChainProvider {
  return {...p, supportsRoute: (from, to) => pred(from, to) && p.supportsRoute(from, to)};
}
```

The app's `delegate` (every wrapper above is built on it) copies each member the router reads, bound to the shared
instance, and only those the original has; since swap2-core 0.13.0 that includes `ownGasEstimate` (router 0.6.1 keeps
it in its dispatch snapshot): without it the engine would send a 0x native sale with the venue's quoted gas limit
instead of the account's own estimate of the exact call. Since swap2-core 0.12.0 every wrapper that refuses or relays a
refusal (`coolDownOnRateLimit`, `payoutToSigner`, the quote round's observer) passes the venue's classification on with
its text: `onRefusal(text, info)`.

`isWrapPair` mirrors the wrap module's own check (`chunk-GC6XODOS.js:121-129`). `from.token` is a catalog
symbol; `to.token` is an address, or the zero address for native.

```ts
import {WRAPPED_NATIVE} from "@anywalletkit/protocol-swap2-wrap/provider";
import {ccAsset} from "@anywalletkit/swap2-assets";

const ZERO = /^0x0{40}$/i;
export function isWrapPair(from: Asset, to: Asset): boolean {
  if (from.chain !== to.chain || !from.chain.startsWith("eip155:")) return false;
  const w = WRAPPED_NATIVE[Number(from.chain.slice(7))];
  if (!w) return false;
  const src = ccAsset(from.chain, from.token);
  const wrappedIn = !!src?.contract && src.contract.toLowerCase() === w.address.toLowerCase();
  const nativeIn = !!src && !src.contract;
  const wrappedOut = to.token.toLowerCase() === w.address.toLowerCase();
  return (nativeIn && wrappedOut) || (wrappedIn && ZERO.test(to.token));
}
```

### 6.2 `buildProviders`

```ts
// src/swap/providers.ts
/**
 * Every AWK swap2 provider this SPA runs, constructed once from public config.
 * - No keys, no fee options (fee 0), no remoteProvider: each module verifies its own upstream answer.
 * - ONE instance per provider for the page's lifetime (Relay's issued-quote memory, Omniston's WebSocket):
 *   build routers over this array per request; never close them; close the providers on pagehide only.
 */
import type {CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import {nearIntentsProvider} from "@anywalletkit/protocol-swap2-near-intents/provider";
import {lifiProvider} from "@anywalletkit/protocol-swap2-lifi/provider";
import {thorchainProvider} from "@anywalletkit/protocol-swap2-thorchain/provider";
import {cctpProvider} from "@anywalletkit/protocol-swap2-cctp/provider";
import {CCTP_DOMAINS} from "@anywalletkit/protocol-swap2-cctp/config";
import {usdt0Provider} from "@anywalletkit/protocol-swap2-usdt0/provider";
import {chainflipProvider} from "@anywalletkit/protocol-swap2-chainflip/provider";
import {relayProvider} from "@anywalletkit/protocol-swap2-relay/provider";
import {uniswapProvider} from "@anywalletkit/protocol-swap2-uniswap/provider";
import {wrapProvider} from "@anywalletkit/protocol-swap2-wrap/provider";
import {jupiterProvider} from "@anywalletkit/protocol-swap2-jupiter/provider";
import {symbiosisProvider} from "@anywalletkit/protocol-swap2-symbiosis/provider";   // light (≈90 KB dist)
import {balancerProvider} from "@anywalletkit/protocol-swap2-balancer/provider";     // light (≈20 KB dist)
import {DEFAULT_RUNTIME_CONFIG, type ProviderName, type RuntimeConfig} from "./runtimeConfig";
import {createProviderStores, type ProviderStores} from "./stores";
import {isWrapPair, narrowRoute, paced, withQuoteGap} from "./providerWrappers";
import {lazyOmniston} from "./omnistonLazy";

/** SRV:296-298 — li.quest/v1/chains names 0x198F… as Flare's Diamond (the canonical 0x1231… has no code there). */
const LIFI_FLARE_DIAMOND = {"eip155:14": ["0x198FC70Dfe05E755C81e54bd67Bff3F729344B9b"]} as const;

/** Built by default in every mode, in ask order (symbiosis, balancer, omniston since 2026-11-12). */
export const DEFAULT_ON_PROVIDERS: readonly ProviderName[] = [
  "uniswap", "curve", "balancer", "wrap", "usdt0", "cctp", "thorchain", "chainflip", "near_intents", "lifi", "relay",
  "symbiosis", "jupiter", "omniston",
];
export const STANDARD_ONLY_PROVIDERS: readonly ProviderName[] = ["fynd", "zeroex", "across"];

export const evmRpcByCaip2 = (rpc: RuntimeConfig["evmRpc"]): Record<string, string[]> =>
  Object.fromEntries(Object.entries(rpc).filter(([, u]) => u.length).map(([id, u]) => [`eip155:${id}`, [...u]]));

const firstRpc = (rpc: RuntimeConfig["evmRpc"], caip2s: readonly string[]): Record<string, string> =>
  Object.fromEntries(caip2s.flatMap((c) => {
    const url = rpc[Number(c.slice("eip155:".length))]?.[0];
    return url ? [[c, url]] : [];
  }));

export function buildProviders(
  config: RuntimeConfig = DEFAULT_RUNTIME_CONFIG,
  stores: ProviderStores = createProviderStores(),
): CrossChainProvider[] {
  const on = config.providers;
  const evm = config.evmRpc;                       // Record<number, string[]>  (uniswap, wrap, balancer)
  const evmCaip = evmRpcByCaip2(evm);              // Record<caip2, string[]>   (usdt0, omniston validators)
  const out: CrossChainProvider[] = [];

  // ── default on, in DEFAULT_ON_PROVIDERS order ─────────────────────────────────────────────────────────────────
  if (on.uniswap) out.push(uniswapProvider({rpcUrls: evm}));
  if (on.curve) out.push(curveProvider({rpcUrls: evm}));   // 2026-11-12 (§4.17)
  if (on.balancer) out.push(balancerProvider({rpcUrls: evm, apiUrl: config.api.balancer}));
  if (on.wrap) out.push(narrowRoute(wrapProvider({rpcUrls: evm}), isWrapPair));
  // Legacy Mesh into TON and Tron named; Tron's fee cap is raised for that route alone (execute.ts nativeFeeCeiling), §4.5.
  if (on.usdt0) out.push(usdt0Provider({rpcUrls: evmCaip, scanUrl: config.api.layerZeroScan, tonApiUrl: config.tonApiUrl, meshDestinations: ["ton", "tron"]}));
  if (on.cctp) {
    out.push(cctpProvider({apiUrl: config.api.cctp, mode: config.cctp.mode, rpcUrls: firstRpc(evm, Object.keys(CCTP_DOMAINS))}));
  }
  if (on.thorchain) {
    out.push(thorchainProvider({
      nodeUrl: [...config.api.thorNodes],
      ...(config.api.thorConfirmNodes.length ? {confirmNodeUrl: [...config.api.thorConfirmNodes]} : {}),
      clientId: config.thorchain.clientId,
      tronSource: false,
    }));
  }
  if (on.chainflip) out.push(chainflipProvider({apiUrl: config.api.chainflip}));
  if (on.near_intents) {
    out.push(nearIntentsProvider({apiUrl: config.api.nearIntents, suspendedChains: config.nearIntents.suspendedChains}));
  }
  if (on.lifi) {
    const lifi = lifiProvider({
      apiUrl: config.api.lifi,
      trustedTransactionTargets: LIFI_FLARE_DIAMOND,
      trustedApprovalAddresses: LIFI_FLARE_DIAMOND,
    });
    // web (§4.2): no new /quote while its rate limit lasts; asked EVM → Solana since lifi 0.8.0 reads the recipient.
    out.push(coolDownOnRateLimit(lifi));
  }
  if (on.relay) out.push(relayProvider({baseUrl: config.api.relay, clearedStore: stores.relayCleared}));
  if (on.symbiosis) {
    out.push(symbiosisProvider({
      apiUrl: config.api.symbiosis,
      tronSource: false,
      btcSource: false,
      // 1 request/s per IP on /v2/quote; the module fetches swap-limits then /v2/quote back to back. One pacer per page.
      fetchImpl: paced(config.pacing.symbiosisGapMs, (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
    }));
  }
  if (on.jupiter) {
    out.push(withQuoteGap(jupiterProvider({apiUrl: config.api.jupiter, rpcUrls: [...config.solanaRpc]}), config.pacing.jupiterGapMs));
  }
  if (on.omniston) out.push(lazyOmniston(config, stores, evmCaip));

  // ── Standard only (2026-11-12, §4.14): the proxy as a keyless Fynd server per chain, asked while health keys it ──
  if (on.fynd && extras.fynd) {
    const selfHosted = Object.fromEntries(Object.entries(FYND_CHAINS).map(([id, c]) => [Number(id), `${extras.fynd.base}/${c.slug}`]));
    out.push(whileLive(fyndProvider({selfHosted, rpcUrls: evm}), extras.fynd.live));
  }
  // ── Standard only (2026-11-15, §4.18-4.19, D38): local providers, the proxy slot as baseUrl, a placeholder key ──
  if (on.zeroex && extras.zeroex) {
    const zeroex = zeroExProvider({apiKey: PROXY_KEY_PLACEHOLDER, baseUrl: extras.zeroex.base, rpcUrls: evm});
    const live = whileLive(zeroex, extras.zeroex.live);
    settlerResolvers.set(live, zeroex.settlerResolver); // execute's pins read the Settlers from it (zeroExSettlers)
    out.push(live);
  }
  if (on.across && extras.across) {
    const rpcUrls = firstRpc(evm, Object.keys(ACROSS_CHAINS));
    out.push(whileLive(acrossProvider({apiKey: PROXY_KEY_PLACEHOLDER, baseUrl: extras.across.base, rpcUrls, fetchImpl: rpcFailoverFetch(failoverLists(evm, rpcUrls))}), extras.across.live));
  }

  return out;
}

/** pagehide only (engine.md §2.5). Closes Omniston's WebSocket; every other provider has no close(). */
export function closeProviders(providers: readonly CrossChainProvider[]): void {
  for (const p of providers) {
    try { p.close?.(); } catch { /* ignore */ }
  }
}
```

The router binds the methods it sees at construction (`chunk-7ZUNB2U7.js:70-99`). Every object above is
therefore final when the array is returned: no mutation later, and `lazyOmniston` swaps internals behind
stable functions.

### 6.3 Omniston: lazy wrapper + chunk

```ts
// src/swap/omnistonLazy.ts — in the main bundle; tiny
import type {Asset, CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import {ccAsset, ccAssetByToken} from "@anywalletkit/swap2-assets";
import type {RuntimeConfig} from "./runtimeConfig";
import type {ProviderStores} from "./stores";

/** Each stand-in's load while it runs; engine.ts waits up to LAZY_WAIT_MS for it before a round picks its venues. */
const loads = new WeakMap<CrossChainProvider, Promise<unknown>>();
export function lazyLoads(providers: readonly CrossChainProvider[]): Promise<void> | null { /* … */ }

/** Cross-chain orders move tokens only (the SDK refuses a native leg locally): such a pair is never asked. */
export const omnistonTokenLegs = (from: Asset, to: Asset): boolean =>
  from.chain === to.chain || (!!ccAsset(from.chain, from.token)?.contract && !!ccAssetByToken(to.chain, to.token)?.contract);

/**
 * A stand-in that is enabled and routable only once the real provider has loaded (supportsRoute must be sync and
 * I/O-free); loading starts immediately.
 */
export function lazyOmniston(config: RuntimeConfig, stores: ProviderStores, rpcUrls: Record<string, string[]>): CrossChainProvider {
  let real: CrossChainProvider | null = null;
  const loading = (async () => {
    if (!(await stores.ready())) return null;                             // no durable secret store → no Omniston
    const {buildOmniston} = await import("./omniston");                    // separate chunk: buffer + @ton/* + sdk
    return (real = buildOmniston(config, stores, rpcUrls));
  })().catch((e) => { console.warn("omniston failed to load", e); return null; });
  const get = async () => {
    const p = real ?? (await loading);
    if (!p) throw new Error("omniston: unavailable in this browser (site storage is blocked)");
    return p;
  };
  const standIn: CrossChainProvider = {
    name: "omniston",
    supportsSameChain: true,                                              // TON↔TON swaps (TON wallet: later)
    enabled: () => !!real && real.enabled(),                              // tracking reaches get() without it
    supportsRoute: (from, to) => !!real && omnistonTokenLegs(from, to) && real.supportsRoute(from, to),
    supportsChain: (c) => !!real?.supportsChain?.(c),
    supportsChainPair: (a, b) => !!real?.supportsChainPair?.(a, b),
    getQuote: async (params, signal) => (await get()).getQuote(params, signal),
    buildDeposit: async (quote) => (await get()).buildDeposit(quote),
    trackIntent: async (ref) => (await get()).trackIntent(ref),
    registerSignedOrder: async (intentId, signature) => {
      const p = await get();
      if (!p.registerSignedOrder) throw new Error("omniston: registerSignedOrder missing");
      return p.registerSignedOrder(intentId, signature);
    },
    describeActivity: (tx, ctx) => real?.describeActivity?.(tx, ctx) ?? null,
    close: () => real?.close?.(),
  };
  loads.set(standIn, loading);
  void loading.finally(() => loads.delete(standIn));
  return standIn;
}
```

```ts
// src/swap/omniston.ts — the lazy chunk
import "../polyfills/buffer";                       // FIRST: globalThis.Buffer for @ton/core, @ton/crypto (§2.2)
import {omnistonProvider} from "@anywalletkit/protocol-swap2-omniston/provider";
import {
  AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS,
  AUDITED_OMNISTON_SETTLEMENT_CONTRACTS,
  createOmnistonEvmDeliveryLocator,
  createOmnistonEvmInputValidator,
  createOmnistonEvmOutputValidator,
  createOmnistonTonDeliveryLocator,
  createOmnistonTonValidators,
} from "@anywalletkit/protocol-swap2-omniston/validators";
import type {CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import type {RuntimeConfig} from "./runtimeConfig";
import type {ProviderStores} from "./stores";

const json = (d: unknown) => JSON.stringify(d ?? {}, (_k, v) => (typeof v === "bigint" ? String(v) : v));

/** Bounded diagnostics (never secrets — the SDK guarantees it); the status screen can show the last few. */
export const omnistonTrace: string[] = [];
const log = (line: string) => { omnistonTrace.push(line); if (omnistonTrace.length > 200) omnistonTrace.shift(); console.debug(line); };

export function buildOmniston(config: RuntimeConfig, stores: ProviderStores, rpcUrls: Record<string, string[]>): CrossChainProvider {
  const tonApi = {tonApiUrl: config.tonApiUrl};                                   // SRV:275 (no key in a browser)
  const refusal = (v: string) => (reason: string, details?: Record<string, unknown>) => log(`[omniston-validator] ${v} ${reason} ${json(details)}`);
  return omnistonProvider({
    apiUrl: config.api.omnistonWs,
    maxUsd: config.omniston.maxUsd,
    trustedSettlementContracts: AUDITED_OMNISTON_SETTLEMENT_CONTRACTS,           // never from runtime config
    ...(config.omniston.evmSource ? {trustedEvmOrderProtocols: AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS} : {}),
    maxHtlcExecutions: 1,                                                        // SRV:404-406
    ...createOmnistonTonValidators({...tonApi, onRefusal: refusal("tonOutput")}),
    validateEvmOutputPosition: createOmnistonEvmOutputValidator({rpcUrls, onRefusal: refusal("evmOutput")}),
    validateEvmInputPosition: createOmnistonEvmInputValidator({rpcUrls, onRefusal: refusal("evmInput")}),
    locateEvmDelivery: createOmnistonEvmDeliveryLocator({rpcUrls}),
    locateTonDelivery: createOmnistonTonDeliveryLocator(tonApi),
    trace: (event, details) => log(`[omniston] ${event} ${json(details)}`),
    quoteStore: stores.omnistonQuotes,
    secretStore: stores.omnistonSecrets,
    // no integratorAddress / integratorFeePips → fee 0
  });
}
```

### 6.4 Lifecycle glue (matches `engine.md` §2.5-2.6)

```ts
// in engine.ts
let registry: CrossChainProvider[] | null = null;
export const appProviders = () => (registry ??= buildProviders(loadedRuntimeConfig(), createProviderStores()));
addEventListener("pagehide", () => { if (registry) closeProviders(registry); });
// per request: new CrossChainRouter(appProviders(), {...ROUTER_RANKING, valueUsd})   — never .close()
// ROUTER_RANKING = {weights: "price:0.7,speed:0.3,reliability:0", tieBand: 0.0005}  (M/swap/gas.ts:51)
```

Do not rebuild providers when the config changes mid-session. A rebuild drops Relay's issued-quote memory.
Reload the page instead. The IndexedDB stores make Omniston resume after a reload.

---

## 7. What is still needed from mobile `providers.ts`

`M/swap/providers.ts` described *remote* venues for the stubs. With real providers:

| export (`M/swap/providers.ts`) | keep? | why |
|---|---|---|
| `PROVIDERS`, `ProviderName` (`:17-33`) | replace | `ProviderName` in `runtimeConfig.ts` (`fynd` Standard only, §4.14; plus `curve`) |
| `PROVIDER_NAMES`, `providerName` (`:35-52`) | **keep** | display names |
| `SAME_CHAIN` (`:55`) | drop | each provider sets `supportsSameChain` itself (lifi, uniswap, wrap, balancer, jupiter, omniston; checked with `names.mjs`), and the router filters on it (`chunk-7ZUNB2U7.js:212-214`) |
| `TWO_PHASE` (`:58`) | **keep** | the review says "claim on arrival" for cctp. Equivalent check: `!!provider.buildClaim` (true for cctp **and** usdt0, but usdt0's claim is only a failed-delivery retry, so keep the explicit set) |
| `PROVIDER_CAPABILITIES`, chain sets (`:63-195`) | drop | the real `supportsChain` / `supportsChainPair` / `supportsRoute` decide. For a chain picker: `providers.some((p) => p.enabled() && p.supportsChain?.(caip2))` |
| `orderSpender` (`:86-101`) | **keep and extend** | dry quotes that name no spender: omniston → `AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS[chain]?.[0]`; **chainflip → `CF_VAULTS[chain]` for EVM sources** (the dry quote has no `txRequest`, §4.6). Every other EVM venue names `txRequest.approvalAddress` in its dry quote (`approve.mjs`) |
| `providerServesRoute` / `providersFor` (`:217-255`) | drop | the router asks `p.enabled() && p.supportsRoute(from, to)`, then the same-chain filter. To show "venues asked", use the same predicate over `appProviders()`. The narrowing mobile did for wrap is now `narrowRoute(isWrapPair)`; CCTP, USDT0, Chainflip, Symbiosis, NEAR and THORChain already narrow by token in their own `supportsRoute` |
| `RELAY_CHAINS` / `symbiosisChain` imports (`:13-14`) | drop | they were copies of what the providers now use directly |

```ts
// src/swap/providerMeta.ts
import {CF_VAULTS} from "@anywalletkit/protocol-swap2-chainflip/config";

/** Inline copy of AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS (validators.d.ts:143, snapshot 2026-11-11) so the main bundle
 *  does not import the Omniston package. A unit test asserts equality with the package export. */
const OMNISTON_ORDER_PROTOCOL: Readonly<Record<string, string>> = {
  "eip155:1": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9", "eip155:56": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
  "eip155:137": "0xafCF681272AF10959736f45616eeCBC22D7095E2", "eip155:8453": "0xe7405fAcDEDB2512e91F2886BDff13231343aF5E",
  "eip155:42161": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9", "eip155:43114": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
  "eip155:196": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9", "eip155:9745": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
  "eip155:999": "0xD84778bbeEC5D2a8d17c6424249C438EC0b1ABE3",
};

/** The spender a dry quote leaves unnamed for an ERC-20 source on `chain`, or null. */
export function orderSpender(provider: string, chain: string): string | null {
  if (provider === "omniston") return OMNISTON_ORDER_PROTOCOL[chain] ?? null;
  if (provider === "chainflip" && chain.startsWith("eip155:")) return CF_VAULTS[chain] ?? null;
  return null;
}
```

Do not import `@anywalletkit/protocol-swap2-omniston/validators` here: it would pull the Omniston package into
the main bundle. Import it only in `providerMeta.test.ts`, and assert
`OMNISTON_ORDER_PROTOCOL[c] === AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS[c][0]` for every chain.

---

## 8. Live probe results (2026-11-11, Node 24, dry quotes)

Route Arbitrum USDC → Base USDC, 5 USDC, dest/refund `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`, through one
`CrossChainRouter([cctp, relay, lifi, near_intents])`:

| provider | first update | out | min | eta | tags |
|---|---|---|---|---|---|
| cctp | 434 ms | 4 999 230 | 4 999 230 | 45 s | best |
| near_intents | 543 ms | 4 996 630 | 4 946 663 | 27 s | |
| relay | 623 ms | 4 978 365 | 4 928 582 | 1 s | fastest |
| lifi | 1 927 ms | 4 983 418 | 4 983 418 | 2 s | |

Others:

| call | result |
|---|---|
| uniswap Base 0.001 ETH→USDC (publicnode) | out 2 075 172, 492 ms, router `0x2626…`, value = input |
| wrap Base ETH→WETH | 1:1, 86 ms |
| usdt0 Arb 5 USDT0→HyperEVM | out 5 000 000, nativeFee 2 968 291 252 200 wei, 685 ms |
| usdt0 Ethereum USDT→Arb | approvalAddress = adapter `0x6C96…1dee` |
| jupiter 0.01 SOL→USDC (keyless, publicnode RPC) | out 848 536, 387 ms, ttl 30 s |
| chainflip Arb 20 USDC→ETH | out 0.009364 ETH, 640 ms, no `txRequest` (dry) |
| thorchain Base 20 USDC→ETH, nodes [Liquify, THORWallet] | quoted in 10.3 s (Liquify degraded); later both nodes: "refusing quote on node with stale state" |
| near Arb 20 USDC → OP USDC / BSC USDT / TON USDT (HOT) | all quote (≈0.5–0.9 s); cp0x-api returns the same → HOT corridors not suspended in prod today |
| near → Solana / TON with a contract or mint as recipient | `400 Internal server error`; a valid wallet address works. Dry quotes need a **real-format** recipient |
| symbiosis Arb→Base USDC | unpaced: rate-limited on the first call; paced 1.1 s: reached the verifier, which refused this route by design |
| balancer Base 0.001 ETH→USDC | out 2 060 722, Vault |
| omniston Base→Arb USDC (EVM→EVM) | out 4 983 651, ~3.3 s (WS + settle window) |
| omniston Base USDC→TON USDT | refused on 0.5.4: untrusted TON settlement contract `EQDybO88…` (same on cp0x-api); 0.5.5 trusts it |
| `wss://omni-ws.ston.fi` with `Origin: https://swap.cp0x.example` | opens |

CORS (OPTIONS with a foreign Origin): every venue API and all 31 primary EVM RPCs pass. The one failure is
`thorchain.ibs.team` (403). `pf.sh` has the full list.

---

## 9. Risks and open items

1. **THORChain in the browser depends on two CORS-open nodes.** If Liquify or THORWallet is down, no THORChain
   route is possible. Consider a third operator via your own proxy (`thorConfirmNodes`).
2. **The router's 8 s cap** silently drops slow venues (THORChain on a slow node, Symbiosis with retries). The
   rejection reads `quote timed out after 8000ms`. Map it to "slow venue" in `parseRejections`.
3. **Omniston EVM→TON was blocked by the SDK pin** (`EQDybO88…`). 0.5.5 (2026-11-12) pins the reviewed rev2 TON
   minter and its position code; never a config override.
4. **The Omniston secret lives in the page.** XSS or a compromised bundle before validation means loss. A strict
   CSP and no third-party scripts are mandatory before enabling it, and the tab must stay open while orders are
   pending (§5.4).
5. **`crypto.randomUUID`** breaks NEAR and Chainflip quotes outside secure contexts (LAN dev URLs).
6. **Dry recipients must be valid on the destination chain.** 1Click 400s on a mint/contract recipient, and
   THORChain validates the address. Mobile always had the user's own address. The web quotes LIVE only with the
   user's own addresses (ARCHITECTURE D7); its preview prices before a wallet use a per-family sample only inside the
   engine's preview round and only for the venues that need one (§4.16), and are never reviewable. SDK task: a
   uniform address-free dry quote (each provider filling its own destination-family placeholder) and a
   `Quote.placeholder` flag refused at build for every provider, as Relay already does.
7. **Public RPC ceilings.**
   - Uniswap batches up to 10 `eth_call`s × several batches per quote.
   - Omniston's `eth_getLogs` uses a lookback of up to 100k blocks.
   - LI.FI keyless `/quote` is about 75 per 2 h per IP (measured 2026-11-12, §4.2), not the 100/min of its other
     endpoints; the 30 s route refresh uses it up in well under an hour. The app cools LI.FI down after a 429
     (§4.2) and asks it for preview prices only through cp0x's keyed proxy, never against this keyless quota; asking
     LI.FI less often on the live auto-refresh is still an open product decision. Every venue that answers with a
     rate limit now also backs off in the engine's rounds (ARCHITECTURE D29).
8. **`suspendedChains` is static config.** There is no canary in a static SPA. To pause a corridor fast, serve
   `/config.json` from the host (no rebuild) with `nearIntents.suspendedChains` set to `HOT_OMNI_CORRIDORS` or a
   subset.
9. **Relay's durable record is fail-closed.** Browsers with blocked storage cannot use Relay. This is
   intentional, but say so in the UI.
10. **Pins drift.** LI.FI Flare's Diamond and THORChain routers are baked into code. A THORChain router migration
    refuses every EVM-source quote until an AWK release, or until a `trustedRouters` entry is added **in code**.
