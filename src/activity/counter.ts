/**
 * The swap reports (ARCHITECTURE D36, owner 2026-11-13; widened by D41, owner 2026-11-17, and D43, owner 2026-11-18):
 * POSTs to cp0x's swap-web proxy (`<API>/api/v2/swap-web/…`) that feed cp0x's swap statistics — a message per swap in
 * its swaps chat and a daily summary.
 * - `/sent`, once per swap this browser sends: the venue, the two networks' CAIP-2 ids, wallet | deposit, the two
 *   tokens' symbols, the amount in, expected and minimum out — exact (D43) — its value in USD by the page's prices,
 *   the slippage, the paying address (a QR deposit's: its refund address) and the recipient (D43), and a random
 *   report id (`statsId`, drawn by the store's write that counted the swap: not the swap's id, not the wallet's).
 *   No hash or time.
 * - `/done`, once it is stuck (it may still end) and once it ends: the outcome, and for a delivered swap what actually
 *   arrived (received.ts, exact), how far that is from the expected amount in bps and whether it fell under the
 *   minimum, and how long it took.
 * - `/refused`, for a route refused before signing: the SDK's check (`gate`, with its reason code — never free text)
 *   or the person declining in the wallet (`wallet`). A route refused while quoting is reported once per page.
 * - Only on a Standard page: a build with VITE_CP0X_API, the Standard mode, not demo (pageConnection's plan). Public,
 *   Custom, demo and every build without the API never send anything.
 * - Once per swap and kind: the activity store notes the moment a record first reads as sent (`counted`, with its
 *   `statsId`), then stuck or final (`reported`), in the tab whose write made it so; a reload, another tab or the
 *   tracker never reports it again (store.ts, inflight noteSent / noteOutcome).
 * - Fire-and-forget: a simple `text/plain` POST (no preflight, so `keepalive` carries it even when the tab closes right
 *   after the broadcast), no credentials, no referrer, a 5 s timeout. The answer is never read; every error is
 *   swallowed.
 */
import type {SwapRecord, SwapStatus} from "../contracts/activity";
import {chainByCaip2Web} from "../catalog";
import {DEFAULT_RUNTIME_CONFIG, isDemo, pageConnection, type PageConnection} from "../config";
import {unitsToDecimal} from "../shared/format";
import type {OutcomeReport} from "./inflight";
import {readReceived} from "./received";

/** An old record's report (counted before D41, no report id): the 2026-11-13 body. */
export interface LegacySentEvent {
  venue: string;
  from: string;
  to: string;
  mode: "wallet" | "deposit";
}

/** A swap's report: nothing else is ever sent. */
export interface SentEvent extends LegacySentEvent {
  id: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedOut: string;
  minOut: string;
  usdIn?: number;
  slippageBps?: number;
  sender?: string;
  recipient?: string;
}

export interface DoneEvent {
  id: string;
  outcome: "done" | "refunded" | "failed" | "stuck";
  actualOut?: string;
  diffBps?: number;
  belowMin?: boolean;
  durationS?: number;
}

export interface RefusedEvent {
  venue: string;
  from: string;
  to: string;
  kind: "gate" | "wallet";
  code?: string;
}

export const SENT_TIMEOUT_MS = 5_000;

/** A report id: 16 random bytes, base64url (22 characters). */
export function newStatsId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Base units → the exact decimal string (D43): 1234567890n at 6 decimals → "1234.56789". */
export const exactUnits = (value: bigint, decimals: number): string => unitsToDecimal((value > 0n ? value : 0n).toString(), decimals);

/** An address as cp0x takes it (its chain's spelling: letters, digits, `:._-`, 2–128); anything else is left out. */
export const reportAddress = (a: string): string | undefined => (/^[A-Za-z0-9:._-]{2,128}$/.test(a) ? a : undefined);

/** Who paid: the wallet of `evm:0x…`, or a QR deposit's refund address (`deposit:<refund>`). */
const payer = (r: SwapRecord): string => r.accountId.slice(r.accountId.indexOf(":") + 1);

/** A token symbol as cp0x takes it (letters, digits, `.$_+-₮`, ≤ 16): an imported token's odd symbol is trimmed. */
export const reportSymbol = (s: string): string => s.replace(/[^\p{L}\p{N}.$_+\-₮]/gu, "").slice(0, 16) || "token";

/** The page's swap-web base when reports go out: a Standard page with a plan, not demo. */
function reportBase(d: CountDeps): string | null {
  const page = d.page ?? pageConnection();
  if (page.mode !== "standard" || !page.plan || (d.demo ?? isDemo())) return null;
  return page.plan.base;
}

/** The venue and the two networks as the catalog names them; null for a venue or network this app doesn't list. */
function routeOf(venue: string, fromChain: string, toChain: string): {venue: string; from: string; to: string} | null {
  const from = chainByCaip2Web(fromChain);
  const to = chainByCaip2Web(toChain);
  if (!Object.hasOwn(DEFAULT_RUNTIME_CONFIG.providers, venue) || !from || !to) return null;
  return {venue, from: from.caip2, to: to.caip2};
}

const pick = <K extends string>(k: K, v: string | undefined): Partial<Record<K, string>> => (v === undefined ? {} : ({[k]: v} as Record<K, string>));

