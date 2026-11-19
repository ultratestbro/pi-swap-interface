// The drawer's ranking, polling one record, and the tracker hook (leader tab, invalidates ["bal"] on a move).
import "fake-indexeddb/auto";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createElement, type ReactNode} from "react";
import {renderHook, waitFor} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {SwapRecord} from "../../../src/contracts/activity";

const status = vi.hoisted(() => ({fn: vi.fn()}));
vi.mock("../../../src/swap", async (importOriginal) => ({...(await importOriginal<object>()), swapStatus: status.fn}));

import {activityPort, activityState, getSwaps, loadSwaps, newRecord, pollRecord, pollSwap, saveSwap, urgencyOf} from "../../../src/activity";

const T0 = 1_800_000_000_000;

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

describe("activityState", () => {
  it("ranks action → failed → pending → done, newest first within each", () => {
    const list = [
      rec("done", {status: "completed", createdAt: T0 + 5, updatedAt: T0}),
      rec("pend", {createdAt: T0 + 4}),
      rec("fail", {status: "not-sent", createdAt: T0 + 3, updatedAt: T0}),
      rec("claim", {status: "action-required", createdAt: T0 + 2}),
      rec("pend2", {createdAt: T0 + 6}),
    ];
    const s = activityState(list, true, T0 + 60_000);
    expect(s.items.map((i) => i.record.id)).toEqual(["claim", "fail", "pend2", "pend", "done"]);
    expect(s.items[0]).toMatchObject({urgency: "action", fromChainName: "Ethereum", toChainName: "Base"});
    expect(s.badge?.record.id).toBe("claim");
    expect(s.visibleCount).toBe(5);
    expect(s.loaded).toBe(true);
  });
  it("a finished swap stays in the badge 8 s after its last change", () => {
    const done = rec("done", {status: "completed", updatedAt: T0});
    expect(activityState([done], true, T0 + 7_000).badge?.record.id).toBe("done");
    expect(activityState([done], true, T0 + 9_000).badge).toBeNull();
  });
  it("a QR deposit still open is an action; once its address expired it is pending", () => {
    const d = rec("dep", {mode: "deposit", deposit: {address: "bc1q", memo: null, amount: "1", validUntilMs: T0 + 60_000}});
    expect(urgencyOf(d, T0)).toBe("action");
    expect(urgencyOf(d, T0 + 61_000)).toBe("pending");
  });
});

describe("polling", () => {
  beforeEach(async () => {
    status.fn.mockReset();
    await loadSwaps();
  });

  it("folds a status in; a failure backs off; a local id is never polled", async () => {
    saveSwap(rec("awk1.lifi.p1"));
    status.fn.mockResolvedValueOnce({status: "completed", transactions: [{hash: "0xd", type: "destination"}]});
    const next = await pollRecord(getSwaps().find((r) => r.id === "awk1.lifi.p1")!);
    expect(next).toMatchObject({status: "completed", destHash: "0xd", failures: 0});
    expect(status.fn).toHaveBeenCalledWith("awk1.lifi.p1", "eip155:1");

    saveSwap(rec("awk1.lifi.p2"));
    status.fn.mockRejectedValueOnce(new Error("rpc down"));
    expect(await pollRecord(getSwaps().find((r) => r.id === "awk1.lifi.p2")!)).toMatchObject({failures: 1, status: "pending"});

    expect(await pollRecord(rec("local.5"))).toBeUndefined();
  });

  it("a QR deposit the venue saw arrive: the poll keeps it on the record (still pending)", async () => {
    saveSwap(rec("awk1.near_intents.d1", {provider: "near_intents", mode: "deposit"}));
    status.fn.mockResolvedValueOnce({status: "pending", transactions: [], depositReceived: true});
    expect(await pollRecord(getSwaps().find((r) => r.id === "awk1.near_intents.d1")!)).toMatchObject({status: "pending", depositReceived: true});
  });

  it("polls a claimed swap by its new id, and finds it by that id", async () => {
    saveSwap(rec("awk1.cctp.c1.0xs", {provider: "cctp", trackId: "awk1.cctp.c1.0xs.0xc.ok"}));
    status.fn.mockResolvedValueOnce({status: "completed", transactions: []});
    const r = await pollSwap("awk1.cctp.c1.0xs.0xc.ok");
    expect(status.fn).toHaveBeenCalledWith("awk1.cctp.c1.0xs.0xc.ok", "eip155:1");
    expect(r).toMatchObject({id: "awk1.cctp.c1.0xs", status: "completed"});
  });
});

