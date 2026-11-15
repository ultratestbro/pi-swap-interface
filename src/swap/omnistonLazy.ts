/**
 * Omniston in the main bundle is only this stand-in (providers.md §6.3): the
 * real provider (rxjs, @ton/*, the WS SDK, a Buffer polyfill) loads as a
 * separate chunk, and only while its runtime flag is on (the default; an
 * operator or a viewer can switch it off). supportsRoute must be
 * synchronous and I/O-free, so the stand-in is disabled until the chunk has
 * loaded: a round waits a bounded time for it (engine.ts LAZY_WAIT_MS), and if
 * the chunk is still loading then, Omniston sits that round out — left out of
 * the venue count, never listed as not covering the pair.
 */
import type {Asset, CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import {ccAsset, ccAssetByToken} from "@anywalletkit/swap2-assets";
import type {RuntimeConfig} from "../contracts/config";
import type {ProviderStores} from "./stores";

/** Each stand-in's load while it runs (removed once it settles): what lazyLoads waits for. */
const loads = new WeakMap<CrossChainProvider, Promise<unknown>>();

/** Resolves once every stand-in in `providers` has loaded or failed; null when none is loading (nothing to wait for). */
export function lazyLoads(providers: readonly CrossChainProvider[]): Promise<void> | null {
  const pending = providers.flatMap((p) => {
    const load = loads.get(p);
    return load ? [load] : [];
  });
  return pending.length ? Promise.all(pending).then(() => {}) : null;
}

/**
 * Omniston's cross-chain orders move tokens only: its getQuote refuses a native leg before sending anything
 * (chunk-DMO24BFW.js:379-382/2086-2089) while its supportsRoute reads the chains alone (:2045-2051). Such a pair is
 * not asked, so its refusal can't hide "Couldn't reach any venue"; it lands in "Not for this pair" (venueScope).
 * The same lookups as the SDK's: the source by catalog symbol, the destination by token id.
 */
export const omnistonTokenLegs = (from: Asset, to: Asset): boolean =>
  from.chain === to.chain || (!!ccAsset(from.chain, from.token)?.contract && !!ccAssetByToken(to.chain, to.token)?.contract);

/** Starts loading at once; never built without durable storage (the HTLC secret has no other holder). */
export function lazyOmniston(config: RuntimeConfig, stores: ProviderStores, rpcUrls: Record<string, string[]>): CrossChainProvider {
  let real: CrossChainProvider | null = null;
  const loading = (async () => {
    if (!(await stores.ready())) return null;
    const {buildOmniston} = await import("./omniston");
    return (real = buildOmniston(config, stores, rpcUrls));
  })().catch((e: unknown) => {
    console.warn("omniston failed to load", e);
    return null;
  });
  const get = async (): Promise<CrossChainProvider> => {
    const p = real ?? (await loading);
    if (!p) throw new Error("omniston: unavailable in this browser (site storage is blocked)");
    return p;
  };
  const standIn: CrossChainProvider = {
    name: "omniston",
    // TON ↔ TON is same-chain (a TON wallet signs those swaps only between TON and USDT, in one step through a DEX
    // contract the app pins, D35 part C).
    supportsSameChain: true,
    // Off while loading, and for good when it can't load. Tracking and execution reach get() through the router's
    // provider lookup, which doesn't read enabled().
    enabled: () => !!real && real.enabled(),
    supportsRoute: (from, to) => !!real && omnistonTokenLegs(from, to) && real.supportsRoute(from, to),
    supportsChain: (c) => !!real?.supportsChain?.(c),
    supportsChainPair: (a, b) => !!real?.supportsChainPair?.(a, b),
    getQuote: async (params, signal) => (await get()).getQuote(params, signal),
    buildDeposit: async (quote) => (await get()).buildDeposit(quote),
    trackIntent: async (ref) => (await get()).trackIntent(ref),
    registerSignedOrder: async (intentId, signature) => {
      const p = await get();
      if (!p.registerSignedOrder) throw new Error("omniston: registerSignedOrder missing");
      return p.registerSignedOrder(intentId, signature);
    },
    describeActivity: (tx, ctx) => real?.describeActivity?.(tx, ctx) ?? null,
    close: () => real?.close?.(),
  };
  loads.set(standIn, loading);
  void loading.finally(() => loads.delete(standIn));
  return standIn;
}
