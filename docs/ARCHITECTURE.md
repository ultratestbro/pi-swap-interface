# cp0x Swap — architecture

Status: source of truth from the contracts phase (2026-11-11), updated after integration (2026-11-11, §9). It
reconciles the four specs in `docs/specs/` (`engine.md`, `providers.md`, `ui-port.md`, `catalog.md`); where they
disagree, **this file wins**. The specs stay the reference for details this file does not restate (exact numbers,
verbatim code, probe results).

cp0x Swap is a static web app (Vite 8, React 19, TypeScript 5.9 strict, pnpm). The Any Wallet Kit (AWK) swap2
providers run in the browser and verify every answer there; the user's own wallet signs; there is no backend of
its own, no fee, no geo-block, no screening of our own and no trackers; only the hosted build counts page views
(D31). A build made with
`VITE_CP0X_API` (the hosted one) adds the Standard connection mode, its default: quote requests and RPC calls go
through cp0x's swap-web proxy, a transport that adds cp0x's keys (D30). Every other mode, and every build without
that variable (IPFS, `npx`, Docker, a plain `pnpm build`), never contacts a cp0x domain (D24).

---

## 1. Module map

| module | paths | does | may import |
|---|---|---|---|
| **contracts** | `src/contracts/**` | Types only: domain, routes, execution, activity, wallets, config, ui props, ports, module export lists, the conformance check | `src/shared` (types), `viem`/AWK/Wallet Standard (types) |
| **config** | `src/config/**` | Runtime config (defaults, parse, load, the viewer's saved overrides), the connection modes (`connection.ts`: the build's cp0x API, the saved mode, Custom endpoints and keys, Standard's proxy slots; `standard.ts`: the health check and the proxy-routing fetch, D30), demo flag, hash routing, tab visibility, the port registry (`PortsProvider`/`usePorts`) | contracts, shared |
| **mocks** | `src/mocks/**` | Fixtures and the demo ports (every port backed by fixtures and timers) | contracts, config, shared |
| **shared** | `src/shared/**` | `@cp0x/shared` web subset: `chains.ts`, `format.ts` (verbatim copies) | — |
| **catalog** | `src/catalog/**` | Chains, tokens, addresses, prices, balances, viem chain defs, public clients | contracts, config, shared |
| **wallets** | `src/wallets/**` | wagmi (EIP-6963 injected + WalletConnect), Wallet Standard (Solana), injected Tron wallets (TronLink), TON Connect and its UI kit's wallet picker (TON), NEAR Connect's injected wallets (NEAR), connect/disconnect, signers | contracts, config, catalog |
| **swap** | `src/swap/**` | Provider registry + stores, engine (quotes, re-quotes, status), route-view model, amounts/slippage/gas math, quote hooks | contracts, config, catalog, shared |
| **execute** | `src/execute/**` | The only code that asks a wallet to sign: gate, engine accounts (EVM/Solana/Tron/TON/NEAR), executeSwap, startSwap, deposits, claims, ids, error texts | contracts, config, catalog, swap, activity |
| **activity** | `src/activity/**` | Swap records (inflight model), IndexedDB store, cross-tab sync, tracker | contracts, config, catalog, swap |
| **ui** | `src/ui/**`, `src/theme/**` | Design tokens, fonts, primitives (Text, Button, Sheet, …), logos | contracts |
| **screens** | `src/screens/**` | AppShell, SwapForm, RoutesPanel, TokenSheet, ReviewSheet, DepositPanel, ActivityDrawer, StatusView | contracts, config, ui, and the **pure** exports of catalog/swap/execute/activity/wallets; effects only via `usePorts()` |
| **app** | `src/main.tsx`, `src/App.tsx`, `src/polyfills.ts`, `index.html` | Boot (config first), provider tree, real vs demo ports, `#/gallery`, font preloads | everything |

The graph is acyclic: `contracts ← config ← catalog ← {wallets, swap} ← activity ← execute ← screens ← App`.
`execute` imports `activity` (the runner writes records); `activity` never imports `execute` (status comes from
`swap.swapStatus`). Modules import each other only through `index.ts`, never an internal file.

### 1.1 Spec paths → web paths (D1)

The specs used three layouts (`src/lib/swap/*`, `src/swap/*`, `src/catalog/*`). The ownership table decides:

| spec says | lives at | owner |
|---|---|---|
| engine.md `src/lib/swap/engine.ts`, `gas.ts`, `routes.ts`, `math.ts`; ui-port `recipient.ts`, `useRoutes.ts`, `webRoute.ts`, `venues.ts`, `send/amount.ts` | `src/swap/{engine,gas,routes,math,recipient,useRoutes,useRequote,webRoute,venues,amount}.ts` | swap |
| providers.md `src/swap/{providers,providerWrappers,providerMeta,stores,omnistonLazy,omniston}.ts`, `src/polyfills/buffer.ts` | same names under `src/swap/`; the polyfill as `src/swap/bufferPolyfill.ts` | swap |
| providers.md `src/swap/runtimeConfig.ts` | type `RuntimeConfig` in `src/contracts/config.ts`; defaults/parse/load in `src/config/` | contracts |
| engine.md `src/lib/swap/{gate,execute,ids}.ts`, `accounts/{evm,solana}.ts`; mobile `runner.ts`; `swapErrorText` | `src/execute/{gate,execute,ids,runner,deposit,claim,errors,pins}.ts`, `src/execute/accounts/{evm,solana,near,gated}.ts` | execute |
| ui-port `inflight.ts`, `store.ts`, `tracker.ts` | `src/activity/{inflight,store,tracker,port}.ts` | execute (activity) |
| catalog.md `src/catalog/chains.ts`, `src/lib/format.ts` | `src/shared/{chains,format}.ts` (alias `@cp0x/shared`), re-exported by catalog | catalog |
| catalog.md `network.ts`, `extraChains.ts`, `evm.ts`, `tokens.ts`, `prices.ts`, `balances/*`; ui-port `useSwapTokens.ts` | `src/catalog/…` same names | catalog |
| catalog.md `src/lib/addressFormat.ts`, `src/lib/recipient.ts`; ui-port `dapp/bytes.ts`, TON address helpers | `src/catalog/address.ts` (+ `bytes.ts`) | catalog |
| catalog.md `src/catalog/logos/*` (svg.ts, png) | **not** a TS module: static files in `public/logos/**` (D13) | ui-kit |
| ui-port `src/lib/appFocus.ts` | `src/config/focus.ts` (`appActive`) | contracts |
| ui-port `swap/draft.ts` | not ported: `SwapDraft` (contracts) lives in React state | — |
| ui-port `relayCleared.ts` (idb-keyval) | replaced by swap's IndexedDB `stores.ts` (D16) | swap |

---

## 2. File ownership

Write only inside your own paths. Read anything. Contract changes go through the orchestrator.

| owner | paths |
|---|---|
| ui-kit | `src/theme/**`, `src/ui/**`, `public/fonts/**`, `public/logos/**` (provider/network/token logos), `tests/unit/ui/**` |
| catalog | `src/catalog/**`, `src/shared/**` (copied @cp0x/shared chains.ts/format.ts), `tests/unit/catalog/**` |
| swap | `src/swap/**`, `tests/unit/swap/**` |
| wallets | `src/wallets/**`, `tests/unit/wallets/**` |
| execute | `src/execute/**`, `src/activity/**`, `tests/unit/execute/**`, `tests/unit/activity/**` |
| screens | `src/screens/**`, `tests/unit/screens/**` |
| dist | `Dockerfile`, `docker/**`, `bin/**`, `.github/**`, `vercel.json`, `README.md`, `CONTRIBUTING.md`, `THIRD_PARTY_NOTICES.md`, `public/runtime-config.example.json`, `.dockerignore`, `tests/unit/dist/**` |
| contracts (you) + integrator | `src/contracts/**`, `src/config/**`, `src/mocks/**`, `src/main.tsx`, `src/App.tsx`, `src/polyfills.ts`, `package.json`, `vite.config.ts`, `tsconfig*.json`, `eslint.config.js`, `playwright.config.ts`, `tests/e2e/**` — added: `index.html`, `.gitignore`, `pnpm-lock.yaml`, `tests/unit/config/**`, `tests/unit/contracts/**`, `docs/ARCHITECTURE.md`, `docs/screens/**` (e2e screenshots) |

The contracts-phase stubs (`// STUB (contracts phase)` headers in `src/{catalog,swap,wallets,execute,activity,
screens}/index.ts`, `src/ui/index.ts`, `src/ui/stub.tsx`, `src/screens/stub.tsx`, `src/theme/tokens.css`) are all
replaced; `grep -r "STUB (contracts phase)" src` returns nothing. Demo mode's fixtures live in `src/mocks` (real
data, not stubs). `src/shared/*` was seeded as a verbatim copy: catalog owns it.

---

## 3. Data flow

### 3.1 Boot

1. `main.tsx` imports `polyfills.ts`, then `await loadRuntimeConfig()` (D8), then `startConnection()` (D30: in
   Standard mode only, the proxy-routing fetch goes in and the health check starts in the background; nothing waits
   for it), then `import("./App")`. Every module therefore evaluates with the final config and sees the final
   `fetch`; `getRuntimeConfig()` is safe at module top level. `index.html` preloads the Regular and SemiBold WOFF2
   (built hrefs are relative, `./fonts/…`).
2. `App` reads the hash path: `#/gallery` renders the ui kit's `Gallery` (a lazy chunk, outside every provider, so it
   never starts wagmi, storage or quotes). Any other path renders `SwapRoot`, which picks the ports once:
   `isDemo() ? demoPorts : realPorts` (D15), and renders
   `QueryClientProvider → ports.wallets.Provider → PortsProvider → <SwapTracker/> + <screens.Routes/> + <ui.Toaster/>`.
   `Routes` is the swap screen; it resolves the demo scenes (`#/demo/<scene>`) itself.
3. `SwapTracker` calls `activity.useSwapTracker()` once: loads the persisted list, then polls.

### 3.2 Quote

```
wallets.useWallets() ──owners──▶ catalog.useSwapTokens(owners) ──▶ {pay, receive, byKey, prices}
screen: pair + amount + recipient/refund (validated) ──▶ QuoteRequest | null      (D7: null until both addresses exist)
                                           meanwhile ──▶ PreviewRequest | null    (D7: prices only; real addresses or none)
swap.useRoutes({mode: "live", req} | {mode: "preview", req} | null, prices)
  └ quoteRoutes(r, onUpdate, prices)          live: debounce 400 ms, refresh 30 s while visible; preview: 800 ms, no timer,
                                              one token of the tab's bucket per round (D29); stale rounds dropped
      ├ preview: wait for cp0x's health answer (proxySettled, ≤ 3 s; at once off Standard)   (D7: LI.FI / Fynd per round)
      ├ asked = appProviders().filter(enabled && supportsRoute (&& supportsSameChain))   → onUpdate({pending: asked})
      ├ gas = gasPricer(source, eth_gasPrice (20 s cache), native price)
      ├ new CrossChainRouter(appProviders(), {...ROUTER_RANKING, valueUsd: usdValue(prices, {gasUsd})})   per round, never closed
      ├ per venue (delegate): backing off after a rate limit → refused, nothing sent (D29); preview → previewSkip
      │   (LI.FI / Fynd only while proxyVenueLive, their signal keyedOnly) / previewAddressing (D7: a sample
      │   destination only where the venue needs one)
      └ router.getQuotes(live ? quoteParams(req) : previewBaseParams(req), {onUpdate}) → RouteSet
          → RouteSnapshot{mode, routes: WebRoute[], pending, rejections, asked, venues}
screen: useShownRoutes(r, state) → the list as shown (D32): a round over rows on screen keeps them; held = quoted for
        other terms than routesKey(r)
screen: keepSelection(routes, selected) → chosen route; the review opens only on a live request with a live snapshot,
        and never on a held route
```

### 3.3 Review

```
SwapDraft {req, route} ──▶ swap.useRequote(draft, prices)    every 30 s: requoteRoute(req, provider) via appRouter().only(p)
ReviewedSwap = {provider, fromChain, fromContract, amountIn, destChain, destToken: destTokenId(to),
                recipient: req.recipient, refundAddress: req.refundAddress,
                minOut: executionFloor(route.minDestAmount), slippageBps, approvalSpender, nativeFee}
Confirm blocked when: no route, gone, balance problem, EVM native unpriced (swapFeeCap undefined), busy.
```

### 3.4 Execute

```
signer = await ports.wallets.getSigner(from.caip2)     EVM: switchChain first (wallet prompt); Solana / TON: connected account
id = await ports.execute.startSwap({from, to, reviewed, expectedOut, signer})   resolves at the first engine phase
     the review stays (locked, its steps following useSwap(id)) until the swap is broadcast → StatusView (D34)
  └ executeSwap (engine.md §8.2)
      navigator.locks "cp0x-swap:<fromChain>:<payer>" (ifAvailable) → createSwapGate(fromChain) → engine account (EVM | Solana | TON)
      → refuse smart-contract accounts (EVM) → wallet account === reviewed.refundAddress → gateAccount(raw, gate)
      → new RouterSwap2Protocol(account, {fromChain, router: appRouter().only(provider), reviewExecution: arm, onExecutionPhase})
                                          TON payer: + decodeTonBody (keeps the BoC) and tonGasCeiling 0.5 TON (D35)
      → swap2({fromToken: catalogSymbol, toToken, toChain?, fromTokenAmount, recipient, refundAddress, minAmountOut, slippage})
         reviewExecution(plan): checkPlanBrowser(plan, reviewed, pins?, tonBody?) → checkTonCallBinding(plan, reviewed, boc?) (D35)
                                → planWrites(plan, boc?) → gate.arm      (re-armed on requoted plans)
         every wallet write consumes one armed write, else SwapGateRefusal (answered)
  └ record: submitting (stage, approvals) → pending + sourceHash | maybeSent | not-sent (swapErrorText)
      the write that makes it read as sent sets `counted` → Standard only: one POST <API>/api/v2/swap-web/sent (D36)
QR payer instead (BTC, ZEC…, TON without a TON wallet): ports.execute.issueDeposit({req, provider, minOut}) → DepositTicket + record mode "deposit"
```

### 3.5 Track

```
activity tracker (leader tab via navigator.locks "cp0x-swap-tracker"): duePolls every 5 s while visible, all on visibilitychange
  → swap.swapStatus(trackId ?? id, fromChain) → applyStatus | pollFailed → store (IndexedDB) → BroadcastChannel → every tab
  → settle: invalidate react-query ["bal"]
  → a QR deposit first seen (depositSeen): `counted` → Standard only: one POST <API>/api/v2/swap-web/sent (D36)
action-required + TWO_PHASE: previewClaim(id) → confirm → getSigner(toChain) → claimSwap(id, signer) → poll the NEW id
```

---

## 4. Decisions

**D1 — Layout.** One folder per owner (§1.1). `@cp0x/shared` resolves to `src/shared/index.ts` (vite alias +
tsconfig `paths`), so wallet files copied verbatim keep their imports. Modules import each other only through
`index.ts`.

