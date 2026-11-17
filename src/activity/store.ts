/**
 * Swaps in flight, persisted in IndexedDB (`cp0x-activity` / `kv`, key `cp0x-swaps-v1`, the JSON string — so
 * parseStored stays the one reader) and shared by every tab of this browser (D16). Same surface as mobile
 * lib/swap/store.ts: a module-level list, subscribe, a hook.
 *
 * Tabs never overwrite each other's list: every change is one operation (upsert / replace) applied to the
 * in-memory list, posted on BroadcastChannel `cp0x-swaps`, and merged into the stored list inside one IndexedDB
 * read-write transaction (idb-keyval `update`); ops apply in arrival order. The executing tab bumps `heartbeatAt`
 * every 5 s; another tab marks a `submitting` record interrupted only after 30 s of silence (inflight markInterrupted); `beforeunload` asks
 * before closing a tab that is still submitting. Without IndexedDB (blocked site data) the list lives in this tab
 * only.
 *
 * The moment a record first reads as sent (inflight readsSent) is noted on the record itself, `counted`, in the same
 * op, by the tab whose own write made it so — never on a message from another tab or a load — and that write is the one
 * that calls `onSent`: the app's store hands it to the swap counter (counter.ts, D36), so each swap counts once.
 */
import {useSyncExternalStore} from "react";
import {createStore, get, update, type UseStore} from "idb-keyval";
import type {SwapRecord} from "../contracts/activity";
import {countSent, newStatsId, reportOutcome} from "./counter";
import {markInterrupted, markNotSent, noteOutcome, noteSent, parseStored, prune, upsert, wasInterrupted, type OutcomeReport} from "./inflight";

const KEY = "cp0x-swaps-v1";
const DB = "cp0x-activity";
const CHANNEL = "cp0x-swaps";
const HEARTBEAT_MS = 5_000;

/** One change to the list. `replace` = the record submitted under `oldId` now goes by `record.id`. */
export type StoreOp = {kind: "upsert"; record: SwapRecord} | {kind: "replace"; oldId: string; record: SwapRecord};

/** What tabs tell each other. */
export interface StoreMessage {
  v: 1;
  ops: StoreOp[];
}

/** The cross-tab bus (BroadcastChannel in the browser; an in-process bus in tests). */
export interface SwapChannel {
  post(msg: StoreMessage): void;
  listen(fn: (msg: StoreMessage) => void): () => void;
}

/**
 * Apply one op. Ops carry whole records and apply in arrival order — no clock comparison, so a clock that moves
 * backwards never drops an update. Only one tab writes a given record at a time in practice (the executing tab its
 * `local.` record, the tracker's leader the polled ones), so arrival order is the write order.
 */
export function applyOp(list: readonly SwapRecord[], op: StoreOp): SwapRecord[] {
  const base = op.kind === "replace" ? list.filter((r) => r.id !== op.oldId) : list;
  return upsert(base, op.record);
}

/** A message from another tab, read as defensively as storage. */
function readMessage(data: unknown): StoreOp[] {
  if (!data || typeof data !== "object" || (data as {v?: unknown}).v !== 1 || !Array.isArray((data as {ops?: unknown}).ops)) return [];
  const out: StoreOp[] = [];
  for (const o of (data as {ops: unknown[]}).ops) {
    if (!o || typeof o !== "object") continue;
    const op = o as {kind?: unknown; oldId?: unknown; record?: unknown};
    const [record] = parseStored(JSON.stringify([op.record]));
    if (!record) continue;
    if (op.kind === "upsert") out.push({kind: "upsert", record});
    else if (op.kind === "replace" && typeof op.oldId === "string" && op.oldId) out.push({kind: "replace", oldId: op.oldId, record});
  }
  return out;
}

/** BroadcastChannel as a SwapChannel, or null where it doesn't exist. */
function browserChannel(): SwapChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    const chan = new BroadcastChannel(CHANNEL);
    return {
      post: (msg) => {
        try {
          chan.postMessage(msg);
        } catch {
          // A closed channel (page unloading): the other tabs reload from storage.
        }
      },
      listen: (fn) => {
        const h = (e: MessageEvent) => fn(e.data as StoreMessage);
        chan.addEventListener("message", h);
        return () => chan.removeEventListener("message", h);
      },
    };
  } catch {
    return null;
  }
}

function browserKv(): UseStore | null {
  if (typeof indexedDB === "undefined") return null;
  try {
    return createStore(DB, "kv");
  } catch {
    return null;
  }
}

