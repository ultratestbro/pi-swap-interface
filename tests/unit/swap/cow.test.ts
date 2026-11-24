// CoW Protocol on the page (D48): a gasless order counts no swap gas, the venue's scope and spender, a signed-only
// route, and how an order reads on the progress sheet.
import {describe, expect, it} from "vitest";
import {GPV2_VAULT_RELAYER} from "@anywalletkit/protocol-swap2-core";
import type {SwapRecord} from "../../../src/contracts/activity";
import {newRecord, parseStored, statusView, swapSteps} from "../../../src/activity/inflight";
import {APPROVE_GAS, routeGasUnits} from "../../../src/swap/gas";
import {ORDER_VENUES, cowServes, orderSpender, providerName, venueScope} from "../../../src/swap/providerMeta";
import {executionOf} from "../../../src/swap/webRoute";
import {toRouteView} from "../../../src/swap/routes";

const quote = {provider: "cow", sourceAmount: "5000000", destAmount: "1", minDestAmount: "1", etaSeconds: 30, feeUsd: 0, validUntilMs: 0, tags: [], relativeValue: 1, netValueUsd: null, gasless: true};
import {DEFAULT_ON_PROVIDERS, buildProviders} from "../../../src/swap/providers";
import {DEFAULT_RUNTIME_CONFIG} from "../../../src/config/defaults";
import {createProviderStores} from "../../../src/swap/stores";
import {finalStep, walletSteps} from "../../../src/screens/review/ReviewSheet";
import {classifyRefusal} from "../../../src/swap/refusals";

const side = (caip2: string, symbol: string, contract: string | null = "0xToken") => ({caip2, family: "evm", symbol, contract});

describe("CoW on the page", () => {
  it("a gasless order costs no swap gas: only its approval, which a permit spares", () => {
    // protocol-swap2-cow 0.1.0: providerData.permit is "offered" or "none" — both truthy strings.
    expect(routeGasUnits({gasless: true, providerData: {approvalAddress: GPV2_VAULT_RELAYER, permit: "none"}}, true)).toBe(APPROVE_GAS);
    expect(routeGasUnits({gasless: true, providerData: {permit: "offered"}}, true)).toBe(0n);
    expect(toRouteView({...quote, providerData: {permit: "none", approvalAddress: GPV2_VAULT_RELAYER}}).gasless).toEqual({permit: false});
    expect(toRouteView({...quote, providerData: {permit: "offered"}}).gasless).toEqual({permit: true});
    // eth-flow: a real transaction with its own limit.
    expect(routeGasUnits({txRequest: {gasLimit: "150000", to: "0xEthFlow"}}, false)).toBe(150_000n);
  });

  it("a token sale is signed in the wallet, never offered as a deposit address", () => {
    expect(executionOf({provider: "cow"})).toBe("calldata");
  });

  it("serves the same network on Ethereum, Arbitrum and Base, its vault relayer as the spender", () => {
    expect(["eip155:1", "eip155:42161", "eip155:8453"].every(cowServes)).toBe(true);
    expect(cowServes("eip155:10")).toBe(false);
    expect(orderSpender("cow", "eip155:8453")).toBe(GPV2_VAULT_RELAYER);
    expect(orderSpender("cow", "eip155:10")).toBeNull();
    expect(venueScope("cow", side("eip155:1", "USDC"), side("eip155:8453", "USDC"))).toBe("Same-network swaps only");
    expect(venueScope("cow", side("eip155:10", "USDC"), side("eip155:10", "WETH"))).toBe("Not on this network");
    expect(providerName("cow")).toBe("CoW Protocol");
    expect(ORDER_VENUES.has("cow")).toBe(true);
  });

  it("is built by default, with its permit step forwarded through the page's wrappers", () => {
    expect(DEFAULT_ON_PROVIDERS).toContain("cow");
    const built = buildProviders(DEFAULT_RUNTIME_CONFIG, createProviderStores(), {});
    const p = built.find((x) => x.name === "cow");
    expect(p).toBeDefined();
    // Without applyPermit the engine would always send an approval transaction instead of the gas-free permit.
    for (const k of ["applyPermit", "buildCancel", "registerCancel", "cancelTargets", "registerSignedOrder"] as const) expect(typeof p![k]).toBe("function");
  });

  it("an orderbook it couldn't reach reads as a connection problem, not as no route", () => {
    expect(classifyRefusal("cow", "cow: the orderbook is unreachable (TypeError)", undefined, "upstream_unavailable").category).toBe("unreachable");
  });

  it("the review says the wallet signs the order", () => {
    const route = {provider: "cow", approvalSpender: GPV2_VAULT_RELAYER};
    expect(walletSteps(route, "5 USDC")).toMatch(/gas-free permit/);
    expect(finalStep(route)).toBe("sign the order — no gas");
    expect(finalStep({provider: "cow", approvalSpender: null})).toBe("sign the swap");
  });
});

