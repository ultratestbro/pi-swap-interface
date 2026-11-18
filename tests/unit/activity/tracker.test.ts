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

  it("with Web Locks only the lock holder polls; the next tab takes over when it unmounts", async () => {
    await loadSwaps();
    saveSwap(rec("awk1.lifi.lead", {createdAt: Date.now()}));
    status.fn.mockResolvedValue({status: "pending", transactions: []});
    // A minimal LockManager: one holder per name, a queue behind it.
    const queue: (() => void)[] = [];
    let held = false;
    const locks = {
      request: (_name: string, opts: {signal?: AbortSignal}, cb: () => Promise<void>) =>
        new Promise<void>((resolve, reject) => {
          const grant = () => {
            held = true;
            void cb().then(() => {
              held = false;
              queue.shift()?.();
              resolve();
            });
          };
          if (!held) grant();
          else {
            queue.push(grant);
            opts.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }
        }),
    };
    Object.defineProperty(navigator, "locks", {value: locks, configurable: true});
    try {
      const qc = new QueryClient();
      const wrapper = ({children}: {children: ReactNode}) => createElement(QueryClientProvider, {client: qc}, children);
      const leader = renderHook(() => activityPort.useSwapTracker(), {wrapper});
      await waitFor(() => expect(status.fn).toHaveBeenCalled());
      const follower = renderHook(() => activityPort.useSwapTracker(), {wrapper});
      expect(queue).toHaveLength(1);
      leader.unmount();
      await waitFor(() => expect(queue).toHaveLength(0));
      expect(held).toBe(true); // the follower holds it now
      follower.unmount();
      await waitFor(() => expect(held).toBe(false));
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
