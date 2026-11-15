/**
 * Swaps after Confirm: the persisted record the tracker follows, and the
 * views the activity drawer and status sheet render. `SwapRecord` is mobile
 * lib/swap/inflight.ts (756b115) plus the web fields of ui-port.md §4.6.
 */
import type {ExecutionPhase} from "./execution";

/** getSwap2Status states plus the app's own `submitting` / `not-sent` for the stretch before broadcast. */
export type SwapStatus =
  | "submitting"
  | "not-sent"
  | "pending"
  | "action-required"
  | "completed"
  | "failed"
  | "refund-pending"
  | "refunded"
  | "cancelled"
  | "expired"
  | "partial";

/**
 * The engine's execution steps (= ExecutionPhase; mobile name kept), plus `permit`: a Permit2 venue's token sale (0x,
 * D38) is asked for its one-time Permit2 signature first — the engine calls that `signing` too, but it is off-chain
 * and sends nothing (the runner tells the two apart).
 */
export type ExecStage = ExecutionPhase | "permit";

export interface SwapRecord {
  /** The swap2 id (`awk1.<provider>.<intent>[.<sourceTxHash>[.<destTxHash>[.ok]]]`), or `local.<ts>` before the engine names it. */
  id: string;
  /** The payer: `${family}:${address}` (e.g. `evm:0xabc…`), or `deposit:${refundAddress}` for QR payments. */
  accountId: string;
  provider: string;
  /** CAIP-2 + catalog slug of both sides. */
  fromChain: string;
  fromSlug: string;
  toChain: string;
  toSlug: string;
  fromSymbol: string;
  fromDecimals: number;
  toSymbol: string;
  toDecimals: number;
  /** Base units, stringified. */
  amountIn: string;
  expectedOut: string;
  minOut: string;
  recipient: string;
  sourceHash?: string;
  /** The broadcast may have reached the network but nothing confirmed it (Swap2MaybeSentError): never retry. */
  maybeSent?: boolean;
  status: SwapStatus;
  destHash?: string;
  /** Two-phase routes: the claim transaction sent on the destination chain. */
  claimHash?: string;
  /** The id to poll with once it differs from `id` (a claim answers with one). */
  trackId?: string;
  createdAt: number;
  updatedAt: number;
  /** Last status poll (ms). */
  checkedAt: number;
  /** Consecutive failed polls — backs the interval off. */
  failures: number;
  stuckReported?: boolean;
  /** While `submitting`: the engine's step. */
  stage?: ExecStage;
  /** Approvals the route needs before the swap (0 = none). */
  approvals?: number;
  /** The route signs a one-time Permit2 transfer before its approval (a Permit2 venue's token sale, D38). */
  permit?: boolean;
  approved?: boolean;
  /** Why it stopped before broadcast (`not-sent`), in the user's words (swapErrorText). */
  error?: string;
  /** The `local.…` id it was submitted under (the open sheet follows it). */
  localId?: string;
  /** Token keys — "Try again" reopens the form with them. */
  fromKey?: string;
  toKey?: string;
  // ── web additions (ui-port.md §4.6) ──
  /** "deposit" = a QR payment to a deposit address (no wallet signed). Absent = "wallet". */
  mode?: "wallet" | "deposit";
  deposit?: {address: string; memo: string | null; amount: string; validUntilMs: number};
  /**
   * A QR deposit the venue reported arriving while the swap was still `pending` (the SDK's `depositReceived`: NEAR's
   * KNOWN_DEPOSIT_TX / PROCESSING): its "Send" step is done, and the swap counter counts it then (D36). Deposits only.
   */
  depositReceived?: true;
  /** The tab executing a `submitting` record bumps this every 5 s; another tab marks it interrupted only after 30 s of silence. */
  heartbeatAt?: number;
  /**
   * The record has read as sent once (inflight readsSent: broadcast, or a QR deposit seen) and that moment was handled:
   * the swap counter (D36) fires on it only, so a reload, another tab or the tracker never counts the swap again. Set in
   * every mode, so switching to Standard later never counts an old swap.
   */
  counted?: true;
}

/** One side of a swap for newRecord (mobile inflight.ts Side). */
export interface RecordSide {
  caip2: string;
  /** Slug. */
  chain: string;
  symbol: string;
  decimals: number;
  /** Token key — kept for "Try again". */
  key?: string;
}

/** newRecord's input (mobile inflight.ts), plus the web's deposit mode. */
export interface NewRecordInput {
  id: string;
  accountId: string;
  provider: string;
  from: RecordSide;
  to: RecordSide;
  amountIn: bigint;
  expectedOut: bigint;
  minOut: bigint;
  recipient: string;
  hash?: string;
  maybeSent?: boolean;
  mode?: SwapRecord["mode"];
  deposit?: SwapRecord["deposit"];
}

export interface StatusView {
  label: string;
  tone: "progress" | "action" | "ok" | "bad" | "warn";
  detail: string;
}

export type StepState = "done" | "active" | "todo" | "failed";

export interface SwapStep {
  key: "permit" | "confirm" | "approve" | "swap" | "deliver";
  label: string;
  state: StepState;
}

/** Drawer ranking (mobile lib/txDock.ts restricted to swaps): action → failed → pending → done. */
export type ActivityUrgency = "action" | "failed" | "pending" | "done";

/** One activity-drawer row. */
export interface ActivityItem {
  record: SwapRecord;
  view: StatusView;
  urgency: ActivityUrgency;
  fromChainName: string;
  toChainName: string;
}

export interface ActivityState {
  /** Every record in this browser, drawer order: by urgency, then newest first. */
  items: readonly ActivityItem[];
  /** The most urgent item still "visible" (unfinished, or changed in the last 8 s for done) — drives the header button ring. */
  badge: ActivityItem | null;
  /** Items the header badge counts (visibleSwaps). */
  visibleCount: number;
  /** The persisted list has been read. */
  loaded: boolean;
}
