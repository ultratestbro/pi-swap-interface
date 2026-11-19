import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {act, cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {useSyncExternalStore, type ReactNode} from "react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {DEFAULT_RUNTIME_CONFIG, PortsProvider, setRuntimeConfig} from "../../../src/config";
import type {DepositTicket} from "../../../src/contracts/execution";
import type {AppPorts} from "../../../src/contracts/ports";
import type {WalletConnection, WalletOption, WalletsApi} from "../../../src/contracts/wallets";
import {DEMO_EVM_ADDRESS, demoActivity, demoPorts, demoSnapshot, demoSwapTokens, resetDemoState} from "../../../src/mocks";
import {SwapScreen} from "../../../src/screens";
import {SwapApp} from "../../../src/screens/SwapScreen";
import {parseRejections} from "../../../src/swap/routes";
import {routeListModel} from "../../../src/screens/form/model";
import {DepositPanel} from "../../../src/screens/review/DepositPanel";
import {RouteList} from "../../../src/screens/routelist/RoutesPanel";
import {ConnectSheet} from "../../../src/screens/wallets/ConnectSheet";
import {WalletsDropdown} from "../../../src/screens/shell/WalletsDropdown";
import {installMatchMedia, type FakeViewport} from "../ui/matchMedia";

const ARB_USDC = "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const BASE_USDC = "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BTC_REFUND = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const SLOW = {timeout: 4000};

let viewport: FakeViewport | null = null;

function wrap(children: ReactNode) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  return (
    <QueryClientProvider client={client}>
      <PortsProvider ports={demoPorts}>{children}</PortsProvider>
    </QueryClientProvider>
  );
}

/** Mount the whole screen on demo ports at `hash` (demo wallets are read from it: `demoWallets=none|evm|solana|both`). */
function renderScreen(hash: string) {
  history.replaceState(null, "", `/${hash}`);
  resetDemoState();
  return render(wrap(<SwapScreen />));
}

const cta = () => screen.getByTestId("swap-review") as HTMLButtonElement;

beforeEach(() => {
  setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
});

afterEach(() => {
  cleanup();
  viewport?.restore();
  viewport = null;
  history.replaceState(null, "", "/");
  vi.useRealTimers();
});

