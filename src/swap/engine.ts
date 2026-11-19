/**
 * The AWK swap2 router over the page's REAL providers (engine.md §2.6, D2):
 * no remote stubs, no pins, no cp0x-api — every module checks its own
 * upstream answer before a quote is accepted.
 *
 *   quoteRoutes  — a dry quote from every venue that serves the pair, in
 *                  parallel; every venue that settles re-publishes the list
 *                  (best / fastest tagged by the SDK auction, after gas).
 *                  A live round quotes the user's addresses; a preview
 *                  round (D7, preview.ts) prices before they exist.
 *   requoteRoute — the one route the review shows, refreshed via only().
 *   swapStatus   — getSwap2Status for a tracked id (no account needed), plus
 *                  the venue's "deposit arrived" the SDK's status drops.
 *
 * Providers are built once per page and shared: routers are built over them
 * per round and never closed (close() would close the shared instances); the
 * providers close on pagehide only.
 */
import {CrossChainRouter, type RouteSet} from "@anywalletkit/protocol-swap2-router/router";
import {RouterSwap2Protocol} from "@anywalletkit/protocol-swap2-router/swap2/router";
import {usdValue} from "@anywalletkit/protocol-swap2-router/value";
import type {Swap2Refusal, Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import type {SwapStatus} from "../contracts/activity";
import type {QuoteRequest, RoutePick, RouteSnapshot, RoutesRequest, WebRoute} from "../contracts/routes";
import {destTokenId, publicClient} from "../catalog";
import {getRuntimeConfig, keyedOnly, proxySettled, proxyVenueLive} from "../config";
import {chainByCaip2} from "../shared";
import {gasPricer, ROUTER_RANKING, type QuoteGasLike} from "./gas";
import {createVenueBackoff, type VenueBackoff} from "./limiter";
import {lazyLoads} from "./omnistonLazy";
import {KEYED_PREVIEW_VENUES, previewAddressing, previewBaseParams, previewSkip, scrubSamples} from "./preview";
import {delegate, isLive} from "./providerWrappers";
import {buildProviders, closeProviders} from "./providers";
import {GATE_REASONS, gateCode, RATE_LIMITED} from "./refusals";
import {reportRefused} from "../activity/counter";
import {orderRoutes, parseRejections, tagRoutes} from "./routes";
import {createProviderStores} from "./stores";
import {sourceParams} from "./source";
import {preferSoonBest, toWebRoute} from "./webRoute";

type Prices = Readonly<Record<string, number>>;

/**
 * Live quote params from explicit addresses (D7): `destAddress` = the request's
 * recipient, `refundAddress` = its refund address — never `to.owner` and never
 * an SDK placeholder. Throws when either is blank, or when handed a preview
 * (its runtime brand), so neither a made-up address nor a preview can reach a
 * live quote, a re-quote or a deposit even if a caller forgets the rule. An
 * imported source (D39) is named by its contract with the decimals read
 * on-chain (`sourceDecimals`); an imported destination is its contract, as any.
 */
export function quoteParams(req: QuoteRequest): QuoteParams {
  if ((req as {preview?: unknown}).preview !== undefined) throw new Error("A preview can't be quoted live: it has no addresses of yours.");
  if (!req.recipient?.trim() || !req.refundAddress?.trim()) throw new Error("A recipient and a refund address are needed to quote.");
  return {
    sourceChain: req.from.caip2,
    ...sourceParams(req.from),
    destChain: req.to.caip2,
    destToken: destTokenId(req.to),
    amountIn: req.amountIn.toString(),
    slippageBps: req.slippageBps,
    destAddress: req.recipient,
    refundAddress: req.refundAddress,
    dry: true,
  };
}

/** The venues a round asks: the router's own eligibility predicate (router chunk-7ZUNB2U7.js:203-214), D17. */
export function eligibleProviders(providers: readonly CrossChainProvider[], params: Pick<QuoteParams, "sourceChain" | "sourceToken" | "destChain" | "destToken">): string[] {
  const from = {chain: params.sourceChain, token: params.sourceToken};
  const to = {chain: params.destChain, token: params.destToken};
  const same = params.sourceChain === params.destChain;
  return providers
    .filter((p) => {
      try {
        return p.enabled() && p.supportsRoute(from, to) && (!same || p.supportsSameChain === true);
      } catch {
        return false;
      }
    })
    .map((p) => p.name);
}

/**
 * Every enabled venue, in ask order: with `asked`, what the route list's "Not for this pair" group is built from. A
 * venue whose live gate is shut (Fynd without cp0x's key, or paused) is left out: it serves no pair right now.
 */
export function enabledVenues(providers: readonly CrossChainProvider[]): string[] {
  return providers
    .filter((p) => {
      try {
        return p.enabled() && isLive(p);
      } catch {
        return false;
      }
    })
    .map((p) => p.name);
}

/** Mobile inflight.ts asStatus: an unknown provider state reads as pending, never as final. */
const KNOWN_STATUS: ReadonlySet<string> = new Set([
  "submitting",
  "not-sent",
  "pending",
  "action-required",
  "completed",
  "failed",
  "refund-pending",
  "refunded",
  "cancelled",
  "expired",
  "partial",
]);
const asStatus = (v: unknown): SwapStatus => (typeof v === "string" && KNOWN_STATUS.has(v) ? (v as SwapStatus) : "pending");

/** A signal that aborts when any of `signals` does. */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => c.abort(s.reason), {once: true});
  }
  return c.signal;
}

