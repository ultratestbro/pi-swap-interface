// The swap store over fake IndexedDB, with two "tabs" sharing one database and an in-process BroadcastChannel (D16).
import "fake-indexeddb/auto";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createStore, get} from "idb-keyval";
import type {SwapRecord} from "../../../src/contracts/activity";
import {INTERRUPTED_SENT_TEXT, INTERRUPTED_SIGNING_TEXT, INTERRUPTED_TEXT, newRecord, parseStored} from "../../../src/activity/inflight";
import {applyOp, createSwapStore, type StoreMessage, type SwapChannel} from "../../../src/activity/store";

const T0 = 1_800_000_000_000;
let dbSeq = 0;

/** An in-process bus: every tab but the sender hears a message (like BroadcastChannel). */
function bus() {
  const tabs = new Set<(m: StoreMessage) => void>();
  return (): SwapChannel => {
    let mine: ((m: StoreMessage) => void) | null = null;
    return {
      post: (m) => {
        const copy = structuredClone(m);
        for (const t of tabs) if (t !== mine) t(copy);
      },
      listen: (fn) => {
        mine = fn;
        tabs.add(fn);
        return () => void tabs.delete(fn);
      },
    };
  };
}

const rec = (id: string, over: Partial<SwapRecord> = {}): SwapRecord => ({
  ...newRecord(
    {
      id,
      accountId: "evm:0xme",
      provider: "lifi",
      from: {caip2: "eip155:1", chain: "ethereum", symbol: "USDC", decimals: 6},
      to: {caip2: "eip155:8453", chain: "base", symbol: "USDC", decimals: 6},
      amountIn: 1n,
      expectedOut: 1n,
      minOut: 1n,
      recipient: "0xme",
    },
    T0,
  ),
  ...over,
});

function tabs(clock = {now: T0}) {
  const kvName = `cp0x-activity-test-${++dbSeq}`;
  const channel = bus();
  const make = () => createSwapStore({kv: createStore(kvName, "kv"), channel: channel(), win: null, now: () => clock.now});
  return {make, kv: createStore(kvName, "kv"), clock};
}

afterEach(() => vi.useRealTimers());

