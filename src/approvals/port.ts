/**
 * The approvals port (D46): scans an address on every EVM network the page lists, CONCURRENCY at a time, each shown
 * as soon as it answers, and keeps the list per network so a revoke re-reads only its own. A new address, a rescan or
 * unmount drops what is in flight for the old one (each run has its own switch).
 */
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {getAddress, isAddress} from "viem";
import type {ApprovalRow, ApprovalsPort, ApprovalsState, ChainScan, ScannedApproval} from "../contracts/approvals";
import type {Chain, Token} from "../contracts/domain";
import {CHAIN_LIST, useImportedLogos, useImportedPrices} from "../catalog";
import {proxyEtherscanUrl, proxySettled} from "../config";
import {historySource, noSourceNote} from "./sources";

/** Etherscan's free daily limit for a network is spent (scan.ts PLAN_LIMIT_NOTE; here so the port needn't load the scan). */
const PLAN_LIMIT_NOTE = "Etherscan's free limit for this network is spent for today";

/** The scan and the approvals SDK load with the section's first scan, not with the page. */
const scanModule = () => import("./scan");

const CONCURRENCY = 4;
/** A network that hasn't answered in this long (its wait for the paced Etherscan turn included) is shown as unread. */
const CHAIN_TIMEOUT_MS = 90_000;

const withDeadline = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });

const evmChains = (): Chain[] => CHAIN_LIST.filter((c) => c.family === "evm" && typeof c.chainId === "number");
const queuedChains = (): ChainScan[] => evmChains().map((c) => ({caip2: c.caip2, name: c.name, status: "queued"}));

interface ChainResult {
  rows: ApprovalRow[];
  approvals: ScannedApproval[];
}

interface Run {
  owner: string;
  n: number;
  fresh: boolean;
}

/** One run's switch: its results stop landing once a newer run (or unmount) turns it off. */
type RunSwitch = {off: boolean};
/** The run whose results land now, and its address: a network's rescan after a revoke joins it. */
type Current = {token: RunSwitch; owner: string | null};

/** An error's first line, without URLs (an RPC's may carry a key; its request body, the address). */
const errorLine = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e))
    .split("\n")[0]!
    .replace(/https?:\/\/\S+/g, "<url>")
    .slice(0, 160);

/** Every approval the last scan found on one network (execute's revoke takes them as its targets). */
export const scannedOn = (rows: readonly ApprovalRow[], caip2: string): ScannedApproval[] => rows.filter((r) => r.caip2 === caip2).map((r) => r.approval);

/** An EVM address as given, checksummed; null for anything else. */
export const evmOwner = (text: string | null): string | null => (text && isAddress(text.trim(), {strict: false}) ? getAddress(text.trim()) : null);

