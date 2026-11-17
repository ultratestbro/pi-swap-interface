// A bridge fee charged on top of the amount (Stargate's LayerZero fee) comes out of the native balance with the network
// fee — and with the amount itself from a native source. The review says what's missing and keeps Confirm off, instead
// of letting the node refuse the send ("The total cost (gas * gas fee + value) … exceeds the balance of the account").
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {cleanup, render, screen} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {DEFAULT_RUNTIME_CONFIG, PortsProvider, setRuntimeConfig} from "../../../src/config";
import type {AppPorts} from "../../../src/contracts/ports";
import type {WebRoute} from "../../../src/contracts/routes";
import type {SwapToken} from "../../../src/contracts/domain";
import {swapErrorText, swapFailureExpected} from "../../../src/execute/errors";
import {DEMO_EVM_ADDRESS, demoPorts, demoSnapshot, demoSwapTokens} from "../../../src/mocks";
import {ReviewSheet} from "../../../src/screens/review/ReviewSheet";
import {gasInNative, nativeShortfall} from "../../../src/swap";

const ARB_ETH = "arbitrum:native";
const BASE_ETH = "base:native";
const FEE = 849_782_096_747_417n; // a live Arbitrum → Base Stargate quote's messaging fee cap, 2026-11-17
const AMOUNT = 1_906_000_000_000_000n; // the screenshot's 0.001906 ETH

const list = demoSwapTokens({evm: DEMO_EVM_ADDRESS});
const wallets = {evm: null, solana: null, tron: null, ton: null, near: null, owners: {}, options: [], connecting: null, pairingUri: null, error: null, connect: vi.fn(), disconnect: vi.fn()};

function renderReview(ethBalance: bigint, nativeFee = FEE) {
  const withBalance = list.map((t): SwapToken => (t.key === ARB_ETH ? {...t, balance: "loaded", amount: ethBalance.toString()} : t));
  const tokens = {all: withBalance, pay: withBalance, receive: withBalance, byKey: new Map(withBalance.map((t) => [t.key, t])), prices: {}, loading: false, refresh: () => {}};
  const from = tokens.byKey.get(ARB_ETH)!;
  const to = tokens.byKey.get(BASE_ETH)!;
  const req = {from, to, amountIn: AMOUNT, slippageBps: 30, recipient: DEMO_EVM_ADDRESS, refundAddress: DEMO_EVM_ADDRESS};
  const route: WebRoute = {
    ...demoSnapshot().routes[0]!,
    provider: "stargate",
    sourceAmount: AMOUNT,
    destAmount: 1_905_000_000_000_000n,
    minDestAmount: 1_905_000_000_000_000n,
    nativeFee,
    gasUsd: 0.004,
    approvalSpender: null,
    validUntilMs: Date.now() + 10 * 60_000,
  };
  const ports: AppPorts = {...demoPorts, swap: {...demoPorts.swap, useRequote: () => ({route, gone: null, failed: false, loading: false, refetch: () => {}})}};
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  render(
    <QueryClientProvider client={client}>
      <PortsProvider ports={ports}>
        <ReviewSheet open draft={{req, route}} tokens={tokens} wallets={wallets} slippage="Auto slippage 0.3%" onClose={() => {}} onShowStatus={() => {}} onTryAgain={() => {}} onConnect={() => {}} />
      </PortsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => setRuntimeConfig(DEFAULT_RUNTIME_CONFIG));
afterEach(cleanup);

describe("nativeShortfall", () => {
  it("counts the amount from a native source, the fee on top and the gas, against the native balance", () => {
    expect(nativeShortfall({amountIn: AMOUNT, sourceIsNative: true, nativeFee: FEE, gas: 0n, nativeBalance: 2_300_000_000_000_000n})).toBe(AMOUNT + FEE - 2_300_000_000_000_000n);
    expect(nativeShortfall({amountIn: AMOUNT, sourceIsNative: true, nativeFee: FEE, gas: 0n, nativeBalance: 3_000_000_000_000_000n})).toBe(0n);
    // An ERC-20 source: only the fee and the gas come out of the native balance.
    expect(nativeShortfall({amountIn: 25_000_000n, sourceIsNative: false, nativeFee: FEE, gas: 10n ** 12n, nativeBalance: 6n * 10n ** 14n})).toBe(FEE + 10n ** 12n - 6n * 10n ** 14n);
    // No fee on top: nothing here (the amount check and the wallet's own gas check stand).
    expect(nativeShortfall({amountIn: AMOUNT, sourceIsNative: true, nativeFee: 0n, gas: 10n ** 18n, nativeBalance: 0n})).toBe(0n);
  });
  it("gasInNative rounds a USD estimate up into base units, 0n when a number is missing", () => {
    expect(gasInNative(0.004, 1823, 18)).toBe(BigInt(Math.ceil((0.004 / 1823) * 1e18)));
    expect(gasInNative(null, 1823, 18)).toBe(0n);
    expect(gasInNative(0.004, undefined, 18)).toBe(0n);
  });
});

describe("the review with a bridge fee on top", () => {
  it("0.001906 ETH + Stargate's 0.00085 ETH fee from a 0.0023 ETH balance: says it's short and keeps Confirm off", () => {
    renderReview(2_300_000_000_000_000n);
    expect(screen.getByTestId("swap-review-problem").textContent).toBe("Not enough ETH: the bridge fee (0.0008 ETH) is paid on top of the amount — 0.0005 ETH short");
    expect((screen.getByTestId("swap-confirm") as HTMLButtonElement).disabled).toBe(true);
  });
  it("a balance that covers the amount and the fee leaves Confirm on", () => {
    renderReview(3_000_000_000_000_000n);
    expect(screen.queryByTestId("swap-review-problem")).toBeNull();
    expect((screen.getByTestId("swap-confirm") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the node's refusal of a send the balance can't cover", () => {
  it("reads as not enough of the native coin, an expected failure", () => {
    const e = new Error("The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.\n\nDetails: …");
    expect(swapErrorText(e, "ETH")).toBe("Not enough ETH for the amount, the bridge fee and the network fee — nothing was sent.");
    expect(swapFailureExpected(e)).toBe(true);
    expect(swapErrorText(new Error("insufficient funds for gas * price + value"), "BNB")).toMatch(/^Not enough BNB/);
  });
});
