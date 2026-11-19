/**
 * The web's route row: the mobile RouteView plus how the payer executes it,
 * whether it needs a memo, and the venue's trust badge (ui-port.md §4.1). Kept
 * out of routes.ts so that file stays diffable against the wallet.
 */
import type {Quote} from "@anywalletkit/protocol-swap2-core/types";
import type {Execution, WebRoute} from "../contracts/routes";
import type {QuoteGasLike} from "./gas";
import {executionFloor, floorToleranceBps, FLOOR_TOLERANCE_BPS} from "./math";
import {toRouteView, type QuoteLike} from "./routes";

export {routeKey} from "./routeKey";
import {venueTrust} from "./venues";

/**
 * Venues whose route is always a wallet signature even though the dry quote
 * carries no txRequest: Chainflip's vault call is built only for a live quote,
 * Omniston's EVM source is a typed order and its TON source a jetton transfer
 * carrying its escrow order (built only for a live quote, its secret then
 * stored) or a DEX swap (USDT transferred to the DEX, or TON sent to it),
 * Symbiosis' TON source a jetton transfer carrying its bridge request — TON
 * contract calls, which a TON wallet signs only through execute's byte-exact
 * check (D35; chunk-K3EPNDVO.js:388-397, depositAddress ""; with btcSource off
 * it never names one), and LI.FI (0.8.0) and USDT0
 * (0.5.0) return a price-only quote, without its transaction, when it was
 * priced for a placeholder recipient or refund (a preview), and 0x's dry
 * quote is its `/swap/permit2/price` answer, which carries no transaction (a
 * Settler call, built only for a live quote; D38). Never offered as a deposit
 * address, so a QR payer reads "Needs a wallet that signs" instead of a dead
 * end.
 */
const SIGNED_ONLY: ReadonlySet<string> = new Set(["chainflip", "omniston", "symbiosis", "lifi", "usdt0", "stargate", "zeroex"]);

/** txRequest present (or a signed-only venue) → the wallet signs; else the payer sends to a deposit address. */
export function executionOf(q: Pick<Quote, "provider" | "txRequest">): Execution {
  return q.txRequest || SIGNED_ONLY.has(q.provider) ? "calldata" : "deposit";
}

/**
 * Venues whose `feeUsd` leaves out the bridge fee they charge on top (`nativeFee`): USDT0 reports its protocol fees only
 * (protocol-swap2-usdt0 0.5.3 chunk-7FQDRYVI.js:333/520), so its Legacy Mesh into Tron read "fees $0.30" with ≈ $13 of
 * LayerZero fee on top. LI.FI's `feeUsd` sums its feeCosts, which already list it ("LayerZero native fee", included:
 * false; protocol-swap2-lifi 0.8.3 chunk-G26GE46T.js:1126). Stargate (0.1.0) reports `feeUsd` 0 (`feeUsdKnown`
 * false) and lists its LayerZero messaging fee as a `network` row it doesn't price (≈ 0.00085 ETH from Arbitrum on
 * 2026-11-17, sealed with headroom that the endpoint refunds).
 */
const FEE_USD_WITHOUT_BRIDGE_FEE: ReadonlySet<string> = new Set(["usdt0", "stargate"]);

/**
 * An Omniston swap on TON's route, step by step (D35 part C): the DEX each step names (`providerData.routeSteps`, the
 * package's own record of the quote's route; a split step reads `split(…)`, more routes `N-routes`), `[]` when it
 * can't be read; undefined for anything but an Omniston swap. Only ever a reason to refuse.
 */
function tonSwapSteps(q: QuoteLike): string[] | undefined {
  if (q.provider !== "omniston" || q.providerData?.settlement !== "swap") return undefined;
  try {
    const steps = JSON.parse(q.providerData.routeSteps ?? "") as unknown;
    return Array.isArray(steps) ? steps.map((x) => String((x as {protocol?: unknown} | null)?.protocol ?? "")) : [];
  } catch {
    return [];
  }
}

/**
 * toRouteView + the web fields. `native`: the source chain's native coin at its price, for the bridge fee in USD;
 * `slippageBps`: the setting it was quoted at, which sets its execution margin (floorBps).
 */
export function toWebRoute(
  q: QuoteLike & Partial<Pick<Quote, "depositMemo" | "routeId">>,
  source?: {chain: string; isToken: boolean},
  gasUsd?: (q: QuoteGasLike) => number,
  native?: {usd: number; decimals: number},
  slippageBps?: number,
): WebRoute {
  const view = toRouteView(q, source, gasUsd);
  const bridgeFeeUsd =
    native && view.nativeFee > 0n && FEE_USD_WITHOUT_BRIDGE_FEE.has(q.provider) ? (Number(view.nativeFee) / 10 ** native.decimals) * native.usd : 0;
  const steps = tonSwapSteps(q);
  return {
    ...view,
    ...(q.routeId !== undefined ? {routeId: q.routeId} : {}),
    execution: executionOf(q),
    hasMemo: typeof q.depositMemo === "string" && q.depositMemo !== "",
    trust: venueTrust(q.provider),
    ...(bridgeFeeUsd > 0 ? {bridgeFeeUsd} : {}),
    ...(steps ? {tonSwapSteps: steps} : {}),
    ...(slippageBps !== undefined ? {floorBps: Number(floorToleranceBps(slippageBps))} : {}),
  };
}

/** The minimum a route is held to — what the list, the summary and the review show, and the swap enforces. */
export const routeFloor = (route: Pick<WebRoute, "minDestAmount" | "floorBps">): bigint =>
  executionFloor(route.minDestAmount, route.floorBps !== undefined ? BigInt(route.floorBps) : FLOOR_TOLERANCE_BPS);
