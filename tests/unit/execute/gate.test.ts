// Port of mobile lib/swap/gate.test.ts (756b115) onto the per-execution gate, plus the browser's additions:
// checkPlanBrowser (family / kind / chain id / venue pins) and "revoke only what this run granted".
import {describe, expect, it} from "vitest";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {CURVE_DEPLOYMENTS} from "@anywalletkit/protocol-swap2-curve";
import {FYND_CHAINS} from "@anywalletkit/protocol-swap2-fynd/router";
import {stargateRegistry} from "@anywalletkit/protocol-swap2-stargate/deployments";
import type {ReviewedSwap} from "../../../src/contracts/execution";
import {
  approveData,
  ARM_TTL_MS,
  checkPlan,
  checkPlanBrowser,
  createSwapGate,
  executionConstraints,
  planWrites,
  readApprove,
  stableJson,
  swapFeeCap,
  TON_BODY_GAS,
  type WriteIntent,
  type WriteMethod,
} from "../../../src/execute/gate";
import {venueRule, VENUE_RULES} from "../../../src/execute/pins";
import {encodeFunctionData, erc20Abi} from "viem";
import E from "./omnistonEscrow.fixture.json";

const ME = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const SPENDER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"; // CCTP TokenMessengerV2 (pinned)
const ROUTER = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"; // LI.FI Diamond (pinned for lifi)
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const EVIL = "0x000000000000000000000000000000000000dEaD";

const reviewed: ReviewedSwap = {
  provider: "cctp",
  fromChain: "eip155:1",
  fromContract: USDC,
  amountIn: 100_000_000n,
  destChain: "eip155:8453",
  destToken: BASE_USDC,
  recipient: ME,
  refundAddress: ME,
  minOut: 99_489_055n,
  slippageBps: 50,
  approvalSpender: SPENDER,
  nativeFee: 0n,
};

const plan = (over: Partial<Swap2ExecutionPlan> = {}): Swap2ExecutionPlan => ({
  provider: "cctp",
  fromChain: "eip155:1",
  destChain: "eip155:8453",
  destToken: BASE_USDC,
  recipient: ME,
  refundAddress: ME,
  sourceAmount: 100_000_000n,
  destAmount: 99_989_000n,
  minDestAmount: 99_989_000n,
  feeUsd: 0.01,
  etaSeconds: 180,
  validUntilMs: 0,
  approvals: [{token: USDC, spender: SPENDER, amount: 100_000_000n, chainId: 1}],
  source: {kind: "call", to: SPENDER, data: "0xdeadbeef", value: 0n, chainId: 1},
  ...over,
});

const send = (raw: unknown, chain = "eip155:1"): WriteIntent => ({chain, method: "sendTransaction", raw});
const intent = (method: WriteMethod, raw: unknown, chain = "eip155:1"): WriteIntent => ({chain, method, raw});

