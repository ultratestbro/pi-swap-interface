# Permissionless Swap Interface by cp0x

**cp0x Swap** is an open-source interface for swapping and bridging between chains, designed to be fully
permissionless. It compares routes from many venues at once: Uniswap, THORChain, Chainflip, NEAR Intents, LI.FI,
Relay, Jupiter, Circle CCTP, USDT0 and more. Your own wallet signs. There is no backend, no account and no fee.

The interface is a static web page. The [Any Wallet Kit](https://docs.anywallet.tech) swap providers run inside
your browser and check every answer there. In **Public** and **Custom** mode, and in every self-hosted, IPFS, `npx`
or Docker copy, your browser talks to each venue directly and no cp0x server sits in between. The hosted interface
also offers **Standard** mode, its default: quote requests and RPC calls go through cp0x's server, which adds cp0x's
API keys and RPC (fewer rate limits); it only carries the requests, signs nothing and never sees your keys, and
your browser still checks every quote and transaction (see [Connection modes](#connection-modes)).

- EVM chains of the Any Wallet Kit catalog (Ethereum, Arbitrum, Base, Optimism, BNB Chain, Polygon, Avalanche,
  HyperEVM, Monad, Elysium and others), Solana, Tron, TON and NEAR, signed by your wallet (EIP-6963 extensions,
  WalletConnect, Wallet Standard Solana wallets, TronLink, TON wallets through the official TON Connect — its own
  wallet picker over a bundled copy of its wallet list, or straight in a TON wallet's extension or in-app browser — and
  NEAR extension wallets that announce themselves the NEAR Connect way, such as HOT).
- Bitcoin, Zcash and other chains your browser wallet cannot sign for — and Tron, TON or NEAR without a connected
  wallet of theirs — through deposit-address routes: you get an address and a QR code, you send from any wallet, and
  refunds go to the address you enter.
- Tokens that aren't in the list, on EVM chains and Solana: paste the token's contract or mint address in the token
  picker. The page reads its decimals, symbol and name from the chain itself, shows a warning about look-alike copies,
  and keeps the token in your browser only once you confirm. Venues that trade any token (Uniswap, LI.FI, Jupiter, 0x,
  Fynd, Relay into a chain) quote it; imported tokens are never priced.
- Token approvals ([`#/revoke`](https://swap.cp0x.com/#/revoke)): what an EVM address still lets apps spend —
  ERC-20 and Permit2 allowances, NFT operator approvals — on every listed EVM network, most at risk first, and a revoke
  from your own wallet. Any address can be checked without connecting a wallet. The history comes from free indexers
  (Etherscan through cp0x's server in Standard mode, public Blockscout instances otherwise), and the page checks every
  approval against the chain itself before it shows it.

## Application links

- Interface: [swap.cp0x.com](https://swap.cp0x.com/), plus IPFS builds attached to every
  [release](../../releases)
- Website: [pi.cp0x.com](https://pi.cp0x.com/)
- Twitter: [@cp0xdotcom](https://x.com/cp0xdotcom)
- Telegram: [@cp0xdotcom](https://t.me/cp0xdotcom)

## Principles

- **Permissionless.** No geo-blocking, no IP checks, no address screening, no KYC and no sign-up. Nothing in this
  code decides who may swap.
- **No fee.** Every fee option of every provider is left unset, so cp0x takes nothing. A venue's own fee or spread
  is already inside its quote.
- **Private.** No trackers, error reporters, cookies or remote fonts. The hosted interface counts page views with
  Vercel Web Analytics (no cookies; the page's path only, never the `#` part; off with Do Not Track or Global
  Privacy Control); IPFS, `npx`, Docker and self-hosted copies have no analytics at all. Logos are bundled, never
  hotlinked. Only the hosted interface's Standard mode calls a cp0x server, and only to carry quote requests and RPC
  calls and to count each swap you send; Public and Custom mode, and
  every copy built without `VITE_CP0X_API`, never do. Your swap history stays in your browser.
- **Self-custodial.** Your keys stay in your wallet. The page asks the wallet to sign a transaction only after it
  has checked that the transaction matches the route you reviewed (see [Security model](#security-model)).
- **Runs anywhere.** One static build works on Vercel, from an IPFS CID, in Docker, with `npx` on your own machine,
  or from source.

## What cp0x guarantees, and what the venues do

cp0x controls only this interface. What it guarantees:

- It adds no restriction of its own: no country or IP blocks, no wallet screening and no token blacklist.
- It charges nothing, and the venue's quote is shown as the venue returned it.
- It contacts only the venues, the RPC endpoints, the price APIs (DefiLlama also prices a token you imported by its
  address, by that address), for such a token's logo DefiLlama's token icons and Trust Wallet's assets on GitHub,
  TonAPI once a TON wallet is connected (balances, the jetton wallet a USDT transfer leaves from) and, if you choose
  them, WalletConnect's relay or the TON Connect
  bridges (once you open TON Connect, its QR listens on the bridge of every wallet in its list until you close it;
  TON Connect's list server and analytics are never contacted: the list and its icons come with the page) — the
  hosted interface also its own host's page-view count — plus,
  in the hosted interface's Standard mode only, cp0x's proxy in place of the venues and RPCs it carries, and one
  count per swap you send, no transaction or time. Public and Custom mode never contact a cp0x server, and a copy built without
  `VITE_CP0X_API` contains no cp0x address at all.
- Before your wallet is asked to sign, the page checks every transaction against the route you reviewed. A
  transaction that does not match is refused.

The venues are independent services with their own rules, and cp0x cannot change them:

- **A venue's API may refuse a quote.** Venues that quote through an API (marked `API` below) apply their own
  policies. They may screen addresses against sanctions lists, block some countries or IP ranges, pause corridors
  or rate-limit. When a venue refuses, the route list shows its refusal as the venue sent it, and the other venues
  still answer.
- **Everyone you contact sees your IP address** and what you ask for: venue APIs, RPC providers and price APIs — and,
  in Standard mode, cp0x's proxy for what it carries. Quote requests contain the addresses and amounts of the swap.
  You can use Custom mode with your own RPC nodes, point the app at your own proxies (see
  [Runtime configuration](#runtime-configuration)), or use a VPN or Tor.
- **Settlement follows each venue's rules.** Bridges and intent networks settle on their own schedule. Refunds,
  timeouts and claims work as each venue documents.

[restricted.cp0x.com](https://restricted.cp0x.com) tracks how DeFi and Web3 interfaces restrict access.

## Venues

| venue | what it does | quotes come from | badge | default |
|---|---|---|---|---|
| Uniswap v3 | same-chain swaps on EVM chains | QuoterV2 contract, over your RPC | ON-CHAIN | on |
| Curve | same-chain swaps over a pinned list of checked pools (Ethereum, Arbitrum, Base, OP Mainnet, Gnosis, Monad, Plasma, X Layer) | Router NG `get_dy`, over your RPC | ON-CHAIN | on |
| Balancer v2 | same-chain swaps | Vault `queryBatchSwap`, over your RPC; paths from the Balancer API | ON-CHAIN | on |
| Wrap | native coin ⇄ wrapped native (ETH ⇄ WETH, …) | WETH9-style contract | ON-CHAIN | on |
| USDT0 | USDT0 between chains (LayerZero OFT) | OFT `quoteSend`, over your RPC; LayerZero Scan for status | ON-CHAIN | on |
| Circle CCTP V2 | USDC between chains (burn, then mint on the destination) | contracts; Circle's attestation API to mint | ON-CHAIN | on |
| THORChain | native cross-chain swaps (BTC, ETH, …) | THORNode API; two node operators cross-check the vault | NODE | on |
| Chainflip | cross-chain vault swaps | Chainflip swap API | API | on |
| NEAR Intents (1Click) | cross-chain intents, including deposit-address routes for BTC, ZEC and others | 1Click API | API | on |
| LI.FI | bridge and DEX aggregator (EVM, Solana) | LI.FI API | API | on |
| Relay | cross-chain fills | Relay API | API | on |
| Symbiosis | cross-chain swaps between EVM chains, to Tron and to TON, and from a TON wallet's USDT to EVM chains | Symbiosis API (paced to 1 request/s; in Standard mode through cp0x's proxy while cp0x holds its key) | API | on |
| Jupiter | Solana swaps | Jupiter API | API | on |
| Omniston (STON.fi) | HTLC orders between EVM chains and TON, including from a TON wallet's USDT to EVM chains; TON ↔ USDT swaps on TON through pinned STON.fi and DeDust contracts | Omniston WebSocket (needs site storage) | API | on |
| Fynd (Propeller Heads) | same-chain swaps over Tycho-indexed pools, settled through the Tycho router | Fynd API, through cp0x's proxy | API | Standard mode only |
| 0x | same-chain swaps on Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche and BNB Chain, settled through 0x's Settler (Permit2) | 0x Swap API v2, through cp0x's proxy; the Settler read from 0x's on-chain registry over your RPC | API | Standard mode only |
| Across | the same token between EVM chains (USDC, USDT, ETH, WBTC), a deposit to Across's SpokePool built in your browser | Across API, through cp0x's proxy; Across's relayer fee quote directly | API | Standard mode only |

Badges: **ON-CHAIN** means the quote and settlement come from contracts, with no company API in the path.
**NODE** means a THORChain node quotes it. **API** means a venue's API quotes it, and your browser checks the
answer before you sign. For example, the LI.FI provider decodes the Diamond call, the Relay provider re-hashes the
order and the Chainflip provider decodes the SCALE payload. Every venue is on by default: an operator can switch one
off in the runtime config, and a viewer for their own browser in Settings (a venue the operator switched off stays
off). Fynd runs only in the hosted build's Standard mode, while cp0x holds a key for it: its API
answers no browser directly (no CORS) and needs a key, so cp0x's proxy carries the request and adds the key. Its
routes settle only through the Tycho router, as the Fynd License requires, and the review of a Fynd route says so
(the licence asks for that notice); the app charges no fee on them. 0x and Across run the same way, only in Standard
mode while cp0x holds their keys: both APIs want a key on every request, and a key can't ship in a web page. Their
providers still run in your browser with every check: the 0x provider reads the Settler from 0x's on-chain registry,
decodes the transaction and rebuilds the Permit2 signature it asks for (one signature for exactly your amount, to that
Settler, valid for minutes; the approval goes to Permit2, never to a 0x contract), and the Across provider builds the
SpokePool deposit itself from your request, so the API only supplies numbers. The page sends cp0x's proxy a fixed
placeholder where the key goes; the proxy puts cp0x's own key in its place.

## Run it

### In the browser

Open the hosted interface, or an IPFS build. Every [GitHub release](../../releases) has the root CID, the CAR
file, a tarball of the same files and their SHA-256 sums attached. Open a release on a **subdomain gateway**
(`https://<cid>.ipfs.dweb.link/`) or on your own node (`ipfs://<cid>/`). Do not use path gateways such as
`https://ipfs.io/ipfs/<cid>/`: every site on them shares one origin, and so one browser storage. There, Omniston
stays off unless the release's own `runtime-config.json` turns it on (its swap secret is kept in that storage).

Your swap history and pending-swap records live in the browser storage of the exact origin you used. A different
URL, port or CID starts with an empty history.

### Docker

```sh
docker build -t cp0x/pi-swap-interface:local .
docker run --rm -p 127.0.0.1:8080:8080 --read-only --tmpfs /tmp --cap-drop ALL cp0x/pi-swap-interface:local
```

Or use Compose (optional config in `./config/runtime-config.json`):

```sh
mkdir -p config && cp public/runtime-config.example.json config/runtime-config.json   # then edit, or skip
docker compose -f docker/compose.yaml up -d --build
```

Open <http://127.0.0.1:8080/>. The image builds the app from source, then serves it with nginx as an
unprivileged user on port 8080, with the same headers as the hosted build. Mount a directory holding
`runtime-config.json` at `/config` to configure it without a rebuild. For anything other than this machine, put
HTTPS in front of it: NEAR Intents, Chainflip and Jupiter need a
[secure context](https://developer.mozilla.org/docs/Web/Security/Secure_Contexts). `docker/build.sh <version>`
builds and pushes the multi-arch `cp0x/pi-swap-interface` image.

### npx

```sh
npx @cp0x/pi-swap-interface
```

This serves the bundled build on `http://127.0.0.1:4370/` and opens your browser. It needs Node.js 22 or newer.
The server itself imports only Node's built-ins and downloads nothing at runtime. (The package is not on npm yet;
before it is, its runtime `dependencies` move out so `npx` installs only `bin/` and `dist/`.) Options: `--port <n>`, `--host <address>`,
`--config <file>` (served as `runtime-config.json`), `--allowed-host <name>`, `--no-browser`, `--help`. Keep
the same port between runs, because your history belongs to that origin.

### TON Connect manifest

A TON wallet names the page it connects to from `tonconnect-manifest.json` beside `index.html` (name, URL, icon).
The shipped file names the hosted interface, `https://swap.cp0x.com`. A copy on another origin should serve its own
— the same three keys, `url` its origin and `iconUrl` on it (the dist guard accepts nothing else): replace
`dist/tonconnect-manifest.json` before you serve or pin it, or mount yours over
`/usr/share/nginx/html/tonconnect-manifest.json` in the Docker image. Otherwise wallets show the hosted interface's
name and address when your copy connects. `tonconnect-wallets.json` is a copy of TON Connect's official wallet list
with its icons under `logos/ton-wallets/`; it stays as it is (`node .github/scripts/ton-wallets.mjs` refreshes both
in the repository).

### From source

```sh
pnpm install --frozen-lockfile
pnpm dev          # http://127.0.0.1:5173
pnpm build        # → dist/
node bin/cli.mjs  # serve dist/ with the production headers
```

Demo mode shows the whole interface with fixtures: no wallet, no network, nothing to sign. Add `?demo=1` to the
hash, as in `http://127.0.0.1:5173/#/?demo=1`. Add `&demoWallets=none|evm|solana|both` to choose which fake
wallets are connected.

### Vercel (your own deployment)

Import the repository with framework preset **Other**. `vercel.json` sets the install and build commands, the
`dist` output and every header. It adds no functions or middleware, your build counts no page views (that needs
`VITE_CP0X_API`, cp0x's hosted build only), and the build runs
`.github/scripts/guard-dist.mjs` on what it deploys. To have Vercel use the exact pnpm version in `package.json`,
set `ENABLE_EXPERIMENTAL_COREPACK=1`. Build-time configuration goes in the `VITE_SWAP_CONFIG` environment variable
(below). Leave `VITE_CP0X_API` unset: it points the Standard mode at cp0x's own server (next section).

## Connection modes

Settings → Connection picks how the page reaches the venues and RPCs. The choice is saved in this browser and
applies after a reload.

| mode | where requests go | contacts cp0x |
|---|---|---|
| **Standard** (hosted build only, its default) | LI.FI, Relay, NEAR Intents, Jupiter, Symbiosis, Fynd, 0x and Across while cp0x holds a key for them, the RPCs cp0x serves, and THORChain's vault check go through cp0x's swap-web proxy, which adds cp0x's keys. Everything else goes direct, the NEAR RPC included, and so does Across's relayer fee quote (`app.across.to`, keyless). Fynd, 0x and Across exist only here. Each swap you send is counted once. | yes, as a transport, plus the swap count |
| **Public** | Keyless public endpoints, straight from your browser. | never |
| **Custom** | Public, plus your own RPCs per EVM network and for Solana (tried first; the public ones stay as the fallback, unless you turn on "Use only my RPCs") and your own LI.FI, Relay, NEAR Intents (1Click JWT), Jupiter and Symbiosis (partner) keys. NEAR keeps the operator's `nearRpc`. | never |

In every mode the SDKs in your browser verify each quote, recipient, calldata and transaction, and your wallet signs
only after the page's own check; cp0x's proxy signs nothing and never sees a wallet key. Standard reads cp0x's
health answer at load (3 seconds at most, in the background): a venue goes through cp0x only while cp0x has its key,
an RPC network only when cp0x serves it, and if cp0x can't be reached the page simply runs as Public. A call that
fails at cp0x's proxy, or that the venue refuses for cp0x's key or server (401, 403, 429), is retried once at the
venue, which then stays direct: for a minute or so after a rate limit, until 00:00 UTC when cp0x's daily budget is
spent, otherwise until the page reloads. Your keys in Custom mode are stored only in this browser — anyone with access to this browser
profile can read them — and each goes only to its own venue, in a request header.

**Standard exists only in a build made with `VITE_CP0X_API`** (the cp0x API origin, `https:`; a bad value fails the
build). Every other build — IPFS releases, `npx`, Docker, a plain `pnpm build` — has no Standard mode, contains no
cp0x address and never contacts cp0x; CI checks both kinds of build. The hosted interface passes it per deploy,
with no project env change:

```sh
vercel deploy --build-env VITE_CP0X_API=https://cp0x-api.vercel.app            # preview
vercel deploy --prod --build-env VITE_CP0X_API=https://cp0x-api.vercel.app     # production
```

For local work against a cp0x API on your machine, `VITE_CP0X_API=http://localhost:3000 pnpm dev` (plain http is
accepted for localhost and 127.0.0.1 only; LI.FI and THORChain then stay direct, since their SDKs refuse http).

The app builds every proxy URL itself from `VITE_CP0X_API`, and uses each only in Standard mode and only while cp0x's
health answer allows it. **Never put a cp0x proxy URL in `VITE_SWAP_CONFIG`, `runtime-config.json` or saved
settings**: it would ignore both the mode and the health answer. The app drops any URL on the cp0x API origin or a
`/api/v2/swap-web` path from those layers (with a console warning), and the build's dist guard fails a bundle that
holds one.

## Runtime configuration

The app reads `./runtime-config.json` from beside `index.html` once per page load. Without one (a 404), it uses
its built-in defaults, which are all public, keyless endpoints. Settings apply in this order, and the later one
wins:

1. built-in defaults ([`src/config/defaults.ts`](src/config/defaults.ts));
2. `VITE_SWAP_CONFIG`, a JSON string read at build time (same shape as the file);
3. `runtime-config.json`;
4. the viewer's own saved settings (the Settings sheet, `localStorage` key `cp0x.swap.settings.v1`): API bases,
   venues, previews off, WalletConnect id. They never change `demo` or `nearIntents` (the operator's corridor pauses),
   cannot turn back on a venue the operator turned off, and are ignored on an IPFS path gateway (`/ipfs/…`, `/ipns/…`),
   where every site shares the origin. While any of them redirects a venue, a price API or an RPC, the swap screen and
   the review name each host;
5. `?demo=1` or `?demo=0` in the URL hash;
6. the [connection mode](#connection-modes) (`cp0x.swap.connection.v1`; Custom's keys in `cp0x.swap.keys.v1`):
   Custom puts your own RPCs first in their lists (named on the swap screen like any saved RPC), Standard adds cp0x's
   proxy. Ignored on an IPFS path gateway too.

Each section merges key by key, so write only what you change. `evmRpc` merges per chain id: an entry replaces
the list for that chain only. Arrays replace the whole array. An unknown key or invalid value is dropped with a
console warning, and the app still starts. URLs must be `https:`; `wss:` for Omniston; never with `user:pass@`
(browsers refuse to fetch those). RPCs may also be `http://localhost`, `http://127.0.0.1` or `http://[::1]`, but only
the local `npx` server allows plain http in its CSP: the hosted, Docker and IPFS builds connect to `https:` and
`wss:` only, so a local http RPC there breaks that chain (Settings refuses one when the page isn't served from this
machine). Changes take effect on the next page load.

[`public/runtime-config.example.json`](public/runtime-config.example.json) lists every key with its default.
Everything in this file is public, because the browser downloads it. **Never put a private key or a secret API
key in it.** An RPC key is only acceptable if its provider restricts it to your origin.

| key | default | what it does |
|---|---|---|
| `demo` | `false` | Fixtures only: no wallets, no network. |
| `providers.<name>` | `true` | Build that venue at all (`false` switches it off). Names: `uniswap curve balancer wrap usdt0 cctp thorchain chainflip near_intents lifi relay symbiosis jupiter omniston fynd zeroex across` (`fynd`, `zeroex` and `across` are built only in Standard mode). |
| `evmRpc.<chainId>` | public RPCs per chain | JSON-RPC URLs tried in order. Used for balances, simulation, provider reads and the wallet's chain definitions. |
| `solanaRpc` | publicnode, solanavibestation | Solana RPCs tried in order. `api.mainnet-beta.solana.com` is left out because it refuses browser origins. |
| `nearRpc` | FastNear | NEAR RPCs tried in order, asked directly in every mode, only once a NEAR wallet is connected. `[]` = no NEAR reads: balances stay unknown and a NEAR wallet's deposits are refused before signing. |
| `tonApiUrl` | `https://tonapi.io` | TonAPI base: a connected TON wallet's balances and the jetton wallet a jetton deposit or contract call leaves from (checked against the address the page computes, never trusted); Omniston. |
| `tronApi` | publicnode, TronGrid | Tron full-node HTTP APIs (`/wallet/*`) tried in order: balances, and a TronLink payment's reference block, broadcast and receipt. Asked only once a Tron wallet is connected. |
| `api.nearIntents` | `https://1click.chaindefuser.com/v0` | NEAR Intents 1Click API. |
| `api.lifi` | `https://li.quest/v1` | LI.FI API. |
| `api.cctp` | `https://iris-api.circle.com` | Circle attestation API. |
| `api.layerZeroScan` | `https://scan.layerzero-api.com` | USDT0 delivery status. |
| `api.chainflip` | `https://chainflip-swap.chainflip.io` | Chainflip swap API. |
| `api.relay` | `https://api.relay.link` | Relay API. |
| `api.jupiter` | `https://api.jup.ag/swap/v2` | Jupiter API. |
| `api.symbiosis` | `https://api.symbiosis.finance/crosschain` | Symbiosis API. |
| `api.balancer` | `https://api-v3.balancer.fi/` | Balancer path API. |
| `api.omnistonWs` | `wss://omni-ws.ston.fi` | Omniston WebSocket. |
| `api.thorNodes` | THORWallet, Liquify | THORNode bases, at least 2 distinct hosts. A second operator confirms the vault address. |
| `api.thorConfirmNodes` | `[]` | Extra confirming nodes. `[]` means the other `thorNodes` confirm each other. |
| `nearIntents.suspendedChains` | `{}` | Corridors to pause, as `{"<caip2>": "<reason>"}` or `"caip2=reason;…"`. They are refused by name. |
| `cctp.mode` | `auto` | `auto`, `fast` or `standard` CCTP transfers. |
| `thorchain.clientId` | `cp0x-swap` | `x-client-id` sent to THORNodes. |
| `omniston.maxUsd` | `1000` | Largest Omniston order in USD. |
| `omniston.evmSource` | `true` | Allow EVM sources on Omniston. |
| `pacing.symbiosisGapMs` | `1100` | Minimum gap between Symbiosis requests (its limit is 1 per second). |
| `pacing.jupiterGapMs` | `2100` | Minimum gap between Jupiter quotes (keyless limit 0.5 per second). |
| `preview.enabled` | `true` | Show preview prices before a wallet is connected or an address is typed. They are never reviewable; the live quote follows. A viewer's Settings can only turn it off. |
| `preview.roundsBurst` | `5` | Preview rounds a tab may run back to back (1–20). |
| `preview.roundRefillMs` | `20000` | One more preview round per this many ms (5000–600000). Advisory: each visitor asks the venues from their own IP. |
| `walletConnect.projectId` | `""` | WalletConnect Cloud project id. It is public by design. `""` hides WalletConnect. |
| `prices.defillama` | `https://coins.llama.fi` | Primary price API. |
| `prices.coingecko` | `https://api.coingecko.com/api/v3` | Fallback price API. |

Pointing any `api.*` base somewhere else changes whom you trust for quotes, deposit addresses and calldata. RPCs
are trusted too: they answer the ON-CHAIN quotes (Uniswap, Curve, Wrap, USDT0, CCTP, Balancer) and their minimums,
balances, allowances, the smart-account check and receipts, and the wallet may use the RPC list for a network it
does not know yet. The price APIs set the USD values and the fee caps. The contract allowlists (LI.FI targets,
THORChain routers, Omniston contracts) are compiled in and cannot be changed by config.

Example: your own Ethereum and Base nodes, Symbiosis on, WalletConnect on.

```json
{
  "evmRpc": {"1": ["https://eth.example.org"], "8453": ["https://base.example.org"]},
  "providers": {"symbiosis": true},
  "walletConnect": {"projectId": "<your public project id>"}
}
```

## Security model

- **Your wallet signs.** The page never holds a key. It asks your wallet for a signature, and the wallet's own
  prompt is the last check.
- **One choke point.** Only `src/execute/accounts/` may ask a wallet to sign or send. An ESLint rule and a CI grep
  (`.github/scripts/guard-wallet-writes.sh`) enforce this.
- **An in-page gate checks every transaction.** When you confirm, the reviewed route (venue, tokens, amount,
  recipient, refund address, minimum received, approval spender) is frozen. The engine's execution plan is checked
  against it before anything is armed. Each wallet write must then match one armed write exactly, or it is refused
  before your wallet sees it. One stray write disarms the rest. A token approval is for the exact amount, and it is
  revoked only if this run granted it. The one typed signature a swap may ask for besides a gasless order is 0x's
  Permit2 transfer: the page signs it only as Permit2's own one-time transfer, on this network, of exactly the
  reviewed token and amount, to the 0x Settler the transaction calls, valid for at most 10 minutes, and the swap that
  follows must carry exactly the signature your wallet returned. Smart-contract accounts are refused in this version. On Solana, the SDK
  checks the serialized transaction, simulates it and caps the fee before the wallet signs, and a signature over
  changed bytes fails. On Tron, the page builds the TRX or USDT transfer itself from the checked write, checks the
  bytes once more (deposit address or the venue's pinned vault, the catalog's token contract, the amount, the memo),
  asks TronLink only to sign, keeps the signature only if it is your account's over those bytes, and broadcasts
  them itself. On TON, the one TON Connect message the wallet gets is decoded back and checked against the same
  write: the deposit address, the amount and the comment, or, for a jetton, your own jetton wallet (computed in the
  page from the jetton's pinned wallet code — USDT only for now; other jettons are refused), the jetton amount,
  recipient and excess address. A TON contract call — a USDT transfer carrying the venue's instruction: Symbiosis to
  a token it releases directly on an EVM network, Omniston's escrow to a token on an EVM network, and Omniston's swap
  between TON and USDT on TON (the one call also paid in TON itself, sent straight to the DEX); Omniston's other TON
  swaps and a cross-chain call paid in TON are refused — is signed only as the exact bytes the venue built,
  read twice by the page (before anything is armed, and again on the TON Connect message): your own jetton wallet (or,
  paid in TON, the pinned DEX contract itself, your input plus the gas), at most 0.5 TON attached for gas, exactly the reviewed amount to the venue's pinned contract, the excess back to you,
  no custom payload, enough TON forwarded for the contract to act on it, the instruction's own fee leaving at least
  your reviewed minimum, then the venue's own verifier (its SDK package) against your reviewed recipient, refund path
  and minimum. Omniston's escrow is also read by the page itself (you as its owner and as where a failed creation
  refunds, enough TON for the escrow to be created, the reviewed network, token and recipient, at least the reviewed
  minimum, one hash lock) and signed only once the page has read back, from this
  browser's storage, the secret whose hash locks it — the secret is handed to Omniston only after the delivery on the
  EVM network was checked on chain; until then (or if the resolver never delivers) the escrow refunds you after its
  timeout. Keep site storage for this page: it is the only copy of that secret. Omniston's swap between TON and USDT
  is signed only in one step through a DEX contract whose address the app pins (STON.fi v1, STON.fi v2's TON/USDT
  router, DeDust v1 — never one a public index labels as a DEX), the page reading the DEX's swap itself: the router's
  wallet of the token you receive (or DeDust's pinned pool), at least your reviewed minimum on chain, your reviewed
  recipient, refunds and excess back to you, no referral, no chained swap or payload; then Omniston's own verifier with
  your review and the same pins. The swap carries no deadline of its own (Omniston sets none): the wallet's request
  expires within 5 minutes, and the on-chain minimum holds whenever it runs. Other DEXes (DeDust CPMM v2, TONCO,
  swap.coffee, other STON.fi routers), several hops and other tokens are listed as refused. On NEAR, the page builds the deposit transaction itself (a NEAR transfer, or the
  token's `ft_transfer`, to the deposit address), checks receiver, token, amount and memo again and that the account
  can pay the fee before the wallet signs and sends it, then holds the transaction the wallet reports to the one it
  built.
- **Strict Content-Security-Policy** on every distribution (headers on Vercel, Docker and `npx`; a `<meta>` copy
  in IPFS builds). The policy is defined once in [`bin/headers.mjs`](bin/headers.mjs):
  - `script-src 'self'`: only the bundle's own files run. No inline, third-party or eval'd code, and no
    WebAssembly.
  - `connect-src 'self' https: wss:`: open to any HTTPS host **on purpose**. Operators and users set their own RPCs
    and API bases, so a fixed host list would break them. Sending data anywhere still needs code, and
    `script-src` admits only the bundle.
  - `style-src 'self' 'unsafe-inline'`: the dialog and drawer libraries (Radix, vaul) insert `<style>` elements at
    runtime, and the scroll lock's CSS is computed per page, so it cannot be hashed. Inline styles cannot run code.
  - `img-src 'self' data: blob:` and `font-src 'self'`: everything is bundled, and wallet icons are `data:` URIs.
  - `frame-src https://verify.walletconnect.org`: WalletConnect's Verify iframe. Without it, every WalletConnect
    request would stall 5 seconds.
  - `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`.
  - With it: `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
    `Cross-Origin-Opener-Policy: same-origin-allow-popups` (wallet popups keep working), and a
    `Permissions-Policy` that turns off camera, microphone, geolocation, payment, USB, HID, serial and similar
    features, keeping only the clipboard for this origin (Paste and Copy).
- **Standard mode is transport only.** cp0x's proxy forwards requests and adds cp0x's keys; the answers reach the
  same in-browser checks as a direct answer, so a wrong answer from it is refused like a wrong answer from a venue.
  Wallets are never given its RPC address. It sees the quote requests and RPC calls it carries; use Public or Custom
  mode if you'd rather it didn't.
- **Pinned supply chain.** Dependencies are pinned exactly in `pnpm-lock.yaml`. CI installs with
  `--frozen-lockfile`, base images are pinned by digest, and GitHub Actions by commit SHA.
- **What the gate cannot do.** It stops mistakes by the engine or a provider. It cannot stop a compromised page:
  a malicious bundle could call the wallet directly. That is why the CSP is strict, there are no third-party scripts,
  every release can be rebuilt from its tag, and IPFS releases are content-addressed. Read your wallet's prompt.
- **Storage.** Relay's one-deposit-per-order record and the swap history are kept in IndexedDB. Without site
  storage, Relay refuses to sign (fail-closed) and Omniston is unavailable.

## Contributions

For local development, tests and code contribution, see [CONTRIBUTING](./CONTRIBUTING.md). The design and module
contracts are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

[Apache-2.0](LICENSE). Use at your own risk, without warranty. Third-party code, fonts and logos keep their own
licences (see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)). The WalletConnect packages are under the
WalletConnect and Reown community licences: Portions © 2025 Reown, Inc. All Rights Reserved.
