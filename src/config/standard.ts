/**
 * Standard mode at run time (ARCHITECTURE D30). The page is built once with every proxy slot in place
 * (connection.ts standardSlots), so which slots carry traffic is decided here, per request, from cp0x's health
 * answer:
 * - GET <API>/api/v2/swap-web/health once at boot, in the background (3 s timeout). A request bound for the proxy
 *   waits for it, never longer than that timeout; a failed or late answer leaves the page Public for its lifetime.
 * - A venue goes through the proxy only while health says "keyed": an anonymous venue there would share one server
 *   IP's quota with every visitor (D29). An RPC network only when health lists it; THORChain's vault check only
 *   while health.thornode is true. An unused venue slot is sent to the venue's public base (same path, query and
 *   body); an unused RPC or THORNode slot fails at once WITHOUT a request, so the client moves to its next URL.
 * - Per-call fallback: a venue call that fails AT THE PROXY (a network error, or `x-swap-web-answer: proxy` with
 *   400/403/404/405/413/414/429/5xx) is sent once more straight to the venue, and that venue stays direct. So is
 *   one the upstream refused with 401/403/429: that refuses cp0x's key or cp0x's server IP (health says "keyed" as
 *   soon as a key is set, not that it works), not this user's request. How long it stays direct: until 00:00 UTC
 *   after the proxy's 429 "daily budget spent" / "ip daily limit"; after any other 429 for its Retry-After (60 s
 *   without one, 5 min at most); otherwise for this page. Every other upstream answer passes through untouched,
 *   never retried. RPC and THORNode clients fall back on their own (each moves to its next URL on a non-2xx or a
 *   network error); a failure there only stops the slot being used, the same way.
 * - A proxy-only venue (Fynd: no CORS on its API, cp0x's key; 0x and Across: a key no page may hold, D38) never goes
 *   direct: an unused slot fails at once WITHOUT a request, like an RPC slot, and a failure at the proxy or an upstream
 *   401/403/429 only stops the slot (the answer goes back to the SDK as it came). providers.ts asks each only while
 *   its slot is live (`standardProxyOnly`). Fynd's SDK path under the per-chain endpoint it is given
 *   (`<chain>/v1/quote`) is sent as the proxy's, the hosted API's path under its /v1 base (`<chain>/quote`); 0x's and
 *   Across's modules call their own API paths under the slot (`/swap/permit2/{price,quote}`, `/v1/quotes`), sent as
 *   they come, with the placeholder key their modules insist on, which the proxy drops for cp0x's.
 * - A venue whose SDK calls more than the proxy forwards (Symbiosis: the proxy's exact paths, PROXIED_PATHS) sends any
 *   other call straight to its public base, like an unused slot, and it stops nothing.
 * - A venue can have its own sender for the calls that go straight to its public base (`direct`): Symbiosis' is
 *   paced to its keyless 1 request/s per IP, so a direct retry after a failure at the proxy and the next call, which
 *   providers.ts' pacer spaces only by their starts, never leave this page less than that gap apart.
 * - A preview call to a venue previews ask only with cp0x's key (LI.FI, D7; `keyedOnly` marks its signal) never goes
 *   straight to the venue from an unused or stopped slot: it fails at once WITHOUT a request, like an RPC slot. The
 *   one retry after a failure at the proxy stays, once per slot and page, so previews send that venue at most one
 *   keyless call in the page's life: the slot it stopped keeps later previews from asking it (`proxyVenueLive`), and a
 *   later failure at the proxy, once a stop for a Retry-After or until 00:00 UTC has run out, retries nothing.
 *
 * Why a fetch wrapper: the LI.FI, NEAR Intents, Jupiter, Fynd and 0x SDKs take only a base URL (no fetchImpl), and so do
 * THORChain's node lists and the RPC clients (viem, @solana/kit, the SDKs' own loops). Relay and Symbiosis (behind
 * its pacer) do take a fetchImpl and get this same function (providers.ts); Across takes one too, and gets the RPC
 * failover that calls the global (so wrapped) fetch. The wrapper is installed once at boot in
 * Standard mode only, matches a request by the exact proxy prefix (`<base>/venue/<name>` followed by "/", "?" or the
 * end, `<base>/rpc/<chain>`) and hands every other request to the original fetch with the same arguments, byte for
 * byte.
 */
