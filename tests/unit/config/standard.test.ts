// Standard mode at run time (D30): the health answer, which proxy slots carry traffic, and the routing fetch —
// exact-prefix matching, one direct retry on the proxy's own failure, the daily limit until 00:00 UTC, upstream
// answers untouched, every other request byte-identical; Symbiosis' calls the proxy doesn't forward go direct, and its
// direct calls keep a pacer of their own.
import {afterEach, describe, expect, it, vi} from "vitest";
import {standardSlots, type StandardPlan} from "../../../src/config/connection";
import {DEFAULT_RUNTIME_CONFIG} from "../../../src/config/defaults";
import {paced} from "../../../src/config/pacing";
import {
  BACKOFF_MS,
  UNUSED_SLOT,
  backoffMs,
  createProxyFetch,
  createStandardRuntime,
  healthRoutes,
  keyedOnly,
  nextUtcMidnight,
  parseHealth,
  proxyTarget,
  proxyVenueUrl,
  type ProxyFetchDeps,
  type SwapWebHealth,
} from "../../../src/config/standard";

const API = "https://cp0x-api.example.org";
const BASE = `${API}/api/v2/swap-web`;
const PLAN: StandardPlan = standardSlots(DEFAULT_RUNTIME_CONFIG, API).plan;
const HEALTH: SwapWebHealth = {
  venues: {lifi: "keyed", relay: "keyed", near_intents: "anonymous", jupiter: "anonymous"},
  rpc: {configured: true, chains: ["8453", "solana", "424242"]},
  thornode: true,
};

/** The same, with cp0x holding a Fynd key. */
const FYND_KEYED: SwapWebHealth = {...HEALTH, venues: {...HEALTH.venues, fynd: "keyed"}};
/** Fynd's SDK request as providers.ts sets it up (its per-chain endpoint + `/v1/quote`), and where the proxy takes it. */
const FYND_SDK = `${BASE}/venue/fynd/ethereum/v1/quote`;
const FYND_PROXY = `${BASE}/venue/fynd/ethereum/quote`;
const FYND_INIT = {method: "POST", headers: {"content-type": "application/json"}, body: '{"orders":[]}'};

/** The same, with cp0x holding a Symbiosis key. */
const SYMBIOSIS_KEYED: SwapWebHealth = {...HEALTH, venues: {...HEALTH.venues, symbiosis: "keyed"}};
/** Symbiosis' public base (the built-in default) and its SDK's quoting calls, as the SDK sends them. */
const SYMBIOSIS = "https://api.symbiosis.finance/crosschain";
const SYM_QUOTE = `${BASE}/venue/symbiosis/v2/quote`;
const SYM_LIMITS = `${BASE}/venue/symbiosis/v1/swap-limits`;
/** Its status calls after a swap (`trackIntent`): the source transaction, then the stuck list of an EVM address. */
const SYM_TX = `/v2/tx/8453/0x${"ab".repeat(32)}`;
const SYM_STUCK = "/v1/stucked/0x1111111111111111111111111111111111111111";
const SYM_QUOTE_INIT = {method: "POST", headers: {accept: "application/json", "content-type": "application/json"}, body: '{"tokenAmountIn":{"amount":"1"}}'};
const SYM_LIMITS_INIT = {method: "GET", headers: {accept: "application/json"}};

/** A Response the proxy itself gave (`who` = "proxy") or passed through from upstream. */
const answer = (status: number, body: unknown, who: "proxy" | "upstream" | null = "upstream", extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json", ...(who ? {"x-swap-web-answer": who} : {}), ...extra}});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the health answer", () => {
  it("reads venues, RPC chains and the THORNode flag; anything else is not an answer", () => {
    expect(parseHealth({venues: {lifi: "keyed", relay: "nope"}, rpc: {configured: true, chains: ["1", "solana", "../x", 5]}, thornode: true})).toEqual({
      venues: {lifi: "keyed", relay: "anonymous", near_intents: "anonymous", jupiter: "anonymous", symbiosis: "anonymous", fynd: "anonymous", zeroex: "anonymous", across: "anonymous"},
      rpc: {configured: true, chains: ["1", "solana"]},
      thornode: true,
      etherscan: false,
    });
    // An older server has no thornode field: off. The Etherscan slot (D46) only while keyed.
    expect(parseHealth({venues: {}, rpc: {configured: false, chains: []}})?.thornode).toBe(false);
    expect(parseHealth({venues: {etherscan: "keyed"}, rpc: {configured: false, chains: []}})?.etherscan).toBe(true);
    expect(parseHealth({venues: {etherscan: "anonymous"}, rpc: {configured: false, chains: []}})?.etherscan).toBe(false);
    for (const bad of [null, "ok", {}, {venues: {}}, {venues: [], rpc: {}}]) expect(parseHealth(bad)).toBeNull();
  });

  it("the overlay: a venue only while keyed, an RPC network only when listed (and the page has its slot), THORNode only while on", () => {
    const r = healthRoutes(HEALTH, PLAN);
    expect([...r.venues]).toEqual(["lifi", "relay"]);
    expect([...r.rpc]).toEqual(["8453", "solana"]);
    expect(r.thornode).toBe(true);
    expect(healthRoutes({...HEALTH, rpc: {configured: false, chains: ["8453"]}}, PLAN).rpc.size).toBe(0);
    expect(healthRoutes({...HEALTH, thornode: false}, PLAN).thornode).toBe(false);
    expect(healthRoutes(HEALTH, {...PLAN, thornode: false}).thornode).toBe(false);
    // Fynd: its proxy-only slot carries traffic only while keyed.
    expect(PLAN.venues.fynd).toBeNull();
    expect([...healthRoutes(FYND_KEYED, PLAN).venues]).toEqual(["lifi", "relay", "fynd"]);
    expect(parseHealth({venues: {fynd: "keyed"}, rpc: {configured: false, chains: []}})?.venues.fynd).toBe("keyed");
    // Symbiosis: a venue with a public base, like LI.FI; through the proxy only while keyed.
    expect(PLAN.venues.symbiosis).toBe(SYMBIOSIS);
    expect([...healthRoutes(SYMBIOSIS_KEYED, PLAN).venues]).toEqual(["lifi", "relay", "symbiosis"]);
    expect(parseHealth({venues: {symbiosis: "keyed"}, rpc: {configured: false, chains: []}})?.venues.symbiosis).toBe("keyed");
    // A venue the page gave no slot (the viewer's own base) stays direct even when keyed.
    expect([...healthRoutes(HEALTH, {...PLAN, venues: {relay: PLAN.venues.relay}}).venues]).toEqual(["relay"]);
    // No answer: nothing goes through the proxy.
    const none = healthRoutes(null, PLAN);
    expect([none.venues.size, none.rpc.size, none.thornode]).toEqual([0, 0, false]);
  });

  it("the next 00:00 UTC", () => {
    expect(nextUtcMidnight(Date.UTC(2026, 10, 12, 23, 59, 59))).toBe(Date.UTC(2026, 10, 13));
    expect(nextUtcMidnight(Date.UTC(2026, 11, 31, 0, 0, 0))).toBe(Date.UTC(2027, 0, 1));
  });
});