describe("a record's route (D47)", () => {
  it("keeps a venue's routeId through storage; a malformed one is dropped, the record kept", () => {
    const fast = rec("awk1.cctp.a", {provider: "cctp", routeId: "fast"});
    const [back] = parseStored(JSON.stringify([fast], (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
    expect(back).toMatchObject({id: "awk1.cctp.a", routeId: "fast"});
    const bad = parseStored(JSON.stringify([{...fast, amountIn: "1", expectedOut: "1", minOut: "1", routeId: "a b"}]));
    expect(bad).toHaveLength(1);
    expect("routeId" in bad[0]!).toBe(false);
    expect("routeId" in rec("awk1.lifi.x")).toBe(false);
  });
});

describe("swap store", () => {
  it("persists the JSON string under cp0x-swaps-v1 and loads it back in a new tab", async () => {
    const {make, kv} = tabs();
    const a = make();
    await a.loadSwaps();
    a.saveSwap(rec("awk1.lifi.a"));
    await a.flush();
    const raw = await get<string>("cp0x-swaps-v1", kv);
    expect(typeof raw).toBe("string");
    expect(parseStored(raw).map((r) => r.id)).toEqual(["awk1.lifi.a"]);
    const b = make();
    await b.loadSwaps();
    expect(b.getSwaps().map((r) => r.id)).toEqual(["awk1.lifi.a"]);
    expect(b.swapsLoaded()).toBe(true);
  });

  it("tabs see each other's changes at once, and neither overwrites the other's records in storage", async () => {
    const {make, kv} = tabs();
    const a = make();
    const b = make();
    await Promise.all([a.loadSwaps(), b.loadSwaps()]);
    const seen = vi.fn();
    b.subscribeSwaps(seen);
    a.saveSwap(rec("awk1.lifi.a", {createdAt: T0 + 1}));
    b.saveSwap(rec("awk1.lifi.b", {createdAt: T0 + 2}));
    expect(seen).toHaveBeenCalled();
    expect(a.getSwaps().map((r) => r.id)).toEqual(["awk1.lifi.b", "awk1.lifi.a"]);
    expect(b.getSwaps().map((r) => r.id)).toEqual(["awk1.lifi.b", "awk1.lifi.a"]);
    await Promise.all([a.flush(), b.flush()]);
    expect(parseStored(await get<string>("cp0x-swaps-v1", kv)).map((r) => r.id).sort()).toEqual(["awk1.lifi.a", "awk1.lifi.b"]);
  });

  it("replace moves a local record to the engine's id in every tab", async () => {
    const {make} = tabs();
    const a = make();
    const b = make();
    await Promise.all([a.loadSwaps(), b.loadSwaps()]);
    a.saveSwap(rec("local.1", {status: "submitting", localId: "local.1"}));
    a.replaceSwap("local.1", rec("awk1.lifi.x.0xh", {localId: "local.1"}));
    expect(b.getSwaps().map((r) => r.id)).toEqual(["awk1.lifi.x.0xh"]);
  });

  it("ops apply in arrival order, whatever their timestamps say (a clock that moved back drops nothing)", () => {
    const first = rec("x", {status: "completed", updatedAt: T0 + 5});
    const second = rec("x", {status: "refunded", updatedAt: T0 - 5});
    expect(applyOp(applyOp([], {kind: "upsert", record: first}), {kind: "upsert", record: second})).toEqual([second]);
    expect(applyOp([rec("local.1")], {kind: "replace", oldId: "local.1", record: first})).toEqual([first]);
  });

  it("ignores malformed messages from the channel", async () => {
    const listeners: ((m: StoreMessage) => void)[] = [];
    const s = createSwapStore({kv: null, win: null, channel: {post: () => {}, listen: (fn) => (listeners.push(fn), () => {})}});
    await s.loadSwaps();
    listeners[0]!({v: 1, ops: [{kind: "upsert", record: {id: 5}}, {kind: "nuke"}]} as unknown as StoreMessage);
    listeners[0]!(null as unknown as StoreMessage);
    expect(s.getSwaps()).toEqual([]);
  });

  it("works without IndexedDB (this tab only)", async () => {
    const s = createSwapStore({kv: null, channel: null, win: null});
    await s.loadSwaps();
    s.saveSwap(rec("awk1.lifi.a"));
    expect(s.updateSwap("awk1.lifi.a", (r) => ({...r, status: "completed", updatedAt: T0 + 1}))?.status).toBe("completed");
    expect(s.updateSwap("nope", (r) => r)).toBeUndefined();
  });
});

describe("heartbeats and interrupted submissions", () => {
  it("the executing tab beats every 5 s; another tab leaves a beating record alone and marks a silent one not-sent", async () => {
    // Only the beat timer is faked: fake-indexeddb runs on the real ones.
    vi.useFakeTimers({toFake: ["setInterval", "clearInterval"]});
    const clock = {now: T0};
    const {make} = tabs(clock);
    const exec = make();
    const other = make();
    await Promise.all([exec.loadSwaps(), other.loadSwaps()]);
    exec.setRunning("local.1", true);
    exec.saveSwap(rec("local.1", {status: "submitting", localId: "local.1", heartbeatAt: T0, updatedAt: T0}));
    for (let i = 0; i < 12; i++) {
      clock.now += 5_000;
      vi.advanceTimersByTime(5_000);
    }
    expect(other.getSwaps()[0]!.heartbeatAt).toBe(T0 + 60_000);
    other.sweepInterrupted();
    expect(other.getSwaps()[0]!.status).toBe("submitting");

    // The executing tab dies (no more beats): 30 s later the other tab calls it.
    exec.setRunning("local.1", false);
    clock.now += 31_000;
    vi.advanceTimersByTime(31_000);
    other.sweepInterrupted();
    expect(other.getSwaps()[0]).toMatchObject({status: "not-sent", error: INTERRUPTED_TEXT});
    expect(exec.getSwaps()[0]!.status).toBe("not-sent");
  });

  it("a throttled executing tab takes its record back on the next beat", async () => {
    // Only the beat timer is faked: fake-indexeddb runs on the real ones.
    vi.useFakeTimers({toFake: ["setInterval", "clearInterval"]});
    const clock = {now: T0};
    const {make} = tabs(clock);
    const exec = make();
    const other = make();
    await Promise.all([exec.loadSwaps(), other.loadSwaps()]);
    exec.setRunning("local.1", true);
    exec.saveSwap(rec("local.1", {status: "submitting", localId: "local.1", heartbeatAt: T0, updatedAt: T0}));
    clock.now += 40_000; // the beat timer was throttled: no beat for 40 s
    other.sweepInterrupted();
    expect(other.getSwaps()[0]!.status).toBe("not-sent");
    clock.now += 1_000;
    vi.advanceTimersByTime(5_000);
    expect(other.getSwaps()[0]).toMatchObject({status: "submitting"});
    expect(other.getSwaps()[0]!.error).toBeUndefined();
    exec.setRunning("local.1", false);
  });

  it("a throttled executing tab takes back a record another tab marked maybe-sent at the signing step", async () => {
    vi.useFakeTimers({toFake: ["setInterval", "clearInterval"]});
    const clock = {now: T0};
    const {make} = tabs(clock);
    const exec = make();
    const other = make();
    await Promise.all([exec.loadSwaps(), other.loadSwaps()]);
    exec.setRunning("local.1", true);
    exec.saveSwap(rec("local.1", {status: "submitting", stage: "signing", localId: "local.1", heartbeatAt: T0, updatedAt: T0}));
    clock.now += 40_000;
    other.sweepInterrupted();
    expect(other.getSwaps()[0]).toMatchObject({status: "pending", maybeSent: true, error: INTERRUPTED_SIGNING_TEXT});
    clock.now += 1_000;
    vi.advanceTimersByTime(5_000);
    expect(other.getSwaps()[0]).toMatchObject({status: "submitting", stage: "signing"});
    expect(other.getSwaps()[0]!.maybeSent).toBeUndefined();
    expect(other.getSwaps()[0]!.error).toBeUndefined();
    exec.setRunning("local.1", false);
  });

  it("a reload after the tab died at signing or after broadcast never says nothing was swapped", async () => {
    const clock = {now: T0};
    const {make} = tabs(clock);
    const first = make();
    await first.loadSwaps();
    first.saveSwap(rec("local.10", {status: "submitting", stage: "signing", fromKey: "a", toKey: "b", heartbeatAt: T0, updatedAt: T0}));
    first.saveSwap(rec("local.11", {status: "submitting", stage: "broadcast", sourceHash: "0xsent", heartbeatAt: T0, updatedAt: T0}));
    await first.flush();
    clock.now = T0 + 31_000;
    const reloaded = make();
    await reloaded.loadSwaps();
    const byId = (id: string) => reloaded.getSwaps().find((r) => r.id === id)!;
    expect(byId("local.10")).toMatchObject({status: "pending", maybeSent: true, error: INTERRUPTED_SIGNING_TEXT});
    expect(byId("local.11")).toMatchObject({status: "pending", maybeSent: true, sourceHash: "0xsent", error: INTERRUPTED_SENT_TEXT});
    // The viewer, after checking the wallet, settles the hashless one.
    reloaded.markNotSent("local.10");
    expect(byId("local.10")).toMatchObject({status: "not-sent", maybeSent: false});
  });

  it("asks before the page unloads only while this tab is submitting", async () => {
    const handlers: ((e: BeforeUnloadEvent) => void)[] = [];
    const win = {
      addEventListener: (_: string, h: (e: BeforeUnloadEvent) => void) => void (handlers.includes(h) || handlers.push(h)),
      removeEventListener: (_: string, h: (e: BeforeUnloadEvent) => void) => void handlers.splice(handlers.indexOf(h), 1),
    } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
    const s = createSwapStore({kv: null, channel: null, win});
    await s.loadSwaps();
    s.setRunning("local.1", true);
    s.saveSwap(rec("local.1", {status: "submitting"}));
    const ev = {preventDefault: vi.fn(), returnValue: undefined as unknown} as unknown as BeforeUnloadEvent;
    handlers[0]!(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    s.updateSwap("local.1", (r) => ({...r, status: "pending", updatedAt: T0 + 1}));
    const ev2 = {preventDefault: vi.fn()} as unknown as BeforeUnloadEvent;
    handlers[0]!(ev2);
    expect(ev2.preventDefault).not.toHaveBeenCalled();
    s.setRunning("local.1", false);
    expect(handlers).toHaveLength(0);
  });

  it("load marks what a dead tab left submitting (silent > 30 s) as not sent", async () => {
    const clock = {now: T0};
    const {make} = tabs(clock);
    const first = make();
    await first.loadSwaps();
    first.saveSwap(rec("local.9", {status: "submitting", heartbeatAt: T0, updatedAt: T0}));
    await first.flush();
    clock.now = T0 + 120_000;
    const reloaded = make();
    await reloaded.loadSwaps();
    expect(reloaded.getSwaps()[0]).toMatchObject({status: "not-sent", error: INTERRUPTED_TEXT});
  });
});
