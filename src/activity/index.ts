/**
 * The activity module's public entry (contract: ActivityModule in src/contracts/modules.ts): swap records after
 * Confirm (mobile inflight.ts + the QR-deposit mode), their IndexedDB store shared across tabs, and the leader-tab
 * tracker. execute's runner writes through the store functions; screens read through `activityPort`.
 */
export {activityPort, activityState, DONE_VISIBLE_MS, urgencyOf} from "./port";
export {
  applyStatus,
  asStatus,
  depositSeen,
  duePolls,
  findSwap,
  HEARTBEAT_SILENCE_MS,
  INTERRUPTED_SENT_TEXT,
  INTERRUPTED_SIGNING_TEXT,
  INTERRUPTED_TEXT,
  isFinal,
  isLocalId,
  isUntrackedMaybeSent,
  MARKED_NOT_SENT_TEXT,
  markInterrupted,
  markNotSent,
  newRecord,
  nextPollAt,
  noteSent,
  parseStored,
  pollFailed,
  providerOfId,
  prune,
  readsSent,
  recordSide,
  statusView,
  STUCK_MS,
  swapIncident,
  swapSteps,
  upsert,
  visibleSwaps,
  wasInterrupted,
} from "./inflight";
export {getSwaps, loadSwaps, markSwapNotSent, replaceSwap, saveSwap, setRunning, updateSwap, useSwaps} from "./store";
export {pollRecord, pollSwap, useSwapTracker} from "./tracker";
export {countSent, sentEvent, SENT_TIMEOUT_MS, type SentEvent} from "./counter";
