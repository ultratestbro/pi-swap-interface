/**
 * The catalog's port (D15): the hooks screens reach through `usePorts().catalog`. Chains and tokens are static, plus
 * the tokens imported in this browser (D39, a guarded localStorage store); balances, prices, an import's on-chain read
 * and its logo are react-query reads, so every caller shares one request per key.
 */
import {useQueries, useQuery, type UseQueryResult} from "@tanstack/react-query";
import {useMemo} from "react";
import type {Owners, PriceMap, Token, TokenLookup} from "../contracts/domain";
import type {CatalogPort, SwapTokensState, TokenLookups} from "../contracts/ports";
import {useBalances} from "./balances";
import {isContractAddress} from "./evm";
import {TokenReadError, addImportedToken, canonicalTokenAddress, readTokenForImport, removeImportedToken, useImportedTokens} from "./imported";
import {fetchTokenLogo} from "./importedLogo";
import {CHAIN_LIST} from "./network";
import {fetchImportedPrices, importedPriceKey, lastKnownPrices, loadPrices} from "./prices";
import {TOKENS, swapTokens} from "./tokens";

/** `{}` until the first prices arrive: one shared object, so memoized consumers do not churn. */
const NO_PRICES: PriceMap = Object.freeze({});

/** Module-level so react-query keeps the same placeholder object between renders. */
const warmStart = (): PriceMap | undefined => lastKnownPrices();

/**
 * Symbol → USD, refreshed every 60 s while the tab is visible. react-query's structural sharing keeps the same
 * object when a refresh brings identical numbers; a failed refresh keeps the last good map (loadPrices throws).
 */
