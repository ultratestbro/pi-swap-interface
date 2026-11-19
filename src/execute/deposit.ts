/**
 * "Get deposit address" for a payer whose chain has no wallet connector here (BTC, ZEC, …), or whose wallet isn't
 * connected where a QR payment is the fallback (Tron, TON, NEAR): engine.md §9, ARCHITECTURE.md D20. Nothing is signed
 * — the payer sends from any wallet — so there is no gate; what protects the user is that the live (non-dry) quote is
 * held to the review before its address is shown: one provider, the reviewed amount and floor, no transaction to
 * sign, no memo, a deposit address valid on the paying chain, a refund address of that chain. The record (mode
 * "deposit") is saved before the ticket is returned, so the tracker follows it even if the sheet closes.
 */
import type {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import {Swap2QuoteError} from "@anywalletkit/protocol-swap2-core/errors";
import type {DepositTicket, IssueDepositInput} from "../contracts/execution";
import {newRecord, recordSide, saveSwap} from "../activity";
import {isAddressFor, QR_FALLBACK_FAMILIES, SIGNING_FAMILIES} from "../catalog";
import {appRouter, quoteParams} from "../swap";
import {usdOf} from "../swap/amount";
import {refusal} from "./errors";
import {same, SwapReviewMismatch} from "./gate";
import {encodeSwapId} from "./ids";

/** What issueDeposit reaches that tests replace. */
export interface DepositDeps {
  /** The one-provider router; default `appRouter().only(provider)`. */
  router?: (provider: string) => CrossChainRouter;
  now?: () => number;
}

/** A live deposit address held to the reviewed route, saved as a tracked record before it is returned. */
export async function issueDeposit(input: IssueDepositInput, deps: DepositDeps = {}): Promise<DepositTicket> {
  const {req, provider, routeId, minOut} = input;
  const {from, to} = req;
  const now = deps.now ?? Date.now;
  // Preview prices (D7) carry no addresses of the user's: never a deposit address. The type already forbids it.
  if ((req as {preview?: unknown}).preview !== undefined) throw refusal("Enter your refund address first — preview prices can't get a deposit address.");
  // Tron, TON and NEAR keep the QR while no wallet of theirs is connected (QR_FALLBACK_FAMILIES); EVM and
  // Solana always sign.
  if (SIGNING_FAMILIES.has(from.family) && !QR_FALLBACK_FAMILIES.has(from.family))
    throw refusal(`Pay from your ${from.chainName} wallet instead — deposit addresses are for networks without a wallet here.`);
  if (!isAddressFor(from.family, req.refundAddress)) throw refusal(`Enter a valid ${from.chainName} refund address — nothing was requested.`);
  if (!isAddressFor(to.family, req.recipient)) throw refusal(`Enter a valid ${to.chainName} address to receive on — nothing was requested.`);
  if (req.amountIn <= 0n) throw refusal("Enter an amount first.");
  if (minOut <= 0n) throw new SwapReviewMismatch("the review has no minimum to hold the route to");

  const router = deps.router ? deps.router(provider) : appRouter().only(provider);
  // The reviewed route of a venue with several (D47), asked by its routeId: never the venue's default in its place.
  const params = {...quoteParams(req), dry: false, minAmountOut: minOut.toString(), ...(routeId !== undefined ? {routeId} : {})};
  const set = await router.getQuotes(params, {requireImmediateExecution: true});
  const q = set?.quotes.find((x) => x.provider === provider && x.routeId === routeId) ?? null;
  if (!q) {
    const detail = router.lastRejections.join("; ");
    throw new Swap2QuoteError(`swap2: no route available for the requested pair${detail ? ` :: ${detail}` : ""}`);
  }

  const mismatch = (why: string) => new SwapReviewMismatch(why);
  if (q.txRequest !== undefined) throw mismatch("this route needs a wallet that signs on the paying network");
  if (q.depositMemo !== null && q.depositMemo !== "") throw mismatch("this route needs a memo a QR payment can't carry");
  if (!q.depositAddress || !isAddressFor(from.family, q.depositAddress)) throw mismatch(`the deposit address isn't a ${from.chainName} address`);
  if (same(q.depositAddress, req.refundAddress)) throw mismatch("the deposit address is your own refund address");
  let sourceAmount: bigint;
  let destAmount: bigint;
  let minDestAmount: bigint;
  try {
    sourceAmount = BigInt(q.sourceAmount);
    destAmount = BigInt(q.destAmount);
    minDestAmount = BigInt(q.minDestAmount);
  } catch {
    throw mismatch("the quote's amounts are malformed");
  }
  if (sourceAmount !== req.amountIn) throw mismatch("the amount changed");
  if (minDestAmount < minOut) throw mismatch("the guaranteed output dropped below what you reviewed");
  if (!(q.validUntilMs > now())) throw mismatch("the deposit address expired before it was shown");

  const id = encodeSwapId(q.provider, q.intentId);
  const ticket: DepositTicket = {
    id,
    provider: q.provider,
    intentId: q.intentId,
    depositAddress: q.depositAddress,
    depositMemo: null,
    sourceAmount,
    destAmount,
    minDestAmount,
    validUntilMs: q.validUntilMs,
    etaSeconds: q.etaSeconds ?? 0,
  };
  saveSwap(
    newRecord(
      {
        id,
        accountId: `deposit:${req.refundAddress}`,
        provider: q.provider,
        ...(routeId !== undefined ? {routeId} : {}),
        from: recordSide(from),
        to: recordSide(to),
        amountIn: sourceAmount,
        expectedOut: destAmount,
        minOut,
        recipient: req.recipient,
        mode: "deposit",
        deposit: {address: q.depositAddress, memo: null, amount: sourceAmount.toString(), validUntilMs: q.validUntilMs},
        // For the swap report (D41).
        ...(usdOf(sourceAmount, from.decimals, from.priceUsd) !== undefined ? {usdIn: usdOf(sourceAmount, from.decimals, from.priceUsd)} : {}),
        slippageBps: req.slippageBps,
      },
      now(),
    ),
  );
  return ticket;
}