/** What is sent for `r`: its report, or the old count for a record from before report ids; null for an unlisted one. */
export function sentEvent(r: SwapRecord): SentEvent | LegacySentEvent | null {
  const route = routeOf(r.provider, r.fromChain, r.toChain);
  if (!route) return null;
  const base = {...route, mode: r.mode ?? "wallet"};
  if (!r.statsId) return base;
  return {
    id: r.statsId,
    ...base,
    tokenIn: reportSymbol(r.fromSymbol),
    tokenOut: reportSymbol(r.toSymbol),
    amountIn: exactUnits(BigInt(r.amountIn), r.fromDecimals),
    expectedOut: exactUnits(BigInt(r.expectedOut), r.toDecimals),
    minOut: exactUnits(BigInt(r.minOut), r.toDecimals),
    ...(r.usdIn !== undefined && r.usdIn > 0 && r.usdIn <= 1e10 ? {usdIn: r.usdIn} : {}),
    ...(r.slippageBps !== undefined ? {slippageBps: Math.round(r.slippageBps)} : {}),
    ...pick("sender", reportAddress(payer(r))),
    ...pick("recipient", reportAddress(r.recipient)),
  };
}

export interface CountDeps {
  /** Default: this page's connection. */
  page?: PageConnection;
  /** Default: isDemo(). */
  demo?: boolean;
  /** Default: the page's fetch. */
  fetch?: typeof fetch;
  /** Default: received.ts readReceived. */
  received?: (r: SwapRecord) => Promise<bigint | null>;
}

/** One fire-and-forget report. Never throws. */
function post(base: string, path: string, body: object, d: CountDeps): void {
  const init: RequestInit = {
    method: "POST",
    headers: {"content-type": "text/plain;charset=UTF-8"},
    body: JSON.stringify(body),
    keepalive: true,
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(SENT_TIMEOUT_MS),
  };
  const url = `${base}${path}`;
  void (d.fetch ? d.fetch(url, init) : globalThis.fetch(url, init)).catch(() => {});
}

/** Report `r` once it reads as sent (store.ts calls it once per record). Never throws, never waits. */
export function countSent(r: SwapRecord, d: CountDeps = {}): void {
  try {
    const base = reportBase(d);
    const event = base ? sentEvent(r) : null;
    if (base && event) post(base, "/sent", event, d);
  } catch {
    // A report is never worth an error.
  }
}

/** A final status as an outcome: delivered (a partial fill too), refunded, or not delivered. */
const OUTCOMES: Partial<Record<SwapStatus, DoneEvent["outcome"]>> = {completed: "done", partial: "done", refunded: "refunded"};

/** The outcome report for `r`: for a delivered swap, what arrived against what was expected (exact amounts). */
export async function doneEvent(r: SwapRecord, report: OutcomeReport, received: (r: SwapRecord) => Promise<bigint | null>): Promise<DoneEvent | null> {
  if (!r.statsId) return null;
  const outcome = report === "stuck" ? "stuck" : (OUTCOMES[r.status] ?? "failed");
  const event: DoneEvent = {id: r.statsId, outcome, durationS: Math.max(0, Math.round((r.updatedAt - r.createdAt) / 1000))};
  if (outcome !== "done") return event;
  const got = await received(r);
  if (got === null) return event;
  const expected = BigInt(r.expectedOut);
  const diff = expected > 0n ? Number(((got - expected) * 10_000n) / expected) : null;
  return {
    ...event,
    actualOut: exactUnits(got, r.toDecimals),
    ...(diff !== null ? {diffBps: Math.min(1_000_000, Math.max(-10_000, diff))} : {}),
    belowMin: got < BigInt(r.minOut),
  };
}

/** Report `r` stuck or ended (store.ts calls it once per record and kind). Never throws; reads the delivery first. */
export async function reportOutcome(r: SwapRecord, report: OutcomeReport, d: CountDeps = {}): Promise<void> {
  try {
    const base = reportBase(d);
    if (!base || !routeOf(r.provider, r.fromChain, r.toChain)) return;
    const event = await doneEvent(r, report, d.received ?? readReceived);
    if (event) post(base, "/done", event, d);
  } catch {
    // A report is never worth an error.
  }
}

/** Refusals already reported from this page's quote rounds: `venue|from|to|code`. */
const quoteRefusals = new Set<string>();

/** Tests only. */
export function resetQuoteRefusals(): void {
  quoteRefusals.clear();
}

/**
 * Report a route refused before signing. `once`: a quote round's refusal, reported once per page (every round would
 * repeat it). A code is kept to `[A-Za-z0-9_.:-]`, 48 at most. Never throws, never waits.
 */
export function reportRefused(
  x: {venue: string; fromChain: string; toChain: string; kind: RefusedEvent["kind"]; code?: string | null; once?: boolean},
  d: CountDeps = {},
): void {
  try {
    const base = reportBase(d);
    const route = base ? routeOf(x.venue, x.fromChain, x.toChain) : null;
    if (!base || !route) return;
    const code = x.code?.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 48) || undefined;
    if (x.once) {
      const key = `${route.venue}|${route.from}|${route.to}|${code ?? ""}`;
      if (quoteRefusals.has(key)) return;
      quoteRefusals.add(key);
    }
    post(base, "/refused", {...route, kind: x.kind, ...(code ? {code} : {})} satisfies RefusedEvent, d);
  } catch {
    // A report is never worth an error.
  }
}
