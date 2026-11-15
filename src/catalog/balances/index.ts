/**
 * Balance orchestration (catalog.md §5.4): one react-query per (chain, owner) — the 31 EVM chains when an EVM
 * wallet is connected, Solana, Tron, TON or NEAR when a wallet of theirs is — so "held first" works across every
 * network like mobile, and each chain renders as soon as its own read lands. Keys `["bal", slug, owner]`: the
 * activity tracker invalidates `["bal"]` when a swap settles.
 */
import {useQueries, useQueryClient, type UseQueryResult} from "@tanstack/react-query";
import {useCallback, useMemo} from "react";
import type {Address} from "viem";
import type {Balance, Chain, Owners, Token} from "../../contracts/domain";
import type {BalancesState} from "../../contracts/ports";
import {publicClient} from "../evm";
import {useImportedTokens} from "../imported";
import {CHAIN_LIST} from "../network";
import {tokensOf} from "../tokens";
import {readEvmBalances, type BalanceRead} from "./evm";
import {readNearBalances} from "./near";
import {readSolanaBalances} from "./solana";
import {readTronBalances} from "./tron";
import {readTonBalances} from "./ton";

export {readEvmBalances, type BalanceRead, type MulticallClient} from "./evm";
export {readNearBalances} from "./near";
export {TOKEN_2022_MINTS, ataOf, readSolanaBalances} from "./solana";
export {readTronBalances} from "./tron";
export {readTonBalances} from "./ton";

/**
 * One balance read: a chain, the connected owner on its family, the tokens it covers — the chain's catalog tokens, or
 * (`imported`, D39) the tokens imported in this browser on it, read apart so an import never re-reads the catalog's.
 */
export type BalanceSpec = (
  | {family: "evm"; slug: string; chainId: number; owner: string; tokens: readonly Token[]}
  | {family: "solana"; slug: string; owner: string; tokens: readonly Token[]}
  | {family: "tron"; slug: string; owner: string; tokens: readonly Token[]}
  | {family: "ton"; slug: string; owner: string; tokens: readonly Token[]}
  | {family: "near"; slug: string; owner: string; tokens: readonly Token[]}
) & {imported?: true};

/** Base units as decimal strings (react-query data stays plain JSON); null = that token's read failed. */
export type WireBalances = Record<string, string | null>;

/**
 * The reads `owners` needs, in display order: each chain's catalog tokens, then, on EVM networks and Solana, the
 * imports on it (`imported`, D39). Families without a reader (BTC, ZEC…) are skipped.
 */
export function balanceSpecs(owners: Owners, chains: readonly Chain[] = CHAIN_LIST, imported: readonly Token[] = []): BalanceSpec[] {
  const out: BalanceSpec[] = [];
  for (const c of chains) {
    const tokens = tokensOf(c.slug);
    const mine = imported.filter((t) => t.chain === c.slug);
    if (c.family === "evm" && owners.evm && c.chainId !== undefined) {
      if (tokens.length) out.push({family: "evm", slug: c.slug, chainId: c.chainId, owner: owners.evm, tokens});
      if (mine.length) out.push({family: "evm", slug: c.slug, chainId: c.chainId, owner: owners.evm, tokens: mine, imported: true});
    }
    if (c.family === "solana" && owners.solana) {
      if (tokens.length) out.push({family: "solana", slug: c.slug, owner: owners.solana, tokens});
      if (mine.length) out.push({family: "solana", slug: c.slug, owner: owners.solana, tokens: mine, imported: true});
    }
    if (!tokens.length) continue;
    if (c.family === "tron" && owners.tron) out.push({family: "tron", slug: c.slug, owner: owners.tron, tokens});
    if (c.family === "ton" && owners.ton) out.push({family: "ton", slug: c.slug, owner: owners.ton, tokens});
    if (c.family === "near" && owners.near) out.push({family: "near", slug: c.slug, owner: owners.near, tokens});
  }
  return out;
}

