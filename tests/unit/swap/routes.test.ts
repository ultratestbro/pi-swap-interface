// Ported from cp0x-elysium apps/mobile/lib/swap/routes.test.ts @756b115 (import paths changed).
import {describe, expect, it} from "vitest";
import {isStale, keepSelection, orderRoutes, parseRejections, tagRoutes, toRouteView, type RouteView} from "../../../src/swap/routes";

const q = (provider: string, min: string, eta: number, extra: Record<string, unknown> = {}) =>
  ({
    provider,
    sourceAmount: "100000000",
    destAmount: min,
    minDestAmount: min,
    etaSeconds: eta,
    feeUsd: 0.1,
    validUntilMs: 0,
    tags: [],
    relativeValue: 1,
    netValueUsd: null,
    ...extra,
  }) as Parameters<typeof toRouteView>[0];

describe("toRouteView", () => {
  it("parses base units to bigint and keeps the auction's tags", () => {
    const r = toRouteView(
      q("cctp", "99989000", 180, {
        tags: ["best"],
        relativeValue: 1,
        txRequest: {approvalAddress: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"},
      }),
    );
    expect(r.minDestAmount).toBe(99_989_000n);
    expect(r.tags).toEqual(["best"]);
    expect(r.approvalSpender).toBe("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
    expect(r.nativeFee).toBe(0n);
  });
  it("reads a declared bridge fee and itemized fees; garbage amounts read as 0", () => {
    const r = toRouteView(
      q("usdt0", "50000000", 240, {
        txRequest: {nativeFee: "45676658340221"},
        fees: [{type: "network", amount: "12", token: "ETH", included: false}],
        destAmount: "x",
      }),
    );
    expect(r.nativeFee).toBe(45_676_658_340_221n);
    expect(r.fees).toEqual([{type: "network", amount: 12n, token: "ETH", included: false}]);
    expect(r.destAmount).toBe(0n);
  });
  it("a price-only quote's bridge fee comes from providerData; a txRequest's own fee wins", () => {
    expect(toRouteView(q("usdt0", "100000000", 300, {providerData: {placeholder: "recipient", nativeFee: "6675988297009553"}})).nativeFee).toBe(
      6_675_988_297_009_553n,
    );
    expect(toRouteView(q("usdt0", "1", 300, {txRequest: {nativeFee: "7"}, providerData: {nativeFee: "9"}})).nativeFee).toBe(7n);
    expect(toRouteView(q("lifi", "1", 300, {providerData: {nativeFee: "0x10"}})).nativeFee).toBe(0n);
  });
});

describe("orderRoutes", () => {
  it("best first, then value, then guaranteed output, then speed", () => {
    const list = [
      toRouteView(q("near_intents", "99481493", 47, {relativeValue: 0.995})),
      toRouteView(q("lifi", "99735883", 2, {tags: ["fastest"], relativeValue: 0.997})),
      toRouteView(q("cctp", "99989000", 180, {tags: ["best"], relativeValue: 1})),
      toRouteView(q("omniston", "99896619", 240, {relativeValue: 0.997})),
    ];
    expect(orderRoutes(list).map((r) => r.provider)).toEqual(["cctp", "omniston", "lifi", "near_intents"]);
  });
});

describe("tagRoutes", () => {
  it("tags best (largest minimum) and fastest (when another route)", () => {
    const t = tagRoutes([toRouteView(q("a", "100", 300)), toRouteView(q("b", "99", 5))]);
    expect(t.map((r) => r.tags)).toEqual([["best"], ["fastest"]]);
  });
  it("one route that is both best and fastest is just best", () => {
    const t = tagRoutes([toRouteView(q("a", "100", 5)), toRouteView(q("b", "99", 300))]);
    expect(t.map((r) => r.tags)).toEqual([["best"], []]);
  });
  it("a lone route carries no tag", () => {
    expect(tagRoutes([toRouteView(q("a", "1", 1))])[0]!.tags).toEqual([]);
  });
});

describe("keepSelection", () => {
  const list: RouteView[] = [
    toRouteView(q("lifi", "1", 1, {tags: ["fastest"]})),
    toRouteView(q("cctp", "2", 2, {tags: ["best"]})),
  ];
  it("keeps the user's pick while it is offered", () => {
    expect(keepSelection(list, "lifi")).toBe("lifi");
  });
  it("falls back to the best route", () => {
    expect(keepSelection(list, "thorchain")).toBe("cctp");
    expect(keepSelection(list, null)).toBe("cctp");
    expect(keepSelection([], null)).toBeNull();
  });
  it("a venue's several routes are picked and kept each by its routeKey (D47)", () => {
    const routes = [
      {...toRouteView(q("cctp", "2", 45, {tags: ["best"]})), routeId: "fast"},
      {...toRouteView(q("cctp", "3", 1080)), routeId: "standard"},
    ];
    expect(keepSelection(routes, "cctp/standard")).toBe("cctp/standard");
    expect(keepSelection(routes, null)).toBe("cctp/fast");
    // A pick made before the venue named its routes isn't one of them: the best route.
    expect(keepSelection(routes, "cctp")).toBe("cctp/fast");
  });
});

describe("parseRejections", () => {
  it("splits the venue prefix and classifies the rest", () => {
    expect(parseRejections(["omniston: no resolver quoted this route/amount", "weird"])).toEqual([
      {
        provider: "omniston",
        reason: "No route for this pair or amount",
        category: "pair",
        detail: "It found no way to make this swap right now — another amount may work.",
        raw: "no resolver quoted this route/amount",
      },
      {provider: "", reason: "Weird", category: "other", raw: "weird"},
    ]);
  });

  it("says the common refusals plainly", () => {
    const usdc = {symbol: "USDC", decimals: 6};
    const reasons = parseRejections(
      [
        "thorchain: thorchain: THORChain fees 20.08% \u2014 too expensive at this amount (cap 5%)",
        "chainflip: chainflip: below the minimum deposit (20000000 USDC)",
        "near_intents: 1Click 400: Temporary swap limits: minimum swap amount is $100 [dry=true tron:728126428->eip155:8453 amount=171798507]",
        "near_intents: below the 1Click minimum ($100)",
        "near_intents: 1Click 400: Quoting for this pair is not available [dry=true eip155:1->tron:728126428 amount=2000000]",
        "near_intents: 1Click 400: No liquidity available [dry=true solana:x->tron:728126428 amount=1]",
        "near_intents: quote timed out after 8000ms",
        "thorchain: returned no quote",
        "thorchain: thorchain: SOL chain is halted / paused on THORChain",
        "thorchain: thorchain: amount below THORChain recommended minimum",
        "near_intents: 1Click 500: Internal server error [dry=true a->b amount=1]",
        "near_intents: 1Click 521:  [dry=true solana:x->near:mainnet amount=20000000]",
      ],
      usdc,
    ).map((r) => r.reason);
    expect(reasons).toEqual([
      "Fees would take 20.08% of this amount",
      "Minimum 20 USDC",
      "Minimum $100 right now",
      "Minimum $100 right now",
      "Not quoting this pair right now",
      "Not enough liquidity right now",
      "Didn't answer in time — tap refresh",
      "No quote right now",
      "SOL trading is paused right now",
      "Below its minimum amount",
      "Unavailable right now — try later",
      "Unavailable right now — try later",
    ]);
    expect(parseRejections(["chainflip: chainflip: below the minimum deposit (10000000000000000 ETH)"], usdc)[0]!.reason).toBe("Below its minimum amount");
  });

  it("Relay and Symbiosis refusals read plainly", () => {
    const rows = parseRejections([
      // What the router really hands over: RelayRefusal's own "relay: " prefix, once.
      "relay: the deposit calls 0xa5f565650890fba1824ee0f21ebbbf660a179934, not the pinned depository [tx-target]",
      "relay: relay: the order pays 0x1111111111111111111111111111111111111111, not the recipient [output-recipient]",
      "symbiosis: sell amount 100000 is below Symbiosis' minimum 300000 on Base",
      "symbiosis: result 9 is above Symbiosis' maximum 5 on TON",
    ]);
    expect(parseRejections(["relay: relay: the deposit calls 0xa5, not the pinned depository [tx-target]"])[0]!.reason).toBe("Doesn't take this token as a source");
    // [tx-target] means "a router we don't sign for" only from Relay; elsewhere the words decide.
    expect(parseRejections(["lifi: something else [tx-target]"])[0]!.reason).toBe("Something else");
    expect(rows.map((r) => [r.reason, r.category])).toEqual([
      ["Doesn't take this token as a source", "pair"],
      ["Can't confirm it pays you", "safety"],
      ["Below its minimum amount", "amount"],
      ["Above its maximum for this pair", "amount"],
    ]);
    expect(parseRejections(["symbiosis: sell amount 100000 is below Symbiosis' minimum 300000 on Base"], {symbol: "USDC", decimals: 6})[0]!.reason).toBe("Minimum 0.3 USDC");
  });
});

describe("isStale", () => {
  it("expires 5 s early; 0 = no expiry", () => {
    expect(isStale({validUntilMs: 0}, 1e12)).toBe(false);
    expect(isStale({validUntilMs: 10_000}, 4_000)).toBe(false);
    expect(isStale({validUntilMs: 10_000}, 6_000)).toBe(true);
  });
});

describe("toRouteView approval spender", () => {
  const BASE_ORDERS = "0xe7405fAcDEDB2512e91F2886BDff13231343aF5E";
  it("names Omniston's audited order protocol for an ERC-20 source its quote leaves unnamed", () => {
    expect(toRouteView(q("omniston", "1", 240), {chain: "eip155:8453", isToken: true}).approvalSpender).toBe(BASE_ORDERS);
  });
  it("no spender for a native source, another venue, or a chain without an order protocol", () => {
    expect(toRouteView(q("omniston", "1", 240), {chain: "eip155:8453", isToken: false}).approvalSpender).toBeNull();
    expect(toRouteView(q("lifi", "1", 2), {chain: "eip155:8453", isToken: true}).approvalSpender).toBeNull();
    expect(toRouteView(q("omniston", "1", 240), {chain: "eip155:4663", isToken: true}).approvalSpender).toBeNull();
  });
  it("the quote's own spender wins", () => {
    const own = "0x1111111111111111111111111111111111111111";
    expect(toRouteView(q("omniston", "1", 240, {txRequest: {approvalAddress: own}}), {chain: "eip155:8453", isToken: true}).approvalSpender).toBe(own);
  });
});
