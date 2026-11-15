import {describe, expect, it} from "vitest";
import {friendlyReason, orderRoutes, parseRejections, toRouteView} from "../../../src/swap/routes";
import {executionOf, routeFloor, toWebRoute} from "../../../src/swap/webRoute";
import {routeMeta} from "../../../src/screens/routelist/RouteRow";

const q = (provider: string, min: string, extra: Record<string, unknown> = {}) =>
  ({
    provider,
    sourceAmount: "5000000",
    destAmount: min,
    minDestAmount: min,
    etaSeconds: 30,
    feeUsd: 0,
    validUntilMs: 0,
    tags: [],
    relativeValue: 1,
    netValueUsd: null,
    ...extra,
  }) as Parameters<typeof toWebRoute>[0];

describe("browser transport failures (refusals.ts)", () => {
  it("reads fetch, rate-limit and abort texts plainly", () => {
    expect(friendlyReason("lifi", "TypeError: Failed to fetch")).toBe("Couldn't reach it — tap refresh");
    expect(friendlyReason("lifi", "NetworkError when attempting to fetch resource.")).toBe("Couldn't reach it — tap refresh");
    expect(friendlyReason("relay", "Load failed")).toBe("Couldn't reach it — tap refresh");
    expect(friendlyReason("relay", "relay: HTTP 429 Too Many Requests")).toBe("Busy right now — try again soon");
    expect(friendlyReason("jupiter", "Rate limit exceeded")).toBe("Busy right now — try again soon");
    expect(friendlyReason("near_intents", "signal is aborted without reason")).toBe("Didn't answer in time — tap refresh");
    expect(friendlyReason("near_intents", "The operation was aborted due to timeout")).toBe("Didn't answer in time — tap refresh");
  });
  it("the router's 8 s cap reads as a slow venue", () => {
    expect(parseRejections(["thorchain: quote timed out after 8000ms"])).toEqual([
      {
        provider: "thorchain",
        reason: "Didn't answer in time — tap refresh",
        category: "unreachable",
        detail: "It took longer than the quote round allows, so the list went on without it.",
        raw: "quote timed out after 8000ms",
      },
    ]);
  });
  it("1Click's network error is the browser not reaching it, an HTTP 5xx is their outage", () => {
    expect(parseRejections(["near_intents: 1Click network error: Failed to fetch"])[0]).toMatchObject({reason: "Couldn't reach it — tap refresh", category: "unreachable"});
    expect(parseRejections(["near_intents: 1Click 503: upstream [dry=true a->b amount=1]"])[0]).toMatchObject({reason: "Unavailable right now — try later", category: "unavailable"});
  });
});