describe("proxyTarget: the exact proxy prefix", () => {
  it("matches a venue followed by /, ? or the end — never a longer name, another path or another host", () => {
    expect(proxyTarget(`${BASE}/venue/lifi/quote?a=1`, BASE)).toEqual({kind: "venue", venue: "lifi", rest: "/quote?a=1"});
    expect(proxyTarget(`${BASE}/venue/lifi?a=1`, BASE)).toEqual({kind: "venue", venue: "lifi", rest: "?a=1"});
    expect(proxyTarget(`${BASE}/venue/near_intents`, BASE)).toEqual({kind: "venue", venue: "near_intents", rest: ""});
    expect(proxyTarget(`${BASE}/venue/lifix/quote`, BASE)).toBeNull();
    expect(proxyTarget(`${BASE}/venue/thornode/thorchain/inbound_addresses`, BASE)).toEqual({kind: "thornode"});
    expect(proxyTarget(`${BASE}/rpc/8453`, BASE)).toEqual({kind: "rpc", network: "8453"});
    expect(proxyTarget(`${BASE}/rpc/solana`, BASE)).toEqual({kind: "rpc", network: "solana"});
    expect(proxyTarget(`${BASE}/rpc/8453/x`, BASE)).toBeNull();
    expect(proxyTarget(`${BASE}/health`, BASE)).toBeNull();
    expect(proxyTarget(`${API}/api/v2/swap-webx/venue/lifi`, BASE)).toBeNull();
    expect(proxyTarget("https://li.quest/v1/quote", BASE)).toBeNull();
    expect(proxyTarget(FYND_SDK, BASE)).toEqual({kind: "venue", venue: "fynd", rest: "/ethereum/v1/quote"});
    expect(proxyTarget(SYM_QUOTE, BASE)).toEqual({kind: "venue", venue: "symbiosis", rest: "/v2/quote"});
    expect(proxyTarget(`${BASE}/venue/symbiosisx/v2/quote`, BASE)).toBeNull();
  });

  it("Fynd's SDK path goes to the proxy as the hosted API's path under its /v1 base; every other venue's URL as it came", () => {
    expect(proxyVenueUrl(FYND_SDK, BASE, {venue: "fynd", rest: "/ethereum/v1/quote"})).toBe(FYND_PROXY);
    expect(proxyVenueUrl(`${BASE}/venue/fynd/robinhood/v1/quote`, BASE, {venue: "fynd", rest: "/robinhood/v1/quote"})).toBe(`${BASE}/venue/fynd/robinhood/quote`);
    // Not the SDK's shape: sent unchanged (the proxy refuses an unknown path).
    expect(proxyVenueUrl(`${BASE}/venue/fynd/ethereum/quote`, BASE, {venue: "fynd", rest: "/ethereum/quote"})).toBe(`${BASE}/venue/fynd/ethereum/quote`);
    expect(proxyVenueUrl(`${BASE}/venue/lifi/v1/quote`, BASE, {venue: "lifi", rest: "/v1/quote"})).toBe(`${BASE}/venue/lifi/v1/quote`);
  });
});

/** The routing fetch over a recording fake, with health already settled to `health`. */
function harness(
  health: SwapWebHealth | null = HEALTH,
  respond: (url: string, init?: RequestInit) => Response | Promise<Response> = () => answer(200, {ok: true}),
  direct?: (fetch: typeof globalThis.fetch) => ProxyFetchDeps["direct"],
) {
  let now = Date.UTC(2026, 10, 12, 12, 0, 0);
  const routes = healthRoutes(health, PLAN);
  const stopped = new Map<string, number>();
  const calls: {url: string; init?: RequestInit; input: unknown}[] = [];
  const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({url, init, input});
    return respond(url, init);
  });
  const deps: ProxyFetchDeps = {
    plan: PLAN,
    settled: async () => {},
    live: (key) => {
      if ((stopped.get(key) ?? 0) > now) return false;
      if (key === "thornode") return routes.thornode;
      if (key.startsWith("rpc:")) return routes.rpc.has(key.slice(4));
      return routes.venues.has(key.slice(6) as never);
    },
    stop: (key, until) => stopped.set(key, until),
    fetch: base as unknown as typeof fetch,
    ...(direct ? {direct: direct(base as unknown as typeof fetch)} : {}),
    now: () => now,
    version: "0.1.0",
  };
  return {f: createProxyFetch(deps), calls, base, stopped, tick: (ms: number) => (now += ms)};
}

