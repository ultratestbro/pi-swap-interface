import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {CrossChainProvider, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {coolDownOnRateLimit, delegate, isWrapPair, narrowRoute, paced, payoutToSigner, retryAfterMs, withQuoteGap} from "../../../src/swap/providerWrappers";
import {friendlyReason, parseRejections} from "../../../src/swap/routes";

const ZERO = "0x0000000000000000000000000000000000000000";
const WETH_ETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const params = {sourceChain: "solana:mainnet", sourceToken: "SOL", destChain: "solana:mainnet", destToken: "x", amountIn: "1", destAddress: "me"} as QuoteParams;

function fake(name = "fake"): CrossChainProvider & {calls: number[]} {
  const calls: number[] = [];
  return {
    calls,
    name,
    supportsSameChain: true,
    enabled: () => true,
    supportsRoute: () => true,
    getQuote: async () => {
      calls.push(Date.now());
      return null;
    },
    buildDeposit: async () => {
      throw new Error("no");
    },
    trackIntent: async () => ({state: "pending"}),
  };
}

describe("paced", () => {
  beforeEach(() => vi.useFakeTimers({now: 0}));
  afterEach(() => vi.useRealTimers());

  it("starts calls at least gapMs apart, in order", async () => {
    const starts: number[] = [];
    const f = paced(1_000, async (i: number) => {
      starts.push(Date.now());
      return i;
    });
    const all = Promise.all([f(1), f(2), f(3)]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await all).toEqual([1, 2, 3]);
    expect(starts).toEqual([0, 1_000, 2_000]);
  });

  it("a call after a quiet spell runs at once", async () => {
    const starts: number[] = [];
    const f = paced(1_000, async () => void starts.push(Date.now()));
    await f();
    await vi.advanceTimersByTimeAsync(5_000);
    await f();
    expect(starts).toEqual([0, 5_000]);
  });
});

describe("withQuoteGap", () => {
  beforeEach(() => vi.useFakeTimers({now: 0}));
  afterEach(() => vi.useRealTimers());

  it("spaces getQuote and skips a call whose round was cancelled while it waited", async () => {
    const p = fake("jupiter");
    const gapped = withQuoteGap(p, 2_100);
    const stale = new AbortController();
    const first = gapped.getQuote(params);
    const second = gapped.getQuote(params, stale.signal);
    const third = gapped.getQuote(params);
    stale.abort();
    await vi.advanceTimersByTimeAsync(4_200);
    await Promise.all([first, second, third]);
    expect(p.calls).toEqual([0, 4_200]);
    expect(gapped.name).toBe("jupiter");
    expect(gapped.supportsSameChain).toBe(true);
  });
});

describe("payoutToSigner", () => {
  it("refuses a dry quote to another recipient (the live one would refuse at Confirm) and passes the signer's own", async () => {
    const p = fake("jupiter");
    const only = payoutToSigner(p);
    const refusals: string[] = [];
    const other = await only.getQuote({...params, destAddress: "someoneElse", refundAddress: "me", dry: true, onRefusal: (r) => refusals.push(r)});
    expect(other).toBeNull();
    expect(p.calls).toHaveLength(0); // never reaches the venue
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/^jupiter: the recipient must be the signing wallet/);
    expect(parseRejections(refusals)[0]).toMatchObject({provider: "jupiter", reason: "Pays only the wallet that signs", category: "setup"});
    await only.getQuote({...params, destAddress: "me", refundAddress: "me", dry: true});
    expect(p.calls).toHaveLength(1);
    expect(only.supportsSameChain).toBe(true);
  });

  it("Jupiter's own live refusal reads the same way", () => {
    expect(friendlyReason("jupiter", "the recipient must be the signing wallet (Jupiter pays the taker)")).toBe("Pays only the wallet that signs");
  });
});

