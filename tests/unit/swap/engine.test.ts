import {describe, expect, it, vi} from "vitest";
import type {CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import {DEFAULT_RUNTIME_CONFIG} from "../../../src/config/defaults";
import type {QuoteRequest, RouteSnapshot, RoutesRequest} from "../../../src/contracts/routes";
import {LAZY_WAIT_MS, createQuoteEngine, eligibleProviders, quoteParams} from "../../../src/swap/engine";
import {lazyLoads, lazyOmniston} from "../../../src/swap/omnistonLazy";
import type {ProviderStores} from "../../../src/swap/stores";
import {ME, USDC_BASE, USDC_ETH, USDT_ETH, request, venue} from "./fixtures";

// The Omniston chunk is a stand-in that routes between EVM networks and refuses (no network): these tests check the
// first round around its lazy load, not the SDK.
vi.mock("../../../src/swap/omniston", () => ({
  buildOmniston: (): CrossChainProvider => ({
    name: "omniston",
    supportsSameChain: true,
    enabled: () => true,
    supportsRoute: (from, to) => from.chain !== to.chain,
    getQuote: async (params) => {
      params.onRefusal?.("omniston: no resolver quoted this route/amount");
      return null;
    },
    buildDeposit: async () => {
      throw new Error("not built in tests");
    },
    trackIntent: async () => ({state: "pending"}),
  }),
}));

/** Provider stores whose IndexedDB opens when `ready` resolves. */
const storesReady = (ready: Promise<boolean>): ProviderStores => ({
  ready: () => ready,
  relayCleared: {has: async () => false, add: async () => {}},
  omnistonQuotes: {save: async () => {}, load: async () => undefined, clear: async () => {}, claim: async () => true},
  omnistonSecrets: {save: async () => {}, load: async () => undefined, clear: async () => {}},
});

const engineOver = (providers: CrossChainProvider[], gasWei: bigint | null = null) =>
  createQuoteEngine({providers: () => providers, gasPrice: async () => gasWei});

const live = (over: Partial<QuoteRequest> = {}): RoutesRequest => ({mode: "live", req: request(over)});

const collect = () => {
  const updates: RouteSnapshot[] = [];
  return {updates, onUpdate: (s: RouteSnapshot) => void updates.push(s)};
};

describe("quoteParams", () => {
  it("uses the request's explicit addresses, never to.owner", () => {
    const p = quoteParams(request({recipient: "0x1111111111111111111111111111111111111111", to: {...USDC_BASE, owner: null}}));
    expect(p).toEqual({
      sourceChain: "eip155:42161",
      sourceToken: "USDC",
      destChain: "eip155:8453",
      destToken: USDC_BASE.contract,
      amountIn: "5000000",
      slippageBps: 30,
      destAddress: "0x1111111111111111111111111111111111111111",
      refundAddress: ME,
      dry: true,
    });
  });
  it("refuses to quote without both addresses (no placeholder ever reaches a venue)", () => {
    expect(() => quoteParams(request({recipient: ""}))).toThrow(/recipient and a refund address/);
    expect(() => quoteParams(request({refundAddress: "  "}))).toThrow(/recipient and a refund address/);
  });
});

describe("eligibleProviders (the router's own predicate)", () => {
  const params = {sourceChain: "eip155:1", sourceToken: "USDT", destChain: "eip155:1", destToken: USDC_ETH.contract!};
  it("same-chain keeps only supportsSameChain venues; disabled / unsupported / throwing ones are out", () => {
    const throwing = {...venue("boom"), supportsRoute: () => {
      throw new Error("x");
    }};
    const list = [venue("bridge"), venue("dex", {sameChain: true}), venue("off", {sameChain: true, enabled: false}), venue("no", {sameChain: true, supports: false}), throwing];
    expect(eligibleProviders(list, params)).toEqual(["dex"]);
    expect(eligibleProviders(list, {...params, destChain: "eip155:8453"})).toEqual(["bridge", "dex"]);
  });
});

describe("quoteRoutes", () => {
  it("first update: every asked venue pending; then each venue leaves pending as it settles", async () => {
    const providers = [venue("fast", {min: "4990000", delayMs: 30, eta: 2}), venue("slow", {min: "4999000", delayMs: 80, eta: 45}), venue("nope", {refuse: "pair is not available", delayMs: 5}), venue("skip", {supports: false})];
    const {updates, onUpdate} = collect();
    const final = await engineOver(providers).quoteRoutes(live(), onUpdate);

    // `venues` = every enabled venue, asked or not: the route list's "Not for this pair" group is venues − asked.
    expect(updates[0]).toEqual({mode: "live", routes: [], pending: ["fast", "slow", "nope"], rejections: [], asked: ["fast", "slow", "nope"], venues: ["fast", "slow", "nope", "skip"]});
    // The refusal shows before any quote: per-venue pending/refused state, not only on the router's accepted updates.
    expect(updates[1]).toMatchObject({routes: [], pending: ["fast", "slow"], rejections: [{provider: "nope", reason: "Not quoting this pair right now", category: "pair"}]});
    expect(updates[2]!.routes.map((r) => r.provider)).toEqual(["fast"]);
    expect(updates[2]!.pending).toEqual(["slow"]);
    expect(final).not.toBeNull();
    expect(final!.pending).toEqual([]);
    expect(final!.asked).toEqual(["fast", "slow", "nope"]);
    expect(final!.routes.map((r) => r.provider)).toEqual(["slow", "fast"]);
    expect(final!.routes[0]).toMatchObject({tags: ["best"], execution: "calldata", trust: "provider-api", minDestAmount: 4_999_000n});
    expect(final!.rejections).toEqual([
      {provider: "nope", reason: "Not quoting this pair right now", category: "pair", detail: "It isn't offering this pair at the moment.", raw: "pair is not available"},
    ]);
    expect(final!.venues).toEqual(["fast", "slow", "nope", "skip"]);
  });

  it("a venue that throws is a refusal in the user's words, not a crash", async () => {
    const providers = [venue("ok", {min: "1", delayMs: 5}), venue("err", {error: "TypeError: Failed to fetch", delayMs: 5})];
    const final = await engineOver(providers).quoteRoutes(live(), () => {});
    expect(final!.routes.map((r) => r.provider)).toEqual(["ok"]);
    expect(final!.rejections).toEqual([
      {
        provider: "err",
        reason: "Couldn't reach it — tap refresh",
        category: "unreachable",
        detail: "Your browser couldn't connect to it — an ad blocker, VPN or network filter can cause this.",
        raw: "TypeError: Failed to fetch",
      },
    ]);
  });

  it("a throwing observer doesn't break the round", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const final = await engineOver([venue("a", {min: "1", delayMs: 5}), venue("b", {refuse: "no liquidity"})]).quoteRoutes(live(), () => {
      throw new Error("screen bug");
    });
    expect(final!.routes.map((r) => r.provider)).toEqual(["a"]);
    warn.mockRestore();
  });

  it("nobody serves the pair: an empty snapshot, no updates", async () => {
    const {updates, onUpdate} = collect();
    expect(await engineOver([venue("x", {supports: false}), venue("off", {enabled: false})]).quoteRoutes(live(), onUpdate)).toEqual({
      mode: "live",
      routes: [],
      pending: [],
      rejections: [],
      asked: [],
      venues: ["x"],
    });
    expect(updates).toEqual([]);
  });

  it("everyone refuses: no routes, the reasons, nothing pending", async () => {
    const final = await engineOver([venue("a", {refuse: "no liquidity"}), venue("b", {refuse: "returned no quote"})]).quoteRoutes(live(), () => {});
    expect(final).toMatchObject({
      routes: [],
      pending: [],
      rejections: [
        {provider: "a", reason: "Not enough liquidity right now", category: "unavailable", raw: "no liquidity"},
        {provider: "b", reason: "No quote right now", category: "other", raw: "returned no quote"},
      ],
      asked: ["a", "b"],
      venues: ["a", "b"],
    });
  });

  it("a venue's reason (swap2-core 0.12.0) reaches its row through the round: a text no rule knows reads by it", async () => {
    const final = await engineOver([venue("a", {refuse: "an odd new text 4242", refuseReason: "insufficient_liquidity"}), venue("b", {refuse: "an odd new text 4242"})]).quoteRoutes(live(), () => {});
    expect(final?.rejections.map((r) => [r.provider, r.reason, r.category])).toEqual([
      ["a", "Too large for its pools — try less", "amount"],
      ["b", "No quote right now", "other"],
    ]);
  });

  it("a newer round supersedes the older one: null, its requests aborted, no late updates", async () => {
    const slow = venue("v", {min: "1", delayMs: 60});
    const engine = engineOver([slow]);
    const first = collect();
    const p1 = engine.quoteRoutes(live(), first.onUpdate);
    await new Promise((r) => setTimeout(r, 5));
    const p2 = engine.quoteRoutes(live({amountIn: 6_000_000n}), () => {});
    expect(await p1).toBeNull();
    expect(slow.signals[0]!.aborted).toBe(true);
    const seen = first.updates.length;
    expect((await p2)!.routes).toHaveLength(1);
    expect(first.updates.length).toBe(seen);
  });

  it("the caller's signal cancels a round, even over a venue that ignores it", async () => {
    const hung = venue("hung", {hang: true});
    const ctl = new AbortController();
    const p = engineOver([hung, venue("ok", {min: "1", delayMs: 500})]).quoteRoutes(live(), () => {}, undefined, ctl.signal);
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    expect(await p).toBeNull();
    expect(hung.signals[0]!.aborted).toBe(true);
  });

  it("with a signal, two callers don't supersede each other", async () => {
    const engine = engineOver([venue("v", {min: "1", delayMs: 20})]);
    const [a, b] = await Promise.all([
      engine.quoteRoutes(live(), () => {}, undefined, new AbortController().signal),
      engine.quoteRoutes(live(), () => {}, undefined, new AbortController().signal),
    ]);
    expect(a!.routes).toHaveLength(1);
    expect(b!.routes).toHaveLength(1);
  });

  it("ranks after source gas: on Ethereum a dearer route can lose to a cheaper one", async () => {
    // USDT → USDC on Ethereum (mobile gas.test.ts): +$0.007 on price vs −$2.81 on gas at 2 gwei.
    const providers = [venue("pricey", {min: "2995000", gasLimit: "900000", spender: "0x00000000000000000000000000000000000000aa", sameChain: true}), venue("lean", {min: "2988000", gasLimit: "289489", spender: "0x00000000000000000000000000000000000000aa", sameChain: true})];
    const req = request({from: USDT_ETH, to: USDC_ETH, amountIn: 3_000_000n});
    const prices = {USDC: 1, USDT: 1, ETH: 2300};
    const noGas = await engineOver(providers, null).quoteRoutes({mode: "live", req}, () => {}, prices);
    expect(noGas!.routes[0]!.provider).toBe("pricey");
    const gas = await engineOver(providers, 2_000_000_000n).quoteRoutes({mode: "live", req}, () => {}, prices);
    expect(gas!.routes[0]!.provider).toBe("lean");
    expect(gas!.routes[0]!.gasUsd).toBeGreaterThan(1);
    expect(gas!.routes[0]!.approvalSpender).toBe("0x00000000000000000000000000000000000000aa");
  });

  it("a 0 s ETA (LI.FI same-chain) ranks like a one-transaction swap, never as an instant 'Fastest' next to a '—'", async () => {
    const same = {from: USDT_ETH, to: USDC_ETH, amountIn: 3_000_000n};
    const providers = [venue("uniswap", {min: "2990000", eta: 15, sameChain: true}), venue("lifi", {min: "2990000", eta: 0, sameChain: true})];
    const snap = await engineOver(providers).quoteRoutes(live(same), () => {}, {USDC: 1, USDT: 1, ETH: 2300});
    const lifi = snap!.routes.find((r) => r.provider === "lifi")!;
    expect(lifi.etaSeconds).toBe(15);
    expect(lifi.tags).not.toContain("fastest");
    // Cross-chain: an unknown ETA ranks slow and still shows as unknown.
    const cross = await engineOver([venue("a", {min: "4990000", eta: 120}), venue("b", {min: "4990000", eta: 0})]).quoteRoutes(live(), () => {}, {USDC: 1, ETH: 2300});
    const b = cross!.routes.find((r) => r.provider === "b")!;
    expect(b.etaSeconds).toBe(0);
    expect(b.tags).not.toContain("fastest");
    expect(cross!.routes.find((r) => r.provider === "a")!.tags).toContain("fastest");
  });

  it("runs on the shared instances and never closes them", async () => {
    const v = venue("v", {min: "1"});
    const engine = engineOver([v]);
    await engine.quoteRoutes(live(), () => {});
    await engine.requoteRoute(request(), "v");
    expect(v.quotes).toBe(2);
    expect(v.closed).toBe(0);
  });
});

