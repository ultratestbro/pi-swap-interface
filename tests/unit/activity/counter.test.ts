// The swap counter (D36): one POST per swap sent, from Standard pages only, deduped on the record across reloads and tabs.
import "fake-indexeddb/auto";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createStore, set} from "idb-keyval";
import type {SwapRecord} from "../../../src/contracts/activity";
import type {StartSwapInput} from "../../../src/contracts/execution";
import type {SwapToken} from "../../../src/contracts/domain";

type Phase = (p: string, d?: {total?: number; hash?: string}) => void;
const exec = vi.hoisted(() => ({run: undefined as undefined | ((onPhase: Phase) => Promise<unknown>)}));
vi.mock("../../../src/execute/execute", () => ({
  executeSwap: (input: {onPhase: Phase}) => exec.run!(input.onPhase),
}));

import {DEFAULT_RUNTIME_CONFIG, setRuntimeConfig, type PageConnection} from "../../../src/config";
import {applyStatus, getSwaps, loadSwaps, markInterrupted, newRecord, noteSent, parseStored, readsSent} from "../../../src/activity";
import {countSent, sentEvent, SENT_TIMEOUT_MS} from "../../../src/activity/counter";
import {createSwapStore, type StoreMessage, type SwapChannel} from "../../../src/activity/store";
import {startSwap} from "../../../src/execute/runner";

const T0 = 1_800_000_000_000;
const API = "https://cp0x-api.test";
const BASE = `${API}/api/v2/swap-web`;
const STANDARD: PageConnection = {mode: "standard", api: API, plan: {base: BASE, venues: {}, rpc: new Set(), thornode: false}, keys: {}};
const NO_OVERRIDES = {ignored: false, hosts: [], evmRpcChains: [], solanaRpc: false};

const rec = (id: string, over: Partial<SwapRecord> = {}): SwapRecord => ({
  ...newRecord(
    {
      id,
      accountId: "tron:TXYZ",
      provider: "near_intents",
      from: {caip2: "tron:728126428", chain: "tron", symbol: "USDT", decimals: 6},
      to: {caip2: "eip155:8453", chain: "base", symbol: "USDC", decimals: 6},
      amountIn: 25_000_000n,
      expectedOut: 24_900_000n,
      minOut: 24_899_000n,
      recipient: "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
    },
    T0,
  ),
  ...over,
});

/** The executing tab's record at its first step, as the runner writes it. */
const submitting = (localId: string): SwapRecord => ({...rec(localId), status: "submitting", stage: "signing", localId, heartbeatAt: T0});

let fetchMock: ReturnType<typeof vi.fn>;
const posts = () => fetchMock.mock.calls as [string, RequestInit][];
const bodies = () => posts().map(([, init]) => JSON.parse(String(init.body)) as unknown);
/** Each report's venue, networks and mode (a counted record's report carries more: D41, tested below). */
const heads = () => (bodies() as {venue: string; from: string; to: string; mode: string}[]).map(({venue, from, to, mode}) => ({venue, from, to, mode}));
/** A store whose sent swaps go to the counter on a Standard page, through the fake fetch. */
const counting = (page: PageConnection = STANDARD) => (r: SwapRecord) => countSent(r, {page, demo: false, fetch: fetchMock as unknown as typeof fetch});

let dbSeq = 0;
/** Tabs sharing one fake IndexedDB and an in-process BroadcastChannel (every tab but the sender hears a message). */
function browser() {
  const kvName = `cp0x-activity-counter-${++dbSeq}`;
  const tabs = new Set<(m: StoreMessage) => void>();
  const channel = (): SwapChannel => {
    let mine: ((m: StoreMessage) => void) | null = null;
    return {
      post: (m) => {
        for (const t of tabs) if (t !== mine) t(structuredClone(m));
      },
      listen: (fn) => {
        mine = fn;
        tabs.add(fn);
        return () => void tabs.delete(fn);
      },
    };
  };
  return () => createSwapStore({kv: createStore(kvName, "kv"), channel: channel(), win: null, now: () => T0, onSent: counting()});
}

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, {status: 204}));
});
afterEach(() => {
  setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  vi.unstubAllGlobals();
});