describe("coolDownOnRateLimit", () => {
  const HOUR = 3_600_000;
  /** A venue that answers each call with the next scripted refusal, or a quote. */
  function scripted(answers: (string | "quote")[]) {
    const p = fake("lifi");
    let i = 0;
    p.getQuote = async (qp) => {
      p.calls.push(i);
      const a = answers[i++] ?? "quote";
      if (a !== "quote") {
        qp.onRefusal?.(`lifi: ${a}`);
        return null;
      }
      return {provider: "lifi", intentId: "x", depositAddress: "", depositMemo: null, sourceAmount: "1", destAmount: "1", minDestAmount: "1", feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: 0};
    };
    return p;
  }
  const ask = async (p: CrossChainProvider) => {
    const refusals: string[] = [];
    const q = await p.getQuote({...params, onRefusal: (r) => refusals.push(r)});
    return {q, refusals};
  };

  it("after LI.FI's 429 it stops asking until the wait it named is over, and says how long is left", async () => {
    let now = 1_000_000;
    const venue = scripted(["Rate limit exceeded, retry in 2 hours"]);
    const cooled = coolDownOnRateLimit(venue, 15 * 60_000, () => now);
    expect(await ask(cooled)).toEqual({q: null, refusals: ["lifi: Rate limit exceeded, retry in 2 hours"]});
    expect(venue.calls).toHaveLength(1);

    now += 60_000;
    expect(await ask(cooled)).toEqual({q: null, refusals: ["lifi: rate limit exceeded, retry in ~119 min"]});
    expect(venue.calls).toHaveLength(1); // nothing sent while it cools

    now += 2 * HOUR;
    const after = await ask(cooled);
    expect(after.q).not.toBeNull(); // asked afresh: the venue's own answer, never a remembered one
    expect(venue.calls).toHaveLength(2);
  });

  it("passes the venue's classification on with its text, and classifies its own cooling refusal", async () => {
    let now = 0;
    const venue = fake("lifi");
    venue.getQuote = async (qp) => {
      qp.onRefusal?.("lifi: HTTP 429", {reason: "rate_limited", retryAfterMs: 60_000});
      return null;
    };
    const cooled = coolDownOnRateLimit(venue, 15 * 60_000, () => now);
    const heard: unknown[] = [];
    await cooled.getQuote({...params, onRefusal: (r, info) => heard.push([r, info])});
    now += 1_000;
    await cooled.getQuote({...params, onRefusal: (r, info) => heard.push([r, info])});
    expect(heard).toEqual([
      ["lifi: HTTP 429", {reason: "rate_limited", retryAfterMs: 60_000}],
      ["lifi: rate limit exceeded, retry in ~15 min", {reason: "rate_limited", retryAfterMs: 15 * 60_000 - 1_000}],
    ]);
  });

  it("a 429 that names no wait cools for the fallback; other refusals don't cool", async () => {
    let now = 0;
    const venue = scripted(["no route found", "HTTP 429"]);
    const cooled = coolDownOnRateLimit(venue, 15 * 60_000, () => now);
    await ask(cooled);
    await ask(cooled);
    expect(venue.calls).toHaveLength(2);
    now += 14 * 60_000;
    expect((await ask(cooled)).refusals).toEqual(["lifi: rate limit exceeded, retry in ~1 min"]);
    now += 60_000;
    await ask(cooled);
    expect(venue.calls).toHaveLength(3);
  });

  it("cools on what the route list reads as a rate limit, not on a 429 inside an amount or a floor", async () => {
    const venue = scripted(["floor breach (min=429 < floor=500)", "below the 1Click minimum (at least 0.429 ETH)", "Too many requests"]);
    const cooled = coolDownOnRateLimit(venue, 15 * 60_000, () => 0);
    await ask(cooled);
    await ask(cooled);
    await ask(cooled);
    expect(venue.calls).toHaveLength(3);
    expect((await ask(cooled)).refusals).toEqual(["lifi: rate limit exceeded, retry in ~15 min"]);
    expect(venue.calls).toHaveLength(3);
  });

  it("never returns a quote while cooling, and caps a wait the venue overstates at 3 hours", async () => {
    let now = 0;
    const venue = scripted(["Rate limit exceeded, retry in 400 hours"]);
    const cooled = coolDownOnRateLimit(venue, 15 * 60_000, () => now);
    await ask(cooled);
    now += 3 * HOUR - 1;
    expect((await ask(cooled)).q).toBeNull();
    expect(venue.calls).toHaveLength(1);
    now += 1;
    expect((await ask(cooled)).q).not.toBeNull();
  });

  it("keeps the venue's identity and members (one shared instance underneath)", () => {
    const venue = fake("lifi");
    const cooled = coolDownOnRateLimit(venue);
    expect(cooled.name).toBe("lifi");
    expect(cooled.supportsSameChain).toBe(true);
  });

  it("retryAfterMs reads LI.FI's text and our own", () => {
    expect(retryAfterMs("lifi: Rate limit exceeded, retry in 2 hours")).toBe(2 * HOUR);
    expect(retryAfterMs("lifi: rate limit exceeded, retry in ~15 min")).toBe(15 * 60_000);
    expect(retryAfterMs("retry in 30 seconds")).toBe(30_000);
    // The list's busy rule reads "retry after" too (RETRY_WAIT): the cooldown keeps the same wait.
    expect(retryAfterMs("x: too many requests, retry after 2 hours")).toBe(2 * HOUR);
    expect(retryAfterMs("lifi: HTTP 429")).toBeNull();
  });
});

