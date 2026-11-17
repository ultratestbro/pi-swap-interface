// The swap reports (D41): amounts to 3 significant figures, a report id drawn once, outcomes once per kind, refusals.
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {refusalOf, Swap2ExecutionError, withReason} from "@anywalletkit/protocol-swap2-core/errors";
import type {SwapRecord} from "../../../src/contracts/activity";
import type {PageConnection} from "../../../src/config";
import {applyStatus, newRecord, noteOutcome} from "../../../src/activity";
import {doneEvent, reportOutcome, reportRefused, reportSymbol, resetQuoteRefusals, roundUnits, roundUsd, sentEvent} from "../../../src/activity/counter";
import {createSwapStore} from "../../../src/activity/store";
import {refusalReport, WALLET_DECLINED_TEXT} from "../../../src/execute/errors";
import {SwapGateRefusal, SwapReviewMismatch} from "../../../src/execute/gate";

const T0 = 1_800_000_000_000;
const API = "https://cp0x-api.test";
const BASE = `${API}/api/v2/swap-web`;
const STANDARD: PageConnection = {mode: "standard", api: API, plan: {base: BASE, venues: {}, rpc: new Set(), thornode: false}, keys: {}};
const PUBLIC: PageConnection = {mode: "public", api: API, plan: null, keys: {}};
const ID = "r4nd0m-report-id_00001";

const rec = (over: Partial<SwapRecord> = {}): SwapRecord => ({
  ...newRecord(
    {
      id: "awk1.relay.r1.0xh",
      accountId: "evm:0x8ba1f109551bD432803012645Ac136ddd64DBA72",
      provider: "relay",
      from: {caip2: "eip155:42161", chain: "arbitrum", symbol: "USDC", decimals: 6, key: "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831"},
      to: {caip2: "eip155:8453", chain: "base", symbol: "ETH", decimals: 18, key: "base:native"},
      amountIn: 1_234_567_890n,
      expectedOut: 274_123_456_789_012_345n,
      minOut: 273_000_000_000_000_000n,
      recipient: "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
      hash: "0xh",
      usdIn: 1234.56789,
      slippageBps: 30,
    },
    T0,
  ),
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;
const deps = (page: PageConnection = STANDARD, received?: (r: SwapRecord) => Promise<bigint | null>) => ({
  page,
  demo: false,
  fetch: fetchMock as unknown as typeof fetch,
  ...(received ? {received} : {}),
});
const posts = () => (fetchMock.mock.calls as [string, RequestInit][]).map(([url, init]) => ({url, body: JSON.parse(String(init.body)) as Record<string, unknown>}));

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, {status: 204}));
  resetQuoteRefusals();
});
afterEach(() => vi.restoreAllMocks());

describe("rounding", () => {
  it("base units to 3 significant figures, half up, exact", () => {
    expect(roundUnits(1_234_567_890n, 6)).toBe("1230");
    expect(roundUnits(274_123_456_789_012_345n, 18)).toBe("0.274");
    expect(roundUnits(999_600n, 3)).toBe("1000");
    expect(roundUnits(1_235n, 6)).toBe("0.00124");
    expect(roundUnits(5n, 0)).toBe("5");
    expect(roundUnits(0n, 6)).toBe("0");
    expect(roundUsd(1234.56789)).toBe(1230);
    expect(roundUsd(0.012345)).toBe(0.0123);
  });

  it("symbols as cp0x takes them", () => {
    expect(reportSymbol("USDC.e")).toBe("USDC.e");
    expect(reportSymbol("USD₮0")).toBe("USD₮0");
    expect(reportSymbol("USDC (PoS) 🚀")).toBe("USDCPoS");
    expect(reportSymbol("🚀")).toBe("token");
    expect(reportSymbol("A".repeat(30))).toHaveLength(16);
  });
});