export function usePrices(): PriceMap {
  const {data} = useQuery<PriceMap>({
    queryKey: ["prices"],
    queryFn: ({signal}) => loadPrices(signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
    placeholderData: warmStart,
  });
  return data ?? NO_PRICES;
}

/**
 * The imported tokens' USD prices by token key (D39), found by contract on DefiLlama (`fetchImportedPrices`), refreshed
 * like the catalog's. react-query key `["imported-prices", …DefiLlama keys]` — its own, so nothing reading `["prices"]`
 * waits on it.
 */
export function useImportedPrices(tokens: readonly Token[]): PriceMap {
  const keys = useMemo(() => tokens.flatMap((t) => importedPriceKey(t) ?? []).sort(), [tokens]);
  const {data} = useQuery<PriceMap>({
    queryKey: ["imported-prices", ...keys],
    enabled: keys.length > 0,
    queryFn: ({signal}) => fetchImportedPrices(tokens, signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  return keys.length && data ? data : NO_PRICES;
}

type Logo = {key: string; logo: string | null};
const NO_LOGOS: Readonly<Record<string, string>> = Object.freeze({});

/** Module-level (a stable `combine`), so react-query hands back the same map until a logo arrives. */
const logosByKey = (results: UseQueryResult<Logo>[]): Readonly<Record<string, string>> => {
  const found = results.flatMap((r) => (r.data?.logo ? [[r.data.key, r.data.logo] as const] : []));
  return found.length ? Object.fromEntries(found) : NO_LOGOS;
};

/**
 * The imported tokens' logos by token key (D39): a `data:` URL each, found by contract (`fetchTokenLogo`). One read per
 * token for the session (`["token-logo", key]`); a token without one is absent and keeps its monogram.
 */
export function useImportedLogos(tokens: readonly Token[]): Readonly<Record<string, string>> {
  return useQueries({
    queries: tokens.map((t) => ({
      queryKey: ["token-logo", t.key],
      queryFn: async ({signal}: {signal: AbortSignal}): Promise<Logo> => ({key: t.key, logo: await fetchTokenLogo(t, signal)}),
      staleTime: Infinity,
      gcTime: Infinity,
      retry: 1,
      refetchOnWindowFocus: false,
    })),
    combine: logosByKey,
  });
}

/** `tokens` with the logos found for them; the same array when there are none. */
function withLogos(tokens: readonly Token[], logos: Readonly<Record<string, string>>): readonly Token[] {
  return logos === NO_LOGOS ? tokens : tokens.map((t) => (logos[t.key] ? {...t, logo: logos[t.key]} : t));
}

/** Owners by value: a caller that rebuilds the object each render must not rebuild the token list. */
function useStableOwners(owners: Owners): Owners {
  const key = JSON.stringify(Object.entries(owners).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "").sort());
  return useMemo(() => Object.fromEntries(JSON.parse(key) as [string, string][]) as Owners, [key]);
}

/**
 * The token universe with the viewer's balances and prices: held first, pay side = payMode !== "none". The tokens
 * imported in this browser (D39) come after the catalog's (held first among them), priced and shown with a logo only as
 * found by their contract.
 */
export function useSwapTokens(owners: Owners): SwapTokensState {
  const stable = useStableOwners(owners);
  const balances = useBalances(stable);
  const prices = usePrices();
  const imported = useImportedTokens();
  const importedPrices = useImportedPrices(imported);
  const logos = useImportedLogos(imported);
  const all = useMemo(
    () => [
      ...swapTokens(TOKENS, balances.byKey, prices, stable),
      ...swapTokens(withLogos(imported, logos), balances.byKey, prices, stable, importedPrices),
    ],
    [balances.byKey, prices, stable, imported, importedPrices, logos],
  );
  const pay = useMemo(() => all.filter((t) => t.payMode !== "none"), [all]);
  const byKey = useMemo(() => new Map(all.map((t) => [t.key, t])), [all]);
  return useMemo(
    () => ({all, pay, receive: all, byKey, prices, loading: balances.loading, refresh: balances.refresh}),
    [all, pay, byKey, prices, balances.loading, balances.refresh],
  );
}

/** EVM contract check for the recipient warning: cached 5 min per (chain, address); null while unknown or not EVM. */
export function useIsContract(caip2: string, address: string | null): boolean | null {
  const {data} = useQuery({
    queryKey: ["is-contract", caip2, address],
    enabled: !!address && caip2.startsWith("eip155:"),
    queryFn: () => isContractAddress(caip2, address!),
    staleTime: 300_000,
    retry: 1,
  });
  return data ?? null;
}

/** A failed read that asking again could change (a network failure) is retried once; the chain's own answer isn't. */
const retryRead = (failures: number, e: unknown): boolean => failures < 1 && !(e instanceof TokenReadError && e.definitive);

/**
 * The react-query options of an import's on-chain read (D39): key `["token-meta", caip2, address]` with the address
 * checksummed on EVM (`canonicalTokenAddress`), kept 10 min — the search result, the network chooser's reads, the
 * confirmation and a pair link share one read, however the address was spelled. Disabled while either is null.
 */
function lookupQuery(caip2: string | null, address: string | null) {
  const at = caip2 && address ? canonicalTokenAddress(caip2, address) : null;
  return {
    queryKey: ["token-meta", caip2, at],
    enabled: !!caip2 && !!at,
    queryFn: () => readTokenForImport(caip2!, at!),
    staleTime: 600_000,
    gcTime: 1_800_000,
    retry: retryRead,
    refetchOnWindowFocus: false,
  };
}

/** A read's state as the screens see it; a failure says whether a node couldn't be reached (asking again may help). */
function asLookup(enabled: boolean, data: Token | undefined, error: unknown): TokenLookup {
  if (!enabled) return {status: "idle"};
  if (data) return {status: "found", token: data};
  if (error) {
    const definitive = error instanceof TokenReadError && error.definitive;
    return {status: "failed", reason: error instanceof TokenReadError ? error.message : "Couldn't read this token — try again.", ...(definitive ? {} : {unreachable: true as const})};
  }
  return {status: "loading"};
}

/** An import's on-chain read (`lookupQuery`). Idle while either is null. A token found carries its logo once that arrives (by contract). */
export function useTokenLookup(caip2: string | null, address: string | null): TokenLookup {
  const q = lookupQuery(caip2, address);
  const {data, error} = useQuery(q);
  const found = useMemo(() => (q.enabled && data ? [data] : []), [q.enabled, data]);
  const logos = useImportedLogos(found);
  return useMemo((): TokenLookup => {
    const l = asLookup(q.enabled, data, error);
    return l.status === "found" ? {status: "found", token: withLogos([l.token], logos)[0]!} : l;
  }, [q.enabled, data, error, logos]);
}

/** Module-level (a stable `combine`): the same object until a read changes. */
const lookupsOf = (results: UseQueryResult<Token>[]): TokenLookups => ({
  lookups: results.map((r) => asLookup(r.fetchStatus !== "idle" || r.status !== "pending", r.data, r.error)),
  retry: () => {
    for (const r of results) if (r.error && !(r.error instanceof TokenReadError && r.error.definitive)) void r.refetch();
  },
});

/**
 * One pasted contract read on every network given (D39: where it is a token), each read `lookupQuery`'s own — what the
 * network chooser lists, and the chosen network's result and confirmation read nothing again.
 */
export function useTokenLookups(caip2s: readonly string[], address: string | null): TokenLookups {
  return useQueries({queries: caip2s.map((c) => lookupQuery(c, address)), combine: lookupsOf});
}

/** The real catalog port (App.tsx's realPorts). */
export const catalogPort: CatalogPort = {
  useChains: () => CHAIN_LIST,
  useTokens: () => TOKENS,
  useBalances,
  usePrices,
  useSwapTokens,
  useIsContract,
  useTokenLookup,
  useTokenLookups,
  importToken: addImportedToken,
  removeImportedToken,
};
