// Screens around the signing-safety fixes: an untracked maybe-sent swap is settled only by the viewer (never
// "Try again"), a smart-contract EVM wallet is never the silent default payout of another payer, and a preview
// price (D7) is never reviewable.
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {useMemo, type ReactNode} from "react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {DEFAULT_RUNTIME_CONFIG, PortsProvider, setRuntimeConfig} from "../../../src/config";
import type {SwapRecord} from "../../../src/contracts/activity";
import type {AppPorts} from "../../../src/contracts/ports";
import {INTERRUPTED_SIGNING_TEXT, newRecord} from "../../../src/activity";
import type {RoutesRequest, RoutesState, WebRoute} from "../../../src/contracts/routes";
import {DEMO_EVM_ADDRESS, demoPorts, demoSnapshot, demoSwapTokens, resetDemoState} from "../../../src/mocks";
import {SwapScreen} from "../../../src/screens";
import {StatusView} from "../../../src/screens/activity/StatusView";
import {ReviewSheet} from "../../../src/screens/review/ReviewSheet";
import {blockedLocalRpcs} from "../../../src/screens/settings/SettingsSheet";

function wrap(children: ReactNode, ports: AppPorts = demoPorts) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  return (
    <QueryClientProvider client={client}>
      <PortsProvider ports={ports}>{children}</PortsProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => setRuntimeConfig(DEFAULT_RUNTIME_CONFIG));
afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

const interrupted = (over: Partial<SwapRecord> = {}): SwapRecord => ({
  ...newRecord({
    id: "local.42",
    accountId: `evm:${DEMO_EVM_ADDRESS}`,
    provider: "lifi",
    from: {caip2: "eip155:42161", chain: "arbitrum", symbol: "USDC", decimals: 6, key: "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831"},
    to: {caip2: "eip155:8453", chain: "base", symbol: "USDC", decimals: 6, key: "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"},
    amountIn: 250_000_000n,
    expectedOut: 249_000_000n,
    minOut: 248_000_000n,
    recipient: DEMO_EVM_ADDRESS,
    maybeSent: true,
  }),
  localId: "local.42",
  error: INTERRUPTED_SIGNING_TEXT,
  ...over,
});

describe("an untracked maybe-sent swap (tab closed mid-signing, a lost wallet answer)", () => {
  it("offers no 'Try again' and no refresh — only 'Mark as not sent', after checking the wallet", () => {
    const markNotSent = vi.fn();
    const r = interrupted();
    const ports: AppPorts = {...demoPorts, activity: {...demoPorts.activity, useSwap: () => r, markNotSent}};
    const wallets = {evm: null, solana: null, tron: null, ton: null, near: null, owners: {}, options: [], connecting: null, pairingUri: null, error: null, connect: vi.fn(), disconnect: vi.fn()};
    render(wrap(<StatusView id="local.42" wallets={wallets} onClose={vi.fn()} onTryAgain={vi.fn()} onConnect={vi.fn()} />, ports));
    expect(screen.getByTestId("swap-status").textContent).toBe("Check your wallet");
    expect(screen.getByTestId("swap-status-detail").textContent).toBe(INTERRUPTED_SIGNING_TEXT);
    expect(screen.getByTestId("swap-status-detail").textContent).not.toMatch(/nothing was swapped|updates on its own/);
    expect(screen.queryByTestId("swap-try-again")).toBeNull();
    expect(screen.queryByTestId("swap-refresh-status")).toBeNull();
    fireEvent.click(screen.getByTestId("swap-mark-not-sent"));
    expect(markNotSent).toHaveBeenCalledWith("local.42");
  });
});

describe("a smart-contract EVM wallet as the default payout (D10)", () => {
  it("another payer (Solana) can't silently pay a contract account's address on the destination: the field is forced on", async () => {
    const ports: AppPorts = {
      ...demoPorts,
      catalog: {...demoPorts.catalog, useIsContract: (_caip2: string, address: string | null) => (address === DEMO_EVM_ADDRESS ? true : address ? false : null)},
    };
    history.replaceState(null, "", `/#/?demoWallets=both&pay=solana:native&receive=base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&amount=1`);
    resetDemoState();
    render(wrap(<SwapScreen />, ports));
    await waitFor(() => expect(screen.getByTestId("swap-recipient")).toBeTruthy());
    expect(screen.getByTestId("swap-recipient-sub").textContent).toMatch(/smart-contract account/);
    expect(screen.queryByTestId("swap-recipient-toggle")).toBeNull();
    expect((screen.getByTestId("swap-review") as HTMLButtonElement).textContent).toBe("Enter the Base address to swap");
  });

  it("the same wallet paying on EVM keeps its own default (the signer's contract check refuses it there)", async () => {
    const ports: AppPorts = {...demoPorts, catalog: {...demoPorts.catalog, useIsContract: () => true}};
    history.replaceState(null, "", `/#/?demoWallets=both&pay=arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831&receive=base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&amount=1`);
    resetDemoState();
    render(wrap(<SwapScreen />, ports));
    await waitFor(() => expect(screen.getByTestId("swap-recipient-toggle")).toBeTruthy());
    expect(screen.queryByTestId("swap-recipient")).toBeNull();
  });
});