describe("the routing fetch", () => {
  it("leaves every other request byte-identical: the same arguments reach the original fetch", async () => {
    const h = harness();
    const init = {method: "POST", headers: {"content-type": "application/json"}, body: '{"a":1}'};
    await h.f("https://li.quest/v1/quote?x=1", init);
    await h.f(`${BASE}/health`);
    const req = new Request("https://rpc.example/");
    await h.f(req);
    expect(h.base.mock.calls[0]).toEqual(["https://li.quest/v1/quote?x=1", init]);
    expect(h.base.mock.calls[0]![1]).toBe(init);
    expect(h.base.mock.calls[1]).toEqual([`${BASE}/health`, undefined]);
    expect(h.base.mock.calls[2]![0]).toBe(req);
  });

  it("a keyed venue goes through the proxy; its upstream answers pass through untouched, never retried", async () => {
    const h = harness(HEALTH, () => answer(404, {message: "No available quotes"}, "upstream"));
    const res = await h.f(`${BASE}/venue/lifi/quote?fromChain=1`, {headers: {accept: "application/json"}});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({message: "No available quotes"});
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/venue/lifi/quote?fromChain=1`]);
    expect(h.stopped.size).toBe(0);
  });

  it("a venue health calls anonymous is sent straight to its public base, same path and query (and no request to the proxy)", async () => {
    const h = harness();
    const init = {method: "POST", headers: {"content-type": "application/json"}, body: '{"amount":"1"}'};
    await h.f(`${BASE}/venue/near_intents/quote`, init);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe("https://1click.chaindefuser.com/v0/quote");
    expect(h.calls[0]!.init).toBe(init);
  });

  it("a failed health check sends every venue direct", async () => {
    const h = harness(null);
    await h.f(`${BASE}/venue/lifi/quote?a=1`);
    await h.f(`${BASE}/venue/relay/quote/v2`, {method: "POST", body: "{}"});
    expect(h.calls.map((c) => c.url)).toEqual(["https://li.quest/v1/quote?a=1", "https://api.relay.link/quote/v2"]);
  });

  it("the proxy's own failure is retried ONCE direct with the same path, query and body, and the venue stays direct for the page", async () => {
    const h = harness(HEALTH, (url) => (url.startsWith(BASE) ? answer(502, {error: "upstream unreachable"}, "proxy") : answer(200, {quote: 1})));
    const init = {method: "POST", headers: {"content-type": "application/json"}, body: '{"user":"0xabc"}'};
    const res = await h.f(`${BASE}/venue/relay/quote/v2?x=1`, init);
    expect(await res.json()).toEqual({quote: 1});
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/venue/relay/quote/v2?x=1`, "https://api.relay.link/quote/v2?x=1"]);
    expect(h.calls[1]!.init?.body).toBe('{"user":"0xabc"}');
    expect(h.calls[1]!.init?.method).toBe("POST");
    expect(h.stopped.get("venue:relay")).toBe(Infinity);
    await h.f(`${BASE}/venue/relay/quote/v2`, init);
    expect(h.calls.at(-1)!.url).toBe("https://api.relay.link/quote/v2");
    expect(h.calls).toHaveLength(3);
  });

  it.each([400, 403, 404, 405, 413, 414, 429, 500, 503, 504])("retries direct on the proxy's own %i", async (status) => {
    const h = harness(HEALTH, (url) => (url.startsWith(BASE) ? answer(status, {error: "x"}, "proxy") : answer(200, {})));
    await h.f(`${BASE}/venue/lifi/quote`);
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/venue/lifi/quote`, "https://li.quest/v1/quote"]);
  });

  it("an answer that doesn't say it is upstream's counts as the proxy's", async () => {
    const h = harness(HEALTH, (url) => (url.startsWith(BASE) ? answer(503, {}, null) : answer(200, {})));
    await h.f(`${BASE}/venue/lifi/quote`);
    expect(h.calls).toHaveLength(2);
  });

  it("a network error at the proxy (a CORS refusal looks the same) is retried direct", async () => {
    const h = harness(HEALTH, (url) => {
      if (url.startsWith(BASE)) throw new TypeError("Failed to fetch");
      return answer(200, {});
    });
    expect((await h.f(`${BASE}/venue/lifi/status?txHash=0x1`)).status).toBe(200);
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/venue/lifi/status?txHash=0x1`, "https://li.quest/v1/status?txHash=0x1"]);
    expect(h.stopped.get("venue:lifi")).toBe(Infinity);
  });

  it("a request its caller aborted is not the proxy's failure: no retry, the venue stays on the proxy", async () => {
    const ac = new AbortController();
    const h = harness(HEALTH, () => {
      ac.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(h.f(`${BASE}/venue/lifi/quote`, {signal: ac.signal})).rejects.toThrow("aborted");
    expect(h.calls).toHaveLength(1);
    expect(h.stopped.size).toBe(0);
  });

  it("a keyed-only preview call (keyedOnly, D7) through a keyed slot goes to the proxy as any call does, its answers untouched", async () => {
    const h = harness(HEALTH, () => answer(400, {message: "No routes found"}, "upstream"));
    const res = await h.f(`${BASE}/venue/lifi/quote?fromChain=8453`, {headers: {accept: "application/json"}, signal: keyedOnly(new AbortController().signal)});
    expect(res.status).toBe(400);
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/venue/lifi/quote?fromChain=8453`]);
    expect(h.stopped.size).toBe(0);
  });

  it("a keyed-only preview call is never sent keyless from an unused slot (anonymous, health failed): it fails WITHOUT a request", async () => {
    for (const health of [{...HEALTH, venues: {...HEALTH.venues, lifi: "anonymous" as const}}, null]) {
      const h = harness(health);
      await expect(h.f(`${BASE}/venue/lifi/quote?a=1`, {signal: keyedOnly(new AbortController().signal)})).rejects.toThrow(UNUSED_SLOT);
      expect(h.calls).toEqual([]);
      // An unmarked call (a live round's) still goes straight to LI.FI, as before.
      await h.f(`${BASE}/venue/lifi/quote?a=1`, {signal: new AbortController().signal});
      expect(h.calls.map((c) => c.url)).toEqual(["https://li.quest/v1/quote?a=1"]);
    }
  });

  it.each([
    ["the proxy's own 502", () => answer(502, {error: "upstream unreachable"}, "proxy"), Infinity],
    ["its daily budget", () => answer(429, {error: "daily budget spent"}, "proxy"), Date.UTC(2026, 10, 13)],
    ["cp0x's key refused upstream", () => answer(401, {message: "Invalid API key"}, "upstream"), Infinity],
  ] as const)("a keyed-only preview call after %s: the one direct retry, then nothing keyless while the slot is stopped", async (_, fail, until) => {
    const h = harness(HEALTH, (url) => (url.startsWith(BASE) ? fail() : answer(200, {quote: 1})));
    const signal = keyedOnly(new AbortController().signal);
    expect(await (await h.f(`${BASE}/venue/lifi/quote?a=1`, {signal})).json()).toEqual({quote: 1});
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/venue/lifi/quote?a=1`, "https://li.quest/v1/quote?a=1"]);
    expect(h.stopped.get("venue:lifi")).toBe(until);
    // The SDK's second /quote in the same round (its slippage rescale) and every later preview: nothing is sent.
    await expect(h.f(`${BASE}/venue/lifi/quote?a=2`, {signal})).rejects.toThrow(UNUSED_SLOT);
    await expect(h.f(`${BASE}/venue/lifi/quote?a=3`, {signal: keyedOnly(new AbortController().signal)})).rejects.toThrow(UNUSED_SLOT);
    expect(h.calls).toHaveLength(2);
    // A live round's call still goes straight to LI.FI from the stopped slot (the per-call fallback, D30).
    await h.f(`${BASE}/venue/lifi/quote?a=4`);
    expect(h.calls.at(-1)!.url).toBe("https://li.quest/v1/quote?a=4");
  });

  it.each([
    ["the proxy's per-minute 429", () => answer(429, {error: "rate limited"}, "proxy", {"retry-after": "1"}), 1_000],
    ["an upstream 429 on cp0x's key (no Retry-After: the proxy strips it)", () => answer(429, {message: "Too many requests"}, "upstream"), 60_000],
  ] as const)("a keyed-only call's keyless retry is once per page: after %s runs out, the next failure at the proxy retries nothing", async (_, fail, stop) => {
    const t0 = Date.UTC(2026, 10, 12, 12, 0, 0);
    const h = harness(HEALTH, (url) => (url.startsWith(BASE) ? fail() : answer(200, {quote: 1})));
    expect((await h.f(`${BASE}/venue/lifi/quote?a=1`, {signal: keyedOnly(new AbortController().signal)})).status).toBe(200);
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/venue/lifi/quote?a=1`, "https://li.quest/v1/quote?a=1"]);
    expect(h.stopped.get("venue:lifi")).toBe(t0 + stop);
    // The stop runs out: a later preview round asks the proxy again (keyed), which fails again — and that is all.
    h.tick(stop + 1);
    await expect(h.f(`${BASE}/venue/lifi/quote?a=2`, {signal: keyedOnly(new AbortController().signal)})).rejects.toThrow(UNUSED_SLOT);
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/venue/lifi/quote?a=1`, "https://li.quest/v1/quote?a=1", `${BASE}/venue/lifi/quote?a=2`]);
    expect(h.stopped.get("venue:lifi")).toBe(t0 + 2 * stop + 1);
    // A live round's call keeps its own per-call fallback (D30).
    h.tick(stop + 1);
    expect(await (await h.f(`${BASE}/venue/lifi/quote?a=3`)).json()).toEqual({quote: 1});
    expect(h.calls.slice(-2).map((c) => c.url)).toEqual([`${BASE}/venue/lifi/quote?a=3`, "https://li.quest/v1/quote?a=3"]);
  });

  it("two keyed-only calls failing at the proxy at once share the one keyless retry", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(HEALTH, async (url) => {
      if (!url.startsWith(BASE)) return answer(200, {quote: 1});
      await gate;
      return answer(502, {error: "upstream unreachable"}, "proxy");
    });
    const a = h.f(`${BASE}/venue/lifi/quote?a=1`, {signal: keyedOnly(new AbortController().signal)});
    const b = h.f(`${BASE}/venue/lifi/quote?a=2`, {signal: keyedOnly(new AbortController().signal)});
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    release();
    const results = await Promise.allSettled([a, b]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(h.calls.filter((c) => c.url.startsWith("https://li.quest/"))).toHaveLength(1);
  });

  it("a keyed-only call after a network error at the proxy: retried direct once too, then nothing keyless", async () => {
    const h = harness(HEALTH, (url) => {
      if (url.startsWith(BASE)) throw new TypeError("Failed to fetch");
      return answer(200, {});
    });
    const signal = keyedOnly(new AbortController().signal);
    expect((await h.f(`${BASE}/venue/lifi/quote`, {signal})).status).toBe(200);
    await expect(h.f(`${BASE}/venue/lifi/quote`, {signal})).rejects.toThrow(UNUSED_SLOT);
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/venue/lifi/quote`, "https://li.quest/v1/quote"]);
  });

  it("a keyed-only call on a path the proxy doesn't forward is not sent straight to the venue either", async () => {
    const h = harness(SYMBIOSIS_KEYED);
    await expect(h.f(`${BASE}/venue/symbiosis${SYM_TX}?x=1`, {headers: {accept: "application/json"}, signal: keyedOnly(new AbortController().signal)})).rejects.toThrow(
      UNUSED_SLOT,
    );
    expect(h.calls).toEqual([]);
    expect(h.stopped.size).toBe(0);
  });

  it("a 429 daily limit keeps the venue direct until 00:00 UTC, then the proxy is asked again", async () => {
    let first = true;
    const h = harness(HEALTH, (url) => {
      if (url.startsWith(BASE) && first) {
        first = false;
        return answer(429, {error: "daily budget spent"}, "proxy");
      }
      return answer(200, {});
    });
    await h.f(`${BASE}/venue/lifi/quote`);
    expect(h.stopped.get("venue:lifi")).toBe(Date.UTC(2026, 10, 13));
    h.tick(11 * 3_600_000);
    await h.f(`${BASE}/venue/lifi/quote`);
    expect(h.calls.at(-1)!.url).toBe("https://li.quest/v1/quote");
    h.tick(3_600_000);
    await h.f(`${BASE}/venue/lifi/quote`);
    expect(h.calls.at(-1)!.url).toBe(`${BASE}/venue/lifi/quote`);
  });

  it("the per-IP daily share counts as a daily limit too; a per-minute 429 stops the venue only for its Retry-After", async () => {
    const t0 = Date.UTC(2026, 10, 12, 12, 0, 0);
    const ip = harness(HEALTH, (url) => (url.startsWith(BASE) ? answer(429, {error: "ip daily limit"}, "proxy", {"retry-after": "43200"}) : answer(200, {})));
    await ip.f(`${BASE}/venue/relay/quote/v2`, {method: "POST", body: "{}"});
    expect(ip.stopped.get("venue:relay")).toBe(Date.UTC(2026, 10, 13));
    let first = true;
    const minute = harness(HEALTH, (url) => {
      if (url.startsWith(BASE) && first) {
        first = false;
        return answer(429, {error: "rate limited"}, "proxy", {"retry-after": "60"});
      }
      return answer(200, {});
    });
    await minute.f(`${BASE}/venue/relay/quote/v2`, {method: "POST", body: "{}"});
    expect(minute.stopped.get("venue:relay")).toBe(t0 + 60_000);
    // Back on the proxy once the window has passed (a long-lived tab isn't left direct for hours).
    minute.tick(60_001);
    await minute.f(`${BASE}/venue/relay/quote/v2`, {method: "POST", body: "{}"});
    expect(minute.calls.at(-1)!.url).toBe(`${BASE}/venue/relay/quote/v2`);
  });

  it("Retry-After: seconds or an HTTP date, 60 s when missing or unreadable, between 1 s and 5 min", () => {
    const now = Date.UTC(2026, 10, 12, 12, 0, 0);
    expect(backoffMs("30", now)).toBe(30_000);
    expect(backoffMs(" 90 ", now)).toBe(90_000);
    expect(backoffMs(new Date(now + 120_000).toUTCString(), now)).toBe(120_000);
    expect(backoffMs(null, now)).toBe(BACKOFF_MS.default);
    expect(backoffMs("soon", now)).toBe(BACKOFF_MS.default);
    expect(backoffMs("0", now)).toBe(BACKOFF_MS.min);
    expect(backoffMs("86400", now)).toBe(BACKOFF_MS.max);
  });

  it.each([401, 403])("an upstream %i on a keyed venue refuses cp0x's key or IP, not the request: asked directly once, the venue direct for the page", async (status) => {
    const h = harness(HEALTH, (url) => (url.startsWith(BASE) ? answer(status, {message: "Invalid API key"}, "upstream") : answer(200, {quote: 1})));
    const init = {method: "POST", headers: {"content-type": "application/json"}, body: '{"user":"0xabc"}'};
    const res = await h.f(`${BASE}/venue/relay/quote/v2`, init);
    expect(await res.json()).toEqual({quote: 1});
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/venue/relay/quote/v2`, "https://api.relay.link/quote/v2"]);
    expect(h.calls[1]!.init?.body).toBe('{"user":"0xabc"}');
    expect(h.stopped.get("venue:relay")).toBe(Infinity);
  });

  it("an upstream 429 (every Standard user on cp0x's one key) is asked directly once; the venue comes back after a short while", async () => {
    const t0 = Date.UTC(2026, 10, 12, 12, 0, 0);
    const h = harness(HEALTH, (url) => (url.startsWith(BASE) ? answer(429, {message: "Too many requests"}, "upstream") : answer(200, {})));
    await h.f(`${BASE}/venue/lifi/quote?a=1`);
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/venue/lifi/quote?a=1`, "https://li.quest/v1/quote?a=1"]);
    // The proxy strips upstream headers: no Retry-After, so the default wait.
    expect(h.stopped.get("venue:lifi")).toBe(t0 + BACKOFF_MS.default);
  });

  it("other upstream refusals stay the venue's answer: a 400 / 404 / 422 / 500 is never retried and stops nothing", async () => {
    for (const status of [400, 404, 422, 500]) {
      const h = harness(HEALTH, () => answer(status, {message: "No available quotes"}, "upstream"));
      expect((await h.f(`${BASE}/venue/lifi/quote`)).status).toBe(status);
      expect(h.calls).toHaveLength(1);
      expect(h.stopped.size).toBe(0);
    }
  });

  it("RPC: a listed network goes through the proxy; an unlisted one fails at once WITHOUT a request, so the client moves on", async () => {
    const h = harness();
    const init = {method: "POST", headers: {"content-type": "application/json"}, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'};
    await h.f(`${BASE}/rpc/8453`, init);
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/rpc/8453`]);
    expect(h.calls[0]!.init?.body).toBe(init.body);
    await expect(h.f(`${BASE}/rpc/1`, init)).rejects.toThrow(UNUSED_SLOT);
    await expect(h.f(`${BASE}/rpc/1`, init)).rejects.toBeInstanceOf(TypeError);
    expect(h.calls).toHaveLength(1);
  });

  it("RPC: answers pass through (the client falls back itself); the proxy's 404/503/5xx stop the slot, a 400 refuses only that call", async () => {
    const h = harness(HEALTH, () => answer(400, {error: "method not allowed: eth_feeHistory"}, "proxy"));
    expect((await h.f(`${BASE}/rpc/8453`, {method: "POST", body: "{}"})).status).toBe(400);
    expect(h.stopped.size).toBe(0);
    const gone = harness(HEALTH, () => answer(404, {error: "chain not served"}, "proxy"));
    expect((await gone.f(`${BASE}/rpc/8453`, {method: "POST", body: "{}"})).status).toBe(404);
    await expect(gone.f(`${BASE}/rpc/8453`, {method: "POST", body: "{}"})).rejects.toThrow(UNUSED_SLOT);
    const upstream = harness(HEALTH, () => answer(503, {}, "upstream"));
    await upstream.f(`${BASE}/rpc/8453`, {method: "POST", body: "{}"});
    expect(upstream.stopped.size).toBe(0);
  });

  it("RPC: an upstream 401 / 403 (cp0x's node token refused) stops the slot for the page, an upstream or per-minute 429 for a while", async () => {
    const t0 = Date.UTC(2026, 10, 12, 12, 0, 0);
    const denied = harness(HEALTH, () => answer(401, {}, "upstream"));
    expect((await denied.f(`${BASE}/rpc/8453`, {method: "POST", body: "{}"})).status).toBe(401);
    expect(denied.stopped.get("rpc:8453")).toBe(Infinity);
    const busy = harness(HEALTH, () => answer(429, {error: "rate limited"}, "proxy", {"retry-after": "60"}));
    await busy.f(`${BASE}/rpc/solana`, {method: "POST", body: "{}"});
    expect(busy.stopped.get("rpc:solana")).toBe(t0 + 60_000);
    const thor = harness(HEALTH, () => answer(403, "Forbidden", "upstream"));
    await thor.f(`${BASE}/venue/thornode/thorchain/inbound_addresses`);
    expect(thor.stopped.get("thornode")).toBe(Infinity);
  });

  it("THORNode: used only while health says so, otherwise the SDK's next confirm host is asked (no request here)", async () => {
    const on = harness();
    await on.f(`${BASE}/venue/thornode/thorchain/inbound_addresses`, {headers: {accept: "application/json", "x-client-id": "cp0x-swap"}});
    expect(on.calls).toHaveLength(1);
    const off = harness({...HEALTH, thornode: false});
    await expect(off.f(`${BASE}/venue/thornode/thorchain/inbound_addresses`)).rejects.toThrow(UNUSED_SLOT);
    expect(off.calls).toHaveLength(0);
  });

  it("x-cp0x-swap-web only on proxy-bound requests that are preflighted anyway; never on a simple GET, the direct retry, or as x-cp0x-app", async () => {
    const h = harness(HEALTH, (url) => (url.includes("/venue/relay") ? answer(500, {}, "proxy") : answer(200, {})));
    await h.f(`${BASE}/venue/lifi/quote?a=1`, {headers: {accept: "application/json"}});
    await h.f(`${BASE}/venue/relay/quote/v2`, {method: "POST", headers: {accept: "application/json", "content-type": "application/json"}, body: "{}"});
    await h.f(`${BASE}/rpc/8453`, {method: "POST", headers: {"content-type": "application/json"}, body: "{}"});
    const header = (i: number, name: string) => new Headers(h.calls[i]!.init?.headers).get(name);
    expect(header(0, "x-cp0x-swap-web")).toBeNull();
    expect(header(1, "x-cp0x-swap-web")).toBe("0.1.0");
    expect(h.calls[2]!.url).toBe("https://api.relay.link/quote/v2");
    expect(header(2, "x-cp0x-swap-web")).toBeNull();
    expect(header(3, "x-cp0x-swap-web")).toBe("0.1.0");
    for (let i = 0; i < h.calls.length; i++) expect(header(i, "x-cp0x-app")).toBeNull();
  });

  it("Fynd while keyed: through the proxy at the hosted API's path, same body and headers (no key here), the app version on its preflighted POST", async () => {
    const h = harness(FYND_KEYED, () => answer(422, {error: "no route"}, "upstream"));
    const res = await h.f(FYND_SDK, FYND_INIT);
    // The venue's own answer passes through untouched; nothing stops.
    expect(res.status).toBe(422);
    expect(h.calls.map((c) => c.url)).toEqual([FYND_PROXY]);
    expect(h.calls[0]!.init?.body).toBe(FYND_INIT.body);
    const headers = new Headers(h.calls[0]!.init?.headers);
    expect(headers.get("x-cp0x-swap-web")).toBe("0.1.0");
    expect(headers.get("authorization")).toBeNull();
    expect(h.stopped.size).toBe(0);
  });

  it("Fynd without a key at cp0x (or a failed health check): fails at once WITHOUT a request — there is no direct Fynd", async () => {
    for (const health of [HEALTH, null]) {
      const h = harness(health);
      await expect(h.f(FYND_SDK, FYND_INIT)).rejects.toThrow(UNUSED_SLOT);
      expect(h.calls).toHaveLength(0);
    }
  });

  it.each([
    ["the proxy's own 502", () => answer(502, {error: "upstream unreachable"}, "proxy"), Infinity],
    ["the proxy's own 404 (a path it doesn't allow)", () => answer(404, {error: "path not allowed"}, "proxy"), Infinity],
    ["an upstream 401 (cp0x's key refused)", () => answer(401, {}, "upstream"), Infinity],
    ["an upstream 403", () => answer(403, {}, "upstream"), Infinity],
    ["the proxy's daily budget", () => answer(429, {error: "daily budget spent"}, "proxy"), Date.UTC(2026, 10, 13)],
    ["an upstream 429", () => answer(429, {}, "upstream"), Date.UTC(2026, 10, 12, 12, 0, 0) + BACKOFF_MS.default],
  ] as const)("Fynd after %s: the answer goes back to the SDK, the slot stops, and nothing is ever sent direct", async (_, respond, until) => {
    const h = harness(FYND_KEYED, respond);
    const res = await h.f(FYND_SDK, FYND_INIT);
    expect(res.status).toBe(respond().status);
    expect(h.calls.map((c) => c.url)).toEqual([FYND_PROXY]);
    expect(h.stopped.get("venue:fynd")).toBe(until);
    await expect(h.f(FYND_SDK, FYND_INIT)).rejects.toThrow(UNUSED_SLOT);
    expect(h.calls).toHaveLength(1);
  });

  it("Fynd after a network error at the proxy: rethrown, the slot stopped for the page, no direct retry", async () => {
    const h = harness(FYND_KEYED, () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(h.f(FYND_SDK, FYND_INIT)).rejects.toThrow("Failed to fetch");
    expect(h.calls.map((c) => c.url)).toEqual([FYND_PROXY]);
    expect(h.stopped.get("venue:fynd")).toBe(Infinity);
  });

  it("0x and Across while keyed (D38): their module's own paths go to the proxy as sent, placeholder key and all; the version on the preflighted call", async () => {
    const keyed: SwapWebHealth = {...HEALTH, venues: {...HEALTH.venues, zeroex: "keyed", across: "keyed"}};
    const h = harness(keyed, () => answer(200, {liquidityAvailable: false}, "upstream"));
    const price = `${BASE}/venue/zeroex/swap/permit2/price?chainId=8453&sellToken=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&buyToken=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&sellAmount=1&slippageBps=50`;
    const zx = await h.f(price, {method: "GET", redirect: "error", headers: {accept: "application/json", "0x-api-key": "placeholder", "0x-version": "v2"}});
    expect(zx.status).toBe(200);
    const quotes = `${BASE}/venue/across/v1/quotes`;
    await h.f(quotes, {method: "POST", redirect: "error", headers: {accept: "application/json", "content-type": "application/json", authorization: "Bearer placeholder"}, body: "{}"});
    expect(h.calls.map((c) => c.url)).toEqual([price, quotes]);
    expect(proxyTarget(price, BASE)).toEqual({kind: "venue", venue: "zeroex", rest: price.slice(`${BASE}/venue/zeroex`.length)});
    const zxHeaders = new Headers(h.calls[0]!.init?.headers);
    expect([zxHeaders.get("0x-api-key"), zxHeaders.get("0x-version"), zxHeaders.get("x-cp0x-swap-web")]).toEqual(["placeholder", "v2", "0.1.0"]);
    const acHeaders = new Headers(h.calls[1]!.init?.headers);
    expect([acHeaders.get("authorization"), acHeaders.get("x-cp0x-swap-web")]).toEqual(["Bearer placeholder", "0.1.0"]);
    expect(h.calls[1]!.init?.body).toBe("{}");
    expect(h.stopped.size).toBe(0);
  });

  it("0x and Across without a key at cp0x (or a failed health check): fail at once WITHOUT a request; after a refusal of cp0x's key, never direct", async () => {
    const urls = [`${BASE}/venue/zeroex/swap/permit2/quote?chainId=1`, `${BASE}/venue/across/v1/quotes`];
    for (const health of [HEALTH, null]) {
      const h = harness(health);
      for (const u of urls) await expect(h.f(u, {method: "GET"})).rejects.toThrow(UNUSED_SLOT);
      expect(h.calls).toHaveLength(0);
    }
    const keyed: SwapWebHealth = {...HEALTH, venues: {...HEALTH.venues, zeroex: "keyed", across: "keyed"}};
    const h = harness(keyed, () => answer(401, {}, "upstream"));
    for (const u of urls) expect((await h.f(u, {method: "GET"})).status).toBe(401);
    expect([h.stopped.get("venue:zeroex"), h.stopped.get("venue:across")]).toEqual([Infinity, Infinity]);
    for (const u of urls) await expect(h.f(u, {method: "GET"})).rejects.toThrow(UNUSED_SLOT);
    expect(h.calls.map((c) => c.url)).toEqual(urls);
    expect(h.calls.some((c) => /0x\.org|across\.to/.test(c.url))).toBe(false);
  });

  it.each([
    "USER_NOT_AUTHORIZED",
    "TAKER_NOT_AUTHORIZED_FOR_TRADE",
    "RECIPIENT_NOT_AUTHORIZED_FOR_TRADE",
    "BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE",
    "SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE",
    "XSTOCKS_NOT_AUTHORIZED",
  ])("0x's 403 %s is about one token or account, not cp0x's key: its answer goes back to the module, 0x stays on", async (name) => {
    const keyed: SwapWebHealth = {...HEALTH, venues: {...HEALTH.venues, zeroex: "keyed"}};
    const h = harness(keyed, () => answer(403, {name, message: "x", data: {zid: "0x1"}}, "upstream"));
    const price = `${BASE}/venue/zeroex/swap/permit2/price?chainId=8453`;
    const res = await h.f(price, {method: "GET"});
    expect(res.status).toBe(403);
    // The module still reads the body (its refusal names the reason).
    expect(await res.json()).toMatchObject({name});
    expect(h.stopped.size).toBe(0);
    await h.f(price, {method: "GET"});
    expect(h.calls).toHaveLength(2);
  });

  it.each([
    ["an upstream 401 naming a request refusal", () => answer(401, {name: "BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE"}, "upstream")],
    ["an upstream 403 without a name", () => answer(403, {message: "Forbidden"}, "upstream")],
    ["an upstream 403 naming something else", () => answer(403, {name: "INVALID_API_KEY"}, "upstream")],
    ["an upstream 403 that isn't JSON", () => new Response("<html>Forbidden</html>", {status: 403, headers: {"x-swap-web-answer": "upstream"}})],
    ["the proxy's own 403 (its Origin gate) naming one", () => answer(403, {name: "BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE"}, "proxy")],
  ] as const)("0x after %s: that refuses cp0x, so the slot stops for the page", async (_, respond) => {
    const keyed: SwapWebHealth = {...HEALTH, venues: {...HEALTH.venues, zeroex: "keyed"}};
    const h = harness(keyed, respond);
    const price = `${BASE}/venue/zeroex/swap/permit2/price?chainId=8453`;
    expect((await h.f(price, {method: "GET"})).status).toBe(respond().status);
    expect(h.stopped.get("venue:zeroex")).toBe(Infinity);
    await expect(h.f(price, {method: "GET"})).rejects.toThrow(UNUSED_SLOT);
  });

  it("only 0x reads a 403 that way: Fynd's and Across' 403 naming the same still stop their slot", async () => {
    const keyed: SwapWebHealth = {...FYND_KEYED, venues: {...FYND_KEYED.venues, across: "keyed"}};
    const h = harness(keyed, () => answer(403, {name: "BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE"}, "upstream"));
    await h.f(FYND_SDK, FYND_INIT);
    await h.f(`${BASE}/venue/across/v1/quotes`, {method: "POST", body: "{}"});
    expect([h.stopped.get("venue:fynd"), h.stopped.get("venue:across")]).toEqual([Infinity, Infinity]);
  });

  it("Symbiosis while keyed: its quote and limits go through the proxy as the SDK sent them, its own answers untouched; no key here", async () => {
    const h = harness(SYMBIOSIS_KEYED, (url) =>
      url.endsWith("/swap-limits") ? answer(200, [{chainId: 8453, address: "0x0", min: "0", max: "0"}]) : answer(400, {message: "Route not found"}, "upstream"),
    );
    expect((await h.f(SYM_LIMITS, SYM_LIMITS_INIT)).status).toBe(200);
    const res = await h.f(SYM_QUOTE, SYM_QUOTE_INIT);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({message: "Route not found"});
    expect(h.calls.map((c) => c.url)).toEqual([SYM_LIMITS, SYM_QUOTE]);
    expect(h.calls[1]!.init?.body).toBe(SYM_QUOTE_INIT.body);
    const header = (i: number, name: string) => new Headers(h.calls[i]!.init?.headers).get(name);
    // The app version only on the preflighted POST, never on the simple GET; cp0x's key is the proxy's to add.
    expect([header(0, "x-cp0x-swap-web"), header(1, "x-cp0x-swap-web")]).toEqual([null, "0.1.0"]);
    for (const i of [0, 1]) expect(header(i, "x-api-key")).toBeNull();
    expect(h.stopped.size).toBe(0);
  });

  it("Symbiosis while health calls it anonymous (or the check failed): straight to its public base, same path and body", async () => {
    for (const health of [HEALTH, null]) {
      const h = harness(health);
      await h.f(SYM_LIMITS, SYM_LIMITS_INIT);
      await h.f(SYM_QUOTE, SYM_QUOTE_INIT);
      expect(h.calls.map((c) => c.url)).toEqual([`${SYMBIOSIS}/v1/swap-limits`, `${SYMBIOSIS}/v2/quote`]);
      expect(h.calls[1]!.init).toBe(SYM_QUOTE_INIT);
    }
  });

  it("Symbiosis' status calls go through the proxy while keyed, exactly the shapes it forwards; any other shape straight to Symbiosis, stopping nothing", async () => {
    const h = harness(SYMBIOSIS_KEYED, (url) => (url.startsWith(BASE) ? answer(404, {message: "Transaction not found"}, "upstream") : answer(200, [])));
    // Symbiosis' own 404 (a transaction it hasn't seen yet) comes back untouched: not retried, nothing stopped.
    expect((await h.f(`${BASE}/venue/symbiosis${SYM_TX}`, SYM_LIMITS_INIT)).status).toBe(404);
    await h.f(`${BASE}/venue/symbiosis${SYM_STUCK}`, SYM_LIMITS_INIT);
    await h.f(`${BASE}/venue/symbiosis/v2/tx/8453/${"ab".repeat(32)}`, SYM_LIMITS_INIT);
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/venue/symbiosis${SYM_TX}`, `${BASE}/venue/symbiosis${SYM_STUCK}`, `${BASE}/venue/symbiosis/v2/tx/8453/${"ab".repeat(32)}`]);
    expect(h.stopped.size).toBe(0);
    // Shapes the proxy would refuse (its 404 or "query not allowed" 400 would stop the slot): straight to Symbiosis.
    const other = [
      "/v2/quotes", // a longer path that only starts like a forwarded one
      "/v2/quote?partnerId=x", // a query, on any path
      `${SYM_TX}?x=1`,
      "/v1/stucked/TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", // not an EVM address
      `/v2/tx/0/0x${"ab".repeat(32)}`, // not a chain id
      "/v2/tx/8453/0xabc", // not a transaction hash
      "/v2/swap", // the SDK's Bitcoin-source call (btcSource is off)
    ];
    for (const rest of other) await h.f(`${BASE}/venue/symbiosis${rest}`, SYM_LIMITS_INIT);
    expect(h.calls.slice(3).map((c) => c.url)).toEqual(other.map((rest) => `${SYMBIOSIS}${rest}`));
    expect(h.stopped.size).toBe(0);
    // The quote still goes through cp0x.
    await h.f(SYM_QUOTE, SYM_QUOTE_INIT);
    expect(h.calls.at(-1)!.url).toBe(SYM_QUOTE);
  });

  it("Symbiosis' status call that fails at the proxy is asked directly once, and Symbiosis stays direct", async () => {
    const h = harness(SYMBIOSIS_KEYED, (url) =>
      url.startsWith(BASE) ? answer(429, {error: "rate limited"}, "proxy", {"retry-after": "30"}) : answer(200, {status: {code: 0}}),
    );
    expect((await h.f(`${BASE}/venue/symbiosis${SYM_TX}`, SYM_LIMITS_INIT)).status).toBe(200);
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/venue/symbiosis${SYM_TX}`, `${SYMBIOSIS}${SYM_TX}`]);
    expect(h.stopped.get("venue:symbiosis")).toBe(Date.UTC(2026, 10, 12, 12, 0, 30));
    await h.f(SYM_QUOTE, SYM_QUOTE_INIT);
    expect(h.calls.at(-1)!.url).toBe(`${SYMBIOSIS}/v2/quote`);
  });

  it("Symbiosis' direct calls go through its own sender (retry, stopped slot, unforwarded path); its proxy calls never do", async () => {
    const sender = vi.fn(async () => answer(200, {}));
    const h = harness(SYMBIOSIS_KEYED, () => answer(401, {message: "Invalid API key"}, "upstream"), () => ({symbiosis: sender as unknown as typeof fetch}));
    await h.f(`${BASE}/venue/symbiosis/v2/quotes`, SYM_QUOTE_INIT);
    await h.f(SYM_QUOTE, SYM_QUOTE_INIT);
    await h.f(SYM_LIMITS, SYM_LIMITS_INIT);
    expect(h.calls.map((c) => c.url)).toEqual([SYM_QUOTE]);
    expect(sender.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual([`${SYMBIOSIS}/v2/quotes`, `${SYMBIOSIS}/v2/quote`, `${SYMBIOSIS}/v1/swap-limits`]);
    // Every other venue keeps the original fetch for its direct calls.
    await h.f(`${BASE}/venue/near_intents/quote`, {method: "POST", body: "{}"});
    expect(h.calls.at(-1)!.url).toBe("https://1click.chaindefuser.com/v0/quote");
    expect(sender).toHaveBeenCalledTimes(3);
  });

  it("Symbiosis' direct calls keep the keyless 1 request/s: the retry after a slow failure at the proxy and the next quotes stay a gap apart", async () => {
    vi.useFakeTimers({now: 0});
    const sent: [string, number][] = [];
    const h = harness(
      SYMBIOSIS_KEYED,
      async (url) => {
        sent.push([url, Date.now()]);
        if (!url.startsWith(BASE)) return answer(200, {tokenAmountOut: {amount: "1"}});
        // cp0x's key is over its 10 req/s (every Standard viewer shares it); the answer takes a second.
        await new Promise((r) => setTimeout(r, 1_000));
        return answer(429, {message: "The limit of requests has been exceeded"}, "upstream");
      },
      (fetch) => ({symbiosis: paced(1_100, fetch)}),
    );
    // providers.ts' pacer around the routing, as the page builds it: three quotes queued in one burst.
    const symbiosis = paced(1_100, h.f);
    const all = Promise.all([0, 1, 2].map(() => symbiosis(SYM_QUOTE, SYM_QUOTE_INIT)));
    await vi.runAllTimersAsync();
    await all;
    expect(sent).toEqual([
      [SYM_QUOTE, 0],
      // The retry at once; the next quote (its turn came at 1.1 s, the slot now stopped) waits for the direct gap.
      [`${SYMBIOSIS}/v2/quote`, 1_000],
      [`${SYMBIOSIS}/v2/quote`, 2_100],
      [`${SYMBIOSIS}/v2/quote`, 3_200],
    ]);
  });

  it.each([
    ["the proxy's own 502", () => answer(502, {error: "upstream unreachable"}, "proxy"), Infinity],
    ["the proxy's own 404", () => answer(404, {error: "path not allowed"}, "proxy"), Infinity],
    ["an upstream 401 (cp0x's key refused)", () => answer(401, {message: "Invalid API key"}, "upstream"), Infinity],
    ["an upstream 403", () => answer(403, {}, "upstream"), Infinity],
    ["the proxy's daily budget", () => answer(429, {error: "daily budget spent"}, "proxy"), Date.UTC(2026, 10, 13)],
    ["the proxy's per-minute limit", () => answer(429, {error: "rate limited"}, "proxy", {"retry-after": "30"}), Date.UTC(2026, 10, 12, 12, 0, 30)],
    ["an upstream 429 (cp0x's 10 req/s key)", () => answer(429, {message: "The limit of requests has been exceeded"}, "upstream"), Date.UTC(2026, 10, 12, 12, 0, 0) + BACKOFF_MS.default],
  ] as const)("Symbiosis after %s: asked directly ONCE with the same body, then direct while the stop lasts", async (_, fail, until) => {
    const h = harness(SYMBIOSIS_KEYED, (url) => (url.startsWith(BASE) ? fail() : answer(200, {tokenAmountOut: {amount: "1"}})));
    const res = await h.f(SYM_QUOTE, SYM_QUOTE_INIT);
    expect(await res.json()).toEqual({tokenAmountOut: {amount: "1"}});
    expect(h.calls.map((c) => c.url)).toEqual([SYM_QUOTE, `${SYMBIOSIS}/v2/quote`]);
    expect(h.calls[1]!.init?.body).toBe(SYM_QUOTE_INIT.body);
    expect(new Headers(h.calls[1]!.init?.headers).get("x-cp0x-swap-web")).toBeNull();
    expect(h.stopped.get("venue:symbiosis")).toBe(until);
    await h.f(SYM_LIMITS, SYM_LIMITS_INIT);
    expect(h.calls.map((c) => c.url)).toHaveLength(3);
    expect(h.calls.at(-1)!.url).toBe(`${SYMBIOSIS}/v1/swap-limits`);
  });

  it("Symbiosis after a network error at the proxy: asked directly once, direct for the page", async () => {
    const h = harness(SYMBIOSIS_KEYED, (url) => {
      if (url.startsWith(BASE)) throw new TypeError("Failed to fetch");
      return answer(200, []);
    });
    expect((await h.f(SYM_LIMITS, SYM_LIMITS_INIT)).status).toBe(200);
    expect(h.calls.map((c) => c.url)).toEqual([SYM_LIMITS, `${SYMBIOSIS}/v1/swap-limits`]);
    expect(h.stopped.get("venue:symbiosis")).toBe(Infinity);
  });

  it("a Request object is routed too, its body sent again on the retry", async () => {
    const h = harness(HEALTH, (url) => (url.startsWith(BASE) ? answer(502, {}, "proxy") : answer(200, {})));
    await h.f(new Request(`${BASE}/venue/lifi/advanced/routes`, {method: "POST", headers: {"content-type": "application/json"}, body: '{"r":1}'}));
    expect(h.calls.map((c) => c.url)).toEqual([`${BASE}/venue/lifi/advanced/routes`, "https://li.quest/v1/advanced/routes"]);
    expect(new TextDecoder().decode(h.calls[1]!.init?.body as ArrayBuffer)).toBe('{"r":1}');
  });
});