import {useSyncExternalStore} from "react";
import type {ConnectionMode, ConnectionStatus, ProxyVenue} from "../contracts/config";
import {PROXY_VENUES, type StandardPlan} from "./connection";
import {paced} from "./pacing";
import {getRuntimeConfig, pageConnection} from "./runtime";

/** cp0x's /health answer, as far as the app reads it. */
export interface SwapWebHealth {
  venues: Readonly<Partial<Record<ProxyVenue, "keyed" | "anonymous">>>;
  rpc: {configured: boolean; chains: readonly string[]};
  /** The THORNode confirm pass-through is on (absent on an older server: false). */
  thornode: boolean;
}

/** The slots that carry traffic. */
export interface ProxyRoutes {
  venues: ReadonlySet<ProxyVenue>;
  rpc: ReadonlySet<string>;
  thornode: boolean;
}

/** A request's proxy slot. */
export type ProxyTarget = {kind: "venue"; venue: ProxyVenue; rest: string} | {kind: "rpc"; network: string} | {kind: "thornode"};

export const HEALTH_TIMEOUT_MS = 3_000;
/** Says who answered: "proxy" (its own refusal or failure) or "upstream" (the venue's or node's own answer). */
export const ANSWER_HEADER = "x-swap-web-answer";
/** Triage only, on proxy-bound requests that already need a CORS preflight (never x-cp0x-app: that is the mobile app's). */
export const VERSION_HEADER = "x-cp0x-swap-web";
/** The proxy's own failures a venue call is retried direct on (5xx too). */
const VENUE_FAILURES: ReadonlySet<number> = new Set([400, 403, 404, 405, 413, 414, 429]);
/** Upstream answers that refuse cp0x — its key (revoked, mistyped, over the venue's per-key limit) or its server IP — rather than the request. */
const REFUSES_CP0X: ReadonlySet<number> = new Set([401, 403, 429]);
/** A 429 with one of these lasts until 00:00 UTC (the proxy's daily allowance, its own or this IP's share). */
const DAILY_LIMIT = /^(daily budget spent|ip daily limit)$/;
/** Any other 429 stops the slot for its Retry-After, within these bounds (ms); 60 s when it names none. */
export const BACKOFF_MS = {min: 1_000, default: 60_000, max: 5 * 60_000} as const;
const NO_ROUTES: ProxyRoutes = {venues: new Set(), rpc: new Set(), thornode: false};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The health answer, or null when it isn't one (then the page stays Public). */
export function parseHealth(raw: unknown): SwapWebHealth | null {
  if (!isObj(raw) || !isObj(raw.venues) || !isObj(raw.rpc)) return null;
  const venues: Partial<Record<ProxyVenue, "keyed" | "anonymous">> = {};
  for (const v of PROXY_VENUES) venues[v] = raw.venues[v] === "keyed" ? "keyed" : "anonymous";
  const chains = Array.isArray(raw.rpc.chains) ? raw.rpc.chains.filter((c): c is string => typeof c === "string" && /^(\d{1,12}|solana)$/.test(c)) : [];
  return {venues, rpc: {configured: raw.rpc.configured === true, chains}, thornode: raw.thornode === true};
}

/**
 * The health overlay: which of the page's proxy slots carry traffic. A venue only while "keyed", an RPC network
 * only when listed (and RPC is configured), THORNode only while on — each only if the page has that slot. Nothing
 * when the check failed.
 */
export function healthRoutes(health: SwapWebHealth | null, plan: StandardPlan): ProxyRoutes {
  if (!health) return NO_ROUTES;
  return {
    venues: new Set(PROXY_VENUES.filter((v) => plan.venues[v] !== undefined && health.venues[v] === "keyed")),
    rpc: new Set(health.rpc.configured ? health.rpc.chains.filter((c) => plan.rpc.has(c)) : []),
    thornode: plan.thornode && health.thornode,
  };
}

/** Fynd's SDK path under its per-chain endpoint (`<base>/venue/fynd/<chain>`, providers.ts): `/<chain>/v1/quote`. */
const FYND_SDK_PATH = /^\/([a-z0-9-]+)\/v1\/quote$/;

