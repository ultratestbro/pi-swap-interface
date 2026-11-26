# Logo sources and licences

Every logo here is a static file served with the app; nothing is hotlinked at runtime. The token, network and venue
files are copied unmodified (apart from the split described below) from the cp0x wallet, `apps/mobile/assets` at
commit `756b115`; the TON wallet and TON Connect images come from TON Connect (below).

## `networks/*.svg`, `tokens/*.svg` — web3icons (MIT)

Split one file per key from the wallet's generated `assets/logos.ts` (`NETWORK_LOGOS`, `TOKEN_LOGOS`), which
`apps/mobile/scripts/build-logos.mjs` builds from `@web3icons/core` (`dist/svgs/{networks,tokens}/branded`),
https://github.com/0xa3k5/web3icons, licensed MIT:

> MIT License
>
> Copyright (c) the web3icons authors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation
> the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of
> the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
> THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
> TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

Exceptions in `networks/`:

- `zcash.svg` — from the cp0x design handoff, originally spothq/cryptocurrency-icons (CC0 1.0, public domain).
- `elysium.svg` — LI.FI's chain icon (`lifinance/types`), its white square background removed.

`morph` has no network logo (a monogram is shown, as in the wallet).

## `tokens/png/*.png` — project marks

Rendered by `apps/mobile/scripts/build-token-logos.py` (normalized to the web3icons geometry, 80 / 120 px) from
cp0x.com's DAO delegation logos and each project's CoinGecko-listed logo or favicon. They are the projects'
trademarks, shown only to identify the asset; they are not relicensed here.

## `providers/*.png` — venue marks

Rendered by `apps/mobile/scripts/build-provider-logos.py` (32 / 64 px tiles) from the Any Wallet Kit landing's logo
set (the brands' own marks; cp0x-drawn tiles for Uniswap, Balancer and Wrap), Fynd's docs icon, and Relay's and
Symbiosis' touch icons. Third-party trademarks used nominatively to name each venue; no endorsement is implied.

`curve.png`, `curve@2x.png` — Curve's mark from `tokens/CRV.svg` (web3icons, MIT, above), rendered here (2026-11-12)
the way that script renders Fynd's: the mark at 72 % of the tile, centred on the cp0x tile colour `#25222B`.

`zeroex.png`, `zeroex@2x.png` (0x) and `across.png`, `across@2x.png` (Across) — 0x's mark and Across Protocol's mark as
web3icons draws them for their tokens (`dist/svgs/tokens/branded/ZRX.svg` and `ACX.svg` of `@web3icons/core` 4.0.59,
MIT, above), rendered here (2026-11-15) the way Curve's is: the mark at 72 % of the tile, centred on `#25222B`, 32 /
64 px. 0x's and Across's trademarks, used nominatively to name each venue; no endorsement is implied, and they are not
relicensed here.

`cow.png`, `cow@2x.png` (CoW Protocol) — CoW Swap's mark on its blue tile as web3icons draws it for the exchange
(`dist/svgs/exchanges/background/cowswap.svg` of `@web3icons/core` 4.0.59, MIT, above), rendered here (2026-11-23) to
32 / 64 px with the tile filling the square. CoW DAO's trademark, used nominatively to name the venue; no endorsement
is implied, and it is not relicensed here.

`kyberswap.png`, `kyberswap@2x.png` (KyberSwap) — Kyber Network's mark (the KNC token's) on its green tile as
web3icons draws it (`dist/svgs/tokens/background/KNC.svg` of `@web3icons/core` 4.0.59, MIT, above), rendered here
(2026-11-26) to 32 / 64 px with the tile filling the square. Kyber Network's trademark; KyberSwap agreed in writing to
cp0x showing its name and logo as a route's source. Not relicensed here.

## `walletconnect.svg` — WalletConnect's icon

`Icon/Blue (Default)/Icon.svg` from WalletConnect's brand toolkit, https://github.com/WalletConnect/walletconnect-assets
(MIT), copied unmodified (2026-11-13). WalletConnect's trademark, shown only to name its connect option.

## `ton-wallets/*.png` — TON wallet marks

The `image` of every wallet in TON Connect's official wallets list, https://config.ton.org/wallets-v2.json, copied
2026-11-13 by `.github/scripts/ton-wallets.mjs` and downscaled to 96 px (PNG); `public/tonconnect-wallets.json` is
that list with each `image` pointed at its copy here. The wallets' own trademarks, shown only to name each wallet in
TON Connect's wallet picker; no endorsement is implied, and they are not relicensed here. Rerun the script to
refresh the list and its icons together.

## `tonconnect/ton-icon-48.png`, `tonconnect/tg.png` — TON Connect UI's own images

`assets/ton-icon-48.png` (the TON mark in the middle of its QR) and `assets/tg.png` (Telegram's mark on "Wallet in
Telegram") from https://github.com/ton-connect/sdk (Apache-2.0, like `@tonconnect/ui`, which hotlinks them from
there), copied unmodified (2026-11-13) and served instead by the build (`vite.config.ts`). TON's and Telegram's
trademarks, shown as the TON Connect UI shows them.

## `cp0x.png`, `cp0x@2x.png`, `cp0x@3x.png` — the cp0x logo

cp0x's own wordmark (white "cp" and "x", the cyan logo zero) from cp0x's brand file
`cp0x-logo-full-transparent.png` (2026-11-12), trimmed and scaled to 22 / 44 / 66 px high. The favicons in `public/`
are the same zero, from the wallet's app icon. cp0x trademarks: the repository's licence grants no right to use them
as marks.

## Not included

Catalog tokens without a bundled logo (about 40 rows, e.g. scrvUSD, GOMINING, wS) show a monogram. The catalog's
icon URLs (CoinMarketCap, CoinGecko, Trust Wallet, DeBank CDNs) are not mirrored: their terms do not grant
redistribution.
