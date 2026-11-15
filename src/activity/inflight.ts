/**
 * Swaps after Confirm: what the browser persists (activity/store, IndexedDB) so delivery is followed across
 * reloads, how a status reads, and when to ask again — mobile lib/swap/inflight.ts (756b115) with the web texts of
 * ui-port.md §4.12, the QR-deposit mode of §4.6 and the multi-tab heartbeat rule of D16. Public data only — ids,
 * hashes, amounts, own addresses. No React — unit-tested in tests/unit/activity/inflight.test.ts.
 */
import type {ExecStage, NewRecordInput, StatusView, SwapRecord, SwapStatus, SwapStep} from "../contracts/activity";

const FINAL = new Set<SwapStatus>(["not-sent", "completed", "failed", "refunded", "cancelled", "expired", "partial"]);

/** No more status will come: the tracker stops polling it. */
export const isFinal = (s: SwapStatus): boolean => FINAL.has(s);

const STAGE_LABEL: Record<ExecStage, (symbol: string) => string> = {
  permit: () => "Signing the Permit2 transfer",
  approving: (s) => `Approving ${s}`,
  requoting: () => "Refreshing the quote",
  preflight: () => "Checking the route",
  signing: () => "Signing the swap",
  broadcast: () => "Sending the swap",
};

/** "12:05" from milliseconds (deposit countdowns). */
const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** How a record reads in the drawer and the status sheet. `now` only moves a QR deposit's countdown. */
export function statusView(
  r: Pick<SwapRecord, "status" | "toSymbol" | "maybeSent"> &
    Partial<Pick<SwapRecord, "id" | "stage" | "fromSymbol" | "error" | "approved" | "provider" | "mode" | "deposit" | "sourceHash">>,
  toChainName: string,
  now: number = Date.now(),
): StatusView {
  switch (r.status) {
    case "submitting":
      return {
        label: r.stage ? STAGE_LABEL[r.stage](r.fromSymbol ?? "") : "Starting",
        tone: "progress",
        detail: "Keep this tab open until the swap is sent.",
      };
    case "not-sent":
      return {
        label: "Not swapped",
        tone: "bad",
        detail: `${r.error ?? "The swap stopped before it was sent."}${r.approved ? " Your wallet asked to remove the approval it made; if you declined, it is still active." : ""}`,
      };
    case "pending":
      if (r.mode === "deposit" && !r.sourceHash) {
        const left = (r.deposit?.validUntilMs ?? 0) - now;
        return left > 0
          ? {label: "Waiting for your deposit", tone: "action", detail: `Send exactly the amount to the address. It expires in ${mmss(left)}.`}
          : {
              label: "Watching for your deposit",
              tone: "progress",
              detail: "The deposit address has expired. If you sent the deposit in time it is on its way — don't send again. If you sent nothing, start a new swap for a new address.",
            };
      }
      // Only a record with the engine's id is polled. A `local.` one (no intent id: a lost wallet answer, a tab that
      // closed mid-signing) never updates by itself, so it must not say it does.
      if (r.maybeSent && r.id !== undefined && isLocalId(r.id))
        return r.sourceHash
          ? {label: "Sent — not tracked", tone: "warn", detail: r.error ?? UNTRACKED_SENT_TEXT}
          : {label: "Check your wallet", tone: "warn", detail: r.error ?? UNTRACKED_MAYBE_TEXT};
      return r.maybeSent
        ? {
            label: "Checking",
            tone: "warn",
            detail: "The swap may have been sent — the network didn't confirm the broadcast. Don't retry; this updates on its own.",
          }
        : {
            label: "In progress",
            tone: "progress",
            detail: `Delivering ${r.toSymbol} on ${toChainName}. You can close this tab — tracking picks up when you come back.`,
          };
    case "action-required":
      return {
        label: "Claim needed",
        tone: "action",
        detail: `The transfer is attested. Claim your ${r.toSymbol} on ${toChainName} to finish — it costs a little gas there.`,
      };
    case "completed":
      return {label: "Completed", tone: "ok", detail: `${r.toSymbol} arrived on ${toChainName}.`};
    case "refund-pending":
      return {
        label: "Refunding",
        tone: "warn",
        detail:
          r.provider === "symbiosis"
            ? "The route got stuck — Symbiosis reverts it itself, usually within an hour."
            : r.provider === "relay"
              ? "The order wasn't filled — Relay refunds it on its own. If this stays, contact Relay with the deposit's hash."
              : "The route couldn't complete — your funds are on their way back.",
      };
    case "refunded":
      return {
        label: "Refunded",
        tone: "warn",
        detail:
          r.provider === "symbiosis"
            ? "The route couldn't complete — the token that crossed the bridge was returned on the source chain, less the bridge fee."
            : r.mode === "deposit"
              ? "The route couldn't complete — your funds were returned to the refund address."
              : "The route couldn't complete — your funds were returned to the paying address.",
      };
    case "partial":
      return {
        label: "Partly filled",
        tone: "warn",
        detail:
          r.provider === "symbiosis"
            ? `The last swap didn't go through — you got the bridged token on ${toChainName} instead of ${r.toSymbol}.`
            : "Only part of the swap was delivered; the rest was refunded.",
      };
    case "expired":
      return {label: "Expired", tone: "bad", detail: "The route expired before the deposit was seen."};
    case "cancelled":
      return {label: "Cancelled", tone: "bad", detail: "The provider cancelled the swap."};
    case "failed":
      return {label: "Failed", tone: "bad", detail: "The swap failed. If funds left your wallet, the provider refunds them."};
  }
}