/**
 * Where a venue request goes at the proxy: Fynd's SDK path becomes the hosted API's under the proxy's /v1 base
 * (`/venue/fynd/ethereum/v1/quote` → `/venue/fynd/ethereum/quote`, the contract with cp0x-api); every other venue's
 * URL is sent as it came.
 */
export function proxyVenueUrl(url: string, base: string, target: {venue: ProxyVenue; rest: string}): string {
  const fynd = target.venue === "fynd" ? FYND_SDK_PATH.exec(target.rest) : null;
  return fynd ? `${base}/venue/fynd/${fynd[1]}/quote` : url;
}

/**
 * The paths the proxy forwards for a venue it forwards only some calls of (the contract with cp0x-api, its
 * `swapWeb/venues.ts` routes, matched exactly); a venue not listed has all of its calls forwarded. Symbiosis: its
 * quoting (`GET /v1/swap-limits`, `POST /v2/quote`) and the status calls `trackIntent` makes after a swap
 * (`GET /v2/tx/<chainId>/<hash>`, `GET /v1/stucked/<EVM address>`), each with no query (the proxy refuses one with a
 * 400). Any other shape — another path, a query, a non-EVM address — would get the proxy's 404 or 400 and take
 * Symbiosis off cp0x for the page, so it goes straight to Symbiosis, stopping nothing.
 */
const PROXIED_PATHS: Readonly<Partial<Record<ProxyVenue, RegExp>>> = {
  symbiosis: /^\/(?:v1\/swap-limits|v2\/quote|v2\/tx\/[1-9]\d{0,9}\/(?:0x)?[0-9a-fA-F]{64}|v1\/stucked\/0x[0-9a-fA-F]{40})$/,
};

/** The proxy forwards this venue call (PROXIED_PATHS). */
const forwarded = (target: {venue: ProxyVenue; rest: string}): boolean => PROXIED_PATHS[target.venue]?.test(target.rest) ?? true;

