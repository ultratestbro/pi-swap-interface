// Ported from cp0x-elysium apps/mobile/lib/swap/routes.ts @756b115. Web patches are marked "web:": the types come
// from src/contracts (same shapes), orderRoutes/tagRoutes are generic over WebRoute, QuoteLike is exported, and the
// refusal texts (mobile REASONS/CODED) moved to the categorised table in refusals.ts (ui-port.md §4.2, D28).
/**
 * The route list: each venue's validated quote as the swap screen shows it,
 * ranked the way the SDK auction tagged it ("best" = the pick on price with
 * speed / reliability breaking ties, "fastest" = the lowest ETA). Snapshots
 * stream in as venues answer (lib/swap/engine); this module only shapes
 * them. No React, no network — unit-tested in routes.test.ts.
 */
import type {Swap2Refusal} from "@anywalletkit/protocol-swap2-core/errors";
import type {RankedQuote} from "@anywalletkit/protocol-swap2-router/router";
import type {PaySide, RouteRejection, RouteView, WebRoute} from "../contracts/routes";
import type {QuoteGasLike} from "./gas";
import {orderSpender} from "./providerMeta";
import {classifyRefusal} from "./refusals";
import {routeKey} from "./routeKey";

// web: the shapes live in src/contracts/routes.ts (copied verbatim from this file there).
export type {PaySide, RouteFee, RouteTag, RouteView} from "../contracts/routes";

/** The quote fields a route row is built from (a RankedQuote, or a test's literal). */
export type QuoteLike = Pick<
  RankedQuote,
  | "provider"
  | "sourceAmount"
  | "destAmount"
  | "minDestAmount"
  | "etaSeconds"
  | "feeUsd"
  | "validUntilMs"
  | "tags"
  | "relativeValue"
  | "netValueUsd"
> &
  Partial<Pick<RankedQuote, "fees" | "txRequest" | "providerData">>;

const big = (v: string | undefined): bigint => (v && /^\d+$/.test(v) ? BigInt(v) : 0n);

/**
 * `source`: the paying side. A quote that names no spender (Omniston's
 * gasless orders are built only after the quote) still needs an ERC-20
 * source approved — for the venue's audited spender on that chain.
 */
export function toRouteView(q: QuoteLike, source?: {chain: string; isToken: boolean}, gasUsd?: (q: QuoteGasLike) => number): RouteView {
  const gas = gasUsd ? gasUsd(q) : 0;
  return {
    provider: q.provider,
    sourceAmount: big(q.sourceAmount),
    destAmount: big(q.destAmount),
    minDestAmount: big(q.minDestAmount),
    // 0 = unknown, as the engine leaves it (null since swap2-core 0.15): etaLabel shows "—".
    etaSeconds: typeof q.etaSeconds === "number" && Number.isFinite(q.etaSeconds) ? q.etaSeconds : 0,
    feeUsd: Number.isFinite(q.feeUsd) ? q.feeUsd : 0,
    fees: (q.fees ?? []).map((f) => ({
      type: f.type,
      amount: big(f.amount),
      token: f.token,
      included: f.included,
      ...(f.description ? {description: f.description} : {}),
    })),
    tags: [...(q.tags ?? [])],
    relativeValue: Number.isFinite(q.relativeValue) ? q.relativeValue : 0,
    netValueUsd: q.netValueUsd ?? null,
    approvalSpender: q.txRequest?.approvalAddress ?? (source?.isToken ? orderSpender(q.provider, source.chain) : null),
    // A price-only quote (no txRequest: LI.FI 0.8.0 and USDT0 0.5.0 priced for a placeholder) declares its bridge fee in
    // providerData, where router 0.5.5 reads it too (chunk-VAOFSGCX.js:15-20).
    nativeFee: big(q.txRequest ? q.txRequest.nativeFee : q.providerData?.nativeFee),
    validUntilMs: q.validUntilMs ?? 0,
    gasUsd: gas > 0 ? gas : null,
  };
}

/** Best first, then by value against the best, then the larger guaranteed output, then the faster. */
export function orderRoutes<R extends RouteView>(routes: readonly R[]): R[] {
  return [...routes].sort(
    (a, b) =>
      Number(b.tags.includes("best")) - Number(a.tags.includes("best")) ||
      b.relativeValue - a.relativeValue ||
      (b.minDestAmount > a.minDestAmount ? 1 : b.minDestAmount < a.minDestAmount ? -1 : 0) ||
      a.etaSeconds - b.etaSeconds,
  );
}

/**
 * Tags for a list that didn't come from the auction (a single re-quoted
 * route, a merged list): "best" on the largest guaranteed output when there
 * is a choice, "fastest" on the lowest ETA when it is another route.
 */
export function tagRoutes<R extends RouteView>(routes: readonly R[]): R[] {
  if (routes.length < 2) return routes.map((r) => ({...r, tags: []}));
  const best = routes.reduce((a, b) => (b.minDestAmount > a.minDestAmount ? b : a));
  const fastest = routes.reduce((a, b) => (b.etaSeconds < a.etaSeconds ? b : a));
  return routes.map((r) => ({
    ...r,
    tags: [
      ...(r === best ? (["best"] as const) : []),
      ...(r === fastest && fastest !== best ? (["fastest"] as const) : []),
    ],
  }));
}

/**
 * The route the user had selected, if it is still in the new list; else the best one.
 * web: by routeKey (D47: a venue may list several routes, CCTP's Fast and Standard), not by venue.
 */
export function keepSelection(routes: readonly Pick<WebRoute, "provider" | "routeId" | "tags">[], selected: string | null): string | null {
  if (selected && routes.some((r) => routeKey(r) === selected)) return selected;
  const pick = routes.find((r) => r.tags.includes("best")) ?? routes[0];
  return pick ? routeKey(pick) : null;
}

/** A venue's refusal as the user reads it: the short line of classifyRefusal (refusals.ts), e.g. for the review's "gone". */
export function friendlyReason(provider: string, reason: string, pay?: PaySide): string {
  return classifyRefusal(provider, reason, pay).reason;
}

/**
 * "lifi: no route for …" → {provider, reason, category, detail, raw}; the router prefixes every rejection with the venue.
 * web: a rejection may come as the router's classified refusal (router 0.6.0 `RouteSet.refusals` / `lastRefusals`, the
 * same text as `message`): its `reason` words a text the table doesn't know (refusals.ts BY_REASON).
 */
export function parseRejections(rejections: readonly (string | Pick<Swap2Refusal, "message" | "reason">)[], pay?: PaySide): RouteRejection[] {
  return rejections.map((x) => {
    const r = typeof x === "string" ? x : x.message;
    const reason = typeof x === "string" ? undefined : x.reason;
    const i = r.indexOf(": ");
    const provider = i > 0 ? r.slice(0, i) : "";
    return {provider, ...classifyRefusal(provider, i > 0 ? r.slice(i + 2) : r, pay, reason)};
  });
}

/** Has the quote expired (with a margin for the confirm tap and the wallet prompt)? */
export function isStale(route: Pick<RouteView, "validUntilMs">, now = Date.now(), marginMs = 5_000): boolean {
  return route.validUntilMs > 0 && route.validUntilMs - marginMs <= now;
}