/** Resolves null once `signal` aborts, whatever the provider does with it: a cancelled round ends at once. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return Promise.race([p, new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null), {once: true}))]);
}

/** Resolves when `p` settles or after `ms`, whichever comes first; the timer is cleared either way. */
function within(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = () => clearTimeout(timer);
  return Promise.race([p, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]).then(done, done);
}

/**
 * How long a round waits for a provider still loading (Omniston's chunk, omnistonLazy) before it picks the venues to
 * ask. Only a page's first rounds wait; a venue still loading after this sits the round out (it reports itself off).
 */
export const LAZY_WAIT_MS = 2_000;

/**
 * cp0x's proxy as a preview round reads it (D7, D30): LI.FI, Fynd, 0x and Across (KEYED_PREVIEW_VENUES) are asked in a
 * preview only while it carries them with cp0x's key. The app's engine gets config's; without one (tests), never.
 */
export interface PreviewProxy {
  /** Resolves once the health check answered or gave up (at once on a page without Standard; 3 s at most). */
  settled(): Promise<void>;
  /** The venue's proxy slot carries traffic with cp0x's key right now (config proxyVenueLive). */
  live(venue: string): boolean;
  /** Marks the signal of such a venue's preview call: never sent keyless from an unused or stopped slot (config keyedOnly). */
  keyedOnly(signal: AbortSignal): AbortSignal;
}

export interface QuoteEngineDeps {
  /** The page's shared provider set (called lazily, once per use). */
  providers: () => CrossChainProvider[];
  /** The source chain's gas price in wei; null off EVM or when it doesn't answer. */
  gasPrice?: (caip2: string) => Promise<bigint | null>;
  /** Venues that answered with a rate limit sit out until their wait is over (D29); default one per engine. */
  backoff?: VenueBackoff;
  /** What a round waits for (up to LAZY_WAIT_MS) before it picks the venues: providers still loading; null = none. */
  loading?: (providers: readonly CrossChainProvider[]) => Promise<unknown> | null;
  /** cp0x's proxy for preview rounds: a preview round waits for its health answer and asks LI.FI, Fynd, 0x and Across only through it. */
  proxy?: PreviewProxy;
}

export interface QuoteEngine {
  /** The unpriced router over the shared providers (discovery, tracking, only()). Never closed. */
  router(): CrossChainRouter;
  /**
   * Every venue's dry quote for a live request or a preview (D7). `onUpdate`
   * fires first with every asked venue pending, then each time a venue settles
   * (quote, refusal or timeout). Resolves with the final list, or null when the
   * round was superseded: by `signal` when the caller passes one, else by the
   * next unsignalled call (the spec's generation guard). A superseded round's
   * requests are aborted. The snapshot carries the round's mode.
   */
  quoteRoutes(r: RoutesRequest, onUpdate: (s: RouteSnapshot) => void, prices?: Prices, signal?: AbortSignal): Promise<RouteSnapshot | null>;
  /**
   * The one route under review, re-quoted dry (25 s solo window): its venue alone, and of a venue with several routes
   * exactly the reviewed one (D47). route null = the venue no longer routes it, with why.
   */
  requoteRoute(req: QuoteRequest, route: RoutePick, prices?: Prices): Promise<{route: WebRoute | null; reason: string | null}>;
  /** `depositReceived`: the venue has seen a QR deposit arrive while the swap is still pending (D36). */
  swapStatus(id: string, fromChain: string): Promise<{status: SwapStatus; transactions: {hash: string; type?: string}[]; depositReceived?: true}>;
}

