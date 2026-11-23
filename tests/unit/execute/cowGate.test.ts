// The in-page gate's CoW rule (D48): a token sale arms its EIP-2612 permit (when the plan has one) and its GPv2 order —
// each held by the SDK's own reader to the review — and the order's appData may change only after that permit; a
// native sale is one eth-flow createOrder; no other venue signs a GPv2 order or a permit.
import {describe, expect, it} from "vitest";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {GPV2_VAULT_RELAYER} from "@anywalletkit/protocol-swap2-core";
import {COW_ETH_FLOW, encodeCreateOrder, permitTypedData} from "@anywalletkit/protocol-swap2-cow";
import {orderTypedData, type CowOrder} from "@anywalletkit/protocol-swap2-cow/order";
import type {ReviewedSwap} from "../../../src/contracts/execution";
import {approveData, checkPlan, checkPlanBrowser, createSwapGate, GPV2_ALLOWANCE_CEILING, GPV2_MAX_LIFETIME_S, planWrites, stableJson, type WriteIntent} from "../../../src/execute/gate";
import {VENUE_RULES, pinnedVenueOf} from "../../../src/execute/pins";

const ME = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const EVIL = "0x000000000000000000000000000000000000dEaD";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC
const WETH = "0x4200000000000000000000000000000000000006";
const BASE = "eip155:8453";
const NOW_S = Math.floor(Date.now() / 1000);
const VALID_TO = NOW_S + 1200;
const APP_DATA = `0x${"ab".repeat(32)}`;
const PERMIT_APP_DATA = `0x${"cd".repeat(32)}`;
const cow = VENUE_RULES.cow!;

const reviewed: ReviewedSwap = {
  provider: "cow",
  fromChain: BASE,
  fromContract: USDC,
  amountIn: 5_000_000n,
  destChain: BASE,
  destToken: WETH,
  recipient: ME,
  refundAddress: ME,
  minOut: 2_800_000_000_000_000n,
  slippageBps: 30,
  approvalSpender: GPV2_VAULT_RELAYER,
  nativeFee: 0n,
};

const order = (over: Partial<CowOrder> = {}): CowOrder => ({
  sellToken: USDC,
  buyToken: WETH,
  receiver: ME,
  sellAmount: "5000000",
  buyAmount: "2810000000000000",
  validTo: VALID_TO,
  appData: APP_DATA,
  feeAmount: "0",
  kind: "sell",
  partiallyFillable: false,
  sellTokenBalance: "erc20",
  buyTokenBalance: "erc20",
  ...over,
});

const typed = (over: Partial<CowOrder> = {}, chainId = 8453) => JSON.stringify(orderTypedData(chainId, order(over)));

const plan = (over: Partial<Swap2ExecutionPlan> = {}): Swap2ExecutionPlan => ({
  provider: "cow",
  fromChain: BASE,
  destChain: BASE,
  destToken: WETH,
  recipient: ME,
  refundAddress: ME,
  sourceAmount: 5_000_000n,
  destAmount: 2_820_000_000_000_000n,
  minDestAmount: 2_810_000_000_000_000n,
  feeUsd: 0,
  etaSeconds: 30,
  validUntilMs: Date.now() + 120_000,
  approvals: [{token: USDC, spender: GPV2_VAULT_RELAYER, amount: 5_000_000n}],
  source: {kind: "typed-order", typedData: typed()},
  ...over,
});

/** What the engine hands the wallet: the payload without EIP712Domain (swap2-core executeSwap2). */
const asSigned = (json: string) => {
  const td = JSON.parse(json) as {domain: unknown; types: Record<string, unknown>; primaryType: string; message: unknown};
  const {EIP712Domain: _drop, ...types} = td.types;
  return {domain: td.domain, types, primaryType: td.primaryType, message: td.message};
};

const permitRaw = (over: {value?: string; deadline?: number; owner?: string; spender?: string} = {}) => {
  const p = permitTypedData({
    chainId: 8453,
    token: USDC,
    domain: {name: "USD Coin", version: "2"},
    owner: over.owner ?? ME,
    value: over.value ?? "5000000",
    nonce: "0",
    deadline: over.deadline ?? VALID_TO,
  });
  const {EIP712Domain: _drop, ...types} = p.types as Record<string, unknown>;
  return {domain: p.domain, types, primaryType: "Permit", message: over.spender ? {...p.message, spender: over.spender} : p.message};
};

