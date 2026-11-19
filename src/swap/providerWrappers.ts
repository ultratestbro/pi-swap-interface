/**
 * Thin wrappers around AWK providers (providers.md §6.1). Each one returns a
 * NEW provider object whose members call the ORIGINAL instance (bound to it),
 * so per-instance state stays on the one shared provider: Relay's
 * issued-quote memory, NEAR's `trackIntent` calling `this.notifyDeposit`.
 * Wrap before constructing a router: the router binds what it sees then.
 */
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {Asset, CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {WRAPPED_NATIVE} from "@anywalletkit/protocol-swap2-wrap/provider";
import {ccAsset} from "@anywalletkit/swap2-assets";
import {paced} from "../config/pacing";
import {RATE_LIMITED, RETRY_WAIT, waitMs} from "./refusals";

// FIFO pacing lives with the config's pacing (Standard's routing paces Symbiosis' direct calls with it at boot).
export {paced};

/**
 * A copy of `p` with every member bound to `p`, then `overrides` on top. The
 * router reads exactly these members (router chunk-7ZUNB2U7.js:70-99); a
 * spread copy would lose `this` for NEAR and any prototype method.
 */
export function delegate(p: CrossChainProvider, overrides: Partial<Omit<CrossChainProvider, "name">> = {}): CrossChainProvider {
  const out: CrossChainProvider = {
    name: p.name,
    enabled: p.enabled.bind(p),
    supportsRoute: p.supportsRoute.bind(p),
    getQuote: p.getQuote.bind(p),
    buildDeposit: p.buildDeposit.bind(p),
    trackIntent: p.trackIntent.bind(p),
  };
  const optional: Partial<CrossChainProvider> = {
    // core 0.16: a venue's several routes for a list (CCTP Fast and Standard, D47). The router asks it in dry rounds
    // without a routeId and then holds every quote of the venue to a routeId — getQuote's included.
    getQuotes: p.getQuotes?.bind(p),
    preflightDeposit: p.preflightDeposit?.bind(p),
    notifyDeposit: p.notifyDeposit?.bind(p),
    registerSignedOrder: p.registerSignedOrder?.bind(p),
    buildClaim: p.buildClaim?.bind(p),
    claimTargets: p.claimTargets?.bind(p),
    callTargets: p.callTargets?.bind(p),
    spenders: p.spenders?.bind(p),
    close: p.close?.bind(p),
    supportsChain: p.supportsChain?.bind(p),
    supportsChainPair: p.supportsChainPair?.bind(p),
    describeActivity: p.describeActivity?.bind(p),
    supportsSameChain: p.supportsSameChain,
    remote: p.remote,
    verifiesBuilds: p.verifiesBuilds,
    verifiesQuotes: p.verifiesQuotes,
    depositAddressRoutes: p.depositAddressRoutes,
    // swap2-core 0.13.0: every EVM call goes out with the account's own gas estimate, dry-run first (0x's native sales;
    // its Permit2 calls do anyway). Router 0.6.1 keeps it in its dispatch snapshot; a copy without it would let the
    // engine send the venue's quoted gas limit.
    ownGasEstimate: p.ownGasEstimate,
  };
  // Only members the original has: `"x" in provider` must agree with the original (the engine checks some by presence).
  for (const [k, v] of Object.entries(optional)) if (v !== undefined) Object.assign(out, {[k]: v});
  // A wrapper of getQuote alone (a gap, a gate, a cool-down) drops getQuotes: the router would ask the venue past it.
  if (overrides.getQuote && !("getQuotes" in overrides)) delete out.getQuotes;
  return Object.assign(out, overrides);
}

/**
 * Spaces a provider's getQuote calls (Jupiter has no fetchImpl). A call whose
 * round was cancelled while it waited its turn is skipped, so fast typing
 * never queues requests against the venue's limit.
 */
export function withQuoteGap(p: CrossChainProvider, gapMs: number): CrossChainProvider {
  const quote = paced(gapMs, (params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> =>
    signal?.aborted ? Promise.resolve(null) : p.getQuote(params, signal),
  );
  return delegate(p, {getQuote: quote});
}

/** whileLive's gate per wrapped provider (engine.ts enabledVenues reads it through `isLive`). */
const gates = new WeakMap<CrossChainProvider, () => boolean>();

/**
 * Routes only while `live()` says so: supportsRoute (and supportsChain / supportsChainPair) follow it, so the router,
 * a review's re-quote and the route list ask the venue only then. Fynd's Standard slot (standard.ts standardFynd) —
 * a page whose proxy holds no Fynd key, or whose Fynd slot stopped after a failure, never asks it and lists no row
 * for it. `enabled()` stays the SDK's: the engine reads it again after an approval is mined (core executeSwap2,
 * "disabled before source broadcast", then a revoke), and nothing after the quote needs the venue's API.
 */
export function whileLive(p: CrossChainProvider, live: () => boolean): CrossChainProvider {
  const {supportsChain, supportsChainPair} = p;
  const out = delegate(p, {
    supportsRoute: (from, to) => live() && p.supportsRoute(from, to),
    ...(supportsChain ? {supportsChain: (c: string) => live() && supportsChain.call(p, c)} : {}),
    ...(supportsChainPair ? {supportsChainPair: (a: string, b: string) => live() && supportsChainPair.call(p, a, b)} : {}),
  });
  gates.set(out, live);
  return out;
}

/** False only for a whileLive provider whose gate is shut right now. */
export const isLive = (p: CrossChainProvider): boolean => gates.get(p)?.() ?? true;

/** The refusal payoutToSigner gives (and Jupiter's own live quote gives): friendlyReason turns it into plain words. */
export const SIGNER_ONLY_REFUSAL = "the recipient must be the signing wallet";

/**
 * A venue that pays only the signer (Jupiter pays the taker) refuses another recipient only in its LIVE quote, so a
 * dry quote to another address would rank — even as Best — and then fail at Confirm. This refuses it in every quote:
 * `destAddress` (the recipient) must equal `refundAddress` (the payer) whenever both are given.
 */
export function payoutToSigner(p: CrossChainProvider): CrossChainProvider {
  return delegate(p, {
    getQuote: (params, signal) => {
      if (params.destAddress && params.refundAddress && params.destAddress !== params.refundAddress) {
        params.onRefusal?.(`${p.name}: ${SIGNER_ONLY_REFUSAL} (it pays only the wallet that signs)`, {reason: "unsupported_pair"});
        return Promise.resolve(null);
      }
      return p.getQuote(params, signal);
    },
  });
}

const NAMED_WAIT = new RegExp(RETRY_WAIT, "i");
/** A cooldown never outlasts this, whatever the venue says: a bad answer can't switch a venue off for the session. */
const MAX_COOLDOWN_MS = 3 * 3_600_000;

/** The wait a rate-limit refusal names ("retry in 2 hours" → 7 200 000; "retry after" too), or null when it names none. */
export function retryAfterMs(reason: string): number | null {
  const m = NAMED_WAIT.exec(reason);
  return m ? waitMs(Number(m[1]), m[2]!) : null;
}

/**
 * After a rate-limit refusal (RATE_LIMITED, read as the route list reads it; LI.FI keyless answers HTTP 429 "Rate
 * limit exceeded, retry in 2 hours"), stops asking the venue until the wait it named is over (else `fallbackMs`):
 * while it cools, getQuote refuses at once ("rate limit exceeded, retry in ~N min") and sends nothing. LI.FI keyless
 * allows about 75 /quote per 2 h per IP and the list refreshes every 30 s, so without this every round re-hits the
 * 429 and the venue's lockout never ends. It never caches or returns a quote: once the wait is over the venue is
 * asked afresh and its own checks run again. `now` is injectable for tests.
 */
export function coolDownOnRateLimit(p: CrossChainProvider, fallbackMs = 15 * 60_000, now: () => number = Date.now): CrossChainProvider {
  let until = 0;
  return delegate(p, {
    getQuote: (params, signal) => {
      const left = until - now();
      if (left > 0) {
        params.onRefusal?.(`${p.name}: rate limit exceeded, retry in ~${Math.ceil(left / 60_000)} min`, {reason: "rate_limited", retryAfterMs: left});
        return Promise.resolve(null);
      }
      // The venue's classification (swap2-core 0.12.0) passes on with its text.
      const onRefusal = (reason: string, info?: Swap2RefusalInfo) => {
        if (RATE_LIMITED.test(reason)) until = now() + Math.min(retryAfterMs(reason) ?? fallbackMs, MAX_COOLDOWN_MS);
        params.onRefusal?.(reason, info);
      };
      return p.getQuote({...params, onRefusal}, signal);
    },
  });
}

/** Narrows a chain-only supportsRoute, so RouteSet.rejections stays free of venues that can never serve the pair. */
export function narrowRoute(p: CrossChainProvider, pred: (from: Asset, to: Asset) => boolean): CrossChainProvider {
  return delegate(p, {supportsRoute: (from, to) => pred(from, to) && p.supportsRoute(from, to)});
}

const ZERO = /^0x0{40}$/i;

/**
 * Native ↔ its wrapped token on one EVM chain, mirroring the wrap module's own
 * check (chunk-GC6XODOS.js:121-129): `from.token` is a catalog symbol,
 * `to.token` an address (the zero address for native).
 */
export function isWrapPair(from: Asset, to: Asset): boolean {
  if (from.chain !== to.chain || !from.chain.startsWith("eip155:")) return false;
  const w = WRAPPED_NATIVE[Number(from.chain.slice("eip155:".length))];
  if (!w) return false;
  const src = ccAsset(from.chain, from.token);
  const wrappedIn = !!src?.contract && src.contract.toLowerCase() === w.address.toLowerCase();
  const nativeIn = !!src && !src.contract;
  const wrappedOut = to.token.toLowerCase() === w.address.toLowerCase();
  return (nativeIn && wrappedOut) || (wrappedIn && ZERO.test(to.token));
}
