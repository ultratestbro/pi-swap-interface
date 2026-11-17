# cp0x Swap: driving the AWK swap2 engine in the browser, and the wallet-account contract

Status: implementation spec, 2026-11-11. Sources read: AWK packages installed in `~/cp0x-elysium` (exact versions below), the mobile wallet `~/cp0x-elysium/apps/mobile/lib/{swap,send}`, cp0x-api `~/cp0x-elysium/apps/api/src/lib/crossChain/index.ts`. Line numbers refer to those files as of `756b115`; the `ENGINE` and `ROUTER` pins were re-read against this repo's installed swap2-core 0.14.0 and router 0.6.2 on 2026-11-15.

Short names used below:

- `CORE` = `~/cp0x-elysium/apps/mobile/node_modules/@anywalletkit/protocol-swap2-core/dist`
- `ROUTER` = `~/cp0x-elysium/apps/mobile/node_modules/@anywalletkit/protocol-swap2-router/dist`
- `ENGINE` = `CORE/chunk-KR2NO5BB.js` (BaseSwap2Protocol, the whole execution engine, 1470 lines; swap2-core 0.14.0)
- `M` = `~/cp0x-elysium/apps/mobile/lib`

---

## 0. Decisions at a glance

1. **Quotes**: one app-wide `CrossChainRouter` over the **real** provider instances (`lifiProvider()`, `relayProvider()`, …), built once. Quote with `router.getQuotes(params, {onUpdate})` exactly as mobile `engine.ts` does, but over real providers, not `remoteProvider` stubs. Do not use `RouterSwap2Protocol.quoteSwap2Routes`, because it drops `txRequest`, and the review needs `txRequest` for the spender, the native fee and gas.
2. **Execution**: for each Confirm, build `new RouterSwap2Protocol(gatedAccount, {fromChain, router: appRouter.only(provider), reviewExecution, onExecutionPhase})` and call `swap2({..., minAmountOut, slippage, recipient, refundAddress})`. Do **not** call `protocol.close()` afterwards: the providers are shared (see §2.5).
3. **The account is ours**: the engine reaches the wallet only through an object we build. That object is the browser's choke point. It replaces the kit `applyPolicies` wrapper that mobile uses.
4. **EVM account** = reads through `WalletAccountReadOnlyEvm` (public RPC) and writes through a viem `WalletClient` (wagmi). It exposes `getChainId()` read from the wallet and **no `chain` property**, so the engine's account-chain check asks the wallet. Never set `accountChain` or `skipAccountChainCheck`.
5. **Solana account** = the SDK's own `WalletAccountSolana`, with `externalSigner()` bridging to Wallet Standard `solana:signTransaction`. The SDK runs the full serialized-tx guard (`sendSerialized` → `checkSerialized`), simulation, the fee cap and the broadcast. The wallet only signs, and a signature over altered bytes fails the SDK's own verification. A local probe (§6.2) showed the bridge works end to end with `@solana/kit` 8.5.
6. **Gate**: port `M/swap/gate.ts` (`checkPlan`, `planWrites`, the arm/consume matcher, `executionConstraints`) almost verbatim, but as a **per-execution instance**. `reviewExecution` = `checkPlan` + arm. Every write method on the engine account must consume one armed write before anything touches the wallet. Refusals carry `answered: true`, so the engine never reports them as "maybe sent".
7. **Re-quote**: with swap2-core 0.14.0 (as since 0.10.3) the engine itself calls `reviewExecution` again (`requoted: true`) whenever the fresh plan differs. Mobile's `requotePlan` and `observeBuild` are not needed (§7.4).
8. **Hardening the browser adds**: a kind/family check and an optional pin check (the provider packages' `*Pins.callTargets/spenders`) on top of `checkPlan`. A revoke is allowed only after an approval for that token and spender was actually sent. `eth_call` simulation runs before each EVM wallet prompt. The wallet's current account must equal the reviewed refund address. A cross-tab `navigator.locks` lock covers each execution.
9. **EVM fee caps cannot be enforced** (the wallet picks the gas price). They are advisory only. Solana's fee cap **is** enforced (`transactionMaxFee`/`transferMaxFee` = 0.05 SOL), because we build the bytes the wallet signs.
10. **Ids** are `awk1.<provider>.<intentId>[.<srcHash>[.<dstHash>[.ok]]]`. `encodeId` is not exported, so copy it (§4.6).
11. **No-signer routes** (BTC/ZEC sources, shown as a QR code) bypass `swap2()`. Use `router.only(p).getQuotes({..., dry: false})` and track with `encodeId(provider, intentId)` (§9).

---

## 1. Packages, import paths, bundling

Pin exact versions (this repo's `package.json`, re-synced on every AWK bump; last 2026-11-15):

| package | version | used for |
|---|---|---|
| `@anywalletkit/core` | 0.9.0 | `externalSigner`, `UserRejectedError`, `TokenInfo`, `Swap2Options`… (peer of everything) |
| `@anywalletkit/protocol-swap2-core` | 0.15.0 | engine, types, errors (refusal reasons), `validQuote`, Permit2 (`/util`: `PERMIT2_ADDRESS`, `PERMIT2_TRANSFER_TYPES`, `appendPermit2Signature`) |
| `@anywalletkit/protocol-swap2-router` | 0.7.0 | `CrossChainRouter` (+ `lastRefusals`), `RouterSwap2Protocol`, `usdValue` |
| `@anywalletkit/swap2-assets` | 0.3.0 | catalog (`ccAsset`, `ccAssetByToken`, `CC_SOURCE_CHAINS`) |
| `@anywalletkit/tx-preview-evm` | 0.5.1 | dependency of the engine (`decodeCall`) |
| `@anywalletkit/wallet-evm` | 0.8.1 | `WalletAccountReadOnlyEvm` (reads, quotes, simulation) |
| `@anywalletkit/wallet-solana` | 0.6.3 | `WalletAccountSolana`, `serializedGuardFromExecution` |
| provider modules | lifi 0.8.4, relay 0.1.5, symbiosis 0.1.5, near-intents 0.3.8, chainflip 0.4.10, cctp 0.5.8, thorchain 0.4.4, usdt0 0.5.4, uniswap 0.4.8, curve 0.1.7, wrap 0.4.5, balancer 0.3.10, fynd 0.3.0, 0x 0.1.2 and across 0.1.1 (Standard only), jupiter 0.3.11, omniston 0.5.10 (2026-11-17: dependency bumps, plus fynd's redeployed TychoRouterV3 and Arc / Elysium; swap2-core 0.15 lets `etaSeconds` be `null`, read as an unknown ETA like 0) | the providers spec covers these |
| `viem` | one version, `2.57.x` (the version mobile resolves) | swap2-core needs `^2.45.0`. Dedupe with wagmi (`pnpm.overrides`) |

Exact imports. These are the subpath exports in each `package.json`:

```ts
import {CrossChainRouter, type RouteSet, type RankedQuote, type RouterOptions} from "@anywalletkit/protocol-swap2-router/router";
import {RouterSwap2Protocol, type RouterSwap2Config} from "@anywalletkit/protocol-swap2-router/swap2/router";
import {usdValue, quoteValues, type QuoteValue} from "@anywalletkit/protocol-swap2-router/value";
import {
  SWAP2_ID_PREFIX, swap2ChainId, nativeUnits,
  type Swap2EngineConfig, type Swap2ExecutionPlan, type Swap2ExecutionPhase, type Swap2ExecutionPhaseDetail,
  type SerializedExecutionExpectation,
} from "@anywalletkit/protocol-swap2-core/swap2/base";
import type {CrossChainProvider, Quote, QuoteParams, TxRequest, UnsignedTx, IntentRef, IntentStatus, RemotePins} from "@anywalletkit/protocol-swap2-core/types";
import {
  Swap2Error, Swap2QuoteError, Swap2ValidationError, Swap2ExecutionError, Swap2InFlightError,
  Swap2InsufficientGasError, Swap2MaybeSentError, Swap2FeeLimitError, Swap2StatusError,
  Swap2UnsupportedOperationError, Swap2ConfigurationError,
} from "@anywalletkit/protocol-swap2-core/errors";
import {validQuote, slippageFloor, SLIPPAGE_ROUNDING_BPS} from "@anywalletkit/protocol-swap2-core/validate";
import {WalletAccountReadOnlyEvm} from "@anywalletkit/wallet-evm";
import {WalletAccountSolana, WalletAccountReadOnlySolana, serializedGuardFromExecution, type SerializedExecutionInput, type SerializedTxGuard} from "@anywalletkit/wallet-solana";
import {externalSigner, UserRejectedError, type TokenInfo, type Swap2Options, type Swap2Result, type Swap2StatusResult} from "@anywalletkit/core";
```

Never import `@anywalletkit/protocol-swap2-core/server` (it is Node/backend code) or `/remote`. The browser has no backend, so there are no remote stubs.

Bundling notes:

- The engine imports `viem`, `@anywalletkit/tx-preview-evm` and `@anywalletkit/swap2-assets`. All are pure.
- No Node built-ins appear in core, router, wallet-evm or wallet-solana (checked: no `node:` or `crypto`/`buffer` imports).
- `protocol-swap2-omniston` imports `buffer` (`chunk-DMO24BFW.js:14,19`, `validators.js:569`) and needs server-side stores. Omniston is TON, so it is "later"; do not ship it in v1.
- Packages declare `engines.node >= 22`. Vite ignores this; do not enable `engine-strict`.

---

## 2. Quoting: `CrossChainRouter`

Implementation: `ROUTER/chunk-7ZUNB2U7.js`. Types: `ROUTER/router.d.ts`.

### 2.1 Constructor

```ts
declare class CrossChainRouter {
  constructor(providers: CrossChainProvider[], options?: string | RouterOptions); // string = weights
  get lastRejections(): readonly string[];
  get lastRefusals(): readonly Swap2Refusal[];   // router 0.6.0: the same, each {message, provider?, reason?, retryAfterMs?, httpStatus?}
  refusalsFor(params: QuoteParams): readonly Swap2Refusal[] | undefined; // one auction's own, keyed by its params object
  only(name: string): CrossChainRouter;
  describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null;
  getProvider(name: string): CrossChainProvider | undefined;
  hasProvider(name: string): boolean;
  hasEnabledProvider(name: string): boolean;
  supportsChain(caip2: string): boolean;
  supportsChainPair(fromChain: string, toChain: string): boolean;
  getBestQuote(params: QuoteParams, options?: {requireImmediateExecution?: boolean; prefer?: "best" | "fastest"}): Promise<RoutedQuote | null>;
  getQuotes(params: QuoteParams, options?: {requireImmediateExecution?: boolean; onUpdate?: (set: RouteSet) => void}): Promise<RouteSet | null>;
  trackIntent(providerName: string, ref: IntentRef): Promise<IntentStatus>;  // {state:"failed"} when not installed
  notifyDeposit(providerName: string, intentId: string, txHash: string): Promise<void>;
  close(): void;
}
interface RouterOptions {
  weights?: string;                                              // "price:0.6,speed:0.3,reliability:0.1" (default)
  valueUsd?: (quote: Quote, params: QuoteParams) => number | null; // net USD value of a quote; null = unpriced
  tieBand?: number;                                              // default 0.002; must be in [0, 1) or the ctor throws
}
```

Constructor behaviour (`chunk-7ZUNB2U7.js:57-104`):

- Every provider `name` must match `/^[A-Za-z0-9_-]+$/` and be unique, or the constructor throws.
- Each provider is **re-bound** into a plain record of bound methods and flags (`enabled`, `supportsRoute`, `getQuote`, `buildDeposit`, `trackIntent`, `preflightDeposit?`, `notifyDeposit?`, `registerSignedOrder?`, `buildClaim?`, `claimTargets?`, `remote`, `verifiesBuilds`, `verifiesQuotes`, `depositAddressRoutes`, `callTargets?`, `spenders?`, `close?`, `supportsChain?`, `supportsChainPair?`, `describeActivity?`, `supportsSameChain`).
- **Consequence:** to wrap a provider method (for example `buildDeposit`), do it *before* constructing the router. The factories return plain objects, so `{...p, buildDeposit}` works; mobile does this in `M/swap/engine.ts:67-78`.

### 2.2 `getQuotes(params, {onUpdate})`

Code: `chunk-7ZUNB2U7.js:192-288`.

1. **Eligibility.** A provider is eligible when `p.enabled() && p.supportsRoute({chain: sourceChain, token: sourceToken}, {chain: destChain, token: destToken})`. When `sourceChain === destChain`, only providers with `supportsSameChain === true` stay. With no eligible provider the call returns **`null`** (and `rejections` stays empty).
2. **Parallel calls with a timeout.** All eligible providers are called in parallel. Each gets its own `AbortController` and a timeout: **8 s** normally, or **25 s** when only one provider is eligible. The 25 s case is always the one for `only(name)`.
3. **Per-quote checks.** Each quote passes:
   - `validQuote(q, params, p.name)` (`CORE/chunk-QQSJPEYY.js:7-57`): the provider name matches; `sourceAmount === amountIn`; the amounts are positive integers with `min ≤ dest`; `min ≥ params.minAmountOut`; `min ≥ slippageFloor(dest, slippageBps)` (with 1 bp of rounding allowed); eta, reliability and feeUsd are finite; the fees are well-formed; the `txRequest` fields are well-formed; and **`validUntilMs > now`** (a quote with `validUntilMs` 0 is rejected).
   - `remotePinRefusal`, which is always `null` for local providers.
   - With `requireImmediateExecution`, quotes that have neither a `depositAddress` nor a `txRequest` are dropped.
4. **Rejections.** Each rejection is one line, prefixed `"<name>: <reason>"`. The reason comes from the provider's `params.onRefusal(reason)`, or `"returned no quote"`, or `"rejected by validation (minDest=… vs floor=…, validUntil=…, now=…)"`, or the thrown message (cut to 160 characters). The router logs `console.warn("swap2-router: …")` for validation and pin refusals.
5. **`onUpdate`.** After each provider settles, if at least one quote has been accepted, the router calls `onUpdate(rank(accepted, …, [...pending], rejections))`. Exceptions thrown by the observer are swallowed.
6. **Result.** It resolves to the final `RouteSet`, with `pending: []`, or **`null`** when nothing was accepted. Read `router.lastRejections` in that case (mobile `M/swap/engine.ts:176`). Since router 0.6.0 each rejection also comes classified (`RouteSet.refusals`, `lastRefusals`: the same text as `message`, plus the venue's `reason` — swap2-core 0.12.0's `Swap2RefusalReason` — when it gave one through `onRefusal(text, info)` or a tagged throw; the router classifies its own: `returned no quote` → `no_route`, a disabled venue → `policy_refused`, validation by `quoteRejection`). The web reads the refusals (`engine.ts` `view`, `requoteRoute`) and words a text its table doesn't know by that reason (refusals.ts `BY_REASON`, D28); its observer and wrappers pass `info` on with the text.
7. **No external `AbortSignal`.** To drop a stale round (the user typed again), guard the results with a generation counter.

```ts
interface RankedQuote extends Quote {
  netValueUsd: number | null;          // valueUsd result, or null when the auction compared raw outputs
  relativeValue: number;               // 0..1 against the best
  tags: ("best" | "fastest")[];
}
interface RouteSet {
  quotes: RankedQuote[];               // best first
  best: RankedQuote;                   // same object as one entry of quotes
  fastest: RankedQuote;
  pending: string[];                   // only non-empty in onUpdate snapshots
  rejections: string[];                // "name: reason" (== lastRejections at that moment)
  refusals: Swap2Refusal[];            // router 0.6.0: the same texts, each with the venue's Swap2RefusalReason when it gave one
}
```

### 2.3 Ranking (`rank`, `chunk-7ZUNB2U7.js:311-349`)

- **USD values.** If `valueUsd` is set, it is computed per quote; a throw or a non-finite result counts as null. When **every** quote is priced, `relativeValue = max(0, v) / max(v)`. If any quote is unpriced, the auction falls back to `minDestAmount / max(minDestAmount)` for all quotes.
- **Tie tier and best.** The tie tier is the quotes with `relativeValue ≥ 1 − tieBand`. `best` is the highest `w.price*rel + w.speed*etaScore + w.reliability*reliability` within the tier.
- **Fastest.** `fastest` is the lowest `etaSeconds`; a tie goes to the higher value.
- **Sort order.** `best` first, then `relativeValue` descending, then eta ascending.

`getBestQuote(params, {prefer})` (`:165-185`) runs `getQuotes` and returns `best` or `fastest` with a `routeScore` attached. The engine's `resolveQuote` uses it (`ROUTER/chunk-VSASJ3WV.js:29-31`).

### 2.4 Value and gas (`ROUTER/chunk-VAOFSGCX.js`)

```ts
declare function usdValue(prices: Readonly<Record<string, number>>, options?: {gasUsd?: (quote: Quote, params: QuoteParams) => number | null}): (quote: Quote, params: QuoteParams) => number | null;
declare function quoteValues(prices, params: Pick<QuoteParams,"sourceChain"|"sourceToken"|"destChain"|"destToken"|"amountIn">, quotes: readonly {provider; destAmount; txRequest?; providerData?}[], options?: {betterByPct?: number}): QuoteValue[];
```

`usdValue` (`:21-43`) prices a quote as follows:

1. Start from `minDestAmount` at the price of the destination catalog asset (`ccAssetByToken(destChain, destToken)`). Prices are keyed by symbol; a `W`-prefixed symbol falls back to its unwrapped form, and stablecoins default to $1.
2. Subtract the declared native fee at the price of the source chain's native coin: `txRequest.nativeFee`, or `providerData.nativeFee` when the quote has no `txRequest` (`declaredNativeFee`, `:15-20`; router 0.5.5). That second source is a price-only quote: LI.FI 0.8.0 and USDT0 0.5.0 return one for a dry quote priced for a placeholder sender or recipient, so preview rounds are still ranked net of the bridge fee. A `providerData.nativeFee` that is not a base-unit integer leaves the quote unpriced.
3. Subtract `gasUsd(q)`.

The function returns null when a price it needs is missing, and one null quote turns USD ranking off for the whole set. Mobile therefore makes `gasUsd` return 0 rather than null.

`quoteValues` gives USD in, USD out, loss percentage and a better alternative, for "be careful" warnings. It is optional UI.

The mobile ranking constants (copy them):

- `M/swap/gas.ts:51`: `ROUTER_RANKING = {weights: "price:0.7,speed:0.3,reliability:0", tieBand: 0.0005}`.
- The gas term is `gasPricer` (`gas.ts:41-44`): units from the quote's `gasLimit`, plus 55k for an approval, priced with `eth_gasPrice` (mobile caches it 20 s, 2.5 s timeout: `engine.ts:85-101`).

### 2.5 Lifecycle: `only()` and `close()` with shared providers

- `only(name)` (`chunk-7ZUNB2U7.js:106-110`) builds a **new** router over the *same bound provider records*. `close()` calls every provider's `close?.()`.
- Mobile can close freely, because its stubs are created per call (`engine.ts:178,195`). The browser shares real provider instances; today only Omniston implements `close` (it closes its WebSocket). Rules:
  - Build the provider registry and `appRouter` once (a module singleton).
  - Call `appRouter.close()` only on `pagehide`.
  - Never call `protocol.close()` or `router.only(x).close()` after a quote or an execution.
- Module-level one-shot records survive inside the page and are lost on reload. Relay's "one deposit per order" record (`relayClearOrder`, `protocol-swap2-relay/dist/chunk-C3I2XYSW.js:29`, called at build/sign time) is one of them. The UI must never resubmit a quote object restored from storage after a reload.

### 2.6 Browser `engine.ts`, ported from `M/swap/engine.ts`

```ts
// src/lib/swap/engine.ts
import {CrossChainRouter, type RouteSet} from "@anywalletkit/protocol-swap2-router/router";
import {usdValue} from "@anywalletkit/protocol-swap2-router/value";
import type {CrossChainProvider, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {ROUTER_RANKING, gasPricer, type QuoteGasLike} from "./gas";            // copied from M/swap/gas.ts
import {orderRoutes, parseRejections, tagRoutes, toRouteView, type RouteView} from "./routes"; // copied
import {destTokenId, type SwapToken} from "./tokens";
import {buildProviders} from "./providers";                                   // providers spec: real instances

let registry: CrossChainProvider[] | null = null;
let shared: CrossChainRouter | null = null;
/** Every installed provider, built once. Never closed except on pagehide. */
export function appProviders(): CrossChainProvider[] { return (registry ??= buildProviders()); }
/** The router for discovery, tracking and `only()`; unpriced. */
export function appRouter(): CrossChainRouter { return (shared ??= new CrossChainRouter(appProviders(), ROUTER_RANKING)); }
addEventListener("pagehide", () => shared?.close());

/** A priced auction over the same instances (valueUsd differs per request, so build one per round; do NOT close it). */
function pricedRouter(prices?: Readonly<Record<string, number>>, gasUsd?: (q: QuoteGasLike) => number): CrossChainRouter {
  const valueUsd = prices && Object.keys(prices).length ? usdValue(prices, gasUsd ? {gasUsd: (q) => gasUsd(q)} : undefined) : undefined;
  return new CrossChainRouter(appProviders(), {...ROUTER_RANKING, ...(valueUsd ? {valueUsd} : {})});
}

export interface QuoteRequest { from: SwapToken; to: SwapToken; amountIn: bigint; slippageBps: number; recipient?: string }

/** Same as M/swap/engine.ts:120-134. destAddress must be a valid address on destChain even for dry quotes (some venues refuse ""). */
export function quoteParams({from, to, amountIn, slippageBps, recipient}: QuoteRequest): QuoteParams {
  return {
    sourceChain: from.caip2, sourceToken: from.catalogSymbol,
    destChain: to.caip2, destToken: destTokenId(to),
    amountIn: amountIn.toString(), slippageBps,
    destAddress: recipient ?? to.owner, refundAddress: from.owner,
    dry: true,
  };
}

export interface RouteSnapshot { routes: RouteView[]; pending: string[]; rejections: {provider: string; reason: string}[] }

let generation = 0;
export async function quoteRoutes(req: QuoteRequest, onUpdate: (s: RouteSnapshot) => void, prices?: Readonly<Record<string, number>>): Promise<RouteSnapshot | null> {
  const mine = ++generation;
  const gas = await sourceGas(req, prices);                // port of engine.ts:104-109 (public RPC eth_gasPrice, 20 s cache)
  const router = pricedRouter(prices, gas);
  const source = {chain: req.from.caip2, isToken: req.from.contract !== null};
  const view = (set: RouteSet): RouteSnapshot => ({
    routes: orderRoutes(set.quotes.map((q) => toRouteView(q, source, gas))),
    pending: [...set.pending],
    rejections: parseRejections(set.rejections, req.from),
  });
  const set = await router.getQuotes(quoteParams(req), {onUpdate: (s) => { if (mine === generation) onUpdate(view(s)); }});
  if (mine !== generation) return null;                     // superseded
  return set ? view(set) : {routes: [], pending: [], rejections: parseRejections(router.lastRejections, req.from)};
}

/** The one route under review, re-quoted (dry). M/swap/engine.ts:183-198. */
export async function requoteRoute(req: QuoteRequest, provider: string, prices?: Readonly<Record<string, number>>) {
  const router = appRouter().only(provider);
  const gas = await sourceGas(req, prices);
  const set = await router.getQuotes(quoteParams(req));
  const q = set?.quotes.find((x) => x.provider === provider);
  if (q) return {route: tagRoutes([toRouteView(q, {chain: req.from.caip2, isToken: req.from.contract !== null}, gas)])[0]!, reason: null};
  return {route: null, reason: parseRejections(router.lastRejections, req.from)[0]?.reason ?? "no route right now"};
}
```

With real providers, `providersFor` and `providerServesRoute` (`M/swap/providers.ts:217-255`) are not needed for routing. Each provider's own `supportsRoute` decides. Keep `PROVIDER_NAMES`, `TWO_PHASE` and `orderSpender` (`providers.ts:35-101`) for the UI.

The web differs from this sketch on addresses (ARCHITECTURE D7): `quoteParams` takes the request's explicit
`recipient` and `refundAddress` and throws on a blank one, never `to.owner`; the prices shown before those exist are a
separate preview round (§2.7).

### 2.7 Preview rounds (web, 2026-11-12; ARCHITECTURE D7, D29)

`quoteRoutes(r: RoutesRequest, onUpdate, prices?, signal?)` takes `{mode: "live", req: QuoteRequest}` or
`{mode: "preview", req: PreviewRequest}`; every snapshot carries the round's `mode`.

- The SDK has no address-free quote: `QuoteParams.destAddress` is a required string and `dry: true` is "pricing
  preview only" (`CORE/types.d.ts`). The router's quote stage never compares addresses (`getQuotes` / `validQuote`,
  router `chunk-7ZUNB2U7.js:192-271`), and every build- and execution-time recipient/refund check stays as it is, so a
  preview round needs no weakened check — only per-venue addressing, kept inside the round.
- The router gets `previewBaseParams(req)` (`src/swap/preview.ts`): `destAddress` = the real recipient or `""`,
  `refundAddress` = the real refund address or ABSENT (never `""`: NEAR reads `refundAddress ?? its placeholder`),
  `dry: true`. `quoteParams` is never used for a preview (it throws on its `preview: true` brand).
- A preview round first waits for cp0x's health answer (`proxy.settled()`, 3 s at most; at once off Standard). The
  per-round delegate (the one that already observes each venue settling) does, per venue: `previewSkip` — LI.FI and
  Fynd only while cp0x's proxy carries them with cp0x's key (`proxy.live(name)`, read per round, 2026-11-13), else
  they refuse at once with "asked only for your live quote: previews ask it only while cp0x's proxy carries it with
  cp0x's key" (nothing sent; category `deferred`, a quiet "Quoted after you connect" row); Jupiter and Wrap refuse
  with the signer-only text when the user turned "Send to another address" on — else
  `p.getQuote({...qp, ...previewAddressing(p.name, req), onRefusal}, signal)`, LI.FI's and Fynd's signal a fresh one
  marked `keyedOnly` (the routing never sends it keyless from an unused or stopped slot; only the one retry after a
  failure at the proxy, once per slot and page). Spreading the router's frozen per-venue params keeps its `onRefusal`
  recorder. `previewAddressing` fills a blank destination with the destination family's sample only for `uniswap`,
  `curve`, `balancer`, `thorchain`, `chainflip`, `near_intents`, `fynd`, and for `lifi` Solana → EVM (providers.md
  §4.16); every other venue keeps its blank address and its own handling (Relay's placeholder flag, CCTP's own EVM
  placeholder; USDT0's own stand-in, priced but returned without its transaction since usdt0 0.5.0; LI.FI EVM → Solana
  prices for its own Solana placeholder, likewise price-only since lifi 0.8.0).
- Only `WebRoute`s leave the engine (`toWebRoute` drops calldata). `requoteRoute` and `issueDeposit` take a
  `QuoteRequest` only; a preview handed to them anyway fails in `quoteParams` / at `issueDeposit`'s first line.
- Measured address independence (2026-11-12, live, read-only): THORChain ETH→BTC 0.1 ETH quoted the same
  `expected_amount_out` (275 428) for a blank destination and two different `bc1q…` addresses, fees identical;
  Jupiter 0.1 SOL→USDC moved 0.005 % between two takers 3 s apart (market). LI.FI could not be re-measured (its
  keyless `/quote` budget on the probe IP was spent); Relay and 1Click are POST quotes and were not probed.
- In both modes a round first waits up to `LAZY_WAIT_MS` (2 s) for a provider still loading (Omniston's chunk,
  `lazyLoads`) before it picks the venues to ask; one still loading after that sits the round out, uncounted.
- In both modes the delegate also skips a venue that is backing off after a rate limit (`src/swap/limiter.ts`, D29) and
  feeds the back-off from each venue's refusals (`RATE_LIMITED`) and quotes. Every refusal the round makes itself
  (preview skip, back-off; nothing sent) comes out with `skipped: true`, so `venuesUnreachable` counts only venues that
  were asked.
- A preview round's refusal texts go through `scrubSamples` (`preview.ts`) before `parseRejections`: a venue that
  repeats the sample it was quoted for (THORChain's "memo failed verification (=:BTC.BTC:bc1qar0…)", a 1Click
  message naming the recipient) shows `<sample-address>`; the user's own addresses are kept. Live texts are untouched.

---

## 3. Executing: `RouterSwap2Protocol`

Implementation: `ROUTER/chunk-VSASJ3WV.js` (router 0.5.5 freezes a shallow copy of the config, `:27`). Types: `ROUTER/swap2/router.d.ts`. Engine base: `ENGINE`.

### 3.1 Constructor and config

```ts
declare class RouterSwap2Protocol extends BaseSwap2Protocol {
  constructor(account: Swap2Account | undefined, config: RouterSwap2Config);   // Swap2Account = unknown
  quoteSwap2(options: Swap2Options): Promise<Swap2Quote>;
  quoteSwap2Routes(options: Swap2Options, opts?: {onUpdate?: (routes: Swap2Route[], pending: string[]) => void}): Promise<Swap2Route[]>;
  using(provider: string): RouterSwap2Protocol;
  swap2(options: Swap2Options, config?: Swap2ProtocolConfig): Promise<Swap2Result>;
  getSwap2Status(id: string, _options?: Swap2StatusOptions): Promise<Swap2StatusResult>;
  claimSwap2(id: string, account: Swap2Account): Promise<{hash: string; chain: string; id: string}>;
  close(): void;   // router.close() → provider.close()
}
interface RouterSwap2Config extends Swap2EngineConfig {
  providers?: CrossChainProvider[];   // exactly one of providers / router, else the ctor throws
  router?: CrossChainRouter;
  weights?: string; valueUsd?: RouterOptions["valueUsd"]; tieBand?: number;  // only used with `providers`
  prefer?: "best" | "fastest";        // what swap2() executes when several routes answer
}
```

- The constructor (`chunk-VSASJ3WV.js:13-28`) runs `toCaip2(config.fromChain)`. A bare number becomes `eip155:<n>`, and genesis-hash ids are aliased: `solana:5eykt…` → `solana:mainnet`, `tron:0x2b6653dc` → `tron:728126428`, `bip122:0000…e93` → `bitcoin:mainnet` (`ENGINE:328-349`).
- It freezes the config (`ENGINE:476-482`) and stores the account as is: `ProtocolBase` keeps `this._account` and `this._config` and does no validation.
- `account: undefined` gives a quote-and-track-only protocol: `swap2` throws `Swap2ExecutionError` (`ENGINE:705-708`).

### 3.2 `swap2(options)` input

```ts
// @anywalletkit/core (index-BCwDQpBU.d.ts:434-482), exact-in only for this engine
type Swap2Options = {
  fromToken: string;            // catalog SYMBOL for listed tokens (mobile passes from.catalogSymbol), or contract/mint
  fromTokenDecimals?: number;   // only for unlisted tokens (allowUnlistedTokens)
  toToken: string;              // destTokenId(to): contract / mint, or 0x000…000 for a native coin
  toTokenDecimals?: number;     // unlisted destination tokens only
  toChain?: string | number;    // omit for same-chain
  recipient?: string;           // ALWAYS pass it (cross-family: the engine's default is the source address!)
  refundAddress?: string;       // ALWAYS pass it (= source owner)
  slippage?: number;            // decimal; reviewed bps / 10_000
  minAmountOut?: bigint | number; // REQUIRED by swap2(): `requireExecutionFloor` (ENGINE:455-460)
  fromTokenAmount: bigint | number;
};
```

Mobile builds these options in `M/swap/execute.ts:237-245`:

```ts
protocol.swap2({
  fromToken: from.catalogSymbol,
  toToken: destTokenId(to),
  ...(to.caip2 !== from.caip2 ? {toChain: to.caip2} : {}),
  fromTokenAmount: reviewed.amountIn,
  recipient: reviewed.recipient,
  refundAddress: reviewed.refundAddress,
  ...executionConstraints(reviewed),   // {minAmountOut: r.minOut, slippage: r.slippageBps / 10_000}
});
```

- `minOut = executionFloor(route.minDestAmount)` = the dry minimum less 50 bps (`M/swap/math.ts:54-59`). The review screen shows this floor as "Minimum received" (`app/swap/review.tsx:112`).
- The engine refuses a live quote whose minimum is below `minAmountOut`, twice: the router's `validQuote` and `assertQuoteConstraints` (`ENGINE:422-437`). The refusal surfaces as `"no route available for the requested pair :: <provider>: rejected by validation (minDest=… vs floor=…)"`.
- Do not pass the second argument (`Swap2ProtocolConfig` `maxNetworkFeeBps`/`maxProtocolFeeBps`). Those caps need itemized `fees`, which many providers lack (`ENGINE:614-640`), and the swap would be refused with `Swap2FeeLimitError`.

### 3.3 Order of operations inside `swap2()`

This sequence determines the UI phases and when wallet prompts appear (`ENGINE:704-1208`).

| # | step | code | account calls | wallet prompt | phase |
|---|---|---|---|---|---|
| 0 | read-only account → `Swap2ExecutionError`; no `minAmountOut` → Error; an identical swap in flight on **the same account object** → `Swap2InFlightError` | 704-721 | `typeof sendTransaction` | — | — |
| 1 | account chain check (§5.1) | 586-600, 725 | `chain`/`getChainId`/… | — | — |
| 2 | `selfAddress = getAddress()`; recipient and refund default to it; `prepareOptions` (unlisted decimals) | 726-729 | `getAddress`, (`getTokenInfo`) | — | — |
| 3 | **live quote** `resolveQuote(toParams(opts, dry=false))` = `router.getBestQuote` (≤25 s for `only`) → `Swap2QuoteError("no route … :: rejections")` | 730-735 | — | — | (show "Preparing…") |
| 4 | provider registered and enabled; `buildDeposit(q)`; payload consistency (serialized vs data vs bodyBoc vs typedData; build == quote `txRequest`, or == deposit address and memo); chain id; memo and calldata are only allowed on families that support them | 736-810 | `typeof sendSerializedTransaction` | — | — |
| 5 | an EVM ERC-20 deposit-address route is rewritten into `transfer(depositAddress, amount)` calldata on the token; non-EVM token routes become `account.transfer` | 811-836 | — | — | — |
| 6 | value checks: serialized `value` = 0 or the input; ERC-20 `value` = the declared `nativeFee`; native `value` = input + `nativeFee`; `nativeFee ≤ nativeFeeCap()`: `NATIVE_FEE_CAP[chain]`, or the app's `nativeFeeCeiling` answer (swap2-core 0.11.0; this app: 0.01 ETH for USDT0's Legacy Mesh into Tron from Ethereum / Arbitrum, the chain's cap elsewhere) | 841-857, 140-203 | — | — | — |
| 7 | TON cell body checks; remote-pin checks (not ours); typed-order shape (`primaryType: "Order"`, `verifyingContract` = the approval address, maker = self, makerAsset = source token, `makingAmount` = input, domain chainId) | 858-898, 215-243 | `getJettonWalletAddress` (TON) | — | — |
| 8 | EVM calldata decode (`decodeCall`): never Permit2 or `setApprovalForAll` as the main call; `transfer`/`approve` only on the source token, ≤ the input, to self, the deposit address or the spender; never `transferFrom` | 917-943 | — | — | — |
| 9 | allowance: `getAllowance(token, spender)`. If ≠ the input, approvals = `[0n?, input]` (the 0 reset only for USDT on eip155:1 when the current allowance is non-zero **or unknown**). A missing or throwing `getAllowance` counts as unknown, so the engine approves | 944-975 | `getAllowance` | — | — |
| 9a | **Permit2 signature transfer** (swap2-core 0.13.0; a quote whose `txRequest` carries `permit2Transfer`, 0x's Settler): `readPermit2Transfer` holds the payload to the source chain's Permit2 domain, the source token, exactly the input, the called contract as the only spender, a deadline ≤ 1 h away; refused with a native input, a native value or `nativeFee` alongside, an `approvalAddress` that is not canonical Permit2, the account as spender, a quote valid past the deadline. The plan's `source` (`call`) carries the REBUILT payload as `permit2Transfer`; a standing Permit2 allowance that covers the input is left as is (no approval) | 899-916, 974 | — | — | — |
| 9b | `ownGas`: a Permit2 call, or any EVM call of a provider that declares `ownGasEstimate` (0x's native sales), goes out with the account's own estimate — the plan shows no `gasLimit` and the quoted one is never sent | 916-917 | — | — | — |
| 10 | **`reviewExecution(plan)`** with a deep-frozen copy of the plan. A throw aborts with nothing sent. After it returns, an expired quote → `Swap2QuoteError("quote expired during review")` | 976-1021 | — | — | — |
| 11 | EVM gas pre-check: sum of `quoteSendTransaction(approve)` fees, plus the main call's fee (an estimate failure counts as 0 if approvals come first, otherwise it throws), plus `value`, compared with `getBalance()` → `Swap2InsufficientGasError` | 1023-1039, 1257-1275 | `getBalance`, `quoteSendTransaction` | — | — |
| 11a | Permit2: `signTypedData({domain, types, primaryType: "PermitTransferFrom", message})` of the rebuilt payload **before** any approval (a deadline already passed → `Swap2QuoteError`), then `appendPermit2Signature` (`data ++ uint256(len) ++ sig`); a refusal here costs no approval (a re-quote pass revokes the one it holds) | 1029-1039, 1213-1220 | `signTypedData` | **sign typed data** | `signing` (the web's runner records it as stage `permit`: off-chain, nothing sent — D38) |
| 12 | approvals, each `sendTransaction({to: token, data: approve(spender, amt), value: 0n, chainId?})` then `waitForTransaction(hash)`. On any failure: `revokeApproval()` (approve 0), then rethrow | 1040-1064 | `sendTransaction`, `waitForTransaction` | **1–2 × approve**, then possibly a **revoke** | `approving {index, total}` |
| 13 | quote expired after approvals → **re-quote** once (recursive `executeSwap2` with `carried` = the allowance handoff); otherwise revoke and `Swap2QuoteError("quote expired before source broadcast")` | 1065-1080 | — | — | `requoting` |
| 14 | provider still enabled; `preflightDeposit(q, unsigned)` (THORChain vault revalidation, Relay one-shot) → on throw: revoke, rethrow | 1081-1094 | — | — | `preflight` (only if the provider has it) |
| 15a | typed order: `signTypedData({domain (chainId → number), types minus EIP712Domain, primaryType, message})` → `registerSignedOrder` → returns `id` **without** a hash. No `signing`/`broadcast` phases | 1095-1127 | `signTypedData` | **sign typed data** | — |
| 15b | serialized: `sendSerializedTransaction(tx, expect)`; token deposit (non-EVM): `transfer({token, recipient, amount, memo?})`; otherwise `sendTransaction({to, data?, value, chainId?, gasLimit?, body?/memo?})` | 1128-1178 | one of those | **the swap** | `signing` |
| 15c | `ownGas` (9b): before the main `sendTransaction`, `dryRunCall` estimates the exact call (a Permit2 call WITH its signature) from the account: a revert → `Swap2ExecutionError` `simulation_failed`, an RPC that doesn't answer twice → `upstream_unavailable`; either revokes. The call then goes out without `gasLimit` | 1129-1137, 1226-1247 | `quoteSendTransaction` | — | `signing` |
| 16 | missing `hash` → `Swap2ExecutionError`. On a throw: `maybeSent(err)` → `Swap2MaybeSentError(hash?, id?)` with **no revoke**; otherwise revoke and rethrow | 1179-1194 | — | maybe a **revoke** | `broadcast {hash}` |
| 17 | `notifyDeposit(intentId, hash)` (errors swallowed); return `{id: awk1.<p>.<intent>.<hash>, hash, transactions:[{hash,type:"source"}], fees, fromTokenAmount, toTokenAmount, toTokenAmountMin}` | 1195-1207 | — | — | — |

### 3.4 Other methods

- `getSwap2Status(id)` (`ENGINE:1277-1282`): `decodeId` → `providerFor(name)` (throws `"no swap2 found for id"` if the provider is not in the router) → `provider.trackIntent({intentId, sourceTxHash?, destTxHash?, destTxConfirmed?})`. The result goes through `mapStatus` (`:461-464`) and becomes `{status, transactions?: [{hash: destTxHash, type: "destination"}]}`. No account is needed.
- `claimSwap2(id, destAccount)` (`ENGINE:1293-1369`) handles two-phase routes (CCTP). It requires `provider.buildClaim` and an account with `sendTransaction`. The claim must:
  - be EVM calldata on `unsigned.chain` with no value, no approval and no serialized payload;
  - have `to ∈ provider.claimTargets(chain)`;
  - not decode as a transfer or approve.

  The destination account chain is checked with `readAccountChain(destAccount)`, which ignores `config.accountChain`, so the wallet must already be on the destination chain. The engine then sends `{to, data, value: 0n, chainId: Number, gasLimit?}` and calls `waitForTransaction`. A revert (`err.code === "reverted"` or `/reverted/`) becomes `Swap2ExecutionError`; a timeout keeps `confirmed = false`. It returns `{hash, chain, id: awk1.<p>.<intent>.<src>.<claimHash>[.ok]}`. Keep polling with **that** id.
- `quoteSwap2(options)` (`ENGINE:686-694`) returns one checked `Swap2Quote`. `quoteSwap2Routes` and `using(provider)` exist, but `Swap2Quote` has no `txRequest`, so the review cannot be built from them. Use `router.getQuotes` (§2.6), as mobile does.
- `bridge()` and `swap()` are legacy wrappers. Don't use them.

### 3.5 How mobile wires this (`M/swap/execute.ts`, `M/swap/engine.ts`)

- `protocolFor(provider, fromChain, account, config, observeBuild)` (`engine.ts:201-209`) = `new RouterSwap2Protocol(account, {...config, fromChain, router: remoteRouter([provider], undefined, observeBuild)})`. **The browser replaces `remoteRouter([provider])` with `appRouter().only(provider)`.**
- `executeSwap` (`execute.ts:178-252`):
  1. Opens a one-off keyring account wrapped by kit `applyPolicies(raw, swapPolicies(...))`, then `engineAccount` (per-chain shims, `:126-158`).
  2. Passes the config `{accountChain, tonGasCeiling: TON_BODY_GAS, decodeTonBody, reviewExecution: arm, onExecutionPhase}`.
  3. Uses `arm(plan)` = `checkPlan` → `planWrites` → `armSwap`.
  4. Arms `requotePlan` from a build observer during `requoting`.
  5. Calls `disarmSwap()`, `dispose()` and `close()` in `finally`.
- Browser differences:
  - There is no keyring and no `applyPolicies`; our gated account replaces both.
  - **No `accountChain`**, because the live wallet chain is the identity.
  - No build observer (§7.4).
  - No `close()`.

---

## 4. swap2-core types and engine config

### 4.1 Provider-facing types (`CORE/types.d.ts`, comments trimmed)

```ts
interface Asset { chain: string; token: string }
interface QuoteParams {
  onRefusal?: (reason: string) => void;   // local only, per call
  sourceChain: string; sourceToken: string; sourceDecimals?: number;  // sourceDecimals only for unlisted tokens
  destChain: string; destToken: string;
  amountIn: string;                       // base units, exact in
  minAmountOut?: string; slippageBps?: number;
  destAddress: string; refundAddress?: string;
  dry?: boolean;                          // pricing only: no deposit address minted upstream
  flex?: boolean;                         // 1Click FLEX_INPUT (exchange flow)
}
interface TxRequest {
  to?: string; data?: string; value?: string; chainId?: number; gasLimit?: string;
  approvalAddress?: string;               // ERC-20 spender
  nativeFee?: string;                     // native coin charged ON TOP of the input (bridge messaging fee)
  serializedTx?: string;                  // Solana base64 wire tx
}
interface Quote {
  provider: string; intentId: string;
  depositAddress: string; depositMemo: string | null;
  txRequest?: TxRequest;
  sourceAmount: string; destAmount: string; minDestAmount: string;
  destDecimals?: number;
  feeUsd: number;
  fees?: {type: "network" | "protocol" | "affiliate" | "other"; amount: string; token: string; included: boolean; description?: string}[];
  etaSeconds: number; reliability: number; validUntilMs: number;
  providerData?: Record<string, string>;  // e.g. priceImpactBps
}
interface UnsignedTx {
  chain: string; to: string; value: string; data?: string; chainId?: number; gasLimit?: string;
  approvalAddress?: string; serializedTx?: string;
  memo?: string; memoEncoding?: "utf8" | "hex";
  bodyBoc?: string; stateInitBoc?: string;           // TON
  typedData?: string; orderExtension?: string;       // gasless EIP-712 orders (Omniston EVM source)
}
interface IntentRef { intentId: string; sourceTxHash?: string | null; destTxHash?: string | null; destTxConfirmed?: boolean }
type IntentState = "pending" | "action-required" | "refund-pending" | "partial" | "completed" | "failed" | "refunded" | "cancelled" | "expired";
interface IntentStatus { state: IntentState; depositReceived?: boolean; destTxHash?: string; claim?: {chain: string; ready: boolean} }
```

`CrossChainProvider` is the full interface in `CORE/types.d.ts:259-347`. The engine uses `name`, `enabled`, `supportsRoute`, `getQuote`, `buildDeposit`, `preflightDeposit?`, `trackIntent`, `notifyDeposit?`, `registerSignedOrder?`, `buildClaim?`, `claimTargets?`, `supportsSameChain`, `supportsChain?` and `supportsChainPair?`. The remote flags apply to stubs only.

### 4.2 `Swap2EngineConfig` (`CORE/swap2/base.d.ts:88-168`), with the browser decision for each option

| option | meaning (engine line) | browser value |
|---|---|---|
| `fromChain: string` | source CAIP-2; aliased (`toCaip2`) | the catalog id (`eip155:8453`, `solana:mainnet`) |
| `reviewExecution?: (plan) => void \| Promise<void>` | called once the live build passes every check, **before** any approval or signature (915-959). Throw to abort. Called again with `requoted: true` on a re-quote that changed the plan | **required**: `checkPlan` + arm (§7) |
| `onExecutionPhase?: (phase, detail?) => void` | `approving{index,total}` / `requoting` / `preflight` / `signing` / `broadcast{hash}`; observer throws are swallowed (468-475) | progress UI |
| `accountChain?: string` | **short-circuits** the chain check: `readAccountChain` returns it without asking the account (281-282) | **never set**. Mobile sets it because its SDK account is bound by config |
| `skipAccountChainCheck?: boolean` | disables the check (553) | never |
| `decodeTonBody?: (boc) => unknown` | TON cell bodies; without it, cell-body deposits fail closed (757-765) | TON phase only (mobile: `execute.ts:219-223`) |
| `tonGasCeiling?` | max nanoTON a cell-body deposit attaches (default 1 TON, 222-223, 821-842) | TON phase: `500_000_000n` (`M/swap/gate.ts:249`) |
| `serializedNativeAllowance?` | lamports a provider-built Solana tx may cost on top of the input (default `20_000_000n`, 0.02 SOL; 222, 1059-1063) | default |
| `allowUnlistedTokens?: boolean` | trade tokens not in the catalog; reads decimals via `account.getTokenInfo` (484-522) | `false` in v1 |
| `maxNetworkFeeBps` / `maxProtocolFeeBps` | fee caps, need itemized fees (566-596) | unset |
| `nativeFeeCeiling?: (ctx) => bigint \| undefined` | per-execution native-fee cap in place of `NATIVE_FEE_CAP[chain]`, ≤ 20× it; asked before the review and approvals, and again on a re-quote pass, where a refusal revokes (swap2-core 0.11.0, `ENGINE:141-203`) | `execute.ts` `nativeFeeCeiling`: 0.01 ETH for provider `usdt0`, dest `tron:728126428`, intent `usdt0-mesh:<src>:30420`, from `eip155:1` / `eip155:42161`; `undefined` (the chain's cap) for every other route (owner's decision, 2026-11-13; §4.7) |
| `RouterSwap2Config.router` | one-provider router | `appRouter().only(reviewed.provider)` |
| `RouterSwap2Config.prefer` | `best`/`fastest` | unset (a single provider) |

### 4.3 `Swap2ExecutionPlan` (what `reviewExecution` receives, `base.d.ts:181-239`)

```ts
interface Swap2ExecutionPlan {
  provider: string; fromChain: string; destChain: string; destToken: string;
  recipient: string; refundAddress: string;
  sourceAmount: bigint; destAmount: bigint; minDestAmount: bigint;
  feeUsd: number; etaSeconds: number; validUntilMs: number;
  approvals: {token: string; spender: string; amount: bigint; chainId?: number}[];  // in order; [] on a re-quote
  requoted?: true;
  source:
    | {kind: "call"; to: string; data?: string; value: bigint; chainId?: number; gasLimit?: bigint;
       memo?: string; memoEncoding?: "utf8" | "hex"; cellBody?: boolean; cellBodyDecoded?: TonBodySummary;
       permit2Transfer?: string}  // swap2-core 0.13.0: the rebuilt EIP-712 PermitTransferFrom the account signs first (0x)
    | {kind: "token-transfer"; token: string; recipient: string; amount: bigint; memo?: string; memoEncoding?: "utf8" | "hex"}
    | {kind: "serialized"; serializedTx: string}
    | {kind: "typed-order"; typedData: string};
}
type Swap2ExecutionPhase = "approving" | "requoting" | "preflight" | "signing" | "broadcast";
interface Swap2ExecutionPhaseDetail { index?: number; total?: number; hash?: string }
```

Which `source` kind each route produces (`ENGINE:995-1005`):

| route | `source` |
|---|---|
| EVM calldata route (LI.FI, Relay, Uniswap…) | `call` with `data` |
| EVM native deposit-address route | `call`, no `data`, `value` = input |
| EVM ERC-20 deposit-address route | `call` to the **token contract** with `transfer(depositAddress, amount)` data and `value 0` |
| Solana SOL deposit | `call` `{to, value}` |
| SPL / jetton / TRC-20 deposit | `token-transfer` |
| Jupiter or a LI.FI Solana leg | `serialized` |
| Omniston EVM-source order | `typed-order` |
| 0x token sale (Permit2, D38) | `call` to the registry Settler with `data` (before its signature), `value 0`, and `permit2Transfer` — the rebuilt PermitTransferFrom; approvals only to canonical Permit2 |
| 0x native sale, Across deposit | `call` with `data` (`value` = the input for a native coin) |

The plan's identity for the re-quote comparison is `reviewedIdentity` (`ENGINE:273-276`): the whole plan minus `feeUsd`, `etaSeconds`, `validUntilMs`, `approvals`, `destAmount` and `requoted`.

### 4.4 `SerializedExecutionExpectation` (handed to `sendSerializedTransaction`, `base.d.ts:246-277`, built at `ENGINE:1144-1150`)

```ts
interface SerializedExecutionExpectation {
  maxValueOut: string;                                  // (source native ? input : 0) + serializedNativeAllowance
  tokenIn?: {token: string; minAmount: string};         // same-chain only: destToken, q.minDestAmount
  source?: {token: string; maxAmount: string};          // token source: mint, q.sourceAmount
  bridgeOut?: {destChain: string; recipient: string; destToken: string; minAmountOut: string;
               destDecimals?: number; slippageBps?: number};  // cross-chain only (bridgeOutOf, 416-432)
}
```

It is structurally compatible with wallet-solana's `SerializedExecutionInput`. Map it **only** with `serializedGuardFromExecution(expect)`. A hand-written mapping that drops `bridgeOut` checks a bridge against the SOL ceiling only (mobile comment, `execute.ts:131-133`).

### 4.5 Errors (`CORE/errors.d.ts`, `CORE/chunk-UD3CJFBY.js`)

All of these extend `Swap2Error extends Error {code: Swap2ErrorCode}`, with `name = class name`; since swap2-core 0.12.0 a classified one also carries `reason` (`Swap2RefusalReason`, plus `retryAfterMs` / `httpStatus`, and `refusals` on "no route available"), read by `refusalOf(err)`, texts unchanged. **Many engine refusals are plain `Error`s** (build mismatches, chain mismatch, "provider disabled", native fee cap). Map errors by `instanceof` first, then by message regex, the way mobile's `swapErrorText` does (`M/swap/execute.ts:326-352`).

| class | code | thrown when | sent? | UI (port of mobile texts) |
|---|---|---|---|---|
| `Swap2QuoteError` | QUOTE | no live route (`"no route available for the requested pair :: <rejections>"`); quote expired during review or before broadcast; a fresh quote moved the spender, or no longer needs an allowance (allowance revoked) | nothing, or approval revoked | "The route is no longer available (…)". A min-floor breach shows as a price move (regex `/minAmountOut\|below the (requested\|caller)\|floor/`) |
| `Swap2ValidationError` | VALIDATION | calldata, typed order or TON body refused; malformed id; bad `toTokenDecimals` | nothing | "This route was refused for safety" + detail |
| `Swap2ExecutionError` | EXECUTION | read-only account; a required hook is missing; no hash returned; claim reverted | depends | generic |
| `Swap2InFlightError` (extends Execution) | EXECUTION | the same options are already running on the same account object (`IN_FLIGHT` WeakMap keyed by the account, `ENGINE:54-58,711-715`) | nothing for this call | "This swap is already running" |
| `Swap2InsufficientGasError` (extends Execution) | EXECUTION | EVM native balance < approvals + main fee + value | nothing | "Not enough {native} to pay the network fees" |
| `Swap2MaybeSentError {hash?, id?}` (extends Execution) | EXECUTION | the send threw and `maybeSent(err)` matched: an error in the cause chain with `maybeSent: true` (wallet-evm and wallet-solana `BroadcastUnknownError`), or the text matches `LOST_ANSWER` (`ENGINE:59-79`). **No revoke**, because the deposit may spend the allowance | maybe | "May still go through, check your wallet's activity before retrying". Track `id` if present |
| `Swap2FeeLimitError` | FEE_LIMIT | `max*FeeBps` caps (not used) | nothing | — |
| `Swap2StatusError` | STATUS | claim not ready | — | "Attestation pending" |
| `Swap2UnsupportedOperationError` | UNSUPPORTED_OPERATION | exact-out; a provider without a claim step; a non-EVM claim | — | — |
| `Swap2ConfigurationError` | CONFIGURATION | bad fee caps or allowance config | — | bug |
| ours: `SwapReviewMismatch` | — | thrown by our `reviewExecution` | nothing | "The live route isn't the one you reviewed (…), nothing was signed" |
| ours: `SwapGateRefusal` (`answered: true`) | — | an unarmed write reached the account | nothing | "A transaction didn't match the reviewed route, refused" |
| wallet rejection (`answered: true`) | — | user rejected in the wallet | nothing (a revoke may follow) | "Cancelled in your wallet" |

The `maybeSent` heuristic (`ENGINE:60-67`) walks up to 6 levels of `.cause`:

1. Any level with `maybeSent === true` → "maybe sent" (with `hash` if present).
2. Else any level with `answered === true` → definitive failure.
3. Else the joined `message`/`code`/`name` is tested against `/socket hang up|ECONNRESET|…|timed? ?out|TimeoutError|request aborted|AbortError|connection (?:closed|reset)|fetch failed|failed to fetch|network request failed|other side closed/i`.

**Our adapters must set `answered: true` on every error that is known not to have broadcast.** Otherwise a wallet message containing "timeout" would be reported as maybe-sent, and the user would be told not to retry.

### 4.6 Swap ids

Format (`ENGINE:277-302`): `awk1.<provider>.<intentId>[.<sourceTxHash>[.<destTxHash>[.ok]]]`. Each segment is `encodeURIComponent`'d with `.` → `%2E`, and there are 2–5 segments. The provider must match `/^[A-Za-z0-9_-]+$/`. A typed order's id has no hash; a deposit-address route tracked without the source hash also has none. `SWAP2_ID_PREFIX` is exported; `encodeId` and `decodeId` are not, so copy them:

```ts
// src/lib/swap/ids.ts (verbatim logic from ENGINE:279-302; decode as M/swap/execute.ts:259-271)
import {SWAP2_ID_PREFIX} from "@anywalletkit/protocol-swap2-core/swap2/base";
const enc = (v: string) => encodeURIComponent(v).replace(/\./g, "%2E");
export function encodeSwapId(provider: string, intentId: string, sourceTxHash?: string, destTxHash?: string, destTxConfirmed = false): string {
  const dest = destTxHash != null ? [destTxHash, ...(destTxConfirmed ? ["ok"] : [])] : [];
  const parts = [provider, intentId, ...(sourceTxHash != null ? [sourceTxHash, ...dest] : [])];
  return `${SWAP2_ID_PREFIX}.${parts.map(enc).join(".")}`;
}
export function decodeSwapId(id: string): {provider: string; intentId: string; sourceTxHash?: string} | null {
  const [prefix, p, i, h] = id.split(".");
  if (prefix !== SWAP2_ID_PREFIX || !p || !i) return null;
  try { return {provider: decodeURIComponent(p), intentId: decodeURIComponent(i), ...(h ? {sourceTxHash: decodeURIComponent(h)} : {})}; }
  catch { return null; }
}
```

### 4.7 Engine-enforced constants worth knowing

- `NATIVE_FEE_CAP` per chain (`ENGINE:96-139`): 0.005 ETH by default, 20 POL, 0.005 BNB, 0.1 AVAX, 0.1 HYPE, … Only `swap2()` applies it (`declaredNativeFee` at `:190-203`, called at `:851`/`:855`, before the approvals and the review): `router.getQuotes` and the route list do **not** check it, so a route whose fee is above the cap is listed and ranked, and its Confirm is refused before any approval (`swap2: quoted native fee X exceeds the cap Y for <chain>`, a plain `Error`). swap2-core 0.11.0 adds `Swap2EngineConfig.nativeFeeCeiling` (`nativeFeeCap`, `:141-189`), which may raise or lower the cap per execution, up to 20× the chain's (`NATIVE_FEE_CEILING_MAX_MULTIPLE`). This app answers 0.01 ETH for USDT0's Legacy Mesh into Tron from Ethereum or Arbitrum (its LayerZero fee ≈ 0.0053 ETH on 2026-11-12, sealed with 25 % headroom ≈ 0.0067 ETH; the unused part is refunded in the same transaction) and `undefined` for every other route, so their defaults hold (`execute.ts` `nativeFeeCeiling`; `tests/unit/execute/flow.test.ts` pins the config keys and the matches). The in-page gate's own value check (twice the reviewed `nativeFee`, §7.3) is unchanged.
- The default serialized allowance is 0.02 SOL and the default TON gas ceiling is 1 TON (`:244-245`).
- Approvals are always for the **exact** input amount (`:945`), never unlimited.
- The in-flight key is `[fromChain, fromToken, toToken, toChain, recipient, refundAddress, fromTokenAmount, toTokenAmount, minAmountOut, slippage]`, keyed per account object (`:54-58`).

---

## 5. The account contract

The engine accepts the account as `unknown` and duck-types it. Every member it touches (grep of `ENGINE`: `signer.*`, `reader.*`, `this._account`) is listed below.

### 5.1 Chain identity (`readAccountChain`, `ENGINE:303-319`; check at `:586-600`)

Resolution order:

1. `config.accountChain`, if set: returned as is, and the account is not asked.
2. `account.chain`, if it is a non-empty string not ending in `:unknown`.
3. `await account.getChainId()` (a number or a string).
4. `await account.getNetwork()` (a string, or `.chainId`).
5. `account.chainId`.
6. `account._provider.getNetwork().chainId`, then `account.provider.getNetwork().chainId`.
7. Otherwise `Error("account chain identity is unavailable …")`.

The comparison: the value is aliased with `swap2ChainId`, any `eip155:` prefix is stripped on both sides, and the two must be equal. Otherwise: `Error("swap2: account is bound to X, but fromChain is Y")`.

- EVM: return `getChainId(): Promise<number>` from the **wallet** (`eth_chainId`). Do not expose `chain`.
- Solana: `WalletAccountSolana.chain = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"`, which is aliased to `solana:mainnet` and matches.
- TON: `ton:-239`. Tron: `tron:0x2b6653dc` (aliased).

The check runs **once** at the start of `executeSwap2` (and again in a re-quote pass). Our EVM `sendTransaction` re-asserts the chain on every send (viem `chain` param, §6.1).

### 5.2 Member table

Engine tx shapes are exact, so the gate must match them.

| member | engine call (line) | args the engine passes | expected return | EVM | Solana | TON / Tron (later) | if missing |
|---|---|---|---|---|---|---|---|
| `getAddress()` | 726 | — | `Promise<string>` (self; default recipient/refund; typed-order `maker`; TON excess check) | checksummed owner | base58 | raw/friendly / base58 `T…` | **TypeError, crash** (required) |
| `chain` / `getChainId()` / … | 305-318 | — | see §5.1 | `getChainId()` from the wallet | `chain` property | `chain` | Error before anything |
| `sendTransaction(tx)` | 706 (presence), 1042-1047 (approve), 1166-1177 (main), 1345-1351 (claim) | approve: `{to: token, data: approve(spender,amt), value: 0n, chainId?}`; main: `{to, data?, value: bigint, chainId?: number, gasLimit?: bigint, body?: Cell \| string (TON), memo?, memoEncoding? (Tron), memo? (NEAR)}`; claim: `{to, data, value: 0n, chainId: number, gasLimit?}` | `Promise<{hash: string}>` (`fee` is ignored; return `fee: 0n`) | `eth_sendTransaction` | `{to, value}`: a SOL transfer only (calldata is refused off EVM, 698-700) | TON: `body` is a Cell (cell body) or a string (**text comment**); Tron: TRX with an optional memo | `Swap2ExecutionError` "requires a signing account" (the read-only path) |
| `waitForTransaction(hash)` | 1048 (after each approval), 1355-1367 (claim) | `hash` | resolves when mined and successful; **throws** on revert (`code: "reverted"` or `/reverted/` in the message for claims) | receipt wait | not called | not called | no wait: the main call follows the approval immediately (race) and a claim stays `confirmed=false` |
| `quoteSendTransaction(tx)` | 1260, 1264 (gas pre-check), 1234 (dry run, `ownGas`) | the same shapes as `sendTransaction` (approve and main; main includes `gasLimit` if quoted) | `Promise<{fee: bigint}>`, the worst case `gas × maxFeePerGas`. **Throw** when estimation fails | public RPC | not called (EVM only) | — | the gas pre-check is skipped |
| `getBalance()` | 1271 | — | native balance (BigInt-able) | public RPC | not called (EVM only) | — | the gas pre-check is skipped |
| `getAllowance(token, spender)` | 967-973 | ERC-20 contract, spender | BigInt-able; a throw counts as unknown | public RPC `allowance` | not called | — | always approves (and on eip155:1 USDT always resets to 0 first) |
| `getTokenInfo(token)` | 543-551 | contract / mint | `{decimals: number}` (`TokenInfo`) | public RPC | `WalletAccountSolana.getTokenInfo` | — | only with `allowUnlistedTokens`: then `fromTokenDecimals` is required |
| `signTypedData(td)` | 1097-1113 (typed order), 1213-1220 (Permit2) | `{domain (chainId normalized to number), types (no EIP712Domain), primaryType?: string, message}` | `Promise<string>` (0x signature) | `eth_signTypedData_v4` | — | — | typed order: Error **after approvals**, then a revoke; Permit2: refused **before** any approval, nothing to revoke |
| `transfer(o)` | 1153-1163 | `{token: mint/jetton/TRC-20, recipient: depositAddress, amount: bigint, memo?, memoEncoding? (Tron only)}` | `Promise<{hash: string}>` | never (EVM token deposits become calldata) | SPL / Token-2022 `transferChecked` (+ATA) | jetton transfer / TRC-20 + memo | `Swap2ExecutionError` at the signing step (non-EVM sources have no approvals, so nothing has been sent) |
| `sendSerializedTransaction(tx, expect)` | 751 (presence, before review), 1151 | base64 wire tx, `SerializedExecutionExpectation` | `Promise<{hash: string}>` | — | guard → sign → broadcast | — | `Swap2ExecutionError` before the review |
| `getJettonWalletAddress(master)` | 876 | jetton master | the own jetton wallet address | — | — | TON jetton cell-body deposits | refused (`Swap2ValidationError`) |

Nothing else is called: no `sign`, `signTransaction`, `approve`, `getTransactionReceipt`, `dispose`, `toReadOnlyAccount`. Providers never see the account; they get only `QuoteParams` and the quote.

### 5.3 Cross-check with the SDK accounts and mobile's `engineAccount`

- `WalletAccountEvm` (`wallet-evm/dist/index.d.ts:713-1093`) has every EVM member above.
  - `sendTransaction(tx: EvmTransaction, options?: WriteOptions): Promise<TransferResult{hash, fee}>`. Before signing it simulates with `eth_call` and refuses a revert (`SimulationError`), checks the chain id (`ChainMismatchError`), applies fee caps (`FeeLimitExceededError`, code `fee-limit-exceeded`) and checks the balance.
  - `waitForTransaction(hash, timeoutMs = 180_000)` throws `TransactionRevertedError{code:"reverted"}`.
  - A lost broadcast throws `BroadcastUnknownError{maybeSent: true, hash}`.
  - **It cannot be used with a browser wallet as the signer**: its `Signer` must sign raw secp256k1 digests, and browser wallets don't (eth_sign is disabled). We reuse `WalletAccountReadOnlyEvm` for reads, quotes and simulation only.
- `WalletAccountSolana` (`wallet-solana/dist/index.d.ts:1013-1084`):
  - `sendTransaction(SolanaTransaction)`;
  - `transfer({token?, recipient, amount})`;
  - `sendSerialized(base64, guard, options?): Promise<{hash, fee, quote, check}>`, which runs `checkSerialized`, then the fee cap, then `signer.sign(messageBytes, {scheme: "ed25519", context: "solana-message"})`, then broadcasts through its own RPC (`index.js:2283-2350`).
  - The signer is pluggable via core `externalSigner`. **This is what makes the SDK account usable with a browser wallet.**
- Mobile's `engineAccount` (`M/swap/execute.ts:126-158`) is a Proxy over the policy-wrapped SDK account that adds:
  - EVM `waitForTransaction` = `waitForEvmTx` (`:87-112`): a 180 s deadline, a reverted status throws, and after mining it waits until a public RPC sees the next block (load-balanced RPC lag), retrying transport errors;
  - Solana `sendSerializedTransaction` = `account.sendSerialized(tx, serializedGuardFromExecution(expect))`;
  - TON `sendTransaction`, which converts the `{__bocBase64}` body shim to `bodyBoc`.

---

## 6. Browser adapters

### 6.1 EVM: viem `WalletClient` (wagmi) plus `PublicClient` → engine account

```ts
// src/lib/swap/accounts/evm.ts
import {BaseError, ChainMismatchError, getAddress, type Address, type Chain, type Hex, type PublicClient, type WalletClient} from "viem";
import {WalletAccountReadOnlyEvm} from "@anywalletkit/wallet-evm";
import type {TokenInfo} from "@anywalletkit/core";

export interface EngineEvmTx { to: string; data?: string; value: bigint; chainId?: number; gasLimit?: bigint }
export interface EngineTypedData { domain: Record<string, unknown>; types: Record<string, {name: string; type: string}[]>; primaryType?: string; message: Record<string, unknown> }
export interface EvmEngineAccount {
  getAddress(): Promise<string>;
  getChainId(): Promise<number>;
  getBalance(): Promise<bigint>;
  getAllowance(token: string, spender: string): Promise<bigint>;
  getTokenInfo(token: string): Promise<TokenInfo>;
  quoteSendTransaction(tx: EngineEvmTx): Promise<{fee: bigint}>;
  sendTransaction(tx: EngineEvmTx): Promise<{hash: string; fee: bigint}>;
  waitForTransaction(hash: string): Promise<void>;
  signTypedData(td: EngineTypedData): Promise<string>;
}

export const answered = <E>(e: E): E => (e && typeof e === "object" ? Object.assign(e, {answered: true}) : e);

/** Wallet errors that prove nothing was broadcast (EIP-1193 / JSON-RPC codes). */
const DEFINITIVE = new Set([4001, 4100, 4200, 4900, 4901, -32601, -32602]);
export function normalizeWalletError(e: unknown, transport: "injected" | "walletconnect"): unknown {
  const walk = (f: (x: unknown) => boolean) => (e instanceof BaseError ? e.walk(f) : f(e) ? e : null);
  if (walk((x) => x instanceof ChainMismatchError)) return answered(e);           // viem refused before sending
  const coded = walk((x) => typeof (x as {code?: unknown})?.code === "number") as {code?: number} | null;
  if (coded?.code !== undefined && DEFINITIVE.has(coded.code)) return answered(e);
  // A WalletConnect request that expired may still be approved/broadcast on the phone: never offer a retry.
  if (transport === "walletconnect" && /expired|timed? ?out|timeout/i.test(String((e as Error)?.message ?? e)))
    return Object.assign(e as object, {maybeSent: true});
  return e;                                                                         // the engine's own heuristic decides
}

export function evmEngineAccount(o: {
  wallet: WalletClient; pub: PublicClient; chain: Chain; rpcUrls: string[]; owner: Address; transport: "injected" | "walletconnect";
}): EvmEngineAccount {
  const reader = new WalletAccountReadOnlyEvm(o.owner, {provider: o.rpcUrls, chainId: o.chain.id}); // reads only; NOT exposed as `chain`
  const assertOwner = async () => {
    const [current] = await o.wallet.getAddresses();                                 // eth_accounts
    if (!current || getAddress(current) !== getAddress(o.owner)) throw answered(new Error("swap: the wallet switched accounts — nothing was sent"));
  };
  return {
    getAddress: async () => getAddress(o.owner),
    getChainId: () => o.wallet.getChainId(),                                         // the LIVE wallet chain (engine chain check)
    getBalance: () => reader.getBalance(),
    getAllowance: (token, spender) => reader.getAllowance(token, spender),
    getTokenInfo: (token) => reader.getTokenInfo(token),
    quoteSendTransaction: (tx) => reader.quoteSendTransaction(tx),                   // gas (tx.gasLimit ?? estimate) × maxFeePerGas; throws when estimation fails
    async sendTransaction(tx) {
      if (tx.chainId !== undefined && tx.chainId !== o.chain.id) throw answered(new Error(`swap: transaction for chain ${tx.chainId}, wallet bound to ${o.chain.id}`));
      await assertOwner();
      // Parity with wallet-evm: refuse a transaction that reverts in eth_call. A transport failure is not a refusal (the wallet simulates too).
      const sim = await reader.simulateTransaction(tx).catch(() => null);
      if (sim && !sim.ok) throw answered(new Error(`swap: the transaction would revert (${sim.reason}) — nothing was sent`));
      try {
        const hash = await o.wallet.sendTransaction({
          account: o.owner, chain: o.chain,                                          // viem asserts eth_chainId === chain.id before sending
          to: tx.to as Address, ...(tx.data ? {data: tx.data as Hex} : {}), value: tx.value,
          ...(tx.gasLimit !== undefined ? {gas: tx.gasLimit} : {}),                  // parity with wallet-evm: the quoted limit as given
        });
        return {hash, fee: 0n};
      } catch (e) { throw normalizeWalletError(e, o.transport); }
    },
    waitForTransaction: (hash) => waitForEvmTx(o.pub, hash as Hex),
    async signTypedData(td) {
      await assertOwner();
      if (!td.primaryType) throw answered(new Error("swap: typed data without primaryType"));
      try {
        return await o.wallet.signTypedData({account: o.owner, domain: td.domain as never, types: td.types, primaryType: td.primaryType, message: td.message});
      } catch (e) { throw normalizeWalletError(e, o.transport); }
    },
  };
}

/** Port of M/swap/execute.ts:87-112, plus replacement handling (MetaMask speed-up / cancel). */
export async function waitForEvmTx(pub: PublicClient, hash: Hex, budgetMs = 180_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    let replaced: string | null = null;
    try {
      const receipt = await pub.waitForTransactionReceipt({
        hash, timeout: Math.max(5_000, deadline - Date.now()),
        onReplaced: (r) => { if (r.reason !== "repriced") replaced = r.reason; },    // viem resolves with the REPLACEMENT's receipt
      });
      if (replaced) throw Object.assign(new Error(`swap: ${hash} was ${replaced} in the wallet — reverted`), {code: "reverted"});
      if (receipt.status !== "success") throw Object.assign(new Error(`swap: ${hash} reverted on-chain`), {code: "reverted"});
      const settleBy = Math.min(deadline, Date.now() + 20_000);                     // a load-balanced RPC may be a block behind
      while (Date.now() < settleBy) {
        const head = await pub.getBlockNumber({cacheTime: 0}).catch(() => 0n);
        if (head > receipt.blockNumber) break;
        await sleep(1_500);
      }
      return;
    } catch (e) {
      if ((e as {code?: unknown}).code === "reverted" || Date.now() >= deadline) throw e;
      await sleep(3_000);                                                           // transport hiccup ≠ failed approval
    }
  }
}
```

Rules around the EVM adapter:

- **Switch the chain before `swap2()`.** Call `await switchChain(wagmiConfig, {chainId})` on Confirm. If the user rejects, abort with nothing sent. Rebuild the `WalletClient` for that chain after the switch.
- **Stay on that chain.** If the user switches network mid-flow, viem throws `ChainMismatchError`. That error is `answered`, so the engine revokes and aborts.
- **Claims.** The wallet must be switched to the **destination** chain first, because `claimSwap2` ignores `accountChain`.
- **Smart-contract accounts: refuse them in v1.**
  - Check: `await pub.getCode({address: owner})` is neither `undefined`/`"0x"` nor an EIP-7702 delegation (`0xef0100…`); if it is anything else, the account is a contract.
  - Why: Safe-style wallets return a `safeTxHash` from `eth_sendTransaction`, so `waitForTransaction` never resolves; and the same address on the destination chain may not be controlled by the user.
- **No `dataSuffix`** (attribution) on the wagmi or viem client. viem appends it to calldata (`sendTransaction.js:63-65`), so the signed data would no longer be the armed data.
- **Fees are the wallet's.** We cannot cap the EVM fee (the user can edit gas in the wallet). Show the `quoteSendTransaction`/`gas.ts` estimate in the review; port `swapFeeCap` only as a warning threshold.
- **No EVM `transfer`, `sendSerializedTransaction` or `getJettonWalletAddress`.** The engine never calls them on EVM. Leaving them out keeps the surface minimal.

### 6.2 Solana: Wallet Standard → `WalletAccountSolana` (recommended)

**Answer to "can the guard run standalone?":** yes, in two ways. `WalletAccountReadOnlySolana.checkSerialized(base64, guard, options?)` is a read-only method that needs only an address and an RPC (`wallet-solana/dist/index.d.ts:922`, `index.js:1905-2063`). It:

1. decodes the wire transaction and resolves lookup tables;
2. enforces signers and the program allowlist (`DEFAULT_PROGRAM_ALLOWLIST`);
3. refuses authority changes, delegate approvals, foreign closes and the `bridgeOut` Mayan order rules;
4. reads the pre-state of the wallet, its ATAs, wSOL and every writable account;
5. runs `simulateTransaction({sigVerify: false, replaceRecentBlockhash: true, accounts: {addresses, encoding: "base64"}})`;
6. checks the lamport, token-in and token-out deltas, CPI authority changes and custody;
7. returns `SerializedCheck`, or throws `UnsafeTransactionError{code}`, `SimulationError` or `MissingSignersError`.

It never signs.

**Recommended:** do not call it by hand. Run the whole SDK account with the wallet as its external signer. `sendSerialized` then checks, signs and broadcasts **the same bytes**, and `transfer` and `sendTransaction` (deposit-address routes) get the SDK's own builder, simulation and fee cap. The wallet sees a normal transaction-approval prompt.

```ts
// src/lib/swap/accounts/solana.ts
import {externalSigner, UserRejectedError} from "@anywalletkit/core";
import {WalletAccountSolana, serializedGuardFromExecution, type SerializedExecutionInput} from "@anywalletkit/wallet-solana";
import {getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder, type Address} from "@solana/kit";
import type {Wallet, WalletAccount} from "@wallet-standard/base";
import {SolanaSignTransaction, type SolanaSignTransactionFeature} from "@solana/wallet-standard-features";
import {answered} from "./evm";

export const SOLANA_FEE_CEILING = 50_000_000n;   // 0.05 SOL — M/send/gate.ts:60 FEE_CEILING.solana

/** Open only while a gated write runs (§7.3): no other code path can obtain a signature. */
export function signingWindow() {
  let open = 0;
  return {open: () => void open++, close: () => void open--, assertOpen: () => { if (open <= 0) throw answered(new Error("swap: signature requested outside a reviewed write")); }};
}
export type SigningWindow = ReturnType<typeof signingWindow>;

function walletStandardSigner(wallet: Wallet, account: WalletAccount, window: SigningWindow) {
  const feature = (wallet.features as Partial<SolanaSignTransactionFeature>)[SolanaSignTransaction];
  if (!feature) throw new Error("This wallet can't sign without sending (solana:signTransaction) — use another wallet.");
  if (!feature.supportedTransactionVersions.includes(0)) throw new Error("This wallet can't sign v0 transactions.");
  return externalSigner({
    curve: "ed25519",
    publicKey: new Uint8Array(account.publicKey),
    async sign(messageBytes, {context}) {
      if (context !== "solana-message") throw answered(new Error("swap: only transactions are signed here"));  // the engine never asks for messages
      window.assertOpen();
      // Wrap the compiled message in a wire tx with empty signature slots, as solana:signTransaction expects.
      const msg = getCompiledTransactionMessageDecoder().decode(messageBytes);
      const signers = msg.staticAccounts.slice(0, msg.header.numSignerAccounts);
      const unsigned = getTransactionEncoder().encode({messageBytes, signatures: Object.fromEntries(signers.map((a) => [a, null]))} as never);
      let signedBytes: Uint8Array;
      try {
        const [out] = await feature.signTransaction({account, transaction: new Uint8Array(unsigned), chain: "solana:mainnet"});
        signedBytes = out!.signedTransaction;
      } catch (e) {
        throw answered(Object.assign(new UserRejectedError((e as Error)?.message), {cause: e}));  // signTransaction never broadcasts
      }
      const signed = getTransactionDecoder().decode(signedBytes);
      const same = signed.messageBytes.length === messageBytes.length && signed.messageBytes.every((b, i) => b === messageBytes[i]);
      if (!same) throw answered(new Error("The wallet changed the transaction before signing it — nothing was sent."));
      const sig = signed.signatures[account.address as Address];
      if (!sig) throw answered(new Error("The wallet returned no signature."));
      return new Uint8Array(sig);                  // externalSigner verifies it against publicKey over messageBytes
    },
  });
}

export function solanaEngineAccount(o: {wallet: Wallet; account: WalletAccount; rpcUrls: string[]; window: SigningWindow}) {
  const publicKey = new Uint8Array(o.account.publicKey);
  const sol = new WalletAccountSolana(walletStandardSigner(o.wallet, o.account, o.window), publicKey, "external", {
    provider: o.rpcUrls,                         // failover list; sendTransaction is never re-signed, only re-sent
    transactionMaxFee: SOLANA_FEE_CEILING,       // sendTransaction + sendSerialized
    transferMaxFee: SOLANA_FEE_CEILING,          // transfer
  });
  if (sol.address !== o.account.address) throw new Error("swap: wallet account / public key mismatch");
  return {
    chain: sol.chain,                                                          // "solana:5eykt…" → aliased to solana:mainnet
    getAddress: () => sol.getAddress(),
    getBalance: () => sol.getBalance(),
    getTokenInfo: (t: string) => sol.getTokenInfo(t),
    sendTransaction: (tx: {to: string; value: bigint}) => sol.sendTransaction(tx),                       // SOL deposit
    transfer: (t: {token: string; recipient: string; amount: bigint}) => sol.transfer(t),                // SPL deposit (+ATA)
    sendSerializedTransaction: async (tx: string, expect: SerializedExecutionInput) => {
      const r = await sol.sendSerialized(tx, serializedGuardFromExecution(expect));                      // the guard, then sign, then broadcast
      return {hash: r.hash, fee: r.fee};
    },
  };
}
```

Wallet Standard typings (`SolanaSignTransaction`, `SolanaSignTransactionFeature`, input `{account, transaction: Uint8Array, chain?, options?}`, output `{signedTransaction: Uint8Array}`) are written from the published `@solana/wallet-standard-features` API. That package is not installed in `~/cp0x-elysium`, so verify the names when you add it.

**Probe, run 2026-11-11.** The script (`/private/tmp/claude-501/-Users-xoxolove-cp0x-mobile/77a9ff69-31b8-4c59-bd67-782764200f91/scratchpad/solprobe/probe.mjs`) built `WalletAccountSolana(externalSigner(...), pk, "external", {provider: "https://solana-rpc.publicnode.com", simulate: false, priorityFee: false})`, with a generated key standing in for the wallet's `signTransaction` over the wire bytes. `signTransaction({to, value: 1n})` returned a 292-char signed base64 wire tx after one signer call, and `chain = solana:5eykt…`. The message → wire → decode → signature-verify path works with the installed `@solana/kit` 8.5.0 and core 0.8.0.

Behaviour you get for free:

- **Lost broadcasts.** A broadcast that times out throws wallet-solana's `BroadcastUnknownError{maybeSent: true, hash}`, which the engine turns into `Swap2MaybeSentError` **with the signature**, so the swap stays trackable.
- **Bridge legs.** Cross-chain serialized legs are held to `bridgeOut` (the Mayan order's recipient, token and minimum). Other bridges are held to the SOL and token ceilings plus the allowlist (see the `BridgeOutExpectation` docs, `wallet-solana/dist/index.d.ts:511-576`).
- **The wallet cannot alter what is sent.** If it modifies the transaction (for example Phantom adding Lighthouse guard instructions), the signature check fails and nothing is sent.

**Fallback, weaker.** For a wallet without `solana:signTransaction`, use `const check = await new WalletAccountReadOnlySolana(address, {provider: rpcUrls}).checkSerialized(tx, serializedGuardFromExecution(expect))`, then `wallet.features["solana:signAndSendTransaction"].signAndSendTransaction({account, transaction: base64ToBytes(tx), chain: "solana:mainnet"})`. Hash = base58 of the returned `signature`. Caveats:

- The wallet may modify the transaction before it broadcasts, so the checked bytes may not be the sent bytes.
- Errors from signAndSend may come after broadcast, so do **not** mark them `answered`.
- `transfer` and `sendTransaction` would need our own builders.

Recommendation: v1 supports only wallets with `solana:signTransaction` (Phantom, Solflare and Backpack all have it).

**Solana RPC requirements.** `checkSerialized` and `sendSerialized` use `getAccountInfo` (lookup tables, mints), `getMultipleAccounts`, `simulateTransaction` with `accounts`, `getFeeForMessage` and `getRecentPrioritizationFees` (the quote), `getLatestBlockhash` (for transfers), `getEpochInfo` (Token-2022 fees) and `sendTransaction`. That is roughly 6–10 calls per swap.

CORS probe, 2026-11-11, `OPTIONS` with `Access-Control-Request-Headers: content-type,solana-client` (`@solana/kit` always sends a `solana-client` header):

- `https://api.mainnet-beta.solana.com` reflects the origin and allows `solana-client`. It is rate-limited (~100 req/10 s per IP).
- `https://solana-rpc.publicnode.com` returns `*` and allows `solana-client`.
- `https://ethereum-rpc.publicnode.com` and `https://base-rpc.publicnode.com` return `*` with `content-type`.

Use a failover list. A keyed RPC in a static SPA exposes the key: only use one that is origin-restricted.

### 6.3 TON and Tron (later): what the adapter must do

- **TON (TON Connect `sendTransaction({validUntil, messages: [{address, amount, payload?, stateInit?}]})`):**
  - `sendTransaction({to, value, body})`: a `Cell` body → `payload = body.toBoc().toString("base64")`. A **string** body is a text comment: build cell `op=0 + utf8`; never send a BoC as text.
  - `transfer({token: master, recipient, amount, memo?})`: build a TEP-74 `transfer` body to **our own jetton wallet** (`getJettonWalletAddress`), with response destination = self and the forward comment = memo.
  - `getJettonWalletAddress(master)` is required for cell-body jetton deposits (`ENGINE:876-878`).
  - Engine config: `decodeTonBody: (b) => Cell.fromBase64(b)`, `tonGasCeiling: 500_000_000n`. The gate arms `bodyBoc` for cell bodies (mobile `M/swap/gate.ts:181-187`).
  - The `hash` returned must follow wallet-ton's convention ("body hash", `wallet-ton/dist/index.d.ts:121-125`), because providers track by it. Verify against wallet-ton before shipping.
- **Tron (TronLink / tronWeb):**
  - `sendTransaction({to, value, memo?, memoEncoding?})` and `transfer({token, recipient, amount, memo?, memoEncoding?})`. Build the transaction, then `transactionBuilder.addUpdateData(tx, memo, memoEncoding === "hex" ? "hex" : "utf8")` into `raw_data.data`, sign, broadcast.
  - Chain identity: `chain: "tron:728126428"`.
  - The engine refuses Tron calldata routes (only transfers with memos are allowed).

---

## 7. The security gate in the browser

### 7.1 What mobile does

`M/swap/gate.ts` (no React, pure apart from viem's ABI encoder; tested in `gate.test.ts`):

| export | lines | what it does |
|---|---|---|
| `ArmedWrite` | 29-37 | `call {to, data?, value, body?, bodyBoc?, memo?}` / `transfer {token, recipient, amount, memo?}` / `serialized {tx}` / `typed {message (stableJson)}` |
| `ARM_TTL_MS` | 40 | 5 min (approvals are mined round trips) |
| `armSwap(chain, writes, revokes, now)` / `disarmSwap()` | 49-60 | **module singleton** armed set `{chain, writes[{w, used}], revokes[{token, spender}], until}` |
| `same(a, b)` | 63-66 | `0x` strings compare case-insensitively; everything else (base58, base64, TON friendly) verbatim |
| `toBig`, `str`, `stableJson` | 68-90 | normalization; `stableJson` = sorted keys, bigints as strings |
| `matches(w, method, raw)` | 92-123 | `call` ⇔ `sendTransaction` with the same `to`, the same `data` (case-insensitive hex, or both absent), the same `value`, and **the same `body`/`bodyBoc`/`memo`** (a text comment ≠ a cell body). `transfer` ⇔ `transfer` with the same token, recipient, amount and memo. `serialized` ⇔ `sendSerialized` with `raw === tx`. `typed` ⇔ `signTypedData` with `stableJson(raw.message) === w.message` |
| `consumeSwapWrite(intent, now)` | 131-155 | the kit `confirm` hook. No arm, or expired → false. A kit `revoke` intent is allowed if every revoke is armed. A raw `approve(spender, 0)` on an armed revoke pair is allowed. Otherwise the first unused matching write is marked used → true. **No match → every remaining write is marked used (disarmed)** → false |
| `approveData(spender, amt)` | 158-159 | viem `encodeFunctionData(erc20Abi, "approve")`, byte-identical to the engine's `approveData` (`ENGINE:50-53`) |
| `planWrites(plan, tonBodyBoc?)` | 166-209 | plan → exact writes in order (one `call approve` per approval, then the source) + `revokes = approvals.map({token, spender})` |
| `ReviewedSwap` | 212-230 | `{provider, fromChain, fromContract \| null, amountIn, destChain, destToken, recipient, refundAddress, minOut, slippageBps, approvalSpender \| null, nativeFee}` |
| `executionConstraints(r)` | 238-241 | `{minAmountOut: r.minOut, slippage: r.slippageBps / 10_000}` (the live quote must be asked with the reviewed slippage, or 1Click falls back to 1 % and breaks the floor) |
| `TON_BODY_GAS` | 249 | 0.5 TON |
| `checkPlan(plan, r)` | 252-276 | Refuses when the provider changed; when the chain pair or destination token changed; when the recipient or refund address changed; when `sourceAmount ≠ amountIn`; when `minDestAmount < minOut`. Every approval must be on `fromContract`, for `approvalSpender`, with amount ∈ {amountIn, 0}. A `call` value must be ≤ (native source ? amountIn : 0) + 2×reviewed nativeFee (+ TON body gas). A `token-transfer` must be the reviewed token and amount |
| `requotePlan(r, q, unsigned)` | 287-317 | rebuilds a plan for the engine's re-quote pass (for the observer) |
| `swapFeeCap(family, opts)` | 326-338 | non-EVM: `FEE_CEILING`. EVM: $80 (L1) or $20 at the native price; unpriced ETH falls back to 0.03/0.005 ETH; other unpriced natives get no cap, and the swap is refused |
| `swapPolicies(chains, cap, normalize)` | 344-353 | kit `Policies{maxFee, confirm: consumeSwapWrite}` |

`M/send/gate.ts` is the plain-send equivalent:

- `arm`/`consumeArmed`: one write, 90 s TTL, `method === "transfer"`, with the same chain, recipient, amount and token (`:31-52`).
- `FEE_CEILING` per family (`:59-66`): sol 0.05, ton 0.5, trx 60, btc 200k sat, near 0.1, zec 0.01.
- `feeCap` = 3× the reviewed fee, capped by the ceiling (`:76-81`).
- `isFeeCapRefusal` (`:90-94`) and `sendPolicies` (`:101-106`).

The swap app needs only `FEE_CEILING` from this file, unless it also gets a Send screen.

### 7.2 Browser threat model and choke point

On mobile, the key never leaves the SDK, so `applyPolicies` on the account is the choke point. In the browser, the **wallet** signs, and the only code that can ask it to sign is ours. The choke point is therefore the engine account object (§6), wrapped so that:

1. **Only the gated wrapper talks to the wallet.** No code outside `accounts/*.ts` may call `walletClient.sendTransaction`, `writeContract`, `signTypedData` or the Solana `signTransaction` feature. Enforce this with an ESLint `no-restricted-syntax`/`no-restricted-imports` rule plus a CI grep.
2. **Each write consumes an armed write.** Every write method the engine can call (`sendTransaction`, `transfer`, `sendSerializedTransaction`, `signTypedData`) must **consume** one armed write before doing anything else. Armed writes come only from `reviewExecution(plan)` after `checkPlan(plan, reviewed)` passes, and from the claim preview.
3. **Solana signatures need an open window.** The Solana external signer additionally requires an open signing window, which only a gated write opens.
4. **Refusals are definitive.** Refusals are `answered`, so the engine treats them as "nothing sent" and runs its cleanup (a revoke) through the same gate.

What the gate cannot do: protect against a compromised page (XSS or a supply-chain attack can call the wallet directly). Mitigations:

- a strict CSP (no inline or third-party scripts; `connect-src` limited to the provider APIs and RPCs);
- an exact-pinned lockfile;
- no analytics SDKs.

The wallet's own prompt is the user's last line of defence.

### 7.3 Port: `src/lib/swap/gate.ts` (browser)

Copy verbatim from `M/swap/gate.ts`: `ArmedWrite`, `same`, `toBig`, `str`, `stableJson`, `matches`, `approveData`, `planWrites`, `ReviewedSwap`, `executionConstraints`, `TON_BODY_GAS`, `checkPlan`.

Changes:

- Drop the `@anywalletkit/kit` imports, `swapPolicies`, `consumeSwapWrite`'s kit `revoke` branch, and `requotePlan` (§7.4).
- Replace the module singleton with a per-execution instance.
- Inline `FEE_CEILING` (from `M/send/gate.ts:59-66`).

```ts
export type WriteMethod = "sendTransaction" | "transfer" | "sendSerialized" | "signTypedData";
export interface WriteIntent { chain: string; method: WriteMethod; raw: unknown }

export class SwapGateRefusal extends Error {
  readonly answered = true;
  constructor() { super("A transaction didn't match the reviewed route — it was refused before signing."); }
}
export class SwapReviewMismatch extends Error {}   // thrown from reviewExecution; nothing was signed

const ARM_TTL_MS = 15 * 60_000;   // browser: wallet prompts add human latency; anchored at each (re)arm

export function createSwapGate(chain: string) {
  let armed: {writes: {w: ArmedWrite; used: boolean}[]; revokes: {token: string; spender: string}[]; until: number} | null = null;
  /** Allowances this execution actually granted (an approve(>0) that returned a hash): only those may be revoked. */
  const granted = new Set<string>();
  const key = (token: string, spender: string) => `${token.toLowerCase()}|${spender.toLowerCase()}`;
  return {
    arm(writes: ArmedWrite[], revokes: {token: string; spender: string}[] = [], now = Date.now()) {
      armed = {writes: writes.map((w) => ({w, used: false})), revokes, until: now + ARM_TTL_MS};
    },
    disarm() { armed = null; },
    /** Port of consumeSwapWrite (M/swap/gate.ts:131-155) without the kit `revoke` intent. */
    consume(intent: WriteIntent, now = Date.now()): boolean {
      const a = armed;
      if (!a || intent.chain !== chain) return false;
      // The engine's cleanup: approve(spender, 0) on an allowance this run granted — allowed until disarm (no TTL).
      if (a.revokes.some((x) => granted.has(key(x.token, x.spender)) && matches({kind: "call", to: x.token, data: approveData(x.spender, 0n), value: 0n}, intent.method, intent.raw)))
        return true;
      if (a.until < now) return false;
      const hit = a.writes.find((e) => !e.used && matches(e.w, intent.method, intent.raw));
      if (!hit) { for (const e of a.writes) e.used = true; return false; }   // one stray write disarms the rest
      hit.used = true;
      return true;
    },
    /** Record a granted allowance (called by the gated wrapper after an approve(>0) returned a hash). */
    granted(token: string, spender: string) { granted.add(key(token, spender)); },
  };
}
export type SwapGate = ReturnType<typeof createSwapGate>;

/** Browser-only additions on top of checkPlan. `pins`: the provider package's pins (RemotePins), when it ships them. */
export function checkPlanBrowser(plan: Swap2ExecutionPlan, r: ReviewedSwap, pins?: Pick<RemotePins, "callTargets" | "spenders">): string | null {
  const base = checkPlan(plan, r);
  if (base) return base;
  const ns = plan.fromChain.split(":")[0];
  const s = plan.source;
  if (s.kind === "serialized" && ns !== "solana") return "a provider-built transaction on a network that doesn't take one";
  if (s.kind === "typed-order" && ns !== "eip155") return "an order signature on a network that doesn't take one";
  if (s.kind === "token-transfer" && ns === "eip155") return "an unexpected token transfer";
  if (s.kind === "call" && s.data !== undefined && ns !== "eip155") return "contract calldata on a network that doesn't take it";
  if (pins && ns === "eip155") {
    const inList = (list: readonly string[], a: string) => list.some((x) => same(x, a));
    for (const a of plan.approvals) if (a.amount !== 0n && !inList(pins.spenders(plan.fromChain), a.spender)) return "an approval for a contract the app doesn't trust";
    const engineTokenCall = r.fromContract !== null && same(s.kind === "call" ? s.to : undefined, r.fromContract); // ERC-20 deposit transfer the engine built
    if (s.kind === "call" && s.data !== undefined && !engineTokenCall && !inList(pins.callTargets(plan.fromChain), s.to)) return "a call to a contract the app doesn't trust";
  }
  return null;
}
```

The gated wrapper turns any engine account into a gated one:

```ts
const ENGINE_WRITES: Record<string, WriteMethod> = {
  sendTransaction: "sendTransaction", transfer: "transfer", sendSerializedTransaction: "sendSerialized", signTypedData: "signTypedData",
};
const APPROVE_SELECTOR = "0x095ea7b3";

export function gateAccount<T extends object>(inner: T, gate: SwapGate, chain: string, window?: {open(): void; close(): void}): T {
  const out: Record<string, unknown> = {...inner};                  // data props (e.g. Solana `chain`) are copied; EVM exposes none
  for (const [name, method] of Object.entries(ENGINE_WRITES)) {
    const fn = (inner as Record<string, unknown>)[name];
    if (typeof fn !== "function") continue;
    out[name] = async (...args: unknown[]) => {
      if (!gate.consume({chain, method, raw: args[0]})) throw new SwapGateRefusal();
      window?.open();
      try {
        const res = await (fn as (...a: unknown[]) => Promise<{hash?: string}>)(...args);
        const tx = args[0] as {to?: string; data?: string};
        if (method === "sendTransaction" && res?.hash && tx.data?.toLowerCase().startsWith(APPROVE_SELECTOR) && BigInt(`0x${tx.data.slice(74, 138)}`) > 0n)
          gate.granted(tx.to!, `0x${tx.data.slice(34, 74)}`);       // approve(address spender, uint256 amount): spender = word 1, amount = word 2
        return res;
      } finally { window?.close(); }
    };
  }
  return Object.freeze(out) as T;                                    // one object per execution; the engine's IN_FLIGHT keys on it
}
```

`LOCAL_PINS`, optional defence in depth: build it from the same package exports mobile imports in `M/swap/pins.ts:50-64`. Only `callTargets` and `spenders` are used:

- `lifiPins` (`/lifi/provider`), `relayPins` (`/relay/verify`), `symbiosisPinsFor()` (`/symbiosis/verify`), `cctpPins`, `usdt0Pins` (`/usdt0/config`), `chainflipPins` (`/chainflip/config`), `uniswapPins`, `wrapPins`, `balancerPins`, `fyndPins` (`/fynd/router`), `thorchainPins()`, `acrossPins` (`/across/verify`: the pinned SpokePool).
- 0x (web, 2026-11-15; ARCHITECTURE D38): no static table can hold its call target, which is whatever 0x's on-chain registry names as the Settler in force or the one it replaced. `callTargets` answers from the resolver the page's 0x provider read the registry through (`zeroExSettlers(appProviders(), chain)`: its last fresh read, the set its live quote was checked against; empty before one, so nothing is called), `spenders` is canonical Permit2 only, and the rule carries `permit2: {maxSeconds: ZEROEX_MAX_PERMIT_SECONDS}` (600).
- **Permit2 transfers** (swap2-core 0.13.0; 0x only): `permit2Problem(plan, r, venue)` runs inside `checkPlanBrowser` on top of the engine's own `readPermit2Transfer`. A plan whose `source.permit2Transfer` is set passes only from a venue whose rule has `permit2`, for a token sale of the reviewed token with no native value, calldata to spend it, approvals to Permit2 only, and a payload of exactly `{domain, types, primaryType, message}`: domain `{name: "Permit2", chainId: <source chain>, verifyingContract: PERMIT2_ADDRESS}`, types exactly `PERMIT2_TRANSFER_TYPES` (no EIP712Domain, no witness), `PermitTransferFrom`, `permitted` = the reviewed token and exactly `amountIn`, `spender` = the call's own target (a pinned Settler), a uint256 nonce, a deadline in the future and ≤ `maxSeconds` away. `planWrites` then arms `{kind: "permit2", typedData: stableJson(payload)}` (consumed only by a `signTypedData` of that whole payload) and the call with `permit2Signed: true`: `matches` accepts it only as `appendPermit2Signature(data, sig)` for the `sig` the gated account handed back from that permit (`gate.recordSignature`, once per arm, cleared by every arm and disarm). No other typed data is armed for a Permit2 venue, and a gasless order from one is refused.
- No pins: `near_intents` (deposit addresses) and `jupiter` (Solana).
- The pins must agree with the provider config. Example: cp0x-api gives LI.FI a Flare Diamond override (`apps/api/src/lib/crossChain/index.ts:293-296`). If the browser does the same, add that address to the pin list, or exclude Flare.

### 7.4 Re-quote pass in swap2-core 0.14.0 (unchanged since 0.10.3): why `requotePlan` and the build observer are not needed

When the quote expires after the approvals are mined (`ENGINE:1065-1076`), the engine recurses with a `carried` handoff `{token, spender, amount, revoke, reviewed}`:

- Fresh quote has no approval, or a different token/spender/amount → it revokes the allowance and throws `Swap2QuoteError` (`:949-963`).
- Otherwise `approvalAmounts = []`, and the review rule at `:978-1020` applies:
  - `reviewedIdentity(fresh) !== reviewedIdentity(first)` (a different source call, minimum, recipient…) or `fresh.destAmount < first.destAmount` → `reviewExecution({...plan, requoted: true, approvals: []})`. Our `arm` runs `checkPlan` (which must still pass: the same provider and amount, minimum ≥ the floor, value ceiling) and re-arms `[source]`. **Keep the previous revokes when `planned.revokes` is empty** (mobile `execute.ts:206-207`). A throw here makes the engine revoke.
  - Identical identity → **no second review**. The source write armed by the first review is still unused, so it is consumed.

Mobile's observer (`execute.ts:230-234`) arms `requotePlan` from inside `buildDeposit` during `requoting`. Since 0.10.3 that is redundant, so the browser drops it. Port `flow.test.ts` cases for:

- identical re-quote → no second review;
- changed re-quote → `requoted: true`;
- a moved spender → revoke and abort.

Bump the gate if a future swap2-core changes `:978`.

### 7.5 Revokes, TTL, fees, locks

- **Revoke prompts.** The engine sends `approve(spender, 0)` after *any* failure that follows an approval attempt: a rejected approve, a rejected swap, an expired quote, a preflight error, a dry run that fails (`:1016-1035, 1060, 1077, 1091, 1123, 1134, 1191`; a declined Permit2 signature costs a revoke only on a re-quote pass, the one that holds an allowance before it signs). Mobile allows it as a standing permission. The browser allows it **only if this execution actually granted that allowance** (`gate.granted`). That avoids a pointless second popup when the user rejects the first approval. The UI should explain the popup: "Removing the unused approval — you can reject this".
- **TTL.** The browser uses 15 min from each (re)arm, because the wallet prompts and the mining are human-paced. Revokes ignore the TTL until `disarm()`.
- **Fee caps.**
  - EVM: advisory only (the wallet sets gas). Show the estimate; warn above the `swapFeeCap` budget. The engine still refuses an under-funded swap before the first approval (`Swap2InsufficientGasError`).
  - Solana: enforced through `transactionMaxFee`/`transferMaxFee` (§6.2).
- **Double submits.**
  - The engine's `IN_FLIGHT` only catches repeated calls on the **same** account object.
  - Add a UI busy flag.
  - Add `navigator.locks.request(\`cp0x-swap:${fromChain}:${owner}\`, {ifAvailable: true}, cb)`. When `cb` gets `null`, throw `Swap2InFlightError`. This is cross-tab, secure contexts only; fall back to an in-memory set.
- **Account sanity.** On Confirm, the wallet's current account must equal `reviewed.refundAddress`. The EVM adapter re-checks before each prompt.

### 7.6 Pure TypeScript files to copy

| mobile file | deps | action |
|---|---|---|
| `M/swap/gate.ts` | viem, swap2-core types, `FEE_CEILING` | **port**: §7.3 (instance gate, no kit, drop `requotePlan`/`swapPolicies`, add `checkPlanBrowser`) |
| `M/swap/gate.test.ts` | vitest, `omnistonEscrow.fixture.json` | port (drop the `swapPolicies`/kit tests; keep `checkPlan`/`planWrites`/`matches`) |
| `M/swap/flow.test.ts` | kit `applyPolicies` | port: replace `applyPolicies(fake, swapPolicies(...))` with `gateAccount(fake, gate, chain)` |
| `M/swap/gas.ts` (+test) | none | copy as is |
| `M/swap/math.ts` (+test) | `@cp0x/shared` `unitsToDecimal`, `ChainFamily` | copy; inline `unitsToDecimal` (or vendor `packages/shared`) |
| `M/swap/routes.ts` (+test) | router types, `../send/amount formatUnits`, `./providers orderSpender` | copy as is (bring `send/amount.ts`) |
| `M/send/amount.ts` (+test) | `@cp0x/shared` | copy |
| `M/swap/providers.ts` | relay/symbiosis config, swap2-assets | copy only `PROVIDER_NAMES`, `providerName`, `TWO_PHASE`, `orderSpender` (routing comes from the real providers) |
| `M/swap/inflight.ts` (+test) | none | copy as is (record, status mapping, poll schedule, steps) |
| `M/swap/errors.test.ts` | — | port with `swapErrorText` |
| `M/send/gate.ts` | kit types | copy `FEE_CEILING` (+ `feeCap` if a Send screen comes) |
| `M/swap/execute.ts` | keyring, kit, RN | **rewrite** (§8), keep `swapErrorText`/`swapFailureExpected`/`maybeSent`/`decodeSwapId` |
| `M/swap/engine.ts` | remote stubs, RN api | **rewrite** (§2.6) |
| `M/swap/pins.ts` | provider pins, RN store | not copied; build `LOCAL_PINS` (§7.3) |
| `M/swap/runner.ts`, `store.ts`, `tracker.ts` | AsyncStorage, RN AppState | rewrite on localStorage + `visibilitychange` (logic reusable) |

---

## 8. End-to-end sketches

### 8.1 The reviewed route (port of `app/swap/review.tsx:144-157`)

```ts
const reviewed: ReviewedSwap = {
  provider: route.provider, fromChain: from.caip2, fromContract: from.contract, amountIn,
  destChain: to.caip2, destToken: destTokenId(to),
  recipient,                         // explicit: own address on the destination family or a validated other one
  refundAddress: from.owner,         // == connected source wallet address
  minOut: executionFloor(route.minDestAmount),
  slippageBps,
  approvalSpender: route.approvalSpender,   // txRequest.approvalAddress ?? orderSpender (routes.ts:88)
  nativeFee: route.nativeFee,
};
```

The dry quote must name the spender of any approval the live plan will make, or `checkPlan` refuses at execution ("an approval for a spender you didn't review"). Verify this per provider (providers spec).

### 8.2 `executeSwap` (browser)

```ts
// src/lib/swap/execute.ts
export type SourceSigner =
  | {family: "evm"; wallet: WalletClient; pub: PublicClient; chain: Chain; rpcUrls: string[]; owner: Address; transport: "injected" | "walletconnect"}
  | {family: "solana"; wallet: Wallet; account: WalletAccount; rpcUrls: string[]};

export async function executeSwap(input: {
  reviewed: ReviewedSwap; from: SwapToken; to: SwapToken; signer: SourceSigner;
  onPhase?: (p: Swap2ExecutionPhase, d?: Swap2ExecutionPhaseDetail) => void;
}): Promise<{id: string; hash?: string; depositTo?: string}> {
  const {reviewed, from, to, signer} = input;
  return withSwapLock(`cp0x-swap:${reviewed.fromChain}:${reviewed.refundAddress}`, async () => {
    const gate = createSwapGate(reviewed.fromChain);
    const window = signingWindow();
    const raw = signer.family === "evm"
      ? evmEngineAccount(signer)                                    // caller already switched the wallet to signer.chain
      : solanaEngineAccount({...signer, window});
    if (!same(await raw.getAddress(), reviewed.refundAddress)) throw new SwapReviewMismatch("the connected wallet isn't the reviewed one");
    const account = gateAccount(raw, gate, reviewed.fromChain, window);

    let depositTo: string | undefined;
    let revokes: {token: string; spender: string}[] = [];
    const arm = (plan: Swap2ExecutionPlan) => {
      const why = checkPlanBrowser(plan, reviewed, LOCAL_PINS[reviewed.provider]);
      if (why) throw new SwapReviewMismatch(why);
      const planned = planWrites(plan);
      const s = plan.source;
      depositTo = s.kind === "call" ? s.to : s.kind === "token-transfer" ? s.recipient : undefined;
      if (planned.revokes.length) revokes = planned.revokes;        // the re-quote pass spends the first pass's allowance
      gate.arm(planned.writes, revokes);
    };
    const protocol = new RouterSwap2Protocol(account, {
      fromChain: reviewed.fromChain,
      router: appRouter().only(reviewed.provider),
      reviewExecution: arm,
      onExecutionPhase: (p, d) => input.onPhase?.(p, d),
      // NO accountChain / skipAccountChainCheck. TON later: decodeTonBody, tonGasCeiling: TON_BODY_GAS.
    });
    try {
      const res = await protocol.swap2({
        fromToken: from.catalogSymbol,
        toToken: destTokenId(to),
        ...(to.caip2 !== from.caip2 ? {toChain: to.caip2} : {}),
        fromTokenAmount: reviewed.amountIn,
        recipient: reviewed.recipient,
        refundAddress: reviewed.refundAddress,
        ...executionConstraints(reviewed),
      });
      return {id: res.id, ...(res.hash ? {hash: res.hash} : {}), ...(depositTo ? {depositTo} : {})};
    } finally {
      gate.disarm();                                                // never protocol.close(): providers are shared
    }
  });
}

async function withSwapLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!("locks" in navigator)) return fn();                         // + an in-memory Set fallback
  return navigator.locks.request(name, {ifAvailable: true}, async (lock) => {
    if (!lock) throw new Swap2InFlightError("swap2: this swap is already running in another tab");
    return fn();
  });
}
```

Persist the record as `submitting` at the first `onPhase` (port `M/swap/runner.ts:42-136`). On `Swap2MaybeSentError`, store it as `maybeSent` with `e.id ?? local id` and never offer a retry.

**Source-hash replacement.** After an EVM `swap2` resolves, run a background `pub.waitForTransactionReceipt({hash, onReplaced})`. On `reason === "repriced"` (the user sped it up in the wallet), rewrite the stored id to `encodeSwapId(provider, intentId, newHash)`, because providers that track by source hash (LI.FI) would not find the old one. On `cancelled`/`replaced`, mark the swap `not-sent`.

### 8.3 Claim (CCTP), port of `M/swap/execute.ts:274-323`

```ts
export async function previewClaim(id: string) {                    // read-only, shown before the user confirms
  const ref = decodeSwapId(id); if (!ref) throw new Error("Not a swap id");
  const tx = await appRouter().getProvider(ref.provider)?.buildClaim?.({intentId: ref.intentId, ...(ref.sourceTxHash ? {sourceTxHash: ref.sourceTxHash} : {})});
  return tx?.to && tx.data ? {chain: tx.chain, to: tx.to, data: tx.data, value: BigInt(tx.value || "0")} : null;
}
export async function claimSwap(id: string, dest: Extract<SourceSigner, {family: "evm"}>) {   // wallet already switched to dest chain
  const claim = await previewClaim(id); if (!claim) throw new Swap2StatusError("attestation pending");
  const ref = decodeSwapId(id)!;
  const gate = createSwapGate(claim.chain);
  gate.arm([{kind: "call", to: claim.to, data: claim.data, value: claim.value}]);
  const account = gateAccount(evmEngineAccount(dest), gate, claim.chain);
  const protocol = new RouterSwap2Protocol(undefined, {fromChain: claim.chain, router: appRouter().only(ref.provider)});
  try { return await protocol.claimSwap2(id, account); }           // → {hash, chain, id}; poll the NEW id
  finally { gate.disarm(); }
}
```

### 8.4 Status

```ts
export async function swapStatus(id: string, fromChain: string): Promise<Swap2StatusResult> {
  // Any valid fromChain works (status ignores it); mobile passes the record's (engine.ts:212-227).
  return new RouterSwap2Protocol(undefined, {fromChain, router: appRouter()}).getSwap2Status(id);
}
```

The poll schedule, stuck detection and step view come from `M/swap/inflight.ts` (`nextPollAt`, `duePolls`, `applyStatus`, `pollFailed`, `swapIncident`, `swapSteps`): 10 s while fresh, backing off to 2 min, "stuck" after 45 min. `action-required` with `TWO_PHASE.has(provider)` shows the Claim button.

### 8.5 Error text

Port `swapErrorText`/`swapFailureExpected`/`maybeSent` from `M/swap/execute.ts:326-364`. Replace "Face ID" with "your wallet", and add `SwapGateRefusal`, `SwapReviewMismatch` and wallet rejection (`answered` + code 4001 / `UserRejectedError`).

---

## 9. Deposit-address routes with no signer (BTC, ZEC… sources; QR)

`swap2()` cannot run without a signing account (`ENGINE:705-708`), so these routes skip it. What has to be done by hand:

```ts
const params = {...quoteParams(req), dry: false, refundAddress: userBtcAddress, minAmountOut: executionFloor(reviewedMin).toString()};
const set = await appRouter().only(provider).getQuotes(params, {requireImmediateExecution: true});
const q = set?.best;   // validQuote already ran: amounts, floor, slippage, expiry
```

Then:

1. Refuse unless `q.txRequest === undefined`, `q.depositAddress` is a valid address on `sourceChain`, and `q.depositMemo === null`. In v1, routes that need a memo or OP_RETURN, such as THORChain BTC, cannot be done from a QR wallet. Check `q.minDestAmount ≥ floor` again.
2. Show the QR code (address + exact `sourceAmount`, or 1Click `flex`) with the `validUntilMs` countdown.
3. Track with `encodeSwapId(q.provider, q.intentId)` → `getSwap2Status`. Whether a provider can track without a source hash is provider-specific (providers spec).
4. Calling `notifyDeposit(intentId, hash)` is optional when the user pastes their tx id.

There is no gate here (we sign nothing). The refund address the user enters is the critical field: validate it per chain.

---

## 10. Tests to write

- `gate.test.ts` (ported): `checkPlan` cases; `planWrites` for every source kind; `matches` (data case, body vs bodyBoc, memo); one stray write disarms the rest; revoke allowed only after a granted approve; TTL.
- `flow.test.ts` (ported): the real `RouterSwap2Protocol` over an in-process provider (mobile `flow.test.ts:20-60` `venue()`), a fake EVM engine account wrapped with `gateAccount`. Cases:
  - happy path with approve, then swap;
  - live plan with another spender → `SwapReviewMismatch` and no sends;
  - an extra write → `SwapGateRefusal`;
  - quote expiry after approve: identical re-quote → no second review; changed → `requoted`;
  - a wallet rejection on the swap → revoke prompt; a rejection on the approve → **no** revoke prompt;
  - insufficient gas → no sends.
- Solana: unit-test `walletStandardSigner` with a generated-key "wallet" (as in the probe): the signature verifies; a mutated message is refused; signing outside the window is refused.
- `ids.test.ts`: encode/decode round trip vs engine ids (`awk1.lifi.<id>.0xabc` with dots in the intent id).

---

## 11. Risks and open questions

1. **Human latency vs quote TTL.** There are 2–3 wallet prompts (USDT on mainnet: reset, approve, swap). The engine re-quotes once after approvals; it cannot help when the **swap** prompt itself is left open past `validUntilMs`. Calldata may then revert, or the deposit address may expire, which leads to a refund. Show a countdown and ask the user to confirm promptly.
2. **EVM fees are not enforceable** in the browser (the wallet picks them). Only the engine's pre-check (balance ≥ fees + value) and the advisory display remain.
3. **Smart-contract wallets** (Safe, ERC-4337) break `waitForTransaction` and the "same address on every chain" assumption. v1 refuses them (the `getCode` check, allowing the EIP-7702 `0xef0100` prefix).
4. **Wallet speed-up or cancel** changes the hash. Approvals are handled (`onReplaced`); source txs need the id rewrite (§8.2) or tracking breaks for hash-tracked providers.
5. **WalletConnect expiry** is treated as maybe-sent (no retry, no revoke). Injected-wallet errors use the EIP-1193 codes in §6.1, and anything else falls to the engine's heuristic. Confirm against the wagmi connectors you ship.
6. **Solana wallets that alter transactions** (Lighthouse and similar) are refused by design. If a popular wallet always alters them, the fallback (`checkSerialized` + `signAndSendTransaction`) is weaker: there is no byte equality, and errors are not definitive.
7. **Public RPC limits.** The Solana guard makes about 6–10 calls per swap, and mainnet-beta is ~100 req/10 s per IP. An origin-restricted key is the only safe keyed option in a static SPA.
8. **Shared provider instances.** `close()` closes shared providers (§2.5). Relay's one-deposit-per-order record lives in memory per page.
9. **The gate is in-page JavaScript.** It stops engine and provider mistakes, not a compromised bundle: use CSP, pinned dependencies, and no third-party scripts.
10. **Dry quotes must name the approval spender** for `checkPlan` to accept the live approval, and the pins must match each provider's config (e.g. the LI.FI Flare override). Both need per-provider verification in the providers spec.
11. **Omniston** (TON, EVM gasless orders) is not browser-ready: it needs a `buffer` polyfill, WebSockets and server-side quote and secret stores in cp0x-api. Keep it out of v1.
12. **`accountChain` must stay unset.** Setting it would silently bypass the only check that compares the live wallet chain with `fromChain` before the review. Add a unit test that fails if `RouterSwap2Protocol` is constructed with it.