/** The slot a URL is bound for, or null for anything else (the health URL and unknown paths included). */
export function proxyTarget(url: string, base: string): ProxyTarget | null {
  if (!url.startsWith(`${base}/`)) return null;
  const path = url.slice(base.length);
  for (const venue of PROXY_VENUES) {
    const p = `/venue/${venue}`;
    if (path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`)) return {kind: "venue", venue, rest: path.slice(p.length)};
  }
  if (path === "/venue/thornode" || path.startsWith("/venue/thornode/")) return {kind: "thornode"};
  const rpc = /^\/rpc\/(\d{1,12}|solana)$/.exec(path);
  return rpc ? {kind: "rpc", network: rpc[1]!} : null;
}

const targetKey = (t: ProxyTarget): string => (t.kind === "venue" ? `venue:${t.venue}` : t.kind === "rpc" ? `rpc:${t.network}` : "thornode");

/** The next 00:00 UTC after `now` (ms). */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** A request in a form that can be sent twice (the proxy, then the venue). */
interface Prepared {
  url: string;
  init: RequestInit;
  /** False for a streamed body, which can be read only once: then there is no direct retry. */
  replayable: boolean;
}

async function prepare(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Prepared> {
  if (typeof input === "string" || input instanceof URL) {
    const b = init?.body;
    const replayable = b == null || typeof b === "string" || b instanceof ArrayBuffer || ArrayBuffer.isView(b) || b instanceof URLSearchParams || b instanceof Blob;
    return {url: String(input), init: init ?? {}, replayable};
  }
  // A Request object (none of the SDKs here sends one): its body is read once, so it can be sent twice.
  const method = (init?.method ?? input.method).toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await input.clone().arrayBuffer();
  const signal = init?.signal ?? input.signal;
  return {url: input.url, init: {method, headers: init?.headers ?? input.headers, ...(body ? {body} : {}), signal, cache: input.cache, redirect: input.redirect}, replayable: true};
}

/** A request the browser already preflights (a JSON POST, a custom header): one more allowed header costs nothing then. */
function preflighted(method: string, headers: Headers): boolean {
  if (!["GET", "HEAD", "POST"].includes(method.toUpperCase())) return true;
  for (const [k, v] of headers) {
    if (k === "accept" || k === "accept-language" || k === "content-language") continue;
    if (k === "content-type" && /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)\s*(;|$)/i.test(v)) continue;
    return true;
  }
  return false;
}

/**
 * The app version header, only on a request that is preflighted anyway: on a simple GET it would add a preflight,
 * and Chrome keys its preflight cache by URL, so every LI.FI /quote query would pay one.
 */
function tagged(init: RequestInit, version: string | null): RequestInit {
  if (!version) return init;
  const headers = new Headers(init.headers);
  if (!preflighted(init.method ?? "GET", headers)) return init;
  headers.set(VERSION_HEADER, version);
  return {...init, headers};
}

const fromProxy = (res: Response): boolean => res.headers.get(ANSWER_HEADER) !== "upstream";

/** A venue call's answer that means the slot failed: the proxy's own failure, or the upstream refusing cp0x. */
const venueSlotFailed = (res: Response): boolean => (fromProxy(res) ? VENUE_FAILURES.has(res.status) || res.status >= 500 : REFUSES_CP0X.has(res.status));

/** The same for RPC and THORNode, except the proxy's 400 / 413: they refuse one call (a method it doesn't forward, an oversized batch), not the slot. */
const clientSlotFailed = (res: Response): boolean => venueSlotFailed(res) && !(fromProxy(res) && (res.status === 400 || res.status === 413));

/** A Retry-After (seconds, or an HTTP date) as a wait in ms, within BACKOFF_MS. */
export function backoffMs(retryAfter: string | null, now: number): number {
  const v = retryAfter?.trim() ?? "";
  const ms = /^\d+$/.test(v) ? Number(v) * 1_000 : v ? Date.parse(v) - now : NaN;
  return Number.isFinite(ms) ? Math.min(BACKOFF_MS.max, Math.max(BACKOFF_MS.min, ms)) : BACKOFF_MS.default;
}

/**
 * How long a slot stays unused after the failure `res`: until 00:00 UTC for the proxy's daily limit, for the
 * Retry-After of any other 429 (the proxy's per-minute window, a venue's per-key limit), else for the page.
 */
async function unusedUntil(res: Response, now: number): Promise<number> {
  if (res.status !== 429) return Infinity;
  if (fromProxy(res)) {
    const body: unknown = await res
      .clone()
      .json()
      .catch(() => null);
    if (isObj(body) && typeof body.error === "string" && DAILY_LIMIT.test(body.error)) return nextUtcMidnight(now);
  }
  return now + backoffMs(res.headers.get("retry-after"), now);
}

/** Thrown instead of sending a request to a slot that carries no traffic: the client moves to its next URL. */
export const UNUSED_SLOT = "cp0x proxy not in use for this request";

/** Signals of preview calls to a venue previews ask only with cp0x's key (keyedOnly): the page's one set. */
const keyedOnlySignals = new WeakSet<AbortSignal>();

/**
 * Marks `signal` (the one a preview round gives LI.FI, D7; the SDK passes it on to fetch): a venue call made with it
 * is never sent straight to the venue's public base from an unused or stopped slot — it fails at once WITHOUT a
 * request, like an RPC slot. Only the one retry after a failure at the proxy itself still goes direct, once per slot
 * and page (the slot is stopped then, so the round's next call and later previews send nothing; once a short stop runs
 * out and the proxy fails again, the call fails without a keyless retry). Returns `signal`.
 */
export function keyedOnly(signal: AbortSignal): AbortSignal {
  keyedOnlySignals.add(signal);
  return signal;
}

const isKeyedOnly = (init: RequestInit): boolean => !!init.signal && keyedOnlySignals.has(init.signal);

/** What the wrapper needs: the plan, the routing state and the original fetch. */
export interface ProxyFetchDeps {
  plan: StandardPlan;
  /** Resolves once the health check answered or gave up. */
  settled(): Promise<void>;
  /** The slot carries traffic now (health allows it and no failure stopped it). */
  live(key: string): boolean;
  /** Stop using a slot until `until` (ms; Infinity = this page). */
  stop(key: string, until: number): void;
  /** The original fetch: every other request goes to it unchanged. */
  fetch: typeof fetch;
  /**
   * A venue's own sender for the calls that go straight to its public base (the retry after a failure at the proxy,
   * an unused or stopped slot, a path the proxy doesn't forward); `fetch` for a venue without one. Symbiosis: paced
   * to its keyless 1 request/s per IP (startConnection).
   */
  direct?: Readonly<Partial<Record<ProxyVenue, typeof fetch>>>;
  now(): number;
  /** Sent as x-cp0x-swap-web when it is semver; null = never. */
  version: string | null;
}

/** The proxy-routing fetch (see the file comment). */
export function createProxyFetch(d: ProxyFetchDeps): typeof fetch {
  // Venue slots whose one keyless retry a keyed-only preview call has had on this page (D7). A stop for a Retry-After
  // runs out within minutes, so without this every later failure at the proxy would buy another keyless call.
  const keylessRetried = new Set<string>();
  /** The retry straight to the venue after a failure at the proxy: a keyed-only call gets it once per slot and page. */
  const mayRetryDirect = (key: string, init: RequestInit): boolean => {
    if (!isKeyedOnly(init)) return true;
    if (keylessRetried.has(key)) return false;
    keylessRetried.add(key);
    return true;
  };
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const target = proxyTarget(url, d.plan.base);
    if (!target) return d.fetch(input, init);
    // A venue without a slot on this page (a viewer's own base, LI.FI against a plain-http API): not ours to route.
    // null is a proxy-only venue's slot (Fynd, 0x, Across): routed below, never direct.
    const publicBase = target.kind === "venue" ? d.plan.venues[target.venue] : undefined;
    if (target.kind === "venue" && publicBase !== null && !publicBase) return d.fetch(input, init);
    // Every call that goes straight to the venue's public base, through its own sender if it has one (Symbiosis' pacer).
    const toVenue = (target.kind === "venue" ? d.direct?.[target.venue] : undefined) ?? d.fetch;
    // A call the proxy doesn't forward: never bound for it, so straight to the venue, no health wait (a keyed-only
    // preview call: nothing).
    if (target.kind === "venue" && publicBase && !forwarded(target)) {
      const req = await prepare(input, init);
      if (isKeyedOnly(req.init)) throw new TypeError(UNUSED_SLOT);
      return toVenue(`${publicBase}${target.rest}`, req.init);
    }
    await d.settled();
    const req = await prepare(input, init);
    const key = targetKey(target);

    if (target.kind === "venue" && publicBase) {
      const direct = `${publicBase}${target.rest}`;
      if (!d.live(key)) {
        // A preview call to a venue previews ask only with cp0x's key: no keyless call from an unused or stopped slot.
        if (isKeyedOnly(req.init)) throw new TypeError(UNUSED_SLOT);
        return toVenue(direct, req.init);
      }
      let res: Response;
      try {
        res = await d.fetch(req.url, tagged(req.init, d.version));
      } catch (e) {
        // The caller gave up (a superseded round, its own timeout): not the proxy's failure.
        if (req.init.signal?.aborted) throw e;
        d.stop(key, Infinity);
        if (!req.replayable || !mayRetryDirect(key, req.init)) throw e;
        return toVenue(direct, req.init);
      }
      if (!venueSlotFailed(res)) return res;
      d.stop(key, await unusedUntil(res, d.now()));
      if (!req.replayable) return res;
      // A keyed-only call whose slot already had its keyless retry: nothing keyless, and not the proxy's answer either
      // (its 429 would read as LI.FI's own and cool LI.FI off the live quote, coolDownOnRateLimit).
      if (!mayRetryDirect(key, req.init)) throw new TypeError(UNUSED_SLOT);
      return toVenue(direct, req.init);
    }

    // RPC and THORNode: the client tries its next URL itself, so an unused slot sends nothing at all. A proxy-only
    // venue (Fynd, 0x, Across) the same way: there is nowhere else to send it.
    if (!d.live(key)) throw new TypeError(UNUSED_SLOT);
    const sent = target.kind === "venue" ? proxyVenueUrl(req.url, d.plan.base, target) : req.url;
    let res: Response;
    try {
      res = await d.fetch(sent, tagged(req.init, d.version));
    } catch (e) {
      if (!req.init.signal?.aborted) d.stop(key, Infinity);
      throw e;
    }
    if (target.kind === "venue" ? venueSlotFailed(res) : clientSlotFailed(res)) d.stop(key, await unusedUntil(res, d.now()));
    return res;
  };
}

/** One page's Standard runtime: the health check, the routing state, the wrapper and the status it reports. */
export interface StandardRuntime {
  fetch: typeof fetch;
  /** The venue's slot carries traffic now (false while health is still checking). */
  venueLive(venue: ProxyVenue): boolean;
  /** Resolves once the health check answered or gave up (HEALTH_TIMEOUT_MS at most after start). */
  settled(): Promise<void>;
  /** Run the health check (once). */
  start(): Promise<void>;
  status(): ConnectionStatus;
  subscribe(cb: () => void): () => void;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const sameStatus = (a: ConnectionStatus, b: ConnectionStatus): boolean =>
  a.mode === b.mode &&
  a.health === b.health &&
  a.rpcNetworks === b.rpcNetworks &&
  a.thornode === b.thornode &&
  sameList(a.keyed, b.keyed) &&
  sameList(a.viaProxy, b.viaProxy) &&
  sameList(a.fellBack, b.fellBack);

export function createStandardRuntime(
  plan: StandardPlan,
  opts: {fetch: typeof fetch; direct?: ProxyFetchDeps["direct"]; timeoutMs?: number; now?: () => number; version?: string | null},
): StandardRuntime {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
  let routes: ProxyRoutes | null = null;
  const stopped = new Map<string, number>();
  const listeners = new Set<() => void>();
  let resolveSettled!: () => void;
  const settledP = new Promise<void>((r) => (resolveSettled = r));
  let started: Promise<void> | null = null;

  const live = (key: string): boolean => {
    if (!routes || (stopped.get(key) ?? 0) > now()) return false;
    if (key === "thornode") return routes.thornode;
    if (key.startsWith("rpc:")) return routes.rpc.has(key.slice(4));
    return routes.venues.has(key.slice(6) as ProxyVenue);
  };

  let answer: SwapWebHealth | null = null;
  const snapshot = (): ConnectionStatus => ({
    mode: "standard",
    health: routes === null ? "checking" : answer ? "ok" : "unreachable",
    keyed: answer ? PROXY_VENUES.filter((v) => answer!.venues[v] === "keyed") : [],
    viaProxy: PROXY_VENUES.filter((v) => live(`venue:${v}`)),
    fellBack: PROXY_VENUES.filter((v) => !!routes?.venues.has(v) && !live(`venue:${v}`)),
    rpcNetworks: routes ? [...routes.rpc].filter((n) => live(`rpc:${n}`)).length : 0,
    thornode: live("thornode"),
  });
  // Read afresh on every status() call, since a stop can run out (a Retry-After, 00:00 UTC) with no event; the same
  // object while nothing changed, as useSyncExternalStore needs.
  let current = snapshot();
  const refresh = (): ConnectionStatus => {
    const next = snapshot();
    if (!sameStatus(current, next)) current = next;
    return current;
  };
  const changed = () => {
    const before = current;
    if (refresh() !== before) for (const cb of listeners) cb();
  };

  const settle = (health: SwapWebHealth | null) => {
    if (routes) return;
    answer = health;
    routes = healthRoutes(health, plan);
    resolveSettled();
    changed();
  };

  const version = opts.version !== undefined ? opts.version : (import.meta.env.VITE_APP_VERSION ?? null);
  const wrapped = createProxyFetch({
    plan,
    settled: () => settledP,
    live,
    stop: (key, until) => {
      stopped.set(key, Math.max(stopped.get(key) ?? 0, until));
      changed();
      // An open Settings sheet hears when the slot carries traffic again.
      if (Number.isFinite(until)) setTimeout(changed, Math.max(0, until - now()) + 10);
    },
    fetch: opts.fetch,
    ...(opts.direct ? {direct: opts.direct} : {}),
    now,
    version: version && SEMVER.test(version) ? version : null,
  });

  return {
    fetch: wrapped,
    venueLive: (venue) => live(`venue:${venue}`),
    settled: () => settledP,
    start() {
      started ??= (async () => {
        // The timer settles the page even if the answer never comes; a late answer is ignored (the page stays Public).
        const timer = setTimeout(() => settle(null), timeoutMs);
        try {
          const res = await opts.fetch(`${plan.base}/health`, {headers: {accept: "application/json"}, cache: "no-store", signal: AbortSignal.timeout(timeoutMs)});
          settle(res.ok ? parseHealth(await res.json()) : null);
        } catch {
          settle(null);
        } finally {
          clearTimeout(timer);
        }
      })();
      return started;
    },
    status: refresh,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

// ── the page's connection ──

const offStatus = (mode: ConnectionMode): ConnectionStatus => ({mode, health: "off", keyed: [], viaProxy: [], fellBack: [], rpcNetworks: 0, thornode: false});

let runtime: StandardRuntime | null = null;
let offline: ConnectionStatus = offStatus("public");
const noop = () => () => {};

/**
 * Boot (main.tsx, after loadRuntimeConfig and before the app loads, so every module sees the wrapped fetch): in
 * Standard mode, install the proxy-routing fetch and start the health check in the background. Any other mode —
 * Public, Custom, demo, a build without VITE_CP0X_API — installs nothing and contacts no cp0x host.
 */
export function startConnection(): void {
  const page = pageConnection();
  if (page.mode !== "standard" || !page.plan) {
    offline = offStatus(page.mode);
    return;
  }
  if (runtime) return;
  const original = globalThis.fetch.bind(globalThis);
  // Symbiosis' direct calls get a pacer of their own: keyless, it allows 1 request/s per IP, and providers.ts' pacer
  // spaces only starts, so a call retried direct after a slow failure at the proxy would otherwise go out right
  // before the next call's turn (also direct, the slot now stopped).
  const direct = {symbiosis: paced(getRuntimeConfig().pacing.symbiosisGapMs, original)};
  runtime = createStandardRuntime(page.plan, {fetch: original, direct});
  globalThis.fetch = runtime.fetch;
  void runtime.start();
}

/** Standard mode's routing fetch, for SDKs that take a fetchImpl (Relay, Symbiosis behind its pacer); undefined in every other mode. */
export const standardFetch = (): typeof fetch | undefined => runtime?.fetch;

/** A proxy-only venue's slot as providers.ts builds it: its base at the proxy, and whether it carries traffic now. */
export interface ProxyOnlySlot {
  base: string;
  live(): boolean;
}

/** The venues only cp0x's proxy reaches (connection.ts PROXY_ONLY), as providers.ts builds them. */
export type ProxyOnlyVenue = "fynd" | "zeroex" | "across";

/**
 * A proxy-only venue's slot on this page (Standard only, and only when the page builds that venue), else undefined:
 * the venue is then not built at all. Live only while health says "keyed" and no failure stopped it, so a page
 * without cp0x's key for it never asks it (no refusal row either).
 */
export function standardProxyOnly(venue: ProxyOnlyVenue): ProxyOnlySlot | undefined {
  const plan = pageConnection().plan;
  const rt = runtime;
  if (!rt || !plan || plan.venues[venue] !== null) return undefined;
  return {base: `${plan.base}/venue/${venue}`, live: () => rt.venueLive(venue)};
}

/** Fynd's slot (standardProxyOnly). */
export const standardFynd = (): ProxyOnlySlot | undefined => standardProxyOnly("fynd");

/**
 * cp0x's proxy carries this venue's calls with cp0x's key right now: a Standard page, health "keyed" and the slot not
 * stopped after a failure or a daily limit. False in Public and Custom, on a build without the API, before health
 * answers and after it failed. Preview rounds read it per round (D7): LI.FI, Fynd, 0x and Across are asked only while
 * it holds.
 */
export function proxyVenueLive(venue: string): boolean {
  return !!runtime && (PROXY_VENUES as readonly string[]).includes(venue) && runtime.venueLive(venue as ProxyVenue);
}

/** Resolves once this page's health check answered or gave up (3 s at most); at once on a page without Standard. */
export const proxySettled = (): Promise<void> => runtime?.settled() ?? Promise.resolve();

/** This page's connection status (Settings). */
export const connectionStatus = (): ConnectionStatus => runtime?.status() ?? offline;

/** The connection status, re-rendering when the health answer lands or a venue falls back. */
export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(runtime ? runtime.subscribe : noop, connectionStatus, connectionStatus);
}