const KNOWN = new Set<string>([
  "submitting",
  "not-sent",
  "pending",
  "action-required",
  "completed",
  "failed",
  "refund-pending",
  "refunded",
  "cancelled",
  "expired",
  "partial",
]);

/** A stored or polled status string; anything unknown reads as pending (keeps polling). */
export const asStatus = (v: unknown): SwapStatus => (typeof v === "string" && KNOWN.has(v) ? (v as SwapStatus) : "pending");

/**
 * When to poll a swap next (ms since epoch), or null when it is done. Fresh swaps every 10 s, after 10 minutes
 * every 30 s, after 2 hours every 2 minutes; failures back off up to 5 minutes. A claim waiting for the user is
 * rechecked slowly (the attestation is there; the user acts).
 */
export function nextPollAt(r: Pick<SwapRecord, "status" | "createdAt" | "checkedAt" | "failures">, now = Date.now()): number | null {
  if (isFinal(r.status)) return null;
  const age = now - r.createdAt;
  let every = age < 10 * 60_000 ? 10_000 : age < 2 * 3600_000 ? 30_000 : 120_000;
  if (r.status === "action-required") every = Math.max(every, 60_000);
  if (r.failures > 0) every = Math.min(300_000, every * 2 ** Math.min(r.failures, 5));
  return r.checkedAt + every;
}

/** The records due for a poll now (never a `local.` id or one still being submitted). */
export const duePolls = (list: readonly SwapRecord[], now = Date.now()): SwapRecord[] =>
  list.filter((r) => {
    if (isLocalId(r.id) || r.status === "submitting") return false;
    const at = nextPollAt(r, now);
    return at !== null && at <= now;
  });

/** A status poll's answer folded into the record. */
export function applyStatus(
  r: SwapRecord,
  status: SwapStatus,
  txs: readonly {hash: string; type?: string}[] = [],
  now = Date.now(),
  depositReceived = false,
): SwapRecord {
  const dest = txs.find((t) => t.type === "destination")?.hash;
  return {
    ...r,
    status,
    ...(dest ? {destHash: dest} : {}),
    // Kept once seen (the spread): a later poll that no longer says so doesn't take the "Send" step back.
    ...(depositReceived && r.mode === "deposit" ? {depositReceived: true as const} : {}),
    maybeSent: status === "pending" ? r.maybeSent : false,
    checkedAt: now,
    updatedAt: status !== r.status ? now : r.updatedAt,
    failures: 0,
  };
}

/** A failed poll: counted, so the interval backs off. */
export const pollFailed = (r: SwapRecord, now = Date.now()): SwapRecord => ({...r, checkedAt: now, failures: r.failures + 1});

/** Past this, an unfinished swap is worth a look (every venue routed here delivers well within it). */
export const STUCK_MS = 45 * 60_000;

/** What deserves a console note after a poll: a swap that just ended badly, or one still undelivered past STUCK_MS (once). */
export function swapIncident(prev: SwapRecord, next: SwapRecord, now = Date.now()): "ended" | "stuck" | null {
  if (next.status !== prev.status && ["failed", "refunded", "partial", "expired"].includes(next.status)) return "ended";
  // A claim waiting for the user isn't stuck on the network; neither is a deposit nobody sent.
  if (
    !isFinal(next.status) &&
    next.status !== "action-required" &&
    !(next.mode === "deposit" && !next.sourceHash) &&
    !next.stuckReported &&
    now - next.createdAt > STUCK_MS
  )
    return "stuck";
  return null;
}