describe("toWebRoute", () => {
  it("a txRequest means the wallet signs; none means a deposit address", () => {
    expect(toWebRoute(q("relay", "1", {txRequest: {to: "0x4cd0", approvalAddress: "0x4cd0"}})).execution).toBe("calldata");
    expect(toWebRoute(q("near_intents", "1")).execution).toBe("deposit");
  });
  it("Chainflip, Omniston and Symbiosis (its TON source) are signed even though their dry quote has no txRequest", () => {
    expect(executionOf({provider: "chainflip"})).toBe("calldata");
    expect(executionOf({provider: "omniston"})).toBe("calldata");
    // A TON jetton transfer with depositAddress "": a QR payer can't send it, so it must never read as a deposit route.
    expect(executionOf({provider: "symbiosis"})).toBe("calldata");
    // LI.FI 0.8.0 and USDT0 0.5.0 previews come back price-only (no txRequest): still a wallet signature, never a deposit.
    expect(executionOf({provider: "lifi"})).toBe("calldata");
    expect(executionOf({provider: "usdt0"})).toBe("calldata");
    // 0x's dry quote is its price answer, no transaction (D38): a Settler call the wallet signs, never a deposit.
    expect(executionOf({provider: "zeroex"})).toBe("calldata");
    expect(toWebRoute(q("zeroex", "1")).execution).toBe("calldata");
    // Across' dry quote carries its deposit call already.
    expect(toWebRoute(q("across", "1", {txRequest: {to: "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64", approvalAddress: "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64"}})).execution).toBe("calldata");
  });
  it("names an Omniston swap's route steps (D35 part C), for the route list to refuse by; nothing for anything else", () => {
    const steps = (routeSteps: unknown, settlement = "swap") => toWebRoute(q("omniston", "1", {providerData: {settlement, ...(routeSteps === undefined ? {} : {routeSteps: String(routeSteps)})}}));
    expect(steps(JSON.stringify([{protocol: "StonFiV1", inputJetton: null, outputJetton: "EQCxE6mU"}])).tonSwapSteps).toEqual(["StonFiV1"]);
    expect(steps(JSON.stringify([{protocol: "StonFiV2"}, {protocol: "StonFiV2"}])).tonSwapSteps).toEqual(["StonFiV2", "StonFiV2"]);
    expect(steps(JSON.stringify([{protocol: "split(StonFiV2|DeDust)"}])).tonSwapSteps).toEqual(["split(StonFiV2|DeDust)"]);
    // Unreadable or missing: no steps, so refused.
    expect(steps("{not json").tonSwapSteps).toEqual([]);
    expect(steps(undefined).tonSwapSteps).toEqual([]);
    expect(steps(JSON.stringify({protocol: "StonFiV1"})).tonSwapSteps).toEqual([]);
    // An escrow (an order), or another venue: no such field.
    expect(steps(JSON.stringify([{protocol: "StonFiV1"}]), "escrow")).not.toHaveProperty("tonSwapSteps");
    expect(toWebRoute(q("lifi", "1", {providerData: {settlement: "swap", routeSteps: "[]"}}))).not.toHaveProperty("tonSwapSteps");
  });
  it("flags a memo and carries the venue's badge", () => {
    expect(toWebRoute(q("thorchain", "1", {depositMemo: "=:ETH.ETH:0xabc"}))).toMatchObject({hasMemo: true, trust: "own-node"});
    expect(toWebRoute(q("near_intents", "1", {depositMemo: null}))).toMatchObject({hasMemo: false, trust: "provider-api"});
    expect(toWebRoute(q("near_intents", "1", {depositMemo: ""})).hasMemo).toBe(false);
    expect(toWebRoute(q("cctp", "1")).trust).toBe("contracts");
    expect(toWebRoute(q("mystery", "1")).trust).toBe("provider-api");
  });
  it("prices a bridge fee the venue's feeUsd leaves out (USDT0), never one it already lists (LI.FI)", () => {
    const eth = {usd: 2000, decimals: 18};
    const tron = {feeUsd: 0.3, providerData: {placeholder: "recipient", nativeFee: "6675988297009553"}};
    expect(toWebRoute(q("usdt0", "1", tron), undefined, undefined, eth).bridgeFeeUsd).toBeCloseTo(13.352, 3);
    expect(routeMeta(toWebRoute(q("usdt0", "1", tron), undefined, undefined, eth))).toContain("fees $13.65");
    // LI.FI's feeCosts already carry the LayerZero fee: its feeUsd stays the whole figure.
    const lifi = toWebRoute(q("lifi", "1", {feeUsd: 1.48, txRequest: {nativeFee: "627672100999764"}}), undefined, undefined, eth);
    expect(lifi).not.toHaveProperty("bridgeFeeUsd");
    expect(routeMeta(lifi)).toContain("fees $1.48");
    // No fee, or the native coin unpriced: nothing added.
    expect(toWebRoute(q("usdt0", "1", {feeUsd: 0.3}), undefined, undefined, eth)).not.toHaveProperty("bridgeFeeUsd");
    expect(toWebRoute(q("usdt0", "1", tron))).not.toHaveProperty("bridgeFeeUsd");
    expect(routeMeta(toWebRoute(q("usdt0", "1", tron)))).toContain("fees $0.30");
  });
  it("the floor sits a margin under the venue's minimum: min(0.5%, the slippage the route was quoted at)", () => {
    const tight = toWebRoute(q("uniswap", "1000000"), undefined, undefined, undefined, 5);
    expect(tight.floorBps).toBe(5);
    expect(routeFloor(tight)).toBe(999_500n); // −0.05 %
    const usual = toWebRoute(q("uniswap", "1000000"), undefined, undefined, undefined, 100);
    expect(usual.floorBps).toBe(50);
    expect(routeFloor(usual)).toBe(995_000n); // −0.5 %
    expect(routeFloor(toWebRoute(q("uniswap", "1000000")))).toBe(995_000n); // no slippage known: the 0.5 % margin
  });
  it("orderRoutes keeps the web fields", () => {
    const list = orderRoutes([toWebRoute(q("a", "1", {relativeValue: 0.9})), toWebRoute(q("b", "2", {tags: ["best"]}))]);
    expect(list.map((r) => [r.provider, r.execution])).toEqual([
      ["b", "deposit"],
      ["a", "deposit"],
    ]);
  });
});

describe("approval spender the dry quote leaves unnamed", () => {
  const ARB_VAULT = "0x79001a5e762f3bEFC8e5871b42F6734e00498920";
  it("Chainflip: the vault for an ERC-20 source on Ethereum / Arbitrum", () => {
    expect(toRouteView(q("chainflip", "1"), {chain: "eip155:42161", isToken: true}).approvalSpender).toBe(ARB_VAULT);
    expect(toRouteView(q("chainflip", "1"), {chain: "eip155:1", isToken: true}).approvalSpender).toBe("0xF5e10380213880111522dd0efD3dbb45b9f62Bcc");
  });
  it("0x: canonical Permit2 for a token sale, nothing for a native one (D38)", () => {
    const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
    expect(toRouteView(q("zeroex", "1"), {chain: "eip155:8453", isToken: true}).approvalSpender).toBe(PERMIT2);
    expect(toRouteView(q("zeroex", "1"), {chain: "eip155:8453", isToken: false}).approvalSpender).toBeNull();
    expect(toRouteView(q("zeroex", "1"), {chain: "eip155:100", isToken: true}).approvalSpender).toBeNull();
  });
  it("no spender for a native source or a non-EVM chain", () => {
    expect(toRouteView(q("chainflip", "1"), {chain: "eip155:42161", isToken: false}).approvalSpender).toBeNull();
    expect(toRouteView(q("chainflip", "1"), {chain: "tron:728126428", isToken: true}).approvalSpender).toBeNull();
  });
});