/** What every other same-chain venue reports for its one transaction (Uniswap, Wrap, Jupiter hard-code 15 s). */
const SAME_CHAIN_ETA_S = 15;
/** A cross-chain quote with no ETA ranks as slow as this (shown as "—"): an unknown is never the fastest. */
const UNKNOWN_CROSS_CHAIN_ETA_S = 3_600;

/**
 * The ETA the router ranks a quote by when the venue reported 0 or less (LI.FI same-chain): with 0 it would take
 * "Fastest" and the speed weight's full score — and win "Best" on a near price tie — while its row shows "—".
 */
export const etaForRanking = (sameChain: boolean): number => (sameChain ? SAME_CHAIN_ETA_S : UNKNOWN_CROSS_CHAIN_ETA_S);

/** An engine over any provider set: the app's singleton below, or in-process fakes in tests. */
export function createQuoteEngine(deps: QuoteEngineDeps): QuoteEngine {
  let shared: CrossChainRouter | null = null;
  const router = () => (shared ??= new CrossChainRouter(deps.providers(), ROUTER_RANKING));
  /** The last unsignalled round: the next one aborts it (the spec's generation guard). */
  let inflight: AbortController | null = null;
  const backoff = deps.backoff ?? createVenueBackoff();

  /** USD gas per quote for this request's source (0 when unknown — ranking stays on price). Mobile engine.ts sourceGas. */
  async function sourceGas(req: Pick<QuoteRequest, "from">, prices?: Prices): Promise<(q: QuoteGasLike) => number> {
    const evm = req.from.family === "evm";
    const wei = evm && deps.gasPrice ? await deps.gasPrice(req.from.caip2).catch(() => null) : null;
    const native = chainByCaip2(req.from.caip2)?.native.symbol;
    return gasPricer({evm, isToken: req.from.contract !== null}, wei, native ? prices?.[native] : undefined);
  }

  /** The source chain's native coin at its price, for a route's bridge fee in USD (toWebRoute); undefined while unpriced. */
  function sourceNative(req: Pick<QuoteRequest, "from">, prices?: Prices): {usd: number; decimals: number} | undefined {
    const native = chainByCaip2(req.from.caip2)?.native;
    const usd = native ? prices?.[native.symbol] : undefined;
    return native && usd !== undefined && usd > 0 ? {usd, decimals: native.decimals} : undefined;
  }

  async function quoteRoutes(r: RoutesRequest, onUpdate: (s: RouteSnapshot) => void, prices?: Prices, signal?: AbortSignal): Promise<RouteSnapshot | null> {
    const round = new AbortController();
    if (signal) {
      if (signal.aborted) return null;
      signal.addEventListener("abort", () => round.abort(signal.reason), {once: true});
    } else {
      inflight?.abort();
      inflight = round;
    }
    const live = () => !round.signal.aborted;
    // Like the router's own observer: a throwing screen callback must not break the round.
    const publish = (snap: RouteSnapshot) => {
      try {
        onUpdate(snap);
      } catch (e) {
        console.warn("quoteRoutes: onUpdate threw", e);
      }
    };
    const {mode, req} = r;
    // A preview's params carry the real addresses or blank; its per-venue placeholders are added below, per quote.
    const params = r.mode === "live" ? quoteParams(r.req) : previewBaseParams(r.req);
    const providers = deps.providers();
    const loading = deps.loading?.(providers);
    // A preview round asks LI.FI, Fynd, 0x and Across only while cp0x's proxy carries them, read from the health
    // answer: it waits for that answer first (3 s at most; at once once it is in, or off Standard). Live rounds don't:
    // the routing waits per request, and the proxy-only venues' whileLive gate is read as each round starts.
    const health = r.mode === "preview" ? deps.proxy?.settled() : undefined;
    if (loading || health) {
      await untilAborted(Promise.all([loading ? within(loading, LAZY_WAIT_MS) : null, health]), round.signal);
      if (!live()) return null;
    }
    const asked = eligibleProviders(providers, params);
    const venues = enabledVenues(providers);
    if (!asked.length) return {mode, routes: [], pending: [], rejections: [], asked: [], venues};

    const source = {chain: req.from.caip2, isToken: req.from.contract !== null};
    publish({mode, routes: [], pending: [...asked], rejections: [], asked, venues});
    const gas = await sourceGas(req, prices);
    if (!live()) return null;
    const native = sourceNative(req, prices);

    const valueUsd = prices && Object.keys(prices).length ? usdValue(prices, {gasUsd: (q) => gas(q)}) : undefined;
    const settled = new Set<string>();
    const sameChain = params.sourceChain === params.destChain;
    /** Venues that quoted an ETA of 0 or less (LI.FI same-chain), or none (null, swap2-core 0.15): ranked by etaForRanking, never "fastest". */
    const unknownEta = new Set<string>();
    /** Venues this round refused itself, sending nothing (preview-only skips, back-off): their rows are `skipped`. */
    const skipped = new Set<string>();
    // A preview's venue texts can repeat the sample address a venue was quoted for: it never reaches the list (D7).
    const scrub = r.mode === "preview" ? (text: string) => scrubSamples(text, [r.req.recipient, r.req.refundAddress]) : null;
    let latest: RouteSet["quotes"] = [];
    let done = false;
    const shown = (w: WebRoute): WebRoute =>
      unknownEta.has(w.provider) ? {...w, ...(sameChain ? {} : {etaSeconds: 0}), tags: w.tags.filter((t) => t !== "fastest")} : w;
    // The router's classified refusals (router 0.6.0): the same texts as its rejections, each with the venue's reason.
    // One refusal row per venue, and none for a venue that quoted: router 0.7.2 rejects each bad candidate of a venue's
    // several routes on its own (D47), and a venue with a route on screen hasn't refused the pair.
    const onePerVenue = (rows: RouteSnapshot["rejections"], quoted: ReadonlySet<string>) =>
      rows.filter((x, i) => !(x.provider && quoted.has(x.provider)) && (!x.provider || rows.findIndex((y) => y.provider === x.provider) === i));
    const view = (quotes: RouteSet["quotes"], pending: string[], refusals: readonly Swap2Refusal[]): RouteSnapshot => ({
      mode,
      // The default pick is never a route of over an hour while a sooner one exists (D47: CCTP's Standard from Linea).
      routes: orderRoutes(preferSoonBest(quotes.map((q) => shown(toWebRoute(q, source, gas, native, req.slippageBps))))),
      pending,
      rejections: onePerVenue(
        parseRejections(scrub ? refusals.map((x) => ({message: scrub(x.message), ...(x.reason ? {reason: x.reason} : {})})) : refusals, req.from).map((x) =>
          skipped.has(x.provider) ? {...x, skipped: true as const} : x,
        ),
        new Set(quotes.map((q) => q.provider)),
      ),
      asked,
      venues,
    });

    // Per round, each provider is observed through a delegate (same shared instance underneath): the router aborts a
    // provider's signal right after it settles, which is the moment its row leaves "pending" — whether it quoted,
    // refused, threw or timed out. The router's own onUpdate fires only once something was accepted. The delegate
    // also skips a venue that is backing off or sits out previews (a refusal, nothing sent), watches for a rate
    // limit, and — in a preview round only — gives a venue that needs one the destination family's sample address.
    // Whether cp0x's proxy carries LI.FI, Fynd, 0x and Across is read here, per round and venue, never once per page.
    let rounder: CrossChainRouter | null = null;
    const viaProxy = (name: string): boolean => deps.proxy?.live(name) ?? false;
    const limitedBy = (name: string) => (reason: string) => {
      if (RATE_LIMITED.test(reason)) backoff.limited(name, reason);
    };
    const emit = () => {
      if (done || !live() || !rounder) return;
      publish(view(latest, asked.filter((n) => !settled.has(n)), rounder.lastRefusals));
    };
    const observed = providers.map((p) => {
      // The venue's answer in this round, whether the router asks getQuote or — a venue with several routes, in a dry
      // round (D47: CCTP's Fast and Standard) — getQuotes: one of the two, once per venue and round.
      const ask = (qp: QuoteParams, s: AbortSignal | undefined, send: (own: QuoteParams, sig: AbortSignal) => Promise<Quote[]>): Promise<Quote[]> => {
        const settle = () =>
          queueMicrotask(() => {
            settled.add(p.name);
            emit();
          });
        const skip = (r.mode === "preview" ? previewSkip(p.name, r.req, viaProxy) : null) ?? backoff.refusal(p.name);
        const watch = limitedBy(p.name);
        let call: Promise<Quote[]>;
        if (skip) {
          skipped.add(p.name);
          qp.onRefusal?.(skip);
          call = Promise.resolve([]);
        } else {
          // Spreading the router's frozen per-venue params keeps its onRefusal recorder; ours reads it first.
          const own: QuoteParams = {
            ...qp,
            ...(r.mode === "preview" ? previewAddressing(p.name, r.req) : {}),
            // The venue's classification (swap2-core 0.12.0) goes on with its text: the router files both.
            onRefusal: (reason: string, info?: Swap2RefusalInfo) => {
              watch(reason);
              // A safety check refused the venue's route (a router it doesn't know, a vault it can't verify): once
              // per page and check to the swap statistics (D41). Not from previews: they quote with sample addresses.
              if (r.mode !== "preview" && info?.reason && GATE_REASONS.has(info.reason)) {
                reportRefused({venue: p.name, fromChain: r.req.from.caip2, toChain: r.req.to.caip2, kind: "gate", code: gateCode(info.reason, reason), once: true});
              }
              qp.onRefusal?.(reason, info);
            },
          };
          // A preview call to LI.FI or Fynd (asked only through cp0x's proxy) gets a signal of its own, marked so the
          // routing never sends it keyless from an unused or stopped slot; round.signal, every venue's, stays unmarked.
          const keyed = r.mode === "preview" && deps.proxy && KEYED_PREVIEW_VENUES.has(p.name) ? deps.proxy : null;
          const sig = s || keyed ? anySignal(s ? [s, round.signal] : [round.signal]) : round.signal;
          try {
            call = send(own, keyed ? keyed.keyedOnly(sig) : sig);
          } catch (e) {
            call = Promise.reject(e);
          }
          void call.then(
            (qs) => qs.length > 0 && backoff.quoted(p.name),
            (e: unknown) => watch(e instanceof Error ? e.message : String(e)),
          );
        }
        if (s) s.addEventListener("abort", settle, {once: true});
        else void call.finally(settle).catch(() => {});
        return untilAborted(call, round.signal).then((qs) =>
          (qs ?? []).map((q) => {
            if ((q.etaSeconds ?? 0) > 0) return q;
            unknownEta.add(p.name);
            return {...q, etaSeconds: etaForRanking(sameChain)};
          }),
        );
      };
      return delegate(p, {
        getQuote: (qp, s) => ask(qp, s, (own, sig) => p.getQuote(own, sig).then((q) => (q ? [q] : []))).then((qs) => qs[0] ?? null),
        ...(p.getQuotes ? {getQuotes: (qp: QuoteParams, s?: AbortSignal) => ask(qp, s, (own, sig) => p.getQuotes!(own, sig))} : {}),
      });
    });
    rounder = new CrossChainRouter(observed, {...ROUTER_RANKING, ...(valueUsd ? {valueUsd} : {})});
    try {
      const set = await rounder.getQuotes(params, {onUpdate: (s) => void (latest = s.quotes)});
      if (!live()) return null;
      done = true;
      return set ? view(set.quotes, [], set.refusals) : view([], [], rounder.lastRefusals);
    } finally {
      done = true;
      if (inflight === round) inflight = null;
    }
  }

  async function requoteRoute(req: QuoteRequest, picked: RoutePick, prices?: Prices): Promise<{route: WebRoute | null; reason: string | null}> {
    const {provider, routeId} = picked;
    const all = router();
    if (!all.hasProvider(provider)) return {route: null, reason: "Not available in this browser right now"};
    const one = all.only(provider);
    const gas = await sourceGas(req, prices);
    const native = sourceNative(req, prices);
    // A venue with several routes is asked for the reviewed one by its routeId (the router then calls getQuote with
    // it): never its list, whose best — CCTP's Standard, free — would replace the Fast the user picked (D47).
    const set = await one.getQuotes(routeId !== undefined ? {...quoteParams(req), routeId} : quoteParams(req));
    const q = set?.quotes.find((x) => x.provider === provider && x.routeId === routeId);
    if (q) return {route: tagRoutes([toWebRoute(q, {chain: req.from.caip2, isToken: req.from.contract !== null}, gas, native, req.slippageBps)])[0]!, reason: null};
    return {route: null, reason: parseRejections(one.lastRefusals, req.from)[0]?.reason ?? "No route right now"};
  }

  async function swapStatus(id: string, fromChain: string): Promise<{status: SwapStatus; transactions: {hash: string; type?: string}[]; depositReceived?: true}> {
    // swap2-core's getSwap2Status keeps a venue's state and delivery hash only (its mapStatus): a provider's
    // `depositReceived` — NEAR's KNOWN_DEPOSIT_TX / PROCESSING / INCOMPLETE_DEPOSIT, all still "pending" — is lost.
    // So this call's router sees the providers through delegates (same shared instances underneath, like a quote
    // round's) that note it for this call only: a QR deposit reads as arrived when the venue first sees it, not when
    // it settles (D36). No account: quote/track only. Never close(): the providers are the page's shared instances.
    let depositReceived = false;
    const observed = deps.providers().map((p) =>
      delegate(p, {
        trackIntent: async (ref) => {
          const s = await p.trackIntent(ref);
          if (s.depositReceived === true) depositReceived = true;
          return s;
        },
      }),
    );
    const tracker = new CrossChainRouter(observed, ROUTER_RANKING);
    const res = await new RouterSwap2Protocol(undefined, {fromChain, router: tracker}).getSwap2Status(id);
    return {
      status: asStatus(res.status),
      transactions: (res.transactions ?? []).map((t) => ({hash: t.hash, ...(t.type ? {type: t.type} : {})})),
      ...(depositReceived ? {depositReceived: true as const} : {}),
    };
  }

  return {router, quoteRoutes, requoteRoute, swapStatus};
}

