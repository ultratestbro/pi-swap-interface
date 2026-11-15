// Port of mobile lib/swap/inflight.test.ts with the web texts (ui-port.md §4.12), QR deposits (§4.6) and the
// multi-tab heartbeat rule (D16).
import {describe, expect, it} from "vitest";
import type {SwapRecord} from "../../../src/contracts/activity";
import {
  applyStatus,
  asStatus,
  duePolls,
  findSwap,
  INTERRUPTED_SENT_TEXT,
  INTERRUPTED_SIGNING_TEXT,
  INTERRUPTED_TEXT,
  isFinal,
  isUntrackedMaybeSent,
  MARKED_NOT_SENT_TEXT,
  markInterrupted,
  markNotSent,
  newRecord,
  nextPollAt,
  parseStored,
  pollFailed,
  providerOfId,
  prune,
  statusView,
  swapIncident,
  swapSteps,
  upsert,
  visibleSwaps,
  wasInterrupted,
} from "../../../src/activity/inflight";

const T0 = 1_800_000_000_000;

const rec = (over: Partial<SwapRecord> = {}): SwapRecord => ({
  ...newRecord(
    {
      id: "awk1.cctp.intent.0xhash",
      accountId: "evm:0xme",
      provider: "cctp",
      from: {caip2: "eip155:1", chain: "ethereum", symbol: "USDC", decimals: 6},
      to: {caip2: "eip155:8453", chain: "base", symbol: "USDC", decimals: 6},
      amountIn: 100_000_000n,
      expectedOut: 99_989_000n,
      minOut: 99_489_055n,
      recipient: "0xme",
      hash: "0xhash",
    },
    T0,
  ),
  ...over,
});

const deposit = (over: Partial<SwapRecord> = {}): SwapRecord => ({
  ...newRecord(
    {
      id: "awk1.near_intents.dep",
      accountId: "deposit:bc1qrefund",
      provider: "near_intents",
      from: {caip2: "bitcoin:mainnet", chain: "bitcoin", symbol: "BTC", decimals: 8},
      to: {caip2: "eip155:1", chain: "ethereum", symbol: "ETH", decimals: 18},
      amountIn: 1_250_000n,
      expectedOut: 1n,
      minOut: 1n,
      recipient: "0xme",
      mode: "deposit",
      deposit: {address: "bc1qdeposit", memo: null, amount: "1250000", validUntilMs: T0 + 125_000},
    },
    T0,
  ),
  ...over,
});

describe("newRecord", () => {
  it("starts pending with the amounts as base-unit strings", () => {
    const r = rec();
    expect(r.status).toBe("pending");
    expect(r.amountIn).toBe("100000000");
    expect(r.minOut).toBe("99489055");
    expect(r.sourceHash).toBe("0xhash");
    expect(r.maybeSent).toBeUndefined();
  });
  it("keeps the deposit mode", () => {
    expect(deposit()).toMatchObject({mode: "deposit", deposit: {address: "bc1qdeposit", amount: "1250000"}});
  });
});

describe("status", () => {
  it("final states", () => {
    for (const s of ["completed", "failed", "refunded", "cancelled", "expired", "partial", "not-sent"] as const) expect(isFinal(s)).toBe(true);
    for (const s of ["pending", "action-required", "refund-pending", "submitting"] as const) expect(isFinal(s)).toBe(false);
  });
  it("unknown strings read as pending", () => {
    expect(asStatus("completed")).toBe("completed");
    expect(asStatus("PROCESSING")).toBe("pending");
    expect(asStatus(undefined)).toBe("pending");
  });
  it("views, in the web's words", () => {
    expect(statusView(rec(), "Base")).toMatchObject({label: "In progress", tone: "progress"});
    expect(statusView(rec(), "Base").detail).toMatch(/close this tab — tracking picks up when you come back/);
    expect(statusView(rec({maybeSent: true}), "Base")).toMatchObject({label: "Checking", tone: "warn"});
    expect(statusView(rec({status: "action-required"}), "Base")).toMatchObject({label: "Claim needed", tone: "action"});
    expect(statusView(rec({status: "completed"}), "Base").detail).toBe("USDC arrived on Base.");
    expect(statusView(rec({status: "refunded"}), "Base").tone).toBe("warn");
    expect(statusView(rec({status: "failed"}), "Base").tone).toBe("bad");
    for (const s of ["submitting", "not-sent", "pending", "completed"] as const)
      expect(`${statusView(rec({status: s}), "Base").label} ${statusView(rec({status: s}), "Base").detail}`).not.toMatch(/cp0x|Face ID|the app/);
  });
  it("a QR deposit waits for the payer with a countdown, then watches once the address expired", () => {
    expect(statusView(deposit(), "Ethereum", T0 + 5_000)).toEqual({
      label: "Waiting for your deposit",
      tone: "action",
      detail: "Send exactly the amount to the address. It expires in 2:00.",
    });
    expect(statusView(deposit(), "Ethereum", T0 + 200_000)).toMatchObject({label: "Watching for your deposit", tone: "progress"});
    expect(statusView(deposit({status: "refunded"}), "Ethereum").detail).toMatch(/refund address/);
  });
});

