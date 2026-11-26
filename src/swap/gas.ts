// Copied from cp0x-elysium apps/mobile/lib/swap/gas.ts @756b115, plus gasless orders (CoW, D48).
/**
 * What a route costs in source-chain gas, for the auction and the route list.
 * The router ranked routes on their guaranteed output alone, so on Ethereum a
 * route a cent better in price but dollars dearer in gas could be "Best". Each
 * EVM quote names its transaction's gas limit (an upper bound — shown as
 * "gas ≤ $x"); a deposit-address route is a plain transfer; a token source
 * that names a spender adds an approval. Non-EVM sources pay cents — counted
 * as 0 so they still rank on price. Pure — unit-tested in gas.test.ts.
 */

/** approve(spender, amount) on a typical ERC-20 (USDT's reset-to-0 is a second one, not counted). */
export const APPROVE_GAS = 55_000n;
export const NATIVE_TRANSFER_GAS = 21_000n;
export const TOKEN_TRANSFER_GAS = 65_000n;
/** A contract call whose quote names no limit. */
export const CALL_GAS = 200_000n;

export interface QuoteGasLike {
  txRequest?: {gasLimit?: string; approvalAddress?: string; to?: string} | undefined;
  /** swap2-core 0.17.0: the user signs the source leg and a solver sends it (a CoW order): no swap gas. */
  gasless?: boolean;
  /** A gasless order's spender (CoW's vault relayer) and whether a gas-free EIP-2612 permit replaces its approval ("offered" | "none"). */
  providerData?: {approvalAddress?: string; permit?: string} | undefined;
}

/**
 * Gas units the route's source transactions take at most (approval included when the route names a spender). A
 * gasless order (CoW, D48) costs the user nothing but its approval, which a permit the token offers spares too.
 */
export function routeGasUnits(q: QuoteGasLike, sourceIsToken: boolean): bigint {
  const t = q.txRequest;
  if (q.gasless && !t) return sourceIsToken && q.providerData?.permit !== "offered" ? APPROVE_GAS : 0n;
  const limit = t?.gasLimit && /^\d+$/.test(t.gasLimit) ? BigInt(t.gasLimit) : null;
  const main = limit ?? (t?.to ? CALL_GAS : sourceIsToken ? TOKEN_TRANSFER_GAS : NATIVE_TRANSFER_GAS);
  // A dry quote without its transaction may name its spender in providerData (KyberSwap's route, D52): still an approval.
  return main + (sourceIsToken && (t?.approvalAddress ?? q.providerData?.approvalAddress) ? APPROVE_GAS : 0n);
}

/** Gas units × gas price (wei) in USD at the native coin's price. */
export function gasCostUsd(units: bigint, gasPriceWei: bigint, nativeUsd: number, nativeDecimals = 18): number {
  const wei = units * gasPriceWei;
  return (Number(wei) / 10 ** nativeDecimals) * nativeUsd;
}

/**
 * The auction's gas term for one request: USD per quote, or 0 when the source
 * isn't EVM or the gas / native price is unknown (ranking then stays on price —
 * a null would make the router drop USD values for the whole list).
 */
export function gasPricer(source: {evm: boolean; isToken: boolean}, gasPriceWei: bigint | null, nativeUsd: number | undefined) {
  return (q: QuoteGasLike): number =>
    source.evm && gasPriceWei !== null && nativeUsd !== undefined && nativeUsd > 0 ? gasCostUsd(routeGasUnits(q, source.isToken), gasPriceWei, nativeUsd) : 0;
}

/**
 * How the router orders routes: within 0.05 % of the best net value (after gas)
 * routes tie on price and the faster wins. The SDK's per-provider
 * "reliability" hints are hand-set constants, not measured — weighted 0.
 */
export const ROUTER_RANKING = {weights: "price:0.7,speed:0.3,reliability:0", tieBand: 0.0005} as const;