/** Newest first; the same id replaces. */
export function upsert(list: readonly SwapRecord[], r: SwapRecord): SwapRecord[] {
  return [r, ...list.filter((x) => x.id !== r.id)].sort((a, b) => b.createdAt - a.createdAt);
}

/** Keep every unfinished swap; finished ones for a week, at most 50 records in all. */
export function prune(list: readonly SwapRecord[], now = Date.now()): SwapRecord[] {
  const week = 7 * 86_400_000;
  return list.filter((r) => !isFinal(r.status) || now - r.updatedAt < week).slice(0, 50);
}

const s = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const n = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const digits = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? v : "0");

function parseDeposit(v: unknown): SwapRecord["deposit"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const d = v as Record<string, unknown>;
  if (!s(d.address) || !n(d.validUntilMs)) return undefined;
  return {address: d.address, memo: s(d.memo) ? d.memo : null, amount: digits(d.amount), validUntilMs: d.validUntilMs};
}

/** The stored list, read defensively: a malformed entry is dropped, not a crash on load. The one parser (D16). */
export function parseStored(raw: string | null | undefined): SwapRecord[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: SwapRecord[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") continue;
    const t = v as Record<string, unknown>;
    if (!s(t.id) || !s(t.accountId) || !s(t.fromChain) || !s(t.toChain) || !n(t.createdAt)) continue;
    const deposit = parseDeposit(t.deposit);
    out.push({
      id: t.id,
      accountId: t.accountId,
      provider: s(t.provider) ? t.provider : "",
      fromChain: t.fromChain,
      fromSlug: s(t.fromSlug) ? t.fromSlug : "",
      toChain: t.toChain,
      toSlug: s(t.toSlug) ? t.toSlug : "",
      fromSymbol: s(t.fromSymbol) ? t.fromSymbol : "",
      fromDecimals: n(t.fromDecimals) ? t.fromDecimals : 18,
      toSymbol: s(t.toSymbol) ? t.toSymbol : "",
      toDecimals: n(t.toDecimals) ? t.toDecimals : 18,
      amountIn: digits(t.amountIn),
      expectedOut: digits(t.expectedOut),
      minOut: digits(t.minOut),
      recipient: s(t.recipient) ? t.recipient : "",
      ...(s(t.sourceHash) ? {sourceHash: t.sourceHash} : {}),
      ...(t.maybeSent === true ? {maybeSent: true} : {}),
      status: asStatus(t.status),
      ...(s(t.destHash) ? {destHash: t.destHash} : {}),
      ...(s(t.claimHash) ? {claimHash: t.claimHash} : {}),
      ...(s(t.trackId) ? {trackId: t.trackId} : {}),
      createdAt: t.createdAt,
      updatedAt: n(t.updatedAt) ? t.updatedAt : t.createdAt,
      checkedAt: n(t.checkedAt) ? t.checkedAt : 0,
      failures: n(t.failures) ? t.failures : 0,
      ...(t.stuckReported === true ? {stuckReported: true} : {}),
      ...(typeof t.stage === "string" && t.stage in STAGE_LABEL ? {stage: t.stage as ExecStage} : {}),
      ...(n(t.approvals) ? {approvals: t.approvals} : {}),
      ...(t.permit === true ? {permit: true} : {}),
      ...(t.approved === true ? {approved: true} : {}),
      ...(s(t.error) ? {error: t.error} : {}),
      ...(s(t.localId) ? {localId: t.localId} : {}),
      ...(s(t.fromKey) ? {fromKey: t.fromKey} : {}),
      ...(s(t.toKey) ? {toKey: t.toKey} : {}),
      ...(t.mode === "deposit" || t.mode === "wallet" ? {mode: t.mode} : {}),
      ...(deposit ? {deposit} : {}),
      ...(t.depositReceived === true ? {depositReceived: true} : {}),
      ...(n(t.heartbeatAt) ? {heartbeatAt: t.heartbeatAt} : {}),
      ...(t.counted === true ? {counted: true} : {}),
    });
  }
  return out;
}