// ── the page's engine ──

const GAS_TTL_MS = 20_000;
const GAS_TIMEOUT_MS = 2_500;
const gasPrices = new Map<string, {at: number; wei: bigint}>();

/** eth_gasPrice over the catalog's public client (runtime RPCs), cached 20 s; null when it doesn't answer in 2.5 s. */
async function evmGasPrice(caip2: string): Promise<bigint | null> {
  if (!caip2.startsWith("eip155:")) return null;
  const hit = gasPrices.get(caip2);
  if (hit && Date.now() - hit.at < GAS_TTL_MS) return hit.wei;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const wei = await Promise.race([
      publicClient(Number(caip2.slice("eip155:".length))).getGasPrice(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), GAS_TIMEOUT_MS);
      }),
    ]);
    gasPrices.set(caip2, {at: Date.now(), wei});
    return wei;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let registry: CrossChainProvider[] | null = null;

/** Every enabled provider, built once per page from runtime config (D2). */
export function appProviders(): CrossChainProvider[] {
  return (registry ??= buildProviders(getRuntimeConfig(), createProviderStores()));
}

const engine = createQuoteEngine({
  providers: appProviders,
  gasPrice: evmGasPrice,
  loading: lazyLoads,
  // Standard's proxy, read per preview round (config/standard.ts): never in Public, Custom or a build without the API.
  proxy: {settled: proxySettled, live: proxyVenueLive, keyedOnly},
});

/** The unpriced router over appProviders(): discovery, tracking and only(name). Never closed. */
export const appRouter = (): CrossChainRouter => engine.router();
export const quoteRoutes = engine.quoteRoutes;
export const requoteRoute = engine.requoteRoute;
export const swapStatus = engine.swapStatus;

// The one place providers close (Omniston's WebSocket): leaving the page. Nothing is built just by importing this.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (registry) closeProviders(registry);
  });
}
