/**
 * Every AWK swap2 provider this SPA runs, constructed once per page from
 * public runtime config (providers.md §6.2, D2/D3):
 * - no fee options (fee 0), no remoteProvider: each module checks its own
 *   upstream answer before a quote is returned. Keys only from the viewer's
 *   own browser in Custom mode (D30: LI.FI, Relay, NEAR Intents, Jupiter,
 *   Symbiosis); Standard mode's keys are added by cp0x's proxy, never seen here;
 * - ONE instance per provider for the page's lifetime (Relay's issued-quote
 *   memory, Omniston's WebSocket): routers are built over this array per
 *   request and never closed; the providers close on pagehide only;
 * - every venue on by default (D3; symbiosis, balancer and omniston since 2026-11-12, as on cp0x's server), each
 *   behind its runtime flag, which an operator or a viewer can switch off;
 * - fynd, zeroex (0x) and across only in Standard mode, through cp0x's proxy and only while health keys each (Fynd's
 *   API takes no browser calls and its key is cp0x's; 0x's and Across's keys can never ship in a page, D38: their
 *   modules run here, every check on this device, with a placeholder key the proxy replaces); never in Public or
 *   Custom.
 * Allowlists (LI.FI targets, THORChain routers, Omniston contracts) are code
 * here or in the SDK, never config.
 */
import type {CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import {balancerProvider} from "@anywalletkit/protocol-swap2-balancer/provider";
import {CCTP_DOMAINS} from "@anywalletkit/protocol-swap2-cctp/config";
import {cctpProvider} from "@anywalletkit/protocol-swap2-cctp/provider";
import {chainflipProvider} from "@anywalletkit/protocol-swap2-chainflip/provider";
import {curveProvider} from "@anywalletkit/protocol-swap2-curve/provider";
import {fyndProvider} from "@anywalletkit/protocol-swap2-fynd/provider";
import {FYND_CHAINS} from "@anywalletkit/protocol-swap2-fynd/router";
import {jupiterProvider} from "@anywalletkit/protocol-swap2-jupiter/provider";
import {lifiProvider} from "@anywalletkit/protocol-swap2-lifi/provider";
import {nearIntentsProvider} from "@anywalletkit/protocol-swap2-near-intents/provider";
import {relayProvider} from "@anywalletkit/protocol-swap2-relay/provider";
import {symbiosisProvider} from "@anywalletkit/protocol-swap2-symbiosis/provider";
import {thorchainProvider} from "@anywalletkit/protocol-swap2-thorchain/provider";
import {uniswapProvider} from "@anywalletkit/protocol-swap2-uniswap/provider";
import {usdt0Provider} from "@anywalletkit/protocol-swap2-usdt0/provider";
import {stargateProvider} from "@anywalletkit/protocol-swap2-stargate/provider";
import {wrapProvider} from "@anywalletkit/protocol-swap2-wrap/provider";
import {zeroExProvider} from "@anywalletkit/protocol-swap2-0x/provider";
import type {SettlerResolver} from "@anywalletkit/protocol-swap2-0x/settler";
import {zeroExChain, zeroExChainId, ZEROEX_CHAINS} from "@anywalletkit/protocol-swap2-0x/chains";
import {acrossProvider} from "@anywalletkit/protocol-swap2-across/provider";
import {ACROSS_CHAINS} from "@anywalletkit/protocol-swap2-across/config";
import type {ProviderName, RuntimeConfig, VenueKeys} from "../contracts/config";
import {getRuntimeConfig, standardFetch, standardProxyOnly, venueKeys, type ProxyOnlySlot} from "../config";
import {lazyOmniston} from "./omnistonLazy";
import {coolDownOnRateLimit, isWrapPair, narrowRoute, paced, payoutToSigner, whileLive, withQuoteGap} from "./providerWrappers";
import {rpcFailoverFetch} from "./rpcFailover";
import {createProviderStores, type ProviderStores} from "./stores";

/** li.quest/v1/chains names 0x198F… as Flare's Diamond; the canonical 0x1231… has no code there (server SRV:296-298). */
const LIFI_FLARE_DIAMOND: Readonly<Record<string, readonly string[]>> = {"eip155:14": ["0x198FC70Dfe05E755C81e54bd67Bff3F729344B9b"]};

/**
 * Built by default in every mode (D3), in the order the route list asks them: the same-network on-chain venues, the
 * bridges and cross-chain APIs, Jupiter, then Omniston (a lazy chunk that needs IndexedDB and opens a WebSocket).
 */
export const DEFAULT_ON_PROVIDERS: readonly ProviderName[] = [
  "uniswap",
  "curve",
  "balancer",
  "wrap",
  "usdt0",
  "stargate",
  "cctp",
  "thorchain",
  "chainflip",
  "near_intents",
  "lifi",
  "relay",
  "symbiosis",
  "jupiter",
  "omniston",
];

/** Built only in Standard mode, through cp0x's proxy (default on there; D3, D30, D38), after the others. */
export const STANDARD_ONLY_PROVIDERS: readonly ProviderName[] = ["fynd", "zeroex", "across"];

/**
 * The API key 0x's and Across's modules are built with on this page (D38): a fixed, public placeholder — never a key.
 * Each module refuses to quote without one and sends it only to its `baseUrl` (0x as `0x-api-key`, Across as
 * `Authorization: Bearer`), here cp0x's proxy slot, which drops it and adds cp0x's own. It reaches neither venue.
 */
export const PROXY_KEY_PLACEHOLDER = "cp0x-swap-web-proxy-adds-the-key";

/** How long a firm 0x quote is offered (the module's default is 45 s): long enough to outlive an Ethereum approval. */
export const ZEROEX_QUOTE_TTL_MS = 120_000;

/** The Settler resolver each built 0x provider reads the on-chain registry through (execute's pins answer from it). */
const settlerResolvers = new WeakMap<CrossChainProvider, SettlerResolver>();

/**
 * The 0x Settlers the page's 0x provider last read from the registry for `chain` (its resolver's fresh set: the one
 * in force, then the one it replaced), [] before a live quote read them or on a chain 0x doesn't serve here. Never the
 * API's word, and never touches the network (execute/pins.ts, the in-page gate's call targets).
 */
export function zeroExSettlers(providers: readonly CrossChainProvider[], chain: string): readonly string[] {
  const id = zeroExChainId(chain);
  if (!zeroExChain(ZEROEX_CHAINS, id)) return [];
  for (const p of providers) {
    const r = p.name === "zeroex" ? settlerResolvers.get(p) : undefined;
    if (r) return r.known(id);
  }
  return [];
}

/** The runtime RPC table keyed by CAIP-2 (usdt0, Omniston's validators take that shape). */
export const evmRpcByCaip2 = (rpc: RuntimeConfig["evmRpc"]): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(rpc)
      .filter(([, urls]) => urls.length > 0)
      .map(([id, urls]) => [`eip155:${id}`, [...urls]]),
  );