function useApprovals(ownerInput: string | null): ReturnType<ApprovalsPort["useApprovals"]> {
  const owner = evmOwner(ownerInput);
  const [run, setRun] = useState<Run | null>(() => (owner ? {owner, n: 1, fresh: false} : null));
  const [chains, setChains] = useState<readonly ChainScan[]>(() => (owner ? queuedChains() : []));
  const [results, setResults] = useState<Readonly<Record<string, ChainResult>>>({});
  const current = useRef<Current>({token: {off: true}, owner: null});
  // Each network's latest scan: an older one (a full scan's, a rescan's) that answers later never lands over it.
  const latest = useRef(new Map<string, number>());

  // Another address: a scan of its own, from a clean list (state set while rendering, not in an effect).
  const [seen, setSeen] = useState(owner);
  if (owner !== seen) {
    setSeen(owner);
    setRun(owner ? {owner, n: (run?.n ?? 0) + 1, fresh: false} : null);
    setChains(owner ? queuedChains() : []);
    setResults({});
  }

  const scanOne = useCallback(async (token: RunSwitch, address: string, chain: Chain, etherscanUrl: string | null) => {
    const n = (latest.current.get(chain.caip2) ?? 0) + 1;
    latest.current.set(chain.caip2, n);
    const live = () => !token.off && latest.current.get(chain.caip2) === n;
    const patch = (c: Partial<ChainScan>) => {
      if (live()) setChains((all) => all.map((x) => (x.caip2 === chain.caip2 ? {...x, ...c} : x)));
    };
    const source = historySource(chain.chainId!, etherscanUrl);
    if (!source) {
      patch({status: "unsupported", note: noSourceNote(chain.chainId!, etherscanUrl)});
      return;
    }
    patch({status: "scanning", source: source.kind});
    try {
      const r = await withDeadline((await scanModule()).scanChain(chain, address, source), CHAIN_TIMEOUT_MS);
      if (!live()) return;
      setResults((all) => ({...all, [chain.caip2]: {rows: r.rows, approvals: r.approvals}}));
      patch({status: "done", count: r.rows.length, ...(r.complete ? {note: undefined} : {note: "Part of the history couldn't be read"})});
    } catch (e) {
      // No backend: an incident goes to the console only (no address).
      console.warn("approvals scan failed", {chain: chain.name, source: source.kind, error: errorLine(e)});
      // The module's words for a 429 that waits too long: here only Etherscan's spent daily plan limit (scan.ts).
      const planLimit = source.kind === "etherscan" && /rate limit reached/i.test(errorLine(e));
      patch({status: "failed", note: planLimit ? PLAN_LIMIT_NOTE : "Couldn't read this network — try again"});
    }
  }, []);

  useEffect(() => {
    if (!run) return;
    const token: RunSwitch = {off: false};
    current.current = {token, owner: run.owner};
    void (async () => {
      await proxySettled();
      const etherscanUrl = proxyEtherscanUrl();
      const list = evmChains();
      if (run.fresh) {
        const {forgetHistory} = await scanModule();
        for (const c of list) forgetHistory(c.chainId!, run.owner);
      }
      const queue = [...list];
      const worker = async () => {
        for (let c = queue.shift(); c && !token.off; c = queue.shift()) await scanOne(token, run.owner, c, etherscanUrl);
      };
      await Promise.all(Array.from({length: CONCURRENCY}, worker));
    })();
    return () => {
      token.off = true;
    };
  }, [run, scanOne]);

  const rescan = useCallback(
    (fresh = false) => {
      if (!run) return;
      setRun({owner: run.owner, n: run.n + 1, fresh});
      setChains(queuedChains());
      setResults({});
    },
    [run],
  );
  // The address scanned NOW, not the one the caller saw: a revoke that lands after the address changed rescans the new
  // one's network (its results are its own), never the old address's into the new list.
  const rescanChain = useCallback(
    (caip2: string) => {
      const chain = evmChains().find((c) => c.caip2 === caip2);
      const {token, owner: now} = current.current;
      if (!chain || !now || token.off) return;
      void scanOne(token, now, chain, proxyEtherscanUrl());
    },
    [scanOne],
  );

  const rows = useMemo(() => Object.values(results).flatMap((r) => r.rows), [results]);
  // Every token priced by its contract (a listed one too: DefiLlama answers by contract); logos only for the read ones.
  const tokens = useMemo(() => {
    const byKey = new Map(rows.flatMap((r) => (r.token ? [[r.token.key, r.token] as const] : [])));
    return [...byKey.values()];
  }, [rows]);
  const priced = useMemo(() => tokens.map((t): Token => (t.imported ? t : ({...t, imported: true} as Token))), [tokens]);
  const read = useMemo(() => tokens.filter((t) => t.imported), [tokens]);
  const prices = useImportedPrices(priced);
  const logos = useImportedLogos(read);

  const state = useMemo(
    (): ApprovalsState => ({owner: run?.owner ?? null, chains, rows, scanning: chains.some((c) => c.status === "queued" || c.status === "scanning"), prices, logos}),
    [rows, chains, run, prices, logos],
  );

  return {...state, rescan, rescanChain};
}

export const approvalsPort: ApprovalsPort = {useApprovals};