describe("nextPollAt / duePolls", () => {
  it("10 s while fresh, 30 s after 10 min, 2 min after 2 h; none when final", () => {
    expect(nextPollAt(rec(), T0)).toBe(T0 + 10_000);
    expect(nextPollAt(rec({checkedAt: T0 + 11 * 60_000}), T0 + 11 * 60_000)).toBe(T0 + 11 * 60_000 + 30_000);
    expect(nextPollAt(rec({checkedAt: T0 + 3 * 3600_000}), T0 + 3 * 3600_000)).toBe(T0 + 3 * 3600_000 + 120_000);
    expect(nextPollAt(rec({status: "completed"}), T0)).toBeNull();
  });
  it("a claim waiting for the user is rechecked every minute at most", () => {
    expect(nextPollAt(rec({status: "action-required"}), T0)).toBe(T0 + 60_000);
  });
  it("backs off on failures, up to 5 minutes", () => {
    expect(nextPollAt(rec({failures: 1}), T0)).toBe(T0 + 20_000);
    expect(nextPollAt(rec({failures: 9}), T0)).toBe(T0 + 300_000);
  });
  it("due = past its next poll, unfinished, not a local id, not still submitting", () => {
    const list = [rec(), rec({id: "awk1.lifi.x", status: "completed"}), rec({id: "local.1"}), rec({id: "awk1.x.y", status: "submitting"})];
    expect(duePolls(list, T0 + 5_000)).toEqual([]);
    expect(duePolls(list, T0 + 10_000).map((r) => r.id)).toEqual(["awk1.cctp.intent.0xhash"]);
  });
});

describe("applyStatus / pollFailed", () => {
  it("folds the answer in, keeps the delivery hash, resets failures", () => {
    const r = applyStatus(rec({failures: 3, maybeSent: true}), "completed", [{hash: "0xsrc", type: "source"}, {hash: "0xdest", type: "destination"}], T0 + 60_000);
    expect(r).toMatchObject({status: "completed", destHash: "0xdest", failures: 0, maybeSent: false, checkedAt: T0 + 60_000, updatedAt: T0 + 60_000});
  });
  it("an unchanged status doesn't move updatedAt; maybe-sent stays until the provider sees it", () => {
    const r = applyStatus(rec({maybeSent: true}), "pending", [], T0 + 60_000);
    expect(r.updatedAt).toBe(T0);
    expect(r.maybeSent).toBe(true);
  });
  it("a failed poll counts", () => {
    expect(pollFailed(rec(), T0 + 1).failures).toBe(1);
  });
  it("a QR deposit the venue saw arrive keeps saying so (deposits only); a later poll without it doesn't undo it", () => {
    const seen = applyStatus(deposit(), "pending", [], T0 + 60_000, true);
    expect(seen.depositReceived).toBe(true);
    expect(seen.updatedAt).toBe(T0);
    expect(applyStatus(seen, "pending", [], T0 + 70_000).depositReceived).toBe(true);
    expect(applyStatus(rec(), "pending", [], T0 + 60_000, true)).not.toHaveProperty("depositReceived");
  });
});

describe("swapIncident", () => {
  it("ended badly, or stuck past 45 min (once) — never a deposit nobody sent", () => {
    expect(swapIncident(rec(), rec({status: "failed"}), T0)).toBe("ended");
    expect(swapIncident(rec(), rec(), T0 + 46 * 60_000)).toBe("stuck");
    expect(swapIncident(rec(), rec({stuckReported: true}), T0 + 46 * 60_000)).toBeNull();
    expect(swapIncident(deposit(), deposit(), T0 + 46 * 60_000)).toBeNull();
  });
});