describe("checkPlan (mobile, verbatim)", () => {
  it("accepts the reviewed route", () => {
    expect(checkPlan(plan(), reviewed)).toBeNull();
  });
  it("accepts a plan with no approval (allowance already in place) and a better minimum", () => {
    expect(checkPlan(plan({approvals: [], minDestAmount: 99_999_000n}), reviewed)).toBeNull();
  });
  it("refuses another venue, network, token, recipient, refund address or amount", () => {
    expect(checkPlan(plan({provider: "lifi"}), reviewed)).toMatch(/route moved/);
    expect(checkPlan(plan({destChain: "eip155:42161"}), reviewed)).toMatch(/networks/);
    expect(checkPlan(plan({fromChain: "eip155:8453"}), reviewed)).toMatch(/networks/);
    expect(checkPlan(plan({destToken: ME}), reviewed)).toMatch(/token/);
    expect(checkPlan(plan({recipient: "0x0000000000000000000000000000000000000001"}), reviewed)).toMatch(/recipient/);
    expect(checkPlan(plan({refundAddress: "0x0000000000000000000000000000000000000001"}), reviewed)).toMatch(/refund/);
    expect(checkPlan(plan({sourceAmount: 100_000_001n}), reviewed)).toMatch(/amount/);
    expect(checkPlan(plan({sourceAmount: 99_999_999n}), reviewed)).toMatch(/amount/);
  });
  it("refuses a minimum below the reviewed one — also on a requoted plan", () => {
    expect(checkPlan(plan({minDestAmount: 99_489_054n}), reviewed)).toMatch(/guaranteed output/);
    expect(checkPlan(plan({requoted: true, approvals: [], minDestAmount: 99_489_054n}), reviewed)).toMatch(/guaranteed output/);
    expect(checkPlan(plan({requoted: true, approvals: [], minDestAmount: 99_489_055n}), reviewed)).toBeNull();
  });
  it("refuses approvals the review didn't show", () => {
    expect(checkPlan(plan({approvals: [{token: USDC, spender: ROUTER, amount: 100_000_000n}]}), reviewed)).toMatch(/spender/);
    expect(checkPlan(plan({approvals: [{token: USDC, spender: SPENDER, amount: 2n ** 256n - 1n}]}), reviewed)).toMatch(/amount/);
    expect(checkPlan(plan({approvals: [{token: ROUTER, spender: SPENDER, amount: 100_000_000n}]}), reviewed)).toMatch(/token/);
    expect(checkPlan(plan(), {...reviewed, approvalSpender: null})).toMatch(/spender/);
  });
  it("lets USDT's reset-to-zero approval through", () => {
    expect(
      checkPlan(
        plan({
          approvals: [
            {token: USDC, spender: SPENDER, amount: 0n},
            {token: USDC, spender: SPENDER, amount: 100_000_000n},
          ],
        }),
        reviewed,
      ),
    ).toBeNull();
  });
  it("caps the value a call attaches", () => {
    expect(checkPlan(plan({source: {kind: "call", to: SPENDER, value: 1n}}), reviewed)).toMatch(/sends more/);
    const native = {...reviewed, fromContract: null, approvalSpender: null, nativeFee: 10n};
    expect(checkPlan(plan({approvals: [], source: {kind: "call", to: ROUTER, value: 100_000_020n}}), native)).toBeNull();
    expect(checkPlan(plan({approvals: [], source: {kind: "call", to: ROUTER, value: 100_000_021n}}), native)).toMatch(/sends more/);
  });
  describe("a TON cell body carries its own gas (Omniston quotes no fee)", () => {
    const TON_USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
    const ton = {...reviewed, provider: "omniston", fromChain: "ton:-239", approvalSpender: null, recipient: E.destAddress, refundAddress: E.owner, destToken: E.destToken};
    const body = (value: bigint, to = E.jettonWallet) =>
      plan({provider: "omniston", fromChain: "ton:-239", recipient: E.destAddress, refundAddress: E.owner, destToken: E.destToken, approvals: [], source: {kind: "call", to, value, cellBody: true}});
    it("jetton source: gas only, up to the allowance", () => {
      const jetton = {...ton, fromContract: TON_USDT, amountIn: BigInt(E.inputUnits), minOut: 4_954_997n};
      const p = (value: bigint) => ({...body(value), sourceAmount: BigInt(E.inputUnits), minDestAmount: BigInt(E.resolverSendsUnits)});
      expect(checkPlan(p(BigInt(E.sendAmount)), jetton)).toBeNull();
      expect(checkPlan(p(TON_BODY_GAS), jetton)).toBeNull();
      expect(checkPlan(p(TON_BODY_GAS + 1n), jetton)).toMatch(/sends more/);
    });
    it("native source: the input plus the allowance, no more", () => {
      const native = {...ton, fromContract: null, amountIn: 1_000_000_000n, minOut: 1n};
      const p = (value: bigint) => ({...body(value, "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt"), sourceAmount: 1_000_000_000n, minDestAmount: 1n});
      expect(checkPlan(p(1_300_000_000n), native)).toBeNull();
      expect(checkPlan(p(1_000_000_000n + TON_BODY_GAS), native)).toBeNull();
      expect(checkPlan(p(1_000_000_000n + TON_BODY_GAS + 1n), native)).toMatch(/sends more/);
    });
  });
  it("a token deposit must be the reviewed token and amount", () => {
    const sol = {...reviewed, fromChain: "solana:mainnet", fromContract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", approvalSpender: null};
    const p = plan({
      fromChain: "solana:mainnet",
      approvals: [],
      source: {kind: "token-transfer", token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", recipient: "dep", amount: 100_000_000n},
    });
    expect(checkPlan(p, sol)).toBeNull();
    expect(checkPlan({...p, source: {kind: "token-transfer", token: "other", recipient: "dep", amount: 100_000_000n}}, sol)).toMatch(/deposit/);
    expect(checkPlan({...p, source: {kind: "token-transfer", token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", recipient: "dep", amount: 100_000_001n}}, sol)).toMatch(/deposit/);
  });
});

describe("checkPlanBrowser: the browser's checks on top", () => {
  const cctp = venueRule("cctp");
  it("accepts the reviewed CCTP route with the package's pins", () => {
    expect(checkPlanBrowser(plan(), reviewed, cctp)).toBeNull();
  });
  it("a payload must suit the chain family", () => {
    expect(checkPlanBrowser(plan({approvals: [], source: {kind: "serialized", serializedTx: "AQID"}}), reviewed, cctp)).toMatch(/provider-built transaction/);
    const sol = {...reviewed, fromChain: "solana:mainnet", fromContract: null, approvalSpender: null};
    const solPlan = (source: Swap2ExecutionPlan["source"]) => plan({fromChain: "solana:mainnet", approvals: [], source});
    expect(checkPlanBrowser(solPlan({kind: "typed-order", typedData: "{}"}), sol)).toMatch(/order signature/);
    expect(checkPlanBrowser(solPlan({kind: "call", to: "Dep", data: "0x01", value: 1n}), sol)).toMatch(/calldata/);
    expect(checkPlanBrowser(solPlan({kind: "call", to: "Dep", value: 1n, memo: "x"}), sol)).toMatch(/payload/);
    expect(checkPlanBrowser(solPlan({kind: "serialized", serializedTx: "AQID"}), sol)).toBeNull();
    expect(checkPlanBrowser(plan({approvals: [], source: {kind: "token-transfer", token: USDC, recipient: EVIL, amount: 100_000_000n}}), reviewed, cctp)).toMatch(/token transfer/);
  });
  it("chain ids must be the source chain's", () => {
    expect(checkPlanBrowser(plan({approvals: [{token: USDC, spender: SPENDER, amount: 100_000_000n, chainId: 8453}]}), reviewed, cctp)).toMatch(/another network/);
    expect(checkPlanBrowser(plan({source: {kind: "call", to: SPENDER, data: "0x01", value: 0n, chainId: 10}}), reviewed, cctp)).toMatch(/another network/);
  });
  it("pinned venue: an approval or a call outside the package's lists is refused", () => {
    const evilReview = {...reviewed, approvalSpender: EVIL};
    expect(checkPlanBrowser(plan({approvals: [{token: USDC, spender: EVIL, amount: 100_000_000n}]}), evilReview, cctp)).toMatch(/doesn't trust/);
    expect(checkPlanBrowser(plan({source: {kind: "call", to: EVIL, data: "0x01", value: 0n}}), reviewed, cctp)).toMatch(/doesn't trust/);
    expect(checkPlanBrowser(plan({approvals: [], source: {kind: "call", to: SPENDER, value: 0n}}), reviewed, cctp)).toMatch(/plain transfer/);
  });
  describe("Stargate: its reviewed pools / OFTs only (stargateRegistry)", () => {
    const sg = venueRule("stargate");
    const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    const ZERO = "0x0000000000000000000000000000000000000000";
    const usdcPool = stargateRegistry.find("eip155:42161", ARB_USDC)!.address;
    const ethPool = stargateRegistry.find("eip155:8453", ZERO)!.address;
    const fee = 849_782_096_747_417n; // the messaging fee cap of a live Arbitrum → Base quote, 2026-11-17
    const usdcReview = {...reviewed, provider: "stargate", fromChain: "eip155:42161", fromContract: ARB_USDC, amountIn: 25_000_000n, minOut: 24_984_924n, approvalSpender: usdcPool, nativeFee: fee};
    const usdcPlan = (over: Partial<Swap2ExecutionPlan> = {}) =>
      plan({provider: "stargate", fromChain: "eip155:42161", sourceAmount: 25_000_000n, destAmount: 24_984_924n, minDestAmount: 24_984_924n, approvals: [{token: ARB_USDC, spender: usdcPool, amount: 25_000_000n, chainId: 42161}], source: {kind: "call", to: usdcPool, data: "0xc7c7f5b3", value: fee, chainId: 42161}, ...over});
    it("accepts sendToken on the pinned Arbitrum USDC pool, approved to that pool for exactly the input", () => {
      expect(stargateRegistry.callTargets("eip155:42161").map((a) => a.toLowerCase())).toContain(usdcPool.toLowerCase());
      expect(checkPlanBrowser(usdcPlan(), usdcReview, sg)).toBeNull();
    });
    it("refuses another call target or spender, and pays no deposit address", () => {
      expect(checkPlanBrowser(usdcPlan({source: {kind: "call", to: EVIL, data: "0xc7c7f5b3", value: fee, chainId: 42161}}), usdcReview, sg)).toMatch(/doesn't trust/);
      expect(checkPlanBrowser(usdcPlan({approvals: [{token: ARB_USDC, spender: EVIL, amount: 25_000_000n, chainId: 42161}]}), {...usdcReview, approvalSpender: EVIL}, sg)).toMatch(/doesn't trust/);
      expect(checkPlanBrowser(usdcPlan({approvals: [], source: {kind: "call", to: usdcPool, value: fee, chainId: 42161}}), usdcReview, sg)).toMatch(/plain transfer/);
    });
    it("a native pool is a call target, never a spender", () => {
      expect(stargateRegistry.callTargets("eip155:8453").map((a) => a.toLowerCase())).toContain(ethPool.toLowerCase());
      expect(stargateRegistry.spenders("eip155:8453").map((a) => a.toLowerCase())).not.toContain(ethPool.toLowerCase());
    });
  });
  it("a venue with no rule gets no calldata or order at all", () => {
    expect(checkPlanBrowser(plan({provider: "mystery"}), {...reviewed, provider: "mystery"}, undefined)).toMatch(/no pins/);
    expect(checkPlanBrowser(plan({provider: "mystery", approvals: [], source: {kind: "typed-order", typedData: "{}"}}), {...reviewed, provider: "mystery"}, undefined)).toMatch(/no pins/);
  });
  it("NEAR Intents (deposit rule): a bare send, or the exact ERC-20 transfer of the input, nothing else", () => {
    const near = {...reviewed, provider: "near_intents", approvalSpender: null};
    const rule = venueRule("near_intents");
    const transfer = (to: string, amount: bigint) => encodeFunctionData({abi: erc20Abi, functionName: "transfer", args: [to as `0x${string}`, amount]});
    const p = (source: Swap2ExecutionPlan["source"], approvals: Swap2ExecutionPlan["approvals"] = []) => plan({provider: "near_intents", approvals, source});
    expect(checkPlanBrowser(p({kind: "call", to: USDC, data: transfer(EVIL, 100_000_000n), value: 0n}), near, rule)).toBeNull();
    expect(checkPlanBrowser(p({kind: "call", to: USDC, data: transfer(EVIL, 100_000_001n), value: 0n}), near, rule)).toMatch(/deposit was expected/);
    expect(checkPlanBrowser(p({kind: "call", to: USDC, data: approveData(EVIL, 100_000_000n), value: 0n}), near, rule)).toMatch(/deposit was expected/);
    expect(checkPlanBrowser(p({kind: "call", to: EVIL, data: "0x01", value: 0n}), near, rule)).toMatch(/deposit was expected/);
    expect(checkPlanBrowser(p({kind: "call", to: USDC, data: transfer(EVIL, 100_000_000n), value: 0n}, [{token: USDC, spender: SPENDER, amount: 100_000_000n}]), {...near, approvalSpender: SPENDER}, rule)).toMatch(/approval this venue never needs/);
    const native = {...near, fromContract: null};
    expect(checkPlanBrowser(p({kind: "call", to: EVIL, value: 100_000_000n}), native, rule)).toBeNull();
  });
});

describe("LOCAL pins agree with the providers swap builds", () => {
  const pins = (p: string) => {
    const r = VENUE_RULES[p];
    if (r?.kind !== "pins") throw new Error(`${p} has no pins`);
    return r.pins;
  };
  it("every default and Standard-only venue has a rule; jupiter (Solana only) needs none", () => {
    for (const p of ["uniswap", "curve", "wrap", "usdt0", "cctp", "thorchain", "chainflip", "near_intents", "lifi", "relay", "fynd", "symbiosis", "balancer", "omniston", "zeroex", "across"])
      expect(VENUE_RULES[p], p).toBeDefined();
    expect(VENUE_RULES.jupiter).toBeUndefined();
  });
  it("Curve: only the pinned Router NG; Fynd: only the Tycho router — as call target and as spender", () => {
    const curveRouter = CURVE_DEPLOYMENTS[1]!.router;
    expect(pins("curve").callTargets("eip155:1")).toEqual([curveRouter]);
    expect(pins("curve").spenders("eip155:1")).toEqual([curveRouter]);
    expect(pins("curve").callTargets("eip155:59144")).toEqual([]);
    expect(pins("fynd").callTargets("eip155:1")).toEqual([FYND_CHAINS[1]!.router]);
    expect(pins("fynd").spenders("eip155:8453")).toEqual([FYND_CHAINS[8453]!.router]);
    expect(pins("fynd").callTargets("eip155:10")).toEqual([]);
  });
  it("LI.FI: the canonical Diamond, the Flare override (providers.md §4) and Elysium", () => {
    expect(pins("lifi").callTargets("eip155:8453").map((x) => x.toLowerCase())).toEqual([ROUTER.toLowerCase()]);
    expect(pins("lifi").callTargets("eip155:14")).toEqual(["0x198FC70Dfe05E755C81e54bd67Bff3F729344B9b"]);
    expect(pins("lifi").spenders("eip155:14")).toEqual(["0x198FC70Dfe05E755C81e54bd67Bff3F729344B9b"]);
    expect(pins("lifi").callTargets("eip155:99901").length).toBe(1);
  });
  it("Chainflip: the vault orderSpender names is the pinned spender", () => {
    expect(pins("chainflip").spenders("eip155:1")).toContain("0xF5e10380213880111522dd0efD3dbb45b9f62Bcc");
    expect(pins("chainflip").spenders("eip155:42161")).toContain("0x79001a5e762f3bEFC8e5871b42F6734e00498920");
  });
  it("THORChain routers and CCTP's TokenMessengerV2", () => {
    expect(pins("thorchain").callTargets("eip155:1")).toContain("0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146");
    expect(pins("cctp").spenders("eip155:1")).toContain(SPENDER);
  });
});

describe("planWrites → the per-execution gate", () => {
  it("passes exactly the approval and the call, once each, in any order", () => {
    const gate = createSwapGate("eip155:1");
    const {writes, revokes} = planWrites(plan());
    gate.arm(writes, revokes);
    const approve = send({to: USDC, data: approveData(SPENDER, 100_000_000n), value: 0n, chainId: 1});
    const call = send({to: SPENDER.toLowerCase(), data: "0xDEADBEEF", value: 0n, chainId: 1, gasLimit: 300_000n});
    expect(gate.consume(call)).toBe(true);
    expect(gate.consume(approve)).toBe(true);
    expect(gate.consume(call)).toBe(false);
    expect(gate.consume(approve)).toBe(false);
  });

  it("refuses nothing-armed, another chain, another calldata, value or target — and disarms the rest", () => {
    const gate = createSwapGate("eip155:1");
    expect(gate.consume(send({to: SPENDER, data: "0xdeadbeef", value: 0n}))).toBe(false);
    const {writes, revokes} = planWrites(plan());
    for (const bad of [
      send({to: SPENDER, data: "0xdeadbeef", value: 0n}, "eip155:8453"),
      send({to: SPENDER, data: "0xdeadbeee", value: 0n}),
      send({to: SPENDER, data: "0xdeadbeef", value: 1n}),
      send({to: ROUTER, data: "0xdeadbeef", value: 0n}),
      send({to: SPENDER, value: 0n}),
      send({to: SPENDER, data: "0xdeadbeef", value: 0n, memo: "x"}),
      intent("transfer", {to: SPENDER, data: "0xdeadbeef", value: 0n}),
      intent("signTypedData", {to: SPENDER, data: "0xdeadbeef", value: 0n}),
    ]) {
      gate.arm(writes, revokes);
      expect(gate.consume(bad)).toBe(false);
      // A chain mismatch is refused without touching the armed set; anything else disarms it.
      if (bad.chain === "eip155:1") expect(gate.consume(send({to: SPENDER, data: "0xdeadbeef", value: 0n}))).toBe(false);
    }
  });

  it("an approval for another amount or spender is refused", () => {
    const gate = createSwapGate("eip155:1");
    gate.arm(planWrites(plan()).writes);
    expect(gate.consume(send({to: USDC, data: approveData(SPENDER, 2n ** 256n - 1n), value: 0n}))).toBe(false);
    gate.arm(planWrites(plan()).writes);
    expect(gate.consume(send({to: USDC, data: approveData(EVIL, 100_000_000n), value: 0n}))).toBe(false);
  });

  it("a revoke passes only for an allowance this run granted — even after a refusal; never another one", () => {
    const gate = createSwapGate("eip155:1");
    const {writes, revokes} = planWrites(plan());
    gate.arm(writes, revokes);
    const revoke = (token: string, spender: string, value = 0n) => send({to: token, data: approveData(spender, 0n), value, chainId: 1});
    // Nothing granted yet (the user rejected the approval): no pointless revoke prompt.
    expect(gate.consume(revoke(USDC, SPENDER))).toBe(false);
    gate.arm(writes, revokes);
    expect(gate.consume(send({to: USDC, data: approveData(SPENDER, 100_000_000n), value: 0n}))).toBe(true);
    gate.recordGrant(USDC, SPENDER);
    expect(gate.consume(send({to: ROUTER, data: "0x01", value: 0n}))).toBe(false); // a stray write disarms the call…
    expect(gate.consume(send({to: SPENDER, data: "0xdeadbeef", value: 0n}))).toBe(false);
    expect(gate.consume(revoke(USDC.toLowerCase(), SPENDER))).toBe(true); // …but the revoke stays possible
    expect(gate.consume(revoke(USDC, ROUTER))).toBe(false);
    expect(gate.consume(revoke(BASE_USDC, SPENDER))).toBe(false);
    expect(gate.consume(revoke(USDC, SPENDER, 1n))).toBe(false);
    expect(gate.consume({...revoke(USDC, SPENDER), chain: "eip155:8453"})).toBe(false);
    gate.disarm();
    expect(gate.consume(revoke(USDC, SPENDER))).toBe(false);
  });

  it("expires 15 minutes after each (re)arm; revokes don't", () => {
    const gate = createSwapGate("eip155:1");
    const {writes, revokes} = planWrites(plan());
    gate.arm(writes, revokes, 0);
    gate.recordGrant(USDC, SPENDER);
    expect(gate.consume(send({to: SPENDER, data: "0xdeadbeef", value: 0n}), ARM_TTL_MS + 1)).toBe(false);
    expect(gate.consume(send({to: USDC, data: approveData(SPENDER, 0n), value: 0n}), ARM_TTL_MS + 1)).toBe(true);
    gate.arm(writes, revokes, ARM_TTL_MS);
    expect(gate.consume(send({to: SPENDER, data: "0xdeadbeef", value: 0n}), ARM_TTL_MS + 60_000)).toBe(true);
  });

  it("two executions never share armed writes", () => {
    const a = createSwapGate("eip155:1");
    const b = createSwapGate("eip155:1");
    a.arm(planWrites(plan()).writes);
    expect(b.consume(send({to: SPENDER, data: "0xdeadbeef", value: 0n}))).toBe(false);
    expect(a.consume(send({to: SPENDER, data: "0xdeadbeef", value: 0n}))).toBe(true);
  });

  it("TON: a cell body must be the decoded BoC, a text comment the memo", () => {
    const ton = plan({fromChain: "ton:-239", approvals: [], source: {kind: "call", to: "EQescrow", value: 5n, cellBody: true}});
    expect(() => planWrites(ton)).toThrow(/body/);
    const gate = createSwapGate("ton:-239");
    gate.arm(planWrites(ton, "te6cc…").writes);
    expect(gate.consume(intent("sendTransaction", {to: "EQescrow", value: 5n, body: "te6cc…"}, "ton:-239"))).toBe(false);
    gate.arm(planWrites(ton, "te6cc…").writes);
    expect(gate.consume(intent("sendTransaction", {to: "EQescrow", value: 5n, bodyBoc: "te6cc…"}, "ton:-239"))).toBe(true);
    const memo = plan({fromChain: "ton:-239", approvals: [], source: {kind: "call", to: "UQdeposit", value: 5n, memo: "abc"}});
    gate.arm(planWrites(memo).writes);
    expect(gate.consume(intent("sendTransaction", {to: "UQdeposit", value: 5n, body: "abc"}, "ton:-239"))).toBe(true);
  });

  it("token transfers, serialized Solana, typed orders", () => {
    const sol = createSwapGate("solana:mainnet");
    const spl = plan({fromChain: "solana:mainnet", approvals: [], source: {kind: "token-transfer", token: "Mint", recipient: "Dep", amount: 9n}});
    sol.arm(planWrites(spl).writes);
    expect(sol.consume(intent("transfer", {token: "Mint", recipient: "Dep", amount: 10n}, "solana:mainnet"))).toBe(false);
    sol.arm(planWrites(spl).writes);
    expect(sol.consume(intent("transfer", {token: "Mint", recipient: "Dep", amount: 9n}, "solana:mainnet"))).toBe(true);

    const ser = plan({fromChain: "solana:mainnet", approvals: [], source: {kind: "serialized", serializedTx: "AQID"}});
    sol.arm(planWrites(ser).writes);
    expect(sol.consume(intent("sendSerialized", "AQIE", "solana:mainnet"))).toBe(false);
    sol.arm(planWrites(ser).writes);
    expect(sol.consume(intent("sendSerialized", "AQID", "solana:mainnet"))).toBe(true);
    expect(sol.consume(intent("sendSerialized", "AQID", "solana:mainnet"))).toBe(false);

    const evm = createSwapGate("eip155:1");
    const typed = plan({approvals: [], source: {kind: "typed-order", typedData: JSON.stringify({domain: {}, types: {}, message: {amount: "5", to: ME}})}});
    evm.arm(planWrites(typed).writes);
    expect(evm.consume(intent("signTypedData", {domain: {}, types: {}, message: {to: ME, amount: "5"}}))).toBe(true);
    evm.arm(planWrites(typed).writes);
    expect(evm.consume(intent("signTypedData", {message: {to: ME, amount: "6"}}))).toBe(false);
  });
});

describe("helpers", () => {
  it("readApprove decodes approve calldata only", () => {
    expect(readApprove(approveData(SPENDER, 5n))).toEqual({spender: SPENDER, amount: 5n});
    expect(readApprove("0xdeadbeef")).toBeNull();
    expect(readApprove(undefined)).toBeNull();
  });
  it("executionConstraints carries the reviewed floor and slippage", () => {
    expect(executionConstraints(reviewed)).toEqual({minAmountOut: 99_489_055n, slippage: 0.005});
  });
  it("stableJson ignores key order, keeps bigints", () => {
    expect(stableJson({b: 1n, a: [1, {d: 2, c: undefined}]})).toBe(stableJson({a: [1, {d: 2}], b: 1n}));
    expect(stableJson({a: 1})).not.toBe(stableJson({a: 2}));
  });
});

describe("swapFeeCap", () => {
  it("non-EVM: Send's family ceilings", () => {
    expect(swapFeeCap("solana", {nativeSymbol: "SOL", decimals: 9})).toBe(50_000_000n);
    expect(swapFeeCap("ton", {nativeSymbol: "TON", decimals: 9})).toBe(500_000_000n);
  });
  it("EVM: a USD budget at the native price", () => {
    expect(swapFeeCap("evm", {chainId: 8453, nativeSymbol: "ETH", decimals: 18, nativePriceUsd: 2000})).toBe(10n ** 16n);
    expect(swapFeeCap("evm", {chainId: 1, nativeSymbol: "ETH", decimals: 18, nativePriceUsd: 2000})).toBe(4n * 10n ** 16n);
  });
  it("EVM unpriced: ETH fallbacks; other natives uncapped", () => {
    expect(swapFeeCap("evm", {chainId: 1, nativeSymbol: "ETH", decimals: 18})).toBe(3n * 10n ** 16n);
    expect(swapFeeCap("evm", {chainId: 42161, nativeSymbol: "ETH", decimals: 18})).toBe(5n * 10n ** 15n);
    expect(swapFeeCap("evm", {chainId: 56, nativeSymbol: "BNB", decimals: 18})).toBeUndefined();
  });
});