describe("the Standard runtime", () => {
  it("reads health once, then reports which venues and how many networks go through cp0x", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => (String(input) === `${BASE}/health` ? answer(200, HEALTH, null) : answer(200, {})));
    const rt = createStandardRuntime(PLAN, {fetch: fetchImpl as unknown as typeof fetch, version: "0.1.0"});
    expect(rt.status().health).toBe("checking");
    const seen: string[] = [];
    rt.subscribe(() => seen.push(rt.status().health));
    await rt.start();
    await rt.start();
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).endsWith("/health"))).toHaveLength(1);
    expect(rt.status()).toEqual({mode: "standard", health: "ok", keyed: ["lifi", "relay"], viaProxy: ["lifi", "relay"], fellBack: [], rpcNetworks: 2, thornode: true});
    expect(seen).toEqual(["ok"]);
  });

  it("a proxy-bound request made before health answers waits for it, then takes the route health gave", async () => {
    let release!: (r: Response) => void;
    const calls: string[] = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input).endsWith("/health")) return new Promise<Response>((r) => (release = r));
      return Promise.resolve(answer(200, {}));
    });
    const rt = createStandardRuntime(PLAN, {fetch: fetchImpl as unknown as typeof fetch});
    void rt.start();
    const pending = rt.fetch(`${BASE}/venue/lifi/quote`);
    await Promise.resolve();
    expect(calls).toEqual([`${BASE}/health`]);
    release(answer(200, HEALTH, null));
    await pending;
    expect(calls).toEqual([`${BASE}/health`, `${BASE}/venue/lifi/quote`]);
  });

  it("settled() resolves once health answered (what a preview round waits for before it decides LI.FI and Fynd)", async () => {
    let release!: (r: Response) => void;
    const fetchImpl = vi.fn((input: RequestInfo | URL) =>
      String(input).endsWith("/health") ? new Promise<Response>((r) => (release = r)) : Promise.resolve(answer(200, {})),
    );
    const rt = createStandardRuntime(PLAN, {fetch: fetchImpl as unknown as typeof fetch});
    let settled = false;
    void rt.settled().then(() => (settled = true));
    void rt.start();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(rt.venueLive("lifi")).toBe(false);
    release(answer(200, HEALTH, null));
    await rt.settled();
    expect(settled).toBe(true);
    expect(rt.venueLive("lifi")).toBe(true);
  });

  it("an unreachable or broken health answer leaves the page Public", async () => {
    for (const health of [() => Promise.reject(new TypeError("Failed to fetch")), () => Promise.resolve(answer(503, {error: "x"}, "proxy")), () => Promise.resolve(answer(200, {nope: 1}, null))]) {
      const calls: string[] = [];
      const fetchImpl = vi.fn((input: RequestInfo | URL) => {
        calls.push(String(input));
        return String(input).endsWith("/health") ? health() : Promise.resolve(answer(200, {}));
      });
      const rt = createStandardRuntime(PLAN, {fetch: fetchImpl as unknown as typeof fetch});
      await rt.start();
      expect(rt.status()).toEqual({mode: "standard", health: "unreachable", keyed: [], viaProxy: [], fellBack: [], rpcNetworks: 0, thornode: false});
      await rt.fetch(`${BASE}/venue/lifi/quote`);
      await expect(rt.fetch(`${BASE}/rpc/8453`, {method: "POST", body: "{}"})).rejects.toThrow(UNUSED_SLOT);
      expect(calls).toEqual([`${BASE}/health`, "https://li.quest/v1/quote"]);
    }
  });

  it("gives up on health after its timeout, never waits longer, and ignores a late answer", async () => {
    vi.useFakeTimers();
    let release!: (r: Response) => void;
    const fetchImpl = vi.fn((input: RequestInfo | URL) =>
      String(input).endsWith("/health") ? new Promise<Response>((r) => (release = r)) : Promise.resolve(answer(200, {})),
    );
    const rt = createStandardRuntime(PLAN, {fetch: fetchImpl as unknown as typeof fetch, timeoutMs: 3_000});
    void rt.start();
    const quote = rt.fetch(`${BASE}/venue/relay/quote/v2`, {method: "POST", body: "{}"});
    await vi.advanceTimersByTimeAsync(3_000);
    await quote;
    expect(rt.status().health).toBe("unreachable");
    expect(fetchImpl.mock.calls.map(([u]) => String(u))).toContain("https://api.relay.link/quote/v2");
    release(answer(200, HEALTH, null));
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.status().health).toBe("unreachable");
  });

  it("reports a venue that fell back after a proxy failure", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.endsWith("/health")) return answer(200, HEALTH, null);
      return u.startsWith(BASE) ? answer(429, {error: "daily budget spent"}, "proxy") : answer(200, {});
    });
    const rt = createStandardRuntime(PLAN, {fetch: fetchImpl as unknown as typeof fetch});
    await rt.start();
    await rt.fetch(`${BASE}/venue/lifi/quote`);
    expect(rt.status()).toMatchObject({keyed: ["lifi", "relay"], viaProxy: ["relay"], fellBack: ["lifi"]});
  });

  it("Fynd: live only while keyed; a stop takes it off cp0x and it is reported among the venues taken off (never as direct)", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      calls.push(u);
      if (u.endsWith("/health")) return answer(200, FYND_KEYED, null);
      return answer(401, {}, "upstream");
    });
    const rt = createStandardRuntime(PLAN, {fetch: fetchImpl as unknown as typeof fetch});
    expect(rt.venueLive("fynd")).toBe(false);
    await rt.start();
    expect(rt.venueLive("fynd")).toBe(true);
    expect(rt.status()).toMatchObject({keyed: ["lifi", "relay", "fynd"], viaProxy: ["lifi", "relay", "fynd"], fellBack: []});
    await rt.fetch(FYND_SDK, FYND_INIT);
    expect(rt.venueLive("fynd")).toBe(false);
    expect(rt.status()).toMatchObject({viaProxy: ["lifi", "relay"], fellBack: ["fynd"]});
    expect(calls.slice(1)).toEqual([FYND_PROXY]);
    // Anonymous at cp0x: never live.
    const anon = createStandardRuntime(PLAN, {fetch: vi.fn(async () => answer(200, HEALTH, null)) as unknown as typeof fetch});
    await anon.start();
    expect(anon.venueLive("fynd")).toBe(false);
  });

  it("Symbiosis: reported among the keyed venues through cp0x while health keys it, and as fallen back after a failure there", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      calls.push(u);
      if (u.endsWith("/health")) return answer(200, SYMBIOSIS_KEYED, null);
      return u.startsWith(BASE) ? answer(401, {message: "Invalid API key"}, "upstream") : answer(200, {});
    });
    const rt = createStandardRuntime(PLAN, {fetch: fetchImpl as unknown as typeof fetch});
    expect(rt.venueLive("symbiosis")).toBe(false);
    await rt.start();
    expect(rt.status()).toMatchObject({keyed: ["lifi", "relay", "symbiosis"], viaProxy: ["lifi", "relay", "symbiosis"], fellBack: []});
    await rt.fetch(SYM_QUOTE, SYM_QUOTE_INIT);
    expect(calls.slice(1)).toEqual([SYM_QUOTE, `${SYMBIOSIS}/v2/quote`]);
    expect(rt.status()).toMatchObject({keyed: ["lifi", "relay", "symbiosis"], viaProxy: ["lifi", "relay"], fellBack: ["symbiosis"]});
    // Anonymous at cp0x (the default HEALTH): never through the proxy.
    const anon = createStandardRuntime(PLAN, {fetch: vi.fn(async () => answer(200, HEALTH, null)) as unknown as typeof fetch});
    await anon.start();
    expect(anon.venueLive("symbiosis")).toBe(false);
    expect(anon.status().keyed).toEqual(["lifi", "relay"]);
  });

  it("a keyed venue whose upstream refuses cp0x's key is asked directly (the review's probe: 401, zero calls to li.quest)", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      calls.push(u);
      if (u.endsWith("/health")) return answer(200, HEALTH, null);
      return u.startsWith(BASE) ? answer(401, {message: "Invalid API key"}, "upstream") : answer(200, {routes: []});
    });
    const rt = createStandardRuntime(PLAN, {fetch: fetchImpl as unknown as typeof fetch});
    await rt.start();
    const res = await rt.fetch(`${BASE}/venue/lifi/quote?fromChain=1`);
    expect(res.status).toBe(200);
    expect(calls.slice(1)).toEqual([`${BASE}/venue/lifi/quote?fromChain=1`, "https://li.quest/v1/quote?fromChain=1"]);
    expect(rt.status()).toMatchObject({viaProxy: ["relay"], fellBack: ["lifi"]});
  });

  it("the status follows a stop running out (00:00 UTC, a Retry-After) with no event, keeps its identity while nothing changes, and tells listeners", async () => {
    vi.useFakeTimers();
    let now = Date.UTC(2026, 10, 12, 23, 59, 0);
    vi.setSystemTime(now);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.endsWith("/health")) return answer(200, HEALTH, null);
      if (u.includes("/venue/relay") && now < Date.UTC(2026, 10, 13)) return answer(429, {error: "daily budget spent"}, "proxy");
      return answer(200, {});
    });
    const rt = createStandardRuntime(PLAN, {fetch: fetchImpl as unknown as typeof fetch, now: () => now});
    await rt.start();
    await rt.fetch(`${BASE}/venue/relay/quote/v2`, {method: "POST", body: "{}"});
    const before = rt.status();
    expect(before).toMatchObject({viaProxy: ["lifi"], fellBack: ["relay"]});
    expect(rt.status()).toBe(before);
    const heard = vi.fn();
    rt.subscribe(heard);
    // Past midnight: Relay goes back through the proxy, and the status says so (read afresh, and announced).
    now = Date.UTC(2026, 10, 13, 0, 0, 1);
    await vi.advanceTimersByTimeAsync(Date.UTC(2026, 10, 13) - Date.UTC(2026, 10, 12, 23, 59, 0) + 100);
    expect(heard).toHaveBeenCalled();
    expect(rt.status()).toMatchObject({viaProxy: ["lifi", "relay"], fellBack: []});
    expect(rt.status()).toBe(rt.status());
  });
});