export interface SwapStoreOptions {
  /** IndexedDB store; null = in memory only. Default: idb-keyval `createStore("cp0x-activity", "kv")`. */
  kv?: UseStore | null;
  /** Cross-tab bus; null = this tab only. Default: BroadcastChannel("cp0x-swaps"). */
  channel?: SwapChannel | null;
  /** Where `beforeunload` is registered; null = nowhere. Default: window. */
  win?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
  now?: () => number;
  /** Called once per record, after the write that first makes it read as sent (D36). Default: nothing. */
  onSent?: ((r: SwapRecord) => void) | null;
  /** Called once per counted record and kind, after the write that makes it stuck or final (D41). Default: nothing. */
  onOutcome?: ((r: SwapRecord, report: OutcomeReport) => void) | null;
  /** The report id a counted record gets (D41). Default: counter newStatsId (random). */
  statsId?: () => string;
}

/** One browsing context's view of the persisted swaps. The app uses the default instance (module functions below). */
export function createSwapStore(opts: SwapStoreOptions = {}) {
  const kv = opts.kv === undefined ? browserKv() : opts.kv;
  const channel = opts.channel === undefined ? browserChannel() : opts.channel;
  const win = opts.win === undefined ? (typeof window !== "undefined" ? window : null) : opts.win;
  const now = opts.now ?? Date.now;
  const onSent = opts.onSent ?? null;
  const onOutcome = opts.onOutcome ?? null;
  const statsId = opts.statsId ?? newStatsId;

  let swaps: readonly SwapRecord[] = [];
  let loaded: Promise<void> | null = null;
  let isLoaded = false;
  /** Ids this tab is executing — any other `submitting` record is another tab's (or a dead tab's). */
  const running = new Set<string>();
  const beats = new Map<string, ReturnType<typeof setInterval>>();
  const listeners = new Set<() => void>();
  let pending: Promise<void> = Promise.resolve();

  const notify = () => {
    for (const l of listeners) l();
  };

  const persist = (ops: readonly StoreOp[]) => {
    if (!kv || !ops.length) return;
    // Serialized per tab; each write is one read-modify-write transaction, so another tab's records survive it.
    pending = pending
      .then(() => update<string>(KEY, (raw) => JSON.stringify(prune(ops.reduce<SwapRecord[]>(applyOp, parseStored(raw)), now())), kv))
      .catch(() => {});
  };

  const commit = (raw: StoreOp[]) => {
    if (!raw.length) return;
    // Each op's record as it is stored: `counted` carried over, or set by the write that makes it read as sent — with
    // its report id (D41) — and `reported` set by the write that makes a counted swap stuck or final.
    const sent: SwapRecord[] = [];
    const outcomes: [SwapRecord, OutcomeReport][] = [];
    let list: SwapRecord[] = [...swaps];
    const ops = raw.map((op) => {
      const prev = list.find((r) => r.id === (op.kind === "replace" ? op.oldId : op.record.id));
      const noted = noteSent(prev, op.record);
      const counted = noted.sent ? {...noted.record, statsId: statsId()} : noted.record;
      if (noted.sent) sent.push(counted);
      const outcome = noteOutcome(counted);
      if (outcome.report) outcomes.push([outcome.record, outcome.report]);
      const next = outcome.record === op.record ? op : {...op, record: outcome.record};
      list = applyOp(list, next);
      return next;
    });
    swaps = prune(list, now());
    notify();
    persist(ops);
    channel?.post({v: 1, ops});
    for (const r of sent) onSent?.(r);
    for (const [r, report] of outcomes) onOutcome?.(r, report);
  };

  channel?.listen((data) => {
    const ops = readMessage(data);
    if (!ops.length) return;
    swaps = prune(ops.reduce<SwapRecord[]>(applyOp, [...swaps]), now());
    notify();
  });

  const onUnload = (e: BeforeUnloadEvent) => {
    if (swaps.some((r) => running.has(r.id) && r.status === "submitting")) {
      e.preventDefault();
      // Older browsers need returnValue set to show the "leave site?" prompt.
      e.returnValue = "";
    }
  };

  const api = {
    /** Read the persisted list once (the tracker calls it at startup); anything written before the read wins over the stored copy. */
    loadSwaps(): Promise<void> {
      loaded ??= (async () => {
        let raw: string | undefined;
        try {
          raw = kv ? await get<string>(KEY, kv) : undefined;
        } catch {
          raw = undefined;
        }
        // This tab's writes before the read (already merged into storage too) win over the stored copy.
        const merged = swaps.reduce<SwapRecord[]>((list, record) => applyOp(list, {kind: "upsert", record}), parseStored(raw));
        swaps = prune(merged, now());
        isLoaded = true;
        notify();
        api.sweepInterrupted();
      })();
      return loaded;
    },
    getSwaps: (): readonly SwapRecord[] => swaps,
    getSwap: (id: string): SwapRecord | undefined => swaps.find((s) => s.id === id),
    /** The persisted list has been read. */
    swapsLoaded: (): boolean => isLoaded,
    saveSwap(r: SwapRecord): void {
      commit([{kind: "upsert", record: r}]);
    },
    /** The record submitted under a local id, now known by the engine's id. */
    replaceSwap(oldId: string, r: SwapRecord): void {
      commit([{kind: "replace", oldId, record: r}]);
    },
    /** Change one record (its id stays: a new polling id goes into `trackId`). */
    updateSwap(id: string, change: (r: SwapRecord) => SwapRecord): SwapRecord | undefined {
      const r = swaps.find((s) => s.id === id);
      if (!r) return undefined;
      const next = {...change(r), id};
      commit([{kind: "upsert", record: next}]);
      return next;
    },
    /** This tab is (no longer) executing `id`: heartbeats every 5 s, and the leave-page prompt while it submits. */
    setRunning(id: string, on: boolean): void {
      if (on) {
        running.add(id);
        if (!beats.has(id)) beats.set(id, setInterval(() => api.beat(id), HEARTBEAT_MS));
      } else {
        running.delete(id);
        const t = beats.get(id);
        if (t !== undefined) clearInterval(t);
        beats.delete(id);
      }
      if (running.size) win?.addEventListener("beforeunload", onUnload);
      else win?.removeEventListener("beforeunload", onUnload);
    },
    /** One heartbeat for a record this tab executes; takes it back if a tab that thought this one dead marked it interrupted. */
    beat(id: string): void {
      if (!running.has(id)) return;
      api.updateSwap(id, (r) => {
        if (r.status === "submitting") return {...r, heartbeatAt: now()};
        // Another tab took this one for dead (not-sent, or maybe-sent from the signing step on): it is alive after all.
        if (wasInterrupted(r)) {
          const {error: _error, maybeSent: _maybeSent, ...rest} = r;
          return {...rest, status: "submitting", heartbeatAt: now(), updatedAt: now()};
        }
        return r;
      });
    },
    /** The viewer checked their wallet: an untracked maybe-sent record (a `local.` id) becomes not-sent. Others are left as they are. */
    markNotSent(id: string): SwapRecord | undefined {
      return api.updateSwap(id, (r) => markNotSent(r, now()));
    },
    /** Mark `submitting` records whose tab went silent as interrupted (the tracker's leader runs it each tick). */
    sweepInterrupted(): void {
      const at = now();
      const next = markInterrupted(swaps, running, at);
      commit(next.filter((r, i) => r !== swaps[i]).map((record) => ({kind: "upsert" as const, record})));
    },
    subscribeSwaps(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Every write handed to IndexedDB so far has finished (tests). */
    flush: (): Promise<void> => pending,
  };
  return api;
}

/** One browsing context's swap store (createSwapStore). */
export type SwapStore = ReturnType<typeof createSwapStore>;

let instance: SwapStore | null = null;
/** The app's store, created on first use; a swap it notes as sent, then stuck or ended, is reported (D36, D41: Standard only). */
export const swapStore = (): SwapStore =>
  (instance ??= createSwapStore({onSent: (r) => countSent(r), onOutcome: (r, report) => void reportOutcome(r, report)}));

/** Read the persisted list once (the tracker calls it at startup). */
export const loadSwaps = (): Promise<void> => swapStore().loadSwaps();
/** The list as this tab sees it, newest first. */
export const getSwaps = (): readonly SwapRecord[] => swapStore().getSwaps();
/** Insert or replace a record by id. */
export const saveSwap = (r: SwapRecord): void => swapStore().saveSwap(r);
/** The record submitted under `oldId` now goes by `r.id`. */
export const replaceSwap = (oldId: string, r: SwapRecord): void => swapStore().replaceSwap(oldId, r);
/** Change one record; undefined when there is none with that id. */
export const updateSwap = (id: string, change: (r: SwapRecord) => SwapRecord): SwapRecord | undefined => swapStore().updateSwap(id, change);
/** This tab is (no longer) executing `id`. */
export const setRunning = (id: string, on: boolean): void => swapStore().setRunning(id, on);
/** Mark silent `submitting` records as interrupted (not sent, or maybe sent once the wallet was asked to sign). */
export const sweepInterrupted = (): void => swapStore().sweepInterrupted();
/** The viewer's "not sent" for an untracked maybe-sent record. */
export const markSwapNotSent = (id: string): SwapRecord | undefined => swapStore().markNotSent(id);

/** The live list (re-renders on every change in any tab). */
export function useSwaps(): readonly SwapRecord[] {
  const s = swapStore();
  return useSyncExternalStore(s.subscribeSwaps, s.getSwaps, s.getSwaps);
}

/** The persisted list has been read. */
export function useSwapsLoaded(): boolean {
  const s = swapStore();
  return useSyncExternalStore(s.subscribeSwaps, s.swapsLoaded, s.swapsLoaded);
}
