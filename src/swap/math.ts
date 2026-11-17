// Copied from cp0x-elysium apps/mobile/lib/swap/math.ts @756b115 (verbatim), plus the web's parsePastedAmount ("web:").
/**
 * Swap amounts, exact: the pay field's text, base units as bigint, MAX with
 * a gas reserve for native coins, slippage and the execution floor. Floats
 * only for display (rate, USD). No React — unit-tested in math.test.ts.
 */
import {unitsToDecimal, type ChainFamily} from "@cp0x/shared";
import {formatUsd} from "../shared/format";

/** Integer digits the pay field accepts. */
const MAX_INT_DIGITS = 15;

/**
 * What the pay field keeps of what was typed or pasted: digits and one
 * decimal point ("," counts as one — a European keypad), no fraction past the
 * token's decimals, no leading zeros ("007" → "7", "." → "0.").
 */
export function sanitizeAmountInput(text: string, decimals: number): string {
  const t = text.replace(/,/g, ".").replace(/[^\d.]/g, "");
  const dot = t.indexOf(".");
  let int = dot === -1 ? t : t.slice(0, dot);
  let frac = dot === -1 ? undefined : t.slice(dot + 1).replace(/\./g, "");
  int = int.replace(/^0+(?=\d)/, "").slice(0, MAX_INT_DIGITS);
  if (frac === undefined || decimals === 0) return int;
  frac = frac.slice(0, decimals);
  return `${int || "0"}.${frac}`;
}

/** web: what a paste into the pay field became — the amount text, or why it was refused (the field keeps its value). */
export type PastedAmount = {ok: true; text: string} | {ok: false; reason: string};

const PASTE_PLAIN = "Paste a plain number, like 1234.56";

/** `1,234,567` / `1.234.567` / `1234`: the first group 1-3 digits, every other exactly 3. */
const grouped = (int: string, sep: string) => {
  const g = int.split(sep);
  return /^\d{1,3}$/.test(g[0]!) && g.slice(1).every((x) => /^\d{3}$/.test(x));
};

/**
 * web: a pasted (or dropped / autofilled) amount, read the way people copy numbers — not keystroke by keystroke like
 * sanitizeAmountInput, which turns every "," into "." and would read "1,234.56" (this app's own balance format) as
 * 1.23456. Grouping by spaces, apostrophes or the other separator is dropped; with both "," and "." the LAST one is
 * the decimal point; "1,234" alone is ambiguous and refused, as is anything with letters ("1e3", "12 USDC").
 */
