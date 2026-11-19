/**
 * How big an approval is (D46; owner 2026-11-20: "показывать не амаунт на кошельке — а сумму аппрува, сколько
 * осталось"): an ERC-20 or Permit2 allowance's remaining amount at the token's price, or unlimited. What it puts at
 * risk now — the allowance capped by the owner's balance — is the summary's total. NFTs and a delegation have no
 * amount; the list ranks them by their flags.
 */
import type {ApprovalRow} from "../contracts/approvals";
import type {PriceMap} from "../contracts/domain";

/** Base units the spender could move today; null when unknown (no balance read, not a fungible token). */
export function atRiskUnits(r: ApprovalRow): bigint | null {
  if (r.balance === null || !r.token) return null;
  const allowance = r.approval.unlimited || r.approval.amount === null ? r.balance : r.approval.amount;
  return allowance < r.balance ? allowance : r.balance;
}

/** That amount in USD at `prices` (token key → USD); null without a price. */
export function usdAtRisk(r: ApprovalRow, prices: PriceMap): number | null {
  const units = atRiskUnits(r);
  const price = r.token ? prices[r.token.key] : undefined;
  if (units === null || price === undefined || !r.token) return null;
  return (Number(units) / 10 ** r.token.decimals) * price;
}

/** A capped allowance's remaining amount in USD; null when unlimited, not fungible or unpriced. */
export function allowanceUsd(r: ApprovalRow, prices: PriceMap): number | null {
  const a = r.approval;
  const price = r.token ? prices[r.token.key] : undefined;
  if (a.unlimited || a.amount === null || !r.token || price === undefined) return null;
  return (Number(a.amount) / 10 ** r.token.decimals) * price;
}

const fungible = (r: ApprovalRow): boolean => r.approval.standard === "erc20" || r.approval.standard === "permit2";

/**
 * Largest approval first: unlimited token allowances (the more of it the wallet holds, the higher), then capped ones by
 * what remains in USD, then NFT approvals and a delegation; a plain-address spender first among equals; then network
 * and id (stable).
 */
export function sortRows(rows: readonly ApprovalRow[], prices: PriceMap): ApprovalRow[] {
  const group = (r: ApprovalRow) => (!fungible(r) ? 2 : r.approval.unlimited ? 0 : 1);
  const size = (r: ApprovalRow) => (group(r) === 0 ? (usdAtRisk(r, prices) ?? -1) : group(r) === 1 ? (allowanceUsd(r, prices) ?? -1) : 0);
  const eoa = (r: ApprovalRow) => (r.approval.risks.includes("eoa-spender") ? 1 : 0);
  return [...rows].sort(
    (a, b) => group(a) - group(b) || size(b) - size(a) || eoa(b) - eoa(a) || a.chainName.localeCompare(b.chainName) || a.approval.id.localeCompare(b.approval.id),
  );
}

/**
 * What the spender could take now, as the list's "Value at risk" reads it: USD for a token (null without a price),
 * 0 for an NFT approval on a collection the owner holds none of, "unknown" for one it holds (no NFT prices here), null
 * for a delegation or an unread balance.
 */
export function valueAtRisk(r: ApprovalRow, prices: PriceMap): number | "unknown" | null {
  if (fungible(r)) return usdAtRisk(r, prices);
  if (r.approval.standard === "eip7702") return null;
  if (r.nftCount === 0n) return 0;
  return "unknown";
}

export type ApprovalsSort = "newest" | "risk" | "amount";

/** The list in the chosen order: newest approval first (the default), most value at risk first, or largest first. */
export function sortedRows(rows: readonly ApprovalRow[], prices: PriceMap, by: ApprovalsSort): ApprovalRow[] {
  if (by === "amount") return sortRows(rows, prices);
  const tie = (a: ApprovalRow, b: ApprovalRow) => a.chainName.localeCompare(b.chainName) || a.approval.id.localeCompare(b.approval.id);
  if (by === "risk") {
    const v = (r: ApprovalRow) => {
      const x = valueAtRisk(r, prices);
      return typeof x === "number" ? x : x === "unknown" ? -0.5 : -1;
    };
    return [...rows].sort((a, b) => v(b) - v(a) || tie(a, b));
  }
  return [...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || tie(a, b));
}