/** CCTP takes ONE RPC per chain: the first runtime URL for each listed EVM domain (rpcFailoverFetch adds the rest). */
const firstRpc = (rpc: RuntimeConfig["evmRpc"], caip2s: readonly string[]): Record<string, string> =>
  Object.fromEntries(
    caip2s.flatMap((c) => {
      const url = c.startsWith("eip155:") ? rpc[Number(c.slice("eip155:".length))]?.[0] : undefined;
      return url ? [[c, url]] : [];
    }),
  );

/** That one URL → its chain's whole runtime list, for rpcFailoverFetch. */
const failoverLists = (rpc: RuntimeConfig["evmRpc"], first: Record<string, string>): Record<string, readonly string[]> =>
  Object.fromEntries(Object.entries(first).map(([c, url]) => [url, rpc[Number(c.slice("eip155:".length))] ?? [url]]));

/**
 * What the page adds besides the config: the viewer's keys (Custom), Standard's routing fetch (for Relay's and
 * Symbiosis' fetchImpl) and Standard's proxy-only slots (Fynd, 0x, Across: without its slot a venue is not built).
 */
export interface ProviderExtras {
  keys?: VenueKeys;
  fetchImpl?: typeof fetch;
  fynd?: ProxyOnlySlot;
  zeroex?: ProxyOnlySlot;
  across?: ProxyOnlySlot;
}