describe("the swap report (/sent)", () => {
  it("a counted record's report: tokens, rounded amounts and value, slippage, its id — no address, hash or exact amount", () => {
    const event = sentEvent(rec({statsId: ID}));
    expect(event).toStrictEqual({
      id: ID,
      venue: "relay",
      from: "eip155:42161",
      to: "eip155:8453",
      mode: "wallet",
      tokenIn: "USDC",
      tokenOut: "ETH",
      amountIn: "1230",
      expectedOut: "0.274",
      minOut: "0.273",
      usdIn: 1230,
      slippageBps: 30,
    });
    const out = JSON.stringify(event);
    for (const secret of ["0x8ba1", "0xh", "awk1", "1234567890", "1234.56"]) expect(out).not.toContain(secret);
  });

  it("an unpriced token has no value; a record from before report ids sends the old count", () => {
    expect(sentEvent(rec({statsId: ID, usdIn: undefined}))).not.toHaveProperty("usdIn");
    expect(sentEvent(rec())).toStrictEqual({venue: "relay", from: "eip155:42161", to: "eip155:8453", mode: "wallet"});
  });
});

describe("the store: a report id once, outcomes once per kind", () => {
  it("the counting write draws the id; a replace carries it; final then reported once, through onOutcome", () => {
    const outcomes: [string, string, string | undefined][] = [];
    let n = 0;
    const s = createSwapStore({
      kv: null,
      channel: null,
      win: null,
      now: () => T0,
      statsId: () => `report-id-000000000${++n}x`,
      onOutcome: (r, report) => outcomes.push([r.id, report, r.statsId]),
    });
    s.saveSwap({...rec({id: "local.1", sourceHash: undefined}), status: "submitting", localId: "local.1"});
    expect(s.getSwap("local.1")?.statsId).toBeUndefined();
    s.updateSwap("local.1", (r) => ({...r, sourceHash: "0xh"}));
    expect(s.getSwap("local.1")).toMatchObject({counted: true, statsId: "report-id-0000000001x"});
    s.replaceSwap("local.1", {...rec(), localId: "local.1"});
    expect(s.getSwap("awk1.relay.r1.0xh")?.statsId).toBe("report-id-0000000001x");
    expect(outcomes).toEqual([]);

    s.updateSwap("awk1.relay.r1.0xh", (r) => ({...r, stuckReported: true}));
    s.updateSwap("awk1.relay.r1.0xh", (r) => ({...r, updatedAt: T0 + 1}));
    s.updateSwap("awk1.relay.r1.0xh", (r) => applyStatus(r, "completed", [{hash: "0xd", type: "destination"}], T0 + 60_000));
    s.updateSwap("awk1.relay.r1.0xh", (r) => applyStatus(r, "completed", [], T0 + 90_000));
    expect(outcomes).toEqual([
      ["awk1.relay.r1.0xh", "stuck", "report-id-0000000001x"],
      ["awk1.relay.r1.0xh", "final", "report-id-0000000001x"],
    ]);
    expect(s.getSwap("awk1.relay.r1.0xh")?.reported).toBe("final");
    expect(n).toBe(1);
  });

  it("a swap stopped before its broadcast, or counted before report ids, reports no outcome", () => {
    expect(noteOutcome({...rec(), status: "not-sent"}).report).toBeNull();
    expect(noteOutcome({...rec({counted: true}), status: "completed"}).report).toBeNull();
    expect(noteOutcome({...rec({counted: true, statsId: ID}), status: "completed"}).report).toBe("final");
    expect(noteOutcome({...rec({counted: true, statsId: ID, reported: "final"}), status: "completed"}).report).toBeNull();
  });
});

