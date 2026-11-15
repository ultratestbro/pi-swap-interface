/**
 * The swap module's public entry (contract: SwapModule in
 * src/contracts/modules.ts): the provider registry, the quote engine, the
 * route-view model, amount/slippage/gas math and the quote hooks. Other
 * modules import only from here.
 */
import type {SwapPort} from "../contracts/ports";
import {quoteRoutes, requoteRoute} from "./engine";
import {createUseRequote} from "./useRequote";
import {createUseRoutes} from "./useRoutes";

/** The real quote port (demo mode swaps in src/mocks' instead, at App level). */
export const swapPort: SwapPort = {
  useRoutes: createUseRoutes(quoteRoutes),
  useRequote: createUseRequote(requoteRoute),
};

// ── provider registry ──
export {DEFAULT_ON_PROVIDERS, PROXY_KEY_PLACEHOLDER, STANDARD_ONLY_PROVIDERS, buildProviders, closeProviders, evmRpcByCaip2, zeroExSettlers} from "./providers";
export {createProviderStores, STORAGE_BLOCKED, type ProviderStores} from "./stores";
export {coolDownOnRateLimit, delegate, isLive, isWrapPair, narrowRoute, paced, whileLive, withQuoteGap} from "./providerWrappers";

// ── engine ──
export {
  appProviders,
  appRouter,
  createQuoteEngine,
  eligibleProviders,
  enabledVenues,
  quoteParams,
  quoteRoutes,
  requoteRoute,
  swapStatus,
  type QuoteEngine,
  type QuoteEngineDeps,
} from "./engine";

// ── names / venue facts ──
export {LISTED_ONLY_VENUES, PERMIT2_VENUES, PROVIDER_NAMES, TWO_PHASE, orderSpender, providerName, venueScope, type ScopeSide} from "./providerMeta";
export {sourceParams} from "./source";
export {FYND_LICENSE_URL, VENUE_TRUST, fyndRouterNotice, venueTrust, venueTrustText} from "./venues";

// ── route list ──
export {friendlyReason, isStale, keepSelection, orderRoutes, parseRejections, tagRoutes, toRouteView, type QuoteLike} from "./routes";
export {classifyRefusal, redactRaw, type ClassifiedRefusal} from "./refusals";
export {executionOf, routeFloor, toWebRoute} from "./webRoute";
export {DEBOUNCE_MS, PREVIEW_DEBOUNCE_MS, PREVIEW_STALE_MS, REFRESH_MS, createUseRoutes, routesKey, type QuoteRoutesFn, type UseRoutesOptions} from "./useRoutes";
// Only the predicate leaves the module: the sample addresses stay inside the engine's preview round (D7).
export {canPreview} from "./preview";
export {createVenueBackoff, type VenueBackoff} from "./limiter";
export {createUseRequote, type RequoteRouteFn} from "./useRequote";

// ── gas ──
export {APPROVE_GAS, CALL_GAS, NATIVE_TRANSFER_GAS, ROUTER_RANKING, TOKEN_TRANSFER_GAS, gasCostUsd, gasPricer, routeGasUnits, type QuoteGasLike} from "./gas";

// ── amounts ──
export {fieldText, formatFee, formatUnits, parseUnits, usdOf} from "./amount";
export {
  DEFAULT_SLIPPAGE_BPS,
  FLOOR_TOLERANCE_BPS,
  floorToleranceBps,
  autoSlippageBps,
  balanceProblem,
  etaLabel,
  executionFloor,
  formatRate,
  gasReserve,
  impliedSlippagePct,
  maxSwappable,
  trimNativeMax,
  minWithSlippage,
  rate,
  parsePastedAmount,
  sanitizeAmountInput,
  slippageLabel,
} from "./math";
export {swapRecipient} from "./recipient";