describe("preview prices before a wallet (D7)", () => {
  const SLOW = {timeout: 4000};
  const ARB_USDC = "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
  const BASE_USDC = "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const cta = () => screen.getByTestId("swap-review") as HTMLButtonElement;

  it("no wallet + amount: preview rows, the connect CTA, and Enter on a route opens the wallets, never the review", async () => {
    history.replaceState(null, "", `/#/?demoWallets=none&pay=${ARB_USDC}&receive=${BASE_USDC}&amount=250`);
    resetDemoState();
    render(wrap(<SwapScreen />));
    const row = await screen.findByTestId("swap-route-cctp", {}, SLOW);
    expect(row.textContent).toContain("Preview");
    expect(row.textContent).toContain("≈");
    expect(screen.queryByTestId("swap-min-received")).toBeNull();
    expect(screen.getByTestId("swap-min-estimate")).toBeTruthy();
    expect(cta().textContent).toBe("Connect EVM wallet to swap");
    expect(cta().dataset.state).toBe("connect");
    // LI.FI isn't asked for this preview (no cp0x proxy carries it here): it waits for the live quote in a quiet group
    // of its own, never under "Didn't quote", its row saying what gets the quote.
    const deferred = await screen.findByTestId("swap-deferred-toggle", {}, SLOW);
    expect(deferred.textContent).toBe("Quoted after you connect (1)");
    expect(screen.queryByTestId("swap-refused-toggle")).toBeNull();
    fireEvent.click(deferred);
    expect(screen.getByRole("list", {name: "Quoted after you connect"}).textContent).toContain("Connect a wallet to get this quote");
    fireEvent.click(row);
    fireEvent.keyDown(screen.getByRole("radiogroup", {name: "Routes"}), {key: "Enter"});
    expect(screen.queryByTestId("swap-review-sheet")).toBeNull();
    expect(await screen.findByTestId("swap-connect")).toBeTruthy();
  });

  it("connecting clears the preview rows at once; the live round's routes are reviewable", async () => {
    history.replaceState(null, "", `/#/?demoWallets=none&pay=${ARB_USDC}&receive=${BASE_USDC}&amount=250`);
    resetDemoState();
    render(wrap(<SwapScreen />));
    await screen.findByTestId("swap-route-cctp", {}, SLOW);
    fireEvent.click(cta());
    fireEvent.click(await screen.findByTestId("swap-connect-io.metamask"));
    await waitFor(() => expect(cta().textContent).toMatch(/^Review via /), SLOW);
    expect(screen.getByTestId("swap-route-cctp").textContent).not.toContain("Preview");
    expect(screen.getByTestId("swap-min-received")).toBeTruthy();
  });

  it("a live request whose list is still a preview never opens the review", async () => {
    const stale = {...demoSnapshot(), mode: "preview" as const};
    const ports: AppPorts = {
      ...demoPorts,
      swap: {...demoPorts.swap, useRoutes: () => ({snapshot: stale, loading: false, error: null, updatedAt: 1, limitedUntil: 0, refresh: () => {}})},
    };
    history.replaceState(null, "", `/#/?pay=${ARB_USDC}&receive=${BASE_USDC}&amount=250`);
    resetDemoState();
    render(wrap(<SwapScreen />, ports));
    expect(cta().textContent).toBe("Getting your quote…");
    expect(cta().disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("radiogroup", {name: "Routes"}), {key: "Enter"});
    fireEvent.click(cta());
    expect(screen.queryByTestId("swap-review-sheet")).toBeNull();
  });
});

