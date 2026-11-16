# cp0x Swap — porting the wallet's swap UI and pure logic to React DOM

Status: implementation spec. Source of truth: `~/cp0x-elysium` at `756b115` (main, 2026-11-11). All line refs below are
for that commit. Paths starting with `apps/mobile/` and `packages/shared/` are under `~/cp0x-elysium`. AWK packages are
the installed copies under `~/cp0x-elysium/node_modules/.pnpm/@anywalletkit+*/node_modules/@anywalletkit/*`
(router 0.5.4, core 0.10.3, swap2-assets 0.3.0, lifi 0.7.0, relay 0.1.0, symbiosis 0.1.0, near-intents 0.3.3,
thorchain 0.3.5, chainflip 0.4.5, cctp 0.5.3, usdt0 0.4.4, omniston 0.5.5, uniswap 0.4.3, balancer 0.3.5, wrap 0.4.0,
fynd 0.2.8, jupiter 0.3.6; `@anywalletkit/core` 0.8.0). This repo now pins (2026-11-15) router 0.6.2, core 0.14.0,
lifi 0.8.3, relay 0.1.4, symbiosis 0.1.4, near-intents 0.3.7, thorchain 0.4.3, chainflip 0.4.9, cctp 0.5.7, usdt0
0.5.3, omniston 0.5.9, uniswap 0.4.7, balancer 0.3.9, curve 0.1.6, wrap 0.4.4, fynd 0.2.12, jupiter 0.3.10,
wallet-solana 0.6.2; what that changed for the UI is in the refusal table (§4.2: every module now classifies its
refusals, swap2-core 0.12.0, and a text the table doesn't know is worded by that reason) and the "Not for this pair"
lines (§5.5).

Out of scope here (other specs): wiring the provider modules in the browser (configs, RPC URLs), wallet connection
(wagmi/viem, Wallet Standard), balance reading, signing/execution guards (`lib/swap/execute.ts`, `gate.ts`, `pins.ts`).
This spec fixes the **interfaces** those parts must hand the UI.

The UI copy stays English, as in the wallet. Where a mobile string names Face ID / "the app", §4.12 lists the web text.

---

## 0. Decisions in one screen

1. **Mirror the mobile `lib/` tree** under `src/lib/` and alias `@cp0x/shared` to a vendored copy
   (`src/lib/shared/{chains,format,index}.ts`). Then `routes.ts`, `math.ts`, `gas.ts`, `recipient.ts`, `draft.ts`,
   `providers.ts`, `send/amount.ts`, `send/recipient.ts`, `addressFormat.ts`, `dapp/bytes.ts` copy **verbatim**
   (import lines untouched) with their vitest files.
2. **No cp0x-api at all.** It has no CORS (`apps/api/next.config.mjs` sets only nosniff/referrer/HSTS) and every route
   requires `x-cp0x-app` (`apps/api/src/lib/appGuard.ts`), which an `<img>` cannot send. Prices → DefiLlama /
   CoinGecko from the browser (both `access-control-allow-origin: *`, probed 2026-11-11). Token logos → static files.
3. **Reuse the mobile route-view model unchanged**: `RouteView`, `RouteTag = "best" | "fastest"`, `orderRoutes`,
   `keepSelection`, `friendlyReason`/`parseRejections` (over web `refusals.ts`, §4.2), `RouteSnapshot` and the status line wording.
   Web adds three fields on top (`execution`, `hasMemo`, `trust`) in a wrapper type, not by editing `RouteView`.
4. **AsyncStorage → `idb-keyval`** (`cp0x-swaps-v1`, `cp0x-relay-cleared-v1`), plus `BroadcastChannel` for cross-tab
   sync and a heartbeat so a second tab never marks the first tab's running swap `not-sent`.
5. **Layout "version B"**: ≥1024 px the 400 px form on the page centre line, routes to its right; 640–1023 one column with the full list inline;
   <640 one column, best route + "N more" (RU: «ещё N») opening a bottom sheet, sticky CTA.
6. **Assets**: copy provider PNGs, token PNGs, Cp0xGrotesk (→ WOFF2, OFL alongside); split the generated
   `assets/logos.ts` into SVG files; mirror the catalog's 387 `CcAsset.icon` URLs at build time for the 41 catalog
   rows that have no bundled logo (mobile shows a monogram for them).

---

## 1. Design tokens, fonts, primitives

### 1.1 `apps/mobile/theme/tokens.ts` (103 lines) → `src/theme/tokens.ts` + `src/theme/tokens.css`

Copy the TS file verbatim except L5 (`import {Platform} …`) and L12: on the web
`export const sheetBackground = "#16161f";` (the Android value; iOS's `transparent` exists only for Liquid Glass).
Header comment (L1-4) is the design rule: **dark only, no borders — surfaces separate by fill + shadow.**

```css
/* src/theme/tokens.css — values copied from apps/mobile/theme/tokens.ts L14-72 */
:root {
  color-scheme: dark;
  --bg: #16161f; --bg-outer: #0c0c11;
  --surface1: #1c1c27; --surface2: #1d1d28; --surface3: #22222d; --surface3-alt: #24242f;
  --menu: #20202b; --menu-hover: #2a2a37; --divider: #26262f;
  --ink: #e8e8ef; --ink2: #c9c9d6; --muted: #8a8a9c; --dim: #63636f; --faint: #4c4c5e;
  --accent: #00D4FF; --accent-pressed: #4ce2ff; --accent-bg: #0d2a34; --accent-border: #124554;
  --on-accent: #06131a; --glass-tint: #2dfffe;
  --green: #3ddc97; --green-bg: #182a22; --red: #ff5c6f; --amber: #e0a83c;
  --backdrop: rgba(0,0,0,.55);
  --red-bg: rgba(255,92,111,.12);      /* review error disc (review.tsx L192) */
  --red-bg-step: rgba(255,92,111,.14); /* failed step dot (SwapSteps.tsx L22) */
  --amber-bg: rgba(224,168,60,.10);    /* "another address" box (review.tsx L312) */

  --r-tag: 6px; --r-chip: 10px; --r-control: 14px; --r-card: 20px; --r-sheet: 34px; --r-pill: 999px;
  --sp-page: 20px; --sp-list: 12px; --sp-row: 8px;

  --sh-card: 0 18px 36px -16px rgba(0,0,0,.75), 0 4px 10px -4px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.045);
  --sh-button: 0 10px 22px -10px rgba(0,0,0,.7), 0 2px 6px -2px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.05);
  --sh-button-accent: 0 14px 26px -12px rgba(0,0,0,.85), 0 3px 8px -3px rgba(0,0,0,.45), inset 0 1.5px 0 rgba(255,255,255,.55), inset 0 -2px 0 rgba(0,40,52,.18);
  --sh-sheet: 0 30px 60px -20px rgba(0,0,0,.85), 0 8px 20px -8px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06);
  --sh-menu: 0 18px 40px rgba(0,0,0,.55);
}
html, body { background: var(--bg); color: var(--ink); font-family: "Cp0xGrotesk", system-ui, sans-serif; }
::selection { background: var(--accent-border); }
input { caret-color: var(--accent); }          /* RN selectionColor={colors.accent} */
input::placeholder { color: var(--faint); }    /* RN placeholderTextColor */
```

The RN shadows are already CSS syntax (RN 0.76+ `boxShadow`), so they paste 1:1.

### 1.2 Fonts — Cp0xGrotesk

- Files: `apps/mobile/assets/fonts/Cp0xGrotesk-{Regular,Medium,SemiBold,Bold}.ttf` (~91 KB each) + `OFL.txt`.
- What it is: Space Grotesk (OFL-1.1, © 2020 The Space Grotesk Project Authors; the OFL header names **no Reserved
  Font Name**) with the "0" glyphs (`zero`, `zero.lf`, `zero.zero`, `zero.lf.zero`, `zero.tf`, `zero.tf.zero`)
  replaced by the cp0x logo zero (stadium + slash) from the design handoff — `apps/mobile/scripts/build-fonts.py`.
  Shipped under a new name with the license alongside; web redistribution as WOFF2 is allowed by OFL §2 provided
  `OFL.txt` ships with it and the font is not sold by itself.
- RN has one family per weight (`tokens.ts` L78-83). On the web make **one family, four weights**:

```sh
# once, into the web repo (fontTools + brotli)
for w in Regular Medium SemiBold Bold; do
  python -m fontTools.ttLib.woff2 compress -o public/fonts/Cp0xGrotesk-$w.woff2 \
    ~/cp0x-elysium/apps/mobile/assets/fonts/Cp0xGrotesk-$w.ttf; done
cp ~/cp0x-elysium/apps/mobile/assets/fonts/OFL.txt public/fonts/OFL.txt
```

```css
/* src/theme/fonts.css */
@font-face { font-family: "Cp0xGrotesk"; font-weight: 400; font-display: swap; src: url(/fonts/Cp0xGrotesk-Regular.woff2) format("woff2"); }
@font-face { font-family: "Cp0xGrotesk"; font-weight: 500; font-display: swap; src: url(/fonts/Cp0xGrotesk-Medium.woff2) format("woff2"); }
@font-face { font-family: "Cp0xGrotesk"; font-weight: 600; font-display: swap; src: url(/fonts/Cp0xGrotesk-SemiBold.woff2) format("woff2"); }
@font-face { font-family: "Cp0xGrotesk"; font-weight: 700; font-display: swap; src: url(/fonts/Cp0xGrotesk-Bold.woff2) format("woff2"); }
```
Preload the 400 and 600 files in `index.html` (`<link rel="preload" as="font" type="font/woff2" crossorigin>`).

### 1.3 Type scale (`tokens.ts` L88-101) and `<Text>` (`components/Text.tsx`)

RN letterSpacing is in pt = CSS px. RN sets no line-height except `hero`; use `line-height: 1.28` (Space Grotesk's
natural ascent+descent) as the default.

| variant | size px | weight | tracking px | extra |
|---|---|---|---|---|
| balance | 37 | 600 | -1.4 | |
| balanceCents | 22 | 500 | -0.6 | |
| hero | 40 | 600 | -1.8 | line-height 41px |
| title | 20 | 600 | -0.5 | |
| amount | 30 | 600 | -1 | |
| listTitle | 14 | 600 | 0 | |
| body | 14 | 400 | 0 | default variant |
| bodyStrong | 14 | 500 | 0 | |
| small | 13 | 400 | 0 | |
| meta | 12 | 400 | 0 | |
| caps | 11 | 600 | 0.8 | uppercase |
| tag | 10 | 600 | 0.4 | uppercase |

```tsx
// src/ui/Text.tsx — same props as components/Text.tsx L4-11
type Variant = keyof typeof type;                      // from src/theme/tokens.ts
export function Text({variant = "body", color, weight, tabular, as: Tag = "span", className, style, ...rest}:
  {variant?: Variant; color?: string; weight?: 400 | 500 | 600 | 700; tabular?: boolean; as?: keyof JSX.IntrinsicElements} & React.HTMLAttributes<HTMLElement>) {
  const v = type[variant];
  return <Tag {...rest} className={className} style={{
    fontSize: v.size, fontWeight: weight ?? v.weight, letterSpacing: v.tracking,
    lineHeight: "lineHeight" in v ? `${v.lineHeight}px` : 1.28,
    textTransform: "upper" in v && v.upper ? "uppercase" : undefined,
    fontVariantNumeric: tabular ? "tabular-nums" : undefined,
    color: color ?? "var(--ink)", ...style}} />;
}
```
`numberOfLines={1}` → `white-space:nowrap; overflow:hidden; text-overflow:ellipsis` (`.one-line`);
`numberOfLines={2}` → `-webkit-line-clamp:2`. Buttons, rows and chips get `user-select:none`; text marked
`selectable` on mobile (review values, addresses, error texts) keeps `user-select:text`.

### 1.4 Primitives (mobile → web, exact numbers)

| Mobile | Web | Numbers |
|---|---|---|
| `components/Screen.tsx` | `.page` | padding `0 20px 32px`, flex column gap 16 (swap overrides: paddingTop 10, gap 14 — `app/swap/index.tsx` L209) |
| `components/Card.tsx` | `.card` | bg surface1, radius 20, `--sh-card`, no border |
| `components/Button.tsx` | `<Button kind height icon loading>` | heights 54 (main CTA) / 48 / 40; radius 14; padding `0 18px`; label weight 600, 15.5 px at 54 else 14 px; gap 9; icon 16. primary: bg accent, `:active` accentPressed, fg onAccent, `--sh-button-accent`. secondary: bg surface2, `:active` surface3Alt, fg ink, `--sh-button`. ghost: transparent, `:active` surface2, fg ink2, no shadow. disabled opacity .45; loading opacity .85, keeps the title, spinner replaces the icon on the left (L29-30, L55). Add `:hover` = the pressed colour on pointer devices. |
| `IconButton` (Button.tsx L66-101) | `<IconButton>` | 36 circle, bg surface2 (`:active` surface3Alt), `--sh-button`, icon 18 ink2, hit area +6 |
| `components/Field.tsx` | `<Field>` | bg surface1, radius 14, padding `13px 14px`, font 500 15 px, min-height 48, no border; label = caps dim above, gap 8; error = meta red below |
| `components/Skeleton.tsx` L8-16 | `.skeleton` | bg surface2, radius 8; opacity .5↔1, 900 ms ease-in-out, alternate infinite; static under `prefers-reduced-motion` |
| `ReviewSkeleton` L22-39 | `<ReviewSkeleton rows label>` | radius 20 surface1, padding `6px 16px`; rows padding 14 0 with 1px divider top (not first); bars 88/72 × 12 left, 120/96 × 14 right; footer spinner + meta muted label, padding 12 0 |
| `ActivityIndicator size="small"` | `<Spinner size={20}>` | 2px ring in the given colour, transparent top, 0.8 s linear rotation |
| RN `Switch` (index.tsx L360-370) | `<Switch>` | track 44×26 radius pill, on = accent, off = surface3; knob 22 px ink; `role="switch" aria-checked` |
| `components/Glass.tsx` (fallback branch L23-29) | `.glass` | `backdrop-filter: blur(30px)`; bg `rgba(26,34,42,.45)` (dark variant `rgba(22,22,31,.82)`); overlay `--glass-tint` at opacity .05; shadow `0 10px 30px rgba(0,0,0,.42), inset 0 .5px 0 rgba(170,255,255,.4)`; overflow hidden |
| `components/Segmented.tsx` | (not used by swap) | track surface1 radius 14 padding 3 `--sh-button`; segment h32 px14 radius 11, active surface3 + `--sh-button`, label small 600 ink / muted |
| `lib/haptics.ts` (`tap/success/warning`) | no-op | |

### 1.5 Icons (`components/Icon.tsx`, 134 lines)

24×24 grid, `fill="none"`, `stroke={color}`, `stroke-width` **2.6, or 3.0 when size ≤ 12**, `stroke-linecap="butt"`,
`stroke-linejoin="round"` (L119-131). Copy the `ICONS` table L11-115 as is, turning `Path/Circle/Rect` from
react-native-svg into DOM `path/circle/rect` (same attributes; `fill(c)` → `fill={c} stroke="none"`). Names:
`arrowRight back chevronDown chevronRight close check search scan scanLine gear send receive swap flip plus external
refresh copy share import lock cloud eye wallet deals hubs explore profile activity allChains`; the web adds `info` and
`power` (`M12 3.5 V12 M7.4 7.1 A7.5 7.5 0 1 0 16.6 7.1`, the header's disconnect). The swap uses:

```ts
chevronDown: "M6 9 L12 15 L18 9"
close:       "M6 6 L18 18 M18 6 L6 18"
check:       "M5 12.5 L10 17.5 L19 7"
flip:        "M8 4 V19.5 M4.5 16 L8 19.5 L11.5 16 M16 20 V4.5 M12.5 8 L16 4.5 L19.5 8"
swap:        "M4 8 H18.5 M14.5 4 L18.5 8 L14.5 12 M20 16 H5.5 M9.5 12 L5.5 16 L9.5 20"
refresh:     "M19 12 A7 7 0 1 1 16.95 7.05 M17.5 3.5 V7.5 H13.5"
external:    "M7 17 L17 7 M9 7 H17 V15"
search:      circle(10.5,10.5,r 6.75) + "M15.5 15.5 L20.5 20.5"
copy:        rect(8.5,8.5,11.5×11.5,rx 3.5) + "M15.5 4.5 H8 a3.5 3.5 0 0 0 -3.5 3.5 V15.5"
```

---

## 2. Mobile swap UI — what each piece shows, states, numbers, interactions

### 2.1 Swap screen — `apps/mobile/app/swap/index.tsx` (534 lines)

Header comment L1-8: pay/receive cards with token pickers, flip, MAX, the live route list (every venue that serves the
pair quotes in parallel, dry; routes appear as each answers; refresh every 30 s). Nothing reads a key; "Review swap"
hands the picked route to the review in memory (`setSwapDraft`). Quotes need no funds.

State (L97-143): `picked: Pair|null` (frozen once balances load, L109-111 — a portfolio refresh must not swap the
token under the user), `text` (amount field), `selected` provider, `sheet: "pay"|"receive"|null`, `toOther`,
`recipientText`. Derived: `amountIn = parseUnits(text, from.decimals)`, `slippageBps = autoSlippageBps(from.symbol,
to.symbol)`, `problem = balanceProblem(amountIn, balance)`, `recipientCheck = swapRecipient(...)`,
`recipientIsContract` (EVM `eth_getCode` ≠ "0x", react-query, staleTime 300 s, L128-135), `req` (null until amount>0
and the recipient, when toggled on, is valid — L136-139), `routes = useRoutes(req, prices)`,
`chosen = keepSelection(list, selected)`.

Pieces, top to bottom:

- **TokenButton** (L50-90): h44, padding-left 7 / right 12, radius 14, bg surface3Alt (`:active` menuHover), gap 8.
  `TokenIcon` 28 with network badge; symbol `bodyStrong` weight 600; chain name `meta` dim **10.5 px**; chevronDown 11
  muted. Empty: 28 px surface3 disc + "Select". aria-label `"{SYM} on {Chain}, change token"`.
- **Pay card** (L215-285): Card padding 14. Row 1 (space-between): caps "You pay" dim | `meta` muted tabular
  "Balance {formatAmount}" (or "—") + **MAX** chip (bg accentBg, `:active` accentBorder, radius 6, padding 3×7,
  `tag` accent "MAX", disabled+opacity .5 when no token or balance 0; hit slop 8). Row 2 (margin-top 13, gap 12):
  TokenButton + amount input (flex 1, min-width 0, right-aligned, weight 600, **25 px**, tracking -0.8, padding 4 0,
  colour red when `problem` else ink, placeholder "0" faint; `onChange → sanitizeAmountInput(t, decimals)`).
  Row 3 `meta` tabular right, margin-top 7: `problem` (red: "Insufficient balance") ‖ `≈ {formatUsd}` ‖ "No price"
  (token without price) ‖ "≈ $0.00" (dim).
- **MAX** (L173-180): `maxSwappable(balance, isNative, reserve)` with `reserve = gasReserve(family, nativeSymbol,
  nativeDecimals, chainId)` for natives, 0 for tokens; writes `formatUnits(...)` into the field.
- **Flip** (L287-315): 8 px spacer between the cards; button absolutely centred on the pair (`top:50%;
  margin-top:-19px`), 38×38, radius 14, bg surface3 (`:active` surface3Alt), **3 px border in bg colour** (cuts into
  both cards), icon `flip` 16 accent, z-index 2. Disabled (opacity .6) when the receive token isn't payable.
- **Receive card** (L317-348): same frame, caps "You receive". Right side: `Skeleton 110×26` while a request is
  quoting and no route yet; else the chosen route's `destAmount` (`formatUnits` truncated to 6 decimals by
  `.replace(/(\.\d{6})\d+$/, "$1")`), weight 600, 25 px, tracking -0.8, one line, auto-shrink; faint "0" without a route.
  Footer meta dim right: `≈ {usd}` ‖ `on {to.chainName}` (cross-chain, no price) ‖ non-breaking space.
- **Recipient box** (L351-426), shown once a receive token exists; gap 10. Row: `bodyStrong` "Send to another
  address" + `meta` muted ("{SYM} is paid out to this {Chain} address" / "To this wallet on {Chain}") | Switch. Toggling
  clears the selected route. When on: input row h52, padding-left 14 / right 6, radius 14, bg surface1, **1.5 px
  border**: red when invalid, accentBorder when valid, transparent otherwise; input font 500 14 px, placeholder
  "{Chain} address". Right: clear button 36×36 (`close` 13 muted) when text, else **Paste** chip (h36, px 12, radius 10,
  bg accentBg/`:active` accentBorder, `meta` 600 accent). Message under it (`meta`): invalid → red `reason`; valid EOA
  → green "Valid {Chain} address. Double-check it — a swap to the wrong address can't be undone."; valid contract →
  amber "This is a contract on {Chain} — make sure it can receive and move {SYM}, or the funds are stuck there.";
  empty → no message (owner, 2026-11-12: the placeholder already names the chain).
- **Routes section** (L428-488), only when `req`; gap 8. Header: caps "Routes" dim | refresh button (`refresh` 16
  muted; spinner while loading; disabled while loading). Status line `meta` (red on error) — the exact cascade L192-204:

```ts
const status = !req ? null
  : routes.loading && pending.length ? `Asking ${pending.map(providerName).join(", ")}…`
  : routes.loading ? "Finding routes…"
  : routes.error ? `Couldn't quote: ${routes.error}`
  : list.length ? `${list.length} route${list.length > 1 ? "s" : ""} · refreshes every 30 s`
  : routes.snapshot && !routes.snapshot.asked.length ? "No venue swaps this pair yet."
  : "No route for this pair and amount right now.";
```
  Card padding 4, gap 2: loading & empty → skeleton block (padding 12, gap 10: 70 %×14, 45 %×11); rows
  (`SwapRouteRow`); empty & idle → up to 4 rejections as `meta` dim, 2 lines: "{Provider}: {reason}", or
  "Try another amount or token.".
- **Hint** (L489-493) when no `req`: `small` dim centred, margin-top 6: "Loading your tokens…" ‖ "Enter an amount to
  see routes from every venue."
- **Summary** (L495-512): `TxReviewCard` rows — Rate `1 {A} = {formatRate(r)} {B}`; Route `{Provider}` (+ ` · {A
  chain} → {B chain}` cross-chain) with `ProviderLogo` 18; Slippage `Auto · {bpsLabel}` (presets 0.01 / 0.05 / 0.3 %, web D37); Minimum received
  `{formatAmount(executionFloor(route.minDestAmount))} {SYM}`.
- **CTA** (L515-517): bottom bar padding `8px 20px (8 + safe-area)`, Button 54 "Review swap", disabled when no route or
  zero amount. Problems (balance) do **not** disable it — the review blocks Confirm.
- **Token sheet** (L519-531): title "You pay" / "You receive"; picking the other side's token swaps the pair
  (`pickSide`); `setPair` keeps the pay side a payable token (L155-166) and re-sanitizes the amount for new decimals.
- Watch-only guard (L145-153): web drops it (no wallet = still a usable form; see §5.4 CTA states).

### 2.2 `components/SwapRouteRow.tsx` (91 lines)

Row: `role="radio"`, flex, gap 12, padding 12×14, radius 14; bg: selected surface2, `:active` surface3, else
transparent; **1 px border** accentBorder when selected else transparent. `ProviderLogo` 32. Middle (flex 1, gap 5):
line 1 = `listTitle` provider name (ellipsis) + tags (gap 6) — **Best**: accent on accentBg; **Fastest**: green on
greenBg; tag = radius 6, padding 2×6, `tag` variant. Line 2 = `meta` dim tabular:
`{etaLabel}` + (`fees>0` ? ` · fees {usd}` : gasUsd===null ? ` · fees in price` : "") + (gasUsd!==null ?
` · gas ≤ {usd}` : "") + (approvalSpender ? " · approval" : ""), where fees = `feeUsd` + `bridgeFeeUsd` (the bridge fee a
venue charges on top and leaves out of its `feeUsd`: USDT0's LayerZero fee, priced at the source native; LI.FI's
`feeUsd` already lists it, webRoute.ts). Right (align end, gap 4, shrinks): `small` 600 tabular
`{formatAmount(minDestAmount)} {SYM}`; `meta` dim `min · {usd}` or "minimum". The row shows the **guaranteed**
amount (`minDestAmount`), never `destAmount`. aria-label `"{Provider}, at least {out} {SYM}, {eta}"`.
testID `swap-route-<provider>`.

### 2.3 `components/SwapTokenSheet.tsx` (225 lines)

Page sheet (slide up, full height). Header (padding 0 20, mb 12): `title` + IconButton close. Search `Field`
(placeholder "Search tokens or networks", mx 20, mb 12). Body: 1 px divider on top; **left rail** 72 px wide, bg
bgOuter, 1 px divider right, items centred, gap 6, padding-top 12 / bottom 40, no scrollbar. Rail item 52×52 radius 16,
1 px border accentBorder + bg accentBg when active, `:active` surface1; network logo 30 (`AssetIcon network`); "All" =
30 px surface3 disc with `tag` ink2 "ALL"; **held dot** 7×7 green at top 6 / right 6. Rail order: "All networks", then
`pickerNetworks(tokens)` (pinned `ethereum, solana, tron, bitcoin, ton, near`, then held, then the rest, catalog
order). Right pane: heading row (baseline, padding 14 16 6): `bodyStrong` "Search results" / "Your tokens" / network
name + `meta` muted tabular value (sum of held USD; network USD if held). List padding 0 6 40; token row: gap 10,
padding 9×10, radius 14, bg surface2 when selected or pressed; `TokenIcon` 34 (network badge only when searching or
on "All"); `listTitle` symbol + `meta` dim chain (same condition); held tokens: right `small` ink2 tabular amount +
`meta` dim USD ("—" unpriced). Open state (L117-122): on the selected token's network, else "All" when anything is
held, else the first network. Search (`matchesToken`): symbol, catalog symbol, chain name, slug, contract prefix ≥ 4
chars; picking or switching network clears the query. Empty texts: `Nothing matches “{q}”.` / "No balances yet — pick
a network on the left." / "No tokens on this network." testIDs `swap-token-<key>`, `swap-net-<slug>`.

### 2.4 `components/ChainPicker.tsx` (146 lines) — not used by the swap

Portfolio filter. 38 px button (radius 14, bg surface1/`:active` surface3, `--sh-button`, padding 0 11, gap 7, logo 18
or a 2×2 grid of ethereum/arbitrum/solana/bitcoin minis, label `small` 500 max-width 120, chevronDown 12 muted) →
anchored menu 228 px (bg menu, radius 14, `--sh-menu`, rows h42 px12 gap 10, `:active` menuHover, label `small` 500,
count `meta` dim, check 12 accent in a 14 px slot). Web reuses this **menu** look for the AppShell wallet menu and the
header's wallets dropdown (§5.2).

### 2.5 `components/TxReviewCard.tsx` (44 lines)

Card padding-y 4. Each row: space-between, align-start, gap 16, padding 11×14. Key `small` muted. Value column
(shrinks, align end, gap 3): optional icon (gap 7) + `small` tabular **selectable** value right-aligned (row colour
override: amber/accent); optional `sub` = `meta` tabular selectable dim right. `ReviewRow = {k, v, sub?, color?,
testID?, icon?}`.

Web additions (D34): `note` — `meta` dim on the value's own line, 8 px after it, dropping under the value only when
the row has no room (no `· ` drawn before it — a note that wrapped would start its line with the dot; below,
`{value} · {note}` only marks where the note begins); `tip` — a focusable 13 px `info` mark beside the key whose
tooltip explains the row (never a fact the row would otherwise lose; a tap or Tab opens it, unlike a badge's hover
tooltip); `badge` — a tag after the value; `compact` — rows padding 8×14, gap 12 (the review, the deposit panel and
the status; the form's summary keeps 11×14). In the card a key's tip opens from the key's left edge and the badge's
ends at the badge, so neither hangs out of the sheet.

### 2.6 Review — `apps/mobile/app/swap/review.tsx` (357 lines)

Everything Confirm authorizes is on screen before any key is read (header L1-17). Re-quotes the picked venue every
30 s (`requoteRoute`, react-query `refetchInterval: REFRESH_MS`, retry 1, staleTime 0, gcTime 0 — L69-90); the fresh
route replaces the drafted one; a venue that no longer routes it blocks Confirm (`gone`).

- Headline (L294-308, gap 7, centred): `amount` variant at **27 px**, tabular, one line auto-shrink:
  `{amount} {A} → {B}`; `small` dim `{A chain} → {B chain}` or `on {chain}`.
- Rows (L232-288): You pay (`sub`: chain · USD) · You receive `≈ …` · Minimum received `executionFloor(min)` (`sub`:
  `Auto slippage {x} · quoted {impliedSlippagePct.toFixed(2)}%`) · Rate · Route (logo 18; `sub`: eta + " · claim on
  arrival" for CCTP cross-chain) · Fees (`$x` or "In the price"; `sub`: "Plus gas, up to $x in {NATIVE}" / "Plus the
  network fee, paid in {NATIVE}") · Bridge fee (only `nativeFee>0`: amount in native, `sub` "Charged on top of the
  amount") · Approval ("Exact {amount}" + `sub` "Spender {shortAddress(8,6)}" / "Not needed") · From (`shortAddress`,
  "Your {chain} address") · To (own: "Your {chain} address"; other: amber, "Another {chain} address — not this wallet").
- No route yet → `ReviewSkeleton label="Getting a fresh quote…"`.
- Other-address box (L311-320): padding 14, radius 14, bg amber-bg, gap 4; `small` 600 amber "Paid out to another
  address"; `meta` ink2 line-height 17, selectable: "{full address} on {chain}. Check every character — a swap sent to
  the wrong address can't be undone."
- Gone (L322-329): `meta` red "{Provider} no longer routes this swap: {reason}" + secondary 40 "Pick another route" (back).
- Re-quote failed (L330-334): `meta` amber "Couldn't refresh the quote — showing the one you picked. The swap
  re-checks it before signing."
- Problem (L335-339): `meta` red — balance, or `uncappedFeeText(native)` when an EVM native has no price
  (`swapFeeCap` undefined, L117-125).
- Fine print (L341-344): `meta` dim line-height 17 (web text in §4.12).
- Confirm (L346-354): Button 54 "Confirm swap", `loading` while executing, disabled on no route / problem / gone /
  executing. While executing the screen is **locked** (no back gesture, no back button — L130-139).
- Error phase (L182-227): centred 66 px disc bg red-bg + `close` 26 red; `title` 22 px margin-top 20 "Not swapped";
  `small` ink2 centred line-height 19 margin-top 9, selectable, the `swapErrorText`; buttons gap 10: secondary 48
  "Review again" (back to review + refetch), primary "Close".
- After `startSwap` resolves (first engine step started) → close review, open the status sheet with the id.

### 2.7 Status — `apps/mobile/app/swap/status.tsx` (245 lines) + `components/SwapSteps.tsx` (67 lines)

Form sheet, detents 0.7 / 1, corner radius 34 (`app/_layout.tsx` L110-111). ScrollView padding 20, top 28, gap 18.
Title `title` "{A} → {B}" + `small` label in tone colour (`progress` accent, `action` amber, `ok` green, `warn`
amber, `bad` red — L34-40). `SwapSteps` (from `swapSteps(r, toChain)`) with `activeDetail(r)` (L226-237). `meta`
muted line-height 17 `statusView(r).detail`. `TxReviewCard`: Paid · Receive (`≈ …`, `sub` "at least … · chain") ·
Route (logo) · Source tx (accent) · Delivery/Claim tx (accent). Error `meta` red. Buttons (gap 10): while
`submitting` primary "Continue in background"; `not-sent` with keys → primary "Try again" (reopens the swap with
pay/receive/amount via `formatUnitsPlain`, L240-245); `action-required` & owner → primary "Claim on {chain}"
(read-only `previewClaim` first, then a confirm dialog naming target/recipient/gas, L76-133); not final & not
submitting → secondary 48 "Refresh status" (`refresh` icon, `pollSwap`); ghost 40 "Source on explorer" /
"Delivery on explorer" (`external` icon, `explorerTxUrl`); not submitting → secondary 48 "Done" / "Close".
Web (owner, 2026-11-13, D34): one button look — the explorer links are `LinkButton`s, real `<a target="_blank"
rel="noopener noreferrer">` in the secondary 48 look of "Refresh status" and "Done" (`external` icon after the title),
labelled "Source tx" / "Delivery tx" / "Claim tx" like their rows ("… on the explorer" as the accessible name). Only
"Continue in background", "Try again" and "Claim on {chain}" are primary, full width.
Web, compact (owner, 2026-11-13, D34) — like the review (§5.8) the status fits with Done on screen, no scrolling, at
1280×800 (dialog) and 390×844 (sheet). Body gap 14. `SwapSteps compact`: 10 px between steps, rail min 8 (the review's
steps keep 16 / 14). Rows: compact `TxReviewCard` (§2.5), one line each — Paid `{amount} · on {A chain}` · Receive `≈
{amount} · ≥ {min} on {B chain}` · Route (logo) · To · Source tx · Delivery/Claim tx (accent). The secondary actions
share rows two by two, equal columns (gap 10; a label ellipsizes rather than widening its column): "Refresh status"
beside the one explorer link, else beside Done; two links share a row; the last of an odd count — Done, mostly — spans
it. In progress `[Refresh status][Source tx]` then `[Done]`; delivered `[Source tx][Delivery tx]` then `[Done]`; both
links while still on its way `[Source tx][Delivery tx]` then `[Refresh status][Done]`; nothing to link yet `[Refresh
status][Done]`; sending, the source link alone. Below 375 px one per row ("Refresh status" doesn't fit half of it).
Checked by `tests/e2e/demo.spec.ts` (Done in the viewport, the sheet body not scrolling — in progress and delivered, and
the heavier approval → claim with both links — at every width).

SwapSteps: dot 26 px circle. active: bg accentBg + spinner accent; done: bg greenBg + `check` 13 green; failed: bg
red-bg-step + `close` 12 red; todo: transparent, 1.5 px border surface3. Rail under each dot except the last: width
1.5, min-height 14, flex 1, green when the step is done else surface3, opacity .6. Row gap 12; text column
padding-top 3, padding-bottom 16 (not last), gap 2: `bodyStrong` label (todo dim, failed red, else ink) + active
detail `meta` muted.

### 2.8 Logos and rows

- `components/ProviderLogo.tsx` (39): bundled PNG at `size` (default 28), corner radius `round(size*0.28)`; unknown
  venue → tile surface3Alt with the name's initial, weight 600 muted, font `round(size*0.45)`.
- `components/AssetIcon.tsx` (168): `AssetIcon({token|network, size=38, logo})` = circle bg surface3, overflow hidden.
  Resolution: `network` → `NETWORK_LOGOS[slug]` SVG; `token` → `tokenLogo(symbol)`: PNG in `TOKEN_IMAGES` (L17-98,
  wins) → web3icons SVG `TOKEN_LOGOS[SYM]` → the chain logo of a gas token (`NATIVE_TO_CHAIN`, L101: HYPE → HyperEVM)
  → remote cp0x-api CMC mirror (`/api/v2/logo/cmc/<id>` with the app header, only when the holding carries `logo`) →
  monogram: `tag` ink2, font `max(7, size*.26)`, first 4 chars upper. **The swap picker never passes `logo`**, so on
  mobile a catalog token without a bundled logo is a monogram. `TokenIcon` (L156-168): badge `round(size*.42)` at
  right -3 / bottom -3, 2 px border in bg colour.
- `components/TokenRow.tsx` (67, portfolio): gap 12, padding 10×8, radius 14, `:active` surface1; network chip
  (surface3, radius 6, padding 1×5, `tag` muted). Not used by the swap; ActivityDrawer rows borrow the chip.

### 2.9 `components/Cp0xSheetParts.tsx` (131) — the sheet header pattern

`SheetHeader`: icon 44, gap 12; `title` at 18 px one line + `meta` muted sub; close = 34 px circle surface3 with
`close` 15 ink2 (hit slop 8). `Tiles`: row gap 8; tile flex 1, surface3, radius 14, padding 11×12, gap 4; caps 10.5 px
muted key; value weight 600 16 px tabular (green option). `Facts`: rows space-between gap 16 padding-y 10, 1 px
divider between; key `small` muted, value `small` right. Web uses `SheetHeader` for every sheet/dialog header,
`Tiles` for DepositPanel's amount/timer, `Facts` for deposit details.

### 2.10 `components/TxDock.tsx` (206) + `lib/txDock.ts`

Floating 56 px glass circle (right 20, above the tab bar): ring track `rgba(232,232,239,.12)` 3 px, r = (56−3)/2−3;
state colours pending accent (arc 28 % spinning 1.1 s), action amber (pulse .35↔1, 700 ms), done green (ring draws
shut 520 ms + check), failed red (+ shake −6,6,−4,4,0 × 60 ms). Centre: kind icon 20 (`swap`). >1 item: count badge
(min 20, h20, accent, `tag` 700 onAccent, 2 px bg border, top/right −2) and a tap opens a 280 px glass list (radius
22, padding 6, ≤5 rows: dot 8 + icon 15 ink2 + `small` 600 title + `meta` label in tone; row padding 11×12 radius 14).
Order: action → failed → pending → done; done items stay `DONE_VISIBLE_MS = 8_000`. Tap → status sheet.

---

## 3. Assets

### 3.1 Provider logos — `apps/mobile/assets/images/providers/<provider>{,@2x,@3x}.png` (208 KB)

14 venues: `near_intents lifi thorchain cctp usdt0 chainflip relay symbiosis omniston uniswap balancer wrap fynd
jupiter` (the web adds `curve`, and, 2026-11-15, `zeroex` and `across`: web3icons' ZRX and ACX marks at 72 % of a
`#25222B` tile, 32 / 64 px, ARCHITECTURE D38 — 17 venues in all). 32 pt square → 32/64/96 px PNGs, opaque square tiles; the app clips the corners. Made by
`apps/mobile/scripts/build-provider-logos.py` from the AWK landing's logo set (`~/awk-landing/public/logos`: the
brands' own marks; cp0x-drawn tiles for Uniswap/Balancer/Wrap), Fynd's docs icon on a `#25222B` tile, Relay's and
Symbiosis' apple-touch-icons. Copy to `public/logos/providers/` and render
`<img src="/logos/providers/lifi@2x.png" srcset="…lifi.png 1x, …@2x.png 2x, …@3x.png 3x" width=32 height=32
style="border-radius:9px">` (radius `round(size*.28)`). License: third-party trademarks used to name the venue
(nominative use); keep them unmodified, no implied endorsement.

### 3.2 Network + token SVGs — `apps/mobile/assets/logos.ts` (104 KB, generated)

`export const NETWORK_LOGOS: Record<slug, svgString>` (36 networks: every `CHAINS` slug except `morph`, which is a
monogram) and `export const TOKEN_LOGOS: Record<SYMBOL, svgString>` (41 symbols: ETH BTC WBTC SOL TRX NEAR ZEC BNB POL
AVAX ARB OP USDC USDT DAI USDE PYUSD FDUSD XAUT PAXG LINK UNI AAVE LDO CRV MKR PENDLE JUP CELO FLR MNT SEI GNO RETH CBETH
MSOL GRT EUL LQTY AKT TORN). Generated by `apps/mobile/scripts/build-logos.mjs` from `@web3icons/core`'s
`dist/svgs/{networks,tokens}/branded/*.svg.js` (**MIT**), Zcash from the design handoff (spothq cryptocurrency-icons,
**CC0**), Elysium from `scripts/logo-src/networks/elysium.svg` (LI.FI's chain icon, `lifinance/types`). The slug →
web3icons-file map is `NETWORKS` in that script.

Web: split the strings into cacheable files (do not ship a 104 KB TS module):

```js
// scripts/split-logos.mjs — run once against a copy of apps/mobile/assets/logos.ts
import {readFileSync, writeFileSync, mkdirSync} from "node:fs";
const src = readFileSync(process.argv[2], "utf8").replace(/export const (\w+): Record<string, string> =/g, "globalThis.$1 =");
new Function(src)();                                   // the file is two object literals
for (const [dir, map] of [["networks", globalThis.NETWORK_LOGOS], ["tokens", globalThis.TOKEN_LOGOS]]) {
  mkdirSync(`public/logos/${dir}`, {recursive: true});
  for (const [k, xml] of Object.entries(map)) writeFileSync(`public/logos/${dir}/${k}.svg`, xml);
}
```
Keep the generated comment's attribution in `public/logos/LICENSES.md` (web3icons MIT notice, CC0 note).

### 3.3 Token PNGs — `apps/mobile/assets/images/tokens/<name>{,@2x,@3x}.png` (75 marks, 225 files, 1.5 MB)

40 pt square (40/80/120 px), normalized to the web3icons geometry (mark in the central 75 %, white backdrops cleared,
full-bleed squares cut to a circle) by `apps/mobile/scripts/build-token-logos.py`; sources in
`scripts/logo-src/tokens` — cp0x.com's DAO delegation logos and each project's CoinGecko-listed logo (250 px) or
favicon. The symbol → file map (several symbols share a file: `UNI.E`→uni, `CSSV`→ssv, `TON`/`GRAM`→gram, `WPOL`→pol,
`WXDAI`→xdai, `USDC.E`→usdc, `LINK.E`→link, `AAVE.E`→aave, `MRPH`→morpho, `KMNO`→kamino, `MLW`→mellow) is
`TOKEN_IMAGES` in `components/AssetIcon.tsx` L17-98 — copy it as a `Record<string, string>` of file stems. Copy only
`@2x`/`@3x` (web 1× screens use @2x downscaled). License: project trademarks; sourced via CoinGecko's public
listings — fine to show as identification, not to be re-licensed.

### 3.4 Remote token logos — what the wallet does and the web replacement

Mobile: `AssetIcon` asks `${API_URL}/api/v2/logo/cmc/<id>` (header `x-cp0x-app`), a 302 to a Vercel Blob copy that
`apps/api/src/services/tokenLogos.service.ts` mirrors from CoinMarketCap's CDN (normalized to 120 px like the bundled
ones), indexed **by contract** from a daily CMC sync (`app/api/cron/token-logos`). Only portfolio holdings carry
`logo`; the swap picker doesn't. **Unusable from the web** (no CORS, header gate, `<img>` can't send headers).

Web: the catalog already names an icon per asset — `CcAsset.icon` (387 of 418 assets; hosts
`s2.coinmarketcap.com`, `coin-images.coingecko.com`, `raw.githubusercontent.com` (trustwallet/assets),
`static.debank.com`) and `CcChain.icon` (trustwallet). Of the 405 catalog rows on cp0x's 37 networks, 364 resolve to
a bundled logo; 41 rows / 37 symbols do not (`scrvUSD GOMINING TSLAx NVDAx EURe TRB ETHFI rswETH WBERA VIRTUAL APE Cake
WMNT FBTC KAT FXRP sFLR UBTC UETH KNTQ WXPL M-BTC frxETH ezETH xSolvBTC wS stS iSEI fastUSD kBTC reUSD WPLUME mTBILL
XAUM WOKB brBTC sfrxUSD`). Do **not** hotlink at runtime (leaks every visitor's IP and token interest to four third
parties, breaks under referrer blocking). Mirror at build time:

```js
// scripts/mirror-catalog-icons.mjs → public/logos/catalog/<caip2 with ":"→"_">/<contract lowercased|native>.png
// for every CC_SOURCE_CHAINS asset with an icon; skip on HTTP error (monogram stays); write public/logos/catalog/index.json
// = string[] of "<caip2>|<contract|native>" present. Optional: normalize like build-token-logos.py (sharp, 120 px).
```
Resolution order on the web (`src/ui/AssetIcon.tsx`): bundled PNG by symbol → web3icons SVG by symbol → gas token's
chain SVG → `catalog/index.json` hit by `(caip2, contract|native)` → monogram. Key by contract, never by symbol, for the
catalog step (the mobile rule — any token can copy a symbol).

### 3.5 Brand / misc

`apps/mobile/assets/images/cp0x-mark.png` (512²) and `cp0x-wordmark.png` (1481×623) for the AppShell header and
favicon (`assets/icon.png`). cp0x's own marks.

---

## 4. Pure logic — file by file

Web tree mirrors mobile: `src/lib/swap/*`, `src/lib/send/*`, `src/lib/dapp/*`, `src/lib/addressFormat.ts`,
`src/lib/shared/*`. Config:

```ts
// vite.config.ts
resolve: {alias: {"@cp0x/shared": fileURLToPath(new URL("./src/lib/shared/index.ts", import.meta.url))}},
// tsconfig.json compilerOptions.paths: {"@cp0x/shared": ["./src/lib/shared/index.ts"]}
```
`src/lib/shared/index.ts` = `export * from "./chains"; export * from "./format";` — copy
`packages/shared/src/chains.ts` (113 lines: `ChainFamily`, `ChainInfo`, `CHAINS`, `chainBySlug/Caip2/Id`,
`explorerTxUrl/AddressUrl`) and `format.ts` (51 lines: `formatUsd`, `formatAmount`, `unitsToDecimal`, `splitUsd`, …)
**verbatim**. Their `rpc` lists are public keyless endpoints. Do not copy `api.ts`/`cp0x.ts`/`positions.ts`.

Legend: **V** = copy verbatim (with its `*.test.ts`), **V+** = verbatim plus a marked small patch, **R** = rewrite
keeping the exported API, **—** = not ported.

| File (apps/mobile/lib/…) | Purpose | Imports (RN/Expo · storage · @cp0x/shared · cp0x-api) | Web |
|---|---|---|---|
| `swap/routes.ts` (193) | RouteView model, ranking/tags helpers, refusal texts | AWK router type, `../send/amount`, `./providers` · — · — · — | **V+** (refusal texts → `refusals.ts`, §4.2) |
| `swap/providers.ts` (255) | venue names, static coverage, `providersFor`, Omniston order spender | AWK relay/symbiosis config, swap2-assets · — · — · — | **V** (+ `providersFor` filtered by the web's enabled set, outside the file) |
| `swap/math.ts` (142) | amount sanitize, auto slippage, floor, rate, ETA, MAX reserve | `unitsToDecimal`, `ChainFamily` | **V** |
| `swap/gas.ts` (51) | gas units/USD per quote, `ROUTER_RANKING` | none | **V** |
| `swap/recipient.ts` (20) | "send to another address" check | `../send/recipient`, `ChainFamily` | **V** |
| `swap/draft.ts` (29) | in-memory draft form → review | types only | **V** |
| `swap/tokens.ts` (208) | token universe, picker networks, pair rules | swap2-assets, `CHAINS…`, `../holdings` type, `../dapp/ton`, `../send/assets`, `../wallets` types | **R** (signature change, §4.4) |
| `swap/inflight.ts` (481) | SwapRecord, statuses, steps, poll schedule, parse | none | **V+** (strings §4.12, deposit mode §4.6) |
| `swap/store.ts` (76) | persisted swap list + hook | **AsyncStorage**, React | **R** (§4.7) |
| `swap/tracker.ts` (86) | poll unfinished swaps | **AppState**, react-query, `../portfolio`, `../report`, `../appFocus` | **R** (§4.8) |
| `swap/runner.ts` (140) | run a confirmed swap → record | `../pendingTx`, `../report`, `./execute`, `./gate`, `@cp0x/shared` | **R** (same contract, §4.9) |
| `swap/useRoutes.ts` (95) | debounced streaming quotes, 30 s refresh | React, `../appFocus` | **V+** (1 line, §4.3) |
| `swap/useSwapTokens.ts` (18) | token universe hook over the portfolio | `../history/usePricer` (**cp0x-api prices**), `../portfolio` (**cp0x-api balances**) | **R** (§4.5) |
| `swap/engine.ts` (227) | AWK router wiring, `quoteRoutes`, `requoteRoute`, `protocolFor`, `swapStatus` | AWK, `@cp0x/shared`, **`../api` (cp0x-api baseUrl + header)**, `../send/endpoints`, pins, relayCleared | **R** — keep every export and type, swap `remoteStub` for local providers (engine spec) |
| `swap/execute.ts` (364) | sign + broadcast (keyring, Face ID) | AWK, keyring, secrets, Expo | **R** in the signing spec; UI needs only `swapErrorText`, `maybeSent`, `swapFailureExpected` (§4.10) |
| `swap/gate.ts` (353) | review→sign handshake, `ReviewedSwap`, `swapFeeCap` | viem, AWK types, `../send/gate` `FEE_CEILING` | signing spec; UI imports `ReviewedSwap`, `swapFeeCap`, `uncappedFeeText` (pure; copy `FEE_CEILING` L59-66 of `send/gate.ts`) |
| `swap/pins.ts` (182) | app pins for **remote** stubs | AWK provider pins | **—** (local providers validate themselves) |
| `swap/relayCleared.ts` (33) | durable "one deposit per Relay order" | **AsyncStorage** | **R** → idb, passed as `relayProvider({clearedStore})` (§4.7) |
| `history/recognizers.ts` (125) | describe chain txs in Activity (Aave, Lido, CCTP…) | many AWK protocol modules | **—** for v1 (ActivityDrawer reads local SwapRecords, not chain history) |
| `netErrors.ts` | — | — | **does not exist** at 756b115 (repo-wide grep: no file, no import). Its job on the web is §4.2's transport rows + §4.10 |
| `api.ts` (48) | cp0x-api client (`API_URL`, `APP_VERSION`, balances, prices…) | expo-constants | **—**. Users: `swap/engine.ts` (stub baseUrl), `components/AssetIcon.tsx` (remote logos), `history/usePricer.ts` (prices), portfolio. `APP_VERSION` → `import.meta.env.VITE_APP_VERSION` (display only) |
| `send/amount.ts` (113) | `parseUnits`, `formatUnits`, `usdOf`, `fieldText`, `formatFee` | `unitsToDecimal` | **V** |
| `send/recipient.ts` (49) | address-per-family check, EIP-55 | viem `isAddress`, `../addressFormat` | **V** |
| `addressFormat.ts` | `detectAddressFamily`, `shortAddress` | `ChainFamily` | **V** (only L1-22 needed) |
| `dapp/bytes.ts` (126) | base64/hex/base58 | none | **V** |
| `dapp/ton.ts` (311) | TON Connect + addresses | `@noble/hashes`, `./bytes` | copy **only** `crc16` L46-55, `toRawAddress` L56-74, `toFriendlyAddress` L77-90, `sameTonAddress` L92-95 |
| `send/endpoints.ts` `evmRpc` L100-109 | JSON-RPC to the catalog's first public RPC | `chainBySlug` | copy the function (public RPCs; publicnode sends CORS) |
| `appFocus.ts` `appActive` | react-query focus | — | `export const appActive = () => document.visibilityState === "visible";` in `src/lib/appFocus.ts` |

### 4.1 Route-view model (reuse as is) — `lib/swap/routes.ts`

```ts
export type RouteTag = "best" | "fastest";
export interface RouteFee { type: "network" | "protocol" | "affiliate" | "other"; amount: bigint; token: string; included: boolean; description?: string }
export interface RouteView {
  provider: string; sourceAmount: bigint; destAmount: bigint;
  minDestAmount: bigint;          // what the route guarantees — the number to show
  etaSeconds: number; feeUsd: number; fees: RouteFee[]; tags: RouteTag[];
  relativeValue: number;          // vs the best, 0..1
  netValueUsd: number | null;
  approvalSpender: string | null; // ERC-20 sources: exact-amount spender
  nativeFee: bigint;              // bridge fee on top, source native base units
  validUntilMs: number;           // 0 = none
  gasUsd: number | null;          // source gas upper bound in USD; null = not counted
}
toRouteView(q, source?: {chain; isToken}, gasUsd?: (q: QuoteGasLike) => number): RouteView   // L69-93
orderRoutes(routes)      // best first, then relativeValue, then larger min, then faster      L96-104
tagRoutes(routes)        // tags for a non-auction list (requote)                            L111-122
keepSelection(routes, selected): string | null   // keep the user's pick if still listed, else best  L125-128
friendlyReason(provider, reason, pay?: PaySide); parseRejections(rejections, pay?)            L169-188
isStale(route, now?, marginMs = 5_000)                                                         L191-193
```
Tags come from the AWK auction (`RankedQuote.tags`, router.d.ts: `"best"` = the pick on price with speed breaking ties
inside the tie band, `"fastest"` = lowest ETA). Ranking config `ROUTER_RANKING = {weights: "price:0.7,speed:0.3,
reliability:0", tieBand: 0.0005}` (gas.ts L51) and `valueUsd = usdValue(prices, {gasUsd})` (engine.ts L66) — keep both,
so "Best" means best **after source gas** exactly as on the phone.

`RouteSnapshot` (engine.ts L138-146) — the UI's only input from the engine, keep it:
`{routes: RouteView[]; pending: string[]; rejections: {provider: string; reason: string}[]; asked: string[]}`.
`QuoteRequest` (L111-118): `{from: SwapToken; to: SwapToken; amountIn: bigint; slippageBps: number; recipient?: string}`.

Web-only wrapper (do not edit `RouteView`, so `routes.ts` stays diffable against mobile):

```ts
// src/lib/swap/webRoute.ts
export type Execution = "calldata" | "deposit";       // txRequest present → wallet signs a call; else a deposit address
export interface WebRoute extends RouteView {
  execution: Execution;
  hasMemo: boolean;           // q.depositMemo !== null — QR-only payers can't attach one (BTC OP_RETURN)
  trust: VenueTrust;          // §5.6
}
// built next to toRouteView in the web engine: {...toRouteView(q, source, gas), execution: q.txRequest ? "calldata" : "deposit",
//   hasMemo: q.depositMemo != null && q.depositMemo !== "", trust: VENUE_TRUST[q.provider] ?? "provider-api"}
```

### 4.2 Refusal texts → `src/swap/refusals.ts` (web, 2026-11-12; ARCHITECTURE D28)

Mobile's `REASONS`/`CODED` (routes.ts L143-167) and the three web transport entries are replaced by ONE ordered,
categorised table: `classifyRefusal(provider, raw, pay?) → {reason, category, detail?, raw}`. `friendlyReason` and
`parseRejections` keep their signatures and delegate (`parseRejections` now returns the whole `RouteRejection`).
Every mobile pattern keeps its meaning; the wording is shorter and drops the venue's name (the row already shows it).

| category | section in the list | examples (short line) |
|---|---|---|
| `amount` | Needs a different amount | "Minimum 0.003099 ETH" (1Click "at least …", rounded UP to 4 significant digits), "Minimum $100 right now", "Minimum 0.02 BTC" (base units → `pay`), "Maximum 98.76 USDC" (rounded DOWN), "Fees would take 8.22% of this amount" (THORChain: never "try larger"), "Fees would take 3.5% — try more" (LI.FI fixed fees), "Too small — try a larger amount", "Round the amount to 8 decimals" — Across (D38): "Minimum 2.5 USDC" / "Maximum 685800 USDC" from its "at least / at most N base units", "Fees would take over 10% — try more" (its fee cap); 0x: "Too large for its pools — try less" |
| `setup` | Needs a change on your side | "Pays only the wallet that signs", "Needs more than your 0.5% slippage", "Your max slippage is above its limit", "Doesn't accept this recipient address", "Needs site storage, blocked here", the QR refusals "Needs a wallet that signs on {Chain}" / "Needs a memo — not for QR payments" |
| `unavailable` | Not available right now | "Its node is catching up — try again soon" (THORNode "stale state"; thorchain 0.4.0: no confirming node within 50 blocks), "Its nodes didn't answer — tap refresh" (incl. THORChain's `/thorchain/lastblock` unread), "Rotating its vault — tap refresh", "SOL trading is paused right now", "Unavailable right now — try later" (5xx), "Quote expired — tap refresh", "Not enough liquidity right now" |
| `unreachable` | Not available right now | "Couldn't reach it — tap refresh" (fetch / CORS / RPC transport), "Didn't answer in time — tap refresh" (timeouts, aborts; THORChain's 8 s vault-check budget) |
| `busy` | Not available right now | "Request limit hit — back in about 2 hours" (the wait the venue names, in its unit; never "a minute" for hours), else "Busy right now — try again soon" |
| `pair` | Doesn't support this pair | "Doesn't support this pair", "Doesn't list one of these tokens", "No route for this pair or amount", "Doesn't take this token as a source" (Relay `[tx-target]` only) |
| `safety` | Skipped for your safety | "Can't confirm it pays you" (LI.FI "pays …, not …", "recipient on a non-EVM destination", "does not bind" and, since 0.8.0, LI.FI Intents' "release the input without the delivery", Relay `[output-recipient]`, THORChain memo), "Its transaction didn't match the quote", "Uses a contract we haven't verified" (incl. Chainflip "encoder targets …, not the … Vault"), "Couldn't double-check its vault" (incl. thorchain 0.4.0 "not ActiveVault" and "mimir flags the inbound vault"), "Guarantees less than your slippage allows" (incl. Chainflip "floor … above the expected output …"), "Didn't match what was asked" (incl. the venues' build checks: Chainflip's vault call, THORChain's router call, Symbiosis' transaction, USDT0's LZ fee) — 0x (D38): "Uses a 0x contract we haven't checked yet" (a Settler deployment past the package's pins), Across: "Priced below what its relayers take" (a fee under its per-asset floor) |
| `other` | Not available right now | "No quote right now" (no reason given, or an unknown text the venue didn't classify; a short plain unknown phrase shows as is) |
| `deferred` | none: its own quiet group, "Quoted after you connect ({n})" (2026-11-13) | no refusal — a preview left the venue for the live quote (D7: LI.FI while cp0x's proxy doesn't carry it; Fynd without its slot is asked by no round, so it is absent); the screen words the line for what is missing: "Connect a wallet to get this quote", "Paste the address to get this quote", "Enter the refund address to get this quote" |

Rules: first match wins (rate limits and transport before anything that reads like a check, the specific safety lines
before the generic ones); the `<provider>: ` prefix is stripped up to twice; a short line never shows an address,
hex, base units, a URL or an HTTP code — also as the SDK names one ("quote 404: …", "build 400: …", "1Click 400: …"):
an unknown text shows only what follows that prefix (or NEAR's "threw: "), and only when it is ≤ 40 chars with no
number of 3+ digits, bracket, address, CODE_NAME or bare HTTP reason phrase ("Forbidden"). Rate limits are ONE
predicate, `RATE_LIMITED`, shared with LI.FI's cooldown: the venue's words or a 429 named as a status, never any 429
("at least 0.429 ETH" is a minimum). `raw` = the rest with URLs → `<url>`, whitespace collapsed, ≤ 400 chars.
The venue's own classification (2026-11-15: swap2-core 0.12.0 `Swap2RefusalReason`, kept next to the text by router
0.6.0's `RouteSet.refusals`) is read only when no rule knows the text (`BY_REASON`): `rate_limited` → `busy`
"Busy right now — try again soon"; `upstream_unavailable` / `key_rejected` → "Unavailable right now — try later",
`chain_halted` → "Paused on this network for now", `stale_node`, `quote_expired`, `simulation_failed` → their
`unavailable` lines; `no_route`, `unsupported_pair` → `pair`; `amount_too_small` / `amount_too_large` /
`insufficient_liquidity` → `amount`; `recipient_*` → "Can't confirm it pays you", `vault_mismatch` → "Uses a contract
we haven't verified", `price_check_failed` / `policy_refused` → "Didn't match what was asked". The engine's observer
and the wrappers (`coolDownOnRateLimit`, `payoutToSigner`) pass it on with the text.
`tests/unit/swap/refusals.test.ts` is the guard: real SDK texts (the owner's screenshots, LI.FI's live 429, the
installed `protocol-swap2-*` dists) with their category and short line.

### 4.3 `useRoutes.ts` — 1-line change

L9 `import {appActive} from "../appFocus";` stays; `src/lib/appFocus.ts` exports the visibility version. Behaviour
kept: debounce 400 ms on a new key, refresh every `REFRESH_MS = 30_000` only while visible, a refresh keeps the old
list until the first new price lands, answers from an older request are dropped (`seq`). Key:
`${from.key}|${to.key}|${amountIn}|${slippageBps}|${recipient ?? ""}` — **web: add `from.owner` and `to.owner`**
(refund/recipient addresses typed for wallet-less families change the quote).

Web, 2026-11-12 (ARCHITECTURE D7, D29): `useRoutes(r: RoutesRequest | null, prices)`, `r` = `{mode: "live", req}` or
`{mode: "preview", req}`; the key starts with the mode (a preview list clears the moment the request becomes live)
and adds the preview's `toOther`. Preview rounds: 800 ms debounce, no 30 s refresh (one re-ask when the tab returns
after more than 2 min), and each round — a manual refresh too — spends one token of the tab's bucket (5 at once, one
per 20 s); without a token the round waits for the next and `RoutesState.limitedUntil` says until when. In both
modes a request typed away and back before its debounce ends shows the round it had already finished (no new round,
no token); a round cut off mid-flight starts again. Live rounds are otherwise unchanged.

Web, 2026-11-13 (ARCHITECTURE D32): the hook is unchanged — a new key still starts empty — and the screen folds its
state into the list it shows (`useShownRoutes` over `foldShownList`, `src/screens/form/model.ts`): a round over rows
already on screen (new slippage, recipient or refund address for the same mode, pair and amount; the refresh) keeps
them in place until each venue answers (§5.5).

### 4.4 `tokens.ts` — the web token universe

Mobile limits the universe to networks where the active wallet has an address (L79-81) and the pay side to families
it can sign (`canSendFrom`, L122-125). Web has up to N connected wallets and **deposit-only** families.

```ts
// src/lib/swap/tokens.ts — same SwapToken as mobile L21-42 except owner may be ""
export interface SwapToken { key: string; chain: string; caip2: string; chainName: string; family: ChainFamily;
  symbol: string; catalogSymbol: string; decimals: number; contract: string | null;
  amount: string; priceUsd?: number; usd: number;
  /** Connected wallet's address on this family, or the address the user typed (refund / recipient), or "" (unknown). */
  owner: string; }

export type HoldingLike = {key: string; amount: string; decimals: number; priceUsd?: number; usd: number; isNative: boolean; chain: string; symbol: string};

/** Every catalog token on cp0x's 37 networks (not only connected families): receive side can always pay out to a typed address. */
export function swapTokens(holdings: readonly HoldingLike[], addresses: Partial<Record<ChainFamily, string>>, prices?: Readonly<Record<string, number>>): SwapToken[]
//   body = mobile L72-120 with L80-81 replaced by `const owner = addresses[chain.family] ?? "";`

/** Pay side: families a connected wallet signs for, plus deposit-only families (paid from any wallet via a deposit address). */
export function payTokens(all: readonly SwapToken[], signers: ReadonlySet<ChainFamily>, depositOnly: ReadonlySet<ChainFamily>): SwapToken[] {
  return all.filter((t) => signers.has(t.family) || depositOnly.has(t.family));
}
```
v1 sets: `signers` = `{"evm"}` with an EIP-1193 wallet, `+ "solana"` with a Wallet Standard wallet, `+ "tron"` with an
injected Tron wallet (TronLink), `+ "ton"` with a TON Connect wallet, `+ "near"` with a NEAR extension wallet (NEAR
Connect's injection protocol; all 2026-11-12, ARCHITECTURE D11); `depositOnly` = `{"btc", "zcash"}` minus whatever
becomes a signer later, plus `"tron"` / `"ton"` / `"near"` while no wallet of theirs is connected (the QR stays their
fallback: catalog `QR_FALLBACK_FAMILIES`, ARCHITECTURE D20), so their CTA never asks to connect: the WalletMenu lists
their wallets in their own sections, and says so when there is none. Everything else in tokens.ts
(`destTokenId`, `holdingKey`, `catalogChains`, `matchesToken`, `PINNED_NETWORKS`, `pickerNetworks`, `Pair`,
`pickSide`, `flipPair`, `defaultPair`) is verbatim; `holdingKey` needs the copied `toRawAddress`.
Owner rules feeding `quoteParams` (engine.ts L120-134: `destAddress: recipient ?? to.owner`, `refundAddress:
from.owner`): **`req` stays null while `from.owner === ""` or (no recipient and `to.owner === ""`)** — a live quote
never uses a placeholder address. Meanwhile, with an amount, the form builds a `PreviewRequest` (only the real
addresses it has) and the list shows preview prices, never reviewable (ARCHITECTURE D7; §5.5); with previews off the
RouteList hint names what is missing.

### 4.5 `useSwapTokens.ts` → web hook

```ts
// src/lib/swap/useSwapTokens.ts
export function useSwapTokens(typed: {refund?: Partial<Record<ChainFamily, string>>; recipient?: Partial<Record<ChainFamily, string>>}) {
  const wallets = useConnectedWallets();          // wallet spec: {evm?: {address}, solana?: {address}}
  const {holdings, loading} = useBalances(wallets); // balances spec: HoldingLike[] for connected families
  const prices = usePrices();                     // §4.11, stable {} until loaded (keep mobile L11-12 trick)
  const addresses = useMemo(() => ({...typed.refund, ...addressesOf(wallets)}), [wallets, typed.refund]);
  const all = useMemo(() => swapTokens(holdings, addresses, prices), [holdings, addresses, prices]);
  const pay = useMemo(() => payTokens(all, signersOf(wallets), DEPOSIT_ONLY), [all, wallets]);
  const byKey = useMemo(() => new Map(all.map((t) => [t.key, t])), [all]);
  return {wallets, all, pay, receive: all, byKey, prices, loading};
}
```
Receive-side owners for wallet-less families come from the RecipientField (the switch is forced on, §5.4) and travel
as `QuoteRequest.recipient`, so `to.owner` may stay "".

### 4.6 `inflight.ts` — keep, plus a deposit mode

Verbatim: `SwapStatus` (L15-26), `SwapRecord` (L28-78), `ExecStage` (L81), `isFinal`, `statusView` (L100-178),
`asStatus`, `nextPollAt` (10 s fresh → 30 s after 10 min → 2 min after 2 h; failures double up to 5 min; claims ≥ 60 s),
`duePolls`, `applyStatus`, `pollFailed`, `STUCK_MS`, `swapIncident`, `upsert`, `prune` (unfinished kept; finished 7
days; max 50), `parseStored`, `findSwap`, `providerOfId`, `visibleSwaps`, `newRecord`, `swapSteps`, `markInterrupted`,
`isLocalId`. Add for QR payments (parse them in `parseStored` like the other optional fields):

```ts
// SwapRecord additions
mode?: "wallet" | "deposit";
deposit?: {address: string; memo: string | null; amount: string /* base units, exact */; validUntilMs: number};
heartbeatAt?: number;   // the tab executing a `submitting` record bumps it every 5 s (§4.7)

// swapSteps: when r.mode === "deposit" the steps are
//   {confirm: "Deposit address issued", done} → {swap: `Send ${amount} ${fromSymbol}`, active until a poll reports
//   anything but pending-without-deposit} → {deliver: `Deliver ${toSymbol} on ${toChainName}`, as today}
// statusView "pending" for mode==="deposit" && !sourceHash:
//   {label: "Waiting for your deposit", tone: "action", detail: `Send exactly the amount to the address. It expires in ${mm:ss}.`}
// markInterrupted(list, running, now): only records with status "submitting" && (heartbeatAt ?? updatedAt) < now - 30_000
```

### 4.7 `store.ts` / `relayCleared.ts` → IndexedDB

```ts
// src/lib/swap/store.ts — same exports as mobile: loadSwaps, getSwaps, getSwap, saveSwap, replaceSwap, setRunning, updateSwap, subscribeSwaps, useSwaps
import {get, set} from "idb-keyval";              // idb-keyval@6.2.1
const KEY = "cp0x-swaps-v1";
const chan = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("cp0x-swaps") : null;
function emit(next: readonly SwapRecord[], broadcast = true) {
  swaps = next; for (const l of listeners) l();
  void set(KEY, JSON.stringify(next)).catch(() => {});
  if (broadcast) chan?.postMessage(next);
}
chan?.addEventListener("message", (e) => emit(e.data as SwapRecord[], false));  // another tab wrote
export function loadSwaps() { loaded ??= get<string>(KEY).then((raw) => { /* mobile L28-32 */ }).catch(() => {}); return loaded; }
// setRunning(id, true) also starts setInterval(() => updateSwap(id, (r) => ({...r, heartbeatAt: Date.now()})), 5_000)
```
Store the JSON string (not structured objects) so `parseStored` (defensive reader) stays the single parser.
While any record of this tab is `submitting`, register `beforeunload` → `e.preventDefault()` (browser's "leave?").

```ts
// src/lib/swap/relayCleared.ts — implements RelayClearedStore (@anywalletkit/protocol-swap2-relay/provider):
//   interface RelayClearedStore { has(orderId: string): boolean | Promise<boolean>; add(orderId: string, expiresAtMs: number): void | Promise<void> }
// mobile L14-32 with AsyncStorage.getItem/setItem → idb-keyval get/set on "cp0x-relay-cleared-v1"; keep "throw on corrupt"
// (a throw refuses the build). Wrap add() in navigator.locks.request("cp0x-relay-cleared", …) when available.
```

### 4.8 `tracker.ts` → web

Same `pollSwap(r)` and `swapContext(r)`. `useSwapTracker()`:
- `AppState "active"` → `document.addEventListener("visibilitychange", …)` when visible → `run(true)`.
- `refreshBalances(qc, accountId)` → `qc.invalidateQueries({queryKey: ["balances"]})`.
- `report("tx", …)` → `console.warn` (no backend; leave a `reportIncident` hook).
- One poller per browser: `navigator.locks.request("cp0x-swap-tracker", () => new Promise(() => {}))` held by the
  leader tab; others only render (BroadcastChannel keeps them in sync). Without `navigator.locks`, every tab polls
  (`polling` set de-dupes per tab only — acceptable).
- TICK_MS 5 000 unchanged.

### 4.9 `runner.ts` → web

Keep `startSwap(input): Promise<string>` semantics exactly (resolves with the `local.<ts>` id when the engine's first
phase fires; rejects if execution fails before that; later failures land as `not-sent` with `swapErrorText`; a
maybe-sent broadcast becomes a tracked `pending` record with `maybeSent: true` and is never retried). Drop
`recordSent` (`../pendingTx` — the wallet's Activity feed). `accountId` = `"${family}:${payer address}"`
(e.g. `evm:0xabc…`). Deposit swaps don't use the runner: the engine spec's "issue deposit" call returns the live
quote; the UI saves `newRecord({...})` with `mode: "deposit"`, `deposit: {...}`, id = the AWK swap id for that
intent, and the tracker polls it like any other.

### 4.10 Error text — `execute.ts` `swapErrorText` (L326-352) on the web

Keep every branch except the keyring ones; replace L334-336 (`isSecretCancel`/`secretErrorText`) with a wallet
rejection check, and keep the order (mismatch → fee cap → not confirmed → **rejected** → maybe-sent → no gas →
in flight → floor → no route → expired → raw):

```ts
const rejected = (e: unknown) => {
  const x = e as {code?: unknown; name?: unknown; message?: unknown} | null;
  return x?.code === 4001 || x?.name === "UserRejectedRequestError" ||
    (typeof x?.message === "string" && /user rejected|rejected the request|denied/i.test(x.message));
};
if (rejected(e)) return "You declined in your wallet — nothing was sent.";
```
`swapFailureExpected` (L355-358) adds `rejected(e)`; `maybeSent` (L361-364) verbatim.

### 4.11 Prices (replaces `GET /api/v2/prices`)

Mobile: `useSymbolPrices()` (`lib/history/usePricer.ts` L12-29) → symbol → USD from cp0x-api, which maps
`GECKO_IDS` (`apps/api/src/services/v2Balances.service.ts` L49-189, symbol → CoinGecko id) over CoinGecko
`simple/price` (L216-232). Web: copy `GECKO_IDS` into `src/lib/swap/prices.ts` and call DefiLlama first, CoinGecko
second (both keyless, CORS `*`):

```ts
export async function fetchSymbolPrices(signal?: AbortSignal): Promise<Record<string, number>> {
  const ids = [...new Set(Object.values(GECKO_IDS))];
  try {
    const r = await fetch(`https://coins.llama.fi/prices/current/${ids.map((i) => `coingecko:${i}`).join(",")}`, {signal});
    const {coins} = (await r.json()) as {coins: Record<string, {price: number}>};
    return mapBack((id) => coins[`coingecko:${id}`]?.price);
  } catch {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`, {signal});
    const body = (await r.json()) as Record<string, {usd?: number}>;
    return mapBack((id) => body[id]?.usd);
  }
}
// mapBack: for each [symbol, id] of GECKO_IDS, out[symbol] = price; then USDT/USDC/DAI default 1 when absent.
// usePrices(): useQuery({queryKey: ["prices"], queryFn, staleTime: 60_000, refetchInterval: 60_000, retry: 1})
```
Long DefiLlama URLs: chunk ids by 100. Footer attribution "Prices: DefiLlama · CoinGecko" (CoinGecko's free tier asks
for it). Balances-attached `priceUsd` (from the balances spec) wins over the symbol map, as on mobile (tokens.ts L95).

### 4.12 Mobile strings that change on the web

| Where | Mobile | Web |
|---|---|---|
| inflight.ts L109 | "Keep cp0x open until the swap is sent — you can leave this screen." | "Keep this tab open until the swap is sent." |
| inflight.ts L128 | "… You can close the app — tracking continues." | "… You can close this tab — tracking picks up when you come back." |
| inflight.ts L438 | "Confirmed with Face ID" | "Confirmed in your wallet" |
| inflight.ts L472 | "The app closed before the swap was sent — nothing was swapped." | "The tab closed before the swap was sent — nothing was swapped." |
| review.tsx L341-344 | "… Face ID signs on this device." | "… · signed in your browser" (two-line fine print, §5.8, D34) |
| execute.ts L334 | "Face ID was cancelled — nothing was sent." | "You declined in your wallet — nothing was sent." |
| status.tsx L197 | "Switch to the wallet that made this swap to claim it." | "Connect the wallet that made this swap to claim it." |

---

## 5. Web component tree — "version B"

### 5.1 Breakpoints and grid

```css
.shell   { min-height: 100dvh; background: var(--bg); }
.header  { height: 64px; padding: 0 var(--sp-page); display: flex; align-items: center; gap: 12px; }
.main    { max-width: 1040px; margin: 0 auto; padding: 8px var(--sp-page) 32px; }
/* ≥1024: centred form, routes to its right */
@media (min-width: 1024px) {
  .header { padding: 0 32px; }
  /* empty | form | routes: the form stays centred; under 400 px of routes the empty left side gives way first */
  .main { display: grid; grid-template-columns: minmax(0, 1fr) 400px minmax(400px, 1fr); gap: 24px; align-items: start;
          max-width: 1440px; padding: 16px 32px 48px; }
  .form-col { grid-area: 1 / 2; }
  .routes-col { grid-area: 1 / 3; max-width: 480px; position: sticky; top: 16px; max-height: calc(100dvh - 96px); overflow: auto; }
}
/* 640–1023: one column, full route list inline under the form */
@media (min-width: 640px) and (max-width: 1023px) { .main { max-width: 520px; } }
/* <640: one column, compact routes (best + "N more"), sticky CTA */
@media (max-width: 639px) {
  .cta-bar { position: sticky; bottom: 0; padding: 8px var(--sp-page) calc(8px + env(safe-area-inset-bottom));
             background: linear-gradient(to top, var(--bg) 72%, transparent); z-index: 5; }
}
```
On ≥640 the CTA sits at the end of the form column (desktop: under the summary card, inside the 400 px column).

### 5.2 Tree (→ mobile counterpart)

```
<AppShell>                                   app/_layout.tsx header + TxDock host
  <Header>  cp0x wordmark (h 22) · <WalletsDropdown/> · <ActivityButton/>   ChainPicker button + menu look, TxDock (button)
  <main>
    <SwapForm>                               app/swap/index.tsx (L206-517)
      <AmountCard side="pay">                index.tsx L215-285
        <TokenButton/>                       index.tsx L50-90
        <MaxChip/>                           index.tsx L224-245
      <FlipButton/>                          index.tsx L288-315
      <AmountCard side="receive">            index.tsx L317-348
      <RefundField/>            (web)        — (mobile always has from.owner)
      <RecipientField/>                      index.tsx L351-426
      <SummaryCard/>                         index.tsx L495-512 (TxReviewCard)
      <CtaBar/>                              index.tsx L515-517
    </SwapForm>
    <RoutesPanel>                            index.tsx L428-493
      <RouteList mode="full|compact">
        <RouteRow state="route|pending|refused"/>   components/SwapRouteRow.tsx (+ VenueBadge)
      <RouteSheet/>             (<640)       — (bottom sheet holding RouteList mode="full")
  </main>
  <TokenSheet/>                              components/SwapTokenSheet.tsx
  <ReviewSheet>                              app/swap/review.tsx → app/swap/status.tsx
    <ReviewBody/> → <StepsBody/>             review rows → SwapSteps
    <DepositPanel/>             (web)        —
  <ActivityDrawer>                           TxDock list + app/swap/status.tsx
    <StatusView/>                            app/swap/status.tsx
  <SettingsSheet>               (web)        — (§5.11: connection, venues, previews, API bases, WalletConnect)
```
`<WalletsDropdown/>` (web, D33; owner 2026-11-13: one header control instead of one pill per wallet): no wallet → the
"Connect wallet" button (`Button` 40, `swap-connect-open`, "Connecting…" while a connect runs) that opens the
WalletMenu. Connected → one 40 px pill (`swap-wallet-pill`; surface2, `--sh-button`, radius pill, padding `0 12 0 9`,
gap 8; `aria-haspopup="dialog"` + `aria-expanded`): the connected wallets' icons (22 px: the announced data-URI icon,
radius 6, else the family's network logo) overlapping by 7 px, each ringed 2 px in the pill's fill
(`swap-wallet-pill-<family>`), then `small` 500 tabular text — the address `4…4` for one wallet, "N wallets" for more —
and a chevronDown 12 muted that turns while open; phones (< 640) drop the chevron and tighten to `0 10 0 7` / gap 6 (it
opens a sheet there). It opens the list (`swap-wallets-menu`): at ≥ 640 a popover 6 px under the pill, right-aligned to
it, `min(340px, 100vw − 40px)` wide and at most `100dvh − 66px` tall (the rows scroll, the title and the button stay:
a 360 px landscape phone fits about three), in the menu look (§2.4: bg menu, radius 14, `--sh-menu`, padding 6,
`popoverIn` 0.12 s), `role="dialog"` named by its caps dim title "Connected wallets"; below 640 the app's bottom
sheet (`half`, SheetHeader "Connected wallets" + close), as Settings' network picker (§5.11). One row per connected
wallet in family order EVM, Solana, Tron, TON, NEAR (`swap-wallet-row-<family>`, min-height 56, gap 10): the 32 px icon
(radius 9) with the network's 14 px logo in its corner (TokenIcon's badge, ringed 2 px in the menu's fill; none when the
icon already is the network logo), "{wallet} · {Network}" (`small` 600, the network muted 500), the address `6…4`
(`meta` muted, tabular, selectable), a CopyButton ("Copy {Network} address", `swap-wallet-copy-<family>`) and a flat 32
px `power` IconButton ("Disconnect {Network} wallet", `swap-wallet-disconnect-<family>`). Under the rows, while some
family is not connected, a ghost 40 block "Connect another wallet" (icon `plus` left, `swap-wallets-connect-more`)
closes the list and opens the WalletMenu — on phones once the list's sheet is gone and has handed focus back to the pill
(`Sheet`'s `onClosed`), so closing the WalletMenu returns it there too. Escape and a press outside close the popover
(Escape and the sheet hand focus back to the pill; an Escape with focus already elsewhere leaves it there); focus
leaving it (Tab past its last button, Shift+Tab off the pill) closes it. A disconnect moves focus to the next row's
disconnect (the previous row's after the last row); disconnecting the last wallet closes it and focuses "Connect
wallet".

`<WalletMenu/>` (web `ConnectSheet`): one section per family — EVM, Solana, Tron, TON, NEAR (ARCHITECTURE D11), the
one the CTA named first — with the connected wallet (copy, disconnect) or the options (installed first: EIP-6963, Wallet
Standard, TronLink via TIP-6963 / window.tron, TON wallets whose JS bridge is on the page, NEAR extensions via NEAR Connect's injection events; WalletConnect "Scan with a phone wallet"; TON's
"TON Connect", the TON logo, "Tonkeeper, MyTonWallet and other TON wallets"), else a "none found" line. A pending
WalletConnect pairing shows its link as our own `QrCode` (208 px) and "Copy link"; closing the menu (or Settings)
cancels a pending WalletConnect attempt, before or after its QR (an installed wallet's pending prompt is left alone).
"TON Connect" closes the menu and, once it is gone, opens TON Connect UI's own modal (owner, 2026-11-13: its official
wallet list, QR and app links); closing that modal cancels the attempt, quietly. An attempt that ends in an error (the
list or the modal didn't load, no wallet answered in 5 minutes, a testnet account) reopens the menu on TON, showing it.

Shared web primitives in `src/ui/`: `Text, Button, IconButton, Icon, Card, Field, Switch, Skeleton, ReviewSkeleton,
Spinner, Tag, Glass, Sheet, SheetHeader, Tiles, Facts, TxReviewCard, SwapSteps, AssetIcon, TokenIcon, ProviderLogo`.

`<Sheet>`: `role="dialog" aria-modal="true"`, focus trap, Esc/backdrop close (disabled while `locked`), focus back to
what was focused when it opened, `onClosed` once it is gone (after the exit animation, focus handed back), backdrop
`--backdrop`. ≥640: centred dialog, width per sheet (Token 480, Review 440, Activity drawer 380 anchored right full
height), radius 20, `--sh-sheet`, bg `--bg`. <640: bottom sheet, top corners radius 34, max-height 92dvh, grabber
36×5 radius pill `--surface3` 8 px from the top, drag-down to close; height presets: Token 100dvh−24, Route 70dvh,
Review 92dvh, Activity/Status 70dvh (status detent 0.7).

Keep the mobile `testID`s as `data-testid` (same names: `swap-amount`, `swap-max`, `swap-flip`, `swap-route-<p>`,
`swap-review`, `swap-confirm`, `swap-steps`, `swap-step-<key>-<state>`, …) so e2e scripts port.

### 5.3 AmountCard / TokenButton / FlipButton

Numbers exactly as §2.1. Web specifics: amount `<input inputMode="decimal" autoComplete="off" spellCheck={false}
aria-label="Amount to pay">`, `onChange → sanitizeAmountInput(value, decimals)`; the pay and receive amounts auto-shrink by
length (≤10 chars 25 px, ≤14 → 21 px, else 18 px; tracking scales −0.8 → −0.6; the pay side is a web addition, 2026-11-13).
MAX of a native coin is cut to 6 decimals (3 significant digits below that), rounded down (`trimNativeMax`, web); a
token's MAX stays its exact balance. `Keyboard.dismiss()` → blur the active
element. Balance line "Balance —" for wallet-less families. Hover on TokenButton = `--menu-hover`. The receive card
keeps its height in every state: the footer's no-break space holds the line, and a held route (D32, §5.5) keeps its
amount and USD line, dimmed (opacity .45, 0.2 s), instead of a skeleton.

### 5.4 RecipientField / RefundField / CTA states

- RecipientField: mobile layout §2.1. When `to.family` has no connected wallet the switch is **on and disabled** and the
  sub reads "{SYM} is paid out to this {Chain} address"; the "own address" error (`swapRecipient` → "That's this
  wallet's own address…") only applies to connected families. Paste chip → `navigator.clipboard.readText()` (hide the
  chip when undefined; Firefox/Safari may prompt). EVM contract warning uses `evmRpc(chain)("eth_getCode", …)`.
- RefundField (web): shown when `from.family` ∈ depositOnly, and for Tron, TON and NEAR while no wallet of theirs is
  connected (then with a secondary "Connect {Tron|TON|NEAR} wallet" button, `swap-refund-connect`, that opens the WalletMenu
  on that family) — same 52 px input frame, placeholder "Your {Chain}
  address for refunds", validated with `checkRecipient(input, from.family)` (`send/recipient.ts`); valid → it becomes
  `from.owner` (via `useSwapTokens({refund})`). Sub (`meta` dim): "If the swap can't complete, {SYM} goes back here."
- CTA (Button 54): no amount → "Enter an amount" (disabled) · pay family is a signer family but no wallet →
  "Connect {EVM|Solana} wallet to swap" (enabled → WalletMenu; Tron, TON and NEAR keep the refund field and "Get
  deposit address" instead) · missing refund → "Enter the {Chain} refund address to
  swap", missing recipient → "Enter the {Chain} address to swap" (disabled; Enter on a route focuses that field) ·
  route chosen, `execution: "deposit"` and payer is deposit-only → "Get deposit address" · route chosen → "Review
  swap" · else disabled "Review swap". Balance problems don't disable (mobile rule; Confirm is blocked in review).
  Web (D7): never a review state on preview prices — the connect / address states above, or "Getting your quote…"
  (disabled) while a live request still shows preview rows. Web (D32): "Updating quote…" (disabled,
  `data-state="updating"`) while the chosen route is held — quoted for other terms (slippage, an address) than the
  form's — until its venue answers the new ones; Enter on a route does nothing meanwhile. Should the round end without
  that answer (it failed), "Couldn't update quote — try again" (enabled, `data-state="retry"`): it, and Enter on a
  route, re-run the round — never the review of the held number.

### 5.5 RoutesPanel / RouteList / RouteRow

Data: `useRoutes(req, prices)` → `snapshot: RouteSnapshot<WebRoute>`, folded by the screen into the list it shows
(`useShownRoutes`, D32: `snapshot`, `held`); `chosen = keepSelection(list, selected)`.
Header + status line exactly as §2.1 (the cascade L192-204, `meta`, red on error). `role="radiogroup"`, ↑/↓ moves the
selection, Enter = CTA.

| RouteList state | Condition | Renders |
|---|---|---|
| idle | `!req && !preview` | hint `small` dim centred: "Loading your tokens…" / "Enter an amount to see routes from every venue." (also with no wallet while previews are on: an amount is all a preview needs) / web, previews off or no sample for the family (NEAR): "Connect a wallet to see routes", "Connect a wallet or paste the {Chain} address to see routes" (missing owner) |
| preview (web, D7) | `!req && preview` | no banner (owner, 2026-11-12: the CTA already says what makes it a quote); the usual states, each route row with a "Preview" tag (warning tone; tooltip "Priced for a sample address — …"), "≈ {amount}" and "est. min · $…"; "≈" on the receive card; the summary's "Estimated minimum" (no note under it: the "≈" says it's an estimate; owner, 2026-11-13) in place of "Minimum received". LI.FI and Fynd are asked only through cp0x's keyed proxy (D7, per round); otherwise they sit in the quiet "Quoted after you connect ({n})" group, never under "Didn't quote" |
| preview, limited (web, D29) | `limitedUntil > now` | the refresh button is disabled with "{n} s" before it; an amount still waiting for its first preview: status "Preview paused for {n} s — too many price checks." |
| loading | `loading && list.length === 0` | skeleton block (mobile L455-460) **plus** one `pending` row per `snapshot.pending` venue |
| routes | `list.length > 0` | rows, then (still loading) pending rows, then a collapsed "Didn't quote ({n})" group of `refused` rows in sections, then (a preview) the collapsed, quiet "Quoted after you connect ({n})" group, then the collapsed "Not for this pair ({n})" group |
| no-route | `!loading && list.length === 0` | the refused sections, open, or "Try another amount or token." — status line above says "No route for this pair…" / "No venue swaps this pair yet."; then (a preview) the collapsed "Quoted after you connect ({n})" group; then the collapsed "Not for this pair ({n})" group |
| error | `routes.error` | status line red `Couldn't quote: …` (the classifier's short line, or — when no rule knows the round's error — its own text, URLs out, ≤ 120 chars); previous list stays |
| refreshing, nothing quoted | `loading && updatedAt > 0 && list.length === 0` with refusals | web: the refused sections stay open in place (no skeleton; a venue already listed as refused gets no `pending` row) until the new answers land |
| re-quoting (web, D32) | a round over rows already on screen: new slippage, recipient or refund address for the same mode, pair and amount, or the refresh | every row keeps its key, place and route until its venue answers; the answer replaces the numbers in place (Best / Fastest stay put); a venue that refuses now moves to "Didn't quote", a venue new to the list comes last; the finished round re-ranks once. A route quoted for other terms is **held**: `updating` row (below), the summary keeps its rows with Rate and the minimum dimmed and a 12 px spinner by the minimum (the Slippage row already says the new value), the receive amount dims, the CTA reads "Updating quote…" (§5.4). Refusal rows keep their order on screen too: a venue that refuses again keeps its place with the new reason, one still asked keeps its row, new refusals come last. A venue asked again keeps its route or refusal row, never a `pending` one. A round that fails leaves the held rows **outdated**: still dimmed and unreviewable, but no spinner, no `aria-busy`, the CTA "Couldn't update quote — try again"; the status line says why (`Couldn't quote: …`). Status: "Updating routes…" until the round asks, then the cascade. A list's first round, and a new pair, amount or mode (D7: preview → live too), stream and clear as above. |

The status row: the status line on the left; on the right, `meta` dim, "{asked} of {venues} venues serve this pair"
("All N venues serve this pair"; from `snapshot.asked` / `snapshot.venues`), wrapping under it when narrow. Web
(D32): the status line is one line (ellipsis, the whole text as its `title`; an error wraps, to be read in full) on a
180 px flex basis, so whether the coverage sits beside it or under it depends on the panel's width, never on the text
— "Asking Uniswap, Balancer…" → "2 routes · updated just now" doesn't move the list. While loading, with rows on
screen and no venue asked yet, it reads "Updating routes…" ("Finding routes…" with none). The
phone's route sheet shows the same coverage line (`meta` dim) right under its header.

"Didn't quote" sections (web, D28), non-empty ones only, in this order, each a caps `h3` head (dim) over a
`role="list"` named by it; rows keep the router's order inside a section:
1. "Needs a different amount" (`amount`); 2. "Needs a change on your side" (`setup`); 3. "Not available right now"
(`unavailable` + `unreachable` + `busy` + `other`); 4. "Doesn't support this pair" (`pair`); 5. "Skipped for your
safety" (`safety`): a 12 px `lock` icon and the head in `--green` — a skip protects the user, it is never red.
A `deferred` row is in none of these sections and not counted in "Didn't quote ({n})".

"Quoted after you connect ({n})" (web, D7, owner 2026-11-13): the venues a preview round left for the live quote
(`deferred`: LI.FI while cp0x's proxy doesn't carry it with cp0x's key; Fynd without its slot is asked by no round,
live ones included, so it is absent from the list, not here). Nothing is wrong with them, so it reads like no error:
a quiet group like "Not for this pair" (the same `Group`, `quiet`: `meta` 500 dim label, chevron), collapsed by
default (`swap-deferred-toggle`), placed after "Didn't quote" and before "Not for this pair"; the head is "Quoted
after you add the address ({n})" while a recipient or refund address is what is missing (`deferredCopy`). Open, a
`role="list"` named by the head, one `refused`-style row per venue (the disclosure with its sentence and "Technical
reason"), its short line saying what gets the quote: "Connect a wallet to get this quote" / "Paste the address to get
this quote" / "Enter the refund address to get this quote".

"Not for this pair ({n})" (web, D28): `snapshot.venues − snapshot.asked`, collapsed by default (`swap-uncovered-toggle`),
one quiet row per venue: 24 px grey logo, name (`small` 600 dim), its scope in one line (`venueScope`): Uniswap /
Balancer "Same-network swaps only" (or "Not on this network"), Wrap "Wraps only, like ETH ⇄ WETH", CCTP and USDT0 by
the first reason that holds ("{Network} isn't supported here", with "yet" where the protocol reaches it but its module
doesn't — CCTP Solana, USDT0 out of TON or Tron; USDT0 into TON or Tron "Into TON (Tron) from Ethereum or
Arbitrum only" (usdt0 0.5.0's Legacy Mesh, asked from those two); "Between networks only"; "Moves USDC only" / "Moves USDT
only"; "Not on one of these networks"), Jupiter "Swaps within Solana only", Relay "EVM networks only here", LI.FI
"Doesn't cover these networks" where its chain table doesn't list a side (EVM → Solana is asked since lifi 0.8.0), 0x
(Standard only, D38) "Same-network swaps only" or "Not on this network" (its 7 chains), Across (Standard only) by its
module's own route check (`acrossRouteOf`, `acrossRouteUnpriced`) — "EVM networks only here", "Between networks only",
"Not on one of these networks", "Same token on both networks only", "Delivers ETH, not WETH — pick ETH", "Moves ETH as
a native coin only", "Doesn't list one of these tokens", "Not into Ethereum yet" —, a bridge on a same-network pair
"Between networks only", else "Doesn't cover this pair" (THORChain, Chainflip, NEAR Intents: the answer is in their
token lists).

RouteRow states (same frame as §2.2):
- `route`: mobile row + **VenueBadge** after the Best/Fastest tags. QR-only payers: a route with
  `execution === "calldata"` or `hasMemo` is shown as `refused` (category `setup`) with reason "Needs a wallet that
  signs on {Chain}" / "Needs a memo — not for QR payments". A TON wallet payer (web, ARCHITECTURE D11, D35): a
  `calldata` route is `refused` (category `setup`) with reason "TON contract calls aren't signed here yet", except a
  contract call execute checks byte for byte (`tonCallSigned`: Symbiosis paid in USDT for a token it releases directly
  on an EVM network — not Tron, nothing reached by a swap on arrival; Omniston's escrow paid in USDT for an ERC-20 on an
  EVM network — not a native coin), which is a `route`. Omniston's swap on TON (D35 part C) is a `route` only between
  TON and USDT (else reason "Only TON ↔ USDT swaps are signed here") whose quote's route is one step through a pinned
  DEX (`tonSwapSteps` ⊂ StonFiV1 / StonFiV2 / DeDust, `omnistonSwapRouteSigned`; else "Routed through a DEX that isn't
  pinned here", the detail naming the DEX — DeDust CPMM v2, TONCO, swap.coffee — or "several hops").
- `updating` (web, D32): a `route` row whose route is held — same frame, key and place; the amount column and the
  meta line at opacity .45 (0.2 s; instant with reduced motion), `aria-busy="true"`, ", updating" at the end of its
  label. Still selectable. `outdated`: the same once no round runs (it failed, or a preview waits for its token),
  without `aria-busy`, ", outdated" at the end of its label.
- `pending`: logo at opacity .5, name `listTitle` muted, right side `Spinner` 16 muted; not selectable.
- `refused` (web, D28): a native `<details>` inside a `role="listitem"` wrapper (`data-category`). The `<summary>` is
  the row: logo `filter: grayscale(1); opacity: .5`, name `listTitle` dim, line 2 = `meta` the short line in FULL (no
  clamp; ≤ 45 chars, wraps on narrow screens; `--muted` for safety skips, else dim), a 12 px chevron that turns when
  open. Open: the detail sentence (`meta` muted) and a nested `<details>` "Technical reason" whose body is the raw
  text (`meta` dim, selectable) and a `CopyButton` ("Copy technical reason", copies `{provider}: {raw}`) — outside
  every `<summary>`. Body indent 58 px (under the reason), 14 px on phones; the "Technical reason" summary and the
  copy button are 44 px tall on phones. Keyboard: Tab to a summary, Enter/Space toggles; the focus ring is the global
  accent `:focus-visible`. Rows are keyed by venue and RouteList holds which rows (and "Technical reason"s) are open,
  so a refresh that remounts a row never closes it.

Compact mode (<640): render only the chosen row (default the `best` one) and, when `list.length > 1`, a ghost Button 40
full width: `{list.length - 1} more route{s}` (RU locale: `ещё ${n}`) with `chevronRight` → `RouteSheet` (title
"Routes", the full list incl. pending/refused; picking closes the sheet).

### 5.6 VenueBadge — "permissionless" level per venue

```ts
// src/lib/swap/venues.ts
export type VenueTrust = "contracts" | "own-node" | "provider-api";
export const VENUE_TRUST: Record<string, VenueTrust> = {
  uniswap: "contracts",   // QuoterV2 quote + SwapRouter02 over RPC (README: "QuoterV2 quotes … verified on-chain")
  wrap: "contracts",      // WETH9 deposit()/withdraw()
  balancer: "contracts",  // queryBatchSwap on the V2 Vault; paths from api-v3.balancer.fi
  usdt0: "contracts",     // OFT quoteSend over RPC; LayerZero DVNs deliver ("not from an API")
  cctp: "contracts",      // burn/mint contracts; Circle's attestation (iris-api.circle.com) to mint
  thorchain: "own-node",  // THORNode quotes (public gateway default; point at your own); second node checks the vault
  near_intents: "provider-api", lifi: "provider-api", relay: "provider-api", symbiosis: "provider-api",
  chainflip: "provider-api", omniston: "provider-api", jupiter: "provider-api", fynd: "provider-api",
};
```
Badge = `Tag` (radius 6, padding 2×6, `tag` variant): contracts → green on greenBg "ON-CHAIN"; own-node → accent on
accentBg "NODE"; provider-api → muted on surface3 "API". `title`/tooltip and RouteSheet sub-line:
"Quoted and settled by contracts on {chain} — no company API" / "Quoted by a THORChain node" /
"Quoted by {Provider}'s API — checked in your browser before you sign". Classification is from the packages'
READMEs; revisit when a provider is configured self-hosted (Fynd `selfHosted` → own-node).

### 5.7 TokenSheet

Mobile §2.3 one-to-one (rail 72, items 52, list rows). Desktop dialog 480×min(680px, 90dvh). Input autofocus on
desktop only. Rows are buttons in a virtualized list (`@tanstack/react-virtual`, row 52 px) — "All" + search can list
~400 tokens. Networks without a connected wallet still list (receive side); on the pay side they appear when
deposit-only. Held dot only for connected families.

**Import by address (web, 2026-11-15, ARCHITECTURE D39).** Placeholder "Search, or paste a token address". When the
search text is an EVM contract or a Solana mint and no token on the lookup network has it (a listed one, or one
imported already, simply shows as its row), the list starts with an "Import token" card (surface1, radius 14,
`data-testid="swap-import-result"`): `caps` dim "IMPORT TOKEN" and, for an EVM contract, a network chooser of only the
networks it was found on (read on every EVM network at once, 2026-11-16): `NetworkPicker` as `chip` (26 px surface3
chip, 16 px network logo, 12 px 500 ink2, chevron; `swap-import-network`, options `swap-import-network-<slug>`), the
menu right-aligned under it at 248 px (each row the network's logo, name and the chosen one's check; a search field
past 8 networks; a muted "Checking N more networks…" with a spinner under the list while others read), a bottom sheet
"The token's network" on phones; a plain chip (logo + name, no chevron) when there is one network and nothing left to
read. Shown first: the network the sheet is filtered to, with "All networks" the other side's, else this side's,
else Ethereum — when the token is there; else the first network found. Below it the read token as a row
(`TokenIcon` 34 — its logo found by contract, else the monogram —, `listTitle` symbol, `meta` dim "{name} · {network} · {short address}", an amber `Import` tag;
`swap-import-open`), a skeleton row "Reading it on {network}…" (or "Looking for it on N networks…" before any has
it), or in amber (`swap-import-failed`) "No token at this address on any EVM network here." / "Not found on the
networks that answered — N networks couldn't be reached." with a secondary "Try again" (`swap-import-retry`). A TON,
Tron, NEAR, Bitcoin or Zcash address shows one muted line instead ("TON tokens can't be imported yet — importing by
address works on EVM networks and Solana.", `swap-import-unsupported`) — unless a listed token's contract is that
address (TON USDT's master): then only its row shows.
Opening it replaces the list with the confirmation (`swap-import-confirm`): `SheetHeader` "Import token" / "on
{network}" with Back (to the search) and close; `TokenIcon` 52 (logo found by contract, else monogram) with the network badge, `title` symbol,
`small` ink2 name, `meta` muted "{network} · {n} decimals"; an address box (surface2, radius 14: `caps` "CONTRACT
ADDRESS", the full address in 12.5 px monospace, selectable, a `CopyButton`, "View on the {network} explorer" in
accent); the warning (amber-bg box, `info` icon in amber, `small` ink2): "Anyone can create a token with any name —
including fake copies of real tokens. Check this address against the project's official sources. Swapping an unknown
token can lose its value."; when it reads like a listed token on that network, a `small` 600 amber line "Not the
listed {SYMBOL} — that one's address is {short}"; a 20 px checkbox "I understand" (accent), then "Import" (48,
disabled until checked) and a ghost "Cancel". Imported, the form takes the token and the sheet closes. A pair link
naming an unlisted token opens the sheet on this confirmation alone (no Back). Imported rows sit after the catalog's
with an amber "Imported" tag beside the symbol, the name in the sub line, and a 30 px flat close button beside the row
("Remove the imported {SYMBOL} on {network}", `swap-token-remove-<key>`); the row gives way to it (`min-width: 0`), so a
long symbol or name ellipsizes and the button stays inside the list at 375 px. The form's chip reads "{SYMBOL}
(imported) on {network}, change token" for an imported token. Priced by its contract (D39), an import's row shows
its held value and the amount cards "≈ {usd}" like any token; unpriced, the cards say "Imported token · no price" and
the review's imported note ends "; no price was found for it".

### 5.8 ReviewSheet: review → approve → swap steps

1. **Review** (mobile §2.6): `SheetHeader` (icon = pay token, title "Review swap", sub `{A chain} → {B chain}`),
   headline, rows, warnings, fine print, Confirm. Re-quote with react-query every 30 s exactly as review.tsx L69-90.
   `isStale(route)` → show `ReviewSkeleton "Getting a fresh quote…"` and refetch.
   Web, compact (owner, 2026-11-13, D34) — the review fits with Confirm on screen, no scrolling, at 1280×800 (dialog)
   and 390×844 (sheet) in the common case, and with an approval and another recipient at 1280×900. Every fact Confirm
   authorizes stays text on screen; explanations moved into tooltips. Body gap 14. The headline is the amount line
   alone (the networks are the header's sub, said once). Rows: compact `TxReviewCard` (§2.5) — You pay `{amount} · $x`
   · You receive `≈ {amount} · $x` · Minimum received `{floor} · {slippage %} + margin`, tip `{Auto slippage x% |
   Slippage x%} + 0.5% margin · quoted {implied}%. The swap is refused if it would deliver less.` · Rate · Route (logo
   18, name, `VenueBadge`, then `· {eta}` and ` · claim on arrival` for CCTP cross-chain; the old "Quoted by" row's
   sentence, `venueTrustText`, is the row's tip and the badge's hover tooltip) · Fees `{$x | In the price} · + gas ≤ $y in {NATIVE}` (or `+ network fee
   in {NATIVE}`) · Bridge fee `{amount} · on top of the amount` · Approval `Exact {amount} · spender {short 8,6}` (0x, D38:
   `· Permit2 {short 8,6} + a one-time signature`, and the executing fine print names the Permit2 signature before
   the approval, `walletSteps`) / "Not
   needed" · one "From / To" row `{short} · yours on both chains` (`· your address` on one chain) when the swap pays the
   address it is paid from, else From `· your {chain} address` and To `· your {chain} address` | amber `· not this
   wallet` / `· the address you entered` (QR: Refund to `· refunds go here`). The other-address box keeps the full
   address (padding 10×14, gap 3). Fine print, two lines at 400 px: "Valid {m:ss} · re-quoted before signing; refused
   below the minimum, to another address or with an unseen approval · signed in your browser". While executing, the
   steps take the fine print's place; they are taller, so the sheet scrolls Confirm's block (Confirm, the wallet hint,
   the offer to leave) back into view with the body's bottom padding. Checked by `tests/e2e/demo.spec.ts` (Confirm in
   the viewport, the sheet body not scrolling; Confirm and the hint in view once the heavier review is confirmed).
2. **Executing**: Confirm → `startSwap(...)`; sheet locked (no Esc/backdrop/close), Button loading. Each wallet
   prompt is a step: for an ERC-20 with `approvalSpender` the first prompt is the approval (exact amount), then the
   swap; Omniston EVM sources sign typed data. Show `SwapSteps` as soon as the record exists (`useSwaps` +
   `findSwap(id)`), labels from `swapSteps` (approve step only when `approvals > 0`), detail from `activeDetail`
   (status.tsx L226-237). Web, not mobile (owner, 2026-11-13): the steps are (Approve {SYM}) → "Confirm the
   transaction" → "Swap {A} → {B}" → "Deliver …"; the confirmation step is the wallet's — active ("Waiting for your
   wallet") while it holds the swap, "You confirmed the transaction" and green only once it signed (the broadcast) —
   instead of mobile's first "You confirmed the review", which read as done while the wallet's prompt was still
   open. A 0x token sale (D38) asks for its one-time Permit2 signature first: a "Sign the Permit2 transfer" step
   (`permit` on the record, stage `permit`, "Signing the Permit2 transfer") comes before the approval, which stays
   todo meanwhile and reads "{SYM} already approved for Permit2" when a standing allowance spared it; a tab closed
   at the permit is not-sent, never maybe-sent. EVM chain mismatch: the wallet spec switches chain before the first write; a refused switch
   ends in the error phase with "Switch your wallet to {Chain} to swap."
3. **Stopped before broadcast** → mobile error phase (§2.6). **Broadcast** → the sheet becomes `StatusView` (§2.7)
   with "Continue in background" while `submitting`, "Done" after.

Web, not mobile (owner, 2026-11-13, ARCHITECTURE D34): mobile opens the status the moment `startSwap` resolves — the
engine's first step — so the web did too, and "Signing the swap" with "Continue in background" read as already sent
while the wallet prompt was still open. The review now follows the record (`activity.useSwap(id)`) and moves on only
when `afterConfirm(r)` says so: **broadcast** = the swap's `sourceHash` is on the record (the runner keeps it at the
engine's `broadcast` step) or the record left `submitting` for a tracked state (a signed order, a maybe-sent
broadcast) — an approval's broadcast is not the swap's; **stopped** = `not-sent` → "Not swapped" with
`statusView(r).detail`; a record another tab marked interrupted is neither (this tab's heartbeat takes it back). A
wallet that never answers doesn't trap the user: the sheet stays locked (no Esc, backdrop or close), but after 20 s
(`BACKGROUND_AFTER_MS`) a ghost 40 under the wallet hint closes it. While `getSigner` is still asked (an EVM chain
switch, which has no timeout on a WalletConnect phone) nothing is started: it is "Cancel", and a switch that lands
afterwards starts nothing — the swap it was for is no longer on screen. Once `startSwap` is called it is "Continue in
background": closing cancels nothing, the runner and the record carry on in the activity drawer; a swap the engine
hadn't recorded yet (a signed order waiting for its signature) that then stops says "Not swapped: {reason}" in a red
toast, since the drawer has nothing to show.

### 5.9 DepositPanel (QR routes)

Shown inside ReviewSheet instead of Confirm when the payer is deposit-only and the chosen route is
`execution === "deposit" && !hasMemo`. Flow: rows as in review (From = the refund address, "Refunds go here"), CTA "Get
deposit address" → engine spec call returns the live (non-dry) quote `{depositAddress, depositMemo, sourceAmount,
validUntilMs, intentId}` → record saved (§4.9) → panel:

```
SheetHeader  icon=pay token · "Send {SYM} on {Chain}" · sub "{Provider} · {eta}"
QR           <canvas> 208 px, quiet zone 12 px on #fff tile radius 14 (QR needs a light ground), payload = address only
             (BIP-21 `bitcoin:<addr>?amount=<decimal>` for btc; `zcash:<addr>?amount=` for zcash)
Address      Text weight 500 14 px, word-break: break-all, selectable; IconButton copy (navigator.clipboard.writeText)
Tiles        [ "Send exactly" {formatUnits(sourceAmount)} {SYM} + copy ] [ "Expires in" mm:ss ]
             timer: tabular; amber under 2:00; 0:00 → QR blurred (filter: blur(6px); opacity .4), text red
             "Expired — don't send. Get a new address." + secondary 48 "Get a new address"
Rows         compact TxReviewCard (the review's look, D34): Network {Chain} · Refund to {shortAddress(refund, 8, 6)} · refunds go
             here · Receive ≥ {min} {B} · on {B chain} · To {recipient}
Warning      meta amber, lh 17: "Only {SYM} on {Chain}. Another asset or network is lost. Send the exact amount in one transaction."
Steps        SwapSteps for mode "deposit" (§4.6) under the facts; updates as the tracker polls
Buttons      primary "I've sent it" (closes to ActivityDrawer; tracking already runs) · ghost 40 "Cancel" (record stays until it expires)
```
QR lib: `qrcode@1.5.4` (MIT) `toCanvas(canvas, text, {margin: 0, width: 208, errorCorrectionLevel: "M",
color: {dark: "#06131a", light: "#ffffff"}})`. Never render a QR for an expired or memo-requiring quote.

### 5.10 ActivityButton / ActivityDrawer / StatusView

- ActivityButton (header, right): 40 px glass circle (TxDock §2.10 scaled 56 → 40: stroke 2.5, r = (40−2.5)/2−2) with
  the most urgent item's ring state (web: no count badge — the owner dropped it, 2026-11-13; the count stays in the
  button's accessible label); no item → plain `activity` icon 18 ink2 on surface2 circle.
  Item list = `lib/txDock.ts` ranking restricted to swaps: action → failed → pending → done (done visible 8 s), from
  `visibleSwaps` (all records in this browser; drop the `accountId` filter, show the payer chip instead).
- ActivityDrawer: `SheetHeader` "Activity"; rows (TxDock list row look on surface, not glass): dot 8 in tone + `swap`
  15 ink2 + `small` 600 "{A} → {B}" (+ an amber "Imported" tag when a side was imported by its address, D39, and
  "(imported)" after that symbol in the row's label) + `meta` tone label (`statusView(r).label`) + network chip; tap →
  StatusView in place (back arrow returns to the list). Older finished swaps (pruned after 7 days) under a caps
  "Earlier" header.
- StatusView = `app/swap/status.tsx` §2.7 (an imported side's "Paid" / "Receive" row carries an amber "Imported" tag
  and "Contract {short}" under the amount, D39), in the review's compact look (§2.7 web notes: it fits without scrolling, in
  the review's dialog and the 380 px drawer alike), with `useLocalSearchParams` → prop `id`, `Linking.openURL` → `<a
  target="_blank" rel="noopener noreferrer">` in the secondary button's look (`LinkButton`, §2.7 web note), `Alert.alert` claim confirm → a `Sheet` with the same title/body and
  "Cancel"/"Claim", `router.push("/swap", {pay, receive, amount})` "Try again" → set form state (pair + amount) and
  close the drawer.

### 5.11 SettingsSheet (web; ARCHITECTURE D8, D30)

No mobile counterpart. Opened from the header gear (≥ 640) or the footer's "Settings" (every width); `Sheet` width
480, phone height "tall"; mounted only while open, so each opening re-reads what this browser saved. One Save for
everything (checked with the runtime-config parser; problems listed in a `role="alert"`), then "Saved — reload to
apply" (the config is fixed per page, D9); "Reset to the site's settings" clears the overrides, the connection
choice, Custom's RPCs and the keys. Demo mode and an IPFS path gateway save nothing. Sections, in order:

1. **Connection** (`ConnectionSection.tsx`, D30), first because it decides where every request goes.
   - Caps heading "Connection"; a **native radio group** drawn as the slippage presets (40 px, `surface1`, the
     chosen one `accent-bg` + `accent-border` + accent text; the focus ring on the label via `:has(:focus-visible)`;
     arrow keys move the choice, Tab enters at the chosen one): **Standard · Public · Custom** in a build made with
     `VITE_CP0X_API`, Standard chosen by default; **Public · Custom** otherwise, Public by default.
   - One `meta` muted line for the chosen mode — Standard "Through cp0x's server, with cp0x's keys and RPC: fewer rate
     limits." · Public "Keyless public endpoints, asked straight from this browser." · Custom "Public endpoints plus
     your own RPCs and API keys, asked straight from this browser." — plus "Applies after you save and reload." when
     it isn't the page's mode.
   - The live Standard line (`role="status"`, ink2; amber when unreachable), only while the page runs Standard:
     "Checking the cp0x API…" → "LI.FI and Relay through cp0x with its keys · RPC for 30 networks through cp0x ·
     THORChain's vault check through cp0x" (+ "· LI.FI asked directly after a cp0x error" after a fallback, which
     alone speaks for the venues when none goes through cp0x; "Venues asked directly (cp0x holds no key for them
     yet)" only when health keyed no venue, plain "Venues asked directly" when keyed ones are direct because this
     browser pointed them elsewhere; "Public RPCs" when health gives none) or "cp0x API unreachable — using public
     endpoints." Read afresh each time, so a venue back on cp0x after its stop ran out (00:00 UTC, a Retry-After)
     shows as such.
   - The privacy copy, `meta` dim, always: "Standard sends quote requests and RPC calls through cp0x's server, which
     adds cp0x's API keys. It never sees your wallet keys and signs nothing; every transaction is still checked in
     this browser. Public and Custom never contact cp0x. The NEAR RPC is asked directly in every mode." — or,
     without the API, "This copy of the app has no Standard mode and never contacts cp0x."
   - **Custom only**: the amber RPC trust note; "Your RPC endpoints" (`h4`) with "Tried before the public ones,
     which stay as the fallback." (with the switch on: "Used alone on their networks: no public RPC is asked there,
     even when yours fails."); a switch row "Use only my RPCs" / "On a network you added one for. Your addresses and
     transactions then reach no public RPC operator there." (`settings-custom-only`, on for an older browser's
     migrated RPCs); an add row — the network picker (`NetworkPicker.tsx`, its styles in `NetworkPicker.module.css`;
     also the import's chooser as `chip`; no native `<select>`: that opens the OS
     menu) over the EVM catalog networks then Solana: a 48 px trigger in the field look (`ChainLogo` 20 · the chosen
     name · `chevronDown` 12, turned while open; visually-hidden label "Network", `aria-haspopup="listbox"`); at
     ≥ 640 it opens a popover under the trigger in the §2.4 menu look (`--menu`, radius 14, `--sh-menu`; rows 44 px,
     `ChainLogo` 20 · name small 500, the active row `--menu-hover`, the chosen one's `check` 12 accent), scrolled
     into view inside the sheet body; below 640 the app's bottom sheet "Network" (phones never autofocus its search).
     Both: a "Search networks" field (`role="combobox"`, `aria-activedescendant`) over a `listbox` "Networks" of
     `option`s — it starts on the chosen network; ↑/↓ move, Enter picks, typing filters by name, slug or chain id
     (word starts first: "b" → Base), "No network matches “…”." when nothing does; a letter typed on the trigger opens
     it searching for that letter, ↑/↓ on the trigger open it; Escape closes only the list (never Settings), Tab on
     or a press outside closes it, and focus returns to the trigger. A network with no bundled logo shows its
     monogram (Morph). Then a URL `Field` labelled "RPC URL for {Network}" (Enter adds), and
     "Add" (secondary, `plus`); the check runs on add (https; plain http only for localhost / 127.0.0.1 and only when
     the page itself is served from this machine; no `user:pass@` — "Put credentials in the URL's path or query:
     browsers refuse user:pass@ URLs."; never cp0x's server; no duplicates; 8 per network) and shows under the field; rows in a
     `surface1` list: `ChainLogo` 20 · name (small 600) over the URL (meta, one line, selectable) · a 32 px flat
     `close` IconButton "Remove {url} for {Network}". Then "Your API keys" (`h4`), the amber note "Stored only in
     this browser — anyone with access to this browser profile can read them. Each key goes only to its own venue,
     in a request header. Empty: that venue is asked without a key.", four password `Field`s (LI.FI API key, Relay
     API key, NEAR Intents (1Click) JWT, Jupiter API key; placeholder "Not set"; password managers told to ignore
     them), and "Clear keys" (secondary, removes the saved keys at once; then the `role="status"` line "Your API keys
     were removed from this browser." — Save stays, since the rest of the draft is not written by it). In another
     mode, keys actually stored (not ones typed and left unsaved) get one amber line "Your API keys are still saved in
     this browser; only Custom mode uses them." with the same "Clear keys". Save writes keys only with Custom picked;
     in another mode the stored keys stay as they are.
2. **Venues asked for quotes** — a switch per venue, every one on by default (Fynd's row notes "Standard mode only");
   one the operator turned off stays off.
3. **Preview prices** — "Show prices before a wallet is connected" (off only, D7).
4. **Venue API bases** (a `<details>`): the API base fields, THORChain nodes (textarea, two or more hosts), the two
   price APIs; amber "Pointing a venue at another server means trusting that server's quotes." Placeholders show
   what an empty field asks: in Standard, each proxied venue's PUBLIC base, never the proxy slot. A cp0x URL in any
   field is refused on Save ("…: that is cp0x's server. Standard mode uses it by itself; leave the field empty.").
5. **WalletConnect project id**.

Test ids: `settings-connection`, `settings-mode-{standard,public,custom}`, `settings-connection-status`,
`settings-connection-privacy`, `settings-custom`, `settings-custom-fallback`, `settings-custom-only`,
`settings-custom-network` (the picker's trigger; its parts `-search`, `-list`, `-<chain id | solana>`, the phone
sheet `-sheet`), `settings-custom-url`, `settings-custom-add`, `settings-custom-rpcs`,
`settings-key-{lifi,relay,nearIntents,jupiter}`, `settings-keys-note`, `settings-keys-saved`, `settings-keys-clear`,
`settings-keys-cleared`, `settings-venue-<p>`, `settings-preview`, `settings-save`,
`settings-reload`, `settings-reset`.

---

## 6. Risks and open points

- **Quoting before a wallet is connected**: AWK `QuoteParams.destAddress` is required and `refundAddress` feeds venue
  refunds. Resolved on the web (2026-11-12, ARCHITECTURE D7): `req` (live) still needs both addresses; before them the
  list shows preview prices whose per-venue sample destinations live only inside the engine's preview round
  (engine.md §2.7, providers.md §4.16), never in the UI, and are never reviewable. Pacing is advisory (D29).
- **Deposit-address routes for BTC/ZEC**: only NEAR Intents (1Click: one-time address, no memo) fits a plain QR.
  THORChain from BTC needs an OP_RETURN memo (`hasMemo`) and is listed as refused for QR payers. Confirm in the engine
  spec that a non-dry 1Click quote's `validUntilMs` is the deposit deadline.
- **Multi-tab**: without the heartbeat (§4.6/4.7) a second tab's `loadSwaps` would turn the first tab's running swap
  into `not-sent` (mobile `markInterrupted` assumes one process). `navigator.locks` exists in all current engines;
  the fallback (every tab polls) is safe but chattier.
- **Static coverage tables** in `providers.ts` (2026-10-20) decide `asked`. With providers running locally each also
  self-filters (`supportsRoute`), so a stale table only costs a wasted call or a missing venue; re-sync on AWK bumps.
- **Browser CORS per venue** is the engine spec's to prove; failures surface through the §4.2 texts, never as raw
  `TypeError`.
- **Logo licenses**: web3icons MIT (keep notice), Zcash CC0, provider/token marks are third-party trademarks used to
  identify venues/assets; the catalog mirror pulls from CMC/CoinGecko/Trust Wallet/DeBank CDNs — check the Trust
  Wallet assets repo licence before shipping the mirror; logos stay unmodified apart from resizing.
- **Fonts**: OFL requires `OFL.txt` next to the WOFF2s and forbids selling the font alone; the modified zero keeps the
  renamed family (already done upstream).
- **Prices from public APIs**: per-IP rate limits (CoinGecko ~30/min keyless) — one fetch per minute per tab, shared
  through react-query; an EVM native without a price makes the swap unsignable (`swapFeeCap` undefined → review
  shows `uncappedFeeText`), so a price outage blocks EVM swaps on non-ETH chains by design.