describe("delegate", () => {
  it("binds every member to the original instance (NEAR's trackIntent calls this.notifyDeposit)", async () => {
    const notified: string[] = [];
    const original = {
      ...fake("near_intents"),
      notifyDeposit: async (id: string) => void notified.push(id),
      async trackIntent(this: CrossChainProvider, ref: {intentId: string}) {
        await this.notifyDeposit?.(ref.intentId, "0xhash");
        return {state: "pending" as const};
      },
    };
    const d = delegate(original, {supportsRoute: () => false});
    await d.trackIntent({intentId: "i1"});
    expect(notified).toEqual(["i1"]);
    expect(d.supportsRoute({chain: "a", token: "b"}, {chain: "a", token: "c"})).toBe(false);
  });

  it("has exactly the optional members the original has", () => {
    const d = delegate(fake());
    expect("preflightDeposit" in d).toBe(false);
    expect("buildClaim" in d).toBe(false);
    expect("remote" in d).toBe(false);
    const withClaim = delegate({...fake(), buildClaim: async () => null, claimTargets: () => ["0x1"]});
    expect(withClaim.claimTargets?.("eip155:1")).toEqual(["0x1"]);
    expect("ownGasEstimate" in d).toBe(false);
  });

  it("forwards getQuotes (core 0.16, D47: CCTP's Fast and Standard), but never past a wrapper of getQuote alone", async () => {
    const listed: string[] = [];
    const cctp = {...fake("cctp"), getQuotes: async () => (listed.push("both"), [])};
    const d = delegate(cctp);
    await d.getQuotes?.(params);
    expect(listed).toEqual(["both"]);
    expect("getQuotes" in delegate(fake())).toBe(false);
    // A gap, a gate or a cool-down over getQuote: the router must not reach the venue around it.
    const gated = delegate(cctp, {getQuote: async () => null});
    expect("getQuotes" in gated).toBe(false);
    expect("getQuotes" in withQuoteGap(cctp, 10)).toBe(false);
    const both = delegate(cctp, {getQuote: async () => null, getQuotes: async () => []});
    expect(typeof both.getQuotes).toBe("function");
  });

  it("keeps ownGasEstimate (swap2-core 0.13.0): without it the engine would send a 0x native sale with the quoted gas limit", () => {
    const d = delegate({...fake("zeroex"), ownGasEstimate: true});
    expect(d.ownGasEstimate).toBe(true);
  });
});

describe("isWrapPair / narrowRoute", () => {
  it("native ↔ its wrapped token on one EVM chain only", () => {
    expect(isWrapPair({chain: "eip155:1", token: "ETH"}, {chain: "eip155:1", token: WETH_ETH})).toBe(true);
    expect(isWrapPair({chain: "eip155:1", token: "WETH"}, {chain: "eip155:1", token: ZERO})).toBe(true);
    expect(isWrapPair({chain: "eip155:1", token: "ETH"}, {chain: "eip155:1", token: USDT_ETH})).toBe(false);
    expect(isWrapPair({chain: "eip155:1", token: "ETH"}, {chain: "eip155:8453", token: WETH_ETH})).toBe(false);
    expect(isWrapPair({chain: "solana:mainnet", token: "SOL"}, {chain: "solana:mainnet", token: ZERO})).toBe(false);
  });

  it("narrowRoute ANDs the predicate with the provider's own check", () => {
    const p = {...fake(), supportsRoute: vi.fn(() => true)};
    const n = narrowRoute(p, isWrapPair);
    expect(n.supportsRoute({chain: "eip155:1", token: "ETH"}, {chain: "eip155:1", token: USDT_ETH})).toBe(false);
    expect(p.supportsRoute).not.toHaveBeenCalled();
    expect(n.supportsRoute({chain: "eip155:1", token: "ETH"}, {chain: "eip155:1", token: WETH_ETH})).toBe(true);
  });
});