/** The page's provider set. Call once (engine.ts caches it): a second set would lose Relay's issued-quote memory. */
export function buildProviders(
  config: RuntimeConfig = getRuntimeConfig(),
  stores: ProviderStores = createProviderStores(),
  extras: ProviderExtras = {
    keys: venueKeys(),
    fetchImpl: standardFetch(),
    fynd: standardProxyOnly("fynd"),
    zeroex: standardProxyOnly("zeroex"),
    across: standardProxyOnly("across"),
  },
): CrossChainProvider[] {
  const on = config.providers;
  const evm = config.evmRpc;
  const evmCaip = evmRpcByCaip2(evm);
  const keys = extras.keys ?? {};
  const out: CrossChainProvider[] = [];

  // ── default on, in DEFAULT_ON_PROVIDERS order ──
  if (on.uniswap) out.push(uniswapProvider({rpcUrls: evm}));
  // Router NG get_dy / exchange over the same RPC table (batches of ≤ 10), pinned pools only; keyless.
  if (on.curve) out.push(curveProvider({rpcUrls: evm}));
  // The SOR (its API) only suggests paths; the Vault prices them on-chain over the RPC table (queryBatchSwap).
  if (on.balancer) out.push(balancerProvider({rpcUrls: evm, apiUrl: config.api.balancer}));
  if (on.wrap) out.push(narrowRoute(wrapProvider({rpcUrls: evm}), isWrapPair));
  // The Legacy Mesh into TON and Tron (Ethereum USDT, Arbitrum USDT0) is named here, not left to the SDK's default
  // (TON only). Tron's LayerZero fee is above the engine's native-fee cap: execute.ts nativeFeeCeiling raises it for
  // that route alone (usdt0 0.5.0, core 0.11.0). A TON payout counts as delivered only once the operator's TonAPI shows
  // the jetton paid.
  if (on.usdt0) out.push(usdt0Provider({rpcUrls: evmCaip, scanUrl: config.api.layerZeroScan, tonApiUrl: config.tonApiUrl, meshDestinations: ["ton", "tron"]}));
  // Stargate V2 Taxi between its pinned pools / OFTs on 15 EVM networks (USDC, USDT, ETH, the WETH OFTs), keyless:
  // quoted from the pools over the RPC table on both networks, the sendToken call rebuilt and checked here, delivery
  // proven from finalized receipts on both. Bus is retired, compose and native drop stay off.
  // Its status finds the destination transaction on LayerZero Scan (the operator's, as USDT0's) and proves it on chain.
  if (on.stargate) out.push(stargateProvider({enabled: true, rpcUrls: evmCaip, scanUrl: config.api.layerZeroScan}));
  if (on.cctp) {
    const rpcUrls = firstRpc(evm, Object.keys(CCTP_DOMAINS));
    out.push(cctpProvider({apiUrl: config.api.cctp, mode: config.cctp.mode, rpcUrls, fetchImpl: rpcFailoverFetch(failoverLists(evm, rpcUrls))}));
  }
  if (on.thorchain) {
    out.push(
      thorchainProvider({
        nodeUrl: [...config.api.thorNodes],
        ...(config.api.thorConfirmNodes.length ? {confirmNodeUrl: [...config.api.thorConfirmNodes]} : {}),
        clientId: config.thorchain.clientId,
        // A Tron wallet pays only the venues with a Tron rule (execute's TRON_RULES); THORChain's stays dark, as on the server.
        tronSource: false,
      }),
    );
  }
  if (on.chainflip) out.push(chainflipProvider({apiUrl: config.api.chainflip}));
  // A viewer's key (Custom mode) goes only into its own venue's constructor; each SDK sends it as a header.
  if (on.near_intents)
    out.push(nearIntentsProvider({apiUrl: config.api.nearIntents, suspendedChains: {...config.nearIntents.suspendedChains}, ...(keys.nearIntents ? {jwt: keys.nearIntents} : {})}));
  if (on.lifi) {
    const lifi = lifiProvider({
      apiUrl: config.api.lifi,
      trustedTransactionTargets: LIFI_FLARE_DIAMOND,
      trustedApprovalAddresses: LIFI_FLARE_DIAMOND,
      ...(keys.lifi ? {apiKey: keys.lifi} : {}),
    });
    // One shared wrapper (D2): every round and the review's re-quote see the same wait. Asked EVM → Solana too: since
    // protocol-swap2-lifi 0.8.0 the SDK reads the Solana recipient (Mayan, Polymer CCTP, Chainflip) and refuses the rest.
    out.push(coolDownOnRateLimit(lifi));
  }
  if (on.relay) {
    // Relay takes a fetchImpl: in Standard mode it gets the proxy routing directly (LI.FI, NEAR Intents and Jupiter
    // reach it through the wrapped global fetch, having no such option).
    out.push(
      relayProvider({
        baseUrl: config.api.relay,
        clearedStore: stores.relayCleared,
        ...(keys.relay ? {apiKey: keys.relay} : {}),
        ...(extras.fetchImpl ? {fetchImpl: extras.fetchImpl} : {}),
      }),
    );
  }
  if (on.symbiosis) {
    // Standard mode: the proxy routing behind the pacer (its quoting and status calls through cp0x while health keys it).
    const send = extras.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    out.push(
      symbiosisProvider({
        apiUrl: config.api.symbiosis,
        tronSource: false,
        btcSource: false,
        ...(keys.symbiosis ? {apiKey: keys.symbiosis} : {}),
        // 1 request/s per IP on /v2/quote; the module fetches swap-limits then /v2/quote back to back. One pacer per
        // page: live rounds, previews and the review's re-quote all wait their turn in it. The same gap through
        // cp0x's proxy, whose key allows 10 req/s for every Standard viewer together. It spaces only starts, so the
        // routing sends Symbiosis' direct calls (a retry after a failure at the proxy included) through a pacer of
        // their own (standard.ts startConnection): this page never sends Symbiosis more than 1 request/s from its IP.
        fetchImpl: paced(config.pacing.symbiosisGapMs, send),
      }),
    );
  }
  if (on.jupiter) {
    // Outside the gap: a refused other-recipient quote never takes a turn of Jupiter's 0.5 req/s budget.
    const jupiter = jupiterProvider({apiUrl: config.api.jupiter, rpcUrls: [...config.solanaRpc], ...(keys.jupiter ? {apiKey: keys.jupiter} : {})});
    out.push(payoutToSigner(withQuoteGap(jupiter, config.pacing.jupiterGapMs)));
  }
  // A stand-in until its chunk loads, which starts at once (omnistonLazy); without durable storage it never loads.
  if (on.omniston) out.push(lazyOmniston(config, stores, evmCaip));

  // ── Standard only ──
  if (on.fynd && extras.fynd) {
    // No key here: the SDK gets cp0x's proxy as a keyless Fynd server per chain (`selfHosted`, which it calls at
    // `<url>/v1/quote`; standard.ts sends that on as the hosted API's `<chain>/quote`), and the proxy adds cp0x's key.
    // Asked only while the slot is live; never retried direct. The SDK's own checks and excluded protocols stand.
    const slot = extras.fynd;
    const selfHosted = Object.fromEntries(Object.entries(FYND_CHAINS).map(([id, c]) => [Number(id), `${slot.base}/${c.slug}`]));
    // rpcUrls: its pre-broadcast simulation and receipts (Standard's lists start with the proxy RPC).
    out.push(whileLive(fyndProvider({selfHosted, rpcUrls: evm}), slot.live));
  }
  if (on.zeroex && extras.zeroex) {
    // 0x Swap API v2, Permit2 flow, same network on its 7 chains (D38). The module's LOCAL provider runs here, so every
    // check runs on this device: the Settler read from 0x's on-chain registry over the page's RPCs (CREATE3 + pinned
    // window + code), the transaction decoded and held to the request, the Permit2 payload rebuilt. Its `baseUrl` is
    // cp0x's slot, which forwards `/swap/permit2/{price,quote}` to api.0x.org with cp0x's key in place of the
    // placeholder; it refuses an answer that came through a redirect or from another origin. Asked only while the slot
    // is live; never direct (no key here).
    //
    // quoteTtlMs: the engine signs the permit BEFORE the Permit2 approval and re-quotes when the approval outlives the
    // quote — and a re-quote is a new permit, so a 45 s quote (the module's default) against an Ethereum approval
    // (the wallet's prompt, then a block or two) asked for the permit twice: permit, approve, permit. 0x's permits
    // run 300 s and the module keeps a quote 20 s inside that; the Settler still holds the swap to the minimum.
    const slot = extras.zeroex;
    const zeroex = zeroExProvider({apiKey: PROXY_KEY_PLACEHOLDER, baseUrl: slot.base, rpcUrls: evm, quoteTtlMs: ZEROEX_QUOTE_TTL_MS});
    const live = whileLive(zeroex, slot.live);
    settlerResolvers.set(live, zeroex.settlerResolver);
    out.push(live);
  }
  if (on.across && extras.across) {
    // Across, EVM → EVM, the same asset, a direct SpokePool deposit (D38). The LOCAL provider encodes the deposit from
    // the pinned SpokePool and the request and verifies it here; API V5 (`POST /v1/quotes`) only prices it, through
    // cp0x's slot with cp0x's key in place of the placeholder. Across's keyless relayer fee
    // (app.across.to/api/suggested-fees, CORS *) stays straight from this browser, as the module defaults. Its RPCs (the
    // status read, the quote time when that fee quote doesn't answer) take ONE URL per chain, so, as for CCTP, the
    // first runtime URL with the rest of the chain's list behind it (rpcFailoverFetch, which also passes V5 and the fee
    // quote on to the global, Standard-routed fetch).
    const slot = extras.across;
    const rpcUrls = firstRpc(evm, Object.keys(ACROSS_CHAINS));
    out.push(
      whileLive(
        acrossProvider({apiKey: PROXY_KEY_PLACEHOLDER, baseUrl: slot.base, rpcUrls, fetchImpl: rpcFailoverFetch(failoverLists(evm, rpcUrls))}),
        slot.live,
      ),
    );
  }

  return out;
}

/** pagehide only (D2): closes Omniston's WebSocket; no other provider has close(). */
export function closeProviders(providers: readonly CrossChainProvider[]): void {
  for (const p of providers) {
    try {
      p.close?.();
    } catch {
      // A provider that fails to close must not stop the others.
    }
  }
}
