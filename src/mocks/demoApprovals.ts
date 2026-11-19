/**
 * Demo approvals (D46): a fixed scan of the demo wallet — offline like every demo port — and a revoke that "lands"
 * after a moment and drops its row on the network's rescan.
 */
import {useCallback, useMemo, useState} from "react";
import type {ApprovalRow, ApprovalsPort, ApprovalsState, ChainScan, RevokeInput, ScannedApproval} from "../contracts/approvals";
import type {Token} from "../contracts/domain";
import {CHAIN_LIST, TOKENS} from "../catalog";
import {DEMO_EVM_ADDRESS} from "./fixtures";

const MAX = 2n ** 256n - 1n;
const DEMO_PRICES: Readonly<Record<string, number>> = {USDT: 1, USDC: 1, WETH: 3_480};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const token = (caip2: string, symbol: string): Token | null => TOKENS.find((t) => t.caip2 === caip2 && t.symbol === symbol && !!t.contract) ?? null;

function row(caip2: string, a: Omit<ScannedApproval, "id" | "chainId" | "risks"> & {risks?: string[]}, extra: Pick<ApprovalRow, "token" | "balance" | "spenderName" | "verified" | "collection">): ApprovalRow {
  const chain = CHAIN_LIST.find((c) => c.caip2 === caip2)!;
  const approval: ScannedApproval = {
    ...a,
    id: `${chain.chainId}:${a.standard}:${a.token.toLowerCase()}:${a.spender.toLowerCase()}`,
    chainId: chain.chainId!,
    risks: a.risks ?? (a.unlimited ? ["unlimited"] : []),
  };
  return {approval, caip2, chainName: chain.name, ...extra};
}

/** The demo wallet's approvals: one of each kind the list shows. */
export function demoApprovalRows(): ApprovalRow[] {
  const usdt = token("eip155:1", "USDT");
  const usdc = token("eip155:8453", "USDC");
  const weth = token("eip155:42161", "WETH") ?? token("eip155:42161", "USDC");
  return [
    row(
      "eip155:1",
      {standard: "erc20", token: usdt?.contract ?? "0xdAC17F958D2ee523a2206206994597C13D831ec7", spender: "0x9a3c5f40cE0c5B2a3eD8B0b4C1aE2f3A9B1d7e01", amount: MAX, unlimited: true, risks: ["unlimited", "eoa-spender"]},
      {token: usdt, balance: 2_450_000_000n, spenderName: null, verified: false},
    ),
    row(
      "eip155:8453",
      {standard: "erc20", token: usdc?.contract ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", spender: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", amount: MAX, unlimited: true},
      {token: usdc, balance: 812_400_000n, spenderName: "LI.FI", verified: true},
    ),
    row(
      "eip155:42161",
      {standard: "permit2", token: weth?.contract ?? "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", spender: "0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3", amount: 500_000_000_000_000_000n, unlimited: false, expiration: 1_800_000_000},
      {token: weth, balance: 1_200_000_000_000_000_000n, spenderName: "Uniswap", verified: true},
    ),
    row(
      "eip155:1",
      {standard: "erc721", token: "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D", spender: "0x1E0049783F008A0085193E00003D00cd54003c71", amount: null, unlimited: true},
      {token: null, balance: null, spenderName: "OpenSea Conduit", verified: false, collection: "BoredApeYachtClub"},
    ),
  ];
}

/** Revoked in this demo page (by approval id). */
const revoked = new Set<string>();

function useDemoApprovals(owner: string | null): ReturnType<ApprovalsPort["useApprovals"]> {
  const [tick, setTick] = useState(0);
  const state = useMemo((): ApprovalsState => {
    void tick;
    if (!owner) return {owner: null, chains: [], rows: [], scanning: false, prices: {}, logos: {}};
    const rows = owner.toLowerCase() === DEMO_EVM_ADDRESS.toLowerCase() ? demoApprovalRows().filter((r) => !revoked.has(r.approval.id)) : [];
    const chains: ChainScan[] = CHAIN_LIST.filter((c) => c.family === "evm").map((c) =>
      c.caip2 === "eip155:56"
        ? {caip2: c.caip2, name: c.name, status: "unsupported", note: "No free history source yet"}
        : {caip2: c.caip2, name: c.name, status: "done", source: "blockscout", count: rows.filter((r) => r.caip2 === c.caip2).length},
    );
    const prices = Object.fromEntries(rows.flatMap((r) => (r.token ? [[r.token.key, DEMO_PRICES[r.token.symbol] ?? 1] as const] : [])));
    return {owner, chains, rows, scanning: false, prices, logos: {}};
  }, [owner, tick]);
  const rescan = useCallback(() => setTick((t) => t + 1), []);
  return {...state, rescan, rescanChain: rescan};
}

export const demoApprovalsPort: ApprovalsPort = {useApprovals: useDemoApprovals};

/** The demo revoke: no wallet; "mined" after a moment. */
export async function demoRevoke(input: RevokeInput): Promise<{hash: string}> {
  await sleep(900);
  revoked.add(input.approval.id);
  return {hash: `0x${"ab".repeat(32)}`};
}

/** Tests: every demo approval back. */
export const resetDemoApprovals = (): void => revoked.clear();
