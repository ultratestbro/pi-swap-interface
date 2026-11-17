// Ported from cp0x-elysium apps/mobile/lib/swap/math.test.ts @756b115 (import paths changed).
import {describe, expect, it} from "vitest";
import {
  balanceProblem,
  etaLabel,
  gasBound,
  executionFloor,
  formatRate,
  gasReserve,
  impliedSlippagePct,
  maxSwappable,
  trimNativeMax,
  minWithSlippage,
  autoSlippageBps,
  floorToleranceBps,
  rate,
  parsePastedAmount,
  sanitizeAmountInput,
  slippageLabel,
} from "../../../src/swap/math";

describe("parsePastedAmount (web: a pasted number is read whole)", () => {
  const ok = (t: string, d = 6) => {
    const r = parsePastedAmount(t, d);
    return r.ok ? r.text : `refused: ${r.reason}`;
  };
  it("reads grouping and the decimal point the way people copy them", () => {
    expect(ok("1,234.56")).toBe("1234.56"); // this app's own balance format
    expect(ok("1.234,56")).toBe("1234.56");
    expect(ok("1 234,56")).toBe("1234.56");
    expect(ok("1 234,56")).toBe("1234.56");
    expect(ok("$1,250.42")).toBe("1250.42");
    expect(ok("1,000,000")).toBe("1000000");
    expect(ok("1.000.000")).toBe("1000000");
    expect(ok("1'234.5")).toBe("1234.5");
    expect(ok("1,5")).toBe("1.5");
    expect(ok("0,125")).toBe("0.125");
    expect(ok("1.234")).toBe("1.234");
    expect(ok(".5")).toBe("0.5");
    expect(ok("0.1234567", 6)).toBe("0.123456");
  });
  it("refuses what it would have to guess, instead of shrinking it 1000×", () => {
    expect(ok("1,000")).toMatch(/^refused: Is that 1000 or 1.000\?/);
    expect(ok("1e3")).toBe("refused: Paste a plain number, like 1234.56");
    expect(ok("12 USDC")).toMatch(/^refused/);
    expect(ok("1.2.3")).toMatch(/^refused/);
    expect(ok("12,34,567")).toMatch(/^refused/);
    expect(ok("")).toMatch(/^refused/);
  });
});

describe("sanitizeAmountInput", () => {
  it("keeps a plain decimal", () => {
    expect(sanitizeAmountInput("1.25", 6)).toBe("1.25");
    expect(sanitizeAmountInput("", 6)).toBe("");
  });
  it("takes a comma as the decimal point and drops other characters", () => {
    expect(sanitizeAmountInput("1,5", 18)).toBe("1.5");
    expect(sanitizeAmountInput(" $1 000.5 ", 18)).toBe("1000.5");
  });
  it("keeps one dot and caps the fraction at the token's decimals", () => {
    expect(sanitizeAmountInput("1.2.3", 18)).toBe("1.23");
    expect(sanitizeAmountInput("0.1234567", 6)).toBe("0.123456");
    expect(sanitizeAmountInput("5.5", 0)).toBe("5");
  });
  it("normalizes leading zeros and a bare dot", () => {
    expect(sanitizeAmountInput("007", 6)).toBe("7");
    expect(sanitizeAmountInput("00.5", 6)).toBe("0.5");
    expect(sanitizeAmountInput(".", 6)).toBe("0.");
    expect(sanitizeAmountInput("0", 6)).toBe("0");
  });
  it("caps integer digits", () => {
    expect(sanitizeAmountInput("1".repeat(20), 6)).toHaveLength(15);
  });
});

describe("slippage", () => {
  it("web: auto is always a preset — 0.05% on one network between liquid tokens, 0.3% otherwise", () => {
    // One network, both liquid (stables, majors and their wrappers / staked forms): 0.05 %.
    expect(autoSlippageBps("ETH", "usdc", true)).toBe(5);
    expect(autoSlippageBps("WETH", "wstETH", true)).toBe(5);
    expect(autoSlippageBps("USDC", "DAI", true)).toBe(5);
    expect(autoSlippageBps("WBTC", "cbBTC", true)).toBe(5);
    // Across networks, or a long-tail token: 0.3 %.
    expect(autoSlippageBps("USDC", "USDT")).toBe(30);
    expect(autoSlippageBps("ETH", "SOL")).toBe(30);
    expect(autoSlippageBps("ETH", "PEPE", true)).toBe(30);
    expect(autoSlippageBps("SSV", "SOL")).toBe(30);
    for (const [a, b, same] of [["ETH", "USDC", true], ["ETH", "PEPE", false]] as const) expect([1, 5, 30]).toContain(autoSlippageBps(a, b, same));
  });
  it("web: the execution margin never exceeds the slippage, and stays 0.5% at or above it", () => {
    expect(floorToleranceBps(5)).toBe(5n);
    expect(floorToleranceBps(30)).toBe(30n);
    expect(floorToleranceBps(50)).toBe(50n);
    expect(floorToleranceBps(100)).toBe(50n);
    expect(floorToleranceBps(0)).toBe(1n);
  });
  it("labels", () => {
    expect(slippageLabel(50)).toBe("0.5%");
    expect(slippageLabel(100)).toBe("1%");
    expect(slippageLabel(300)).toBe("3%");
  });
  it("min with slippage floors in base units", () => {
    expect(minWithSlippage(1_000_000n, 50)).toBe(995_000n);
    expect(minWithSlippage(999n, 50)).toBe(994n);
  });
  it("implied slippage between expected and guaranteed output", () => {
    expect(impliedSlippagePct(1_000_000n, 995_000n)).toBeCloseTo(0.5);
    expect(impliedSlippagePct(100n, 100n)).toBe(0);
    expect(impliedSlippagePct(0n, 0n)).toBe(0);
  });
});