**D2 — Real providers, one shared set per page.** No `remoteProvider`, no server pins, no cp0x-api in the quote or
the check (providers.md §0.1; Standard's proxy, D30, only carries the requests). `appProviders()` builds every enabled provider **once** from `getRuntimeConfig()`;
`appRouter()` is the unpriced router over it. A priced `CrossChainRouter` is built per quote round over the same
array. Never call `router.close()` / `protocol.close()` / `only(x).close()`; close providers on `pagehide` only
(Omniston's WebSocket is the only `close` today). Wrap provider methods **before** constructing any router.
Relay's issued-quote memory is per instance and per page: never resubmit a quote restored from storage.

**D3 — Provider set.** Default on, every mode, in ask order (`DEFAULT_ON_PROVIDERS`): `uniswap, curve, balancer,
wrap, usdt0, cctp, thorchain, chainflip, near_intents, lifi, relay, symbiosis, jupiter, omniston` (`curve` added
2026-11-12: Router NG `get_dy`/`exchange` over the page's RPC table, pinned pools, keyless, every mode; providers.md
§4.17). `symbiosis` (`paced` 1.1 s, one pacer per page; Tron and BTC sources off), `balancer` and `omniston` (lazy
chunk, needs IndexedDB, opens its WebSocket on the first quote; 0.5.5 trusts the rev2 TON minter that EVM→TON
quotes name) defaulted off until
the owner turned them on (2026-11-12), as cp0x's server runs them: USDT Ethereum → Tron showed fewer routes than the
wallet. A Symbiosis TON source is a jetton transfer carrying its bridge request, an Omniston TON source one carrying
its escrow order or a DEX swap (TON contract calls, D35), so `executionOf` reads them as signed, never a deposit address. Omniston is off (uncounted) until its chunk is in, and a
round waits up to 2 s for it (`LAZY_WAIT_MS`); between networks it is asked for tokens only (its SDK refuses a native
leg locally); on an IPFS path gateway it stays off unless the page's operator layer turns it on (its HTLC secret
would sit in storage every site there shares). An operator's layer or a viewer's Settings can still switch any venue
off (D8). Standard only,
default on there: `fynd` (2026-11-12; providers.md
§4.14) — built only on a Standard page, asked only while health says `venues.fynd` is "keyed", through cp0x's proxy
with cp0x's key; its API sends no CORS headers, so there is no direct fallback, and Public and Custom never build it
(Settings' venue row says "Standard mode only" and why this page doesn't ask it). Asked for previews too since
2026-11-13, through the same slot (D7: the EVM sample as its recipient and sender). Standard only too, the same way
(2026-11-15, D38): `zeroex` (0x Swap API v2) and `across` (Across), after Fynd. The Fynd
License: every route settles through the Tycho router, which the SDK and the gate enforce; §3.4 asks whoever hands a
Fynd route to someone to settle for a prominent notice of those router and anti-circumvention terms, so the review
of every Fynd route shows one with a link to the licence (`fyndRouterNotice`); a revenue share is owed only on fees
the integrator earns, and cp0x Swap charges none. Every fee option stays unset
(zero fee). Options per provider = providers.md §4 / §6.2 verbatim (LI.FI Flare Diamond
override, THORChain `tronSource: false`, Jupiter `withQuoteGap(2100 ms)`, wrap `narrowRoute(isWrapPair)`, Relay
`clearedStore`), plus LI.FI `coolDownOnRateLimit(lifi)` (D28) and USDT0's Legacy Mesh into TON and Tron
(`meshDestinations: ["ton", "tron"]`, the operator's `tonApiUrl`; Tron's LayerZero fee is above the engine's
native-fee cap, so `execute.ts` `nativeFeeCeiling` raises it to 0.01 ETH for that route alone, from Ethereum or
Arbitrum: owner's decision, 2026-11-13). Allowlists (LI.FI targets, THORChain routers, Omniston contracts) are code, never config.

**D4 — Token model.** catalog.md §3.4 wins over ui-port §4.4: `Token` (static, 405 catalog rows) and `SwapToken`
(+ `amount`, `balance` state, `priceUsd`, `usd`, `owner: string | null`, `payMode`). `key =
<slug>:<contract lowercased | native>`; `contract` keeps its case. `gasToken` marks natives plus Celo CELO / Arc
USDC (ERC-20 faces), and MAX reserves gas for them. Pay side = `payMode !== "none"` (`wallet`, `connect`,
`deposit`); receive side = every token. Tokens imported by their address (D39) join both after the catalog's, marked
`imported` (their `catalogSymbol` is their contract; priced and shown with a logo only as found by that contract).

**D5 — Chains.** `src/shared/chains.ts` is `@cp0x/shared` verbatim with one patch (World Chain's dead tenderly
RPC → drpc + thirdweb). The web `Chain` adds `catalogKey`, `memo`, `icon`, `receiveOnly` (catalog.md §2.3). The 9
catalog-only chains (LTC, DOGE, XRP, …) stay behind `VITE_EXTRA_CHAINS=1`, off: they need validators and a memo UI.
Elysium (99901) is a normal catalog chain; viem has no definition for it, so all EVM chains are built with
`defineChain` from the catalog.

**D6 — Prices.** DefiLlama `coins.llama.fi/prices/current` first, CoinGecko `simple/price` fallback (its 429 has
no CORS header). Keys = `PRICE_IDS` (catalog.md Appendix A: the wallet's GECKO_IDS + additions); bases from
`config.prices`. Output `PriceMap` (symbol → USD), `{}` when both fail (the router then ranks on raw output). No
hard-coded $1 for stables (`usdValue` already does it, and a de-peg must show). One stable object per update;
react-query key `["prices"]`, 60 s; `localStorage "cp0x.prices.v1"` only as a warm start. Footer credit
"Prices: DefiLlama · CoinGecko".

**D7 — Live quotes need explicit addresses; preview prices before them (rewritten 2026-11-12).**
- **Live.** `QuoteRequest` carries explicit `recipient` and `refundAddress` (both required, both validated);
  `quoteParams` uses them as `destAddress`/`refundAddress` and throws on a blank one and on a preview's runtime brand
  (`preview: true`), so neither can reach a live quote, the review's re-quote or `issueDeposit` (which also refuses the
  brand itself). The screen builds no `QuoteRequest` until both exist: pay token `payMode "connect"` (EVM/Solana, no
  wallet) → CTA "Connect {EVM|Solana} wallet to swap"; `payMode "deposit"` (BTC, ZEC, TON without a TON wallet, …) → the RefundField must hold
  a valid address of that family ("Enter the {Chain} refund address to swap"); a receive family without a connected
  wallet → the RecipientField is forced on and must hold a valid address ("Enter the {Chain} address to swap"). Only a
  live request, picked from a live snapshot, becomes a `SwapDraft`, a deposit or an execution; `QuoteRequest`,
  `SwapDraft` and `IssueDepositInput` are unchanged.
- **Preview.** While only the wallet, the refund address or the recipient is missing, an amount is typed, both
  families have a sample (`canPreview`: EVM, Solana, Bitcoin, TON, Tron, Zcash; not NEAR) and `preview.enabled`, the
  form builds a `PreviewRequest` (`preview: true`, the real validated addresses it has or none, `toOther`) and the
  list quotes `{mode: "preview", req}`. Not assignable to `QuoteRequest` (its addresses are optional), so it can't
  type-check into a draft, a deposit or an execution. The engine's preview round (`src/swap/preview.ts`) is the ONLY
  place a sample address exists, and only per venue: a blank destination gets the destination family's sample (the
  SDK's own table, near-intents chunk-4DBCMQCI.js:46-60) for uniswap, curve, balancer, thorchain, chainflip,
  near_intents and fynd, whose dry quotes can't price without one, and for lifi only Solana → EVM (its dry quote
  reuses the sender's placeholder as the destination, `FILLS_OTHER_FAMILY`; EVM → Solana prices for its own Solana
  placeholder since lifi 0.8.0); relay, usdt0, cctp, symbiosis, omniston, wrap and jupiter keep the blank address and
  apply their own handling (Relay flags a blank-address quote as a placeholder and never issues it, so it is NEVER
  filled; Symbiosis fills its own placeholders, sender included; Omniston's RFQ carries no address; usdt0 0.5.0 and
  lifi 0.8.0 return a quote priced for their own placeholder as price-only, without its transaction); the refund is
  the real one or absent, never `""` (NEAR reads `refundAddress ?? its sample`). Symbiosis' one pacer per page holds its 1 req/s through a preview burst.
  Jupiter and Wrap sit out a preview with "Send to another address" on, as their live quote would refuse it. The
  table per venue: providers.md §4.16. Samples never enter UI state, a request, a record, storage or a URL — venue
  texts included: a preview round passes every refusal through `scrubSamples` before it is classified, so THORChain's
  "memo failed verification (=:BTC.BTC:bc1qar0…)" or a 1Click message that repeats the recipient shows
  `<sample-address>` in the "Technical reason" (the user's own addresses are kept; no space in the stand-in, so the
  table's `\S+` rules read the text as before); so do the TON and Tron placeholders Symbiosis fills in itself and
  LI.FI's own Solana sender. No user-facing check refuses a sample value as a recipient:
  `0xd8dA…6045` is a real account people send to.
- **LI.FI and Fynd in previews (owner, 2026-11-13; `KEYED_PREVIEW_VENUES`).** Asked in a preview only while cp0x's
  proxy carries them with cp0x's key: a Standard page (D30), health "keyed", the slot not stopped after a failure or a
  daily limit (`proxyVenueLive`). Decided per preview round, never once per page: the round first waits for the health
  answer (`proxySettled`, 3 s at most), then each venue's skip reads the slot as the round asks it, so a slot that
  stops sends later previews back to the live-only rule and one that comes back (a Retry-After, 00:00 UTC) is asked
  again. There LI.FI's keyless ~75 `/quote` per 2 h per IP and one visitor's share of Fynd's key don't apply; cp0x's
  daily budgets cap the spend (LI.FI 5000, Fynd 3000 shared with the cp0x wallet) and D29's bucket paces each tab.
  Everywhere else — Public, Custom (a viewer's own LI.FI key included), a build without the API, health anonymous or
  unreachable, a stopped slot — LI.FI waits for the live quote. Fynd is then asked by no round, live ones included: it
  is built only on a Standard page and asked only while its slot is live (`whileLive`), so it is absent from the list
  rather than "quoted after you connect" (only a slot that stops between a round's start and its skip check leaves it
  `deferred` for that round). A preview never makes either fall back to a keyless call more than the existing per-call
  fallback does: the round marks the signal it gives them (`keyedOnly`), and the routing sends a marked call straight
  to the venue only as the one retry after a failure at the proxy itself (which stops the slot), and that once per
  slot and page; from an unused or stopped slot it fails at once WITHOUT a request, like an RPC slot, so the SDK's own
  second `/quote` in that round (LI.FI's slippage rescale) and every later preview send nothing, and once a short stop
  runs out (a Retry-After: 1 s to 5 min, 60 s for an upstream 429) a second failure at the proxy retries nothing
  either. Fynd never goes direct at all (D30). Live rounds are unchanged: they neither wait for health nor mark
  anything.
- **Left for the live quote (`deferred`).** A venue a preview leaves for the live quote (LI.FI as above, Fynd only in
  that race; a venue whose blank-address handling hasn't been read) is no refusal: its row is the `deferred` category,
  `skipped`, outside "Didn't quote" and outside its count, in a quiet collapsed group of its own before "Not for this
  pair": "Quoted after you connect (N)" ("Quoted after you add the address (N)" while a recipient or refund address is
  what is missing). The row says what gets the quote, from the form's `Missing` (`deferredCopy`): "Connect a wallet to
  get this quote", "Paste the address to get this quote", "Enter the refund address to get this quote"; behind it,
  "Preview prices skip it here to save its request limit for your own quote — it's asked as soon as your wallet is
  connected or your address is entered."
- **Never reviewable.** The snapshot carries `mode`; `useRoutes`' key starts with it, so the preview rows clear the
  moment the request becomes live and a live round runs. `ctaState` never returns "review" on a preview list (the
  connect / address states; "Getting your quote…" if a live request still shows preview rows); Enter on a route
  presses the CTA (the wallets, or focus on the missing address field); a click only selects the row, or opens the
  route sheet on phones — never the review. `openReview` requires `form.req && snapshot.mode === "live"`:
  required, not cosmetic, because the review falls back to the drafted route on a network error and Confirm takes its
  floor, spender and native fee. The UI says what it is: a "Preview" tag per row with "≈" and "est. min", "≈" on the
  receive amount, the summary's "Estimated minimum" in place of "Minimum received", and the CTA naming what makes it a
  quote ("Connect EVM wallet to swap", "Enter the Tron address to swap"). The banner above the list that said so again
  was dropped (owner, 2026-11-12).
- **Off switch.** Runtime config `preview.enabled` (default true) is the operator's kill switch; a viewer's saved
  settings may only turn it off (D8). Off: nothing is quoted until both addresses exist, and the idle hint names what
  is missing ("Connect a wallet to see routes", "Enter the {Chain} address to see routes"). Pacing: D29.

**D8 — Runtime config.** `./runtime-config.json` beside `index.html` (resolved against `document.baseURI`, so
`/ipfs/<cid>/` works), fetched once with `cache: "no-store"` and a 4 s timeout; 404 = defaults, and so is a 200
`text/html` answer (an SPA fallback such as `vite preview` serving `index.html`), without a warning. Layers, last
wins: defaults → `VITE_SWAP_CONFIG` (build-time JSON) → the file → the viewer's saved settings (localStorage
`cp0x.swap.settings.v1`, written by the Settings sheet through `src/config/userSettings.ts`; `demo` and
`nearIntents` are dropped on read, because suspensions are the operator's lever, and so are `evmRpc` / `solanaRpc`,
which are the connection's now (Custom mode, D30), and `nearRpc`, the operator's only; a venue an operator layer set to
`false` stays off; `preview` may only be switched off there, the operator's `roundsBurst` / `roundRefillMs` stay (D29);
the whole layer is ignored on an IPFS path gateway `/ipfs/…` / `/ipns/…`, one origin for every
site on it; `savedOverrides()` lists the API / price hosts and RPC chains it changed — Custom's own RPCs included —
and the swap screen and the review name them) → `?demo=1|0` in the hash query → the connection mode (D30: Custom's
RPCs first in their lists; Standard's proxy slots, which `savedOverrides()` never lists). Sections
merge key by key; `evmRpc` merges per chain id (an entry replaces that chain's list); arrays replace. Unknown keys
and invalid values are dropped with a console warning (never a crash). URLs must be `https:` (`wss:` for
Omniston; plain `http://localhost|127.0.0.1` allowed for RPCs only); `api.thorNodes` needs ≥ 2 distinct hosts;
`nearIntents.suspendedChains` accepts `{caip2: reason}` or the server's `"caip2=reason;…"` string. No secrets:
WalletConnect's `projectId` is public by design; `""` hides WalletConnect. Defaults: `src/config/defaults.ts`
(the server's public RPC first, then the catalog's lists; Solana = publicnode + solanavibestation; NEAR = FastNear,
`nearRpc`, which may be emptied: no NEAR reads, so balances stay unknown and a NEAR wallet's deposits are refused
before signing).

**D9 — Boot order; config fixed per page.** Config loads before any module evaluates (§3.1). Changing it needs a
reload: providers, viem chains and the wagmi config are built once.

**D10 — Signing choke point.** Only `src/execute/accounts/**` may call a wallet write (`sendTransaction`,
`signTypedData`, `writeContract`, `signMessage`, Wallet Standard `signTransaction` / `signAndSendTransaction`, NEAR
`signAndSendTransaction(s)` / `signDelegateActions`, …).
Enforced by ESLint (`no-restricted-syntax` + `no-restricted-imports` in `eslint.config.js`: direct calls,
`.call/.apply/.bind` on a write, `Reflect.*`, computed calls with a run-time key, the signing RPC / Wallet Standard
names as literals (WalletConnect's `tron_sign*` too), TronWeb's `trx` member, EIP-1193 `request()` — in
`src/wallets/tron` only a literal `{method: "eth_requestAccounts" | "tron_requestAccounts"}`, the connect prompt — and
`getProvider()` outside `src/wallets/evm`) and a CI grep (dist) over the same names;
`tests/unit/dist/chokepoint.test.ts` feeds both a bypass probe.
The gate (engine.md §7.3) is **per execution** (`createSwapGate`): `reviewExecution` = `checkPlanBrowser`
(checkPlan + family/kind check + optional local pins) → `planWrites` → `arm`; each write consumes one armed write;
one stray write disarms the rest; refusals are `answered`. A revoke (`approve(spender, 0)`) passes only for an
allowance this run granted. TTL 15 min from each (re)arm. Cross-tab `navigator.locks` per `fromChain:payer`
(fallback: an in-memory set). The wallet's account must equal `reviewed.refundAddress`. EVM smart-contract accounts
are refused in v1 (`getCode` neither empty nor an EIP-7702 `0xef0100…` delegation). `accountChain` /
`skipAccountChainCheck` are never set (a unit test asserts it). No `dataSuffix` anywhere (it changes signed calldata).
On Tron (2026-11-12) `checkPlanBrowser` also holds the plan to the venue's Tron rule (`TRON_RULES`, pins.ts: NEAR
Intents → its per-quote deposit address, no memo; Chainflip → its Tron Vault from `CF_VAULTS`, with the hex note its
SDK decoded and checked; no rule → refused): no approval, calldata or TON body, exactly the reviewed amount, never the
payer's own address; the armed write carries the memo's encoding (`memoEncoding`), so a hex note can't be sent as
text. The Tron account (`accounts/tron.ts`) then builds the transaction itself from the consumed write
(`tronTx.ts`: protobuf `Transaction.raw`, a mainnet reference block, `fee_limit` = the 60 TRX fee ceiling, 10 min
expiry), re-checks the bytes (`checkTronRaw`: one TRX `TransferContract` or a TRC-20 `transfer(deposit, amount)` on
the catalog's contract, from the payer, the reviewed memo, no other field), dry-runs a TRC-20 transfer, asks the wallet
for one `trx.sign` (never a broadcast), keeps only a signature that recovers the payer over its own txID, and
broadcasts its own bytes (`/wallet/broadcasthex`, host by host: every host refusing = not sent; a lost answer =
maybe-sent with the txID).
TON (2026-11-12): `checkPlanBrowser` holds a TON plan to `checkTonPlan` (`src/execute/tonPlan.ts`: a deposit —
TON to an address or a jetton transfer, at most a text comment; no approval, mainnet addresses; a cell body only as a
venue's TON contract call, D35), and
the TON account (`accounts/ton.ts`, a lazy chunk with `@ton/core`) turns the consumed write into ONE TON Connect
message that `checkTonRequest` (`src/execute/tonGate.ts`) decodes back from its own BoCs before `sendTransaction`:
mainnet, from the reviewed wallet, ≤ 5 min validity, no state init; the deposit address (bounce flag included), the
amount, the comment or none; for a jetton, the payer's own jetton wallet (TonAPI's `get_wallet_address`, equal to
the address computed from the jetton's pinned wallet code and proven by its `get_wallet_data` — owner, master,
balance; a jetton without pinned code is refused, so only USDT is sent today), 0.05 TON + 1 nanoTON forward, and a
body whose amount, recipient, excess address (the payer), forward amount and comment are exactly the reviewed ones;
for a contract call (D35), that same proven wallet, bounceable, the TON the write attaches (≤ 0.5 TON) and the armed
BoC itself, read again against the reviewed call, then bound again (Omniston's escrow: the secret this browser holds,
its package's checks; D35 part B); for a call paid in TON (Omniston's swap, part C), the write's own target — a DEX
contract the app pins — the input plus at most 0.5 TON, the armed BoC, read and bound the same way.
TON Connect's error answer, the SDK's refusal before it hands the request over, or a failure before an installed
wallet (JS bridge) got it, is `answered`; on TON Connect's HTTP bridge (which confirms a request only once its POST
was answered, retrying until then) any other failure or silence is maybe-sent, as is a lost answer after the wallet
got it; the record's hash is the signed message's normalized (TEP-467) hash. ESLint and the CI grep also name TON
Connect's `signData`. TON Connect UI (D11) only picks the wallet: it is handed a view of the connector without
`sendTransaction` or `signData`, its own `sendTransaction` / `signData` / `signMessage` are never called, and the
`TonSender` execute gets is the SDK connector itself, so this gate stays the only way a TON request is sent.
NEAR (2026-11-12, `accounts/near.ts`): a NEAR wallet builds, signs and broadcasts in one call, so nothing signed can
be checked afterwards. checkPlanBrowser lets only a `deposit` venue (NEAR Intents) pay from NEAR: no approval, no
memo (the review shows none), a NEAR value of exactly the input, never to the refund account. The account then builds
the transaction itself from the gated write — a `Transfer` to the deposit address, or on the token contract
`ft_transfer` (1 yoctoNEAR, 30 Tgas) preceded by `storage_deposit` (registration only, ≤ 0.0125 NEAR) when the
deposit address is not registered — holds it to the write once more (`checkNearTransaction`: receiver, token,
amount, memo, nothing else), freezes it, re-reads the wallet's accounts, reads the account's NEAR (`view_account`)
and refuses, `answered`, when it can't pay every attached deposit plus the attached gas and 5 Tgas of fees at 2.5×
the floor gas price (a wallet error before inclusion would otherwise be "maybe sent"), and only then calls
`signAndSendTransaction` inside the signing window. The answer is checked too: a 32-byte hash, and the transaction it
reports — signer = the reviewed account, receiver and actions (RPC format, args decoded) = exactly the built ones —
not `Failure`. One that differs, or doesn't show signer, receiver and actions, is `maybeSent` with its hash: tracked,
never notified to the venue as the deposit. A rejection is `answered`, any other wallet error `maybeSent`.

**D11 — Wallet connections.** EVM: wagmi `createConfig({chains: VIEM_CHAINS, transports over config.evmRpc,
multiInjectedProviderDiscovery: true, connectors})` — both without cp0x's proxy URLs (D30: the chain definitions
feed `wallet_addEthereumChain`, the transports WalletConnect's rpcMap): injected wallets via EIP-6963, plus `walletConnect` only
when `walletConnect.projectId` is set, with `showQrModal: false` — the screens show `WalletsState.pairingUri` with
`ui.QrCode` (AppKit's modal loads a remote wallet list and telemetry; any telemetry option the WalletConnect
packages expose is turned off; WalletConnect's relay is contacted only after the user picks it). Solana:
`@wallet-standard/app` `getWallets()`, listing wallets with `solana:mainnet`, `standard:connect` and
`solana:signTransaction` supporting v0; silent reconnect on reload (remembered wallet name in localStorage). Tron
(2026-11-12): injected wallets only — TIP-6963 announcements (TronLink: rdns `org.tronlink.www`), else
`window.tron` (TIP-1193), else the legacy `window.tronLink` / `window.tronWeb`; option ids `tron:<rdns>`. Connect =
the wallet's `eth_requestAccounts` (legacy `tron_requestAccounts`); `accountsChanged` / `chainChanged` follow it
(`[]` = locked); the silent reconnect reads the remembered wallet's TronWeb `defaultAddress`, never a prompt. Nothing
is fetched to find a wallet. WalletConnect's `tron` namespace is not offered: the installed
`@walletconnect/ethereum-provider` builds eip155 sessions only (numeric chain ids), and a Tron session needs
`@walletconnect/universal-provider` or `sign-client` as a new direct dependency. Contract changes: `WalletFamily` +
`"tron"`, `TronConnection`, `WalletsState.tron`, `ConnectOptionGroups.tron`, `TronWebLike`, `TronSourceSigner`,
`RuntimeConfig.tronApi`, `CatalogModule.QR_FALLBACK_FAMILIES`.
NEAR (2026-11-12): browser-extension wallets through NEAR Connect's injection protocol only — the page fires
`near-selector-ready`, each wallet answers `near-wallet-injected` with its API (HOT's extension does; others may).
The `@hot-labs/near-connect` package is not used: it fetches its wallet list from GitHub/jsDelivr at boot and runs
each wallet's script from that wallet's host in a sandboxed `srcdoc` iframe (remote scripts, iframes, D24);
`@near-wallet-selector/*` needs near-api-js and per-wallet SDKs that open popups and relays. So web, mobile and Ledger
NEAR wallets are not offered, and NEAR keeps the QR (D20). Connect = `signIn({network: "mainnet"})` (never an
access key), an account the catalog accepts (implicit hex or `.near`); silent reconnect = `getAccounts` on the
remembered wallet (`cp0x.nearWallet.v1`), never `signIn`; the injected API has no account events, so execute reads
the accounts again before it prompts. Balances read the NEAR RPC (`nearRpc`, FastNear by default, D8) only once
connected.
`getSigner(caip2)` is the only way execution gets a wallet: EVM switches the chain first (wagmi adds unknown chains,
e.g. Elysium, from `VIEM_CHAINS`); a refused switch throws an `answered` Error "Switch your wallet to {Chain} to
swap."; not connected → "Connect a{n} {EVM|Solana|Tron|TON|NEAR} wallet first."; Tron refuses a wallet on a test network
(`chainChanged`, else its TronWeb's node host) and one that switched accounts since connecting (the transaction is
built on a mainnet block either way, so it is valid only there). `disconnect(family)` while a connect of that
family is pending (an open pairing QR, TON Connect's modal) cancels that attempt and keeps any connected wallet
(WalletConnect cannot abort a pairing, its QR just stops being shown; a TON Connect attempt is aborted and its modal
closed). The wallet sheet calls it whenever it closes (Escape, ×, the backdrop, a drag down, its Settings button)
during a WalletConnect attempt, before or after the QR (uncancelled, every option would stay disabled until the
proposal expires); an installed EVM, Solana, Tron, TON or NEAR wallet's pending connect is left to its own prompt,
and a TON Connect attempt to its own modal, which the sheet has closed for. A TON connect gives up after 5 minutes
and closes the modal (the SDK would retry its bridges forever), so a stuck attempt can't keep every wallet option
locked. A WalletConnect attempt that shows no pairing QR within
`WC_START_MS` (15 s, `evm/runtime.ts`) fails with the answered "WalletConnect didn't start — its relay refused this
site or isn't answering. Try a browser wallet or try again later." — a relay that refuses the origin (close 3000
"Unauthorized: origin not allowed" while the Reown project doesn't list the domain) leaves the provider reconnecting
forever, with no URI and a connect that never settles; the relay's close code reaches no public WalletConnect event,
so the timeout is the signal. The connector is dropped so the next attempt starts fresh, and a late URI from a
dropped one is never shown; once a QR is up there is no limit (scanning may take long). Only the latest
WalletConnect attempt may drop the connector — a cancelled attempt's deadline leaves it to a retry on the same
connector — and only a URI that reaches the screen lifts a limit (one from a dropped connector or after a cancel
lifts none).
TON (owner, 2026-11-12; revised by the owner 2026-11-13, "use the official TON Connect" — TON wallets connect through the official TON Connect UI, its modal and its official wallet list, instead of
our three-wallet menu and our own QR): TON Connect through `@tonconnect/sdk`, a lazy chunk loaded only when the viewer
picks TON, or on a reload after a TON wallet was connected (`cp0x.tonWallet.v1`) — never at boot otherwise. The
SDK is built with `analytics: {mode: "off"}` (it would post every connect and transaction event to
analytics.ton.org), a silent event dispatcher, its session under `cp0x.tonconnect.*`, `setConnectionNetwork(MAINNET)`,
and `walletsListSource` = `tonconnect-wallets.json` beside `index.html`: a self-hosted snapshot of TON Connect's
official list (config.ton.org/wallets-v2.json, every wallet, unmodified but for each `image`, which points at its
icon bundled under `logos/ton-wallets/`, relative so a sub-path works), rebuilt with its icons and the menu's table
(`src/wallets/ton/officialWallets.ts`) by `.github/scripts/ton-wallets.mjs` and checked by a unit test. TON's remote
list is never fetched; the static `TonConnect.getWallets()` / `TonConnectUI.getWallets()` (the remote list) and
`enableQaMode` are never called, and WalletConnect inside TON Connect is never initialized. The menu's TON section
lists the wallets whose JS bridge is on the page (`window[key].tonconnect` for a key in the list or cp0x's `cp0x`: an
extension, or the page running in that wallet's in-app browser, `isWalletBrowser`) as installed — they connect through
that bridge, without the modal (option ids `tonconnect:<app name>`) — and one "TON Connect" entry (`tonconnect`, the
bundled TON logo). That entry closes the menu (a modal dialog: focus trap, outside pointers blocked, scroll lock) and,
once it is gone (`Sheet.onClosed`), opens `@tonconnect/ui` 2.4.4's modal: a second lazy chunk, built once on that
first pick as a picker only — `restoreConnection: false`, the silent dispatcher, no button, English, the app's dark
theme, and cp0x's wallet added through `includeWallets` (bundled icon, `aboutUrl` "./": no cp0x host in the bundle,
D24) when its in-app browser injects it. It is handed a view of our connector (`PickerConnector`): reads pass through,
it has no write, and every connect the modal starts carries the attempt's `AbortSignal` — closing the modal alone
leaves the modal's connect listening on every bridge in the list (2.4.4 only closes it), so a cancel, the 5-minute
give-up or the viewer closing the modal aborts that signal and the bridges close. The attempt follows the modal:
`connecting` until a wallet connects (success: our connector's status change with a mainnet account, then
`cp0x.tonWallet.v1`), or the viewer closes it (a quiet cancel, no error). A wallet's error while the modal is open is
the modal's, and 2.4.4 shows little of it (review 2026-11-13): a decline only on its desktop screen for one wallet (with
a retry), a wrong network on that screen and the phone's; a decline on its universal QR (what wide screens open on) or
on a phone's screen changes nothing on the page — the attempt stays `connecting` until the viewer closes the modal (a
quiet cancel) or the 5-minute give-up. An attempt that ends in an error (our list or the UI didn't load, the give-up,
a testnet account, a decline from a wallet the page runs inside, which the entry connects without opening the modal)
reopens the menu on TON, where the error shows (`SwapScreen`): the menu was closed for the modal. A reload's restore
uses the connector alone and never loads the UI.
TON Connect UI hotlinks two images on GitHub in that flow (the TON mark in its QR, Telegram's on "Wallet in Telegram")
and sets an inline `ontouchstart` on `<body>`; a Vite transform scoped to its module (`vite.config.ts`, not a package
patch) points the images at bundled copies (`logos/tonconnect/`) and swaps the handler for a listener, and fails the
build when a version moves either, so the modal causes no CSP violation. `pnpm dev` pre-bundles the package in its
dependency optimizer, which plugin transforms don't reach, so the same transform runs there too
(`optimizeDeps.rolldownOptions.plugins`): dev serves what the build ships. If `tonconnect-wallets.json` can't be read
(a gateway's hiccup, a bad deploy), the SDK resolves its list with its own bundled one — remote icons the CSP blocks,
bridges ours doesn't name — and keeps that for the connector's life. So the UI is only built over a connector whose
list is ours (every image a bundled `logos/ton-wallets/` icon; the SDK fetches the list once per connector, so it
stays ours): otherwise the pick is answered "TON Connect's wallet list didn't load — check your connection and try
again." with no modal, and the connector is dropped (unless a session lives on it or a reload's restore still runs on
it), so the next pick fetches ours again. Not a `walletsListCacheTTLMs`: the SDK also reads the list on every read of
a bridge session (`actualizeBridgeConnection`), so a TTL would refetch it all through a connected session and could
swap the fallback's bridge into it. Accepted (owner, 2026-11-13):
once the viewer picks TON Connect, the modal's universal QR opens SSE to every bridge in the list (25 hosts on
2026-11-13) — at once on wide screens, on the first tap on a phone — and the wallet picked there is reached over its
bridge; nothing TON-side is contacted before that pick. Only a mainnet account is kept (raw address → `UQ…` for
display, the refund address and the review); the connected wallet's name comes from the list by `device.appName`. The wallet fetches `tonconnect-manifest.json` beside `index.html` ("cp0x Swap", the hosted origin
`https://swap.cp0x.com`, its apple-touch-icon); a copy on another origin serves its own (README; the dist guard
allows that file to name its page's origin and nothing else). `getSigner("ton:-239")` → `TonSourceSigner` (the
connector as `TonSender`, raw and friendly address, `tonApiUrl`). TON balances come from TonAPI
(`catalog/balances/ton.ts`), asked only for a connected TON wallet. A TON contract call (a jetton transfer whose
forward payload is the venue's instruction, a cell body) is signed only as D35 lists it — Symbiosis paid in USDT for
a token it releases directly on an EVM network, Omniston's escrow paid in USDT for a token on an EVM network (part B),
Omniston's swap between TON and USDT in one step through a DEX contract the app pins (part C: STON.fi v1, STON.fi v2's
TON/USDT router, DeDust v1; TON itself then sent to the DEX); Omniston's other TON swaps (other tokens, DeDust CPMM v2,
TONCO, swap.coffee, other STON.fi v2 routers, several hops), a cross-chain call from native TON or another jetton,
and Symbiosis to Tron or to a token reached by a swap on arrival are not wired: `checkTonPlan` refuses their cell
bodies and the route list lists such routes as refused for a TON wallet ("TON contract calls aren't signed here yet",
"Only TON ↔ USDT swaps are signed here", "Routed through a DEX that isn't pinned here").

**D12 — EVM engine account.** engine.md §6.1 as written: reads, gas quotes and `eth_call` simulation through
`WalletAccountReadOnlyEvm` over the runtime RPC list; writes through the viem `WalletClient`; `getChainId()` from
the wallet (no `chain` property); owner re-check before each prompt; `normalizeWalletError` marks EIP-1193
definitive codes `answered` and WalletConnect expiries `maybeSent`; `waitForEvmTx` handles speed-up/cancel. EVM
fee caps are advisory only (the wallet picks gas); `swapFeeCap` drives the review warning and the "unpriced
native" block.

**D13 — Logos and assets.** Static files only, no runtime hotlinks (CMC / CoinGecko / Trust Wallet / DeBank CDNs
would see every visitor's IP and token interest). `public/logos/providers/<name>{,@2x,@3x}.png` (18 venues),
`public/logos/networks/<slug>.svg` (split from mobile `assets/logos.ts`), `public/logos/tokens/<SYM>.svg` and
`public/logos/tokens/png/<stem>@{2,3}x.png` (mobile TOKEN_IMAGES map), optional build-time mirror
`public/logos/catalog/<caip2_>/<contract|native>.png` + `index.json`. AssetIcon order: bundled PNG by symbol →
SVG by symbol → the gas token's network SVG → catalog mirror by (caip2, contract) → monogram. `Token.icon` /
`Chain.icon` stay data only. TON Connect UI's wallet picker (D11) shows the icons bundled with the self-hosted
wallets list (`public/logos/ton-wallets/<app_name>.png`) and its own two images from `public/logos/tonconnect/`.
Fonts: Cp0xGrotesk 400/500/600/700 WOFF2 + `OFL.txt`. Every asset URL must resolve under a sub-path (relative base
`./`).

**D14 — THORChain nodes.** `nodeUrl = [Liquify, THORWallet]` (Liquify first since 2026-11-12: a lagging node's
"stale state" answer is final for the SDK), `confirmNodeUrl = []` (each confirms the other);
`thorchain.ibs.team` (403 to CORS) is appended by the SDK and fails harmlessly. THORChain is the least reliable MVP
venue in a browser; a third operator can be added through `api.thorConfirmNodes`. In Standard mode (D30) cp0x's
THORNode pass-through (`…/venue/thornode`, which forwards to thorchain.ibs.team — in sync with Liquify, but its CORS
preflight answers browsers 403) goes FIRST in the confirm list while health says so; the quote nodes stay direct, so the proxy can never both quote and confirm.
Since thorchain 0.4.0 a confirming node vouches for the quoted vault when it is its current inbound address or
any `ActiveVault` mimir doesn't flag, so a vault rotation no longer refuses; a node more than 50 blocks behind the
quoting one, or slower than 2.5 s, is skipped. Every node, the quoting one included, must answer
`/thorchain/lastblock`, and the pass-through must forward it (plus `vaults/asgard` and `mimir`) — cp0x-api allowed only
`inbound_addresses` on 2026-11-13; until its update ships, the first 404 stops the THORNode slot for the page and the
confirmation moves to the next node, direct (providers.md §4.3).

**D15 — Ports and demo mode.** Effectful module APIs are **ports** (`src/contracts/ports.ts`): `catalog`,
`wallets`, `swap`, `execute`, `activity`. Screens reach them only through `usePorts()`; pure helpers are imported
directly. `App.tsx` provides `realPorts` (each module's `xxxPort`) or `demoPorts` (`src/mocks`). Demo mode =
`?demo=1` in the hash query (or page query, or `demo: true` in config), decided at boot: fixtures, streaming fake
quotes, timer-driven executions, no wallet, no network, no storage writes. `demoWallets=none|evm|solana|both`
picks the fake connections (default `evm`). A `#/demo/<scene>` path also means demo (unless `demo=0`); scenes
(`review`, `executing`, `error`, `deposit`, `deposit-expired`, `refused`, `activity`, `status`, `claim`, `connect`,
`tokens`, `settings`, `routes`, `preview`) open the screen in that state, for design review and e2e (`refused`: 0.008 ETH
Arbitrum → Ethereum, with an amount refusal, a safety skip and the "Not for this pair" group, D28; `preview`: 250 USDC
Arbitrum → Base with no wallet — `demoWallets` defaults to `none` on that path — preview rows, the connect CTA and
the per-tab preview budget, D7/D29). Demo data can never receive
funds (the demo deposit address is invalid). The header shows a DEMO tag in demo mode. Hooks in a port are ordinary
hooks (call them unconditionally). The recipient's "this is a contract" warning goes through
`catalog.useIsContract` (demo: a fixture token's own contract reads as a contract, offline).

**D16 — Browser storage.**
- `cp0x-swap` — raw IndexedDB (swap, providers.md §5.2): store `kv` with Relay `rc:<orderId>` (until the order
  deadline) and Omniston `oq:`/`os:` (6 h); writes with `durability: "strict"`; atomic `claim`. Fail-closed:
  without storage, Relay refuses to sign ("Enable site storage to use Relay") and Omniston is not built. A TON escrow
  is signed only once the gate read its `os:` row back and found its hash is the escrow's hashlock (D35 part B).
- `cp0x-activity` — idb-keyval `createStore("cp0x-activity", "kv")`, key `cp0x-swaps-v1`, value = the JSON string
  (`parseStored` stays the one parser); `BroadcastChannel("cp0x-swaps")` syncs tabs; the executing tab bumps
  `heartbeatAt` every 5 s and another tab marks a `submitting` record interrupted only after 30 s of silence —
  `not-sent` before the swap's own prompt (approving, re-quoting, preflight), but `pending` + `maybeSent` from
  `signing` on, because the web wallet (an extension, a WalletConnect phone) may broadcast after the tab is gone; the
  runner stores the hash the engine names at `broadcast` at once;
  `beforeunload` prompts while this tab has a `submitting` record. A record carries `counted` once it has read as sent
  (D36), set in the writing tab's own op, so the swap counter fires once per swap across reloads and tabs.
- `localStorage` only for per-viewer conveniences (`cp0x.prices.v1`, wagmi's reconnect store, the remembered
  Solana wallet `cp0x.solanaWallet.v1`, Tron wallet `cp0x.tronWallet.v1`, NEAR wallet `cp0x.nearWallet.v1`, the
  remembered TON wallet `cp0x.tonWallet.v1` and TON Connect's session `cp0x.tonconnect.*` (D11), the Settings sheet's
  overrides `cp0x.swap.settings.v1`, the connection mode and Custom endpoints `cp0x.swap.connection.v1`, Custom's venue
  keys `cp0x.swap.keys.v1`, D30; the tokens imported by address `cp0x.swap.tokens.v1`, D39 — memory only on an IPFS path
  gateway); every access in try/catch. One exception, not ours: once its modal was used, TON
  Connect UI keeps `ton-connect-ui_wallet-info`, `ton-connect-ui_preferred-wallet` and
  `ton-connect-ui_last-selected-wallet-info` (the wallet picked there, for its "Recent" mark), unprefixed and without a
  guard; it falls back to memory when `localStorage` can't be read, the runtime builds it inside a try/catch (a
  failure is an answered error), and a TON disconnect removes the three keys (D11).
- `sessionStorage`: nothing of ours. TON Connect UI writes `ton-connect-session_storage_launchParams` once, when its
  chunk loads (the first "TON Connect" pick): its Telegram Mini App detection copies the page's hash query (the
  swap's `pay`, `receive`, `amount`…) there, and merges it back on a later load in that tab. This app is never a Mini
  App and nothing reads it after that load, so the runtime removes it (guarded) right after the import, the only time
  it is written (`TONCONNECT_UI_SESSION_KEY`, D11).

**D17 — What of mobile `providers.ts` survives.** Keep `PROVIDER_NAMES`, `providerName`, `TWO_PHASE` (`cctp`) and
`orderSpender`, extended for Chainflip EVM sources (`CF_VAULTS`: its dry quote names no spender) and Omniston (an
inline copy of `AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS`, asserted equal in a test that imports the package — the main
bundle must not). Drop `PROVIDERS`, `SAME_CHAIN`, the capability tables, `providersFor` and `providerServesRoute`:
the real providers' `supportsRoute`/`supportsSameChain` decide. `RouteSnapshot.asked` uses exactly the router's
eligibility predicate over `appProviders()`.

**D18 — Solana.** Signing = the SDK's `WalletAccountSolana` with `externalSigner()` bridging to Wallet Standard
`solana:signTransaction` (engine.md §6.2): the SDK runs the serialized-tx guard, simulation, the 0.05 SOL fee cap
and the broadcast; the wallet only signs, and a signature over altered bytes fails verification; signatures only
inside an open signing window. v1 supports only wallets with `solana:signTransaction` (no weaker
`signAndSendTransaction` fallback). RPCs = `config.solanaRpc` (publicnode, then solanavibestation);
`api.mainnet-beta.solana.com` is excluded — engine.md's OPTIONS probe passed but catalog.md's real requests got 403
for every browser origin. Balances: the owner's ATAs via `getMultipleAccounts` (≤ 10 per call), never
`getTokenAccountsByOwner` (blocked on publicnode).

**D19 — Re-quote.** swap2-core 0.14.0 (as since 0.10.3) re-reviews a changed plan itself (`requoted: true`): no build observer, no
`requotePlan`; on a re-arm with no approvals keep the previous revokes. The review re-quotes the picked venue every
30 s (react-query, retry 1, staleTime 0, gcTime 0); a venue that no longer routes it sets `gone` and blocks Confirm.

**D20 — Deposit-address (QR) routes.** For payers whose family has no connector (BTC, ZEC), and for Tron, TON and
NEAR while no wallet of theirs is connected (`QR_FALLBACK_FAMILIES`: the fallback when there is none or its
connection fails; `payModeOf` reads "deposit", not "connect", and the refund box offers "Connect
{Tron|TON|NEAR} wallet"). With TronLink connected the same Tron routes are paid from the wallet (D10, D11): NEAR
Intents' deposit address, and Chainflip's Tron Vault with its note, which the QR never could carry. A connected TON
wallet pays any deposit route itself, a memo included (as the message comment); a NEAR wallet pays NEAR Intents'
deposit address, without a memo.
Only routes with `execution === "deposit" && !hasMemo` are offered (in practice NEAR Intents);
the others show as refused, in the "Needs a change on your side" section (D28), with "Needs a wallet that signs on
{Chain}" / "Needs a memo — not for QR payments". `issueDeposit`: `appRouter().only(p).getQuotes({...quoteParams(req), dry: false,
minAmountOut: floor}, {requireImmediateExecution: true})`; refuse unless there is no `txRequest`, the deposit
address is valid on the source chain, there is no memo and `minDestAmount ≥ floor`; save a `mode: "deposit"` record
(id = `encodeSwapId(provider, intentId)`) before showing the QR. QR = `uqr` (already a dependency; replaces
ui-port's `qrcode@1.5.4`); payload = the address (BIP-21 `bitcoin:` / `zcash:` URI with the amount); never for an
expired or memo quote. The refund address is the critical field: validated per family.

**D21 — Venue trust badge.** `VENUE_TRUST` (ui-port §5.6): contracts → "ON-CHAIN" (uniswap, curve, wrap, balancer,
usdt0, cctp), own-node → "NODE" (thorchain), provider-api → "API" (the rest, fynd, zeroex and across included).

**D22 — Hash routing.** One screen: `#/?pay=<tokenKey>&receive=<tokenKey>&amount=<decimal>&swap=<id>&demo=1`.
`src/config/hash.ts`: `parseHash`, `formatHash`, `setHashQuery` (replaceState by default), `useHashRoute`. Form
state may mirror into the hash ("Try again", shareable pairs); addresses never go into the URL. A token key naming a
token the list doesn't have (an unlisted EVM contract or Solana mint) is never trusted on the link's word: that side
opens empty with the import confirmation up (D39).

**D23 — CSS and layout.** Plain CSS Modules (`*.module.css`) over the variables in `src/theme/tokens.css`; global
CSS only in `src/theme/` (loaded by `src/ui/index.ts`). No Tailwind, no CSS-in-JS library; inline `style` only for
computed values. Dark only, no borders (fill + shadow), mobile numbers from ui-port §1-2. Version B breakpoints:
`@media (max-width: 639px)` phone (one column, best route + "N more" → bottom sheet, sticky CTA),
`(min-width: 640px) and (max-width: 1023px)` tablet (one column ≤ 560 px, full list under the form),
`(min-width: 1024px)` desktop (400 px form centred, routes to its right). JS reads the same classes with `ui.useBreakpoint()`. Sheets:
Radix Dialog for ≥ 640 (dialog / right drawer), vaul for < 640 (bottom sheet) — both already installed. The token
list virtualizes with `@tanstack/react-virtual` (added). Tooltips (`ui/Tooltip`: hover on `(hover: hover)` devices
after 0.2 s, focus within at once) draw their tip on `<body>`, `position: fixed` from the trigger's rect, so no
clipping container cuts it (owner, 2026-11-13: the "Preview" tag's tip at a row's left edge was cut by the route
panel): centred, kept 8 px inside the viewport, flipped to the other side without room (`placeTooltip`, unit-tested),
over the sheets (`--z-tooltip` 60, between `--z-sheet` and `--z-toast`); a scroll or resize drops a hover tip and moves
a focus one. The description stays in place (a hidden `role="tooltip"` copy for `aria-describedby`); the drawn tip is
`aria-hidden`.

**D24 — Permissionless and private (rewritten 2026-11-12 for D30).** No trackers, error reporters or remote fonts;
no analytics outside the hosted build's page-view count (D31) and Standard's anonymous swap count (D36); no
geo-blocking or screening; zero fee options everywhere.
- **Which builds can contact cp0x.** Only a build made with `VITE_CP0X_API` (the hosted one) holds a cp0x host, and
  exactly that one origin; it is contacted only in the Standard mode (D30). A build without the variable — IPFS,
  `npx`, Docker, a plain `pnpm build` — holds no cp0x host and never contacts one, whatever a viewer saves. In a
  build with it, Public and Custom never contact cp0x either: not even the health check.
  One file names a cp0x host without the page contacting it: `tonconnect-manifest.json` (D11) names the hosted page,
  so a TON wallet connected from a copy that kept it shows that page and fetches its icon from it — a copy on
  another origin serves its own (README).
- **What Standard is.** Transport only: the browser sends quote requests and RPC calls through cp0x's swap-web proxy,
  which adds cp0x's keys and forwards them; the answers come back to the same SDK code, which verifies every quote,
  recipient, calldata and transaction in the browser exactly as in the other modes. The proxy never sees a wallet key
  and signs nothing; the wallet signs only after the in-page gate (D10). cp0x does see, in Standard, the quote
  requests and RPC calls it carries (amounts, addresses, the viewer's IP) — Settings says so — and, once per swap
  sent, which venue and networks it used, nothing more (D36).
- **Third parties.** Public/Custom: exactly the venues, RPCs (Custom: the viewer's own first), price APIs, (only
  while a Tron wallet is connected) the runtime `tronApi` hosts — publicnode, then TronGrid — for its balances and its
  payments' reference block, broadcast and receipt, TonAPI once a TON wallet is connected (balances, the jetton wallet
  lookup) and (only when chosen) WalletConnect's relay or, once the viewer picks TON Connect, the TON Connect bridges
  of the self-hosted official list (its modal's universal QR listens on all of them until it closes, an accepted cost,
  owner 2026-11-13) and the picked wallet's — never TON's remote wallets list, its icons or its analytics (D11). Standard: the same plus Fynd, 0x and Across, except that the keyed venues (Fynd, 0x and Across only ever),
  the listed RPC networks and THORChain's vault check go to cp0x's proxy instead (D30), and Across's keyless relayer-fee
  quote (`app.across.to/api/suggested-fees`, no key) is asked directly whenever Across is (D38). The NEAR RPC is asked only
  once a NEAR wallet is connected, and always directly (the proxy has no NEAR route, and Custom no NEAR row: an
  operator's `nearRpc` is the only lever); finding NEAR wallets is a DOM event to the installed extensions, no
  request (D11).
- Strict CSP (`bin/headers.mjs`, the one definition for Vercel, nginx, `npx` and the IPFS `<meta>` copy):
  `script-src 'self'`, no inline or third-party scripts, `frame-ancestors 'none'`. `connect-src` is
  `'self' https: wss:` rather than a host list, because operators and viewers may point RPCs and API bases at any
  https host (D8); the privacy promise is kept by the code and checked by `.github/scripts/guard-dist.mjs` (no
  tracker anywhere but D31's one script path, and that only with `--api`; no cp0x host in a build without `VITE_CP0X_API`; exactly its origin and nothing else cp0x in a
  build with it — CI checks both, and the Vercel build runs it on the very build it deploys) and the e2e (no cp0x
  request from the default build; the Standard build's requests go to its fake API origin only). A secure context is
  required (NEAR, Chainflip and `@solana/kit` need `crypto.randomUUID` / `crypto.subtle`).

**D25 — Errors.** Map by `instanceof` first, then message (mobile `swapErrorText` order: mismatch → fee cap → not
confirmed → **rejected in wallet** → maybe-sent → no gas → in flight → floor → no route → expired → raw). Every
error our adapters know did not broadcast gets `answered: true`; wallet rejections read "You declined in your
wallet — nothing was sent."; maybe-sent swaps are tracked and never retried. One without the engine's id (a `local.`
id: a lost wallet answer, a tab closed mid-signing) can't be polled: it says so ("Check your wallet"), and only the
viewer settles it (`activity.markNotSent`, "Mark as not sent"). Web texts replace "Face ID" / "the app"
per ui-port §4.12. Venue refusals (transport failures and "quote timed out after 8000ms" included) read through
the categorised table of D28.

**D26 — Dependencies and bundling.** All exact-pinned. Added for TON (2026-11-12): `@tonconnect/sdk 3.4.1` (Feb 2026,
TON Connect's original maintainers; brings `@tonconnect/protocol`, tweetnacl-util and two Node shims that are empty in
a browser build) and `@ton/core 0.63.1` (already in the lockfile through Omniston); both load only in lazy chunks.
Added 2026-11-13 (D11, the owner's official TON Connect): `@tonconnect/ui 2.4.4` (Mar 2026, Apache-2.0; Solid,
goober and its QR code compiled in; brings classnames, deepmerge and ua-parser-js 1.0.41, MIT — ua-parser-js 2.x is
AGPL; no install scripts), the last release that pins `@tonconnect/sdk` to exactly 3.4.1, so the lockfile and the
bundle hold one SDK (5.x pins sdk 5, a major bump of the error texts and signatures the TON account reads). It is a
lazy chunk of its own (~275 kB, ~85 kB gzip), importing the SDK's, loaded only by the "TON Connect" pick.
Added in this phase: `@anywalletkit/wallet-evm 0.8.0`,
`@anywalletkit/wallet-solana 0.6.1` (0.6.2 since 2026-11-13), `@wallet-standard/base 1.1.1`, `@wallet-standard/features 1.1.1`,
`@solana/wallet-standard-features 1.5.0`, `@tanstack/react-virtual 3.14.22`; dev: `@testing-library/react 16.3.3`,
`@testing-library/dom 10.4.2`, `@testing-library/user-event 14.6.7`, `fake-indexeddb 6.2.6`. Vite
`resolve.dedupe` keeps one viem / AWK core / swap2-core / swap2-assets / `@solana/kit` (WalletConnect brings a
second viem peer set). `src/polyfills.ts` (global `Buffer`) stays first in `main.tsx`; the Omniston chunk also
imports its own polyfill so it does not depend on load order. Never import `@anywalletkit/protocol-swap2-core/server`
or `/remote`. Builders cannot add dependencies: ask the orchestrator. NEAR signing (D11) added none: the injection
protocol and the NEAR JSON-RPC reads are a few lines of our own.

**D27 — Testing.** Vitest (jsdom) under `tests/unit/<module>/`, run per module with
`pnpm exec vitest run tests/unit/<module>`. No network in unit tests; live checks are opt-in (`LIVE=1`) and sparing
(Symbiosis ~1 req/s, Jupiter 0.5 req/s). Components test with `@testing-library/react` inside
`<PortsProvider ports={demoPorts}>`; IndexedDB with `fake-indexeddb`. e2e (integrator): Playwright against
`pnpm build` + `vite preview` on `127.0.0.1:4317`, served with the shipped header set (`preview.headers` =
`bin/headers.mjs` `securityHeaders()`, so every e2e runs under the CSP; the watcher turns a
`securitypolicyviolation` into an error; `tests/e2e/ipfs.spec.ts` adds the `/ipfs/<cid>/` sub-path with the meta CSP)
(`E2E_PORT` moves it; an already-running server is reused only with
`E2E_REUSE=1`, so a stale preview is never tested by mistake), projects 375×812, 768×1024, 1280×800. A second build
made with `VITE_CP0X_API=https://cp0x-api.e2e.test` (a host that never resolves) serves on `E2E_PORT + 1` for the
`standard` project (1280×800, `tests/e2e/standard.spec.ts`), which answers that origin like cp0x's proxy (D30).
`tests/e2e/demo.spec.ts`: swap screen with routes (+ the phone's "N more" sheet), token sheet, review sheet, deposit
panel, activity drawer, the preview scene (preview rows, the connect CTA, Enter never opens the review, refresh waits
after the burst); each test fails on a page error, a console error, horizontal scroll, any request off the
page's origin (demo is offline) and any cp0x host. `tests/e2e/real.spec.ts`: the real ports boot with the price APIs
stubbed and everything else aborted; with previews off (a stubbed `runtime-config.json`) no wallet means "Connect a
wallet to see routes" and nothing but prices is requested; with previews on (the default) nothing is asked before an
amount, an amount asks the venues — never LI.FI, never a cp0x host — and the CTA still asks for a wallet.
`tests/e2e/standard.spec.ts`: health is read once; the keyed venue and the listed RPC network go through the proxy,
the anonymous venue and unlisted networks never reach it; THORChain's quote comes from Liquify directly while its
vault is confirmed through the proxy's THORNode (the route then shows); a failing health check leaves the page Public
and Settings says "cp0x API unreachable"; a proxy 429 "daily budget spent" sends that venue direct; Symbiosis' limits,
quote and status calls go through the proxy while keyed, and a failure there sends it direct once; LI.FI's preview
(D7) goes through the proxy while keyed (the EVM sample as sender and recipient, never li.quest), sits in "Quoted
after you connect" sending nothing anywhere while anonymous, and after the proxy's 502 makes its one direct call,
then later previews leave it for the live quote and send nothing; a same-network preview asks Fynd's SDK through the
proxy at the hosted API's path (the EVM sample as sender and receiver, the sample never shown), a call shaped like
its SDK's goes the same way while keyed and sends nothing anywhere while anonymous; Public chosen in Settings never
contacts cp0x.
`tests/e2e/tron.spec.ts` (desktop): a fake TronLink injected into the real build (its `trx.sign` hands the txID to the
test process, which signs with a key made for the run); 1Click and the Tron API stubbed: no wallet keeps the QR and
never asks the Tron API; connected from the refund box, the reviewed USDT deposit is signed once and the page
broadcasts exactly that transfer.
Screenshots: `docs/screens/<width>-<state>.png` (swap, refused, preview, tokens, review, deposit, activity;
routes-sheet at 375).

**D28 — Refusals people can understand, and coverage (2026-11-12).** The route list's "Didn't quote" rows showed
the SDK's log text (LI.FI "The transaction does not match the quote: pays 0x6f84…, not…", THORChain "Refusing quote
on node with stale state: invalid request"), cut after two lines, and venues that don't serve a pair were invisible.
- `src/swap/refusals.ts` is the ONE ordered table (first match wins) from a venue's refusal text to a
  `RouteRejection`: `reason` = a short line (≤ 45 chars; never an address, hex, base units or an HTTP code; the
  review's "gone" text keeps using it), `category` (`safety | amount | setup | unavailable | unreachable | busy |
  pair | deferred | other`; `deferred`, 2026-11-13, is no refusal: a preview left the venue for the live quote, D7),
  `detail` = one plain sentence, `raw` = the text after the venue prefix with URLs → `<url>`,
  whitespace collapsed, ≤ 400 chars. Minimums in base units round UP to 4 significant digits (typing the number
  passes), maximums DOWN; Symbiosis' "received amount … below Symbiosis' minimum" (receive-token units) shows no
  number. Unknown texts: past the venue's status prefix ("quote 404: ", "build 400: ", "1Click 400: ", "threw: "),
  a short plain phrase (≤ 40 chars; no number of 3+ digits, bracket, address, CODE_NAME or bare HTTP reason phrase
  like "Forbidden") shows as is, anything else "No quote right now" — unless its venue classified it (2026-11-15:
  swap2-core 0.12.0's `Swap2RefusalReason`, which every module now gives next to an unchanged text and router 0.6.0
  keeps as `RouteSet.refusals`): then the line its reason names (`BY_REASON`: `insufficient_liquidity` "Too large for
  its pools — try less", `vault_mismatch` "Uses a contract we haven't verified", …). The text stays first: a reason
  never overrides a rule. The engine's observer, `coolDownOnRateLimit` and `payoutToSigner` pass the reason on with
  the text (`onRefusal(text, info)`), and `parseRejections` takes the router's refusals. The venues' own build checks (Chainflip's vault
  call, THORChain's router call, Symbiosis' transaction, USDT0's LZ fee) read as safety skips.
  `friendlyReason`/`parseRejections` (routes.ts) keep their exports and delegate. Wording only: no SDK check is
  weakened, and a safety refusal stays a refusal. The rate limit says how long ("Request limit hit — back in about
  2 hours"), never "a minute"; THORChain's fee cap no longer says "try a larger one" (the fee share is U-shaped).
  ONE predicate, `RATE_LIMITED` (refusals.ts), is "busy" for the list and the trigger of LI.FI's cooldown: the
  venue's words or a 429 the SDK names as a status ("HTTP 429", "quote 429", "Symbiosis API → 429"), never any 429 ("at least 0.429 ETH",
  "min=429"). A whole round's failure ("Couldn't quote: …", useRoutes) has no "Technical reason": a text no rule
  knows shows itself, URLs out, ≤ 120 chars.
- The list shows the refused venues in sections, in this order, empty ones hidden: "Needs a different amount"
  (amount), "Needs a change on your side" (setup, incl. the QR refusals of D20), "Not available right now"
  (unavailable, unreachable, busy, other), "Doesn't support this pair" (pair), "Skipped for your safety" (safety,
  a green lock, never red). A `deferred` row is in none of them, and not counted in "Didn't quote (N)": it sits in
  its own quiet group, "Quoted after you connect (N)" (D7). Each row is a native `<details>`: logo, name, the full
  short line; open, the sentence
  and a nested "Technical reason" with the selectable raw text and a copy button outside every `<summary>`.
  Rows are keyed by venue and the list holds which are open (and their "Technical reason"), so the 30 s refresh,
  which can remount a row, never closes one. Re-quoting a list where nothing quoted leaves the sections in place
  until the new answers land: no skeleton, and a venue already listed isn't repeated as "Quoting…" (a new pair's
  first round still folds its early refusals into "Didn't quote (N)" until it settles).
- `RouteSnapshot.venues` (every enabled venue, ask order) − `asked` = the collapsed "Not for this pair (N)" group,
  each venue with one scope line from `venueScope` (providerMeta.ts): "Same-network swaps only", "USDC between EVM
  networks only", "Into TON from Ethereum or Arbitrum only", … and the generic "Doesn't cover this pair" where the
  answer is in a venue's token list. The status row adds "N of M venues serve this pair"; the phone's route sheet
  (its only full list) shows it under the sheet's header.
- `venuesUnreachable` reads `category === "unreachable"`, not exact strings, so rewording can't silently turn off
  "Can't reach the venues". It counts only venues that were sent a request: a refusal the round made itself
  (`RouteRejection.skipped`: the signer-only skip, a venue backing off, D29; a preview's `deferred` venues are not
  among the refusals at all) is left out, so a blocked network still reads "Couldn't reach any venue" on a preview.
- LI.FI (providers.md §4.2): asked EVM → Solana since lifi 0.8.0, which reads the Solana recipient for Mayan,
  Polymer CCTP and Chainflip and refuses every other bridge (the app's `lifiChecksRecipient` narrowing, which skipped
  the pair while 0.7.0 refused every such quote, is gone), and `coolDownOnRateLimit`: after
  a refusal `RATE_LIMITED` reads ("Rate limit exceeded, retry in N unit", "Too many requests", "HTTP 429") it sends
  nothing until the named wait is over ("retry in|after N unit": `RETRY_WAIT`, the pattern the list's busy line reads) (else 15 min, at most 3 h) and refuses with "lifi: rate limit exceeded,
  retry in ~N min". It never caches or returns a quote. The keyless quota measured 2026-11-12 is about 75 `/quote`
  per 2 h per IP, against a 30 s auto-refresh.
- Contract changes: `RefusalCategory`; `RouteRejection` + `category`, `detail?`, `raw`; `RouteSnapshot.venues`;
  `SwapModule` + `classifyRefusal`, `venueScope`. Demo refusals are written in the classifier's words
  (`DEMO_REFUSALS`, kept equal by `tests/unit/swap/refusals.test.ts`).

**D29 — Preview pacing and venue back-off (2026-11-12).** Previews (D7) ask the venues before anyone connects, so
they are paced harder than live quotes.
- **Advisory, and what it protects.** There is no backend: every visitor asks the venues from their own IP, and anyone
  can call them directly or edit this JavaScript, so a client-side limiter cannot stop abuse. It protects the visitor's
  own per-IP budgets (LI.FI keyless ~75 `/quote` per 2 h, Jupiter 0.5 req/s, Symbiosis 1 req/s, 1Click, the public
  RPCs), THORChain's shared `cp0x-swap` client id, and the live quote after connect, which should not start
  rate-limited. Routing previews through a keyless cp0x proxy to "protect" the venues would make it worse: every visitor
  would share one server IP's limits (LI.FI's 75 would last minutes). That is why Standard (D30) sends a venue
  through cp0x's proxy only while cp0x holds a key for it (health "keyed"); the proxy's own per-IP windows and daily
  budgets then apply, and the per-call fallback goes direct when they are spent. LI.FI's and Fynd's previews go only
  that way (D7, 2026-11-13): a spent budget or a failure there sends later previews back to waiting for the live
  quote, never to the visitor's own keyless quota (one retry in the page's life aside).
- **Preview rounds** (`useRoutes`): an 800 ms debounce (`PREVIEW_DEBOUNCE_MS`); no timed refresh — one re-ask when the
  tab comes back after more than 2 min (`PREVIEW_STALE_MS`); each round, a manual refresh too, spends one token of a
  per-tab bucket (`createTokenBucket`, `src/config/pacing.ts`: `preview.roundsBurst` 5 at once, one more every
  `preview.roundRefillMs` 20 s; parse bounds 1–20 and 5–600 s). Without a token the round waits for the next one and
  `RoutesState.limitedUntil` says until when: the refresh button is disabled with a seconds countdown, and an amount
  waiting for its first preview reads "Preview paused for N s — too many price checks." An amount typed away and
  back before the debounce ends shows the preview it had (its round finished): no new round, no token; a round cut
  off mid-flight, or a refresh still waiting for a token, starts again. LI.FI and Fynd are asked in a preview only
  through cp0x's proxy with cp0x's key, decided per round (D7): never against LI.FI's keyless per-IP quota, and never
  keyless beyond the one retry after a failure at the proxy, once per page. The demo port spends the same bucket, so
  the e2e sees the limiter.
- **Live rounds** keep the 400 ms debounce and the 30 s refresh while visible, and never touch the bucket.
- **Venue back-off** (`src/swap/limiter.ts`, the engine's rounds in both modes): a venue whose answer reads as a rate
  limit (`RATE_LIMITED`, D28) is not asked again until the wait it named is over ("retry in 2 hours", "retry after
  …": `RETRY_WAIT`, the one pattern the list's "back in about …" reads too; believed up to 3 h), else 60 s doubling
  per repeat up to 15 min; a quote from it clears the back-off. Meanwhile it is refused at
  once ("{venue}: rate limit exceeded, retry in ~N min" → "Request limit hit — back in about N minutes") and nothing
  is sent, so our own retries never extend a lockout. LI.FI keeps its provider-level `coolDownOnRateLimit` (D28); the
  review's re-quote (`requoteRoute`) doesn't go through the back-off.
- Contract changes: `RouteMode`, `RouteSnapshot.mode`, `PreviewRequest`, `RoutesRequest`, `RoutesState.limitedUntil`,
  `RouteRejection.skipped` (the round's own refusals: nothing was sent);
  `SwapPort.useRoutes(r: RoutesRequest | null, prices)`; `SwapModule.quoteRoutes(r: RoutesRequest, …)` +
  `canPreview`; `RuntimeConfig.preview`; config exports `createTokenBucket`.

**D30 — Three connection modes: Standard, Public, Custom (owner, 2026-11-12).** "Default mode goes through our API
with our RPCs and keys (like the cp0x wallet); PRO mode where you can set your own RPCs and keys." Chosen in Settings
→ Connection, saved per browser (`cp0x.swap.connection.v1`, `src/config/connection.ts`), applied on the next load
(D9); ignored on an IPFS path gateway like every saved setting (D8). Demo mode contacts nothing in any mode.
- **The build switch.** `VITE_CP0X_API` (an origin, `https:`; plain `http:` only for localhost / 127.0.0.1 — checked
  in `vite.config.ts`, a bad value fails the build) is passed per deploy: `vercel deploy --build-env
  VITE_CP0X_API=https://cp0x-api.vercel.app` (no Vercel project env). Set: Standard exists and is the default. Unset:
  Standard does not exist (Settings offers Public and Custom), the bundle holds no cp0x host, and the app behaves as
  before (D24).
- **Standard** (hosted build only). The proxy (cp0x-api `apps/api/docs/swap-web-proxy.md`) lives at
  `<API>/api/v2/swap-web`: venue bases `/venue/{lifi|relay|near_intents|jupiter|symbiosis|fynd|zeroex|across}`, RPC
  `/rpc/<chainId|solana>`, the THORNode confirm pass-through `/venue/thornode` (thorchain 0.4.0 reads `thorchain/
  {lastblock,inbound_addresses,vaults/asgard,mimir}` through it, D14), and `GET /health` → `{venues: {…:
  "keyed"|"anonymous"}, rpc: {configured, chains}, thornode}`. Providers, RPC clients and chain lists are built once
  per page (D9) while the health answer arrives later, so the page is built with every proxy SLOT in place
  (`standardSlots`): the five venue
  bases point at the proxy (not a venue the viewer's saved settings pointed elsewhere, not one the page doesn't
  build, not LI.FI against a plain-http API, whose SDK refuses http); every non-empty EVM list and the Solana list
  start with the proxy RPC, the public URLs after it (NEAR's never does: the proxy has no NEAR route); THORChain's
  confirm list starts with the proxy THORNode while `thorNodes`, the quote nodes, stay direct and unchanged (Liquify
  first). Fynd's slot (`plan.venues.fynd = null`: no public base) exists whenever the page builds Fynd; 0x's and
  Across's the same way (D38).
  `src/config/standard.ts` then decides per request, from the health answer, which slots carry traffic:
  - health: one `GET /health` at boot, in the background, 3 s timeout (`HEALTH_TIMEOUT_MS`). A request bound for the
    proxy waits for it, never longer; a failed or late answer leaves the page Public for its lifetime and Settings
    says "cp0x API unreachable — using public endpoints.";
  - a venue goes through the proxy only while "keyed" (an anonymous venue there would share one server IP's quota,
    D29); an RPC network only when health lists it (and RPC is configured); THORNode only while `thornode` is true;
  - an unused venue slot is sent to that venue's public base with the same path, query and body; an unused RPC or
    THORNode slot fails at once, WITHOUT a request (`TypeError`), so the client moves to its next URL;
  - Fynd (proxy only, `PROXY_ONLY`): its SDK is given the proxy as a keyless server per chain (`selfHosted:
    {<id>: <base>/venue/fynd/<slug>}`) and posts `…/<slug>/v1/quote`; the wrapper sends that to the proxy as the hosted
    API's path under its `/v1` base, `…/venue/fynd/<slug>/quote` (`proxyVenueUrl`; the contract with cp0x-api). An
    unused Fynd slot fails WITHOUT a request like an RPC slot; a failure at the proxy, or an upstream 401/403/429,
    stops it for the durations below and the answer goes back to the SDK unretried — never direct. Its `supportsRoute`
    reads the same slot (`standardFynd`, `whileLive`; `enabled()` stays the SDK's, which the engine re-reads after an
    approval is mined), so Fynd is not asked at all while it doesn't carry traffic, before the health answer included.
    Previews ask it through the same slot while it carries traffic (D7, 2026-11-13).
  - Symbiosis (2026-11-12): a venue like LI.FI (public base `api.symbiosis.finance/crosschain`, direct fallback),
    except that the proxy forwards only the calls its SDK makes, each matched exactly with no query (`PROXIED_PATHS`,
    the proxy's own routes): `GET /v1/swap-limits`, `POST /v2/quote`, and the status calls after a swap
    (`GET /v2/tx/<chainId>/<hash>`, `GET /v1/stucked/<EVM address>`). Any other shape goes straight to Symbiosis from
    the slot, without waiting for health and stopping nothing (the proxy's 404 or 400 would otherwise take Symbiosis
    off cp0x for the page). Keyless, Symbiosis allows 1 request/s per IP; cp0x's partner key (`X-Api-Key`, added by
    the proxy) has its own 10 req/s, shared by every Standard viewer. Its one pacer per page
    (`pacing.symbiosisGapMs`, 1.1 s) stays in every mode, around the routing: through the proxy it keeps one page
    from taking a tenth of that shared budget. That pacer spaces only starts, and a call that fails at the proxy is
    retried direct as soon as the failure lands, so the routing sends every direct Symbiosis call (the retry, a
    stopped or unused slot, an unforwarded shape) through a second pacer with the same gap (`ProxyFetchDeps.direct`,
    built in `startConnection`): the direct path stays at 1 request/s per page, also right after a slow failure.
- **Per-call fallback.** A venue call that fails at the proxy itself — a network error (a CORS refusal looks the
  same), or `x-swap-web-answer: proxy` with 400/403/404/405/413/414/429/5xx (a missing header counts as the proxy's)
  — is sent once more straight to the venue (same path, query, body), and that venue stays direct. So is a call the
  upstream answered 401, 403 or 429: health says "keyed" as soon as a key is SET, not that it works, and those
  statuses refuse cp0x's key (revoked, mistyped, every Standard user over the venue's per-key limit) or cp0x's server
  IP, not this user's request; without this a dead key would leave every Standard user without that venue while
  Public worked. How long a slot stays direct: until 00:00 UTC after the proxy's 429 "daily budget spent" / "ip
  daily limit"; after any other 429 (the proxy's per-minute "rate limited", an upstream's) for its `Retry-After`
  (60 s without one — the proxy strips upstream headers — at most 5 min, `BACKOFF_MS`), so a burst or a shared
  carrier-grade-NAT IP doesn't leave a long-lived tab direct for hours; else for the page. Every other upstream
  answer passes through untouched and is never retried; a request its caller aborted is not the proxy's failure.
  A preview's call to LI.FI (D7: its signal marked `keyedOnly`) takes the one retry too, but only once per slot and
  page, and from an unused or stopped slot it fails at once WITHOUT a request instead of going direct: a stop for a
  Retry-After runs out within minutes, and a preview's next failure at the proxy then fails without a keyless call
  (not with the proxy's answer either, whose 429 would read as LI.FI's own and cool it off the live quote). So
  previews add at most one keyless call per page to this fallback; live rounds' calls are unchanged.
  RPC and THORNode clients fall back on their own; a failure there (a network error, any of the proxy's own failures
  except 400 and 413, which refuse one call, or an upstream 401/403/429) only stops the slot being used, the same
  way. Settings' status is read afresh on every look and announced when a timed stop runs out. How: LI.FI, NEAR
  Intents and Jupiter take only a base URL (no `fetchImpl`), and so do THORChain's node lists and the RPC clients, so
  a fetch wrapper is installed once at boot in Standard mode only (`startConnection`, before the app loads). It
  matches requests by the exact proxy prefix (`<base>/venue/<name>` followed by "/", "?" or the end;
  `<base>/rpc/<chain>`) and hands every other request to the original fetch with the same arguments. Relay and
  Symbiosis (behind its pacer) take a `fetchImpl` and get the same routing directly. `x-cp0x-swap-web: <version>` goes only on proxy-bound requests that are preflighted anyway (a
  JSON POST, THORNode's `x-client-id`), never on a simple GET (Chrome keys its preflight cache by URL, so every LI.FI
  `/quote` would pay one), never on the direct retry; `x-cp0x-app` is never sent.
- **RPC fallback, every client.** Each moves to its next URL on a non-2xx or a network error: viem's `fallback`
  (catalog `readTransport`, wagmi, wallet-evm's provider list, USDT0), wallet-solana's provider list (it tries every
  provider on any error), the raw loops of Uniswap, Wrap, Balancer, Jupiter (its loop moves on when the body has an
  `error`, which every proxy answer has) and Omniston's validators, and `catalog/balances/solana.ts`. CCTP takes ONE
  URL per chain, so it gets `rpcFailoverFetch` (`src/swap/rpcFailover.ts`) as its `fetchImpl`: a call that fails on
  that URL goes to the rest of the chain's runtime list (in every mode).
- **Only Standard's slots add cp0x.** No other layer may put a cp0x API URL in the page's config: the boot drops,
  with a console warning, every base, price API, THORChain node and RPC URL on the build's API origin or on a
  `/api/v2/swap-web` path (`withoutCp0xApi`) — from VITE_SWAP_CONFIG and runtime-config.json (falling back to the
  built-in value) and from the viewer's saved settings and Custom RPCs (falling back to the operator's). Such a URL
  would contact cp0x in Public and Custom too, skip the health check and the fallback, and (as a venue's "public"
  base) send an anonymous venue's direct fallback back through cp0x's shared IP. Settings refuses one on Save, and a
  Custom RPC row on Add. The dist guard holds the bundle to the same rule: with `--api` (or the deploy's
  VITE_CP0X_API) the origin may appear exactly once, as the bare string literal the define emits; `<origin>/…` or a
  second copy fails the build.
- **Wallets never get a proxy URL.** `toViemChain` (the chain definition wagmi's `switchChain` hands
  `wallet_addEthereumChain`) and wagmi's transports (WalletConnect's rpcMap) leave out every cp0x API URL
  (`isProxyUrl`: the build's API origin or a swap-web path, in EVERY mode, not only under Standard's plan): a wallet
  extension calling the proxy has no allowed Origin, gets 403 and would be left with a broken network. The app's own
  clients (`publicClient`, the SDKs, the execute accounts) use the proxy.
- **Public**: the keyless public endpoints, as before D30; never contacts cp0x.
- **Custom ("PRO")**: Public plus the viewer's own EVM RPCs per chain and Solana RPCs (https; plain http only to
  this machine, and only where this page's CSP allows it — the `npx` server; no `user:pass@`, which fetch refuses, so
  every call would fall over to the public RPCs unseen; never a cp0x URL; at most 8 per network), tried FIRST with
  the public ones kept after them as the fallback — or, with "Use only my RPCs" (`CustomEndpoints.only`), alone on
  each network they were given for, so addresses and signed transactions reach no public RPC operator there (NEAR
  has no row: it keeps the operator's `nearRpc`, which "only my RPCs" doesn't cover) — and their own venue keys:
  LI.FI `apiKey` (`x-lifi-api-key`), Relay `apiKey` (`x-api-key`, ≤ 256 visible ASCII — the SDK's rule), NEAR 1Click
  `jwt` (`authorization: Bearer`), Jupiter `apiKey` (`x-api-key`), Symbiosis partner `apiKey` (`X-Api-Key`, ≤ 256
  visible ASCII — the SDK's rule); each venue's CORS allows its header (checked 2026-11-12; Symbiosis' preflight
  answers `access-control-allow-origin: *` and allows `x-api-key`). Keys live only in this browser
  (`cp0x.swap.keys.v1`), go only into their own venue's constructor (never RuntimeConfig, a URL, the hash, a log, an
  Activity record or an error text; a refused key is named by its venue, never echoed), and Settings says plainly that
  anyone with access to this browser profile can read them; "Clear keys" removes them at once and says so on its own
  line, leaving Save for the rest of the draft (also shown in the other modes while keys are STORED — keys typed and
  left unsaved don't count), Reset removes them with everything else; Save writes keys only with Custom picked, and
  leaves the stored ones alone otherwise. Never contacts cp0x. Custom's RPCs count as saved overrides: the swap
  screen and the review name them (D8). An older browser's saved `evmRpc` / `solanaRpc` (which replaced each list)
  read as Custom endpoints with `only` on, so they still replace each list.
- **Settings → Connection** (ui-port §5.11): a native radio group (arrow keys move the choice), the live Standard
  line ("LI.FI and Relay through cp0x with its keys · RPC for N networks through cp0x · THORChain's vault check
  through cp0x", fallbacks named — "… asked directly after a cp0x error", "Fynd paused after a cp0x error"; "cp0x
  holds no key for them yet" only when health keyed no venue at all; or "cp0x API unreachable — using public
  endpoints."), and the privacy copy:
  "Standard sends quote requests and RPC calls through cp0x's server, which adds cp0x's API keys. It never sees your
  wallet keys and signs nothing; every transaction is still checked in this browser. Public and Custom never contact
  cp0x. The NEAR RPC is asked directly in every mode." (A build without the API: "This copy of the app has no
  Standard mode and never contacts cp0x.")
- Contract changes: `ConnectionMode`, `ProxyVenue`, `VenueKeys`, `CustomEndpoints` (+ `only`),
  `ConnectionSettings`, `ConnectionStatus` (+ `keyed`: the venues health keyed, routed here or not)
  (`src/contracts/config.ts`; `RuntimeConfig` still has no key field); config exports the connection store,
  `standardSlots`, `customOverlay`, `isCp0xApiUrl`, `withoutCp0xApi`, `pageConnection`, `venueKeys`, `isProxyUrl`,
  `startConnection`, `standardFetch`, `useConnectionStatus` and the routing pieces (`createProxyFetch`,
  `healthRoutes`, `parseHealth`, `proxyTarget`, `backoffMs`, `BACKOFF_MS`); `setRuntimeConfig(config, saved?,
  page?)`; swap's `buildProviders(config, stores, {keys, fetchImpl})`. The runtime-config parser refuses any URL
  with `user:pass@` (D8). 2026-11-12 (Curve, Fynd): `ProviderName` + `"curve" | "fynd"`, `ProxyVenue` + `"fynd"`,
  `StandardPlan.venues` values `string | null`, `ConnectionStatus.fellBack` also lists a paused proxy-only venue;
  config exports `PROXY_ONLY`, `proxyVenueUrl`, `standardFynd`, `ProxyOnlySlot`, `StandardRuntime.venueLive`; swap's
  `STANDARD_ONLY_PROVIDERS` (in `SwapModule`), `whileLive`, `buildProviders(…, {keys, fetchImpl, fynd})`.
  2026-11-12 (Symbiosis through the proxy): `ProxyVenue` + `"symbiosis"`, `VenueKeys` + `symbiosis`; `fetchImpl`
  also reaches Symbiosis, inside its pacer; `ProxyFetchDeps.direct` and `createStandardRuntime`'s `direct` (a
  venue's own sender for its direct calls); `paced` moved to `config/pacing.ts` (swap re-exports it).
  2026-11-13 (LI.FI and Fynd in previews, D7): `RefusalCategory` + `"deferred"`; config exports `proxyVenueLive`,
  `proxySettled`, `keyedOnly`, `StandardRuntime.settled`; swap's `createQuoteEngine` takes `proxy?: PreviewProxy`,
  `previewSkip(provider, req, viaProxy?)`, preview.ts `KEYED_PREVIEW_VENUES`, `FILLS_OTHER_FAMILY`,
  `KEYED_ONLY_REFUSAL`; screens' `routeListModel(…, missing?)` with `RouteListModel.deferred` / `deferredTitle` and
  `deferredCopy`.

**D31 — Page views on the hosted interface (owner, 2026-11-12).** The owner asked for visit counts on swap.cp0x.com.
The hosted build (made with `VITE_CP0X_API`) adds Vercel Web Analytics; nothing else does.
- **How.** `src/config/analytics.ts` sets up the queue `@vercel/analytics` would and adds Vercel's script from the
  page's own origin (`/_vercel/insights/script.js`; events go to `/_vercel/insights/*`), so CSP stays as it is and
  no package is added. main.tsx imports it only under `import.meta.env.VITE_CP0X_API`: in every other build the
  branch and its chunk are gone, and guard-dist fails such a bundle if the script path shows up anyway. With `--api`
  it allows exactly one bare literal of that path; `/_vercel/speed-insights`, any longer insights path and a second
  copy still fail.
- **What is sent.** One page view per load (the app's `#` routes are not page changes). `beforeSend` cuts the URL to
  origin + path, so no query and no `#` route (where a recipient address can sit) leaves the page. Vercel's script
  sets no cookie; it sees what serving the page already shows it (IP-derived country, browser, OS, referrer).
- **When not.** On a local host (dev, e2e: no 404 noise) and when the browser sends Global Privacy Control or Do Not
  Track. It does not depend on the connection mode: the script and its endpoint are the page's own host, not a cp0x
  API (D30's "Public never contacts cp0x" is about the API).

**D32 — The screen keeps its shape while it re-quotes (owner, 2026-11-13).** "When I change the slippage, the whole
interface jumps and rebuilds." The slippage is part of `routesKey`, so a new one was a new request: the list emptied
to a skeleton, the summary unmounted, the receive amount turned into a skeleton and the CTA jumped up (1440 px: form
column 684 → 448 px, CTA 236 px higher, the route list 308 → 148 → 407 → 340 → 308 px over 1.5 s; phones scrolled
to the top as the page shrank). The 30 s refresh did a smaller version of it (old rows plus a "Quoting…" row per venue,
then only the venues that had answered).
- **The list as shown.** `useRoutes` is unchanged; the screen folds its state (`useShownRoutes` over `foldShownList`,
  `src/screens/form/model.ts`). Within one list — `listKey`: mode, pair, amount — a round over rows already on screen
  (new slippage, recipient or refund address; the refresh) keeps every row, its key and its place until its venue
  answers; the answer replaces the numbers in place with the row's Best / Fastest kept, a refusal moves the venue to
  "Didn't quote", a venue new to the list comes last, and the finished round re-ranks once. Refusal rows keep their
  order on screen the same way (a venue that refuses again keeps its place; new refusals come last), never answer
  order. A list's first round streams as the port ranks it; a new pair, amount or mode clears as before (D7: a
  preview list never carries into a live one).
- **Held, never reviewable.** Each route on screen carries the `routesKey` it was quoted for. The port's snapshot
  always belongs to the request it was given (a new key starts empty), so a route taken from it is fresh; one kept
  from before keeps its key, and one quoted for other terms than the form's is *held*: dimmed, `aria-busy`, the CTA
  "Updating quote…" (disabled) while the chosen route is held, and `openReview` refuses it — required, not cosmetic,
  as D7's live-snapshot check: the review falls back to the drafted route on a network error, and Confirm takes its
  floor. A failed round keeps the rows, and what was held stays held — but stops claiming an update: "updating"
  (spinner by the minimum, `aria-busy`, "Updating quote…") only while a round runs (`heldAs`); after it the held route
  is "outdated", still dimmed and unreviewable, and the CTA reads "Couldn't update quote — try again", which only
  re-runs the round. The review still re-quotes (D19).
- **Fixed heights.** The receive card keeps its footer line (a no-break space, as the mobile spec has it); the status
  line is one line on a fixed basis, so the coverage beside it never wraps because the text changed; the summary
  keeps its rows, Rate and the minimum dimmed, a 12 px spinner by the minimum while the round runs. Motion is opacity
  and colour only, 0.2 s, off under `prefers-reduced-motion` (base.css). Checked by `tests/e2e/demo.spec.ts`
  (bounding boxes every frame through a slippage change, ≤ 2 px, at all three widths; scrolled to the bottom, so a
  shrinking page would show as a scroll jump). Demo venues move their minimum with the requested slippage, so the
  update shows.

**D33 — Connected wallets in one header dropdown (owner, 2026-11-13).** The owner asked for the connected wallets "in a
dropdown": at ≥ 640 the header drew one pill per wallet (three wallets — MetaMask on EVM and on Solana, TronLink — made
three pills), phones one combined pill, and every pill opened the whole wallet sheet. `WalletsDropdown`
(`src/screens/shell`, ui-port §5.2):
- **One button at every width.** No wallet: "Connect wallet", unchanged (the wallet sheet). Connected: one 40 px pill —
  the wallets' icons stacked, the address for one wallet or "N wallets" for more, a chevron at ≥ 640 —
  `aria-haspopup="dialog"`, `aria-expanded`.
- **The list.** At ≥ 640 a menu-look popover under the pill, right-aligned to it (the NetworkPicker pattern, D30); below
  640 the app's bottom sheet, as NetworkPicker does there. One row per wallet in the sheet's family order: the wallet's
  icon with its network's logo in the corner, "{wallet} · {Network}", the short address (selectable), copy, and
  disconnect (`wallets.disconnect(family)`) — what a pill was opened for most. Under the rows "Connect another wallet"
  opens the wallet sheet, shown only while a family is left: not "Manage wallets", since what the sheet adds beyond the
  rows is connecting (the options, the WalletConnect / TON Connect QR).
- **Closing and focus.** Escape and a press outside close the popover, Escape handing focus back to the pill (the sheet
  does that itself) unless focus is already elsewhere; focus leaving it (Tab past its last button, Shift+Tab off the
  pill) closes it. Focus is never left on `<body>` (WCAG 2.4.3; review of 2026-11-13): a disconnect moves it to the next
  row's disconnect, the previous row's after the last row; disconnecting the last wallet closes it and focuses "Connect
  wallet" once the wallet is gone; on phones "Connect another wallet" opens the wallet sheet only once the list's sheet
  is gone and has handed focus back to the pill (`Sheet`'s `onClosed`) — opened at once, the wallet sheet took the
  vanishing button for its opener and its close dropped focus to `<body>`. The popover is at most `100dvh − 66px` tall,
  its rows scrolling: it hangs from the sticky header, so on a landscape phone the page's scroll never reached its foot.
  A wallet that goes away elsewhere while it is open closes it too, so a later connect never reopens it.
- **Test ids.** `swap-wallet-pill` is the button now and `swap-wallet-pill-<family>` its stacked icons (ton.spec.ts and
  tron.spec.ts check one shows once its wallet connects); the list is `swap-wallets-menu` with
  `swap-wallet-row-<family>`, `swap-wallet-copy-<family>`, `swap-wallet-disconnect-<family>` and
  `swap-wallets-connect-more`. Covered by `tests/unit/screens/screen.test.tsx`, `tests/e2e/demo.spec.ts` (all three
  widths) and `tests/e2e/near.spec.ts` (disconnect from the dropdown).

**D34 — Review and status, as the owner read them (owner, 2026-11-13).** From screenshots of prod:
- **No status before the swap is sent.** After Confirm the sheet became the status ("Signing the swap", steps, "Keep
  this tab open…", a primary "Continue in background") while the wallet prompt was still open and nothing was signed —
  read as already sent. `startSwap` resolves at the engine's first step (runner.ts, unchanged); the review now stays,
  locked, Confirm loading, the wallet hint and `SwapSteps` from the record under its rows, and becomes `StatusView`
  only once the swap itself is broadcast (`afterConfirm`, ui-port §5.8: the record's `sourceHash`, or a tracked state
  after `submitting`; an approval sent first is not it). A swap that stops before shows "Not swapped" and the record's
  reason. After 20 s of waiting a quiet ghost 40 closes the still-locked sheet: "Cancel" while the chain switch is
  asked (nothing started; a switch that lands afterwards starts nothing, so a later review can't be followed by a
  wallet prompt for this one), "Continue in background" once `startSwap` is called (nothing is cancelled, the activity
  drawer follows the record; a stop before the engine made one is a red toast). The demo wallet now puts the hash on
  the record at `broadcast`, as the runner does. Checked by `tests/unit/screens/review.test.tsx` (fake execute and
  activity ports),
  `tests/e2e/demo.spec.ts` (the executing scene) and `tests/e2e/tron.spec.ts` (TronLink holds its prompt: still the
  review, nothing broadcast; the status after it answers).
- **The review fits without scrolling.** Every row was two lines (the chain repeated under the headline, "Quoted by" a
  row of its own, From and To both said "your … address"), so at 1280×800 Confirm sat 210 px below the dialog's edge
  (912 px of content in a 720 px dialog). Every fact Confirm authorizes is still text on screen (§2.6): pay, expected
  receive, the floor, the venue and its trust level, fees and the bridge fee, the approval's exact amount and spender,
  From, To — another address stays amber with its full-address box. What moved is explanation: the slippage breakdown
  behind the minimum's info mark, the trust sentence behind the Route row's (and the venue badge's hover tooltip — a
  badge alone isn't reachable by Tab or a tap). `TxReviewCard` gained `note` (dim, after a gap, no dot: a wrapped
  note never starts with one),
  `tip`, `badge` and `compact` (ui-port §2.5); the review is one line per row where it fits, the networks said once,
  one "From / To" row for one address, a two-line fine print with the countdown first (§5.8); the deposit panel's
  facts use the same rows. Measured on the demo build: common case 533 px (1280×800) and 575 px (390×844); an approval
  plus another recipient 670 px (1280×800 and ×900) and 747 px of the phone's 776. Once confirmed the steps (≈150 px)
  replace the fine print (34), so the heavy case outgrows the sheet: Confirm's block is scrolled back into view.
  `tests/e2e/demo.spec.ts` asserts Confirm in the viewport with the sheet body not scrolling (every width; the heavy
  case at 1280×900, and Confirm and the wallet hint in view once it is confirmed).
- **The status view's actions share one look.** "Refresh status" and "Done" were secondary 48 px buttons, the explorer
  links plain ghost text under them. They are `LinkButton`s now (src/ui/Button.tsx: an `<a>` with the Button's
  classes, always `target="_blank" rel="noopener noreferrer"`), secondary 48 with the `external` icon, "Source tx" /
  "Delivery tx" / "Claim tx" (their rows' words; "… on the explorer" is the accessible name), side by side in two equal
  columns when both exist — so a label never ellipsizes in the 340 px drawer — full width when one. Primary stays
  primary: "Continue in background", "Try again", "Claim on {chain}". Same in the review sheet and the activity drawer;
  checked by `tests/unit/screens/status.test.tsx` (delivered, sending, on its way, a claim, stopped).
- **The status view follows the review's compact look.** The owner's screenshot of prod (ETH → SOL via NEAR Intents, in
  progress, in the review's dialog): Paid and Receive two lines each, rows 11×14, then "Refresh status", "Source tx" and
  "Done" stacked — Done under the dialog's edge (on the demo build a native pair in progress was 704 px of content in
  680; with an approval 744, a claim 840). The status now uses the review's compact rows, one line each — Paid `· on
  {chain}`, Receive `≈ … · ≥ {min} on {chain}`, Route, To, both transactions; nothing a user checks is gone — `SwapSteps
  compact` (10 px between steps; the review's keep 16), gap 14, and its secondary actions two to a row (ui-port §2.7):
  in progress `[Refresh status][Source tx]` then Done, delivered the two links then Done; with both links still on its
  way Refresh goes beside Done. Primary actions stay full width. Measured (content / room): 1280×800 dialog — in
  progress 547 / 680 (581 with an approval), delivered 550, a claim with both transactions and Refresh 671; the 390×844
  sheet — the same in 728; the 380 px drawer — 547, 550, a claim 605, in 760. A QR deposit still waiting (its QR,
  address and tiles) is 856 in the drawer's 760 and still scrolls. Checked by `tests/unit/screens/status.test.tsx` (the
  card, the steps, each state's order of actions) and `tests/e2e/demo.spec.ts` (Done in view with the sheet body not
  scrolling: in progress and delivered, and an approval then a claim, at every width).

**D36 — Swap counts in Standard mode (owner, 2026-11-13; widened by D41).** The owner asked to count swaps anonymously and see them
daily in cp0x's ops chat: swaps per day, per venue, per direction (source network → destination network), every venue
including the on-chain ones; counts only, no volume. The server half is cp0x-api's `POST /api/v2/swap-web/sent` and a
daily cron (its `docs/swap-web-proxy.md` §8): per-UTC-day counts of venue × direction × mode, kept 120 days, no IP.
- **What is sent.** One POST to `<API>/api/v2/swap-web/sent` per swap, holding exactly `{venue, from, to, mode}`: the
  provider id, the two networks' catalog CAIP-2 ids (`chainByCaip2Web`'s, so a wallet's alias never goes out) and
  `wallet` | `deposit`. No address, amount, hash, swap id or time. A venue or network the app doesn't list sends
  nothing (the server's allowlist would refuse it anyway).
- **When.** Once per swap record, the moment it first reads as sent (`readsSent`, `src/activity/inflight.ts`): a wallet
  swap when its source hash lands on the record or it leaves `submitting` for a tracked state — the signal
  `afterConfirm` turns the review into the status with (D34), taken in the activity store so it fires whether the
  sheet is open or not — and a QR deposit when the tracker first sees it arrive (`depositSeen`: its "Send" step done;
  counted on the day it is seen). Arrival is the venue's `depositReceived` (NEAR: KNOWN_DEPOSIT_TX, PROCESSING), which
  swap2-core's `getSwap2Status` drops — every one of those is just "pending" there — so `swapStatus` reads it off its
  providers' `trackIntent` through delegates and the record keeps it (`depositReceived`); a venue that doesn't report
  it counts when its status moves on or a delivery hash comes. Not a stop before the broadcast, not a deposit that
  expired unseen, not a record another tab marked interrupted (its own tab takes it back, or nobody knows).
- **Once.** The store notes that moment on the record itself (`counted`, `noteSent`), in the same op, in the tab whose
  own write made it so — never on a BroadcastChannel message or a load — and only that write calls the store's
  `onSent` (the app's store hands it to `countSent`). A replace carries the flag, so the engine's handover, a
  speed-up's new id, a reload, another tab, the tracker's polls and an interrupted record taken back never count a
  swap twice; a record that read as sent before the flag existed is never counted late. The flag is set in every
  mode, so switching to Standard later never counts an old swap. Without Web Locks every tab polls, and two tabs
  seeing the same deposit arrive in the same instant could both count it: accepted.
- **Only Standard.** `countSent` (`src/activity/counter.ts`) sends only on a page running Standard with a plan — a
  build with `VITE_CP0X_API`, not demo — never in Public, Custom, demo or a build without the API. Its URL is the
  plan's base (`swapWebBase(CP0X_API)`) + `/sent`, so the bundle holds no new cp0x literal and guard-dist's
  one-origin rule stands. It doesn't wait for the health answer: a count to an unreachable server just fails.
- **How.** A simple `text/plain` POST (CORS-safelisted: no preflight, so `keepalive` carries it even when the tab
  closes right after the broadcast; the server reads the body as JSON whatever its type), `credentials: "omit"`,
  `referrerPolicy: "no-referrer"`, a 5 s timeout. The answer is never read and every error is swallowed: a 400, a
  429, a 503 or an API without the route changes nothing for anyone.
- **Said where it applies.** Settings → Connection, under the mode, while Standard is picked: "Counts each swap you
  send — venue and networks only, no address or amount." (`settings-standard-count`); its info panel and the README's
  privacy lines and modes table say the same.
- **Tests.** `tests/unit/activity/counter.test.ts` (the exact body and request; never in Public, Custom, demo or a
  build without the API; once at the broadcast, not at the first step, the handover or a poll; a stop before it
  never; deposits when seen, never when expired; a reload, another tab and an interrupted record taken back; errors
  swallowed; the runner with the app's own store), `tests/unit/screens/settings.test.tsx` (the line), and
  `tests/e2e/standard.spec.ts`: a TronLink payer's swap through NEAR Intents posts exactly one `/sent`, the body
  `{venue: "near_intents", from: "tron:728126428", to: "eip155:8453", mode: "wallet"}` as `text/plain`, and nothing
  more after a reload; in Public the same swap reaches no cp0x host. The Tron fake moved from tron.spec.ts to
  `tests/e2e/fakeTron.ts`, which both specs use.

**D35 — TON contract calls (owner, 2026-11-13).** From a TON wallet Omniston and Symbiosis aren't paid by a deposit:
the wallet sends one jetton transfer from the payer's own USDT jetton wallet whose forward payload is the venue's
instruction to its contract — a cell body (Symbiosis' bridge request, Omniston's escrow order, a DEX's swap) — or, for
Omniston's swap from TON itself, the TON straight to the DEX with the swap as its body (part C). `checkTonPlan` refused
every cell body and the route list every such route for a TON wallet. They are enabled one venue at a time, each only
once the EXACT BoC the wallet will sign passes the app's own decode AND the venue package's verifier, with every
expectation taken from the reviewed route, never from the quote; no existing check is loosened, every new path adds
one. Mobile signs both venues through the same engine hooks (its execute.ts, pins.ts); the web binds the jetton wallet
to the pinned wallet code instead of the jetton master's answer over RPC, and decodes the transfer itself instead of
trusting the engine's summary (which skips a custom payload and doesn't read the destination).
- **Part A — the plumbing, and Symbiosis paid in USDT (TON → EVM).**
  - *Engine.* For a TON payer only, `engineConfig` gets `decodeTonBody` (tonGate.ts `captureTonBody`: keeps the BoC it
    is handed, refuses anything but one ordinary root cell, returns a frozen `{__bocBase64, beginParse}` — the engine
    reads the transfer before the review) and `tonGasCeiling: TON_BODY_GAS` (0.5 TON; the engine's default and the
    package's own ceiling are 1 TON). `arm` hands that BoC to `checkPlanBrowser` and `planWrites(plan, boc)`: the write
    armed is the BoC read.
  - *Plan.* `checkTonPlan`'s blanket refusal became the venue rule `TON_CALLS` (tonPlan.ts): a listed venue only
    (Symbiosis), paid only in a listed jetton with pinned wallet code (USDT; native TON and other jettons refused), for
    a token the venue's call is checked for (`serves`; Symbiosis: `symbiosisRelease` — a token its pinned pools release
    directly on an EVM network, the real token of a pinned synthetic that shares a pool with the jetton's own: USDC on
    Ethereum, Arbitrum, Avalanche, BNB Chain, USDbC on Base, USDC.e on Polygon and Optimism; not Tron, whose payout
    from TON needs an EVM address of the payer's, and nothing reached by a swap on arrival), no calldata or memo, and
    the captured BoC through `checkTonCall` (tonGate.ts): sent bounceable to the payer's own jetton wallet computed
    from the pinned code (no API asked), at most 0.5 TON attached, one ordinary root read as a TEP-74 transfer — op
    `0x0f8a7ea5`, exactly the reviewed amount, to one of the venue's pinned contracts (Symbiosis' TON Portal, from its
    package's config), excess to the payer, a custom payload refused (not skipped), less TON forwarded than attached
    but at least the venue's `minForwardTon` (Symbiosis: 0.05 TON, every recording's — TEP-74: a transfer forwarding
    none sends the Portal no notification and 1 nanoTON can't pay for its work, so the USDT would sit at the Portal
    with neither recipient nor revert address ever paid), the instruction in a reference and nothing after it. Then
    the app's own read of that instruction (`instruction`; Symbiosis: op `0x5e7d9020`, exactly three cells, the head
    read to its end — the reviewed jetton and amount, and the relayers' fee `stableBridgingFee`, which the package
    bounds only by "less than the amount": what it leaves must cover the reviewed minimum unit for unit, the release
    being a like-asset token at its own decimals) — then the package's verifier on the same message:
    `checkSymbiosisTonMessage(symbiosisRequest(params), msg, reviewed.minOut)`, `params` rebuilt from the review
    (tokens, amount, recipient, the payer as sender), which decodes the bridge request against its pins — host chain,
    pools, the burn paying the reviewed recipient, a revert address that is the payer's or Symbiosis' pinned revert
    service, the pools' minimum less the burn's fee at least the reviewed minimum — and a route it reads as a swap on
    the destination refused (that burn's fee is bound by nothing there). A listed venue is paid from TON by its
    contract call only: a plain deposit for it (a jetton or TON transfer to an address its API named) is refused.
    checkPlan's own checks (minimum ≥ the reviewed one, gas only for a jetton source) still run first.
  - *Gate.* The engine hands the account the decoded body; on a TON gate `gateAccount` turns it into `bodyBoc` (the
    BoC it carries) before the frozen copy, which can't copy a Cell, so `matches` holds it to the armed BoC byte for
    byte; any other non-text body is refused. `getJettonWalletAddress` passes as a read.
  - *Account.* `tonEngineAccount(signer, deps, tonCallOf(reviewed))` signs no contract call but the reviewed route's
    own, and when it has one, nothing else (`transfer` and a plain `sendTransaction` are refused).
    `getJettonWalletAddress` names the payer's jetton wallet for that call's jetton only — the pinned-code
    address, TonAPI's answer checked against it, proven by `get_wallet_data` (owner, master, balance ≥ the amount) —
    and `sendTransaction({to, value, bodyBoc})` proves it again and builds ONE message: `to` as written (a raw one
    bounceable), the TON the write attaches, the write's BoC as the payload. checkTonRequest's new `jetton-call` kind
    (the `jetton` kind is unchanged) holds it to the envelope (one message, mainnet, the reviewed wallet, ≤ 5 min, no
    state init), the proven wallet, bounceable, the exact TON amount, the armed BoC (same string, same cell hash), and
    runs `checkTonCall` on it again.
  - *Route list.* `tonWalletRefusal(route, from, to)` lifts "TON contract calls aren't signed here yet" only for
    Symbiosis paid in USDT for a token it releases directly on an EVM network (`tonCallSigned(provider, contract,
    to.caip2, to.contract)`, the same `serves` the gate holds); Omniston (escrows and TON → TON swaps), Symbiosis from
    native TON, to Tron (its dry quote passes on a placeholder EVM address, the live one can't) or to a token reached by
    a swap on arrival stay refused — never offered, so never a Best that can't be confirmed.
  - *Still trusted*, as on the phone: Symbiosis' contracts, relayers and revert service, and the level of the minimum
    (its API's); the relayers' fees within the bounds above — the bridge request's (what it leaves covers the reviewed
    minimum unit for unit, so a request it starves reverts having cost at most what that minimum already allowed, the
    revert service repaying the rest) and the burn's (the pools' minimum less it covers the reviewed minimum, the
    package's check); the gas it attaches (0.2 TON in every recording), capped at 0.5 TON, the excess refunded. The
    review says "+ network fee in TON", not the attached amount. (The EVM source shares the package's bridge-request
    check, and with it the head fee's "less than the amount" alone: hardening sent to the SDK's owner — check the pools'
    consistency on the amount less that fee.)
  - *Tests.* `tests/unit/execute/tonCall.test.ts` over `symbiosisTon.fixture.json` — two dry quotes captured
    2026-11-13 (USDC on Arbitrum, 6 decimals; USDC on BNB Chain, 18 decimals; both direct releases) and the SDK's
    recording (USDC on Base, a swap on arrival: refused by the direct-release rule, by the venue rule's verify on its
    own, and through executeSwap): the pass case and every tampered field, at the plan and on the TON Connect message
    (target, non-bounceable, gas > 0.5 TON, op, amount, destination, excess, custom payload, forward ≥ value, forward
    0, 1 nanoTON or just under the floor, inline or trailing data, another body or encoding, two messages, state init;
    the bridge request's op, cells, jetton, amount, trailing head data, a relayers' fee one unit past what the reviewed
    minimum allows and all but one unit of the input, its recipient and revert address; the reviewed recipient and
    minimum, native TON, another jetton, another venue, Tron, a plain jetton or TON transfer for the venue); the real
    engine and the real Symbiosis provider over the recordings through executeSwap to a fake TON Connect wallet (one
    request: the jetton wallet, 0.2 TON, the exact BoC; five tampered answers — another target, non-bounceable, more
    gas, forward 0, the fee eating the input — refused before the wallet); `gated.ts` with the decoded body; an account
    built for the call refusing plain transfers. `tests/unit/screens/model.test.ts`: the route list offers Symbiosis to a
    TON wallet paying USDT for USDC on Arbitrum, not for Tron, USDC on Base, a native coin or no token yet.
    `tests/e2e/ton.spec.ts`: a fake Tonkeeper pays 50 USDT for USDC on Arbitrum through Symbiosis' stubbed API — the
    one request is the jetton wallet, the TON attached and the exact BoC — and an answer tampered after the review (the
    same wallet, non-bounceable) is refused before the wallet is asked.
- **Part B — Omniston's escrow paid in USDT (TON → EVM).** From TON an Omniston order is an HTLC escrow: the payer's
  USDT jetton wallet sends the input to Omniston's TON Escrow Minter with an escrow order (`0xc0a5f0d9`) locked by the
  hash of a secret only this browser holds; the resolver delivers on the EVM network and the package's `trackIntent`
  discloses the secret once `validateEvmOutputPosition` proved that delivery — or the escrow refunds the payer after
  its timelocks. The message exists only after the local provider's `buildDeposit`, which generates and stores the
  secret and runs the package's payload check (`validateTonEscrowPayload`) on what Omniston built.
  - *Venue rule.* `TON_CALLS.omniston` (tonPlan.ts): paid only in USDT (an escrow from native TON is refused, as the
    phone refuses it: "an escrow body needs a jetton source"), for an ERC-20 on an EVM network Omniston's escrow check
    encodes and audits a settlement contract on (`omnistonEscrowServes`; not a TON → TON swap — a DEX router TonAPI's
    label names, no deadline checked — not a native coin, not Tron); the transfer may pay only `OMNISTON_TON_MINTER`,
    the rev2 minter EQDybO88… pinned in the main bundle (a test holds it equal to the package's
    `AUDITED_OMNISTON_SETTLEMENT_CONTRACTS["ton:-239"]`; rev1 never); it forwards at least 0.3 TON (`minForwardTon`,
    every recording's: two live escrows, 2026-10-10 and 2026-11-11, and the dry builds of 2026-11-13 and 2026-11-14 —
    0.4 TON attached, under `TON_BODY_GAS`).
  - *The app's own decode* (checkTonCall, unchanged, then `omnistonInstruction`): the envelope and the TEP-74 transfer
    as in part A (one message, mainnet, the reviewed wallet, ≤ 5 min, no state init; to the payer's pinned-code jetton
    wallet, bounceable, ≤ 0.5 TON; op `0x0f8a7ea5`, the reviewed amount, the pinned minter, excess to the payer, a
    custom payload refused, forward between the floor and the TON attached, the order in a reference, nothing after
    it); then the order itself: op `0xc0a5f0d9`, the payer as owner (where it refunds) in the order and in its owner
    data, the TON the minter forwards to the escrow — at least 0.12 TON (`OMNISTON_ESCROW_GAS`, every recording's,
    the quote's `estimatedGasConsumption`: the escrow's own deploy gas, with less its creation fails; the package asks
    only for more than none) and less than what the transfer brings it (the instruction reader is now told that
    amount; Symbiosis ignores it) — and its four cells; the auxiliary cell (the 3rd, which the package reads for shape
    only): a zero address, then the payer as where a failed creation refunds the input (the build request's
    `refundSrcAddress`: a read-only dry build of 2026-11-14 that asked for another address found it in that slot, and
    the package's checks passed it), 3 zero bits and one cell held by hash to every recording's (both live escrows,
    the dry builds of 2026-11-14), nothing else; the flags cell (the 4th) held by hash to every recording's too; the
    config's one resolver, no Dutch auction, a destination, one full fill; the execution locked by ONE keccak hash and
    naming the same resolver; the destination the reviewed EVM network, token and recipient, the resolver bound to
    send at least the reviewed minimum; every cell read to its end. The pins (escrow and execution code, authority
    key, timelocks, the deposit) are the package's, below.
  - *Bound beyond its bytes* (TON_CALLS `bind`, a new, asynchronous half of a rule: `omnistonEscrow.ts`, a chunk of its
    own with @ton/core and the package, loaded for this call only). (1) The build: omniston.ts keeps every escrow
    whose `validateTonEscrowPayload` passed, by its exact payload (`omnistonBuilds.ts`, in memory, the last 16) — the
    provider's binding to the quote it cached (quote id, resolver, deposit, exclusivity, what the resolver sends); a
    BoC it didn't build and check, or naming another quote id, is refused. (2) The hashlock: the one secret IndexedDB
    holds for that quote (`os:<quoteId>`, read back from disk), hashed with keccak-256, must be the escrow's hashlock
    and the build's — so the preimage is on disk before anything is signed, and no one else's unlocks the payer's
    USDT. (3) The package's `validateTonEscrowPayload` again on these bytes, the review's side from the review (the
    amount, the payer as owner, the network, token and recipient), the hashlock of (2), the quote's side from (1).
    (4) `omnistonEscrowVerifier` — the phone's construction (mobile pins.ts): an escrow body needs a jetton source,
    then `omnistonVerifyBuild({...createOmnistonTonValidators({tonApiUrl}), integratorAddress: null})` — on the exact
    BoC with a quote and a request rebuilt from the review (never the live quote, so always its escrow branch): the
    audited settlement contract, the amount, owner and destination again, the resolver bound to send at least the
    reviewed minimum. Its `verifyTonEscrowBuild` reads the quote id, resolver and hashlock from the body itself, so it
    is never run alone: (1)–(3) bind those.
  - *Where it runs.* execute.ts's `arm` is async now (the engine awaits `reviewExecution`): it reads the kept BoC once,
    runs `checkPlanBrowser` and then `checkTonCallBinding(plan, reviewed, boc)` (null for anything but a TON cell body
    and for a venue without a `bind`), refuses if the kept BoC changed meanwhile, and arms that BoC. The TON account
    freezes the TON Connect request, runs `checkTonRequest` and then the call's `bind` on it, right before the wallet is
    asked; a `bind` that throws is a refusal. Symbiosis' rule has no `bind` (its `verify` is synchronous); every rule
    has a `verify`, a `bind` or both (a test holds them to it).
  - *The secret's life*, unchanged in the package and wired as it already was for a TON source: buildDeposit saves it
    (stores.ts, durability "strict", `navigator.storage.persist()` asked once) before it asks Omniston for the escrow;
    the gate signs only after reading it back (above); `trackIntent` discloses it only after `validateEvmOutputPosition`
    (`createOmnistonEvmOutputValidator` over the page's RPC table) proved the EVM position for this quote, hashlock and
    recipient — the activity tracker polls the record through the router (`getSwap2Status`), after a reload too, the
    `oq:`/`os:` rows being IndexedDB's; a fill clears them. A tab closed while the wallet's prompt is open and signed in
    the wallet app afterwards leaves no record to poll: the secret is never disclosed and the escrow refunds the payer.
  - *Route list.* `tonCallSigned("omniston", USDT, EVM chain, ERC-20)` lifts the refusal for that case only; Omniston's
    TON → TON swaps, an escrow from native TON or another jetton, to a native coin or Tron stay refused.
  - *Still trusted*, as on the phone: Omniston's contracts and the resolver — its price, its identity and its deposit
    (the quote's, held to the build), whether it fills at all (else a refund after the timelocks); what the auxiliary
    cell's zero address and cell and the flags cell mean (unread, held byte for byte to the recordings: a change on
    Omniston's side is refused until it is recorded and reviewed); that 0.12 TON pays for the escrow's deploy (the
    recorded amount, not measured against the minter's code); TonAPI for the package's own jetton-wallet check (the
    pinned-code wallet backstops it); the gas it attaches (0.4 TON in every recording), capped at 0.5 TON, the excess
    refunded. What the resolver is bound to send includes the protocol fee (0.03 % recorded); what the recipient gets
    is the quote's output, at least the reviewed minimum (checkPlan), and the disclosure checks it on chain before the
    secret leaves. No TON-source escrow has been signed from the web live yet. (The phone runs only the package's
    checks on this body, so it lets a failed creation's refund elsewhere and 1 nanoTON of escrow gas through: hardening
    for the SDK's owner — `validatePayload`/`verifyTonEscrowBuild` should bind the auxiliary cell's refund address to
    `ownerAddress` and floor the escrow's gas.)
  - *Tests.* `tests/unit/execute/omnistonTon.test.ts` over `omnistonEscrowRev2.fixture.json` (the phone's live rev2
    capture of 2026-11-11, USDT on TON → USDC on Base): the pin against the package's table; every field at the plan
    (target, bounce, gas, op, amount, rev1 or another minter, excess, custom payload, forward at or past the TON
    attached, 0, 1 nanoTON, just under the floor, inline or trailing data; the order's op, owner twice, layout bits,
    escrow gas at or past what the transfer forwards, 0, 1 nanoTON or just under 0.12 TON; the auxiliary cell's refund
    to someone else, to the payer's jetton wallet or to no address, its zero address, its 3 bits, another cell of the
    same shape (an address in it) or another one, a bit or a cell after them; the flags another value, a bit set in
    its tail or a cell after it; config op, Dutch auction, parts, a sha256 or two-resolver execution, network, token,
    recipient, a delivery under the reviewed minimum), both live escrows carrying the same auxiliary cell (the payer
    aside) and flags; the binding (bytes the provider didn't check, another quote id, someone else's hashlock, no
    secret on disk, another or two secrets, a build kept with another hash or hashing function; another resolver,
    deposit, window, timelocks, escrow code, authority key or delivery than the quote's; the review's recipient,
    network, token, owner or amount; the reviewed minimum above what the resolver sends; native TON), and the
    package's checks passing what only the app's decode refuses (a failed creation refunded elsewhere, another zero
    address or flags, 1 nanoTON of escrow gas: shape only, more than none); the
    phone's pins.test.ts:68-105 port (pass, destination, owner, token, amount, short delivery, not an escrow, native
    TON, no request, rev1 refused by name); the TON Connect message (an armed escrow refunding a failed creation
    elsewhere, or with 1 nanoTON of escrow gas, refused there too); the account binding again right before the wallet
    (a secret cleared by then is refused); the real engine and the real Omniston provider (`lazyOmniston` →
    `buildOmniston` over IndexedDB, its WebSocket client replaced by a recording one) through executeSwap to a fake TON
    Connect wallet — one request (the jetton wallet, 0.4 TON, the exact escrow), the one secret for the quote on disk
    while the wallet is asked and its hash the escrow's hashlock; six tampered builds refused before the wallet (0.6
    TON, non-bounceable, 1 nanoTON forwarded, 1 nanoTON of escrow gas, a failed creation refunded elsewhere, the secret
    gone after the build); and the secret's life through the activity tracker's `pollRecord`: not
    disclosed while `validateEvmOutputPosition` refuses or throws, disclosed after a reload (a new provider and stores
    over the same IndexedDB) once it passes, cleared on the fill. `tests/e2e/ton.spec.ts`: Omniston's WebSocket API
    stubbed (JSON-RPC, the capture's quote, the escrow built with the hashlock the page asked for) — the one TON
    Connect request is the jetton wallet, 0.4 TON and that escrow, the page's IndexedDB holding the one secret whose
    hash locks it; a build forwarding the minter 1 nanoTON, having it forward the escrow 1 nanoTON, or refunding a
    failed creation to another wallet is refused before the wallet is asked.
- **Part C — Omniston's swap between TON and USDT on TON (owner, 2026-11-14).** Omniston builds a swap on TON as one
  message from the payer (`tonBuildSwap`): USDT in, a jetton transfer from the payer's USDT wallet to the DEX — a
  STON.fi router, DeDust's USDT vault — carrying the DEX's swap; TON in, the input plus gas sent straight to the DEX —
  a STON.fi router's pTON wallet, DeDust's native vault — with the swap as the message's own body. Its package and the
  phone know which DEX is real only by TonAPI's code-interface labels and its get-methods, and a label can't say which
  instance a contract is (STON.fi v2 routers are deployed by anyone with the genuine code, its admin then holding a
  7-day code upgrade; DeDust CPMM v2 pools are permissionless, with a creator's own fees and resolvers); for TON in,
  nothing pins the target at all (the package's `callTargets` are empty; the engine binds it by value only). So the
  web pins the DEXes by address and reads every field of the swap itself, and nothing at run time comes from TonAPI,
  an indexer or Omniston's labels.
  - *Pins* (`tonDexPins.ts`, the main bundle, strings only; each with its source in a comment). STON.fi v1: the router
    EQB3ncyB… (ston-fi/sdk `dex/v1/constants.ts`, api.ston.fi/v1/routers), its pTON v1 wallet EQARULUY… (the routers
    API; on chain owner = the router, master = pTON v1), its USDT wallet derived from USDT's pinned wallet code.
    STON.fi v2: the one router holding the liquid TON/USDT pool, EQCS4UEa… (v2.2; api.ston.fi/v1/routers and
    pools/by_market — of 50 v2 routers listed, the only other TON/USDT pools are dust), its pTON v2 wallet EQCSIMGB…,
    its USDT wallet derived. DeDust v1: what its factory EQBfBWT7… (docs.dedust.io, dedust-io/sdk) derives — the native
    vault EQDa4VOn…, the USDT vault EQAYqo4u…, the TON/USDT volatile pool EQA-X_yo…. Each address and code hash read
    once, read-only, on 2026-11-13; refreshed by hand at a release (the routers API, pTON wallets' get_wallet_data,
    the factory getters, USDT's get_wallet_address against the derivation), never at run time: a DEX's new contract is
    refused until it is pinned. The entry floors are every recording's: USDT forwarded to STON.fi v1 0.135, v2 0.21,
    DeDust 0.1 TON; TON beyond the input to STON.fi v1 0.1, v2 0.22, DeDust 0.1 TON.
  - *Venue rule.* `TON_CALLS` is now venue → its calls (at most one serving a route; `tonCallOf` and `tonCallSigned`
    pick it, `checkCellBody` names why none does in the same words as before). A rule's `destinations` carry each
    contract's least forward (Symbiosis' 0.05 and the escrow's 0.3 TON unchanged), and a rule may name `native`
    contracts: TON sent to one of them, each with the least gas beyond the input; absent, never paid in TON (Symbiosis,
    the escrow). Omniston's second rule: paid in USDT or TON, for the other of the two on TON only
    (`omnistonSwapServes`), entering at the pins above, its instruction `omnistonSwapInstruction` (tonSwap.ts), bound by
    `omnistonSwap.ts`.
  - *The app's own decode.* `checkTonCall` gained a TON-in branch (the jetton branch is unchanged but for the
    per-contract floor): bounceable to a pinned entry, the reviewed input plus at least that entry's floor and at most
    0.5 TON (`TON_BODY_GAS`; checkPlan already caps a TON cell body at the input plus that), one ordinary root; then the
    instruction reader, told the TON that comes with it and the contract it goes to — the pin decides the layout,
    never the quote's label (tonSwap.ts). STON.fi v1: USDT in, swap#25938561 forwarded to the router; TON in, a
    TEP-74 transfer of exactly the input to the pTON wallet's own router, excess to the payer, no custom payload,
    forwarding at least 0.1 TON and no more than the gas, carrying that swap in a reference. The swap: the router's
    wallet of the reviewed output (its pinned USDT wallet, or its pTON wallet for TON), the minimum ≥ the reviewed one,
    the reviewed recipient, no referral. STON.fi v2: USDT in, swap#6664de2a forwarded to the router; TON in,
    ton_transfer#01f3835d of exactly the input refunding the payer, the swap in a reference. The swap: the router's
    wallet of the reviewed output, refund and excess to the payer, the deadline (below), then the minimum, the
    recipient, no chained swap (forward gas 0, no custom payload), no refund payload or its gas, no referral (fee 0
    AND no address — the package lets a zero-fee referral at any address through). DeDust v1: USDT in, swap#e3a0d482
    forwarded to the USDT vault; TON in, swap#ea06185d of exactly the input to the native vault. The step: the pinned
    TON/USDT pool, a given input, the minimum, no next step; its params: the deadline, the recipient, no referral, no
    payload for the recipient, and back to the payer on a refund either nothing or what every build carries (op
    0x3c37d7e9, the payer twice — undocumented, delivered only to the payer). The recipient always named explicitly
    (never addr_none, "the sender"); every cell read to its end.
  - *The deadline.* Omniston sets none and can't: its build request has no deadline field (@ston-fi/omniston-sdk
    0.8.12 `BuildTonSwapRequest`); it sends STON.fi v2's tx_deadline as 2^32 − 1 and DeDust's as 0 (no deadline; 7 of
    8 recent CPMM v2 swaps with 0 paid out), and STON.fi v1 has no field. Requiring one would enable nothing. What
    bounds when the swap can run is the TON Connect request itself — at most 5 minutes (`checkTonRequest`), which the
    wallet signs as its message's own expiry, so the signed message can't be included later — with the on-chain
    minimum at least the reviewed one whenever it runs, and the write armed once. The reader decodes each deadline and
    passes only Omniston's "none" as recorded or a real deadline in the next 20 minutes (`OMNISTON_SWAP_DEADLINE_S`).
  - *Bound beyond its bytes* (`omnistonSwap.ts`, a chunk of its own, the rule's `bind`): the package's build verifier
    `omnistonVerifyBuild` — its `checkTonSwapPayload` (the layout, amount, recipient, refund and excess, the minimum,
    referral, cells to their end), then the DEX target and the chain facts the body depends on — on the exact BoC,
    with the quote and request rebuilt from the review (amount, minimum, payer, recipient, tokens), the route ONE step
    through the DEX whose pin the message pays (never the quote's route steps or protocols), and its two chain-fact
    hooks answered by the pins, not TonAPI: `validateTonSwapTarget` (that very contract, for that DEX),
    `validateTonSwapLeg` (the router, its pTON wallet and the wallet it is asked for, or the pool, the pinned ones for
    the reviewed pair); no integrator. It runs before anything is armed and again right before the wallet, as the
    escrow's does. The provider's own build checks (TonAPI-backed, in `buildDeposit`) still run first; they can only
    refuse.
  - *Account and message.* A call paid in TON names no jetton wallet: `getJettonWalletAddress` refuses it, and
    `sendTransaction({to, value, bodyBoc})` sends the write's own target — checkTonRequest's new `native-call` kind
    holds it to the envelope, that target (bounceable), the exact TON amount and the armed BoC, then `checkTonCall`
    again; a `jetton-call` and a `native-call` are each refused for the other kind of call. The jetton-call kind
    serves USDT in, unchanged.
  - *Route list.* `toWebRoute` keeps an Omniston swap's route steps (`tonSwapSteps`, its quote's `routeSteps`
    protocols). For a TON wallet, `tonWalletRefusal` offers Omniston's swap on TON only for TON ↔ USDT
    (`tonCallSigned`, else "Only TON ↔ USDT swaps are signed here") whose quote names one step through StonFiV1,
    StonFiV2 or DeDust (`omnistonSwapRouteSigned`, else "Routed through a DEX that isn't pinned here", the detail naming
    the DEX or "several hops"). That label only ever refuses: the gate decides by the contract the exact BoC pays, so a
    live quote re-routed after the review (Omniston answered TON → USDT through DeDust CPMM v2 on 2026-11-13), or a
    STON.fi v2 route through another router than the pinned one, is refused at Confirm, nothing signed.
  - *Not enabled, and what would unblock it.* DeDust CPMM v2 (what Omniston quotes TON → USDT through today): its
    TON/USDT pool EQAH4MY1… is vouched for only by its code (a library cell equal to dedust-io/kit `PoolV2.LIBRARY_HASH`)
    and Omniston's builds — no DeDust address list or factory names the canonical pool, and pools are permissionless —
    so it waits for DeDust (or the SDK) to publish its canonical pools, or for the owner to accept code-plus-chain
    provenance; from USDT no build is recorded at all. STON.fi's other v2 routers: a published allowlist. TONCO and
    swap.coffee: no decoder in the package (it refuses to build them). Several hops: per-hop pins and decode. Any other
    jetton: its wallet code pinned (an ask wallet derived) and its pools. The route list reads these as refused.
  - *Still trusted*: the DEX contracts and their admins (STON.fi v2's 7-day code-upgrade timelock; DeDust's
    upgradeability undocumented); Omniston's price, bounded by the reviewed minimum on chain; what DeDust's refund note
    means; the gas, at most 0.5 TON (0.1–0.26 TON in every recording), the excess refunded; a refund's path (STON.fi v1
    and DeDust refund the sender — the payer, the only sender here). Hardening for the SDK's owner: pin the DEX
    instances (TON `callTargets` in `omnistonPins`, router and pool pins in the validators) instead of TonAPI labels;
    bound deadlines; refuse a zero-fee referral at another address; read DeDust's fulfill/reject payloads, CPMM v2's
    payout extras and STON.fi v2's refund forward gas instead of skipping them. No TON → TON swap has been signed from
    the web live yet.
  - *Tests.* `tests/unit/execute/omnistonSwap.test.ts` over `omnistonSwaps.fixture.json` — every TON ↔ USDT build
    recorded: the SDK's of 2026-10-22 and the read-only dry builds of 2026-11-13 (12 through a pinned DEX: STON.fi v1,
    v2 and DeDust v1 both ways; 3 through DeDust CPMM v2, 1 through swap.coffee, 1 to USDe through another v2 router,
    all refused): the pins against their friendly forms, the derivation, every recording, the package's protocol names
    and pTON masters, the recorded floors; the rewriters re-encoding every body cell for cell; at the plan, per DEX and
    direction, every field — the envelope (target, bounce, gas 0 / under the floor / past 0.5 TON, another DEX's entry
    carrying this body), the transfer (op, amount, destination, an unpinned or wrong-role contract, excess, custom
    payload, forward, inline, trailing), pTON v1's transfer (op, amount, router, excess, custom payload, forward past
    the gas or under 0.1 TON), pTON v2's (op, amount, refund), the swap (op, ask wallet — another, the other output's,
    another router's — minimum, recipient or none, referral fee or address, chained swap, refund payload or its gas,
    deadline past, too far, 0 or near-max, a real one in 20 minutes passing; DeDust's pool, kind, limit, next step,
    deadline, recipient, referral, payloads, its refund note's op, addresses or tail), and the review's recipient,
    minimum, amount and payer; the binding (all pass with no network; the review's side; legs and targets off the
    pins; what the package reads, and what only the app's decode holds — a day-away deadline, a zero-fee referral,
    refund gas, DeDust's payloads — which flips once the package binds them); checkPlanBrowser and the binding as arm
    runs them; the TON Connect message (native-call and jetton-call, each refused as the other); the account (TON in:
    no jetton wallet asked, one message to the pin; USDT in: the proven wallet); and the real engine and the real
    Omniston provider (`lazyOmniston` → `buildOmniston`, its WebSocket client replaced, TonAPI's answers to its own
    checks replaced by yes) through executeSwap to a fake TON Connect wallet — one request for each recording that
    carries its quote (every DEX and direction but STON.fi v1 from USDT, a dry build), the recorded message exactly; eight builds the provider passes refused before the wallet (DeDust CPMM v2, another ask
    wallet, a zero-fee referral, a day-away deadline, refund gas, a recipient payload, another target, 0.6 TON of gas
    quoted). The escrow's and Symbiosis' tests run unchanged but for the rule's new shape (`TON_CALLS` lists,
    per-contract floors). `tests/unit/screens/model.test.ts` and `tests/unit/swap/webRoute.test.ts`: the route list
    offers TON ↔ USDT through each pinned DEX and refuses DeDust CPMM v2, TONCO, swap.coffee, two hops, a split, no
    steps, any other pair. `tests/e2e/ton.spec.ts`: a fake Tonkeeper swaps 2 TON for USDT through Omniston's stubbed
    WebSocket API (the SDK's DeDust v1 recording; TonAPI with what the package's own checks read) — the one request is
    DeDust's pinned native vault, 2.1 TON and the exact recorded body — and the same swap re-routed after the review
    through DeDust CPMM v2 is refused before the wallet is asked.


**D37 — Prices read the way the market reads them (team feedback, 2026-11-15).** Compared against an aggregator on
WETH → wstETH (15.14 WETH), three things read wrong: the receive card showed the expected 12.1235 while every route row
showed a minimum near 12.00; the minimum sat ~1% under the quote even at a custom 0.05% slippage; and the presets were
0.1 / 0.5 / 1 / 3%. Now:
- **Rows show the expected amount**, the same number as the receive card, with the minimum the swap enforces under it
  ("min 12.0582"); the label reads "about … at least …". Ranking is unchanged.
- **The execution margin scales with the slippage**: `floorToleranceBps(bps)` = min(0.5%, slippage) (math.ts, web). The
  route carries it (`WebRoute.floorBps`, set by toWebRoute from the request's slippage) and `routeFloor(route)` is the one
  floor the list, the summary, the review and execution use. At 0.05% the minimum is now 0.1% under the quote, not
  0.55%; at 0.5% and above nothing changes (the 0.5% margin covered ~18 bps of drift while a review is read and signed).
- **Auto is always a preset** (owner, 2026-11-15, after the first cut still left ETH → USDC at 0.5%): 0.05% on one
  network when both tokens are liquid (USD stables, majors and their wrappers / liquid-staking forms), 0.3% across
  networks (a bridge or an intent fills over minutes) or with a long-tail token (`autoSlippageBps(from, to, sameChain)`).
  The margin follows it: the minimum sits 0.1% under the quote at 0.05%, 0.6% at 0.3%.
- **Presets 0.01%, 0.05%, 0.3%** and Custom (0.01–50%); every label keeps its precision (`bpsLabel`).
- **The review once confirmed keeps the terms in view**: the card keeps You pay, You receive, Minimum received and
  Route; the approval, fee, rate and address rows, the Fynd licence note (read before Confirm) and the saved-settings
  notice step aside, so the steps and Confirm fit under the headline.
The rate itself (ours 0.0002 wstETH under the aggregator's best on that trade) is the venues': 1inch, KyberSwap and
Velora aren't venues here, and the aggregator's numbers are before the positive slippage it keeps.
**D38 — 0x and Across, keyed by the proxy (owner, 2026-11-15).** Any Wallet Kit released two venues whose APIs want a
key on every request: `@anywalletkit/protocol-swap2-0x` 0.1.1 (0x Swap API v2, Permit2 flow; exact-input swaps on one
network: Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, BNB Chain) and `@anywalletkit/protocol-swap2-across`
0.1.0 (Across: EVM → EVM, the same asset on both sides — USDC, USDT / USDT0, ETH / WETH, WBTC — on its 17 pinned
chains, a plain `deposit` on the source SpokePool; nothing into Ethereum yet). A key can never ship in a page (D24),
so — like Fynd, and like keyed LI.FI — they exist only in Standard mode and only while the proxy's health says them
"keyed"; Public and Custom never build them, and there is no Custom key for them.
- **The checks run here.** The page runs each module's LOCAL provider (`zeroExProvider`, `acrossProvider`), not the
  remote stubs, so everything the modules check happens on this device: 0x's Settler read from 0x's on-chain registry
  over the page's own RPCs (`ownerOf(2)` / `prev(2)`), held to the CREATE3 address the registry deploys to, the
  package's pinned deployment window and code at the address; the transaction decoded (`Settler.execute`: recipient,
  buy token, minimum, the first action spending exactly the permit); the Permit2 payload rebuilt from local constants.
  Across's deposit is encoded here from the pinned SpokePool and the request, every argument held to it (depositor =
  the signing account, `QuoteParams.sender`; recipient, tokens, amounts, chain, empty message, deadlines, a per-asset
  fee floor and a 10 % cap) at build time and again before signing. The APIs supply numbers only.
- **The key is a placeholder.** Each module refuses to quote without a key and sends it only to its `baseUrl` (0x as
  `0x-api-key` with `0x-version: v2`, refusing an answer that came through a redirect or from another origin; Across's
  V5 as `Authorization: Bearer`). Here `baseUrl` is the proxy slot — `<API>/api/v2/swap-web/venue/zeroex`, `…/across`
  — and the key is a fixed public string (`PROXY_KEY_PLACEHOLDER`, providers.ts), which the proxy drops for cp0x's own
  (`ZEROEX_API_KEY`, `ACROSS_API_KEY`). The modules append their own paths: 0x `GET /swap/permit2/price` (a dry quote)
  and `GET /swap/permit2/quote` (the live one) with `chainId, sellToken, buyToken, sellAmount, slippageBps` and
  `taker` / `recipient` when there are addresses; Across `POST /v1/quotes` (JSON). Neither module works under React
  Native with a key, by design; in a browser it is the page's own fetch, routed by the Standard wrapper.
- **Slots and health** follow Fynd exactly (D30): `ProxyVenue` + `"zeroex" | "across"`, both `PROXY_ONLY` (no public
  base, no config base, `plan.venues.<v> = null`), `standardProxyOnly(venue)` (standardFynd is its Fynd case), the
  providers built behind `whileLive(slot.live)` (a page whose health doesn't key one never asks it, and lists no row
  for it), an unused slot failing without a request, a failure at the proxy or an upstream 401/403/429 stopping the
  slot with no direct retry — except 0x's 403 that names a token, account or recipient it doesn't serve
  (`BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE`, `XSTOCKS_NOT_AUTHORIZED`… — the module's `unsupported_pair`; xStocks behind
  the proxy are judged by the region of cp0x's server): that refuses one request, goes back to the module as its
  answer and stops nothing (`REQUEST_REFUSALS`, standard.ts). Previews ask them through their slot too (`KEYED_PREVIEW_VENUES`, `PREVIEW_VENUES`): each
  fills its own blank addresses (0x asks its price without a `taker`; Across prices for its own placeholder and never
  builds that quote). Across's keyless relayer-fee quote (`https://app.across.to/api/suggested-fees`, CORS `*`,
  checked 2026-11-15) stays straight from the browser, as the module defaults: no key, and the module holds V5's price
  to it. Across's RPCs take one URL per chain, so it gets the first runtime URL with the rest behind it
  (`rpcFailoverFetch`, as CCTP); 0x's take the whole runtime list.
- **The gate (D10) takes exactly 0x's permit.** A 0x token sale is paid by a one-time Permit2 signature transfer
  (swap2-core 0.13.0): the engine signs the rebuilt `PermitTransferFrom` first, then approves canonical Permit2 for
  exactly the input unless a standing Permit2 allowance covers it, then sends the Settler call with the signature
  appended. `VENUE_RULES.zeroex` = call targets the Settlers the provider's own resolver last read (`zeroExSettlers`,
  never the API's word), spender canonical Permit2 only, and `permit2: {maxSeconds: ZEROEX_MAX_PERMIT_SECONDS}` (600,
  the package's bound). `permit2Problem` holds the plan's `permit2Transfer` to exactly `{domain, types, primaryType,
  message}` with the Permit2 domain on the source chain, Permit2's PermitTransferFrom / TokenPermissions and nothing
  else, the reviewed token and exactly the reviewed input, the call's own target as spender, a uint256 nonce and a
  deadline within 10 min; a native sale, native value with it, an approval to anything but Permit2, and any venue
  whose rule has no `permit2` are refused. `planWrites` arms that permit (`{kind: "permit2"}`: the whole payload as
  stable JSON) and the call with `permit2Signed`: it matches only with exactly the signature the wallet returned for
  that permit appended (`gate.recordSignature`, fed by the gated account's `signTypedData`; reset on every re-arm). No
  blanket typed-data allowance exists. Across's rule is its pinned SpokePools (`acrossPins`).
- **UI.** Names "0x" and "Across", trust "API", logos (web3icons' ZRX / ACX marks on the venue tile, LICENSES.md).
  0x's price answer has no transaction, so it is `SIGNED_ONLY` (never a deposit address) and its approval spender is
  named here (`orderSpender` → Permit2); the review's Approval row reads "Permit2 … + a one-time signature" and the
  wallet steps name the signature before the approval (`walletSteps`). The engine calls the permit's prompt `signing`,
  like the swap's own; the runner records the first `signing` of a 0x token sale (and the first after a re-quote) as
  stage `permit` with `permit: true` on the record, so the steps read "Sign the Permit2 transfer" → "Approve {SYM}"
  (or "{SYM} already approved for Permit2" when a standing allowance spared it) → "Confirm the transaction", the status
  "Signing the Permit2 transfer", and a tab closed at the permit is `not-sent` ("nothing was swapped"), never
  maybe-sent: the signature is off-chain and only that tab could spend it. "Not for this pair": 0x "Same-network swaps
  only" / "Not on this network"; Across by its module's own route check (`acrossRouteOf`, `acrossRouteUnpriced`):
  "EVM networks only here", "Between networks only", "Not on one of these networks", "Same token on both networks
  only", "Delivers ETH, not WETH — pick ETH", "Moves ETH as a native coin only", "Doesn't list one of these tokens",
  "Not into Ethereum yet". Refusals: their texts that read better than the reason alone (0x's transport and key
  refusals as Fynd's, its liquidity, token-tax and newer-Settler texts; Across's minimums and maximums in the pay
  token, its 10 % fee cap, a price under what relayers take), the rest by reason (D28).
- **What cp0x's proxy must forward (the contract with cp0x-api):** `zeroex` → `https://api.0x.org`, only `GET
  /swap/permit2/price` and `GET /swap/permit2/quote`, query keys `chainId, sellToken, buyToken, sellAmount,
  slippageBps, taker, recipient, excludedSources` (the module sends no others; this app sets no excluded sources),
  request headers `accept`, `0x-version`, the client's `0x-api-key` replaced by `ZEROEX_API_KEY`; `across` →
  `https://api.across.to`, only `POST /v1/quotes` with a JSON body (`accept`, `content-type`), the client's
  `authorization` replaced by `Bearer ACROSS_API_KEY`. Both answer with `x-swap-web-answer`, follow no redirects, and
  allow `0x-api-key`, `0x-version` and `authorization` in their CORS preflight. `/health` reports `zeroex` and
  `across` as "keyed" only with their key set. Until the owner sets the keys, nothing changes in prod.
- Contract changes: `ProviderName` + `"zeroex" | "across"`, `ProxyVenue` + the same; config exports
  `standardProxyOnly`, `ProxyOnlyVenue`; swap exports `PROXY_KEY_PLACEHOLDER`, `zeroExSettlers`, `PERMIT2_VENUES`;
  `ProviderExtras` + `zeroex`, `across`; execute's `VenueRule` (pins) + `permit2?`, `ArmedWrite` + `{kind:
  "permit2"}` and the call's `permit2Signed`, `matches(…, permitSignature?)`, `permit2Problem`, the gate's
  `recordSignature`; screens' `walletSteps`; activity's `ExecStage` + `"permit"`, `SwapRecord.permit`, `SwapStep.key`
  + `"permit"`.

**D39 — Imported tokens (owner, 2026-11-15).** "A user can paste a token's address when it isn't in the list, and swap
it."
- **Scope (v1).** EVM networks (all 31) and Solana. A pasted TON, Tron, NEAR, Bitcoin or Zcash address says it can't be
  imported yet (`detectTokenAddress` → "unsupported"). What an EVM contract or a Solana mint is, swap2-assets'
  `isTokenAddress` decides — the engine's own test for an unlisted token; a 32-byte base58 key reads as Solana before
  any shape test (a short one starting with 1 or 3 also has a Bitcoin address's shape).
- **Where it is looked up (revised 2026-11-16, owner: "не проверяется на каких сетях есть токен").** In the token
  sheet, when the search text is a token address: an EVM contract is read on every importable EVM network at once
  whose list doesn't already have a token at it (`importCandidates`; `tokenAt` — a listed one, or one imported
  already, just shows as itself) — `CatalogPort.useTokenLookups`, each the very read `useTokenLookup` makes there
  (one react-query cache: the chosen network's result and its confirmation read nothing again), so one `eth_getCode`
  per network and decimals() / symbol() / name() only where there is code: ~31 RPC requests per pasted contract, through
  Standard's proxy RPC like any read. `importNetworks` tallies them (found, still reading, unreachable); the result
  shows (`shownImportNetwork`) the viewer's pick while the token is there, else the preferred network — the one the
  sheet is filtered to, with "All networks" the other side's, else this side's, else Ethereum (`lookupNetwork`) —
  while its read goes or once it has the token (no jump to whichever answers first), else the first network found, in
  catalog order. Its chooser lists only the networks it was found on, with their logos (NetworkPicker's `chip`, a line
  "Checking N more networks…" while others read; a plain chip when there is one network and nothing left to read).
  Found nowhere: "No token at this address on any EVM network here."; with networks that couldn't be reached, "Not
  found on the networks that answered — N networks couldn't be reached." and "Try again" (`retry()` asks those again);
  nothing at all when the list has it on some network (its row is the answer). A mint is read on Solana. A pasted TON, Tron or NEAR address of a listed token (TON USDT's master) is just that
  token's row, without the "can't be imported" line (`showsAddress`).
- **What is read, and from where.** On-chain only — never a token list, a third-party API or a venue's word
  (`readTokenForImport`, `src/catalog/imported.ts`); the price and the logo shown beside it are looked up by the
  contract afterwards (below), never feed the read. EVM: the contract checksummed first (a pasted one may carry a
  wrong checksum or none, and viem refuses to call a mis-checksummed address), `eth_getCode` (code, not an EIP-7702
  delegation), then `decimals()` (required, 0..36), `symbol()` and `name()` (ABI string or legacy bytes32) over the
  catalog's public client — the runtime RPCs, so Standard's proxy RPC first (D30: cp0x sees that read like any RPC call
  it carries). A read no node answered — down, offline, timed out, or turned away (a rate limit even with HTTP 200:
  JSON-RPC -32005 / -32002, or 429) — is "try again", never "not a token", and a `symbol()` / `name()` lost that way is
  never kept as "UNKNOWN"; only one the contract lacks is. Solana: one `getMultipleAccounts` over the runtime Solana
  RPCs for the mint (owner SPL Token or Token-2022, initialized, decimals ≤ 36 — held to spl-token-2022's unpacking: no
  account of a multisig's 355 bytes, zero padding before the AccountType byte, so a multisig's freely chosen signer keys
  never pass for a mint) and its Metaplex metadata PDA; the name and symbol from Token-2022's metadata extension (TLV 19,
  for that mint), else Metaplex, else "UNKNOWN". Every text is cleaned (`cleanTokenText`): control, format (bidi
  overrides, zero-width), private-use and other default-ignorable characters (Hangul fillers) and the symbols drawn
  blank (U+2800, U+1D159) stripped, stacks of combining marks cut to two, whitespace collapsed, a symbol ≤ 20 and a name
  ≤ 48 characters; missing, or nothing visible left → "UNKNOWN". react-query `["token-meta", caip2, address]` with the
  address checksummed on EVM (`canonicalTokenAddress`: the search result, its confirmation and a link share one read),
  10 min; a network failure is asked again once, the chain's own answer never. Once a wallet of its family is connected its balance is read like the catalog's, in a read of its own per
  network (`["bal", slug, owner, "imported", …keys]`, still under the tracker's `["bal"]`); an imported Token-2022
  mint's associated account derives under Token-2022 (`token2022`).
- **The confirmation** (`ImportToken.tsx`, inside the token sheet; a pair link opens it alone): monogram, symbol,
  name, network and decimals, the full address (monospace, copyable) with its explorer page, the warning verbatim —
  "Anyone can create a token with any name — including fake copies of real tokens. Check this address against the
  project's official sources. Swapping an unknown token can lose its value." — and, when its symbol or name reads as a
  listed token's symbol on the same network (`lookalikeOf` / `readsAs`: NFKD with combining marks stripped; Cyrillic,
  Greek, Armenian, Lisu, Cherokee and small-capital look-alikes folded by their own shape before case — Greek Η reads
  H, η reads n —, 0 / o and 1 / l / i / | folded; then everything but a–z and 0–9 dropped: spaces, dots, blank glyphs,
  ticks), an amber "Not the listed {SYMBOL} — that one's address is {short}" ("… that one is {Chain}'s own coin" for a
  native). "Import" stays disabled until "I understand" is checked.
- **Kept in this browser only.** `localStorage cp0x.swap.tokens.v1` (D16): `{chain, contract, symbol, name, decimals,
  token2022?}` per token, newest first, at most 50 (the oldest go), every read held to the rules again — an importable
  network, a token address there that isn't a catalog token, whole decimals in 0..36, texts cleaned again, duplicates
  dropped; every access guarded; another tab's change arrives through the `storage` event. On an IPFS path gateway — one
  origin for every site on it (D8) — imports live in memory only, so no other site there can plant one that skipped
  the warning. Key `<slug>:<contract>`: lowercased on EVM like the catalog's, verbatim on Solana (a lowercased mint is
  another address, and a shared link must still name it). Listed in the sheet after the catalog's tokens, with an
  "Imported" badge, its name and a remove button.
- **Priced and pictured by its contract, never by its symbol (revised 2026-11-16, owner: "не показываются картинки и
  не показывается цена").** Price: DefiLlama `prices/current/<llamaChain>:<contract>` (`fetchImportedPrices`,
  `src/catalog/prices.ts`; the runtime `prices.defillama` host like the catalog's), one GET for every import,
  react-query `["imported-prices", …keys]`, 60 s; `LLAMA_CHAINS` maps each importable network to DefiLlama's chain
  key (avalanche → avax, zksync → era, hyperevm → hyperliquid, gnosis → xdai, worldchain → wc, plume →
  plume_mainnet; checked against each network's listed stablecoin); a price under confidence 0.9 is left out; no
  CoinGecko fallback (its contract endpoint is per network and keyless allows ~5 calls). `tokenPrice(t, prices,
  importedPrices)` reads an import by its token key only, so a copy named "USDC" gets its own price or none — never
  USDC's. Logo: `fetchTokenLogo` (`src/catalog/importedLogo.ts`) asks DefiLlama's token icons by chain id
  (`token-icons.llamao.fi`, EVM), then Trust Wallet's assets repository (`raw.githubusercontent.com/trustwallet/assets`,
  the EVM networks it has and Solana), by the checksummed contract or the mint; never a deployer-chosen URL (Metaplex
  `uri`, a token list) and never by symbol. The bytes are fetched without credentials or a referrer, kept only if a
  raster type (png, webp, jpeg, gif, avif — no SVG) of ≤ 256 KB, and shown as a `data:` URL (`Token.logo`, never
  stored), so the CSP's `img-src 'self' data: blob:` is unchanged on every build; `AssetIcon` takes only a
  `data:image/` logo for an import and still never turns its symbol into a bundled logo; one read per token for the
  session (`["token-logo", key]`, retried once when no source could be reached). Without either, as before: "Imported
  token · no price" on the amount cards, the monogram. What it costs: DefiLlama, and for the logo Trust Wallet's
  GitHub host, see which contracts this browser imported (the price API already sees the page's IP). The router
  still ranks such a pair on raw output (its `usdValue` reads catalog assets only — every route delivers the same
  token, so only the gas term is lost); fees and gas stay in the native coin's USD. Auto slippage reads it as
  long-tail (0.3%, D37). The opening pair never picks an imported token the link didn't name.
- **Marked wherever it shows.** The token chip's label reads "{SYMBOL} (imported) on {network}" (as the sheet's row
  does). A swap record keeps an imported side's contract (`fromImportedContract` / `toImportedContract`, set by
  `recordSide`): the activity row carries an amber "Imported" tag ("(imported)" in its label) and the status view tags
  that side's amount with its contract under it — a swap into a copy named USDC never reads like one into the listed
  USDC afterwards.
- **Links (D22).** A pair link's key naming an unlisted EVM contract or Solana mint not imported in this browser
  (`linkedToken`) opens that side empty ("Select a token") with the token sheet on that address's confirmation, the
  warning included: confirmed, the side is the token; cancelled, it stays empty; an address that can't be read is
  ignored (the default fills the side). A key imported here already, a listed EVM key in another case or a listed
  Solana mint as written is that token. One side per link (the pay side first).
- **Engine.** A quote names an imported source by its contract with `sourceDecimals` (`sourceParams`, swap2-core
  0.14.0) and an imported destination by its contract (as any). Execution passes `fromToken` = the contract with
  `fromTokenDecimals`, `toTokenDecimals` for an imported destination (a bridge leg's reviewed minimum,
  `bridgeOut.destDecimals`), and `allowUnlistedTokens: true` for that execution only (`engineConfig({unlisted})`) — a
  catalog pair runs with the config it always had, its tokens named by catalog symbol. The engine reads the source's
  decimals again through the account (`getTokenInfo`, one of the gated account's reads) and refuses a mismatch ("This
  token's decimals on-chain don't match the ones read when it was imported — nothing was signed."); `assertCoherent`
  holds an import to a token address the catalog doesn't list, the very contract the review showed.
- **Which venues take one** (dry quotes 2026-11-15 for DEGEN on Base, PEPE on Ethereum and BONK on Solana, a scratch
  probe over the installed packages, nothing signed): on one network Uniswap, LI.FI, Fynd and 0x quoted, while Curve and
  Balancer were asked and found no pinned pool; between networks LI.FI (EVM and Solana, either side) and Relay into one
  (out of one it refuses: its deposit would first swap through a router it doesn't sign for — "Doesn't take this token
  as a source"); within Solana Jupiter and LI.FI. USDT0, CCTP, THORChain, Chainflip, NEAR Intents, Symbiosis, Omniston
  and Across resolve both sides in their own lists, so their supportsRoute is false and "Not for this pair" reads
  "Listed tokens only" (`LISTED_ONLY_VENUES`, providerMeta) — where the venue covers the networks; where it doesn't, its
  usual network line stands (Omniston on Solana "Doesn't cover these networks", a bridge within one network "Between
  networks only"), read with the import's symbol ignored (a copy named USDC isn't USDC to CCTP). Fee-on-transfer tokens: the SDK's own refusals stand (0x
  refuses a token being bought that taxes transfers: "Doesn't take a token that taxes transfers"); a taxed sale fails
  the engine's simulation before anything is signed.
- **Review and gate.** The review shows an amber "Imported token: {SYMBOL}" note with the full contract for each
  imported side (stepping aside once confirmed, D37). The in-page gate is unchanged in strength: approvals exact to
  `reviewed.fromContract` and the reviewed spender, call targets pinned per venue, Permit2 held to the reviewed token
  and input — every check keyed on contracts, none on a catalog symbol (`checkPlan`, `checkPlanBrowser`,
  `permit2Problem`). The one symbol-keyed check before it, `assertCoherent`'s catalog lookup, has its own branch for an
  import (above); Tron, TON and NEAR, whose rules read the catalog, aren't importable.
- Contract changes: domain `Token` + `imported?`, `name?`, `token2022?`, and `TokenAddress`, `TokenLookup` (its failure
  + `unreachable?`, 2026-11-16); `CatalogPort` + `useTokenLookup`, `useTokenLookups` (+ `TokenLookups`, 2026-11-16),
  `importToken`, `removeImportedToken` (demo: in memory); `CatalogModule` +
  `detectTokenAddress`, `importable`, `importKey`, `listedToken`, `parseTokenKey`, `canonicalTokenAddress`, `lookalikeOf`;
  ui `AssetIconProps.token`, `TokenIconProps.token` and `TokenChipToken` + `imported?`; swap exports `sourceParams`,
  `LISTED_ONLY_VENUES`, `ScopeSide.imported`; execute's `engineConfig` + `unlisted`; catalog `ataOf(owner, mint,
  token2022?)`, `solRpc`, `BalanceSpec.imported`, `balanceSpecs(…, imported)`; activity `SwapRecord` +
  `fromImportedContract?` / `toImportedContract?`, `RecordSide.importedContract?`, `ActivityModule.recordSide`.

---

**D40 — Stargate (owner, 2026-11-17).** Stargate V2 Taxi is a venue in every mode, on by default: the SDK's new
`protocol-swap2-stargate` (0.1.0), keyless, quoted from its pinned pools over the page's RPCs, checked and tracked on
this device (providers §4.20). Its LayerZero fee is priced into the route row and may reach 0.5 AVAX / 40 POL from
Avalanche / Polygon, where the engine's cap is below or at it.

**D41 — Swap reports in Standard mode (owner, 2026-11-17; widens D36).** The owner asked to see, per swap, which
asset went to which, between which networks, how much was sent, what was expected and what actually arrived — in a
swaps chat as each swap goes, and in the daily summary — plus the routes the SDK's check refused and the declines in
the wallet. Amounts are kept to 3 significant figures (the owner's choice: volume and fill quality without amounts
precise enough to find the transaction); no address, hash, time or free text is sent. The server half is cp0x-api's
`POST /sent`, `/done` and `/refused` (its `docs/swap-web-proxy.md` §8): a Turso database of its own, the swaps chat,
the summary.
- **`/sent`** replaces D36's body for a record counted from now on: the store's write that counts the swap (`counted`)
  also draws its report id (`statsId`, 16 random bytes; not the swap's id, not the wallet's) and the report carries
  it with the venue, networks, mode, the two symbols (`reportSymbol`), `amountIn` / `expectedOut` / `minOut`
  (`roundUnits`: base units to 3 significant figures, half up; `minOut` is the record's execution floor), the
  amount's value in USD by the page's prices at the review (`usdIn`, kept on the record by the runner and
  `issueDeposit`; absent for an unpriced token) and the slippage. A record counted before has no id and keeps D36's
  body. When it is sent is D36's rule, unchanged.
- **`/done`**: the store notes the write that makes a counted swap with an id stuck (the tracker's `stuckReported`)
  or final (`noteOutcome`, flag `reported`, once per kind, same tab rule as `counted`) and hands it to
  `reportOutcome`, which posts the outcome — `done` (completed or partial), `refunded`, else `failed`; `stuck` — and its
  duration. For a delivered swap it first reads what actually arrived from the delivery transaction (`received.ts`:
  the record's claim or destination hash — for a swap on one network the swap itself; EVM: the token's Transfer logs
  to the recipient, or for the native coin the balance change at that block plus the gas when the recipient sent it;
  Solana: token balances before/after, or lamports plus the fee; Tron: TRC-20 Transfer logs; other networks not read)
  and sends it rounded, with `diffBps` (against `expectedOut`) and `belowMin` (under `minOut`) worked out here from
  the exact amounts. Unreadable: the outcome alone.
- **`/refused`**: the runner reports a failure `refusalReport` classifies — the person declining in the wallet
  (`wallet`), or a check refusing before signing (`gate`: a write the plan didn't arm `unarmed_write`, a review
  mismatch as `review:<its words as a slug, no hex or numbers>`, the account's fee cap `fee_cap`, an SDK safety reason
  from `GATE_REASONS`). A quote round's safety refusal (a router the venue's pins don't know, a vault that can't be
  verified) is reported once per page (`once`); previews never.
- **Only Standard, fire-and-forget**: D36's rules — a Standard page with a plan, never Public, Custom, demo or a build
  without the API; simple `text/plain` POSTs to the plan's base with `keepalive`, no credentials, no referrer, 5 s; the
  answer is never read. guard-dist's one-origin rule stands (URLs are built from the plan's base).
- **Tests.** `tests/unit/activity/reports.test.ts` (rounding, the report, the id drawn once and carried, outcomes once
  per kind, the outcome's figures, refusal classes and the once-per-page rule), `received.test.ts` (each network's
  reading), `counter.test.ts` (D36's timing and dedupe, now with the richer body), e2e `standard.spec.ts` (one `/sent`
  with exactly the report's keys, no recipient, ≤ 3 significant figures; none in Public).

## 5. Conventions

- **TypeScript**: strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (use `import type`). Named exports
  only. Small modules. Each exported thing gets a short doc comment saying **why**; no filler comments. No `any`
  (if unavoidable, a comment saying why). Amounts are `bigint` in memory, decimal strings in storage and URLs.
- **Contracts**: shared types come from `src/contracts` (or a module's `index.ts`), never from another module's
  internal file. A module's `index.ts` must satisfy its interface in `src/contracts/modules.ts`;
  `src/contracts/conformance.ts` fails the typecheck when it does not. Never import `conformance.ts`.
- **Effects**: screens never fetch, read storage or touch a wallet; they call ports.
- **Hooks**: `eslint-plugin-react-hooks` 7 runs its recommended rules, including `set-state-in-effect`. A verbatim
  port of mobile `useRoutes` trips it: set state from timer / promise callbacks instead (see `useDemoRoutes` in
  `src/mocks/demoPorts.ts`); do not disable the rule.
- **Runtime config**: read with `getRuntimeConfig()`; never hard-code an RPC or API base that the config holds.
- **Errors**: user-facing texts are full English sentences; `answered: true` on definitive refusals (D25).
- **Test ids**: mobile `testID`s as `data-testid` (`swap-amount`, `swap-max`, `swap-flip`, `swap-route-<p>`,
  `swap-review`, `swap-confirm`, `swap-steps`, `swap-step-<key>-<state>`, `swap-token-<key>`, `swap-net-<slug>`, …).
- **Accessibility**: the route list is a `radiogroup` (↑/↓ select, Enter = CTA); sheets are `role="dialog"
  aria-modal`; icon-only buttons carry `aria-label`; reduced motion stops skeleton/spinner animation.
- **Copy**: English, the wallet's wording; addresses, review values and errors selectable.
- **CSS**: D23. camelCase class names in CSS Modules; tokens by variable name (`var(--surface1)`), never raw hex
  outside `src/theme/` (the QR's `#06131a`/`#fff` excepted).

---

## 6. Contracts reference

| file | holds |
|---|---|
| `src/contracts/domain.ts` | `ChainFamily`, `ChainInfo` (re-exported from shared), `ExtraFamily`, `Family`, `Chain`, `Token` (+ `imported`, `name`, `token2022`, D39), `TokenAddress`, `TokenLookup`, `BalanceState`, `Balance`, `PayMode`, `SwapToken`, `PriceMap`, `Owners`, `Pair`, `RecipientCheck`, `SwapRecipient`, `PickerNetwork` |
| `src/contracts/routes.ts` | `RouteTag`, `RouteFee`, `RouteView` (mobile verbatim), `Execution`, `VenueTrust`, `WebRoute`, `PaySide`, `RefusalCategory`, `RouteRejection` (short line, category, detail, raw), `RouteMode`, `RouteSnapshot` (+ `mode`, `venues`), `QuoteRequest` (explicit addresses, D7), `PreviewRequest` (D7), `RoutesRequest`, `RoutesState` (+ `limitedUntil`, D29), `RequoteState` |
| `src/contracts/execution.ts` | `ReviewedSwap` (mobile verbatim), `SwapDraft`, `ExecutionPhase`, `ExecutionPhaseDetail`, `EvmTransport`, `EvmSourceSigner`, `SolanaSourceSigner`, `TronWebLike`, `TronSourceSigner`, `TonConnectRequest`, `TonSender`, `TonSourceSigner`, `NearInjectedWallet`, `NearSourceSigner`, `SourceSigner`, `ExecuteResult`, `StartSwapInput`, `IssueDepositInput`, `DepositTicket`, `ClaimPreview`, `ClaimResult` |
| `src/contracts/activity.ts` | `SwapStatus`, `ExecStage`, `SwapRecord` (mobile + `mode`/`deposit`/`heartbeatAt`/`counted`, D39 `fromImportedContract`/`toImportedContract`), `RecordSide` (+ `importedContract`, D39), `NewRecordInput`, `StatusView`, `StepState`, `SwapStep`, `ActivityUrgency`, `ActivityItem`, `ActivityState` |
| `src/contracts/wallets.ts` | `WalletFamily` (+ `"tron"`, `"ton"`, `"near"`), `WalletOption` (+ kind `"tonconnect"`: the TON Connect UI entry), `EvmConnection`, `SolanaConnection`, `TronConnection`, `TonConnection`, `NearConnection`, `WalletConnection`, `WalletsState` (incl. `owners`, `pairingUri`), `WalletsApi`, `ConnectOptionGroups` |
| `src/contracts/config.ts` | `ProviderName`, `RuntimeConfig`, `RuntimeConfigInput`, `SavedOverrides`, `ConnectionMode`, `ProxyVenue`, `VenueKeys`, `CustomEndpoints`, `ConnectionSettings`, `ConnectionStatus` (D30) |
| `src/contracts/ui.ts` | props of every ui primitive, `TextVariant`, `IconName`, `Breakpoint`, `ReviewRow`, `Tile`, `Fact` |
| `src/contracts/ports.ts` | `CatalogPort`, `WalletsPort`, `SwapPort`, `ExecutePort`, `ActivityPort`, `AppPorts`, `BalancesState`, `SwapTokensState` |
| `src/contracts/modules.ts` | the full export list of each module's `index.ts` (`CatalogModule`, `WalletsModule`, `SwapModule`, `ExecuteModule`, `ActivityModule`, `UiModule`, `ScreensModule`) |
| `src/contracts/conformance.ts` | `import * as m from "../m"; m satisfies MModule` for every module (typecheck only) |

Ports (effectful):

```ts
catalog.useChains(): readonly Chain[]            catalog.useTokens(): readonly Token[]
catalog.useBalances(owners): BalancesState       catalog.usePrices(): PriceMap
catalog.useSwapTokens(owners): SwapTokensState   catalog.useIsContract(caip2, address | null): boolean | null
catalog.useTokenLookup(caip2 | null, address | null): TokenLookup             (D39: an import's on-chain read)
catalog.importToken(token): void                 catalog.removeImportedToken(key): void
wallets.Provider                                 wallets.useWallets(): WalletsApi          wallets.getSigner(caip2): Promise<SourceSigner>
swap.useRoutes(r: RoutesRequest | null, prices): RoutesState & {refresh}
swap.useRequote(draft | null, prices): RequoteState & {refetch}
execute.startSwap(input): Promise<recordId>      execute.issueDeposit(input): Promise<DepositTicket>
execute.previewClaim(id): Promise<ClaimPreview | null>       execute.claimSwap(id, signer): Promise<ClaimResult>
activity.useActivity(): ActivityState            activity.useSwap(id | null): SwapRecord | undefined
activity.useSwapTracker(): void                  activity.pollSwap(id): Promise<SwapRecord | undefined>
```

Pure / cross-module exports are listed name by name in `modules.ts` — swap: `quoteParams`, `quoteRoutes`,
`requoteRoute`, `swapStatus`, `canPreview`, `appProviders`, `appRouter`, `DEFAULT_ON_PROVIDERS`, `STANDARD_ONLY_PROVIDERS`, `PROVIDER_NAMES`,
`providerName`, `TWO_PHASE`, `VENUE_TRUST`, `orderSpender`, `venueScope`, `REFRESH_MS`, `routesKey`, `orderRoutes`, `keepSelection`,
`isStale`, `friendlyReason`, `classifyRefusal`, `sanitizeAmountInput`, `parseUnits`, `formatUnits`, `fieldText`, `formatFee`, `usdOf`,
`autoSlippageBps`, `slippageLabel`, `executionFloor`, `impliedSlippagePct`, `rate`, `formatRate`, `etaLabel`,
`gasReserve`, `maxSwappable`, `balanceProblem`, `swapRecipient`; execute: `swapErrorText`, `swapFailureExpected`,
`maybeSent`, `encodeSwapId`, `decodeSwapId`, `swapFeeCap`, `uncappedFeeText`, `FEE_CEILING`; activity:
`statusView`, `swapSteps`, `isFinal`, `isLocalId`, `findSwap`, `newRecord`, `recordSide`, `visibleSwaps`, `STUCK_MS` and the
store functions the runner writes through (`loadSwaps`, `getSwaps`, `saveSwap`, `replaceSwap`, `updateSwap`,
`setRunning`); catalog: `CHAIN_LIST`, `chainByCaip2Web`, `chainBySlugWeb`, `SIGNING_FAMILIES`, `QR_FALLBACK_FAMILIES`, `TOKENS`,
`TOKEN_BY_KEY`, `ZERO_ADDRESS`, `tokenKey`, `destTokenId`, `matchesToken`, `PINNED_NETWORKS`, `pickerNetworks`,
`pickSide`, `flipPair`, `defaultPair`, `checkRecipient`, `isAddressFor`, `shortAddress`, `isContractAddress`,
`txUrl`, `addressUrl`, `formatUsd`, `formatAmount`, `unitsToDecimal`, `VIEM_CHAINS`, `publicClient`,
`evmRpcUrls`, and for imports (D39) `detectTokenAddress`, `importable`, `importKey`, `listedToken`, `parseTokenKey`,
`canonicalTokenAddress`, `lookalikeOf`; wallets: `familyOfCaip2`, `useConnectOptions`, `connectOptionGroups`, `WALLETCONNECT_ID`; ui: every
primitive + `useBreakpoint`; screens: `SwapScreen`, `Routes`.

Config (`src/config/index.ts`): `getRuntimeConfig`, `loadRuntimeConfig`, `isDemo`, `demoWallets`,
`parseRuntimeConfig`, `DEFAULT_RUNTIME_CONFIG`, `parseHash`/`formatHash`/`setHashQuery`/`useHashRoute`,
`appActive`, `createTokenBucket` (D29), `PortsProvider`/`usePorts`, `USER_SETTINGS_KEY`/`readUserSettings`/`writeUserSettings`;
D30: `CP0X_API`, `apiOrigin`, `connectionModes`, `defaultConnectionMode`, `readConnection`/`writeConnection`,
`readVenueKeys`/`writeVenueKeys`, `parseCustom`, `customRpcProblem`, `venueKeyProblem`, `customOverlay`,
`standardSlots`, `pageConnection`, `venueKeys`, `isProxyUrl`, `startConnection`, `standardFetch`,
`connectionStatus`/`useConnectionStatus`, `createStandardRuntime`, `createProxyFetch`, `healthRoutes`,
`parseHealth`, `proxyTarget`, `nextUtcMidnight`. Mocks (`src/mocks/index.ts`): `DEMO_*` fixtures, `demoSwapTokens`,
`demoSnapshot`, `demoActivity`, `demoPorts` and each `demo*Port`, `resetDemoState`.

A contract change (adding, removing or retyping an export, a port method or a shared type) goes through the
orchestrator; say so in your result.

---

## 7. Acceptance criteria per module

Common to all: `pnpm exec tsc -p tsconfig.app.json --noEmit` clean for your files, `pnpm lint` clean for your
files, conformance green, your tests pass (report exact counts), no new dependency, demo mode unaffected.

### ui-kit
- `src/theme/tokens.css` (every variable of the stub, same names), `fonts.css` (one family `Cp0xGrotesk`,
  400/500/600/700, `font-display: swap`), `base.css` (reset, `:focus-visible` ring in accent, reduced motion);
  loaded from `src/ui/index.ts`.
- Every `UiModule` export with the props of `src/contracts/ui.ts` and the numbers of ui-port §1.4, §2.2-2.10, as
  CSS Modules.
- `Sheet`: Radix Dialog ≥ 640 (focus trap, Esc, backdrop, `aria-modal`, `width`, `placement="drawer"` anchored right),
  vaul < 640 (bottom sheet, grabber, drag to close, `phoneHeight` presets); `locked` blocks every close path; focus
  goes back to its opener on close, then `onClosed` (a sheet opened from another waits for it, D33).
- `Icon`: all 30 mobile icon paths, stroke 2.6 / 3.0 at ≤ 12 px. `QrCode`: `uqr` SVG, `#06131a` on `#fff`, 12 px quiet
  zone, `expired` blur. `useBreakpoint` via `matchMedia` (640 / 1024).
- Assets per D13 in `public/logos/**` and `public/fonts/**` (+ `OFL.txt`, `public/logos/LICENSES.md`); `AssetIcon` /
  `TokenIcon` / `ProviderLogo` resolve local files only, monogram fallback; everything loads when `dist/` is served from a
  sub-path. Ask the integrator for the font `<link rel="preload">` tags in `index.html`.
- Tests (`tests/unit/ui`): Button disabled/loading, Switch `role`/`aria-checked`, Sheet Esc/backdrop/locked, AssetIcon
  fallback order, QrCode renders an SVG, useBreakpoint on resize.

### catalog
- `src/shared` stays verbatim (+ World Chain patch); port `chains.test.ts` / `format.test.ts` to `tests/unit/catalog`.
- `network.ts` (37 chains, extras behind `VITE_EXTRA_CHAINS`), `evm.ts` (`VIEM_CHAINS` for all 31 EVM chains incl.
  99901, Multicall3 per slug, `publicClient(chainId)` = fallback transport over `config.evmRpc`, `evmRpcUrls`),
  `tokens.ts` (`TOKENS`, `TOKEN_BY_KEY`, `swapTokens`, `payModeOf`, `destTokenId`, mobile pair helpers), `address.ts`
  (`detectAddressFamily`, `shortAddress`, `isAddressFor`, `checkRecipient`, TON raw/friendly), `prices.ts` (D6),
  `balances/{evm,solana,index}.ts` (catalog.md §5: one multicall per chain; Solana ATAs ≤ 10 per call; a failed read
  is `state: "error"`, never 0), `isContractAddress`, `txUrl`/`addressUrl`.
- `catalogPort`: react-query keys `["bal", slug, owner]` (staleTime 30 s, retry 1) and `["prices"]` (60 s);
  `usePrices` returns one stable object per change; `useSwapTokens` sorts held first.
- Tests: every `CC_SOURCE_CHAINS` caip2 maps to a chain or an extra; unique keys; Celo/Arc `gasToken`; `destTokenId`;
  pair helpers (mobile cases); `PRICE_IDS` covers every catalog symbol except Sei `fastUSD`; price fallback with a
  mocked `fetch`; balances with mocked clients. A `LIVE=1` test is optional.

### swap
- `providers.ts` = providers.md §6.2 over `getRuntimeConfig()` (flags; fynd only with Standard's slot), `providerWrappers.ts`,
  `providerMeta.ts` (D17, with the Omniston equality test), `stores.ts` (D16), `omnistonLazy.ts` + `omniston.ts`
  (separate chunk, loaded only while the flag is on, the default — check the build output).
- `engine.ts`: `appProviders`/`appRouter` singletons, `pagehide` close only (D2); `quoteRoutes` (generation guard, a
  first update with every asked venue pending, a priced router per round with `ROUTER_RANKING` + gas, `asked` per
  D17), `requoteRoute` via `only()`, `swapStatus`, `quoteParams` from explicit addresses (D7).
- `routes.ts` verbatim with the refusal texts moved to `refusals.ts` (D28), `webRoute.ts` (`execution`, `hasMemo`, `trust`), `venues.ts`,
  `gas.ts`, `math.ts`, `amount.ts`, `recipient.ts` (owner may be null) — with their mobile tests.
- `swapPort.useRoutes`: mobile semantics (400 ms debounce, 30 s refresh while visible, a refresh keeps the old list,
  stale answers dropped), key = mode + both addresses; preview rounds paced per D29. `useRequote` per D19.
- Tests: provider construction per flag set; `narrowRoute`/`isWrapPair`; `paced` with fake timers; the engine with
  in-process fake providers (asked, pending, superseded round); stores with `fake-indexeddb` (fail-closed when open
  fails).

### wallets
- wagmi config per D11 (no `dataSuffix`, WalletConnect only with a projectId, `showQrModal: false`, `pairingUri`),
  Wallet Standard discovery / connect / disconnect / events per D11, silent reconnect.
- `walletsPort.useWallets()` → `WalletsApi` (`owners`, options installed first, `connecting`, `error` in the user's
  words; `connect` never throws); `getSigner(caip2)` → `EvmSourceSigner` (switched chain, wallet client, catalog
  public client, rpcUrls, transport) or `SolanaSourceSigner` (wallet, account, `config.solanaRpc`); not connected /
  refused switch → `answered` Error with the D11 texts. No write call anywhere in `src/wallets` (ESLint).
- Tests: `familyOfCaip2`; option filtering with fake Wallet Standard wallets (no `solana:signTransaction` or no v0 →
  hidden); `getSigner` errors; the wagmi config has no `dataSuffix` and hides WalletConnect without a projectId.

### execute (+ activity)
- execute: `gate.ts` (engine.md §7.3: port + `createSwapGate` + `checkPlanBrowser` + `SwapGateRefusal` /
  `SwapReviewMismatch`), `accounts/evm.ts`, `accounts/solana.ts`, `accounts/gated.ts` (`gateAccount`), `execute.ts`
  (engine.md §8.2 + D10), `runner.ts` (`startSwap` = mobile runner semantics, no `recordSent`), `deposit.ts` (D20),
  `claim.ts` (§8.3; the record gets `claimHash`/`trackId`), `ids.ts`, `errors.ts` (D25),
  `swapFeeCap`/`uncappedFeeText`/`FEE_CEILING`, optional `pins.ts`.
- activity: `inflight.ts` (mobile port + deposit mode + web strings), `store.ts` (D16), `tracker.ts` (leader tab, 5 s
  tick, visibilitychange, invalidate `["bal"]` on settle), `activityPort` (`useActivity` ranking action → failed →
  pending → done, done visible 8 s; `useSwap` follows a local id after the rename; `pollSwap`), `counter.ts` (D36: one
  count per swap sent, Standard only).
- Tests: ported `gate.test.ts`; `flow.test.ts` with the real `RouterSwap2Protocol` over an in-process provider and a
  fake EVM account behind `gateAccount` (happy path; another spender → mismatch, no sends; an extra write → refusal;
  identical vs changed re-quote; reject the swap → revoke; reject the approve → no revoke; insufficient gas → no
  sends); the Solana signer with a throwaway key (verifies; mutated message refused; outside the window refused); ids
  round trip; `swapErrorText` order; never `accountChain`; inflight ported tests + deposit additions; the store with
  `fake-indexeddb` + the heartbeat rule.
- Never sign or broadcast a real transaction in a test.

### screens
- The ui-port §5 tree: AppShell (wordmark, the connected wallets' dropdown (D33), ActivityButton, WalletMenu with the
  WalletConnect QR, DEMO tag in demo),
  SwapForm (AmountCard ×2, TokenButton, MaxChip, FlipButton, RefundField, RecipientField, SummaryCard, CtaBar),
  RoutesPanel / RouteList / RouteRow (route | pending | refused) / RouteSheet, TokenSheet (virtualized, rail + search),
  ReviewSheet (review → steps → status, locked while executing), DepositPanel (D20), ActivityDrawer, StatusView
  (claim confirm).
- Effects only via `usePorts()`; the CTA state machine of ui-port §5.4 and D7; the route list states of §5.5; the QR
  rules of D20; layout version B (D23); hash params (D22) restore pair and amount; mobile `data-testid`s; copy per
  ui-port §4.12.
- Tests (`tests/unit/screens`) inside `<PortsProvider ports={demoPorts}>`: CTA states (no amount, no wallet, missing
  address, deposit payer, ready), route list states (idle hint, pending rows, refused group), the review shows the floor
  as "Minimum received", the deposit panel's expired state.

### dist
- `Dockerfile` + `docker/**` (static nginx with the CSP and security headers of D24, a mountable `runtime-config.json`),
  `bin/**` (an `npx`-style static server for `dist/`), `vercel.json` (same headers), `.github/**` (CI: frozen install,
  typecheck, lint, unit, build, e2e; a grep guard that wallet write calls appear only under `src/execute/accounts/`),
  `README.md` (what it is, self-hosting, runtime config, privacy model, demo mode), `CONTRIBUTING.md`,
  `THIRD_PARTY_NOTICES.md` (AWK, web3icons MIT, Zcash CC0, Cp0xGrotesk OFL, venue marks),
  `public/runtime-config.example.json` (every key with its default), `.dockerignore`.
- `dist/` works from `/` and from a sub-path; a mounted `runtime-config.json` is picked up; the CSP blocks nothing the
  MVP calls (providers.md §2.4 + config RPC hosts + price APIs).

### integrator (contracts owner)
- Wire each module as it lands (stubs out), keep `conformance.ts` green, write `tests/e2e` (demo screenshots at the three
  widths; boot without page errors; route list, review, deposit and activity flows in demo mode), run the full gate:
  `pnpm lint && pnpm exec tsc -p tsconfig.app.json --noEmit && pnpm exec vitest run && pnpm build && pnpm test:e2e`.

---

## 8. Risks carried from the specs

1. Quote TTL vs human latency: 2-3 wallet prompts; a swap prompt left open past `validUntilMs` can revert or refund —
   show a countdown in the review.
2. EVM fees cannot be enforced (the wallet picks gas); only the engine's balance pre-check and the advisory display
   remain.
3. THORChain depends on two CORS-open nodes; Symbiosis and slow THORChain nodes miss the router's fixed 8 s window.
4. Public RPC ceilings (Uniswap batches, Solana guard ~6-10 calls per swap) and LI.FI's keyless `/quote` quota (about
   75 per 2 h per IP, D28: cooled down after a 429, asked for previews only through cp0x's keyed proxy (D7), but a
   long-open live tab still uses it up): throttle re-quotes per pair (≥ 10 s). Previews add rounds before a wallet;
   D29 paces them, advisory only.
5. WalletConnect expiry is treated as maybe-sent (no retry, no revoke).
6. Solana wallets that alter transactions (Lighthouse-style) are refused by design.
7. The gate is in-page JavaScript: it stops engine/provider mistakes, not a compromised bundle — CSP, a pinned lockfile,
   no third-party scripts.
8. Omniston (on by default since 2026-11-12): the browser is the only HTLC secret holder; EVM→TON was blocked by an
   SDK pin until 0.5.5 (the rev2 TON minter), not re-measured live here. From a TON wallet (D35 part B) a tab closed
   while the wallet's prompt is still open, then signed in the wallet app, leaves no record to poll: the secret stays
   on disk undisclosed and the escrow refunds the payer after its timelocks (no live TON-source escrow signed here yet).
9. Without storage, Relay refuses to sign (fail-closed) and Omniston is unavailable.
10. `suspendedChains` is static config: pausing a 1Click corridor fast means serving a new `runtime-config.json`.
11. Prices from keyless public APIs: a price outage blocks EVM swaps on non-ETH chains (unpriced native → no fee cap).
12. Standard mode (D30): cp0x's proxy sees the quote requests and RPC calls it carries (amounts, addresses, the
    viewer's IP) — Settings says so, and Public / Custom don't send them. Its outage costs at most the 3 s health
    wait at load (then Public) or one failed call per venue (then direct); its per-IP windows and daily budgets are
    advisory like D29, and a spent one sends that venue direct until 00:00 UTC. It never decides what is signed: a
    dishonest answer is refused by the same in-browser checks as a dishonest venue.
13. Omniston's swaps on TON (D35 part C) go only through the DEX contracts pinned in `tonDexPins.ts`, refreshed by
    hand at a release: a DEX that moves its liquidity (a new STON.fi router or pool, DeDust's CPMM v2, which Omniston
    quotes TON → USDT through today) reads as refused until it is re-pinned; the DEXes' admins (STON.fi v2's 7-day code
    upgrade) stay trusted.

---

## 9. Integration notes (2026-11-11)

What the builders and the integrator changed against §1-§7, and what is still open.

**Contract changes made at integration**
- `CatalogPort.useIsContract(caip2, address | null)`: the recipient's contract warning no longer calls
  `catalog.isContractAddress` through react-query inside a screen (react-query key `["is-contract", caip2, address]`,
  5 min, retry 1; demo answers offline).
- `ConnectOptionGroups` moved to `src/contracts/wallets.ts`; `WalletsModule` lists `useConnectOptions`,
  `connectOptionGroups`, `WALLETCONNECT_ID`; `WalletsApi.disconnect` documents the cancel-a-pending-connect rule (D11).
- `ScreensModule.Routes` (what `App` mounts).
- `LoadOptions.userSettings` (tests inject; default reads localStorage) and the saved-settings layer (D8).

**Deviations the builders made on purpose (kept)**
- ui: Button height 48 and Icon 24 by default (the contract's numbers; mobile is 54 / 18); Skeleton bars on
  `surface3` (mobile's `surface2` is invisible on a `surface1` card). ProviderLogo cannot call `providerName()` (ui
  imports contracts only): screens pass `name`.
- catalog: `isAddressFor` / `checkRecipient` verify checksums (bech32/bech32m, base58check for BTC/ZEC/Tron, TON CRC,
  Solana = 32 bytes); a whole-chain EVM multicall failure throws (retried) instead of marking every token unknown;
  NEAR / Zcash explorer links use nearblocks `/txns/` and blockchair `/transaction/` (not probed: both 403 bots).
- screens: an insufficient balance disables the CTA ("Insufficient {SYM} balance", only once the balance loaded); the
  CTA reads "Review via {Provider}" ("Get deposit address" for QR payers); route rows show only the guaranteed
  minimum; a manual slippage setting (Auto default; 0.1 / 0.5 / 1 / 3 %; custom 0.01-50 %); the tablet list sits
  above the summary; the CCTP claim confirm is inline in the status view; demo opens with amount 0.1.
- The Settings sheet (the connection, D30; venues on/off, API bases, THORChain nodes, price APIs, a WalletConnect
  project id) saves overrides for the next load (D8). `RuntimeConfig` has no key fields by design; Custom mode's venue
  keys live apart from it (D30). It also offers "Show prices before a wallet is connected" (D7): a viewer may only
  turn previews off.

**Packaging.** `package.json` has `bin: {"pi-swap-interface": "bin/cli.mjs"}`, `files` (`bin/*.mjs`, `bin/*.d.mts`,
`dist/`, `LICENSE`, `README.md`, `THIRD_PARTY_NOTICES.md`) and `prepack: pnpm build`, but stays `private: true`.
Before publishing for `npx`, decide on the runtime `dependencies`: every library is bundled into `dist/`, yet npm
would still install them all for `npx` (move them to `devDependencies`, or publish a thin package with only
`bin/` + `dist/`).

**Open issues found at integration**
1. NEAR Intents QR deposits: `@anywalletkit/protocol-swap2-near-intents` 0.3.3 (dist unchanged in 0.3.4) clamps a
   live quote's `validUntilMs` to now + 55 s (`QUOTE_TTL_MS`), although it asks 1Click for a 60 min deposit deadline and hides the answer.
   `issueDeposit` passes that through, so the deposit panel's countdown expires after about 55 s while the address
   stays live for up to an hour (a later deposit is still processed, or refunded below the floor). Safe (it errs
   short), but tight for a BTC/ZEC payer. Fix candidates: an SDK field carrying 1Click's own `deadline`, or a
   pinned, tested display window for `near_intents` in `src/execute/deposit.ts`. Demo shows 20:00, so screenshots
   do not show the problem.
2. Without a `runtime-config.json`, servers that answer 404 (nginx, `npx`, Vercel) make Chrome log one
   "Failed to load resource: 404" console line per page load. Harmless; an operator can ship `{}` to silence it.
3. The ui `Gallery` ships as its own lazy chunk at `#/gallery` in production builds (design review; no network).

## 10. Review fixes (2026-11-11)

Contract changes: `ActivityPort.markNotSent(id)` (real + demo), `statusView` reads the record's `id` (an untracked
maybe-sent record reads differently), `SavedOverrides` (`src/contracts/config.ts`) with `savedOverrides()` /
`isSharedOriginPath()` from `src/config`, `setRuntimeConfig(config, saved?)`. activity also exports
`markInterrupted`'s new texts (`INTERRUPTED_SIGNING_TEXT`, `INTERRUPTED_SENT_TEXT`), `wasInterrupted`,
`isUntrackedMaybeSent`, `markNotSent`, `markSwapNotSent`. swap exports `parsePastedAmount` (a paste is read as a
copied number; the keystroke sanitizer stays) and `etaForRanking` (a quote with an ETA ≤ 0 ranks as 15 s same-chain,
1 h cross-chain, and never takes "Fastest"); `payoutToSigner` wraps Jupiter so a dry quote to another recipient is
refused like the live one. Route rows show `executionFloor(minDestAmount)`, the number the summary and the review
show. `--dim` is `#878797` (AA on bg / surface1). The npx default port is 4370 (4173 is Vite's preview). The build
emits `LICENSE` and `THIRD_PARTY_NOTICES.md` into `dist/` (footer "Licences"). The IPFS release packs the CAR in a
read-only job with install scripts off and checks it with `.github/scripts/verify-car.mjs` before a separate job
pins and attaches.