describe("CTA states (ui-port §5.4, D7)", () => {
  it("no amount: 'Enter an amount', disabled, and the idle hint says so", () => {
    renderScreen("#/");
    expect(cta().textContent).toBe("Enter an amount");
    expect(cta().disabled).toBe(true);
    expect(screen.getByTestId("swap-hint").textContent).toBe("Enter an amount to see routes from every venue.");
  });

  it("no wallet: 'Connect EVM wallet to swap' over preview prices; it opens the wallet menu, which closes once connected", async () => {
    renderScreen("#/?demoWallets=none&amount=1");
    expect(cta().textContent).toBe("Connect EVM wallet to swap");
    expect(cta().disabled).toBe(false);
    expect(screen.queryByTestId("swap-hint")).toBeNull();
    fireEvent.click(cta());
    const menu = await screen.findByRole("dialog");
    expect(within(menu).getByText("Connect a wallet")).toBeTruthy();
    fireEvent.click(within(menu).getByTestId("swap-connect-io.metamask"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SLOW);
    // 1 ETH against the demo wallet's 0.42: the CTA now says what blocks it.
    await waitFor(() => expect(cta().textContent).toBe("Insufficient ETH balance"), SLOW);
  });

  it("the wallet menu has a NEAR section; without a NEAR extension it points to the deposit address", async () => {
    renderScreen("#/?demoWallets=none");
    fireEvent.click(screen.getByTestId("swap-connect-open"));
    const menu = await screen.findByRole("dialog");
    expect(within(within(menu).getByLabelText("NEAR wallets")).getByText(/No NEAR wallet extension found.*deposit address/)).toBeTruthy();
  });

  it("deposit payer: the refund address gates the quote, then 'Get deposit address'", async () => {
    renderScreen(`#/?pay=bitcoin:native&receive=${ARB_USDC}&amount=0.01`);
    expect(screen.getByTestId("swap-refund-box")).toBeTruthy();
    expect(cta().textContent).toBe("Enter the Bitcoin refund address to swap");
    expect(cta().disabled).toBe(true);
    const field = screen.getByTestId("swap-refund") as HTMLInputElement;
    fireEvent.change(field, {target: {value: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"}});
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(cta().disabled).toBe(true);
    fireEvent.change(field, {target: {value: BTC_REFUND}});
    await waitFor(() => expect(cta().textContent).toBe("Get deposit address"), SLOW);
    expect(cta().disabled).toBe(false);
    // THORChain needs a memo: listed as refused for a QR payer, never offered.
    expect(screen.queryByTestId("swap-route-thorchain")).toBeNull();
  });

  it("previews off (operator or viewer): a missing wallet quotes nothing and the hint asks for one", () => {
    setRuntimeConfig({...DEFAULT_RUNTIME_CONFIG, preview: {...DEFAULT_RUNTIME_CONFIG.preview, enabled: false}});
    renderScreen("#/?demoWallets=none&amount=1");
    expect(screen.getByTestId("swap-hint").textContent).toBe("Connect a wallet to see routes");
    expect(cta().textContent).toBe("Connect EVM wallet to swap");
  });

  it("no wallet and no amount: the hint asks for the amount, since that is all a preview needs", () => {
    renderScreen("#/?demoWallets=none");
    expect(screen.getByTestId("swap-hint").textContent).toBe("Enter an amount to see routes from every venue.");
  });

  it("insufficient balance: red line under the amount and a disabled CTA", () => {
    renderScreen("#/?amount=5");
    expect(screen.getByTestId("swap-amount-error").textContent).toBe("Insufficient balance");
    expect(cta().textContent).toBe("Insufficient ETH balance");
    expect(cta().disabled).toBe(true);
  });

  it("ready: routes stream in and the CTA names the chosen venue", async () => {
    renderScreen("#/?amount=0.1");
    await screen.findByTestId("swap-route-pending-uniswap");
    const row = await screen.findByTestId("swap-route-uniswap", {}, SLOW);
    expect(row.getAttribute("role")).toBe("radio");
    expect(row.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(cta().textContent).toBe("Review via Uniswap"));
    expect(cta().disabled).toBe(false);
  });
});

describe("route list states (ui-port §5.5)", () => {
  it("pending rows while venues answer, then a collapsed 'Didn't quote' group with the reason", async () => {
    renderScreen("#/?amount=0.1");
    expect(await screen.findByTestId("swap-route-pending-lifi")).toBeTruthy();
    const toggle = await screen.findByTestId("swap-refused-toggle", {}, SLOW);
    expect(toggle.textContent).toContain("Didn't quote (1)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const refused = screen.getByTestId("swap-route-refused-lifi");
    expect(refused.textContent).toContain("Didn't answer in time — tap refresh");
    // ETH → USDC on Arbitrum: Uniswap and Balancer quote.
    expect(screen.getByTestId("swap-routes-status").textContent).toMatch(/^2 routes · updated/);
  });

  it("keyboard: ↓ selects the next route, Enter presses the CTA", () => {
    const tokens = demoSwapTokens({evm: DEMO_EVM_ADDRESS});
    const to = tokens.find((t) => t.key === BASE_USDC)!;
    const from = tokens.find((t) => t.key === ARB_USDC)!;
    const onSelect = vi.fn();
    const onSubmit = vi.fn();
    render(
      <RouteList model={routeListModel(demoSnapshot(), from)} loading={false} to={to} payChainName="Arbitrum" chosen="cctp" onSelect={onSelect} onSubmit={onSubmit} />,
    );
    const group = screen.getByRole("radiogroup", {name: "Routes"});
    expect(within(group).getAllByRole("radio").map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    fireEvent.keyDown(group, {key: "ArrowDown"});
    expect(onSelect).toHaveBeenCalledWith("near_intents");
    fireEvent.keyDown(group, {key: "ArrowUp"});
    expect(onSelect).toHaveBeenLastCalledWith("relay");
    fireEvent.keyDown(group, {key: "Enter"});
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("phone: the chosen route only, plus 'N more routes'; the sheet says how many venues serve the pair", async () => {
    viewport = installMatchMedia(375);
    renderScreen(`#/?pay=${ARB_USDC}&receive=${BASE_USDC}&amount=250`);
    const more = await screen.findByTestId("swap-more-routes", {}, SLOW);
    // CCTP, NEAR Intents, Relay, Symbiosis and Omniston quote; LI.FI times out.
    await waitFor(() => expect(more.textContent).toBe("4 more routes"), SLOW);
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    fireEvent.click(more);
    const sheet = await screen.findByTestId("swap-route-sheet");
    expect(within(sheet).getByTestId("swap-coverage").textContent).toBe("6 of 14 venues serve this pair");
  });
});

describe("refused sections, disclosure and coverage (ui-port §5.5)", () => {
  const tokens = demoSwapTokens({evm: DEMO_EVM_ADDRESS});
  const from = tokens.find((t) => t.key === ARB_USDC)!;
  const to = tokens.find((t) => t.key === BASE_USDC)!;
  const rejections = parseRejections(
    [
      "lifi: the transaction does not match the quote: pays 0x6f844aa8f38d91244f057bcc70438a1f5c461b64, not 0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "thorchain: Refusing quote on node with stale state: invalid request",
      "near_intents: below the 1Click minimum ($100)",
      "jupiter: the recipient must be the signing wallet (Jupiter pays the taker)",
      "relay: HTTP 429",
      "chainflip: no vault swap eip155:42161 \u2192 eip155:8453",
    ],
    from,
  );
  const list = () =>
    render(
      <RouteList
        model={routeListModel({...demoSnapshot(), routes: [], rejections}, from, to)}
        loading={false}
        to={to}
        payChainName="Arbitrum"
        chosen={null}
        onSelect={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

  it("nothing quoted: the refusals in sections, in order, safety last in green", () => {
    list();
    const heads = screen.getAllByRole("heading", {level: 3});
    expect(heads.map((h) => h.textContent)).toEqual([
      "Needs a different amount",
      "Needs a change on your side",
      "Not available right now",
      "Doesn't support this pair",
      "Skipped for your safety",
    ]);
    expect(heads.at(-1)!.style.color).toBe("var(--green)");
    expect(heads.at(-1)!.parentElement!.querySelector("svg")).toBeTruthy();
    const unavailable = screen.getByRole("list", {name: "Not available right now"});
    expect(within(unavailable).getAllByRole("listitem").map((x) => x.dataset.testid)).toEqual(["swap-route-refused-thorchain", "swap-route-refused-relay"]);
    const safety = within(screen.getByRole("list", {name: "Skipped for your safety"})).getByTestId("swap-route-refused-lifi");
    expect(safety.dataset.category).toBe("safety");
  });

  it("each row: the whole short line, then a disclosure with why and the venue's own text to copy", () => {
    list();
    const row = screen.getByTestId("swap-route-refused-lifi");
    const reason = within(row).getByText("Can't confirm it pays you");
    expect(reason.className).not.toMatch(/lines/);
    const [outer, inner] = Array.from(row.querySelectorAll("details"));
    expect(outer!.open).toBe(false);
    fireEvent.click(outer!.querySelector("summary")!);
    expect(outer!.open).toBe(true);
    expect(within(row).getByText(/could pay an address we couldn't confirm is yours/)).toBeTruthy();
    expect(inner!.querySelector("summary")!.textContent).toBe("Technical reason");
    expect(within(row).getByTestId("swap-refused-raw").textContent).toBe(
      "the transaction does not match the quote: pays 0x6f844aa8f38d91244f057bcc70438a1f5c461b64, not 0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    );
    const copy = within(row).getByRole("button", {name: "Copy technical reason"});
    expect(copy.closest("summary")).toBeNull();
  });

  it("an opened row and its technical reason stay open through the 30 s refresh, and when the row comes back", async () => {
    const props = {to, payChainName: "Arbitrum", chosen: null, onSelect: vi.fn(), onSubmit: vi.fn()};
    const none = routeListModel({...demoSnapshot(), routes: [], rejections}, from, to);
    const {rerender} = render(<RouteList model={none} loading={false} {...props} />);
    const row = screen.getByTestId("swap-route-refused-lifi");
    const [outer, inner] = Array.from(row.querySelectorAll("details"));
    fireEvent.click(outer!.querySelector("summary")!);
    fireEvent.click(inner!.querySelector("summary")!);
    // <details> announces a toggle a task later (as browsers do)
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const isOpen = () => Array.from(screen.getByTestId("swap-route-refused-lifi").querySelectorAll("details")).map((d) => d.open);

    // Nothing quoted, the refresh runs: the sections stay where they are, the same row, still open, not repeated as pending.
    rerender(<RouteList model={{...none, pending: ["lifi", "relay"]}} loading refreshing {...props} />);
    expect(screen.getByTestId("swap-route-refused-lifi")).toBe(row);
    expect(isOpen()).toEqual([true, true]);
    expect(screen.queryByTestId("swap-refused-toggle")).toBeNull();
    expect(screen.queryByTestId("swap-route-pending-lifi")).toBeNull();
    rerender(<RouteList model={none} loading={false} {...props} />);
    expect(screen.getByTestId("swap-route-refused-lifi")).toBe(row);
    expect(isOpen()).toEqual([true, true]);

    // Routes exist: the first new price replaces the list before LI.FI refuses again; its row comes back open.
    const quoted = routeListModel({...demoSnapshot(), rejections: rejections.filter((x) => x.provider !== "lifi")}, from, to);
    rerender(<RouteList model={quoted} loading refreshing {...props} />);
    fireEvent.click(screen.getByTestId("swap-refused-toggle"));
    expect(screen.queryByTestId("swap-route-refused-lifi")).toBeNull();
    rerender(<RouteList model={routeListModel({...demoSnapshot(), rejections}, from, to)} loading={false} {...props} />);
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(isOpen()).toEqual([true, true]);
  });

  it("a preview's venue left for the live quote: its own quiet, collapsed group, never under 'Didn't quote' or 'Needs a change'", () => {
    const skipped = parseRejections(["lifi: asked only for your live quote: previews ask it only while cp0x's proxy carries it with cp0x's key"], from).map((x) => ({
      ...x,
      skipped: true as const,
    }));
    const others = rejections.filter((x) => x.provider !== "lifi");
    const props = {to, payChainName: "Arbitrum", chosen: null, onSelect: vi.fn(), onSubmit: vi.fn(), preview: true};
    const model = (rows: typeof rejections, routes = demoSnapshot().routes) =>
      routeListModel({...demoSnapshot(), mode: "preview", routes, rejections: rows}, from, to, {kind: "connect", family: "evm"});
    const {rerender} = render(<RouteList model={model([...skipped, ...others])} loading={false} {...props} />);
    // Routes quoted: "Didn't quote" counts only the venues that didn't, the quiet group sits apart, before "Not for this pair".
    expect(screen.getByTestId("swap-refused-toggle").textContent).toContain(`Didn't quote (${others.length})`);
    const toggle = screen.getByTestId("swap-deferred-toggle");
    expect(toggle.textContent).toBe("Quoted after you connect (1)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.compareDocumentPosition(screen.getByTestId("swap-uncovered-toggle")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("swap-route-refused-lifi")).toBeNull();
    fireEvent.click(toggle);
    const group = screen.getByRole("list", {name: "Quoted after you connect"});
    const row = within(group).getByTestId("swap-route-refused-lifi");
    expect(row.dataset.category).toBe("deferred");
    expect(row.textContent).toContain("Connect a wallet to get this quote");
    fireEvent.click(row.querySelector("summary")!);
    expect(within(row).getByText(/asked as soon as your wallet is connected/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("swap-refused-toggle"));
    expect(within(screen.getByTestId("swap-refused")).queryByTestId("swap-route-refused-lifi")).toBeNull();

    // Nothing quoted: the refusals' sections open, the quiet group still apart.
    rerender(<RouteList model={model([...skipped, ...others], [])} loading={false} {...props} />);
    expect(screen.getAllByRole("heading", {level: 3}).map((h) => h.textContent)).not.toContain("Quoted after you connect");
    expect(within(screen.getByTestId("swap-refused")).queryByTestId("swap-route-refused-lifi")).toBeNull();
    expect(within(screen.getByTestId("swap-deferred")).getByTestId("swap-route-refused-lifi")).toBeTruthy();

    // Only the deferred venue and no route: no "Didn't quote" at all.
    rerender(<RouteList model={model(skipped, [])} loading={false} {...props} />);
    expect(screen.queryByTestId("swap-refused-toggle")).toBeNull();
    expect(screen.queryByTestId("swap-refused")).toBeNull();
    expect(screen.getByTestId("swap-deferred-toggle").textContent).toBe("Quoted after you connect (1)");
  });

  it("'Not for this pair' lists the enabled venues not asked, collapsed, each with its scope", () => {
    list();
    const toggle = screen.getByTestId("swap-uncovered-toggle");
    expect(toggle.textContent).toContain("Not for this pair (8)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", {name: "Not for this pair"})).toBeNull();
    fireEvent.click(toggle);
    const group = screen.getByRole("list", {name: "Not for this pair"});
    expect(within(group).getByTestId("swap-route-uncovered-uniswap").textContent).toContain("Same-network swaps only");
    expect(within(group).getByTestId("swap-route-uncovered-usdt0").textContent).toContain("Moves USDT only");
  });

  it("the demo 'refused' scene: an amount refusal and a safety skip, and how many venues serve the pair", async () => {
    history.replaceState(null, "", "/");
    resetDemoState();
    render(wrap(<SwapApp scene="refused" />));
    const safety = await screen.findByRole("list", {name: "Skipped for your safety"}, SLOW);
    expect(within(safety).getByTestId("swap-route-refused-lifi").textContent).toContain("Can't confirm it pays you");
    const amount = screen.getByRole("list", {name: "Needs a different amount"});
    expect(within(amount).getByTestId("swap-route-refused-chainflip").textContent).toContain("Minimum 0.01 ETH");
    // Omniston is asked for ETH Arbitrum → Ethereum, as its module is, and refuses the native coin.
    const pair = await screen.findByRole("list", {name: "Doesn't support this pair"}, SLOW);
    expect(within(pair).getByTestId("swap-route-refused-omniston").textContent).toContain("Doesn't move native coins across networks");
    expect(screen.getByTestId("swap-coverage").textContent).toBe("6 of 14 venues serve this pair");
  });
});

describe("a slippage change keeps the screen's shape (D32)", () => {
  const pickSlippage = async (label: string) => {
    fireEvent.click(screen.getByTestId("swap-slippage"));
    const sheet = await screen.findByRole("dialog", {name: "Max slippage"});
    fireEvent.click(within(within(sheet).getByRole("group", {name: "Slippage presets"})).getByRole("button", {name: label}));
  };
  // ETH → USDC on Arbitrum: Uniswap (350 ms) and Balancer (550 ms) quote, LI.FI times out (1.4 s).
  const settled = () => waitFor(() => expect(screen.getByTestId("swap-routes-status").textContent).toMatch(/^2 routes · updated/), SLOW);

  it("rows, summary and receive amount stay; the CTA waits for the chosen venue's new quote, which the review gets", async () => {
    renderScreen("#/?amount=0.1");
    await settled();
    await waitFor(() => expect(cta().textContent).toBe("Review via Uniswap"));
    const uniswap = screen.getByTestId("swap-route-uniswap");
    const balancer = screen.getByTestId("swap-route-balancer");
    const min = screen.getByTestId("swap-min-received").textContent;
    await pickSlippage("0.3%");

    // At once: the same rows (not remounted), in place and dimmed; the summary and the receive amount still there.
    expect(screen.getByTestId("swap-route-uniswap")).toBe(uniswap);
    expect(uniswap.getAttribute("aria-busy")).toBe("true");
    expect(uniswap.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("swap-route-pending-uniswap")).toBeNull();
    expect(screen.getByTestId("swap-min-received").textContent).toBe(min);
    expect(screen.getByRole("status", {name: "Updating"})).toBeTruthy();
    expect(screen.getByTestId("swap-receive-amount").textContent).not.toBe("0");
    // A number quoted for 0.5 % is never reviewable at 0.3 %.
    expect(cta().textContent).toBe("Updating quote…");
    expect(cta().disabled).toBe(true);
    expect(cta().dataset.state).toBe("updating");
    fireEvent.keyDown(screen.getByRole("radiogroup", {name: "Routes"}), {key: "Enter"});
    fireEvent.click(cta());
    expect(screen.queryByTestId("swap-review-body")).toBeNull();

    // Uniswap answers for 0.3 %: its row and the summary take the new minimum in place.
    await waitFor(() => expect(cta().textContent).toBe("Review via Uniswap"), SLOW);
    expect(screen.getByTestId("swap-route-uniswap")).toBe(uniswap);
    expect(uniswap.getAttribute("aria-busy")).toBeNull();
    const fresh = screen.getByTestId("swap-min-received").textContent;
    expect(fresh).not.toBe(min);
    expect(screen.queryByRole("status", {name: "Updating"})).toBeNull();
    // Reviewed while the round still runs (Balancer is asked until 550 ms), the review drafts Uniswap's 0.3 % quote. Read
    // at once: the review's own re-quote (600 ms after it opens, in demo) would replace the drafted route anyway.
    fireEvent.click(cta());
    const sheet = await screen.findByTestId("swap-review-body");
    expect(within(sheet).getByTestId("swap-review-min").textContent).toBe(fresh);
    await settled();
    expect(screen.getByTestId("swap-route-balancer")).toBe(balancer);
  });

  it("a route the user picked stays picked, and the CTA waits for that venue's answer", async () => {
    renderScreen("#/?amount=0.1");
    await settled();
    fireEvent.click(screen.getByTestId("swap-route-balancer"));
    await waitFor(() => expect(cta().textContent).toBe("Review via Balancer"));
    await pickSlippage("0.3%");
    expect(cta().textContent).toBe("Updating quote…");
    // Uniswap answers first: Balancer, the chosen one, is still quoted for 0.5 %.
    await waitFor(() => expect(screen.getByTestId("swap-route-uniswap").getAttribute("aria-busy")).toBeNull(), SLOW);
    expect(screen.getByTestId("swap-route-balancer").getAttribute("aria-busy")).toBe("true");
    expect(cta().textContent).toBe("Updating quote…");
    await waitFor(() => expect(cta().textContent).toBe("Review via Balancer"), SLOW);
    await settled();
    expect(screen.getByTestId("swap-route-balancer").getAttribute("aria-checked")).toBe("true");
  });
});

describe("review", () => {
  it("shows the execution floor as 'Minimum received'; confirming keeps the review until the swap is broadcast", async () => {
    renderScreen(`#/?pay=${ARB_USDC}&receive=${BASE_USDC}&amount=250`);
    await waitFor(() => expect(cta().textContent).toBe("Review via Circle CCTP · Fast"), SLOW);
    const summaryMin = screen.getByTestId("swap-min-received").textContent;
    const rowLabel = screen.getByTestId("swap-route-cctp-fast").getAttribute("aria-label")!;
    fireEvent.click(cta());
    const sheet = await screen.findByTestId("swap-review-body");
    const min = within(sheet).getByTestId("swap-review-min");
    expect(min.textContent).toBe(summaryMin);
    // The route row promises exactly the floor the swap enforces (executionFloor), the same number as the summary
    // and the review — never the venue's own minimum 50 bps above it.
    expect(rowLabel).toContain(`at least ${summaryMin}`);
    expect(within(sheet).getByText(/\+ 0\.5% margin/)).toBeTruthy();
    expect(within(sheet).getByText("Minimum received")).toBeTruthy();
    fireEvent.click(within(sheet).getByTestId("swap-confirm"));
    // The approval is asked first: the review stays, locked, its steps under it — nothing is swapped yet.
    await waitFor(() => expect(within(sheet).getByTestId("swap-step-approve-active")).toBeTruthy(), SLOW);
    expect(screen.queryByTestId("swap-status-view")).toBeNull();
    expect((within(sheet).getByTestId("swap-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).queryByTestId("sheet-close")).toBeNull();
    // Approved; the swap itself is being signed: still the review, its confirmation the open step.
    await waitFor(() => expect(within(sheet).getByTestId("swap-step-confirm-active")).toBeTruthy(), SLOW);
    expect(screen.queryByTestId("swap-status-view")).toBeNull();
    // The demo wallet broadcasts the swap: now the sheet is its status.
    const status = await screen.findByTestId("swap-status-view", {}, SLOW);
    expect(within(status).getByTestId("swap-step-approve-done")).toBeTruthy();
    expect(screen.queryByTestId("swap-review-body")).toBeNull();
  });
});

describe("deposit panel (D20)", () => {
  const tokens = demoSwapTokens({evm: DEMO_EVM_ADDRESS});
  const from = tokens.find((t) => t.key === "bitcoin:native")!;
  const to = tokens.find((t) => t.key === ARB_USDC)!;
  const req = {from, to, amountIn: 1_500_000n, slippageBps: 50, recipient: DEMO_EVM_ADDRESS, refundAddress: BTC_REFUND};
  const ticket = (validUntilMs: number): DepositTicket => ({
    id: "awk1.near_intents.test",
    provider: "near_intents",
    intentId: "test",
    depositAddress: "demo-address-do-not-send",
    depositMemo: null,
    sourceAmount: 1_500_000n,
    destAmount: 1_452_100_000n,
    minDestAmount: 1_437_500_000n,
    validUntilMs,
    etaSeconds: 600,
  });
  const panel = (t: DepositTicket, onRenew = vi.fn()) =>
    render(wrap(<DepositPanel ticket={t} req={req} from={from} to={to} onRenew={onRenew} renewing={false} onSent={vi.fn()} onClose={vi.fn()} />));

  it("live: a BIP-21 QR, the exact amount, the countdown", () => {
    panel(ticket(Date.now() + 10 * 60_000));
    expect(screen.getByLabelText("QR code of the Bitcoin deposit address")).toBeTruthy();
    expect(screen.queryByTestId("swap-deposit-expired")).toBeNull();
    expect(screen.getByText("0.015 BTC")).toBeTruthy();
    expect(screen.getByTestId("swap-deposit-address").textContent).toBe("demo-address-do-not-send");
  });

  it("expired: the QR is blurred, a red 'don't send' and 'Get a new address'", () => {
    const onRenew = vi.fn();
    panel(ticket(Date.now() - 1), onRenew);
    expect(screen.getByTestId("swap-deposit-expired").textContent).toContain("Expired — don't send to this address.");
    // Someone who already paid is told not to pay again before a new address is offered.
    expect(screen.getByTestId("swap-deposit-expired").textContent).toMatch(/Already sent before it expired\? Don't send again/);
    expect(screen.getByLabelText("Expired deposit address QR code")).toBeTruthy();
    expect(screen.getByText("0:00")).toBeTruthy();
    // Nothing invites a send to the stale address: no copy buttons, and "I've sent it" is no longer the main action.
    expect(screen.queryByTestId("swap-deposit-copy")).toBeNull();
    expect(screen.queryByRole("button", {name: "Copy amount"})).toBeNull();
    expect(screen.getByTestId("swap-deposit-sent").textContent).toBe("I already sent it");
    fireEvent.click(screen.getByRole("button", {name: "Get a new address"}));
    expect(onRenew).toHaveBeenCalledTimes(1);
  });
});

describe("activity", () => {
  it("a stopped swap from the hash offers 'Try again', which refills the form", async () => {
    const stopped = {...demoActivity().find((r) => r.status === "not-sent")!, fromKey: BASE_USDC, toKey: "base:native"};
    // The fixture's stopped swap has no token keys; this one does (as the runner records them).
    const ports = {...demoPorts, activity: {...demoPorts.activity, useSwap: (id: string | null) => (id === stopped.id ? stopped : undefined)}};
    history.replaceState(null, "", `/#/?swap=${stopped.id}`);
    resetDemoState();
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    render(
      <QueryClientProvider client={client}>
        <PortsProvider ports={ports}>
          <SwapScreen />
        </PortsProvider>
      </QueryClientProvider>,
    );
    const view = await screen.findByTestId("swap-status-view");
    expect(within(view).getByTestId("swap-status").textContent).toBe("Not swapped");
    fireEvent.click(within(view).getByTestId("swap-try-again"));
    await waitFor(() => expect((screen.getByTestId("swap-amount") as HTMLInputElement).value).toBe("250"));
    expect(screen.getByTestId("swap-pay-token").getAttribute("aria-label")).toBe("USDC on Base, change token");
    expect(screen.getByTestId("swap-receive-token").getAttribute("aria-label")).toBe("ETH on Base, change token");
    const q = new URLSearchParams(location.hash.slice(location.hash.indexOf("?") + 1));
    expect(q.get("pay")).toBe(BASE_USDC);
    expect(q.get("amount")).toBe("250");
    expect(q.get("swap")).toBeNull();
  });

  it("a CCTP claim is previewed before the wallet is asked, then tracked again", async () => {
    const claim = demoActivity().find((r) => r.status === "action-required")!;
    renderScreen(`#/?swap=${claim.id}`);
    const view = await screen.findByTestId("swap-status-view");
    fireEvent.click(within(view).getByTestId("swap-claim"));
    const confirm = await screen.findByTestId("swap-claim-confirm", {}, SLOW);
    expect(confirm.textContent).toContain("to mint your USDC to 0x709979…dc79C8");
    await act(async () => {
      fireEvent.click(within(confirm).getByTestId("swap-claim-confirm-button"));
    });
    await waitFor(() => expect(screen.getByTestId("swap-status").textContent).toBe("In progress"), SLOW);
  });
});

describe("token sheet", () => {
  it("opens on the token's network, searches every network, and picking the other side's token swaps the pair", async () => {
    renderScreen("#/?amount=0.1");
    expect(screen.getByTestId("swap-pay-token").getAttribute("aria-label")).toBe("ETH on Arbitrum, change token");
    fireEvent.click(screen.getByTestId("swap-pay-token"));
    const sheet = await screen.findByTestId("swap-token-sheet");
    expect(within(sheet).getByTestId("swap-net-arbitrum").getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(within(sheet).getByTestId("swap-token-search"), {target: {value: "usdc"}});
    expect(within(sheet).getByTestId(`swap-token-${BASE_USDC}`)).toBeTruthy();
    expect(within(sheet).queryByTestId("swap-token-arbitrum:native")).toBeNull();
    fireEvent.click(within(sheet).getByTestId(`swap-token-${ARB_USDC}`));
    await waitFor(() => expect(screen.getByTestId("swap-pay-token").getAttribute("aria-label")).toBe("USDC on Arbitrum, change token"));
    expect(screen.getByTestId("swap-receive-token").getAttribute("aria-label")).toBe("ETH on Arbitrum, change token");
  });
});

describe("the wallet menu closing mid-connect (D11)", () => {
  const WC: WalletOption = {id: "walletconnect", family: "evm", name: "WalletConnect", kind: "walletconnect"};
  const MM: WalletOption = {id: "io.metamask", family: "evm", name: "MetaMask", kind: "injected"};
  const TL: WalletOption = {id: "tron:org.tronlink.www", family: "tron", name: "TronLink", kind: "injected"};
  const api = (connecting: string | null, pairingUri: string | null = null) => ({
    evm: null,
    solana: null,
    tron: null,
    ton: null,
    near: null,
    owners: {},
    options: [MM, WC, TL],
    connecting,
    pairingUri,
    error: null,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  });

  it("a WalletConnect attempt goes with the sheet — Escape, the close button and Settings all cancel it", () => {
    for (const close of [
      () => fireEvent.keyDown(screen.getByRole("dialog"), {key: "Escape"}),
      () => fireEvent.click(screen.getByTestId("sheet-close")),
      () => fireEvent.click(screen.getByTestId("swap-connect-settings")),
    ]) {
      const wallets = api("walletconnect", "wc:test@2?relay-protocol=irn&symKey=00");
      const onClose = vi.fn();
      const onSettings = vi.fn();
      render(<ConnectSheet open focus={null} wallets={wallets} onClose={onClose} onSettings={onSettings} />);
      expect(screen.getByTestId("swap-walletconnect-qr")).toBeTruthy();
      close();
      expect(wallets.disconnect).toHaveBeenCalledTimes(1);
      expect(wallets.disconnect).toHaveBeenCalledWith("evm");
      expect(onClose.mock.calls.length + onSettings.mock.calls.length).toBe(1);
      cleanup();
    }
  });

  it("a TON Connect attempt runs behind the closed menu; one that ends in an error reopens it on TON, where the error shows", async () => {
    const TC: WalletOption = {id: "tonconnect", family: "ton", name: "TON Connect", kind: "tonconnect"};
    const listeners = new Set<() => void>();
    let state: WalletsApi = {...api(null), options: [MM, WC, TC]};
    const set = (patch: Partial<WalletsApi>) => {
      state = {...state, ...patch};
      for (const l of listeners) l();
    };
    const connect = vi.fn(async (id: string) => set({connecting: id, error: null}));
    state = {...state, connect};
    const subscribe = (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    };
    const useWallets = () => useSyncExternalStore(subscribe, () => state);
    const ports: AppPorts = {...demoPorts, wallets: {...demoPorts.wallets, useWallets}};
    history.replaceState(null, "", "/#/?demoWallets=none");
    resetDemoState();
    render(
      <QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}>
        <PortsProvider ports={ports}>
          <SwapScreen />
        </PortsProvider>
      </QueryClientProvider>,
    );
    const pickTonConnect = async () => {
      fireEvent.click(screen.getByTestId("swap-connect-open"));
      fireEvent.click(within(await screen.findByRole("dialog")).getByTestId("swap-connect-tonconnect"));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SLOW);
      // The attempt starts once the menu is gone.
      await waitFor(() => expect(state.connecting).toBe("tonconnect"));
    };

    // The viewer closes TON Connect's modal: a quiet cancel, the menu stays closed.
    await pickTonConnect();
    act(() => set({connecting: null}));
    expect(screen.queryByRole("dialog")).toBeNull();

    await pickTonConnect();
    act(() => set({connecting: null, error: "TON Connect didn't load — check your connection and try again."}));
    const menu = await screen.findByRole("dialog");
    expect(within(menu).getByTestId("swap-connect-error").textContent).toBe("TON Connect didn't load — check your connection and try again.");
    expect(menu.querySelector("section")?.getAttribute("aria-label")).toBe("TON wallets");
  });

  it("before its QR too; an installed wallet's pending prompt, or no attempt, is left alone", () => {
    for (const [connecting, cancels] of [["walletconnect", true], ["io.metamask", false], ["tron:org.tronlink.www", false], [null, false]] as const) {
      const wallets = api(connecting);
      const onClose = vi.fn();
      render(<ConnectSheet open focus={null} wallets={wallets} onClose={onClose} />);
      fireEvent.click(screen.getByTestId("sheet-close"));
      expect(wallets.disconnect).toHaveBeenCalledTimes(cancels ? 1 : 0);
      expect(onClose).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });
});

describe("the header's wallets: one button, one dropdown (D33)", () => {
  const ICON = "data:image/svg+xml;base64,PHN2Zy8+";
  const CONN = {
    evm: {family: "evm", address: "0xFc3b2A9e1D0c4b5a6978E1f2d3C4b5A6e7F88670", chainId: 1, walletName: "MetaMask", walletIcon: ICON, transport: "injected"},
    solana: {family: "solana", address: "Dc7GZ9wq5KnUuE4Ywd1BkDqDaHNJxgk1f3sH3QWkM3d", walletName: "MetaMask"},
    tron: {family: "tron", address: "TY1YHcrKY36YUKBwF2ARtjGtPD3s4ZeXeC", walletName: "TronLink"},
    ton: {family: "ton", address: "UQDemoTonAddress000000000000000000000000000000ton", walletName: "Tonkeeper"},
    near: {family: "near", address: "alice.near", walletName: "HOT Wallet"},
  } as const satisfies Record<string, WalletConnection>;
  type Family = keyof typeof CONN;
  const api = (families: readonly Family[]): WalletsApi => ({
    evm: families.includes("evm") ? CONN.evm : null,
    solana: families.includes("solana") ? CONN.solana : null,
    tron: families.includes("tron") ? CONN.tron : null,
    ton: families.includes("ton") ? CONN.ton : null,
    near: families.includes("near") ? CONN.near : null,
    owners: {},
    options: [],
    connecting: null,
    pairingUri: null,
    error: null,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  });
  const trigger = () => screen.getByTestId("swap-wallet-pill");
  const menu = () => screen.queryByTestId("swap-wallets-menu");

  it("no wallet: 'Connect wallet' opens the wallet sheet; one wallet: its address on one button", () => {
    const onWallets = vi.fn();
    const {rerender} = render(<WalletsDropdown wallets={api([])} onWallets={onWallets} />);
    expect(screen.queryByTestId("swap-wallet-pill")).toBeNull();
    fireEvent.click(screen.getByTestId("swap-connect-open"));
    expect(onWallets).toHaveBeenCalledTimes(1);

    rerender(<WalletsDropdown wallets={api(["evm"])} onWallets={onWallets} />);
    expect(trigger().textContent).toBe("0xFc…8670");
    expect(trigger().getAttribute("aria-label")).toBe("EVM wallet MetaMask 0xFc3b…8670");
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(within(trigger()).getByTestId("swap-wallet-pill-evm")).toBeTruthy();
  });

  it("several: their icons stacked and 'N wallets'; the dropdown lists them in family order with copy and disconnect", () => {
    const wallets = api(["tron", "evm", "solana"]);
    const onWallets = vi.fn();
    render(<WalletsDropdown wallets={wallets} onWallets={onWallets} />);
    expect(trigger().textContent).toBe("3 wallets");
    expect(trigger().getAttribute("aria-label")).toBe("3 wallets connected");
    expect([...trigger().querySelectorAll("[data-testid^='swap-wallet-pill-']")].map((e) => e.getAttribute("data-testid"))).toEqual([
      "swap-wallet-pill-evm",
      "swap-wallet-pill-solana",
      "swap-wallet-pill-tron",
    ]);
    expect(menu()).toBeNull();

    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const dropdown = screen.getByRole("dialog", {name: "Connected wallets"});
    expect(dropdown).toBe(menu());
    expect(trigger().getAttribute("aria-controls")).toBe(dropdown.id);
    const rows = within(dropdown).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["swap-wallet-row-evm", "swap-wallet-row-solana", "swap-wallet-row-tron"]);
    expect(rows[1]!.textContent).toContain("MetaMask · Solana");
    expect(rows[1]!.textContent).toContain("Dc7GZ9…kM3d");
    expect(within(rows[0]!).getByRole("button", {name: "Copy EVM address"})).toBeTruthy();
    // The wallet's own icon carries its network in the corner; a network logo stands alone.
    expect(rows[0]!.querySelector("img")?.getAttribute("src")).toBe(ICON);
    expect(rows[0]!.querySelectorAll("img")).toHaveLength(2);
    expect(rows[1]!.querySelectorAll("img")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("swap-wallet-disconnect-solana"));
    expect(wallets.disconnect).toHaveBeenCalledWith("solana");
    // Two are left: the dropdown stays.
    expect(menu()).toBe(dropdown);
    expect(within(dropdown).getByRole("button", {name: "Disconnect Tron wallet"})).toBeTruthy();

    // "Connect another wallet": closed, focus on the button (the wallet sheet hands it back there), the sheet opens.
    fireEvent.click(screen.getByTestId("swap-wallets-connect-more"));
    expect(onWallets).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("Escape closes it and hands focus back to the button; a press outside closes it; the button toggles it", () => {
    render(
      <>
        <button type="button">elsewhere</button>
        <WalletsDropdown wallets={api(["evm", "near"])} onWallets={() => {}} />
      </>,
    );
    fireEvent.click(trigger());
    screen.getByTestId("swap-wallet-copy-near").focus();
    fireEvent.keyDown(screen.getByTestId("swap-wallet-copy-near"), {key: "Escape"});
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());

    fireEvent.click(trigger());
    fireEvent.pointerDown(screen.getByTestId("swap-wallet-row-near"));
    expect(menu()).not.toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", {name: "elsewhere"}));
    expect(menu()).toBeNull();

    fireEvent.click(trigger());
    expect(menu()).not.toBeNull();
    fireEvent.click(trigger());
    expect(menu()).toBeNull();
  });

  it("focus leaving it closes it (Shift+Tab off the button); Escape then leaves the focus where it went", () => {
    render(
      <>
        <button type="button">elsewhere</button>
        <WalletsDropdown wallets={api(["evm", "near"])} onWallets={() => {}} />
      </>,
    );
    const elsewhere = screen.getByRole("button", {name: "elsewhere"});
    fireEvent.click(trigger());
    expect(document.activeElement).toBe(trigger());
    // within it (the button to a row's copy) it stays
    fireEvent.focusOut(trigger(), {relatedTarget: screen.getByTestId("swap-wallet-copy-near")});
    expect(menu()).not.toBeNull();
    act(() => elsewhere.focus());
    expect(menu()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(elsewhere, {key: "Escape"});
    expect(document.activeElement).toBe(elsewhere);
  });

  it("a disconnect by keyboard hands focus to the next row's disconnect, the previous row's after the last row", () => {
    const wallets = api(["evm", "solana", "tron"]);
    const {rerender} = render(<WalletsDropdown wallets={wallets} onWallets={() => {}} />);
    fireEvent.click(trigger());
    screen.getByTestId("swap-wallet-disconnect-solana").focus();
    fireEvent.click(screen.getByTestId("swap-wallet-disconnect-solana"));
    // not before the wallet is gone (the button still stands)
    expect(document.activeElement).toBe(screen.getByTestId("swap-wallet-disconnect-solana"));
    rerender(<WalletsDropdown wallets={api(["evm", "tron"])} onWallets={() => {}} />);
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("swap-wallet-disconnect-tron"));

    fireEvent.click(screen.getByTestId("swap-wallet-disconnect-tron"));
    rerender(<WalletsDropdown wallets={api(["evm"])} onWallets={() => {}} />);
    expect(document.activeElement).toBe(screen.getByTestId("swap-wallet-disconnect-evm"));
    expect(menu()!.contains(document.activeElement)).toBe(true);
  });

  it("all five connected: no 'Connect another wallet'", () => {
    render(<WalletsDropdown wallets={api(["evm", "solana", "tron", "ton", "near"])} onWallets={() => {}} />);
    fireEvent.click(trigger());
    expect(within(menu()!).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.queryByTestId("swap-wallets-connect-more")).toBeNull();
  });

  it("disconnecting the last wallet closes it, and 'Connect wallet' takes the focus once the wallet is gone", () => {
    const wallets = api(["ton"]);
    const {rerender} = render(<WalletsDropdown wallets={wallets} onWallets={() => {}} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId("swap-wallet-disconnect-ton"));
    expect(wallets.disconnect).toHaveBeenCalledWith("ton");
    expect(menu()).toBeNull();
    rerender(<WalletsDropdown wallets={api([])} onWallets={() => {}} />);
    expect(document.activeElement).toBe(screen.getByTestId("swap-connect-open"));
  });

  it("a wallet gone from elsewhere while it is open closes it; the next connect does not reopen it", () => {
    const {rerender} = render(<WalletsDropdown wallets={api(["evm"])} onWallets={() => {}} />);
    fireEvent.click(trigger());
    rerender(<WalletsDropdown wallets={api([])} onWallets={() => {}} />);
    rerender(<WalletsDropdown wallets={api(["evm"])} onWallets={() => {}} />);
    expect(menu()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("on a phone (375 px) the list is the app's bottom sheet", () => {
    viewport = installMatchMedia(375);
    render(<WalletsDropdown wallets={api(["evm", "solana"])} onWallets={() => {}} />);
    fireEvent.click(trigger());
    const sheet = screen.getByRole("dialog", {name: "Connected wallets"});
    expect(sheet).toBe(menu());
    expect(within(sheet).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(sheet).getByTestId("sheet-close"));
    expect(menu()).toBeNull();
  });

  it("on a phone 'Connect another wallet' opens the wallet sheet once the list's sheet has handed focus back to the button", async () => {
    viewport = installMatchMedia(375);
    // what was focused when the wallet sheet opened: where its own close hands focus back
    let opener: Element | null = null;
    const onWallets = vi.fn(() => {
      opener = document.activeElement;
    });
    render(<WalletsDropdown wallets={api(["evm"])} onWallets={onWallets} />);
    fireEvent.click(trigger());
    fireEvent.click(within(menu()!).getByTestId("swap-wallets-connect-more"));
    expect(onWallets).not.toHaveBeenCalled();
    await waitFor(() => expect(onWallets).toHaveBeenCalledTimes(1));
    expect(menu()).toBeNull();
    expect(opener).toBe(trigger());

    // closed any other way, it opens nothing
    fireEvent.click(trigger());
    fireEvent.click(within(menu()!).getByTestId("sheet-close"));
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
    expect(onWallets).toHaveBeenCalledTimes(1);
  });

  it("on the demo screen: the header opens the dropdown and a disconnect takes the wallet off it", async () => {
    renderScreen("#/?demoWallets=both");
    fireEvent.click(trigger());
    expect(within(menu()!).getAllByRole("listitem").map((r) => r.getAttribute("data-testid"))).toEqual(["swap-wallet-row-evm", "swap-wallet-row-solana"]);
    fireEvent.click(screen.getByTestId("swap-wallet-disconnect-evm"));
    await waitFor(() => expect(screen.queryByTestId("swap-wallet-row-evm")).toBeNull());
    expect(trigger().textContent).toBe("Demo…1111");
  });
});