describe("a CoW order's progress", () => {
  const order = (over: Partial<SwapRecord> = {}): SwapRecord => ({
    ...newRecord({
      id: "awk1.cow.x",
      accountId: "evm:0xme",
      provider: "cow",
      from: {caip2: "eip155:8453", chain: "base", symbol: "USDC", decimals: 6},
      to: {caip2: "eip155:8453", chain: "base", symbol: "WETH", decimals: 18},
      amountIn: 5_000_000n,
      expectedOut: 1n,
      minOut: 1n,
      recipient: "0xme",
      order: true,
    }),
    ...over,
  });

  it("signs the order, then a solver fills it — no separate delivery step", () => {
    const signing = swapSteps(order({status: "submitting", stage: "signing", approvals: 0}), "Base");
    expect(signing.map((s) => [s.key, s.label, s.state])).toEqual([
      ["confirm", "Sign the order", "active"],
      ["swap", "A solver fills USDC → WETH", "todo"],
    ]);
    expect(swapSteps(order(), "Base").map((s) => s.state)).toEqual(["done", "active"]);
    expect(swapSteps(order({status: "completed"}), "Base").map((s) => s.state)).toEqual(["done", "done"]);
    expect(swapSteps(order({status: "expired"}), "Base").map((s) => s.state)).toEqual(["done", "failed"]);
  });

  it("reads as waiting for a solver, and an unfilled order as nothing swapped", () => {
    expect(statusView(order(), "Base").label).toBe("Waiting for a solver");
    expect(statusView(order({status: "expired"}), "Base").detail).toMatch(/never left your wallet/);
    expect(statusView(order({status: "submitting", stage: "signing"}), "Base").label).toBe("Signing the order");
    expect(statusView(order({status: "submitting", stage: "permit"}), "Base").label).toBe("Signing the USDC permit");
    expect(swapSteps(order({status: "submitting", stage: "permit", approvals: 0}), "Base").map((s) => [s.label, s.state])).toEqual([
      ["Sign the USDC permit, then the order", "active"],
      ["A solver fills USDC → WETH", "todo"],
    ]);
  });

  it("keeps its order flag across a reload (it was dropped before D49)", () => {
    const [back] = parseStored(JSON.stringify([order({cancelRequestedAt: 5, cancelHash: "0xabc"})]));
    expect(back).toMatchObject({order: true, cancelRequestedAt: 5, cancelHash: "0xabc"});
  });

  it("a cancellation on its way reads as Cancelling (D49) — it may still fill first", () => {
    expect(statusView(order({cancelRequestedAt: 1}), "Base")).toMatchObject({label: "Cancelling", detail: expect.stringMatching(/may still fill/)});
    const flow = order({order: undefined, fromSymbol: "ETH", cancelHash: "0xabc"});
    expect(statusView(flow, "Base")).toMatchObject({label: "Cancelling", detail: expect.stringMatching(/returns your ETH/)});
  });

  it("an eth-flow order that didn't fill is a refund to send, not a claim (D49)", () => {
    const flow = order({order: undefined, fromSymbol: "ETH", status: "action-required"});
    expect(statusView(flow, "Base")).toMatchObject({label: "Not filled", tone: "action", detail: expect.stringMatching(/refund service/)});
    expect(swapSteps(flow, "Base").at(-1)?.label).toBe("Get your ETH back");
  });

  it("after the refund was sent: Refund sent, then a refunded order reads as unfilled or cancelled", () => {
    const flow = order({order: undefined, fromSymbol: "ETH"});
    expect(statusView({...flow, claimHash: "0xabc"}, "Base").label).toBe("Refund sent");
    expect(statusView({...flow, status: "refunded"}, "Base").detail).toMatch(/No solver filled the order/);
    expect(statusView({...flow, status: "refunded", cancelHash: "0xabc"}, "Base").detail).toMatch(/You cancelled the order/);
  });
});