describe("a re-quote that fails over a held route (D32)", () => {
  const ARB_USDC = "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
  const BASE_USDC = "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const cta = () => screen.getByTestId("swap-review") as HTMLButtonElement;

  it("stays unreviewable, stops saying it is updating, and the CTA only asks again", async () => {
    const refresh = vi.fn();
    // The list at the pair's own slippage (Auto, 0.3 %) is in; every round at 0.05 % fails before any venue answers.
    function useRoutes(r: RoutesRequest | null): RoutesState & {refresh(): void} {
      const bps = r?.req.slippageBps;
      const mode = r?.mode;
      return useMemo(() => {
        const idle = {loading: false, limitedUntil: 0, refresh};
        if (!mode) return {...idle, snapshot: null, error: null, updatedAt: 0};
        if (bps === 5) return {...idle, snapshot: null, error: "Couldn't reach the venue", updatedAt: 2};
        return {...idle, snapshot: {...demoSnapshot(), mode}, error: null, updatedAt: 1};
      }, [bps, mode]);
    }
    history.replaceState(null, "", `/#/?pay=${ARB_USDC}&receive=${BASE_USDC}&amount=250`);
    resetDemoState();
    render(wrap(<SwapScreen />, {...demoPorts, swap: {...demoPorts.swap, useRoutes}}));
    expect(cta().textContent).toBe("Review via Circle CCTP");
    fireEvent.click(screen.getByTestId("swap-slippage"));
    const sheet = await screen.findByRole("dialog", {name: "Max slippage"});
    fireEvent.click(within(within(sheet).getByRole("group", {name: "Slippage presets"})).getByRole("button", {name: "0.05%"}));

    // The rows and the summary stay, dimmed; nothing claims to be updating (no spinner, no aria-busy): the status says why.
    await waitFor(() => expect(cta().dataset.state).toBe("retry"));
    expect(cta().textContent).toBe("Couldn't update quote — try again");
    const row = screen.getByTestId("swap-route-cctp");
    expect(row.getAttribute("aria-busy")).toBeNull();
    expect(row.getAttribute("aria-label")).toMatch(/, outdated$/);
    expect(screen.getByTestId("swap-min-received")).toBeTruthy();
    expect(screen.queryByRole("status", {name: "Updating"})).toBeNull();
    expect(screen.getByTestId("swap-routes-status").textContent).toBe("Couldn't quote: Couldn't reach the venue");
    // Pressing it, or Enter on a route, asks again — never the review of a number quoted for 0.3 %.
    fireEvent.click(cta());
    fireEvent.keyDown(screen.getByRole("radiogroup", {name: "Routes"}), {key: "Enter"});
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("swap-review-sheet")).toBeNull();
  });
});

describe("a Fynd route's review (the Fynd License §3.4)", () => {
  const list = demoSwapTokens({evm: DEMO_EVM_ADDRESS});
  const tokens = {all: list, pay: list, receive: list, byKey: new Map(list.map((t) => [t.key, t])), prices: {}, loading: false, refresh: () => {}};
  const wallets = {evm: null, solana: null, tron: null, ton: null, near: null, owners: {}, options: [], connecting: null, pairingUri: null, error: null, connect: vi.fn(), disconnect: vi.fn()};
  const from = list.find((t) => t.key === "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831")!;
  const to = list.find((t) => t.key === "arbitrum:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9")!;
  const req = {from, to, amountIn: 250_000_000n, slippageBps: 50, recipient: DEMO_EVM_ADDRESS, refundAddress: DEMO_EVM_ADDRESS};
  const review = (provider: string) => {
    const route: WebRoute = {...demoSnapshot().routes[0]!, provider, approvalSpender: "0x924F147c50eA59f5180a26031A8b65B2aA1e81Cd"};
    const ports: AppPorts = {...demoPorts, swap: {...demoPorts.swap, useRequote: () => ({route, gone: null, failed: false, loading: false, refetch: () => {}})}};
    const noop = () => {};
    render(wrap(<ReviewSheet open draft={{req, route}} tokens={tokens} wallets={wallets} slippage="Slippage 0.5%" onClose={noop} onShowStatus={noop} onTryAgain={noop} onConnect={noop} />, ports));
  };

  it("names the Tycho Router terms before Confirm and links the licence; no other venue's review carries it", () => {
    review("fynd");
    const note = screen.getByTestId("swap-review-fynd-license");
    expect(note.textContent).toBe(
      "Fynd routes settle only through Propeller Heads' Tycho Router on Arbitrum, with its fees intact, and must not be re-routed around it. Fynd License",
    );
    expect(note.querySelector("a")?.getAttribute("href")).toBe("https://github.com/propeller-heads/fynd/blob/main/LICENSE.md");
    expect(screen.getByTestId("swap-confirm")).toBeTruthy();
    cleanup();
    review("uniswap");
    expect(screen.queryByTestId("swap-review-fynd-license")).toBeNull();
  });
});

describe("Settings: local http RPCs", () => {
  it("are refused where this page's CSP blocks them, and allowed when served from this machine", () => {
    const input = {evmRpc: {1: ["http://127.0.0.1:8545"]}, solanaRpc: ["http://[::1]:8899"]};
    expect(blockedLocalRpcs(input, "swap.example")).toHaveLength(2);
    expect(blockedLocalRpcs(input, "127.0.0.1")).toEqual([]);
    expect(blockedLocalRpcs({evmRpc: {1: ["https://eth.example"]}}, "swap.example")).toEqual([]);
  });
});