describe("a provider still loading (Omniston's lazy chunk)", () => {
  const withOmniston = (omniston: CrossChainProvider) =>
    createQuoteEngine({providers: () => [venue("bridge", {min: "4990000"}), omniston], gasPrice: async () => null, loading: lazyLoads});

  it("the page's first round waits for the chunk: Omniston is asked and counted, never 'not for this pair'", async () => {
    const omniston = lazyOmniston(DEFAULT_RUNTIME_CONFIG, storesReady(new Promise((r) => setTimeout(() => r(true), 30))), {});
    expect(omniston.enabled()).toBe(false);
    const {updates, onUpdate} = collect();
    const final = await withOmniston(omniston).quoteRoutes(live(), onUpdate);
    expect(updates[0]).toMatchObject({pending: ["bridge", "omniston"], asked: ["bridge", "omniston"], venues: ["bridge", "omniston"]});
    expect(final!.rejections).toMatchObject([{provider: "omniston", category: "pair"}]);
    // Loaded: the next rounds have nothing to wait for.
    expect(lazyLoads([omniston])).toBeNull();
  });

  it("still loading after LAZY_WAIT_MS: the round goes on without it, and it isn't counted either", async () => {
    vi.useFakeTimers();
    try {
      const omniston = lazyOmniston(DEFAULT_RUNTIME_CONFIG, storesReady(new Promise(() => {})), {});
      const {updates, onUpdate} = collect();
      const round = withOmniston(omniston).quoteRoutes(live(), onUpdate);
      await vi.advanceTimersByTimeAsync(LAZY_WAIT_MS - 1);
      expect(updates).toEqual([]);
      await vi.advanceTimersByTimeAsync(10);
      const final = await round;
      expect(updates[0]).toMatchObject({asked: ["bridge"], venues: ["bridge"]});
      expect(final!.routes.map((r) => r.provider)).toEqual(["bridge"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a round cancelled while it waits ends at once, asking nobody", async () => {
    const bridge = venue("bridge", {min: "4990000"});
    const omniston = lazyOmniston(DEFAULT_RUNTIME_CONFIG, storesReady(new Promise(() => {})), {});
    const engine = createQuoteEngine({providers: () => [bridge, omniston], gasPrice: async () => null, loading: lazyLoads});
    const c = new AbortController();
    const round = engine.quoteRoutes(live(), () => {}, undefined, c.signal);
    c.abort();
    expect(await round).toBeNull();
    expect(bridge.quotes).toBe(0);
  });
});

describe("requoteRoute", () => {
  it("returns the fresh route, untagged (one route)", async () => {
    const res = await engineOver([venue("cctp", {min: "4999230", eta: 45})]).requoteRoute(request(), "cctp");
    expect(res.reason).toBeNull();
    expect(res.route).toMatchObject({provider: "cctp", minDestAmount: 4_999_230n, tags: [], trust: "contracts", execution: "calldata"});
  });
  it("a venue that no longer routes it: no route, its reason", async () => {
    const res = await engineOver([venue("near_intents", {refuse: "1Click 400: minimum swap amount is $10 [dry=true a->b amount=1]"})]).requoteRoute(request(), "near_intents");
    expect(res).toEqual({route: null, reason: "Minimum $10 right now"});
  });
  it("a venue that no longer routes it, for a reason only its classification names", async () => {
    const res = await engineOver([venue("near_intents", {refuse: "an odd new text 4242", refuseReason: "chain_halted"})]).requoteRoute(request(), "near_intents");
    expect(res).toEqual({route: null, reason: "Paused on this network for now"});
  });
  it("a venue that isn't built here", async () => {
    expect(await engineOver([venue("lifi", {min: "1"})]).requoteRoute(request(), "relay")).toEqual({route: null, reason: "Not available in this browser right now"});
  });
});

describe("swapStatus", () => {
  it("asks the provider's tracker through the router; unknown states read as pending", async () => {
    const v = {...venue("lifi"), trackIntent: vi.fn(async () => ({state: "completed" as const, destTxHash: "0xdest"}))};
    const engine = engineOver([v]);
    const res = await engine.swapStatus("awk1.lifi.intent-1.0xsrc", "eip155:42161");
    expect(res.status).toBe("completed");
    expect(res.transactions).toEqual([{hash: "0xdest", type: "destination"}]);
    expect(v.trackIntent).toHaveBeenCalledWith(expect.objectContaining({intentId: "intent-1", sourceTxHash: "0xsrc"}));
    expect(res).not.toHaveProperty("depositReceived");
  });

  it("carries the venue's 'deposit arrived' that swap2-core's status drops (NEAR's PROCESSING: still pending)", async () => {
    const arrived = {...venue("near_intents"), trackIntent: vi.fn(async () => ({state: "pending" as const, depositReceived: true}))};
    const waiting = {...venue("relay"), trackIntent: vi.fn(async () => ({state: "pending" as const, depositReceived: false}))};
    const engine = engineOver([arrived, waiting]);
    // Two polls at once: each call reads its own venue's answer, never the other's.
    const [a, w] = await Promise.all([engine.swapStatus("awk1.near_intents.dep-1", "bitcoin:mainnet"), engine.swapStatus("awk1.relay.r-1", "eip155:1")]);
    expect(a).toEqual({status: "pending", transactions: [], depositReceived: true});
    expect(w).toEqual({status: "pending", transactions: []});
    expect(arrived.trackIntent).toHaveBeenCalledWith(expect.objectContaining({intentId: "dep-1"}));
  });
});
