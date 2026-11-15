/**
 * The review card's rows (mobile app/swap/review.tsx L232-288 + the web's
 * trust and refund rows): everything Confirm authorizes, built from the
 * request and the live route. One line per row where it fits (D34): the
 * secondary fact sits dim on the value's line, an explanation behind the
 * row's info mark (focusable, so a keyboard or a tap opens it too) — never a
 * fact. Pure apart from the logo and badge elements.
 */
import type {SwapToken} from "../../contracts/domain";
import type {QuoteRequest, WebRoute} from "../../contracts/routes";
import type {ReviewRow} from "../../contracts/ui";
import {formatUsd, shortAddress} from "../../catalog";
import {FLOOR_TOLERANCE_BPS, TWO_PHASE, etaLabel, formatRate, impliedSlippagePct, providerName, rate, routeFloor, usdOf} from "../../swap";
import {ProviderLogo, VenueBadge, venueTrustText} from "../../ui";
import {bpsLabel} from "../form/FormParts";
import {amountText} from "../labels";

export interface ReviewRowsInput {
  req: QuoteRequest;
  route: WebRoute;
  /** The pay token as it is now (live balance and price). */
  from: SwapToken;
  to: SwapToken;
  /** The pay chain's native coin (gas, bridge fee). */
  native: {symbol: string; decimals: number} | undefined;
  /** "Auto slippage 0.5%" / "Slippage 1%" (the minimum's tip; its note is the percentage, from req.slippageBps). */
  slippage: string;
}

/** Is the payout address the connected wallet's own on that family? */
export const paysToOwn = (req: QuoteRequest): boolean =>
  req.to.owner !== null && (req.to.family === "evm" ? req.recipient.toLowerCase() === req.to.owner.toLowerCase() : req.recipient === req.to.owner);

/** Paid out to the very address it is paid from (an EVM wallet across EVM chains, or a same-chain swap). */
const samePayer = (req: QuoteRequest): boolean =>
  req.from.family === req.to.family &&
  (req.to.family === "evm" ? req.recipient.toLowerCase() === req.refundAddress.toLowerCase() : req.recipient === req.refundAddress);

export function reviewRows({req, route, from, to, native, slippage}: ReviewRowsInput): ReviewRow[] {
  const qr = from.payMode === "deposit";
  const payUsd = usdOf(req.amountIn, from.decimals, from.priceUsd);
  const outUsd = usdOf(route.destAmount, to.decimals, to.priceUsd);
  const r = rate(req.amountIn, from.decimals, route.destAmount, to.decimals);
  const nativeSymbol = native?.symbol ?? "the native coin";
  const cross = from.caip2 !== to.caip2;
  const name = providerName(route.provider);
  const eta = etaLabel(route.etaSeconds);
  const routeNote = [eta === "—" ? null : eta, TWO_PHASE.has(route.provider) && cross ? "claim on arrival" : null].filter(Boolean).join(" · ");
  return [
    {k: "You pay", v: amountText(req.amountIn, from.decimals, from.symbol), ...(payUsd !== undefined ? {note: formatUsd(payUsd)} : {}), testId: "swap-review-pay"},
    {
      k: "You receive",
      v: `≈ ${amountText(route.destAmount, to.decimals, to.symbol)}`,
      ...(outUsd !== undefined ? {note: formatUsd(outUsd)} : {}),
      testId: "swap-review-receive",
    },
    {
      k: "Minimum received",
      v: amountText(routeFloor(route), to.decimals, to.symbol),
      note: `${bpsLabel(req.slippageBps)} + margin`,
      // The venue's own minimum is `slippage` under the quote; the enforced floor is a further margin below it.
      tip: `${slippage} + ${bpsLabel(route.floorBps ?? Number(FLOOR_TOLERANCE_BPS))} margin · quoted ${impliedSlippagePct(route.destAmount, route.minDestAmount).toFixed(2)}%. The swap is refused if it would deliver less.`,
      testId: "swap-review-min",
    },
    {k: "Rate", v: r !== null ? `1 ${from.symbol} = ${formatRate(r)} ${to.symbol}` : "—"},
    {
      k: "Route",
      v: name,
      icon: <ProviderLogo provider={route.provider} size={18} />,
      // Who quoted it (contracts, a node, the venue's API) is the badge; what that means, its tooltip on hover and the
      // row's info mark — the badge itself isn't focusable, and touch has no hover.
      badge: <VenueBadge trust={route.trust} providerName={name} chainName={from.chainName} />,
      tip: venueTrustText(route.trust, name, from.chainName),
      ...(routeNote ? {note: routeNote} : {}),
      testId: "swap-review-route",
    },
    {
      k: "Fees",
      v: route.feeUsd > 0 ? formatUsd(route.feeUsd) : "In the price",
      note: route.gasUsd !== null ? `+ gas ≤ ${formatUsd(route.gasUsd)} in ${nativeSymbol}` : `+ network fee in ${nativeSymbol}`,
    },
    ...(route.nativeFee > 0n && native ? [{k: "Bridge fee", v: amountText(route.nativeFee, native.decimals, native.symbol), note: "on top of the amount"}] : []),
    ...(qr
      ? []
      : [
          {
            k: "Approval",
            v: route.approvalSpender ? `Exact ${amountText(req.amountIn, from.decimals, from.symbol)}` : "Not needed",
            ...(route.approvalSpender ? {note: `spender ${shortAddress(route.approvalSpender, 8, 6)}`} : {}),
            testId: "swap-review-approval",
          },
        ]),
    ...addressRows(req, qr, cross),
  ];
}

/** Where it is paid from (or refunded to) and where it goes; one "From / To" row when that is the same address. */
function addressRows(req: QuoteRequest, qr: boolean, cross: boolean): ReviewRow[] {
  const {from, to} = req;
  const own = paysToOwn(req);
  const payer = shortAddress(req.refundAddress, 8, 6);
  const toRow: ReviewRow = own
    ? {k: "To", v: shortAddress(req.recipient, 8, 6), note: `your ${to.chainName} address`, testId: "swap-review-to"}
    : {
        k: "To",
        v: shortAddress(req.recipient, 8, 6),
        note: to.owner ? "not this wallet" : "the address you entered",
        color: "var(--amber)",
        testId: "swap-review-to",
      };
  if (qr) return [{k: "Refund to", v: payer, note: "refunds go here", testId: "swap-review-refund"}, toRow];
  if (own && samePayer(req)) return [{k: "From / To", v: payer, note: cross ? "yours on both chains" : "your address", testId: "swap-review-to"}];
  return [{k: "From", v: payer, note: `your ${from.chainName} address`}, toRow];
}