/**
 * The react-query key of a read: `["bal", slug, owner]`, plus the imported keys for an imports read (D39) — a new
 * import is a new read, and the activity tracker's `["bal"]` invalidation still reaches every one.
 */
export const balanceKey = (s: Pick<BalanceSpec, "slug" | "owner" | "imported" | "tokens">): readonly string[] =>
  s.imported ? ["bal", s.slug, s.owner, "imported", ...s.tokens.map((t) => t.key)] : ["bal", s.slug, s.owner];

/** Runs one read against the network (our public clients / runtime Solana RPCs / runtime Tron API / the NEAR RPCs). */
export async function readBalances(spec: BalanceSpec): Promise<WireBalances> {
  const read: BalanceRead =
    spec.family === "evm"
      ? await readEvmBalances(publicClient(spec.chainId), spec.slug, spec.tokens, spec.owner as Address)
      : spec.family === "solana"
        ? await readSolanaBalances(spec.owner, spec.tokens)
        : spec.family === "tron"
          ? await readTronBalances(spec.owner, spec.tokens)
          : spec.family === "ton"
            ? await readTonBalances(spec.owner, spec.tokens)
            : await readNearBalances(spec.owner, spec.tokens);
  const out: WireBalances = {};
  for (const [k, v] of Object.entries(read)) out[k] = v === null ? null : v.toString();
  return out;
}

/** The query results the merge reads (a subset of UseQueryResult, so tests can pass plain objects). */
export type BalanceResult = Pick<UseQueryResult<WireBalances>, "data" | "isError" | "isPending">;

/**
 * Token key → balance over every read. Data wins (a failed refetch keeps the last good read); a null entry or a
 * failed first read is "error" (render "—", never 0, never block the swap on it); no answer yet is "loading".
 */
export function mergeBalances(specs: readonly BalanceSpec[], results: readonly BalanceResult[]): {byKey: Record<string, Balance>; loading: boolean} {
  const byKey: Record<string, Balance> = {};
  let loading = false;
  specs.forEach((spec, i) => {
    const r = results[i];
    const data = r?.data;
    if (!data && !r?.isError) loading = true;
    for (const t of spec.tokens) {
      if (data) {
        const v = data[t.key];
        byKey[t.key] = typeof v === "string" ? {amount: v, state: "loaded"} : {amount: "0", state: "error"};
      } else {
        byKey[t.key] = {amount: "0", state: r?.isError ? "error" : "loading"};
      }
    }
  });
  return {byKey, loading};
}

/**
 * catalogPort.useBalances: every connected family's catalog balances and those of the tokens imported in this browser
 * (D39), one stable `byKey` until a value changes.
 */
export function useBalances(owners: Owners): BalancesState {
  const qc = useQueryClient();
  const imported = useImportedTokens();
  const evm = owners.evm;
  const solana = owners.solana;
  const tron = owners.tron;
  const ton = owners.ton;
  const near = owners.near;
  const specs = useMemo(
    () =>
      balanceSpecs(
        {...(evm ? {evm} : {}), ...(solana ? {solana} : {}), ...(tron ? {tron} : {}), ...(ton ? {ton} : {}), ...(near ? {near} : {})},
        CHAIN_LIST,
        imported,
      ),
    [evm, solana, tron, ton, near, imported],
  );
  // react-query structurally shares the combined result, so `byKey` keeps its identity while the values do.
  const combine = useCallback((results: UseQueryResult<WireBalances>[]) => mergeBalances(specs, results), [specs]);
  const merged = useQueries({
    queries: specs.map((spec) => ({
      queryKey: balanceKey(spec),
      queryFn: () => readBalances(spec),
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: true,
    })),
    combine,
  });
  const refresh = useCallback(() => {
    void qc.invalidateQueries({queryKey: ["bal"]});
  }, [qc]);
  return useMemo(() => ({byKey: merged.byKey, loading: merged.loading, refresh}), [merged.byKey, merged.loading, refresh]);
}