const sign = (raw: unknown): WriteIntent => ({chain: BASE, method: "signTypedData", raw});

describe("checkPlanBrowser — CoW (gpv2)", () => {
  it("accepts the reviewed order, with its approval or with one permit instead", () => {
    expect(checkPlanBrowser(plan(), reviewed, cow)).toBeNull();
    expect(checkPlanBrowser(plan({approvals: [], permits: [{token: USDC, spender: GPV2_VAULT_RELAYER, amount: 5_000_000n, deadline: VALID_TO}]}), reviewed, cow)).toBeNull();
    // An allowance that also covers the account's other open orders of the token (never less than the input).
    expect(checkPlanBrowser(plan({approvals: [{token: USDC, spender: GPV2_VAULT_RELAYER, amount: 9_000_000n}]}), reviewed, cow)).toBeNull();
  });

  it("refuses an order that isn't the reviewed swap", () => {
    expect(checkPlanBrowser(plan({source: {kind: "typed-order", typedData: typed({receiver: EVIL})}}), reviewed, cow)).toMatch(/not the reviewed swap/);
    expect(checkPlanBrowser(plan({source: {kind: "typed-order", typedData: typed({sellAmount: "5000001"})}}), reviewed, cow)).toMatch(/not the reviewed swap/);
    expect(checkPlanBrowser(plan({source: {kind: "typed-order", typedData: typed({buyAmount: "1"})}}), reviewed, cow)).toMatch(/not the reviewed swap/);
    expect(checkPlanBrowser(plan({source: {kind: "typed-order", typedData: typed({buyToken: USDC})}}), reviewed, cow)).toMatch(/not the reviewed swap/);
    expect(checkPlanBrowser(plan({source: {kind: "typed-order", typedData: typed({}, 1)}}), reviewed, cow)).toMatch(/not the reviewed swap/);
    expect(checkPlanBrowser(plan({source: {kind: "typed-order", typedData: typed({validTo: NOW_S + GPV2_MAX_LIFETIME_S + 60})}}), reviewed, cow)).toMatch(/too long/);
  });

  it("refuses an allowance or permit beyond the vault relayer and the order", () => {
    expect(checkPlanBrowser(plan({approvals: [{token: USDC, spender: EVIL, amount: 5_000_000n}]}), {...reviewed, approvalSpender: EVIL}, cow)).toMatch(/doesn't trust/);
    expect(checkPlanBrowser(plan({approvals: [{token: USDC, spender: GPV2_VAULT_RELAYER, amount: 4_000_000n}]}), reviewed, cow)).toMatch(/another amount/);
    const p = {token: USDC, spender: GPV2_VAULT_RELAYER, amount: 5_000_000n, deadline: VALID_TO};
    expect(checkPlanBrowser(plan({approvals: [], permits: [{...p, spender: EVIL}]}), reviewed, cow)).toMatch(/spender/);
    expect(checkPlanBrowser(plan({approvals: [], permits: [{...p, amount: 1n}]}), reviewed, cow)).toMatch(/less than/);
    expect(checkPlanBrowser(plan({approvals: [], permits: [{...p, deadline: VALID_TO + 1}]}), reviewed, cow)).toMatch(/outlives/);
    expect(checkPlanBrowser(plan({approvals: [], permits: [p, p]}), reviewed, cow)).toMatch(/more than one/);
    expect(checkPlanBrowser(plan({permits: [p]}), reviewed, cow)).toMatch(/both/);
    // Never an "unlimited" allowance, by approval or permit.
    expect(checkPlanBrowser(plan({approvals: [{token: USDC, spender: GPV2_VAULT_RELAYER, amount: GPV2_ALLOWANCE_CEILING}]}), reviewed, cow)).toMatch(/another amount/);
    expect(checkPlanBrowser(plan({approvals: [], permits: [{...p, amount: GPV2_ALLOWANCE_CEILING}]}), reviewed, cow)).toMatch(/without a limit/);
  });

  it("a CoW order never crosses networks", () => {
    expect(checkPlanBrowser(plan({destChain: "eip155:1"}), {...reviewed, destChain: "eip155:1"}, cow)).toMatch(/another network/);
  });

  it("no other venue signs a GPv2 order or a permit", () => {
    const lifi = {...reviewed, provider: "lifi"};
    expect(checkPlanBrowser(plan({provider: "lifi"}), lifi, VENUE_RULES.lifi)).toMatch(/isn't CoW/);
    expect(checkPlanBrowser(plan({provider: "omniston"}), {...reviewed, provider: "omniston"}, VENUE_RULES.omniston)).toMatch(/isn't CoW/);
    const permits = [{token: USDC, spender: GPV2_VAULT_RELAYER, amount: 5_000_000n, deadline: VALID_TO}];
    expect(checkPlanBrowser({...plan({provider: "lifi", permits}), source: {kind: "call", to: EVIL, data: "0x12345678", value: 0n}}, lifi, VENUE_RULES.lifi)).toMatch(/permit/);
    // checkPlan's larger allowance is for a GPv2 order only.
    expect(checkPlan({...plan({approvals: [{token: USDC, spender: GPV2_VAULT_RELAYER, amount: 9_000_000n}]}), source: {kind: "call", to: EVIL, data: "0x1234", value: 0n}}, reviewed)).toMatch(/another amount/);
  });

  it("a native sale is exactly one eth-flow createOrder for the reviewed swap", () => {
    const native: ReviewedSwap = {...reviewed, fromContract: null, destToken: USDC, amountIn: 2_000_000_000_000_000n, minOut: 3_500_000n, approvalSpender: null};
    const data = (over: Partial<{buyToken: string; receiver: string; sellAmount: string; buyAmount: string; validTo: number}> = {}) =>
      encodeCreateOrder({buyToken: USDC, receiver: ME, sellAmount: "2000000000000000", buyAmount: "3510000", appData: APP_DATA, validTo: VALID_TO, quoteId: 1, ...over});
    const call = (d: string, to = COW_ETH_FLOW, value = 2_000_000_000_000_000n) =>
      plan({destToken: USDC, sourceAmount: 2_000_000_000_000_000n, minDestAmount: 3_510_000n, approvals: [], source: {kind: "call", to, data: d, value}});
    expect(checkPlanBrowser(call(data()), native, cow)).toBeNull();
    expect(checkPlanBrowser(call(data(), EVIL), native, cow)).toMatch(/doesn't trust/);
    expect(checkPlanBrowser(call(data({receiver: EVIL})), native, cow)).toMatch(/someone else/);
    expect(checkPlanBrowser(call(data({buyAmount: "1"})), native, cow)).toMatch(/below the minimum/);
    expect(checkPlanBrowser(call(data({buyToken: WETH})), native, cow)).toMatch(/another token/);
    expect(checkPlanBrowser(call(data({sellAmount: "1"})), native, cow)).toMatch(/exactly the reviewed amount/);
    expect(checkPlanBrowser(call(data({validTo: NOW_S + GPV2_MAX_LIFETIME_S + 60})), native, cow)).toMatch(/too long/);
    expect(checkPlanBrowser(call("0x12345678"), native, cow)).toMatch(/doesn't place/);
  });

  it("only on the networks its package serves", () => {
    expect(checkPlanBrowser(plan({fromChain: "eip155:10"}), {...reviewed, fromChain: "eip155:10"}, cow)).toMatch(/network/);
    expect(pinnedVenueOf(BASE, GPV2_VAULT_RELAYER)).toBe("cow");
    expect(pinnedVenueOf("eip155:10", GPV2_VAULT_RELAYER)).toBeNull();
  });
});

describe("the armed CoW writes", () => {
  const consume = (g: ReturnType<typeof createSwapGate>, i: WriteIntent) => g.consume(i);

  it("approval then the order, exactly as the plan's", () => {
    const g = createSwapGate(BASE);
    const p = plan();
    g.arm(planWrites(p, undefined, reviewed).writes);
    expect(consume(g, {chain: BASE, method: "sendTransaction", raw: {to: USDC, data: approveData(GPV2_VAULT_RELAYER, 5_000_000n), value: 0n}})).toBe(true);
    expect(consume(g, sign(asSigned(typed())))).toBe(true);
    expect(g.remaining()).toBe(0);
  });

  it("the cleanup may put the allowance back below what this run granted, never above it", () => {
    const armed = planWrites(plan({approvals: [{token: USDC, spender: GPV2_VAULT_RELAYER, amount: 9_000_000n}]}), undefined, reviewed);
    const approve = (n: bigint): WriteIntent => ({chain: BASE, method: "sendTransaction", raw: {to: USDC, data: approveData(GPV2_VAULT_RELAYER, n), value: 0n}});
    const g = createSwapGate(BASE);
    g.arm(armed.writes, armed.revokes);
    // Before a grant went to the wallet nothing can be "restored": a stray approve disarms.
    expect(g.consume(approve(4_000_000n))).toBe(false);
    g.arm(armed.writes, armed.revokes);
    expect(g.consume(approve(9_000_000n))).toBe(true);
    g.recordGrant(USDC, GPV2_VAULT_RELAYER, 9_000_000n);
    expect(g.consume(approve(4_000_000n))).toBe(true); // back to the 4 USDC it had
    expect(g.consume(approve(0n))).toBe(true);
    expect(g.consume(approve(9_000_000n))).toBe(false); // never as high again, nor higher
    expect(g.consume(approve(10_000_000n))).toBe(false);
  });

  it("another venue's cleanup is still approve(0) only", () => {
    const g = createSwapGate(BASE);
    g.arm([{kind: "call", to: USDC, data: approveData(EVIL, 5_000_000n), value: 0n}], [{token: USDC, spender: EVIL}]);
    expect(g.consume({chain: BASE, method: "sendTransaction", raw: {to: USDC, data: approveData(EVIL, 5_000_000n), value: 0n}})).toBe(true);
    g.recordGrant(USDC, EVIL, 5_000_000n);
    expect(g.consume({chain: BASE, method: "sendTransaction", raw: {to: USDC, data: approveData(EVIL, 1n), value: 0n}})).toBe(false);
  });

  it("an order with another appData without a permit, or another field, disarms", () => {
    const g = createSwapGate(BASE);
    g.arm(planWrites(plan({approvals: []}), undefined, reviewed).writes);
    expect(consume(g, sign(asSigned(typed({appData: PERMIT_APP_DATA}))))).toBe(false);
    const h = createSwapGate(BASE);
    h.arm(planWrites(plan({approvals: []}), undefined, reviewed).writes);
    expect(consume(h, sign(asSigned(typed({buyAmount: "2810000000000001"}))))).toBe(false);
  });

  it("the permit, then the order carrying it (another appData), and names each signature", () => {
    const seen: string[] = [];
    const g = createSwapGate(BASE, (k) => seen.push(k));
    const p = plan({approvals: [], permits: [{token: USDC, spender: GPV2_VAULT_RELAYER, amount: 5_000_000n, deadline: VALID_TO}]});
    g.arm(planWrites(p, undefined, reviewed).writes);
    expect(consume(g, sign(permitRaw()))).toBe(true);
    expect(consume(g, sign(asSigned(typed({appData: PERMIT_APP_DATA}))))).toBe(true);
    expect(seen).toEqual(["gpv2Permit", "gpv2Order"]);
  });

  it("a permit for more, for another spender or owner, or past the order, disarms", () => {
    for (const bad of [permitRaw({value: "5000001"}), permitRaw({spender: EVIL}), permitRaw({owner: EVIL}), permitRaw({deadline: VALID_TO + 1})]) {
      const g = createSwapGate(BASE);
      g.arm(planWrites(plan({approvals: [], permits: [{token: USDC, spender: GPV2_VAULT_RELAYER, amount: 5_000_000n, deadline: VALID_TO}]}), undefined, reviewed).writes);
      expect(consume(g, sign(bad))).toBe(false);
      expect(g.remaining()).toBe(0);
    }
  });

  it("a plan's order arms only with the review's token and owner", () => {
    expect(() => planWrites(plan(), undefined, undefined)).toThrow(/can't hold it/);
    expect(stableJson(planWrites(plan(), undefined, reviewed).writes.map((w) => w.kind))).toBe(stableJson(["call", "gpv2Order"]));
  });
});