const decoded = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/**
 * The record an id names: its id, the `local.` id it was submitted under, or the claim's polling id. Swap ids carry
 * percent-encoded segments and a router may hand them back decoded — either spelling matches.
 */
export function findSwap(list: readonly SwapRecord[], id: string | undefined): SwapRecord | undefined {
  if (!id) return undefined;
  return (
    list.find((r) => r.id === id || r.localId === id) ??
    list.find((r) => r.trackId === id) ??
    list.find((r) => decoded(r.id) === decoded(id))
  );
}

/** The swap2 id's provider segment (`awk1.<provider>.…`). */
export function providerOfId(id: string): string {
  const seg = id.split(".")[1];
  try {
    return seg ? decodeURIComponent(seg) : "";
  } catch {
    return "";
  }
}

/** What the header badge counts: unfinished swaps plus anything changed in the last 10 minutes — every payer in this browser. */
export const visibleSwaps = (list: readonly SwapRecord[], now = Date.now()): SwapRecord[] =>
  list.filter((r) => !isFinal(r.status) || now - r.updatedAt < 10 * 60_000);

/** The record a broadcast (or maybe-broadcast, or a QR deposit) starts tracking with; the first poll comes one interval later. */
export function newRecord(x: NewRecordInput, now = Date.now()): SwapRecord {
  return {
    id: x.id,
    accountId: x.accountId,
    provider: x.provider,
    fromChain: x.from.caip2,
    fromSlug: x.from.chain,
    toChain: x.to.caip2,
    toSlug: x.to.chain,
    fromSymbol: x.from.symbol,
    fromDecimals: x.from.decimals,
    toSymbol: x.to.symbol,
    toDecimals: x.to.decimals,
    amountIn: x.amountIn.toString(),
    expectedOut: x.expectedOut.toString(),
    minOut: x.minOut.toString(),
    recipient: x.recipient,
    ...(x.hash ? {sourceHash: x.hash} : {}),
    ...(x.maybeSent ? {maybeSent: true} : {}),
    ...(x.from.key ? {fromKey: x.from.key} : {}),
    ...(x.to.key ? {toKey: x.to.key} : {}),
    ...(x.mode ? {mode: x.mode} : {}),
    ...(x.deposit ? {deposit: x.deposit} : {}),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    checkedAt: now,
    failures: 0,
  };
}

