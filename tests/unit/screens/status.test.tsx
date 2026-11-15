// The status view (ui-port.md §2.7, §5.10, D34): the review's compact look, so it fits without scrolling — compact rows
// and steps, the secondary actions two to a row — and one button look: the explorer links are real links in the
// secondary 48 px look of "Refresh status" and "Done"; only "Continue in background", "Try again" and "Claim" are primary.
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {cleanup, render, screen, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {DEFAULT_RUNTIME_CONFIG, PortsProvider, setRuntimeConfig} from "../../../src/config";
import type {SwapRecord} from "../../../src/contracts/activity";
import type {AppPorts} from "../../../src/contracts/ports";
import type {WalletsApi} from "../../../src/contracts/wallets";
import {newRecord} from "../../../src/activity";
import {txUrl} from "../../../src/catalog";
import {DEMO_EVM_ADDRESS, demoPorts} from "../../../src/mocks";
import {StatusView, activeDetail} from "../../../src/screens/activity/StatusView";

const SRC = `0x${"a1".repeat(32)}`;
const DEST = `0x${"b2".repeat(32)}`;
const ID = `awk1.relay.demo.${SRC}`;

const record = (over: Partial<SwapRecord> = {}): SwapRecord => ({
  ...newRecord({
    id: ID,
    accountId: `evm:${DEMO_EVM_ADDRESS}`,
    provider: "relay",
    from: {caip2: "eip155:42161", chain: "arbitrum", symbol: "ETH", decimals: 18, key: "arbitrum:native"},
    to: {caip2: "eip155:1", chain: "ethereum", symbol: "ETH", decimals: 18, key: "ethereum:native"},
    amountIn: 10n ** 16n,
    expectedOut: 9_957_000_000_000_000n,
    minOut: 9_800_000_000_000_000n,
    recipient: DEMO_EVM_ADDRESS,
    hash: SRC,
  }),
  ...over,
});

const wallets: WalletsApi = {evm: null, solana: null, tron: null, ton: null, near: null, owners: {}, options: [], connecting: null, pairingUri: null, error: null, connect: vi.fn(), disconnect: vi.fn()};

function renderStatus(r: SwapRecord, w: WalletsApi = wallets) {
  const ports: AppPorts = {...demoPorts, activity: {...demoPorts.activity, useSwap: () => r}};
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  render(
    <QueryClientProvider client={client}>
      <PortsProvider ports={ports}>
        <StatusView id={r.id} wallets={w} onClose={vi.fn()} onTryAgain={vi.fn()} onConnect={vi.fn()} />
      </PortsProvider>
    </QueryClientProvider>,
  );
  return screen.getByTestId("swap-status-view");
}

/** The CSS module class names of an element (hashed `_secondary_abc123` → "secondary"). */
const looks = (el: Element) => [...el.classList].map((c) => c.replace(/^_/, "").replace(/_[0-9a-f]+$/, ""));

beforeEach(() => setRuntimeConfig(DEFAULT_RUNTIME_CONFIG));
afterEach(cleanup);

/** The test ids of an element's children, in order (the secondary actions' grid: two to a row, the last of an odd count spans it). */
const order = (el: Element) => [...el.children].map((c) => c.getAttribute("data-testid"));

describe("the status view's look (D34)", () => {
  it("the review's compact card: one line per row, the networks and the floor dim beside the amounts; every fact stays", () => {
    const view = renderStatus(record({status: "completed", destHash: DEST}));
    const card = view.querySelector("dl")!;
    expect(looks(card)).toContain("compact");
    expect(within(view).getByTestId("swap-status-paid").textContent).toBe("0.01 ETH");
    expect(within(card).getByText("on Arbitrum")).toBeTruthy();
    expect(within(view).getByTestId("swap-status-receive").textContent).toBe("≈ 0.01 ETH");
    expect(within(card).getByText("≥ 0.0098 on Ethereum")).toBeTruthy();
    for (const k of ["Paid", "Receive", "Route", "To", "Source tx", "Delivery tx"]) expect(within(card).getByText(k)).toBeTruthy();
    expect(within(card).getByText("Relay")).toBeTruthy();
    expect(within(card).getByText("0x709979…dc79C8")).toBeTruthy();
    expect(within(card).getByText("0xa1a1a1…a1a1a1")).toBeTruthy();
    expect(within(card).getByText("0xb2b2b2…b2b2b2")).toBeTruthy();
    expect(looks(within(view).getByTestId("swap-steps"))).toContain("compact");
  });
});

describe("the status view's actions (D34)", () => {
  it("delivered: both explorer links side by side in the secondary 48 px look of Done, as real new-tab links; Done under them", () => {
    const view = renderStatus(record({status: "completed", destHash: DEST}));
    const source = within(view).getByTestId("swap-explorer-source");
    const dest = within(view).getByTestId("swap-explorer-dest");
    for (const [link, href, name] of [
      [source, txUrl("eip155:42161", SRC), "Source tx on the explorer"],
      [dest, txUrl("eip155:1", DEST), "Delivery tx on the explorer"],
    ] as const) {
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      expect(link.getAttribute("aria-label")).toBe(name);
      expect(looks(link)).toEqual(expect.arrayContaining(["button", "secondary", "h48", "block"]));
    }
    // One grid, two to a row: the links, then Done alone on the last row; the same look as Done.
    expect(looks(source.parentElement!)).toContain("secondary");
    expect(order(source.parentElement!)).toEqual(["swap-explorer-source", "swap-explorer-dest", "swap-done"]);
    expect(looks(within(view).getByTestId("swap-done"))).toEqual(expect.arrayContaining(["button", "secondary", "h48", "block"]));
  });

  it("sent, still submitting: the source link alone (full width) under the primary 'Continue in background'; no Done", () => {
    const view = renderStatus(record({status: "submitting", stage: "broadcast"}));
    expect(looks(within(view).getByTestId("swap-background"))).toContain("primary");
    const source = within(view).getByTestId("swap-explorer-source");
    expect(order(source.parentElement!)).toEqual(["swap-explorer-source"]);
    expect(within(view).queryByTestId("swap-explorer-dest")).toBeNull();
    expect(within(view).queryByTestId("swap-refresh-status")).toBeNull();
    expect(within(view).queryByTestId("swap-done")).toBeNull();
  });

  it("on its way: Refresh status beside the source link, Done under them, all in the secondary look; a claim's link names the claim", () => {
    let view = renderStatus(record({status: "pending"}));
    for (const id of ["swap-refresh-status", "swap-explorer-source", "swap-done"]) expect(looks(within(view).getByTestId(id))).toEqual(expect.arrayContaining(["secondary", "h48"]));
    expect(within(view).getByTestId("swap-refresh-status").textContent).toBe("Refresh status");
    expect(order(within(view).getByTestId("swap-done").parentElement!)).toEqual(["swap-refresh-status", "swap-explorer-source", "swap-done"]);
    cleanup();
    // Both transactions while still on its way: the links share a row, Refresh goes beside Done.
    view = renderStatus(record({status: "pending", claimHash: DEST, trackId: `${ID}.${DEST}`}));
    expect(within(view).getByTestId("swap-explorer-dest").textContent).toBe("Claim tx");
    expect(within(view).getByTestId("swap-explorer-dest").getAttribute("aria-label")).toBe("Claim tx on the explorer");
    expect(order(within(view).getByTestId("swap-done").parentElement!)).toEqual(["swap-explorer-source", "swap-explorer-dest", "swap-refresh-status", "swap-done"]);
    cleanup();
    // No transaction to link yet: Refresh beside Done.
    view = renderStatus({...record({status: "pending"}), sourceHash: undefined});
    expect(order(within(view).getByTestId("swap-done").parentElement!)).toEqual(["swap-refresh-status", "swap-done"]);
  });

  it("a claim to make and a swap that stopped: their own action is primary and full width, the rest secondary", () => {
    const evm = {family: "evm", address: DEMO_EVM_ADDRESS, chainId: 1, walletName: "MetaMask", transport: "injected"} as const;
    let view = renderStatus(record({status: "action-required"}), {...wallets, evm});
    const claim = within(view).getByTestId("swap-claim");
    expect(looks(claim)).toEqual(expect.arrayContaining(["primary", "block"]));
    expect(claim.textContent).toBe("Claim on Ethereum");
    expect(order(within(view).getByTestId("swap-done").parentElement!)).toEqual(["swap-refresh-status", "swap-explorer-source", "swap-done"]);
    for (const id of ["swap-refresh-status", "swap-explorer-source", "swap-done"]) expect(looks(within(view).getByTestId(id))).toContain("secondary");
    cleanup();
    view = renderStatus({...record({status: "not-sent", error: "You declined in your wallet — nothing was sent."}), sourceHash: undefined});
    expect(looks(within(view).getByTestId("swap-try-again"))).toEqual(expect.arrayContaining(["primary", "block"]));
    expect(within(view).getByTestId("swap-done").textContent).toBe("Close");
    expect(order(within(view).getByTestId("swap-done").parentElement!)).toEqual(["swap-done"]);
    expect(looks(within(view).getByTestId("swap-done"))).toEqual(expect.arrayContaining(["secondary", "h48"]));
    expect(within(view).queryByTestId("swap-explorer-source")).toBeNull();
  });
});

describe("the status view while the wallet holds a 0x permit (D38)", () => {
  it("the Permit2 step is the active one, read as a signature that sends nothing; Approve and the confirmation wait", () => {
    const r = record({id: "local.9", localId: "local.9", provider: "zeroex", status: "submitting", stage: "permit", permit: true, approvals: 1, sourceHash: undefined});
    expect(activeDetail(r)).toBe("Waiting for your wallet — a signature, nothing is sent");
    const view = renderStatus(r);
    expect(within(view).getByTestId("swap-step-permit-active").textContent).toContain("Sign the Permit2 transfer");
    expect(within(view).getByTestId("swap-step-approve-todo")).toBeTruthy();
    expect(within(view).getByTestId("swap-step-confirm-todo")).toBeTruthy();
    expect(within(view).getByText("Signing the Permit2 transfer")).toBeTruthy();
  });
});