describe("useSwapTracker / useActivity / useSwap", () => {
  afterEach(() => status.fn.mockReset());

  it("polls unfinished swaps on mount and refreshes balances when one moves", async () => {
    await loadSwaps();
    saveSwap(rec("awk1.lifi.t1", {createdAt: Date.now()}));
    status.fn.mockResolvedValue({status: "completed", transactions: []});
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const wrapper = ({children}: {children: ReactNode}) => createElement(QueryClientProvider, {client: qc}, children);
    const {unmount} = renderHook(() => activityPort.useSwapTracker(), {wrapper});
    await waitFor(() => expect(getSwaps().find((r) => r.id === "awk1.lifi.t1")?.status).toBe("completed"));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({queryKey: ["bal"]}));
    unmount();
  });

  it("a hidden tab still polls a due swap on its tick, so it ends on time (D42)", async () => {
    vi.useFakeTimers({shouldAdvanceTime: true});
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      await loadSwaps();
      saveSwap(rec("awk1.lifi.hidden", {createdAt: Date.now()}));
      status.fn.mockResolvedValue({status: "pending", transactions: []});
      const qc = new QueryClient();
      const wrapper = ({children}: {children: ReactNode}) => createElement(QueryClientProvider, {client: qc}, children);
      const {unmount} = renderHook(() => activityPort.useSwapTracker(), {wrapper});
      // Mount checks everything once; the swap is still pending.
      await waitFor(() => expect(status.fn).toHaveBeenCalledWith("awk1.lifi.hidden", "eip155:1"));
      status.fn.mockResolvedValue({status: "completed", transactions: []});
      await vi.advanceTimersByTimeAsync(15_000);
      await waitFor(() => expect(getSwaps().find((r) => r.id === "awk1.lifi.hidden")?.status).toBe("completed"));
      unmount();
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  // A minimal LockManager: one holder per name, a queue behind it, `steal` (the holder's request rejects).
  function fakeLocks() {
    type Entry = {n: number; steal: boolean; grant: () => void; reject: (e: unknown) => void};
    const entries: Entry[] = [];
    const queue: Entry[] = [];
    let holder: Entry | null = null;
    const locks = {
      request: (_name: string, opts: {signal?: AbortSignal; steal?: boolean}, cb: () => Promise<void>) =>
        new Promise<void>((resolve, reject) => {
          const entry: Entry = {
            n: entries.length + 1,
            steal: opts.steal === true,
            grant: () => {
              holder = entry;
              void cb().then(() => {
                if (holder !== entry) return; // stolen: its request has rejected already
                holder = null;
                resolve();
                queue.shift()?.grant();
              });
            },
            reject,
          };
          entries.push(entry);
          if (opts.steal) {
            const prev = holder;
            holder = null;
            prev?.reject(new DOMException("stolen", "AbortError"));
            entry.grant();
          } else if (!holder) entry.grant();
          else {
            queue.push(entry);
            opts.signal?.addEventListener("abort", () => {
              const i = queue.indexOf(entry);
              if (i < 0) return;
              queue.splice(i, 1);
              reject(new DOMException("aborted", "AbortError"));
            });
          }
        }),
    };
    Object.defineProperty(navigator, "locks", {value: locks, configurable: true});
    return {entries, queue, holder: () => holder};
  }

  it("with Web Locks only the lock holder polls; a hidden tab queues and takes over when it unmounts", async () => {
    await loadSwaps();
    saveSwap(rec("awk1.lifi.lead", {createdAt: Date.now()}));
    status.fn.mockResolvedValue({status: "pending", transactions: []});
    const lock = fakeLocks();
    try {
      const qc = new QueryClient();
      const wrapper = ({children}: {children: ReactNode}) => createElement(QueryClientProvider, {client: qc}, children);
      const leader = renderHook(() => activityPort.useSwapTracker(), {wrapper});
      await waitFor(() => expect(status.fn).toHaveBeenCalled());
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      const follower = renderHook(() => activityPort.useSwapTracker(), {wrapper});
      visibility.mockRestore();
      expect(lock.queue.map((e) => e.n)).toEqual([2]);
      leader.unmount();
      await waitFor(() => expect(lock.queue).toHaveLength(0));
      expect(lock.holder()?.n).toBe(2); // the follower holds it now
      follower.unmount();
      await waitFor(() => expect(lock.holder()).toBeNull());
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("the tab the person looks at takes the lock — on load and when shown again; the other queues (owner 2026-11-19)", async () => {
    await loadSwaps();
    saveSwap(rec("awk1.lifi.shown", {createdAt: Date.now()}));
    status.fn.mockResolvedValue({status: "pending", transactions: []});
    const lock = fakeLocks();
    try {
      const qc = new QueryClient();
      const wrapper = ({children}: {children: ReactNode}) => createElement(QueryClientProvider, {client: qc}, children);
      // An older tab holds the lock (in the background, its timers slowed); a new tab opens in front.
      const polls = () => status.fn.mock.calls.filter(([id]) => id === "awk1.lifi.shown").length;
      const older = renderHook(() => activityPort.useSwapTracker(), {wrapper});
      await waitFor(() => expect(polls()).toBe(1));
      const shown = renderHook(() => activityPort.useSwapTracker(), {wrapper});
      // It takes the lock and checks every unfinished swap at once; the older one queues behind it.
      expect(lock.holder()?.n).toBe(2);
      await waitFor(() => expect(polls()).toBe(2));
      await waitFor(() => expect(lock.queue.map((e) => e.n)).toEqual([3]));
      // The person goes back to the older tab: it takes the lock again (the newer tab, already leading, re-checks).
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(lock.holder()?.steal).toBe(true));
      expect(lock.holder()!.n).toBeGreaterThan(3);
      // One hold, the other tab queued once: no tab piles up requests.
      await waitFor(() => expect(lock.queue).toHaveLength(1));
      shown.unmount();
      older.unmount();
      await waitFor(() => expect(lock.queue).toHaveLength(0));
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("useActivity and useSwap follow the store", async () => {
    await loadSwaps();
    const {result} = renderHook(() => ({a: activityPort.useActivity(), s: activityPort.useSwap("local.77")}));
    expect(result.current.a.loaded).toBe(true);
    saveSwap(rec("awk1.lifi.r77", {localId: "local.77", createdAt: Date.now()}));
    await waitFor(() => expect(result.current.s?.id).toBe("awk1.lifi.r77"));
    expect(result.current.a.items.some((i) => i.record.id === "awk1.lifi.r77")).toBe(true);
  });
});