const amountText = (units: string, decimals: number) => {
  const v = units.replace(/^0+(?=\d)/, "").padStart(decimals + 1, "0");
  const int = v.slice(0, v.length - decimals);
  const frac = decimals ? v.slice(v.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${int}.${frac}` : int;
};

/**
 * The progress sheet's steps: (Permit2 signature) → (approve) → the wallet's confirmation → swap → delivery. The
 * approve step shows only when the route needs one, the permit step only for a Permit2 venue's token sale (D38: its
 * one-time signature comes before the approval, which a standing Permit2 allowance spares); a stop before broadcast
 * fails the step it stopped on; a claim waiting for the user is the delivery step, active. A QR deposit: address
 * issued → send the amount → delivery.
 */
export function swapSteps(r: SwapRecord, toChainName: string): SwapStep[] {
  const delivered = r.status === "completed" || r.status === "partial";
  const bad = r.status === "failed" || r.status === "refunded" || r.status === "expired" || r.status === "cancelled";
  const deliver = (sent: boolean): SwapStep => ({
    key: "deliver",
    label: `${r.status === "action-required" ? "Claim" : "Deliver"} ${r.toSymbol} on ${toChainName}`,
    state: delivered ? "done" : bad ? "failed" : sent ? "active" : "todo",
  });
  if (r.mode === "deposit") {
    const seen = depositSeen(r);
    return [
      {key: "confirm", label: "Deposit address issued", state: "done"},
      {
        key: "swap",
        label: `Send ${amountText(r.deposit?.amount ?? r.amountIn, r.fromDecimals)} ${r.fromSymbol}`,
        state: seen ? "done" : r.status === "expired" ? "failed" : "active",
      },
      deliver(seen),
    ];
  }
  // A maybe-sent swap without a hash: nobody knows yet whether the swap step happened.
  const unsure = r.status === "pending" && r.maybeSent === true && !r.sourceHash;
  const sent = r.status !== "submitting" && r.status !== "not-sent" && !unsure;
  const stopped = r.status === "not-sent";
  const approving = r.status === "submitting" && r.stage === "approving";
  // The wallet holds the Permit2 signature (the first, or a re-quote's new one): no approval or swap prompt yet.
  const atPermit = r.stage === "permit";
  const permitting = r.status === "submitting" && atPermit;
  const pastApproval = sent || unsure || r.approved === true || (!!r.stage && r.stage !== "approving" && !atPermit);
  // web (owner, 2026-11-13): the confirmation step is the wallet's, green only once the wallet signed the swap (its
  // broadcast) — a done "You confirmed the review" first read as already confirmed while the wallet's prompt was open.
  const signed = sent || (r.status === "submitting" && r.stage === "broadcast");
  const steps: SwapStep[] = [];
  if (r.permit) {
    const permitted = sent || unsure || (!!r.stage && !atPermit);
    steps.push({
      key: "permit",
      label: permitted ? "You signed the Permit2 transfer" : "Sign the Permit2 transfer",
      state: permitted ? "done" : stopped ? "failed" : permitting ? "active" : "todo",
    });
  }
  if ((r.approvals ?? 0) > 0) {
    // Past the permit with no approval sent: a standing Permit2 allowance already covered the input (the engine leaves it).
    const covered = r.permit === true && !sent && !unsure && !r.approved && !!r.stage && r.stage !== "approving" && !atPermit;
    steps.push({
      key: "approve",
      label: covered ? `${r.fromSymbol} already approved for Permit2` : `Approve ${r.fromSymbol}`,
      // A stop at the permit never reached the approval.
      state: pastApproval ? "done" : stopped ? (atPermit ? "todo" : "failed") : approving ? "active" : "todo",
    });
  }
  steps.push({
    key: "confirm",
    label: signed ? "You confirmed the transaction" : "Confirm the transaction",
    state: signed ? "done" : stopped ? (!atPermit && (pastApproval || !(r.approvals ?? 0)) ? "failed" : "todo") : unsure || (pastApproval && !approving && !permitting) ? "active" : "todo",
  });
  steps.push({key: "swap", label: `Swap ${r.fromSymbol} → ${r.toSymbol}`, state: sent ? "done" : signed ? "active" : "todo"});
  steps.push(deliver(sent));
  return steps;
}

/** The not-sent reason markInterrupted writes — the executing tab's heartbeat recognises it and takes the record back. */
export const INTERRUPTED_TEXT = "The tab closed before the swap was sent — nothing was swapped.";

/**
 * A tab that closed while the wallet was asked to sign the swap. On the web the wallet is another program (an
 * extension, a phone over WalletConnect) that still holds the request and may broadcast after the tab is gone.
 */
export const INTERRUPTED_SIGNING_TEXT =
  "The tab closed while your wallet was asked to sign the swap — it may still have been sent. This browser can't follow it: check your wallet's activity before trying again.";

/** A tab that closed after the wallet returned the swap's hash (the engine was still notifying the venue). */
export const INTERRUPTED_SENT_TEXT =
  "The tab closed just after the swap was sent — it is on its way, but this browser can't follow its delivery. Check the source transaction before trying anything again.";

/** A maybe-sent swap this browser can't poll (a `local.` id), with a hash: sent, but delivery isn't followed here. */
export const UNTRACKED_SENT_TEXT =
  "The swap was sent, but this browser can't follow its delivery. Check the source transaction on the explorer — don't swap these funds again.";

/** A maybe-sent swap this browser can't poll, without a hash: only the wallet knows whether it went out. */
export const UNTRACKED_MAYBE_TEXT =
  "The swap may have been sent — your wallet didn't answer in time. This browser can't check it: look at your wallet's activity before trying again.";

/** What markNotSent writes: the viewer checked their wallet and saw no swap. */
export const MARKED_NOT_SENT_TEXT = "You checked your wallet and marked this swap as not sent.";

/** A `submitting` record's tab is gone once it has been silent this long (D16: the executing tab beats every 5 s). */
export const HEARTBEAT_SILENCE_MS = 30_000;

/** Stages at which the wallet may already hold (or have broadcast) the swap itself. */
const SWAP_PROMPTED = new Set<ExecStage>(["signing", "broadcast"]);

/**
 * Records left `submitting` by a tab that is gone. Before the swap's own prompt (a Permit2 signature, approving,
 * re-quoting, preflight) nothing was swapped: `not-sent`, with a note on an approval that may be live. A permit is
 * off-chain and only this tab could have spent it, so a wallet that signs it after the tab is gone sends nothing. From
 * `signing` on the wallet may have broadcast without the tab (D25): `pending` + `maybeSent`, never `not-sent`, so it is
 * never offered again. `running` holds the ids this tab is executing; a record another tab still executes keeps beating
 * (heartbeatAt) and is left alone.
 */
export function markInterrupted(list: readonly SwapRecord[], running: ReadonlySet<string>, now = Date.now()): SwapRecord[] {
  return list.map((r) => {
    if (r.status !== "submitting" || running.has(r.id) || (r.heartbeatAt ?? r.updatedAt) >= now - HEARTBEAT_SILENCE_MS) return r;
    if (r.stage && SWAP_PROMPTED.has(r.stage)) {
      const sent = r.stage === "broadcast" && !!r.sourceHash;
      return {...r, status: "pending", maybeSent: true, error: sent ? INTERRUPTED_SENT_TEXT : INTERRUPTED_SIGNING_TEXT, updatedAt: now};
    }
    const approval =
      r.stage === "approving" && !r.approved
        ? ` Your wallet may still send the ${r.fromSymbol} approval it was asked for — check its activity.`
        : r.approved
          ? ` The ${r.fromSymbol} approval may still be active.`
          : "";
    return {...r, status: "not-sent", error: `${INTERRUPTED_TEXT}${approval}`, approved: false, updatedAt: now};
  });
}

/** A record markInterrupted wrote (the executing tab takes such a record back on its next heartbeat). */
export function wasInterrupted(r: SwapRecord): boolean {
  if (r.status === "not-sent") return !!r.error?.startsWith(INTERRUPTED_TEXT);
  return r.status === "pending" && (r.error === INTERRUPTED_SIGNING_TEXT || r.error === INTERRUPTED_SENT_TEXT);
}

/** A maybe-sent record this browser can't poll: only the viewer can settle it (markNotSent), after checking the wallet. */
export const isUntrackedMaybeSent = (r: Pick<SwapRecord, "id" | "status" | "maybeSent">): boolean =>
  r.status === "pending" && r.maybeSent === true && isLocalId(r.id);

/** The viewer's answer for an untracked maybe-sent record: their wallet shows no swap. Anything else is left as it is. */
export function markNotSent(r: SwapRecord, now = Date.now()): SwapRecord {
  if (!isUntrackedMaybeSent(r)) return r;
  return {...r, status: "not-sent", maybeSent: false, error: MARKED_NOT_SENT_TEXT, updatedAt: now};
}

/** A swap id for a broadcast the engine couldn't name (maybe-sent without one) or one not submitted yet: never polled remotely. */
export const isLocalId = (id: string): boolean => id.startsWith("local.");

/**
 * A QR deposit the venue has seen arrive: it said so while still waiting (`depositReceived`), its status moved on from
 * waiting, or a delivery hash came — other than to `expired` — the moment its "Send" step is done.
 */
export const depositSeen = (r: Pick<SwapRecord, "status" | "destHash" | "depositReceived">): boolean =>
  (r.status !== "pending" || !!r.destHash || r.depositReceived === true) && r.status !== "expired";

/**
 * The swap is out: a wallet swap once the wallet broadcast it — its source hash is on the record, or it left
 * `submitting` for a tracked state (a signed order, a maybe-sent broadcast), the moment the review becomes its status
 * (D34, afterConfirm) — and a QR deposit once it was seen (depositSeen). A record another tab marked interrupted is
 * not: its own tab takes it back, or nobody knows.
 */
export function readsSent(r: SwapRecord): boolean {
  if (r.mode === "deposit") return depositSeen(r);
  if (r.status === "not-sent" || wasInterrupted(r)) return false;
  return r.status !== "submitting" || !!r.sourceHash;
}

/**
 * `next` as the store keeps it after `prev` (the record it replaces, if any): `counted` carried over (a replace builds
 * a fresh record), or set when this very write makes the record read as sent — then `sent` is true, once per swap
 * (D36). A record that already read as sent before (one from before the flag existed) is never counted late.
 */
export function noteSent(prev: SwapRecord | undefined, next: SwapRecord): {record: SwapRecord; sent: boolean} {
  if (next.counted) return {record: next, sent: false};
  if (prev?.counted) return {record: {...next, counted: true}, sent: false};
  if (!readsSent(next) || (prev && readsSent(prev))) return {record: next, sent: false};
  return {record: {...next, counted: true}, sent: true};
}
