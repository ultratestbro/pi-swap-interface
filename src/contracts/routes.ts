/**
 * The quote side of the swap: what the form asks for and what the route list
 * shows. `RouteView` is the wallet's model copied verbatim (mobile
 * lib/swap/routes.ts) so ported code and tests stay diffable; the web adds its
 * fields in `WebRoute` instead of editing it (ui-port.md §4.1).
 */
import type {SwapToken} from "./domain";

export type RouteTag = "best" | "fastest";

export interface RouteFee {
  type: "network" | "protocol" | "affiliate" | "other";
  amount: bigint;
  token: string;
  included: boolean;
  description?: string;
}

/** Copied from mobile lib/swap/routes.ts (756b115) — keep in sync, do not add fields here. */
export interface RouteView {
  provider: string;
  sourceAmount: bigint;
  destAmount: bigint;
  /** What the route guarantees — the number to show, not destAmount. */
  minDestAmount: bigint;
  etaSeconds: number;
  /** Provider-reported fee in USD (0 = none reported). */
  feeUsd: number;
  fees: RouteFee[];
  tags: RouteTag[];
  /** Against the best route, 0..1. */
  relativeValue: number;
  netValueUsd: number | null;
  /** ERC-20 sources: the spender this route must be approved for (exact amount). */
  approvalSpender: string | null;
  /** Native coin the route charges on top of the input (bridge messaging fee), base units of the source chain's native. */
  nativeFee: bigint;
  /** Quote expiry, unix ms (0 = none). */
  validUntilMs: number;
  /** Source gas in USD at most (approval included); null = not counted (non-EVM / unknown). */
  gasUsd: number | null;
}

/** How the payer executes a route: the wallet signs a call / provider-built tx, or the payer sends to a deposit address. */
export type Execution = "calldata" | "deposit";

/** Who answers for a venue's quote (VenueBadge): contracts over RPC, a node, or the provider's API checked in the browser. */
export type VenueTrust = "contracts" | "own-node" | "provider-api";

/** A route as the web shows it. Built next to toRouteView: execution = txRequest ? "calldata" : "deposit". */
export interface WebRoute extends RouteView {
  /**
   * The route within its venue when the venue offers several (D47): CCTP's "fast" and "standard" (core 0.16 `routeId`;
   * Stargate names its one Taxi route "taxi"). Absent for a venue with one route. A route is `routeKey(route)` on
   * screen, and the review and the swap ask the venue for exactly this route, never its default.
   */
  routeId?: string;
  execution: Execution;
  /** depositMemo is non-empty — QR-only payers can't attach one (BTC OP_RETURN), so the row shows as refused for them. */
  hasMemo: boolean;
  trust: VenueTrust;
  /**
   * The bridge fee (`nativeFee`) in USD where the venue's own `feeUsd` leaves it out (USDT0), so the row's "fees" counts
   * it. Absent when there is none, while the source's native coin is unpriced, or when `feeUsd` already lists it (LI.FI).
   */
  bridgeFeeUsd?: number;
  /**
   * An Omniston swap on TON: each step's DEX as its quote names it (`providerData.routeSteps`; a split step or more
   * routes as the package words them, `[]` when unreadable). The route list refuses a TON wallet's swap by it — never
   * accepts by it: execute decides by the contract the exact BoC pays (ARCHITECTURE D35 part C). Absent otherwise.
   */
  tonSwapSteps?: readonly string[];
  /**
   * The execution margin under the venue's minimum for the slippage this route was quoted at, in bps: min(0.5%,
   * slippage) (floorToleranceBps). The floor every screen shows and the swap enforces is `routeFloor(route)`.
   */
  floorBps?: number;
}

/** Which route: its venue, and its route within the venue when it offers several (D47). */
export type RoutePick = Pick<WebRoute, "provider" | "routeId">;

/** The token being paid, for minimums a venue states in its base units (mobile routes.ts PaySide). */
export interface PaySide {
  symbol: string;
  /** The swap2 catalog's symbol, which venues name the asset by. */
  catalogSymbol?: string;
  decimals: number;
}

/**
 * Which section of the route list a refusal sits in (src/swap/refusals.ts decides): the SDK refused an unsafe or
 * unverifiable route (safety), the amount is off (amount), the user can change something (setup), the venue is down,
 * out of reach or rate-limited (unavailable / unreachable / busy), it doesn't serve the pair (pair), or unknown.
 * `deferred` is no refusal: a preview round left the venue for the user's own quote (D7: LI.FI while cp0x's proxy
 * doesn't carry it; Fynd only if its slot stopped mid-round — while it is off, Fynd isn't asked at all, live rounds
 * included, and is in no group), and the list shows it in a quiet group of its own, outside "Didn't quote".
 */
