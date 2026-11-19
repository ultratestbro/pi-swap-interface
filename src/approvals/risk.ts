/**
 * What an approval puts at risk now (D46): for an ERC-20 or Permit2 allowance, the part of the owner's balance the
 * spender could take — the allowance, capped by the balance — and its value at the token's price. NFTs and a
 * delegation have no amount here; the list ranks them by their flags.
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

/** Most at risk first: by USD, then unlimited, then an EOA spender, then network and id (stable). */
export function sortRows(rows: readonly ApprovalRow[], prices: PriceMap): ApprovalRow[] {
  const score = (r: ApprovalRow) => usdAtRisk(r, prices) ?? -1;
  const flag = (r: ApprovalRow) => (r.approval.unlimited ? 2 : 0) + (r.approval.risks.includes("eoa-spender") ? 1 : 0);
  return [...rows].sort((a, b) => score(b) - score(a) || flag(b) - flag(a) || a.chainName.localeCompare(b.chainName) || a.approval.id.localeCompare(b.approval.id));
}