describe("the outcome report (/done)", () => {
  const ended = (status: SwapRecord["status"], over: Partial<SwapRecord> = {}) => ({...rec({counted: true, statsId: ID, ...over}), status, updatedAt: T0 + 42_000});

  it("delivered: what arrived, rounded, its distance from the expected amount in bps (exact), under the minimum or not", async () => {
    expect(await doneEvent(ended("completed"), "final", async () => 273_900_000_000_000_000n)).toEqual({
      id: ID,
      outcome: "done",
      durationS: 42,
      actualOut: "0.274",
      diffBps: -8,
      belowMin: false,
    });
    expect(await doneEvent(ended("completed"), "final", async () => 270_000_000_000_000_000n)).toMatchObject({diffBps: -150, belowMin: true});
    expect(await doneEvent(ended("partial"), "final", async () => null)).toEqual({id: ID, outcome: "done", durationS: 42});
  });

  it("refunded, failed, expired, a revert after the broadcast; stuck", async () => {
    const never = async () => {
      throw new Error("not read");
    };
    expect(await doneEvent(ended("refunded"), "final", never)).toEqual({id: ID, outcome: "refunded", durationS: 42});
    for (const st of ["failed", "expired", "cancelled", "not-sent"] as const) expect((await doneEvent(ended(st), "final", never))?.outcome).toBe("failed");
    expect(await doneEvent(ended("pending"), "stuck", never)).toEqual({id: ID, outcome: "stuck", durationS: 42});
    expect(await doneEvent(ended("completed", {statsId: undefined}), "final", never)).toBeNull();
  });

  it("posted to /done on a Standard page only, after reading the delivery", async () => {
    await reportOutcome(ended("completed"), "final", deps(STANDARD, async () => 274_000_000_000_000_000n));
    expect(posts()).toEqual([{url: `${BASE}/done`, body: {id: ID, outcome: "done", durationS: 42, actualOut: "0.274", diffBps: -4, belowMin: false}}]);
    await reportOutcome(ended("completed"), "final", deps(PUBLIC, async () => 1n));
    await reportOutcome(ended("completed"), "final", {...deps(STANDARD, async () => 1n), demo: true});
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("refusals (/refused)", () => {
  it("classifies a decline, the gate, a review mismatch, the fee cap and an SDK safety refusal; nothing else", () => {
    expect(refusalReport(new Error(WALLET_DECLINED_TEXT.replace("You declined", "User rejected")))).toEqual({kind: "wallet", code: null});
    expect(refusalReport(Object.assign(new Error("nope"), {code: 4001}))).toEqual({kind: "wallet", code: null});
    expect(refusalReport(new SwapGateRefusal())).toEqual({kind: "gate", code: "unarmed_write"});
    expect(refusalReport(new Error("wrapped", {cause: new SwapGateRefusal()}))).toEqual({kind: "gate", code: "unarmed_write"});
    expect(refusalReport(new SwapReviewMismatch("the recipient changed"))).toEqual({kind: "gate", code: "review:recipient_changed"});
    expect(refusalReport(new SwapReviewMismatch("the transaction targets 0xabc123, not the router 0xdef"))).toEqual({kind: "gate", code: "review:transaction_targets_not_router"});
    expect(refusalReport(Object.assign(new Error("Exceeded maximum fee cost"), {}))).toEqual({kind: "gate", code: "fee_cap"});
    const vault = withReason(new Swap2ExecutionError("vault moved"), "vault_mismatch");
    expect(refusalOf(vault)?.reason).toBe("vault_mismatch");
    expect(refusalReport(vault)).toEqual({kind: "gate", code: "vault_mismatch"});
    expect(refusalReport(withReason(new Swap2ExecutionError("quote expired"), "quote_expired"))).toBeNull();
    expect(refusalReport(new Error("insufficient funds for gas"))).toBeNull();
  });

  it("posted on a Standard page; a quote round's refusal once per page; codes kept to safe characters", () => {
    const x = {venue: "fynd", fromChain: "eip155:1", toChain: "eip155:1", kind: "gate" as const, code: "policy_refused"};
    reportRefused({...x, once: true}, deps());
    reportRefused({...x, once: true}, deps());
    reportRefused({...x, code: "a b<c>", once: false}, deps());
    reportRefused({...x, kind: "wallet", code: null}, deps());
    reportRefused(x, deps(PUBLIC));
    reportRefused({...x, venue: "thornode"}, deps());
    expect(posts()).toEqual([
      {url: `${BASE}/refused`, body: {venue: "fynd", from: "eip155:1", to: "eip155:1", kind: "gate", code: "policy_refused"}},
      {url: `${BASE}/refused`, body: {venue: "fynd", from: "eip155:1", to: "eip155:1", kind: "gate", code: "a_b_c_"}},
      {url: `${BASE}/refused`, body: {venue: "fynd", from: "eip155:1", to: "eip155:1", kind: "wallet"}},
    ]);
  });
});
