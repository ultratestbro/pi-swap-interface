/**
 * Routes that would lose most of the swap to thin pools never reach the list (D50; owner 2026-11-26 after 62 000 MON →
 * AUSD on Monad: Uniswap v3's pools there quoted 1.13 AUSD for ≈ $720 — a 99.8% price impact — shown as an ordinary
 * route next to LI.FI's 718.66).
 *
 * A quote is left out, as a refusal of its venue filed under "amount" ("Loses 99.8% to price impact"), when either
 *   - the venue's own price impact (`providerData.priceImpactBps`, Uniswap's quoter probe) is MAX_IMPACT_BPS or more, or
 *   - priced at the page's spot prices, it delivers MAX_LOSS_PCT or more under what is paid AND another route of the
 *     same round delivers MAX_LOSS_PCT more (router `quoteValues`): a small swap whose every route pays fees well
 *     above 5% keeps its routes — only one that is that much worse than another is dropped.
 * Never a route of a venue that measures nothing and has no priced alternative: nothing is hidden on a guess.
 */
import {quoteValues} from "@anywalletkit/protocol-swap2-router/value";
import type {Swap2Refusal} from "@anywalletkit/protocol-swap2-core/errors";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";

/** The venue's own price impact from which a route is left out: 5%. */
export const MAX_IMPACT_BPS = 500;
/** The value lost (and the better route's lead) from which a route is left out, in percent. */
export const MAX_LOSS_PCT = 5;

/** The refusal text a left-out route is filed under (refusals.ts reads "loses N% … price impact"). */
export const lossText = (provider: string, pct: number): string =>
  `${provider}: loses ${pct >= 99.95 ? "99.9" : pct.toFixed(1)}% of the value to price impact — its pools are too thin for this amount`;

/** The venue's own price impact in bps, when it reports a finite one. */
function impactBps(q: Pick<Quote, "providerData">): number | null {
  const raw = (q.providerData as Record<string, unknown> | undefined)?.priceImpactBps;
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The quotes worth showing, and a refusal per quote left out. `prices` (symbol → USD) may be missing or empty. */
export function dropLossy<Q extends Quote>(
  quotes: readonly Q[],
  params: Pick<QuoteParams, "sourceChain" | "sourceToken" | "destChain" | "destToken" | "amountIn">,
  prices?: Readonly<Record<string, number>>,
): {kept: Q[]; dropped: Swap2Refusal[]} {
  if (!quotes.length) return {kept: [], dropped: []};
  const values = prices && Object.keys(prices).length ? quoteValues(prices, params, quotes, {betterByPct: MAX_LOSS_PCT}) : [];
  const kept: Q[] = [];
  const dropped: Swap2Refusal[] = [];
  quotes.forEach((q, i) => {
    const bps = impactBps(q);
    const v = values[i];
    const lost =
      bps !== null && bps >= MAX_IMPACT_BPS
        ? bps / 100
        : v && v.lossPct !== null && v.lossPct >= MAX_LOSS_PCT && v.betterAlternative && v.betterAlternative.byPct >= MAX_LOSS_PCT
          ? v.lossPct
          : null;
    if (lost === null) kept.push(q);
    else dropped.push({provider: q.provider, message: lossText(q.provider, lost), reason: "insufficient_liquidity"});
  });
  return {kept, dropped};
}