describe("executionFloor", () => {
  it("takes 50 bps off the reviewed minimum", () => {
    expect(executionFloor(1_000_000n)).toBe(995_000n);
    expect(executionFloor(99_989_000n)).toBe(99_489_055n);
  });
  it("never rounds a tiny minimum to zero", () => {
    expect(executionFloor(1n)).toBe(1n);
    expect(executionFloor(0n)).toBe(0n);
  });
});

describe("rate / formatRate", () => {
  it("is units out per unit in", () => {
    expect(rate(10n ** 16n, 18, 23_814_531n, 6)).toBeCloseTo(2381.4531);
    expect(rate(0n, 18, 1n, 6)).toBeNull();
  });
  it("formats", () => {
    expect(formatRate(2381.4531)).toBe("2,381");
    expect(formatRate(0.000412345)).toBe("0.0004123");
    expect(formatRate(1)).toBe("1");
    expect(formatRate(NaN)).toBe("—");
  });
});

describe("etaLabel", () => {
  it("seconds, minutes, hours", () => {
    expect(etaLabel(8)).toBe("~8 s");
    expect(etaLabel(0)).toBe("—");
    expect(etaLabel(180)).toBe("~3 min");
    expect(etaLabel(812)).toBe("~14 min");
    expect(etaLabel(7200)).toBe("~2 h");
    expect(etaLabel(undefined)).toBe("—");
    expect(gasBound(0.004)).toBe("gas < $0.01");
    expect(gasBound(0.01)).toBe("gas ≤ $0.01");
    expect(gasBound(1.234)).toBe("gas ≤ $1.23");
  });
});

describe("MAX", () => {
  it("a token swaps its whole balance", () => {
    expect(maxSwappable(5_000_000n, false, 123n)).toBe(5_000_000n);
  });
  it("a native coin keeps the gas reserve, never negative", () => {
    expect(maxSwappable(10n ** 18n, true, 4n * 10n ** 15n)).toBe(996n * 10n ** 15n);
    expect(maxSwappable(10n, true, 100n)).toBe(0n);
  });
  it("web: a native MAX is cut to 6 decimals (3 significant digits below that), always rounded down", () => {
    expect(trimNativeMax(5_883_953_566_923_123n, 18)).toBe(5_883_000_000_000_000n); // 0.005883953566923123 → 0.005883
    expect(trimNativeMax(12_345_678_901_234n, 18)).toBe(12_300_000_000_000n); // 0.000012345678901234 → 0.0000123
    expect(trimNativeMax(12_345_678_912_345_678_901_234n, 18)).toBe(12_345_678_912_000_000_000_000n); // 12345.678912…
    expect(trimNativeMax(1_234_567n, 6)).toBe(1_234_567n); // 6 decimals or fewer: nothing to cut
    expect(trimNativeMax(0n, 18)).toBe(0n);
  });
  it("reserves per network", () => {
    expect(gasReserve("evm", "ETH", 18, 1)).toBe(4n * 10n ** 15n);
    expect(gasReserve("evm", "ETH", 18, 8453)).toBe(4n * 10n ** 14n);
    expect(gasReserve("evm", "BNB", 18, 56)).toBe(2n * 10n ** 15n);
    expect(gasReserve("evm", "S", 18, 146)).toBe(5n * 10n ** 16n);
    expect(gasReserve("solana", "SOL", 9)).toBe(10_000_000n);
    expect(gasReserve("ton", "TON", 9)).toBe(300_000_000n);
    expect(gasReserve("tron", "TRX", 6)).toBe(3_000_000n);
    expect(gasReserve("btc", "BTC", 8)).toBe(10_000n);
    expect(gasReserve("near", "NEAR", 24)).toBe(5n * 10n ** 22n);
  });
});

describe("balanceProblem", () => {
  it("flags only an amount above the balance", () => {
    expect(balanceProblem(null, 0n)).toBeNull();
    expect(balanceProblem(0n, 0n)).toBeNull();
    expect(balanceProblem(5n, 5n)).toBeNull();
    expect(balanceProblem(6n, 5n)).toBe("Insufficient balance");
    expect(balanceProblem(1n, 0n)).toBe("Insufficient balance");
  });
});