export type RefusalCategory = "safety" | "amount" | "setup" | "unavailable" | "unreachable" | "busy" | "pair" | "deferred" | "other";

/** A venue that sat out: a short line in the user's words, why in one sentence, and the venue's own text for support. */
export interface RouteRejection {
  provider: string;
  /** The short line (≤ 45 chars; never an address, hex, base units or an HTTP code): the row, the review's "gone" text. */
  reason: string;
  category: RefusalCategory;
  /** One plain sentence behind the row's disclosure. */
  detail?: string;
  /** The venue's own text, URLs redacted, whitespace collapsed, ≤ 400 chars: the row's "Technical reason". */
  raw: string;
  /**
   * The round sat the venue out itself and sent it nothing (left for the live quote, pays only the signer, backing off, D29):
   * not an answer from the venue, so venuesUnreachable leaves it out.
   */
  skipped?: true;
}

/**
 * Which kind of round a snapshot came from (D7): `live` was quoted for the user's own addresses and may be reviewed;
 * `preview` was priced before they exist (no wallet, no typed address) and is never reviewable, signable or a draft.
 */
export type RouteMode = "live" | "preview";

/** The engine's only output to the UI (mobile engine.ts RouteSnapshot, routes typed as WebRoute). */
export interface RouteSnapshot {
  /** Live (reviewable) or preview (prices only); the review opens only on a live snapshot. */
  mode: RouteMode;
  /** Ordered: best first (orderRoutes). */
  routes: WebRoute[];
  /** Venues still quoting (non-empty only while a round streams). */
  pending: string[];
  rejections: RouteRejection[];
  /** Venues asked: `enabled() && supportsRoute(from, to)` (+ supportsSameChain for same-chain pairs) — the router's own predicate. */
  asked: string[];
  /** Every enabled venue on this page, in ask order: `venues − asked` is what the "Not for this pair" group lists. */
  venues: string[];
}

/**
 * What the form asks live quotes for. Web deviation from mobile (D7): both
 * addresses are explicit and required — the screen resolves them (connected
 * wallet, or a validated typed address) and builds no request until both
 * exist. Only a live request can be reviewed, deposited or executed; prices
 * before that are a PreviewRequest.
 */
export interface QuoteRequest {
  from: SwapToken;
  to: SwapToken;
  /** Base units of `from`, > 0. */
  amountIn: bigint;
  slippageBps: number;
  /** Destination address on `to`'s chain: the connected wallet's own, or the validated "send to another address". */
  recipient: string;
  /** Refund address on `from`'s chain: the connected payer, or the validated typed refund address (deposit payers). */
  refundAddress: string;
}

/**
 * What the form asks PREVIEW prices for while an address is still missing (no wallet connected, no recipient or
 * refund typed yet, D7). It carries only addresses the user really has (validated), never a placeholder: the
 * engine's preview round fills a blank one per venue, inside the round. Not assignable to QuoteRequest (the
 * addresses are optional), so it can't become a SwapDraft, a deposit or an execution; `preview: true` is the
 * runtime brand quoteParams refuses.
 */
export interface PreviewRequest {
  preview: true;
  from: SwapToken;
  to: SwapToken;
  /** Base units of `from`, > 0. */
  amountIn: bigint;
  slippageBps: number;
  /** The real destination address when there is one (connected wallet or a valid typed one), else absent. */
  recipient?: string;
  /** The real refund address when there is one (connected payer or a valid typed one), else absent. */
  refundAddress?: string;
  /** "Send to another address" is on by the user's choice: venues that pay only the signer sit out. */
  toOther: boolean;
}

/** What the route list quotes: the user's live request, or preview prices before an address exists. */
export type RoutesRequest = {mode: "live"; req: QuoteRequest} | {mode: "preview"; req: PreviewRequest};

/** The live route list (mobile useRoutes RoutesState). */
export interface RoutesState {
  snapshot: RouteSnapshot | null;
  /** A round is running (venues still answering). */
  loading: boolean;
  /** Round failure in the user's words; the previous snapshot stays on screen. */
  error: string | null;
  /** When the last round finished (ms), 0 before the first. */
  updatedAt: number;
  /** Preview rounds only: the tab's preview budget is spent until this time (ms); 0 = not limited (D29). */
  limitedUntil: number;
}

/** The review's re-quote of the one picked route (mobile review.tsx L69-90). */
export interface RequoteState {
  /** The fresh route, or the drafted one until the first re-quote lands. */
  route: WebRoute | null;
  /** Set when the venue no longer routes it: "{Provider} no longer routes this swap: {reason}" blocks Confirm. */
  gone: string | null;
  /** The re-quote itself failed (network): keep showing the drafted route; the engine re-checks before signing. */
  failed: boolean;
  loading: boolean;
}
