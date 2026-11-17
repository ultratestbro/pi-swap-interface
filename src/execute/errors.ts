/**
 * Errors in the user's words (mobile execute.ts swapErrorText, ui-port.md §4.10, ARCHITECTURE.md D25), and the
 * flags that decide what the runner does with a failure: `answered` (nothing was broadcast — the engine cleans up and
 * the swap is not-sent) versus maybe-sent (tracked, never retried).
 */
import {
  Swap2InFlightError,
  Swap2InsufficientGasError,
  Swap2MaybeSentError,
  Swap2ValidationError,
} from "@anywalletkit/protocol-swap2-core/errors";
import {SwapGateRefusal, SwapReviewMismatch} from "./gate";

/** The wallet rejection line (D25). One constant so the review, the record and the tests agree. */
export const WALLET_DECLINED_TEXT = "You declined in your wallet — nothing was sent.";

/** Mark an error as a definitive "nothing was broadcast" (the engine's maybeSent heuristic then stops at it). */
export function answered<E>(e: E): E {
  if (e && typeof e === "object") {
    try {
      Object.assign(e, {answered: true});
    } catch {
      // A frozen error object: nothing to add; callers wrap it with a cause instead.
    }
  }
  return e;
}

/** A definitive refusal in the user's words: an `answered` Error (nothing was sent). */
export const refusal = (message: string, cause?: unknown): Error =>
  answered(cause === undefined ? new Error(message) : new Error(message, {cause}));

/** The error and its causes, up to 6 levels (the engine's own depth). */
function causes(e: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let x = e, i = 0; x && typeof x === "object" && i < 6; x = (x as {cause?: unknown}).cause, i++) out.push(x as Record<string, unknown>);
  return out;
}

const REJECTED = /user rejected|rejected the request|user denied|denied transaction|request was rejected|user cancel|confirmation declined/i;

/**
 * The user said no in the wallet (EIP-1193 4001, viem's UserRejectedRequestError, AWK's UserRejectedError, the usual
 * texts; TronLink rejects a signature with the bare string "Confirmation declined by user").
 */
export function isWalletRejection(e: unknown): boolean {
  if (typeof e === "string") return REJECTED.test(e);
  return causes(e).some(
    (x) => x.code === 4001 || x.name === "UserRejectedRequestError" || x.name === "UserRejectedError" || (typeof x.message === "string" && REJECTED.test(x.message)),
  );
}

/** The SDK account's fee cap refused the write (Solana transactionMaxFee / transferMaxFee) — mobile isFeeCapRefusal. */
export function isFeeCapRefusal(e: unknown): boolean {
  return causes(e).some(
    (x) =>
      x.policy === "maxFee" ||
      x.name === "FeeLimitExceededError" ||
      x.code === "fee-limit-exceeded" ||
      (typeof x.message === "string" && x.message.startsWith("Exceeded maximum fee cost")),
  );
}

/** First line of the message (mobile send/transfer shortError). */
function shortError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0]!.trim() || "Unknown error";
}

/** One line for a failed swap or claim, in the order D25 fixes (then the engine's own refusals). Nothing here carries a secret. */
export function swapErrorText(e: unknown, nativeSymbol: string): string {
  const msg = shortError(e).replace(/^swap2?: /, "");
  if (e instanceof SwapReviewMismatch)
    return `The live route isn't the one you reviewed (${e.message}) — nothing was signed. Review it again.`;
  if (isFeeCapRefusal(e)) return "The network fee rose above the cap — nothing more was signed. Try again in a moment.";
  if (e instanceof SwapGateRefusal) return e.message;
  if (isWalletRejection(e)) return WALLET_DECLINED_TEXT;
  // A source leg comes back as Swap2MaybeSentError; a claim's broadcast as the chain package's BroadcastUnknownError.
  if (e instanceof Swap2MaybeSentError || causes(e).some((x) => x.maybeSent === true))
    return "The network didn't confirm it got the transaction — it may still go through. Check Activity before trying again.";
  if (e instanceof Swap2InsufficientGasError) return `Not enough ${nativeSymbol} to pay the network fees — nothing was sent.`;
  // The node's own refusal of a send the balance can't cover (amount + a bridge fee on top + gas), viem's text.
  if (/exceeds the balance of the account|insufficient funds/i.test(msg))
    return `Not enough ${nativeSymbol} for the amount, the bridge fee and the network fee — nothing was sent.`;
  if (e instanceof Swap2InFlightError) return "This swap is already running — wait for its result.";
  // A live minimum under the reviewed one comes back as "no route available :: <venue>: floor breach …" — it's the price.
  if (/minAmountOut|below the (requested|caller)|floor/i.test(msg)) return "The price moved below your minimum — nothing was swapped. Review it again.";
  if (/no route available/i.test(msg)) {
    const detail = msg.split(" :: ")[1];
    return `The route is no longer available${detail ? ` (${detail.slice(0, 160)})` : ""}. Refresh and pick a route again.`;
  }
  if (/quote expired/i.test(msg)) return "The quote expired before signing — nothing was swapped. Review it again.";
  // An imported token (D39) whose decimals on-chain differ from the ones read when it was imported.
  if (/fromTokenDecimals \d+ does not match|destDecimals \d+ do not match toTokenDecimals/.test(msg))
    return "This token's decimals on-chain don't match the ones read when it was imported — nothing was signed. Remove it and import it again.";
  // The engine's own refusals: a payload it would not sign, or a wallet on another network than the swap's.
  if (e instanceof Swap2ValidationError) return `This route was refused for safety (${msg.slice(0, 160)}) — nothing was signed.`;
  if (/account is bound to .*, but fromChain is|claim is on .*, but the account is bound to/i.test(msg))
    return "Your wallet is on another network than this swap — nothing was sent. Switch it back and try again.";
  return msg || "The swap failed.";
}

/** A failure that is an answer, not an incident: no route, an expired quote, a price move, no gas, already running, a rejection. */
export function swapFailureExpected(e: unknown): boolean {
  if (isFeeCapRefusal(e) || isWalletRejection(e) || e instanceof Swap2InsufficientGasError || e instanceof Swap2InFlightError) return true;
  if (e instanceof SwapReviewMismatch || e instanceof SwapGateRefusal) return false;
  return /no route available|quote expired|minAmountOut|below the (requested|caller)|floor|exceeds the balance of the account|insufficient funds/i.test(shortError(e));
}

/** Swap2MaybeSentError: the source broadcast may be on its way — never retry; track its id / hash (mobile, verbatim). */
export function maybeSent(e: unknown): {id?: string; hash?: string} | null {
  if (!(e instanceof Swap2MaybeSentError)) return null;
  return {...(e.id ? {id: e.id} : {}), ...(e.hash ? {hash: e.hash} : {})};
}