describe("list", () => {
  it("upsert replaces by id, newest first", () => {
    const a = rec({id: "a", createdAt: T0});
    const b = rec({id: "b", createdAt: T0 + 1});
    const list = upsert(upsert([], a), b);
    expect(list.map((r) => r.id)).toEqual(["b", "a"]);
    expect(upsert(list, {...a, status: "completed"}).find((r) => r.id === "a")!.status).toBe("completed");
  });
  it("prune keeps unfinished swaps, finished ones for a week, at most 50", () => {
    const old = rec({id: "old", status: "completed", updatedAt: T0 - 8 * 86_400_000});
    const live = rec({id: "live", updatedAt: T0 - 30 * 86_400_000});
    const recent = rec({id: "recent", status: "refunded", updatedAt: T0 - 86_400_000});
    expect(prune([old, live, recent], T0).map((r) => r.id)).toEqual(["live", "recent"]);
    expect(prune(Array.from({length: 60}, (_, i) => rec({id: `x${i}`})), T0)).toHaveLength(50);
  });
  it("visible = every payer's unfinished swaps and ones settled in the last 10 min", () => {
    const list = [
      rec({id: "a"}),
      rec({id: "b", accountId: "solana:So1"}),
      rec({id: "c", status: "completed", updatedAt: T0}),
      rec({id: "d", status: "completed", updatedAt: T0 - 11 * 60_000}),
    ];
    expect(visibleSwaps(list, T0 + 60_000).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("parseStored", () => {
  it("round-trips, deposit and heartbeat included", () => {
    const list = [rec({claimHash: "0xclaim", trackId: "awk1.cctp.intent.0xhash.0xc.ok"}), deposit({heartbeatAt: T0 + 3, depositReceived: true})];
    expect(parseStored(JSON.stringify(list))).toEqual(list);
  });
  it("drops malformed entries and garbage", () => {
    expect(parseStored(null)).toEqual([]);
    expect(parseStored("{not json")).toEqual([]);
    expect(parseStored(JSON.stringify({a: 1}))).toEqual([]);
    const parsed = parseStored(JSON.stringify([null, {id: "x"}, {...rec(), amountIn: "1e18", status: "weird", mode: "teleport", deposit: {address: 5}}]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.amountIn).toBe("0");
    expect(parsed[0]!.status).toBe("pending");
    expect(parsed[0]!.mode).toBeUndefined();
    expect(parsed[0]!.deposit).toBeUndefined();
  });
});

describe("ids", () => {
  it("providerOfId reads the provider segment", () => {
    expect(providerOfId("awk1.near_intents.abc.0xh")).toBe("near_intents");
    expect(providerOfId("awk1")).toBe("");
  });
  it("findSwap: id, either spelling, the local id, the claim's polling id", () => {
    const lifi = rec({id: "awk1.lifi.lifi%3A1.0xabc", provider: "lifi", localId: "local.9"});
    const cctp = rec({id: "awk1.cctp.i.0xs", trackId: "awk1.cctp.i.0xs.0xc.ok"});
    expect(findSwap([cctp, lifi], "awk1.lifi.lifi:1.0xabc")).toBe(lifi);
    expect(findSwap([cctp, lifi], "awk1.lifi.lifi%3A1.0xabc")).toBe(lifi);
    expect(findSwap([cctp, lifi], "local.9")).toBe(lifi);
    expect(findSwap([cctp, lifi], "awk1.cctp.i.0xs.0xc.ok")).toBe(cctp);
    expect(findSwap([cctp], undefined)).toBeUndefined();
    expect(findSwap([cctp], "awk1.lifi.x")).toBeUndefined();
  });
});

describe("submission (execute's runner records)", () => {
  const sub = (over: Partial<SwapRecord> = {}) => rec({id: "local.1", localId: "local.1", status: "submitting", approvals: 1, ...over});

  it("labels the running step and a stop before broadcast", () => {
    expect(statusView(sub({stage: "approving", fromSymbol: "USDT"}), "Base").label).toBe("Approving USDT");
    expect(statusView(sub({stage: "signing"}), "Base")).toMatchObject({label: "Signing the swap", tone: "progress"});
    expect(statusView(sub(), "Base").detail).toBe("Keep this tab open until the swap is sent.");
    const stopped = statusView(sub({status: "not-sent", error: "The price moved below your minimum — nothing was swapped.", approved: true}), "Base");
    expect(stopped).toMatchObject({label: "Not swapped", tone: "bad"});
    expect(stopped.detail).toMatch(/price moved.*remove the approval/);
  });

  it("walks the steps: approve → the wallet's confirmation → swap → delivery", () => {
    const states = (r: SwapRecord) => swapSteps(r, "Base").map((s) => `${s.key}:${s.state}`);
    const confirm = (r: SwapRecord) => swapSteps(r, "Base").find((s) => s.key === "confirm")!;
    // The confirmation step is the wallet's: never done (or worded as done) before the wallet signed the swap.
    expect(confirm(sub({approvals: 0, stage: "signing"}))).toEqual({key: "confirm", label: "Confirm the transaction", state: "active"});
    expect(confirm(sub({approvals: 0, stage: "broadcast"}))).toEqual({key: "confirm", label: "You confirmed the transaction", state: "done"});
    expect(states(sub({approvals: 0, stage: "signing"}))).toEqual(["confirm:active", "swap:todo", "deliver:todo"]);
    expect(states(sub({approvals: 0, stage: "broadcast", sourceHash: "0xsent"}))).toEqual(["confirm:done", "swap:active", "deliver:todo"]);
    expect(states(sub({stage: "approving"}))).toEqual(["approve:active", "confirm:todo", "swap:todo", "deliver:todo"]);
    expect(states(sub({stage: "preflight", approved: true}))).toEqual(["approve:done", "confirm:active", "swap:todo", "deliver:todo"]);
    expect(states(sub({stage: "signing", approved: true}))).toEqual(["approve:done", "confirm:active", "swap:todo", "deliver:todo"]);
    expect(states(rec({status: "pending", approvals: 1}))).toEqual(["approve:done", "confirm:done", "swap:done", "deliver:active"]);
    expect(states(rec({status: "completed", approvals: 0}))).toEqual(["confirm:done", "swap:done", "deliver:done"]);
    expect(states(sub({status: "not-sent", stage: "approving"}))).toEqual(["approve:failed", "confirm:todo", "swap:todo", "deliver:todo"]);
    expect(states(sub({status: "not-sent", stage: "requoting", approved: true}))).toEqual(["approve:done", "confirm:failed", "swap:todo", "deliver:todo"]);
    expect(states(sub({status: "not-sent", stage: "signing", approvals: 0}))).toEqual(["confirm:failed", "swap:todo", "deliver:todo"]);
    expect(swapSteps(rec({status: "action-required"}), "Base").at(-1)).toMatchObject({label: "Claim USDC on Base", state: "active"});
  });

  it("a Permit2 venue's token sale (0x, D38): the permit first — the approval and the swap untouched while the wallet holds it", () => {
    const zx = (over: Partial<SwapRecord> = {}) => sub({provider: "zeroex", permit: true, fromSymbol: "USDC", ...over});
    const states = (r: SwapRecord) => swapSteps(r, "Base").map((s) => `${s.key}:${s.state}`);
    const label = (r: SwapRecord, key: string) => swapSteps(r, "Base").find((s) => s.key === key)!.label;
    // The wallet shows the Permit2 typed data: nothing approved, nothing to confirm yet.
    expect(states(zx({stage: "permit"}))).toEqual(["permit:active", "approve:todo", "confirm:todo", "swap:todo", "deliver:todo"]);
    expect(label(zx({stage: "permit"}), "permit")).toBe("Sign the Permit2 transfer");
    expect(statusView(zx({stage: "permit"}), "Base")).toMatchObject({label: "Signing the Permit2 transfer", tone: "progress"});
    // Then Permit2's approval, then the swap's own prompt.
    expect(states(zx({stage: "approving"}))).toEqual(["permit:done", "approve:active", "confirm:todo", "swap:todo", "deliver:todo"]);
    expect(label(zx({stage: "approving"}), "permit")).toBe("You signed the Permit2 transfer");
    expect(states(zx({stage: "preflight", approved: true}))).toEqual(["permit:done", "approve:done", "confirm:active", "swap:todo", "deliver:todo"]);
    expect(label(zx({stage: "signing", approved: true}), "approve")).toBe("Approve USDC");
    expect(states(zx({stage: "broadcast", approved: true, sourceHash: "0xs"}))).toEqual(["permit:done", "approve:done", "confirm:done", "swap:active", "deliver:todo"]);
    // A standing Permit2 allowance covered the input: no approval was sent, and the step says so.
    expect(states(zx({stage: "signing"}))).toEqual(["permit:done", "approve:done", "confirm:active", "swap:todo", "deliver:todo"]);
    expect(label(zx({stage: "signing"}), "approve")).toBe("USDC already approved for Permit2");
    // A re-quote's new permit (the approval is in place): the swap's prompt is not open yet.
    expect(states(zx({stage: "permit", approved: true}))).toEqual(["permit:active", "approve:done", "confirm:todo", "swap:todo", "deliver:todo"]);
    // Declined at the permit: that step failed, the rest was never reached.
    expect(states(zx({status: "not-sent", stage: "permit"}))).toEqual(["permit:failed", "approve:todo", "confirm:todo", "swap:todo", "deliver:todo"]);
    expect(states(zx({status: "not-sent", stage: "approving"}))).toEqual(["permit:done", "approve:failed", "confirm:todo", "swap:todo", "deliver:todo"]);
    expect(states(zx({status: "not-sent", stage: "signing", approved: true}))).toEqual(["permit:done", "approve:done", "confirm:failed", "swap:todo", "deliver:todo"]);
  });

  it("a tab gone while the wallet held the permit swapped nothing: not-sent (the permit is off-chain, only that tab could spend it)", () => {
    const [r] = markInterrupted([sub({provider: "zeroex", permit: true, stage: "permit", fromSymbol: "USDC", heartbeatAt: T0})], new Set(), T0 + 31_000);
    expect(r).toMatchObject({status: "not-sent", error: INTERRUPTED_TEXT, approved: false});
    expect(r!.maybeSent).toBeUndefined();
    expect(wasInterrupted(r!)).toBe(true);
    // A re-quote's permit, after Permit2's approval was mined: that approval may still be live.
    const [requoted] = markInterrupted([sub({provider: "zeroex", permit: true, stage: "permit", approved: true, fromSymbol: "USDC", heartbeatAt: T0})], new Set(), T0 + 31_000);
    expect(requoted).toMatchObject({status: "not-sent", error: `${INTERRUPTED_TEXT} The USDC approval may still be active.`});
  });

  it("deposit steps: address issued → send the amount → delivery", () => {
    const states = (r: SwapRecord) => swapSteps(r, "Ethereum").map((s) => `${s.key}:${s.state}`);
    expect(swapSteps(deposit(), "Ethereum").map((s) => s.label)).toEqual(["Deposit address issued", "Send 0.0125 BTC", "Deliver ETH on Ethereum"]);
    expect(states(deposit())).toEqual(["confirm:done", "swap:active", "deliver:todo"]);
    // The venue saw it arrive while still pending (NEAR's PROCESSING): sent, now delivering.
    expect(states(deposit({depositReceived: true}))).toEqual(["confirm:done", "swap:done", "deliver:active"]);
    expect(states(deposit({status: "completed"}))).toEqual(["confirm:done", "swap:done", "deliver:done"]);
    expect(states(deposit({status: "expired"}))).toEqual(["confirm:done", "swap:failed", "deliver:failed"]);
  });

  it("marks a submitting record interrupted only after 30 s without a heartbeat, and never one this tab runs", () => {
    const beating = sub({id: "local.2", heartbeatAt: T0 + 100_000, updatedAt: T0});
    const silent = sub({id: "local.3", heartbeatAt: T0 + 60_000, approved: true, fromSymbol: "USDT"});
    const mine = sub({id: "local.4", heartbeatAt: T0});
    const [b, s, m] = markInterrupted([beating, silent, mine], new Set(["local.4"]), T0 + 110_000);
    expect(b!.status).toBe("submitting");
    expect(s).toMatchObject({status: "not-sent", approved: false, updatedAt: T0 + 110_000});
    expect(s!.error).toBe(`${INTERRUPTED_TEXT} The USDT approval may still be active.`);
    expect(m!.status).toBe("submitting");
    // No heartbeat at all: updatedAt is the clock.
    expect(markInterrupted([sub({updatedAt: T0})], new Set(), T0 + 29_000)[0]!.status).toBe("submitting");
    expect(markInterrupted([sub({updatedAt: T0})], new Set(), T0 + 31_000)[0]!.status).toBe("not-sent");
  });

  it("a tab gone while the wallet held the swap (signing) leaves it maybe-sent — tracked, never not-sent or retried", () => {
    const signing = sub({id: "local.5", stage: "signing", sourceHash: undefined, approved: true, fromKey: "base:native", toKey: "base:0xusdc", heartbeatAt: T0});
    const [r] = markInterrupted([signing], new Set(), T0 + 31_000);
    expect(r).toMatchObject({status: "pending", maybeSent: true, error: INTERRUPTED_SIGNING_TEXT, updatedAt: T0 + 31_000});
    expect(r!.status).not.toBe("not-sent");
    const view = statusView(r!, "Base");
    expect(view).toMatchObject({label: "Check your wallet", tone: "warn"});
    expect(view.detail).not.toMatch(/nothing was swapped|updates on its own/);
    expect(isFinal(r!.status)).toBe(false);
    expect(wasInterrupted(r!)).toBe(true);
    // Whether the wallet confirmed it is unknown: the confirmation stays open, the swap step not done.
    expect(swapSteps(r!, "Base").map((s) => `${s.key}:${s.state}`)).toEqual(["approve:done", "confirm:active", "swap:todo", "deliver:todo"]);
  });

  it("a tab gone after the broadcast (hash on the record) says it was sent and keeps the hash", () => {
    const sent = sub({id: "local.6", stage: "broadcast", sourceHash: "0xsent", heartbeatAt: T0});
    const [r] = markInterrupted([sent], new Set(), T0 + 31_000);
    expect(r).toMatchObject({status: "pending", maybeSent: true, sourceHash: "0xsent", error: INTERRUPTED_SENT_TEXT});
    expect(statusView(r!, "Base")).toMatchObject({label: "Sent — not tracked", tone: "warn", detail: INTERRUPTED_SENT_TEXT});
    expect(swapSteps(r!, "Base").find((s) => s.key === "swap")!.state).toBe("done");
  });

  it("a tab gone while approving says the approval may still go out; before any prompt it is plain not-sent", () => {
    const [approving] = markInterrupted([sub({stage: "approving", fromSymbol: "USDT", heartbeatAt: T0})], new Set(), T0 + 31_000);
    expect(approving).toMatchObject({status: "not-sent"});
    expect(approving!.error).toBe(`${INTERRUPTED_TEXT} Your wallet may still send the USDT approval it was asked for — check its activity.`);
    expect(wasInterrupted(approving!)).toBe(true);
    const [preflight] = markInterrupted([sub({stage: "preflight", approved: true, fromSymbol: "USDT", heartbeatAt: T0})], new Set(), T0 + 31_000);
    expect(preflight).toMatchObject({status: "not-sent", error: `${INTERRUPTED_TEXT} The USDT approval may still be active.`});
  });

  it("an untracked maybe-sent record never claims it updates on its own, and only the viewer can settle it", () => {
    const lost = rec({id: "local.7", localId: "local.7", status: "pending", maybeSent: true, sourceHash: undefined});
    const view = statusView(lost, "Base");
    expect(view).toMatchObject({label: "Check your wallet", tone: "warn"});
    expect(view.detail).not.toMatch(/updates on its own/);
    expect(view.detail).toMatch(/wallet's activity/);
    // Nothing polls it…
    expect(duePolls([lost], T0 + 365 * 86_400_000)).toEqual([]);
    expect(isUntrackedMaybeSent(lost)).toBe(true);
    // …so "Mark as not sent" is the way out (and the header badge lets go of it once it is final).
    const marked = markNotSent(lost, T0 + 5);
    expect(marked).toMatchObject({status: "not-sent", maybeSent: false, error: MARKED_NOT_SENT_TEXT, updatedAt: T0 + 5});
    expect(visibleSwaps([marked], T0 + 11 * 60_000)).toEqual([]);
    // A tracked maybe-sent swap (the engine's id) or a settled one is never touched.
    const tracked = rec({maybeSent: true});
    expect(statusView(tracked, "Base").detail).toMatch(/updates on its own/);
    expect(markNotSent(tracked)).toBe(tracked);
    expect(markNotSent(sub())).toEqual(sub());
  });

  it("keeps the submission fields through storage", () => {
    const r = sub({stage: "approving", approvals: 2, approved: true, error: "x", fromKey: "base:native", toKey: "base:0xusdc", heartbeatAt: 5});
    expect(parseStored(JSON.stringify([r]))[0]).toMatchObject({status: "submitting", stage: "approving", approvals: 2, approved: true, error: "x", localId: "local.1", fromKey: "base:native", toKey: "base:0xusdc", heartbeatAt: 5});
    expect(parseStored(JSON.stringify([sub({stage: "permit", permit: true})]))[0]).toMatchObject({stage: "permit", permit: true});
    expect(parseStored(JSON.stringify([{...sub(), permit: "yes"}]))[0]!.permit).toBeUndefined();
  });
});