describe("what is sent", () => {
  it("a record counted before report ids: exactly {venue, from, to, mode} to <API>/api/v2/swap-web/sent: a keepalive text/plain POST, no credentials, no referrer, a timeout", () => {
    countSent(rec("awk1.near_intents.q.0xh", {sourceHash: "0xh"}), {page: STANDARD, demo: false, fetch: fetchMock as unknown as typeof fetch});
    expect(posts()).toHaveLength(1);
    const [url, init] = posts()[0]!;
    expect(url).toBe(`${BASE}/sent`);
    expect(JSON.parse(String(init.body))).toStrictEqual({venue: "near_intents", from: "tron:728126428", to: "eip155:8453", mode: "wallet"});
    expect(Object.keys(JSON.parse(String(init.body)) as object)).toEqual(["venue", "from", "to", "mode"]);
    expect(init).toMatchObject({method: "POST", keepalive: true, credentials: "omit", referrerPolicy: "no-referrer"});
    // A CORS-safelisted header only: no preflight, so keepalive holds as the tab closes.
    expect(init.headers).toEqual({"content-type": "text/plain;charset=UTF-8"});
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(SENT_TIMEOUT_MS).toBe(5_000);
    // The old count: no address, amount, hash or id anywhere in what goes out.
    const out = `${url} ${String(init.body)}`;
    for (const secret of ["0x8ba1", "TXYZ", "25000000", "0xh", "awk1"]) expect(out).not.toContain(secret);
  });

  it("a deposit says so; a venue or network the app doesn't list is not sent; a wallet alias is sent as the catalog's id", () => {
    expect(sentEvent(rec("d", {mode: "deposit"}))).toEqual({venue: "near_intents", from: "tron:728126428", to: "eip155:8453", mode: "deposit"});
    expect(sentEvent(rec("x", {provider: "thornode"}))).toBeNull();
    expect(sentEvent(rec("x", {provider: "toString"}))).toBeNull();
    expect(sentEvent(rec("x", {toChain: "eip155:31337"}))).toBeNull();
    expect(sentEvent(rec("x", {fromChain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"}))).toMatchObject({from: "solana:mainnet"});
  });

  it("never in Public, Custom, a build without the API, or demo mode", () => {
    const r = rec("awk1.near_intents.q.0xh", {sourceHash: "0xh"});
    const f = fetchMock as unknown as typeof fetch;
    countSent(r, {page: {mode: "public", api: API, plan: null, keys: {}}, demo: false, fetch: f});
    countSent(r, {page: {mode: "custom", api: API, plan: null, keys: {}}, demo: false, fetch: f});
    countSent(r, {page: {mode: "public", api: null, plan: null, keys: {}}, demo: false, fetch: f});
    // Demo mode: the page builds no plan at all; the flag alone stops it too.
    countSent(r, {page: {...STANDARD, plan: null}, demo: false, fetch: f});
    countSent(r, {page: STANDARD, demo: true, fetch: f});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a network error, a refusal or a throwing fetch is swallowed: nothing throws, nothing is left unhandled", async () => {
    const r = rec("awk1.near_intents.q.0xh", {sourceHash: "0xh"});
    for (const f of [
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
      vi.fn(async () => new Response('{"error":"rate limited"}', {status: 429})),
      vi.fn(() => {
        throw new TypeError("blocked");
      }),
    ]) {
      expect(() => countSent(r, {page: STANDARD, demo: false, fetch: f as unknown as typeof fetch})).not.toThrow();
      expect(f).toHaveBeenCalledOnce();
    }
    await new Promise((res) => setTimeout(res, 0));
  });
});

describe("when: once per swap, at the moment it reads as sent", () => {
  it("a wallet swap: at the broadcast — not at its first step, not when the engine hands the record over, not on a poll", () => {
    const s = createSwapStore({kv: null, channel: null, win: null, now: () => T0, onSent: counting()});
    const localId = "local.1";
    s.saveSwap({...submitting(localId), stage: "approving"});
    s.updateSwap(localId, (r) => ({...r, stage: "signing"}));
    expect(fetchMock).not.toHaveBeenCalled();
    s.updateSwap(localId, (r) => ({...r, stage: "broadcast", sourceHash: "0xh"}));
    expect(heads()).toEqual([{venue: "near_intents", from: "tron:728126428", to: "eip155:8453", mode: "wallet"}]);
    expect(s.getSwap(localId)?.counted).toBe(true);
    // The engine's id replaces the local record with a fresh one: the flag goes with it, nothing more is sent.
    s.replaceSwap(localId, {...rec("awk1.near_intents.q.0xh", {sourceHash: "0xh"}), localId});
    expect(s.getSwap("awk1.near_intents.q.0xh")?.counted).toBe(true);
    s.updateSwap("awk1.near_intents.q.0xh", (r) => applyStatus(r, "completed", [{hash: "0xd", type: "destination"}], T0));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("a stop before the broadcast never counts; a maybe-sent broadcast and a gasless order count once", () => {
    const s = createSwapStore({kv: null, channel: null, win: null, now: () => T0, onSent: counting()});
    s.saveSwap(submitting("local.declined"));
    s.updateSwap("local.declined", (r) => ({...r, status: "not-sent", error: "You declined in your wallet — nothing was sent."}));
    expect(fetchMock).not.toHaveBeenCalled();
    s.saveSwap(submitting("local.maybe"));
    s.replaceSwap("local.maybe", {...rec("awk1.near_intents.m.0xm", {sourceHash: "0xm", maybeSent: true}), localId: "local.maybe"});
    s.saveSwap(rec("awk1.omniston.o1", {provider: "omniston", fromChain: "ton:-239", toChain: "ton:-239"}));
    expect(heads()).toEqual([
      {venue: "near_intents", from: "tron:728126428", to: "eip155:8453", mode: "wallet"},
      {venue: "omniston", from: "ton:-239", to: "ton:-239", mode: "wallet"},
    ]);
  });

  it("a QR deposit: when the tracker first sees it arrive — never while it waits, never when it expires unseen", () => {
    const s = createSwapStore({kv: null, channel: null, win: null, now: () => T0, onSent: counting()});
    const id = "awk1.near_intents.dep1";
    s.saveSwap(rec(id, {mode: "deposit", accountId: "deposit:TXYZ", deposit: {address: "TDEP", memo: null, amount: "25000000", validUntilMs: T0 + 600_000}}));
    s.updateSwap(id, (r) => applyStatus(r, "pending", [], T0 + 10_000));
    expect(fetchMock).not.toHaveBeenCalled();
    // The venue sees the deposit (NEAR's KNOWN_DEPOSIT_TX / PROCESSING): still pending, counted now — not at settlement.
    s.updateSwap(id, (r) => applyStatus(r, "pending", [], T0 + 15_000, true));
    expect(heads()).toEqual([{venue: "near_intents", from: "tron:728126428", to: "eip155:8453", mode: "deposit"}]);
    s.updateSwap(id, (r) => applyStatus(r, "pending", [], T0 + 18_000, true));
    s.updateSwap(id, (r) => applyStatus(r, "completed", [{hash: "0xd", type: "destination"}], T0 + 20_000));
    s.updateSwap(id, (r) => applyStatus(r, "completed", [], T0 + 30_000));
    expect(fetchMock).toHaveBeenCalledOnce();

    // A venue that never says so: counted when its status moves on.
    const quiet = "awk1.near_intents.dep3";
    s.saveSwap(rec(quiet, {mode: "deposit"}));
    s.updateSwap(quiet, (r) => applyStatus(r, "completed", [{hash: "0xd3", type: "destination"}], T0 + 40_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const unseen = "awk1.near_intents.dep2";
    s.saveSwap(rec(unseen, {mode: "deposit"}));
    s.updateSwap(unseen, (r) => applyStatus(r, "expired", [], T0 + 900_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a record that already read as sent before the counter existed is never counted late", async () => {
    const kv = createStore(`cp0x-activity-counter-${++dbSeq}`, "kv");
    const old = rec("awk1.lifi.old.0xo", {provider: "lifi", sourceHash: "0xo"});
    await set("cp0x-swaps-v1", JSON.stringify([old]), kv);
    const s = createSwapStore({kv, channel: null, win: null, now: () => T0, onSent: counting()});
    await s.loadSwaps();
    expect(readsSent(s.getSwap(old.id)!)).toBe(true);
    s.updateSwap(old.id, (r) => applyStatus(r, "completed", [], T0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(noteSent(old, applyStatus(old, "completed", [], T0))).toEqual({record: applyStatus(old, "completed", [], T0), sent: false});
  });

  it("the runner and the app's own store: on a Standard page one POST at the broadcast, through the page's fetch", async () => {
    vi.stubGlobal("fetch", fetchMock);
    setRuntimeConfig(DEFAULT_RUNTIME_CONFIG, NO_OVERRIDES, STANDARD);
    await loadSwaps();
    let phase!: Phase;
    let finish!: (v: unknown) => void;
    exec.run = (onPhase) => {
      phase = onPhase;
      return new Promise((resolve) => {
        finish = resolve;
        onPhase("signing");
      });
    };
    const token = (over: Partial<SwapToken>): SwapToken =>
      ({key: "base:native", chain: "base", caip2: "eip155:8453", chainName: "Base", family: "evm", symbol: "ETH", catalogSymbol: "ETH", decimals: 18, contract: null, gasToken: true, amount: "1", balance: "loaded", usd: 1, owner: "0xme", payMode: "wallet", ...over}) as SwapToken;
    const input = {
      from: token({}),
      to: token({key: "arbitrum:native", chain: "arbitrum", caip2: "eip155:42161", chainName: "Arbitrum"}),
      reviewed: {provider: "relay", fromChain: "eip155:8453", fromContract: null, amountIn: 1n, destChain: "eip155:42161", destToken: "native", recipient: "0xme", refundAddress: "0xme", minOut: 1n, slippageBps: 50, approvalSpender: null, nativeFee: 0n},
      expectedOut: 1n,
      signer: {family: "evm", owner: "0xme"},
    } as unknown as StartSwapInput;
    const id = await startSwap(input);
    expect(fetchMock).not.toHaveBeenCalled();
    phase("broadcast", {hash: "0xrelay"});
    finish({id: "awk1.relay.r1.0xrelay"});
    await new Promise((res) => setTimeout(res, 0));
    expect(posts().map(([url]) => url)).toEqual([`${BASE}/sent`]);
    expect(bodies()).toEqual([
      {
        id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
        venue: "relay",
        from: "eip155:8453",
        to: "eip155:42161",
        mode: "wallet",
        tokenIn: "ETH",
        tokenOut: "ETH",
        amountIn: "0.000000000000000001",
        expectedOut: "0.000000000000000001",
        minOut: "0.000000000000000001",
        slippageBps: 50,
        sender: "0xme",
        recipient: "0xme",
      },
    ]);
    expect(getSwaps().find((r) => r.localId === id)?.statsId).toBe((bodies()[0] as {id: string}).id);
    expect(getSwaps().find((r) => r.localId === id)?.counted).toBe(true);

    // The same swap on a Public page: nothing.
    setRuntimeConfig(DEFAULT_RUNTIME_CONFIG, NO_OVERRIDES, {mode: "public", api: API, plan: null, keys: {}});
    exec.run = async (onPhase) => {
      onPhase("broadcast", {hash: "0xpublic"});
      return {id: "awk1.relay.r2.0xpublic"};
    };
    await startSwap(input);
    await new Promise((res) => setTimeout(res, 0));
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("dedupe across reloads and tabs", () => {
  it("a reload never counts a swap again: the flag is stored with the record", async () => {
    const tab = browser();
    const a = tab();
    await a.loadSwaps();
    a.saveSwap(submitting("local.r"));
    a.updateSwap("local.r", (r) => ({...r, stage: "broadcast", sourceHash: "0xh"}));
    a.replaceSwap("local.r", {...rec("awk1.near_intents.r.0xh", {sourceHash: "0xh"}), localId: "local.r"});
    await a.flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    // The page reloads: a new store reads the stored list, the tracker polls it to the end.
    const b = tab();
    await b.loadSwaps();
    expect(b.getSwap("awk1.near_intents.r.0xh")?.counted).toBe(true);
    b.updateSwap("awk1.near_intents.r.0xh", (r) => applyStatus(r, "completed", [], T0));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(parseStored(JSON.stringify([{...rec("x"), counted: true}]))[0]?.counted).toBe(true);
  });

  it("another tab hears the sent record and never counts it, nor when it polls it", async () => {
    const tab = browser();
    const a = tab();
    const b = tab();
    await Promise.all([a.loadSwaps(), b.loadSwaps()]);
    a.saveSwap(submitting("local.t"));
    a.updateSwap("local.t", (r) => ({...r, stage: "broadcast", sourceHash: "0xh"}));
    a.replaceSwap("local.t", {...rec("awk1.near_intents.t.0xh", {sourceHash: "0xh"}), localId: "local.t"});
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(b.getSwap("awk1.near_intents.t.0xh")?.counted).toBe(true);
    b.updateSwap("awk1.near_intents.t.0xh", (r) => applyStatus(r, "completed", [], T0));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("a record another tab took for interrupted and its own tab took back counts once", async () => {
    const tab = browser();
    const a = tab();
    const b = tab();
    await Promise.all([a.loadSwaps(), b.loadSwaps()]);
    a.saveSwap(submitting("local.i"));
    a.updateSwap("local.i", (r) => ({...r, stage: "broadcast", sourceHash: "0xh"}));
    expect(fetchMock).toHaveBeenCalledOnce();
    // Tab B thinks A died (no heartbeat for 30 s) and marks the record maybe-sent; A's heartbeat takes it back.
    const [interrupted] = markInterrupted([b.getSwap("local.i")!], new Set(), T0 + 31_000);
    b.saveSwap(interrupted!);
    expect(b.getSwap("local.i")).toMatchObject({status: "pending", maybeSent: true, counted: true});
    a.setRunning("local.i", true);
    a.beat("local.i");
    a.setRunning("local.i", false);
    expect(a.getSwap("local.i")).toMatchObject({status: "submitting", counted: true});
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
