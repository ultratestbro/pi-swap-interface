// The in-page gate's Permit2 rule (D38): a 0x token sale arms exactly its own rebuilt PermitTransferFrom and the swap
// call carrying exactly the signature the wallet returned for it — nothing broader, and nothing for another venue.
import {describe, expect, it} from "vitest";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {PERMIT2_ADDRESS, PERMIT2_TRANSFER_TYPES, appendPermit2Signature} from "@anywalletkit/protocol-swap2-core/util";
import {ZEROEX_MAX_PERMIT_SECONDS} from "@anywalletkit/protocol-swap2-0x/settler";
import {ACROSS_CHAINS} from "@anywalletkit/protocol-swap2-across/config";
import type {ReviewedSwap} from "../../../src/contracts/execution";
import {gateAccount} from "../../../src/execute/accounts/gated";
import {
  approveData,
  checkPlanBrowser,
  createSwapGate,
  matches,
  permit2Problem,
  planWrites,
  stableJson,
  SwapGateRefusal,
  type VenueRule,
  type WriteIntent,
} from "../../../src/execute/gate";
import {VENUE_RULES} from "../../../src/execute/pins";

const ME = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC
const WETH = "0x4200000000000000000000000000000000000006";
const SETTLER = "0x103502909141F7025a94b7b99A276dCD128e21a8"; // Base taker Settler in force on 2026-11-15
const OLD_SETTLER = "0x7d6839415693801E94cDC4A7d732C9a3FDBbd1D7";
const EVIL = "0x000000000000000000000000000000000000dEaD";
const DATA = `0x1fff991f${"00".repeat(196)}`;
const SIG = `0x${"11".repeat(65)}`;
const OTHER_SIG = `0x${"22".repeat(65)}`;
/** checkPlanBrowser reads the clock itself: the permits here are dated from it. */
const NOW = Date.now();
const NOW_S = Math.floor(NOW / 1000);

const reviewed: ReviewedSwap = {
  provider: "zeroex",
  fromChain: "eip155:8453",
  fromContract: USDC,
  amountIn: 25_000_000n,
  destChain: "eip155:8453",
  destToken: WETH,
  recipient: ME,
  refundAddress: ME,
  minOut: 7_000_000_000_000_000n,
  slippageBps: 50,
  approvalSpender: PERMIT2_ADDRESS,
  nativeFee: 0n,
};

/** The permit as the engine rebuilds it (swap2-core readPermit2Transfer): lowercase addresses, decimal strings. */
const permit = (over: {domain?: Record<string, unknown>; types?: unknown; primaryType?: unknown; message?: Record<string, unknown>; permitted?: Record<string, unknown>; extra?: Record<string, unknown>} = {}) => ({
  domain: {name: "Permit2", chainId: 8453, verifyingContract: PERMIT2_ADDRESS, ...over.domain},
  types: over.types ?? PERMIT2_TRANSFER_TYPES,
  primaryType: over.primaryType ?? "PermitTransferFrom",
  message: {
    permitted: {token: USDC.toLowerCase(), amount: "25000000", ...over.permitted},
    spender: SETTLER.toLowerCase(),
    nonce: "2241959297937691820908574931991586",
    deadline: String(NOW_S + 300),
    ...over.message,
  },
  ...over.extra,
});

const plan = (over: Partial<Swap2ExecutionPlan> = {}, typed: unknown = permit()): Swap2ExecutionPlan => ({
  provider: "zeroex",
  fromChain: "eip155:8453",
  destChain: "eip155:8453",
  destToken: WETH,
  recipient: ME,
  refundAddress: ME,
  sourceAmount: 25_000_000n,
  destAmount: 7_100_000_000_000_000n,
  minDestAmount: 7_050_000_000_000_000n,
  feeUsd: 0,
  etaSeconds: 15,
  validUntilMs: NOW + 45_000,
  approvals: [{token: USDC, spender: PERMIT2_ADDRESS, amount: 25_000_000n, chainId: 8453}],
  source: {kind: "call", to: SETTLER, data: DATA, value: 0n, chainId: 8453, permit2Transfer: JSON.stringify(typed)},
  ...over,
});