export function parsePastedAmount(text: string, decimals: number): PastedAmount {
  const t = text.trim().replace(/[\s\u00a0\u202f'_’]/g, "").replace(/^[$€£¥]|[$€£¥]$/g, "");
  if (!t) return {ok: false, reason: PASTE_PLAIN};
  if (!/^(\d[\d.,]*|[.,]\d+)$/.test(t)) return {ok: false, reason: PASTE_PLAIN};
  const dots = t.split(".").length - 1;
  const commas = t.split(",").length - 1;
  let dec: "." | "," | null = null;
  if (dots && commas) dec = t.lastIndexOf(".") > t.lastIndexOf(",") ? "." : ",";
  else if (dots === 1) dec = ".";
  else if (commas === 1) {
    const at = t.indexOf(",");
    const int = t.slice(0, at);
    // "1,234": a thousands separator (en-US) or a decimal comma (most of Europe)? Don't guess with someone's money.
    if (t.length - at - 1 === 3 && int.length >= 1 && int.length <= 3 && int !== "0")
      return {ok: false, reason: `Is that ${t.replace(",", "")} or ${t.replace(",", ".")}? Type it with a "." for decimals`};
    dec = ",";
  }
  const at = dec ? t.lastIndexOf(dec) : -1;
  const int = at === -1 ? t : t.slice(0, at);
  const frac = at === -1 ? "" : t.slice(at + 1);
  const sep = dec === "." ? "," : dec === "," ? "." : dots ? "." : commas ? "," : "";
  if (sep && int.includes(sep) && !grouped(int, sep)) return {ok: false, reason: PASTE_PLAIN};
  if (/[.,]/.test(frac)) return {ok: false, reason: PASTE_PLAIN};
  const plain = `${(sep ? int.split(sep).join("") : int) || "0"}${at === -1 ? "" : `.${frac}`}`;
  return {ok: true, text: sanitizeAmountInput(plain, decimals)};
}

export const DEFAULT_SLIPPAGE_BPS = 50;

const STABLES = new Set(["USDT", "USDC", "DAI", "USDE", "USDT0", "USDC.E", "USDBC", "PYUSD", "USDG", "USDS", "FDUSD", "TUSD", "USD1", "AUSD", "FRAX", "GHO", "LUSD"]);
const MAJORS = new Set(["ETH", "WETH", "STETH", "WSTETH", "CBETH", "RETH", "WEETH", "BTC", "WBTC", "CBBTC", "BTCB", "TBTC", "SOL", "JITOSOL", "MSOL", "BNB", "WBNB", "TON", "TRX", "POL", "AVAX", "ARB", "OP"]);

/**
 * Auto slippage for a pair — web (owner, 2026-11-15): always one of the presets. 0.05% on one network when both sides
 * are liquid (USD stables, majors and their wrappers / liquid-staking forms: ETH → USDC, WETH → wstETH, USDC → DAI),
 * the market's usual default; 0.3% otherwise — across networks (a bridge or an intent is filled over minutes, not one
 * block) or with a long-tail token. A pair that needs more takes a custom value. (Mobile: 0.3% for two stables, 0.5%
 * for majors, 1% for anything else.)
 */
export function autoSlippageBps(fromSymbol: string, toSymbol: string, sameChain = false): number {
  const liquid = (s: string) => STABLES.has(s.toUpperCase()) || MAJORS.has(s.toUpperCase());
  return sameChain && liquid(fromSymbol) && liquid(toSymbol) ? 5 : 30;
}

export const slippageLabel = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;

/**
 * How far the live execution quote may land below the minimum the user
 * reviewed (vaulty measured ~18 bps of drift while the user reads the review
 * and passes Face ID). The review shows the floored number as "Minimum
 * received", so the floor IS what was reviewed.
 */
export const FLOOR_TOLERANCE_BPS = 50n;

/**
 * web: the execution margin for a slippage setting — FLOOR_TOLERANCE, but never more than the slippage itself: at
 * 0.05% a fixed 0.5% margin put the "minimum" 0.55% under the quote, eleven times what the user chose.
 */
export const floorToleranceBps = (slippageBps: number): bigint => {
  const bps = BigInt(Math.max(1, Math.round(slippageBps)));
  return bps < FLOOR_TOLERANCE_BPS ? bps : FLOOR_TOLERANCE_BPS;
};

export function executionFloor(minDest: bigint, toleranceBps: bigint = FLOOR_TOLERANCE_BPS): bigint {
  const floor = (minDest * (10_000n - toleranceBps)) / 10_000n;
  return floor > 0n ? floor : minDest;
}

/** Output a slippage tolerance guarantees for an expected amount (floor, never above it). */
export function minWithSlippage(expected: bigint, bps: number): bigint {
  return (expected * BigInt(10_000 - bps)) / 10_000n;
}

/** Slippage between expected and guaranteed output, percent (display). */
export function impliedSlippagePct(expected: bigint, min: bigint): number {
  if (expected <= 0n || min >= expected) return 0;
  return Number(((expected - min) * 1_000_000n) / expected) / 10_000;
}

/** Units of `out` per one unit of `in` (display only). Null when the input is zero. */
export function rate(amountIn: bigint, inDecimals: number, amountOut: bigint, outDecimals: number): number | null {
  if (amountIn <= 0n) return null;
  return (
    Number(unitsToDecimal(amountOut.toString(), outDecimals)) / Number(unitsToDecimal(amountIn.toString(), inDecimals))
  );
}

/** A rate for a row: 4 significant digits, grouped thousands for big numbers. */
export function formatRate(r: number): string {
  if (!Number.isFinite(r) || r <= 0) return "—";
  if (r >= 1000) return Math.round(r).toLocaleString("en-US");
  return Number(r.toPrecision(4)).toString();
}

/** The gas bound a route row and the review show: "gas ≤ $0.03", or "gas < $0.01" under a cent (not "≤ <$0.01"). */
export function gasBound(usd: number): string {
  return usd < 0.01 ? "gas < $0.01" : `gas ≤ ${formatUsd(usd)}`;
}

/** "~40 s", "~3 min", "~1 h". */
export function etaLabel(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `~${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`;
  return `~${Math.round(seconds / 3600)} h`;
}

const units = (whole: string, decimals: number): bigint => {
  const [i = "0", f = ""] = whole.split(".");
  return BigInt(i + f.padEnd(decimals, "0").slice(0, decimals));
};

/**
 * Native coin MAX keeps back for the swap's own network fees (approval-free,
 * but a bridge call, a TON forward amount, a Solana ATA rent…). Generous on
 * purpose: an unspendable leftover beats a swap that can't pay its gas.
 */
export function gasReserve(family: ChainFamily, nativeSymbol: string, decimals: number, chainId?: number): bigint {
  switch (family) {
    case "evm":
      if (nativeSymbol === "ETH") return units(chainId === 1 ? "0.004" : "0.0004", decimals);
      return units(
        {BNB: "0.002", AVAX: "0.02", POL: "0.5", XDAI: "0.05", CELO: "0.1", HYPE: "0.02", MNT: "0.5", OKB: "0.005"}[
          nativeSymbol
        ] ?? "0.05",
        decimals,
      );
    case "solana":
      return units("0.01", decimals);
    case "ton":
      return units("0.3", decimals);
    case "tron":
      // Every TRX-source route is a plain transfer: ≤0.3 bandwidth + 1 memo fee + 1.1 activating a new deposit address.
      return units("3", decimals);
    case "btc":
      return units("0.0001", decimals);
    case "zcash":
      return units("0.001", decimals);
    case "near":
      return units("0.05", decimals);
  }
}

/** MAX for the pay side: a token's whole balance; a native coin's balance minus the gas reserve (never negative). */
export function maxSwappable(balance: bigint, isNative: boolean, reserve: bigint): bigint {
  if (!isNative) return balance;
  const left = balance - reserve;
  return left > 0n ? left : 0n;
}

/**
 * web: a native MAX cut to a readable length, rounded down so it only ever leaves more for gas: 6 decimals, or 3
 * significant digits when the amount is smaller than that (0.005883953566923 → 0.005883, 0.0000123456 → 0.0000123).
 * Tokens keep their exact balance (MAX of a token spends all of it).
 */
export function trimNativeMax(amount: bigint, decimals: number): bigint {
  if (amount <= 0n) return amount;
  const lead = decimals - amount.toString().length; // zeros between the point and the first significant digit
  const keep = Math.max(6, lead + 3);
  if (keep >= decimals) return amount;
  const step = 10n ** BigInt(decimals - keep);
  return (amount / step) * step;
}

/** Why the amount can't be swapped, or null (the pay field and the review). */
export function balanceProblem(amount: bigint | null, balance: bigint): string | null {
  if (amount === null || amount === 0n) return null;
  return amount > balance ? "Insufficient balance" : null;
}
