/**
 * Follows every unfinished swap until it lands (mobile lib/swap/tracker.ts, web: ui-port.md §4.8): loads the
 * persisted list, polls `getSwap2Status` on the schedule inflight.ts sets (10 s fresh → 2 min old, backing off on
 * errors) — a hidden tab too (D42: the browser slows its timers, to once a minute after a few minutes), so a swap
 * ends on time while the person looks elsewhere — re-checks everything when the tab comes back, and refreshes balances
 * (react-query `["bal"]`) when a swap's status moves. One tab per browser polls — the holder of the Web Lock
 * `cp0x-swap-tracker`; the others render what BroadcastChannel brings. The tab the person looks at takes the lock
 * (`steal`) as it loads and whenever it is shown again; the one it was taken from queues for it. Without Web Locks
 * every tab polls.
 * There is no backend: incidents go to the console only.
 */
import {useEffect} from "react";
import {useQueryClient} from "@tanstack/react-query";
import type {SwapRecord} from "../contracts/activity";
import {appActive} from "../config";
import {swapStatus} from "../swap";
import {applyStatus, duePolls, findSwap, isFinal, isLocalId, pollFailed, swapIncident} from "./inflight";
import {getSwaps, loadSwaps, sweepInterrupted, updateSwap} from "./store";

const TICK_MS = 5_000;
const LOCK = "cp0x-swap-tracker";
const polling = new Set<string>();

/** Status source (swap.swapStatus); injectable for tests. */
export type StatusSource = (
  id: string,
  fromChain: string,
) => Promise<{status: SwapRecord["status"]; transactions: readonly {hash: string; type?: string}[]; depositReceived?: boolean}>;

/** Poll one record now; resolves with the updated record (undefined when skipped: local id, already polling, gone). */
export async function pollRecord(r: SwapRecord, status: StatusSource = swapStatus): Promise<SwapRecord | undefined> {
  if (isLocalId(r.id) || polling.has(r.id)) return undefined;
  polling.add(r.id);
  try {
    const res = await status(r.trackId ?? r.id, r.fromChain);
    return noteIncident(r, updateSwap(r.id, (x) => applyStatus(x, res.status, res.transactions, Date.now(), res.depositReceived === true)));
  } catch (e) {
    return noteIncident(r, updateSwap(r.id, (x) => pollFailed(x)), e);
  } finally {
    polling.delete(r.id);
  }
}

/** "Refresh status" for the record `id` names (id, local id or claim id); resolves with the record as it stands after. */
export async function pollSwap(id: string): Promise<SwapRecord | undefined> {
  await loadSwaps();
  const r = findSwap(getSwaps(), id);
  if (!r) return undefined;
  return (await pollRecord(r)) ?? findSwap(getSwaps(), id);
}

/** A swap that ended badly or hangs gets one console line (no addresses or hashes); "stuck" once per swap. */
function noteIncident(prev: SwapRecord, next: SwapRecord | undefined, pollError?: unknown): SwapRecord | undefined {
  const incident = next ? swapIncident(prev, next) : null;
  if (!next || !incident) return next;
  console.warn(
    incident === "stuck" ? "swap not delivered after 45 min" : `swap ended ${next.status}`,
    {provider: next.provider, from: `${next.fromSymbol} ${next.fromSlug}`, to: `${next.toSymbol} ${next.toSlug}`, ageMin: Math.round((Date.now() - next.createdAt) / 60_000), ...(pollError instanceof Error ? {pollError: pollError.message.slice(0, 200)} : {})},
  );
  return incident === "stuck" ? updateSwap(next.id, (x) => ({...x, stuckReported: true})) : next;
}

type Locks = {request: LockManager["request"]};
const webLocks = (): Locks | null => {
  const l = typeof navigator !== "undefined" ? (navigator as Navigator & {locks?: LockManager}).locks : undefined;
  return l?.request ? l : null;
};

/** Mount once (App): loads the list, polls on schedule, re-polls when the tab becomes visible — leader tab only (a shown tab leads). */
export function useSwapTracker(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let alive = true;
    const locks = webLocks();
    let leader = !locks;
    let release: (() => void) | null = null;

    const run = async (all = false) => {
      await loadSwaps();
      if (!alive || !leader) return;
      sweepInterrupted();
      const list = getSwaps();
      const due = all ? list.filter((r) => !isFinal(r.status) && !isLocalId(r.id) && r.status !== "submitting") : duePolls(list);
      for (const r of due) {
        void pollRecord(r).then((next) => {
          // A settled or moved swap changed balances on both chains.
          if (next && next.status !== r.status) void qc.invalidateQueries({queryKey: ["bal"]});
        });
      }
    };

    // The lock request that holds the lock now (0: none) and the last one made: a stolen hold is told from an
    // aborted queue place by its number.
    let holding = 0;
    let requests = 0;
    let queued: AbortController | null = null;
    // Queue for the lock, or take it (steal) for the tab the person looks at: a hidden leader's timers are slowed to
    // once a minute, so a swap watched in another tab would end late (owner 2026-11-19: it ended only on "Refresh").
    const lead = (steal: boolean) => {
      if (!locks || !alive) return;
      const n = ++requests;
      const place = steal ? null : new AbortController();
      if (place) {
        queued?.abort();
        queued = place;
      }
      locks
        .request(LOCK, place ? {signal: place.signal} : {steal: true}, () => {
          if (!alive) return Promise.resolve();
          // Taken: this tab's place in the queue is no longer needed.
          if (steal) queued?.abort();
          queued = null;
          holding = n;
          leader = true;
          void run(true);
          // Held until this tab goes away (or the tracker unmounts), or another tab the person opens takes it.
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        })
        .catch(() => {
          // Stolen: queue again, so this tab polls once that one goes away. (Else an aborted place, or no steal here.)
          if (holding !== n) return;
          holding = 0;
          leader = false;
          release = null;
          lead(false);
        });
    };

    void loadSwaps();
    if (locks) lead(appActive());
    else void run(true);
    // Hidden too (D42): only unfinished swaps are due, so an idle tab asks nothing.
    const timer = setInterval(() => void run(), TICK_MS);
    const onVisible = () => {
      if (!appActive()) return;
      if (leader) void run(true);
      else lead(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      queued?.abort();
      (release as (() => void) | null)?.();
    };
  }, [qc]);
}