/** 0x's rule as pins.ts builds it, its Settlers given here (the registry read is the provider's resolver). */
const zeroExRule: VenueRule = {kind: "pins", pins: {callTargets: () => [SETTLER, OLD_SETTLER], spenders: () => [PERMIT2_ADDRESS]}, permit2: {maxSeconds: ZEROEX_MAX_PERMIT_SECONDS}};
const check = (p: Swap2ExecutionPlan, r: ReviewedSwap = reviewed, rule: VenueRule | undefined = zeroExRule) => permit2Problem(p, r, rule, NOW) ?? checkPlanBrowser(p, r, rule);
const send = (raw: unknown): WriteIntent => ({chain: "eip155:8453", method: "sendTransaction", raw});
const sign = (raw: unknown): WriteIntent => ({chain: "eip155:8453", method: "signTypedData", raw});

describe("permit2Problem: exactly this swap's PermitTransferFrom, from a venue that takes one", () => {
  it("accepts the 0x token sale as the engine rebuilt it", () => {
    expect(permit2Problem(plan(), reviewed, zeroExRule, NOW)).toBeNull();
    // The previous Settler the registry still names is a call target too, and then the spender.
    expect(permit2Problem(plan({source: {kind: "call", to: OLD_SETTLER, data: DATA, value: 0n, permit2Transfer: JSON.stringify(permit({message: {spender: OLD_SETTLER}}))}}), reviewed, zeroExRule, NOW)).toBeNull();
    // A standing Permit2 allowance covering the input: no approval at all.
    expect(permit2Problem(plan({approvals: []}), reviewed, zeroExRule, NOW)).toBeNull();
    // No permit (a native sale): nothing for this rule to say.
    expect(permit2Problem(plan({approvals: [], source: {kind: "call", to: SETTLER, data: DATA, value: 1n}}), {...reviewed, fromContract: null}, zeroExRule, NOW)).toBeNull();
  });

  it("refuses a tampered spender, token or amount", () => {
    expect(check(plan({}, permit({message: {spender: OLD_SETTLER}})))).toMatch(/spender you didn't review/);
    expect(check(plan({}, permit({message: {spender: EVIL}})))).toMatch(/spender you didn't review/);
    expect(check(plan({}, permit({permitted: {token: WETH}})))).toMatch(/another token/);
    expect(check(plan({}, permit({permitted: {amount: "25000001"}})))).toMatch(/another amount/);
    expect(check(plan({}, permit({permitted: {amount: "24999999"}})))).toMatch(/another amount/);
    expect(check(plan({}, permit({permitted: {amount: "115792089237316195423570985008687907853269984665640564039457584007913129639935"}})))).toMatch(/another amount/);
    expect(check(plan({}, permit({permitted: {amount: 25_000_000}})))).toMatch(/another amount/);
  });

  it("refuses a deadline already passed or further than the package's bound (10 min)", () => {
    expect(ZEROEX_MAX_PERMIT_SECONDS).toBe(600);
    expect(check(plan({}, permit({message: {deadline: String(NOW_S)}})))).toMatch(/already expired/);
    expect(check(plan({}, permit({message: {deadline: String(NOW_S + 600)}})))).toBeNull();
    expect(check(plan({}, permit({message: {deadline: String(NOW_S + 601)}})))).toMatch(/too long/);
    expect(check(plan({}, permit({message: {deadline: String(NOW_S + 3600)}})))).toMatch(/too long/);
    expect(check(plan({}, permit({message: {deadline: "0x10"}})))).toMatch(/already expired/);
  });

  it("refuses another domain: name, network, verifying contract, extra fields", () => {
    expect(check(plan({}, permit({domain: {name: "Permit3"}})))).toMatch(/another contract than Permit2/);
    expect(check(plan({}, permit({domain: {chainId: 1}})))).toMatch(/another network/);
    expect(check(plan({}, permit({domain: {chainId: "8453"}})))).toMatch(/another network/);
    expect(check(plan({}, permit({domain: {verifyingContract: EVIL}})))).toMatch(/another contract than Permit2/);
    expect(check(plan({}, permit({domain: {version: "1"}})))).toMatch(/another contract than Permit2/);
  });

  it("refuses any other typed data: a witness, PermitSingle, an extra type or field, another shape", () => {
    const witness = {...PERMIT2_TRANSFER_TYPES, PermitWitnessTransferFrom: [{name: "witness", type: "bytes32"}]};
    expect(check(plan({}, permit({types: witness})))).toMatch(/another kind/);
    expect(check(plan({}, permit({types: {EIP712Domain: [{name: "name", type: "string"}], ...PERMIT2_TRANSFER_TYPES}})))).toMatch(/another kind/);
    expect(check(plan({}, permit({primaryType: "PermitSingle"})))).toMatch(/another kind/);
    expect(check(plan({}, permit({message: {witness: "0x01"}})))).toMatch(/another kind/);
    expect(check(plan({}, permit({permitted: {extra: "1"}})))).toMatch(/another kind/);
    expect(check(plan({}, permit({extra: {hash: "0x01"}})))).toMatch(/malformed/);
    expect(check(plan({}, permit({message: {nonce: "-1"}})))).toMatch(/malformed/);
    expect(check(plan({source: {kind: "call", to: SETTLER, data: DATA, value: 0n, permit2Transfer: "{not json"}}))).toMatch(/malformed/);
  });

  it("refuses it around the payload: another venue, a native sale, native value, no call data, another spender, another target", () => {
    // A venue whose rule takes no Permit2 transfer (Across' SpokePools; any pins rule without it; no rule at all).
    const pinsOnly: VenueRule = {kind: "pins", pins: zeroExRule.pins};
    expect(check(plan(), reviewed, pinsOnly)).toMatch(/doesn't take one from/);
    expect(permit2Problem(plan(), reviewed, undefined, NOW)).toMatch(/doesn't take one from/);
    expect(checkPlanBrowser(plan(), reviewed, undefined)).toMatch(/doesn't take one from/);
    expect(check(plan({provider: "across"}), {...reviewed, provider: "across"}, VENUE_RULES.across)).toMatch(/doesn't take one from/);
    expect(check(plan({approvals: []}), {...reviewed, fromContract: null, approvalSpender: null})).toMatch(/native-coin sale/);
    expect(permit2Problem(plan({source: {kind: "call", to: SETTLER, data: DATA, value: 1n, permit2Transfer: JSON.stringify(permit())}}), reviewed, zeroExRule, NOW)).toMatch(/native coin sent along/);
    expect(permit2Problem(plan({source: {kind: "call", to: SETTLER, value: 0n, permit2Transfer: JSON.stringify(permit())}}), reviewed, zeroExRule, NOW)).toMatch(/without the swap/);
    expect(permit2Problem(plan({approvals: [{token: USDC, spender: EVIL, amount: 25_000_000n}]}), {...reviewed, approvalSpender: EVIL}, zeroExRule, NOW)).toMatch(/other than Permit2/);
    // A spender that matches the payload but isn't a registry Settler: the pins refuse the call.
    const evil = plan({source: {kind: "call", to: EVIL, data: DATA, value: 0n, permit2Transfer: JSON.stringify(permit({message: {spender: EVIL}}))}});
    expect(permit2Problem(evil, reviewed, zeroExRule, NOW)).toBeNull();
    expect(checkPlanBrowser(evil, reviewed, zeroExRule)).toMatch(/doesn't trust/);
    // And a gasless order from a Permit2 venue never.
    expect(checkPlanBrowser(plan({approvals: [], source: {kind: "typed-order", typedData: JSON.stringify(permit())}}), {...reviewed, approvalSpender: null}, zeroExRule)).toMatch(/order signature/);
  });
});

describe("the gate arms the permit and the signed call, and nothing else", () => {
  it("planWrites: the approval, the exact permit, then the call that must carry its signature", () => {
    const {writes, revokes} = planWrites(plan());
    expect(writes).toEqual([
      {kind: "call", to: USDC, data: approveData(PERMIT2_ADDRESS, 25_000_000n), value: 0n},
      {kind: "permit2", typedData: stableJson(permit())},
      {kind: "call", to: SETTLER, data: DATA, value: 0n, permit2Signed: true},
    ]);
    expect(revokes).toEqual([{token: USDC, spender: PERMIT2_ADDRESS}]);
  });

  it("the call matches only with exactly the recorded signature appended", () => {
    const w = planWrites(plan()).writes[2]!;
    expect(matches(w, "sendTransaction", {to: SETTLER, data: appendPermit2Signature(DATA, SIG), value: 0n}, SIG)).toBe(true);
    expect(matches(w, "sendTransaction", {to: SETTLER, data: appendPermit2Signature(DATA, SIG).toUpperCase().replace("0X", "0x"), value: 0n}, SIG)).toBe(true);
    expect(matches(w, "sendTransaction", {to: SETTLER, data: appendPermit2Signature(DATA, OTHER_SIG), value: 0n}, SIG)).toBe(false);
    expect(matches(w, "sendTransaction", {to: SETTLER, data: DATA, value: 0n}, SIG)).toBe(false);
    expect(matches(w, "sendTransaction", {to: SETTLER, data: appendPermit2Signature(DATA, SIG), value: 0n})).toBe(false);
    expect(matches(w, "sendTransaction", {to: SETTLER, data: `${appendPermit2Signature(DATA, SIG)}00`, value: 0n}, SIG)).toBe(false);
    expect(matches(w, "sendTransaction", {to: OLD_SETTLER, data: appendPermit2Signature(DATA, SIG), value: 0n}, SIG)).toBe(false);
    expect(matches(w, "sendTransaction", {to: SETTLER, data: appendPermit2Signature(DATA, SIG), value: 1n}, SIG)).toBe(false);
    expect(matches(w, "sendTransaction", {to: SETTLER, data: appendPermit2Signature(DATA, SIG), value: 0n}, "0x1234")).toBe(false);
  });

  it("a whole execution: approve, sign the permit, send the call with its signature; a different call is refused", () => {
    const gate = createSwapGate("eip155:8453");
    const {writes, revokes} = planWrites(plan());
    gate.arm(writes, revokes);
    // The engine signs first (its order), then approves, then sends.
    expect(gate.consume(sign(permit()))).toBe(true);
    gate.recordSignature(SIG);
    expect(gate.consume(send({to: USDC, data: approveData(PERMIT2_ADDRESS, 25_000_000n), value: 0n, chainId: 8453}))).toBe(true);
    expect(gate.consume(send({to: SETTLER, data: appendPermit2Signature(DATA, SIG), value: 0n, chainId: 8453}))).toBe(true);
    expect(gate.remaining()).toBe(0);

    const other = createSwapGate("eip155:8453");
    other.arm(writes, revokes);
    expect(other.consume(sign(permit()))).toBe(true);
    other.recordSignature(SIG);
    expect(other.consume(send({to: SETTLER, data: appendPermit2Signature(DATA, OTHER_SIG), value: 0n}))).toBe(false);
  });

  it("no other typed data is armed: a permit with any field changed, or a second signature, is refused", () => {
    const tampered = [
      permit({message: {spender: EVIL}}),
      permit({permitted: {amount: "25000001"}}),
      permit({message: {deadline: String(NOW_S + 3600)}}),
      permit({domain: {chainId: 1}}),
      permit({message: {nonce: "1"}}),
      {...permit(), primaryType: "PermitSingle"},
    ];
    for (const t of tampered) {
      const gate = createSwapGate("eip155:8453");
      gate.arm(planWrites(plan()).writes);
      expect(gate.consume(sign(t)), JSON.stringify(t)).toBe(false);
      // A stray write disarms the rest: the call can no longer be sent either.
      expect(gate.consume(sign(permit()))).toBe(false);
    }
    const gate = createSwapGate("eip155:8453");
    gate.arm(planWrites(plan()).writes);
    expect(gate.consume(sign(permit()))).toBe(true);
    expect(gate.consume(sign(permit()))).toBe(false);
  });

  it("the call waits for the permit's own signature: none recorded, one from another typed write, or after a re-arm", () => {
    const gate = createSwapGate("eip155:8453");
    gate.arm(planWrites(plan()).writes);
    // Nothing signed yet: the call can't carry a signature the gate hasn't seen.
    expect(gate.consume(send({to: SETTLER, data: appendPermit2Signature(DATA, SIG), value: 0n}))).toBe(false);
    // A signature handed over without the permit consumed first is ignored.
    const g2 = createSwapGate("eip155:8453");
    g2.arm(planWrites(plan()).writes);
    g2.recordSignature(SIG);
    expect(g2.consume(send({to: SETTLER, data: appendPermit2Signature(DATA, SIG), value: 0n}))).toBe(false);
    // Only the first answer after the permit counts; a re-armed plan (the engine's re-quote pass) forgets it.
    const g3 = createSwapGate("eip155:8453");
    g3.arm(planWrites(plan()).writes);
    expect(g3.consume(sign(permit()))).toBe(true);
    g3.recordSignature(SIG);
    g3.recordSignature(OTHER_SIG);
    g3.arm(planWrites(plan()).writes);
    expect(g3.consume(send({to: SETTLER, data: appendPermit2Signature(DATA, SIG), value: 0n}))).toBe(false);
  });

  it("through the gated account: the wallet's signature for the permit is the one the swap call must carry", async () => {
    const sent: unknown[] = [];
    let signature = SIG;
    const inner = {
      signTypedData: async (_td: unknown) => signature,
      sendTransaction: async (tx: unknown) => {
        sent.push(tx);
        return {hash: `0x${"ab".repeat(32)}`, fee: 0n};
      },
    };
    const gate = createSwapGate("eip155:8453");
    gate.arm(planWrites(plan({approvals: []})).writes);
    const account = gateAccount(inner, gate);
    expect(await account.signTypedData(permit() as never)).toBe(SIG);
    await expect(account.sendTransaction({to: SETTLER, data: appendPermit2Signature(DATA, OTHER_SIG), value: 0n} as never)).rejects.toBeInstanceOf(SwapGateRefusal);
    expect(sent).toEqual([]);

    const gate2 = createSwapGate("eip155:8453");
    gate2.arm(planWrites(plan({approvals: []})).writes);
    const account2 = gateAccount(inner, gate2);
    signature = OTHER_SIG;
    await account2.signTypedData(permit() as never);
    await account2.sendTransaction({to: SETTLER, data: appendPermit2Signature(DATA, OTHER_SIG), value: 0n} as never);
    expect(sent).toHaveLength(1);
  });
});

describe("0x's and Across's rules in pins.ts", () => {
  it("0x: canonical Permit2 as the only spender on its chains, a Permit2 transfer bounded by the package; Across: its SpokePools, no permit", () => {
    const zx = VENUE_RULES.zeroex;
    expect(zx?.kind).toBe("pins");
    if (zx?.kind !== "pins") return;
    expect(zx.permit2).toEqual({maxSeconds: 600});
    expect(zx.pins.spenders("eip155:8453")).toEqual([PERMIT2_ADDRESS]);
    expect(zx.pins.spenders("eip155:100")).toEqual([]);
    const ac = VENUE_RULES.across;
    expect(ac?.kind).toBe("pins");
    if (ac?.kind !== "pins") return;
    expect(ac.permit2).toBeUndefined();
    const spoke = ACROSS_CHAINS["eip155:8453"]!.spokePool;
    expect(ac.pins.callTargets("eip155:8453").map((a) => a.toLowerCase())).toEqual([spoke.toLowerCase()]);
    expect(ac.pins.spenders("eip155:8453").map((a) => a.toLowerCase())).toEqual([spoke.toLowerCase()]);
    // Every other venue's rule takes no Permit2 transfer.
    for (const [name, rule] of Object.entries(VENUE_RULES)) if (name !== "zeroex") expect(rule.kind === "pins" ? rule.permit2 : undefined, name).toBeUndefined();
  });
});
