// The review sheet (ui-port.md §5.8, D34). Compact: one line per fact, the secondary one dim beside the value, the
// explanations behind an info mark — every fact Confirm authorizes still on screen as text. After Confirm it stays,
// locked, while the wallet is asked, follows the record the engine names, and becomes the status only once the swap
// itself is broadcast — never at an approval — or says why it stopped. A wallet that never answers can be left after a
// while: a chain switch is cancelled (the swap never starts), a started swap carries on in the background.
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {act, cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import {useSyncExternalStore, type ReactNode} from "react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {DEFAULT_RUNTIME_CONFIG, PortsProvider, setRuntimeConfig} from "../../../src/config";
import type {SwapRecord} from "../../../src/contracts/activity";
import type {SourceSigner, StartSwapInput} from "../../../src/contracts/execution";
import type {AppPorts} from "../../../src/contracts/ports";
import type {WebRoute} from "../../../src/contracts/routes";
import {INTERRUPTED_TEXT, newRecord} from "../../../src/activity";
import {DEMO_EVM_ADDRESS, demoPorts, demoSnapshot, demoSwapTokens} from "../../../src/mocks";
import {BACKGROUND_AFTER_MS, ReviewSheet, afterConfirm} from "../../../src/screens/review/ReviewSheet";
import {reviewRows} from "../../../src/screens/review/rows";
import {Toaster, TxReviewCard} from "../../../src/ui";

const ARB_USDC = "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const BASE_USDC = "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BTC_REFUND = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const OTHER = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const LOCAL = "local.1";
const HASH = `0x${"ab".repeat(32)}`;

const list = demoSwapTokens({evm: DEMO_EVM_ADDRESS});
const tokens = {all: list, pay: list, receive: list, byKey: new Map(list.map((t) => [t.key, t])), prices: {}, loading: false, refresh: () => {}};
const wallets = {evm: null, solana: null, tron: null, ton: null, near: null, owners: {}, options: [], connecting: null, pairingUri: null, error: null, connect: vi.fn(), disconnect: vi.fn()};
const from = list.find((t) => t.key === ARB_USDC)!;
const to = list.find((t) => t.key === BASE_USDC)!;
const req = {from, to, amountIn: 250_000_000n, slippageBps: 50, recipient: DEMO_EVM_ADDRESS, refundAddress: DEMO_EVM_ADDRESS};
const route: WebRoute = {...demoSnapshot().routes[0]!, validUntilMs: Date.now() + 10 * 60_000};

/** The record as the runner writes it at the engine's first step (an approval first). */
const submitting = (over: Partial<SwapRecord> = {}): SwapRecord => ({
  ...newRecord({
    id: LOCAL,
    accountId: `evm:${DEMO_EVM_ADDRESS}`,
    provider: "cctp",
    from: {caip2: from.caip2, chain: from.chain, symbol: "USDC", decimals: 6, key: ARB_USDC},
    to: {caip2: to.caip2, chain: to.chain, symbol: "USDC", decimals: 6, key: BASE_USDC},
    amountIn: 250_000_000n,
    expectedOut: 249_900_000n,
    minOut: 248_600_000n,
    recipient: DEMO_EVM_ADDRESS,
  }),
  status: "submitting",
  stage: "approving",
  approvals: 1,
  localId: LOCAL,
  ...over,
});

/** A records store the test moves by hand, behind fake activity / execute / wallets ports. */
function fakePorts() {
  let records: readonly SwapRecord[] = [];
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  };
  const get = () => records;
  const set = (r: SwapRecord) =>
    act(() => {
      records = [r];
      for (const l of listeners) l();
    });
  const startSwap = vi.fn(async (_input: StartSwapInput) => {
    records = [submitting()];
    for (const l of listeners) l();
    return LOCAL;
  });
  const ports: AppPorts = {
    ...demoPorts,
    wallets: {...demoPorts.wallets, getSigner: async () => ({family: "evm"}) as unknown as SourceSigner},
    swap: {...demoPorts.swap, useRequote: () => ({route, gone: null, failed: false, loading: false, refetch: () => {}})},
    execute: {...demoPorts.execute, startSwap},
    activity: {
      ...demoPorts.activity,
      useSwap(id: string | null) {
        const all = useSyncExternalStore(subscribe, get, get);
        return id ? all.find((r) => r.id === id || r.localId === id) : undefined;
      },
    },
  };
  return {ports, set, startSwap};
}

function renderReview(ports: AppPorts, onClose = vi.fn()) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  const tree = (children: ReactNode) => (
    <QueryClientProvider client={client}>
      <PortsProvider ports={ports}>{children}</PortsProvider>
    </QueryClientProvider>
  );
  const noop = () => {};
  render(tree(<ReviewSheet open draft={{req, route}} tokens={tokens} wallets={wallets} slippage="Auto slippage 0.5%" onClose={onClose} onShowStatus={noop} onTryAgain={noop} onConnect={noop} />));
  return onClose;
}

/** Press Confirm and let getSigner + startSwap resolve. */
async function confirm() {
  await act(async () => {
    fireEvent.click(screen.getByTestId("swap-confirm"));
  });
}

beforeEach(() => setRuntimeConfig(DEFAULT_RUNTIME_CONFIG));

describe("the review's rows (D34)", () => {
  const ETH = {symbol: "ETH", decimals: 18};
  const rowsOf = (over: Partial<typeof req> = {}, r: Partial<WebRoute> = {}) =>
    reviewRows({req: {...req, slippageBps: 30, ...over}, route: {...route, ...r}, from: over.from ?? from, to: over.to ?? to, native: ETH, slippage: "Auto slippage 0.3%"});
  const row = (rows: ReturnType<typeof rowsOf>, k: string) => rows.find((x) => x.k === k);

  it("one line per fact: the secondary fact as a note, the slippage breakdown behind the info mark, one row for one address", () => {
    const rows = rowsOf();
    expect(rows.map((x) => x.k)).toEqual(["You pay", "You receive", "Minimum received", "Rate", "Route", "Fees", "Approval", "From / To"]);
    expect(rows.filter((x) => x.sub !== undefined)).toEqual([]);
    expect(row(rows, "You pay")).toMatchObject({v: "250.00 USDC", note: "$250.00", testId: "swap-review-pay"});
    expect(row(rows, "Minimum received")).toMatchObject({
      note: "0.3% + margin",
      tip: "Auto slippage 0.3% + 0.5% margin · quoted 0.00%. The swap is refused if it would deliver less.",
      testId: "swap-review-min",
    });
    // The venue, its trust badge and its timing; what the trust level means is the row's tip (and the badge's tooltip).
    expect(row(rows, "Route")).toMatchObject({
      v: "Circle CCTP",
      note: "~45 s · claim on arrival",
      tip: "Quoted and settled by contracts on Arbitrum — no company API",
      testId: "swap-review-route",
    });
    expect(row(rows, "Route")?.badge).toBeTruthy();
    expect(row(rows, "Fees")).toMatchObject({v: "In the price", note: "+ gas ≤ $0.03 in ETH"});
    expect(row(rows, "Approval")).toMatchObject({v: "Exact 250.00 USDC", note: "spender 0x28b5a0…68cf5d", testId: "swap-review-approval"});
    expect(row(rows, "From / To")).toMatchObject({v: "0x709979…dc79C8", note: "yours on both chains", testId: "swap-review-to"});
  });

  it("another address: From and To apart, To in amber; a bridge fee and a gas-less fee line keep their facts", () => {
    const rows = rowsOf({recipient: OTHER}, {nativeFee: 1_200_000_000_000_000n, gasUsd: null, feeUsd: 0.41, approvalSpender: null});
    expect(row(rows, "From")).toMatchObject({v: "0x709979…dc79C8", note: "your Arbitrum address"});
    expect(row(rows, "To")).toMatchObject({v: "0x8ba1f1…4DBA72", note: "not this wallet", color: "var(--amber)", testId: "swap-review-to"});
    expect(row(rows, "From / To")).toBeUndefined();
    expect(row(rows, "Bridge fee")).toMatchObject({v: "0.0012 ETH", note: "on top of the amount"});
    expect(row(rows, "Fees")).toMatchObject({v: "$0.41", note: "+ network fee in ETH"});
    expect(row(rows, "Approval")).toMatchObject({v: "Not needed"});
    expect(row(rows, "Approval")?.note).toBeUndefined();
  });

  it("a QR payer: the refund address and where it goes, no approval", () => {
    const btc = list.find((t) => t.key === "bitcoin:native")!;
    const rows = rowsOf({from: btc, refundAddress: BTC_REFUND, amountIn: 1_500_000n});
    expect(row(rows, "Approval")).toBeUndefined();
    expect(row(rows, "Refund to")).toMatchObject({v: "bc1qw508…v8f3t4", note: "refunds go here", testId: "swap-review-refund"});
    expect(row(rows, "To")).toMatchObject({note: "your Base address", testId: "swap-review-to"});
  });

  it("the card keeps the value alone under its test id, the note beside it and the tip behind a named info mark", () => {
    render(<TxReviewCard compact rows={[{k: "Minimum received", v: "0.0098 ETH", note: "0.5% + margin", tip: "Why this number", testId: "min"}]} />);
    expect(screen.getByTestId("min").textContent).toBe("0.0098 ETH");
    expect(screen.getByText("0.5% + margin")).toBeTruthy();
    expect(screen.getByRole("button", {name: "About minimum received"})).toBeTruthy();
    expect(screen.getByText("Why this number")).toBeTruthy();
  });

  it("the sheet says the networks once, and keeps every row's test id", () => {
    const {ports} = fakePorts();
    renderReview(ports);
    const body = screen.getByTestId("swap-review-body");
    expect(within(body).getAllByText("Arbitrum → Base")).toHaveLength(1);
    for (const id of ["swap-review-amount", "swap-review-pay", "swap-review-receive", "swap-review-min", "swap-review-route", "swap-review-approval", "swap-review-to"])
      expect(within(body).getByTestId(id)).toBeTruthy();
    expect(within(body).getByText("On-chain")).toBeTruthy();
    // The trust sentence has a focusable home (keyboard, a tap), not only the badge's hover.
    expect(within(body).getByRole("button", {name: "About route"}).closest("[aria-describedby]")?.textContent).toContain(
      "Quoted and settled by contracts on Arbitrum — no company API",
    );
    expect(screen.getByTestId("swap-review-fine").textContent).toMatch(
      /^Valid \d+:\d\d · re-quoted before signing; refused below the minimum, to another address or with an unseen approval · signed in your browser$/,
    );
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("afterConfirm", () => {
  it("waits through the approval and the signing, and goes to the status at the swap's hash or a tracked state", () => {
    expect(afterConfirm(submitting(), "Base")).toBeNull();
    expect(afterConfirm(submitting({stage: "signing", approved: true}), "Base")).toBeNull();
    expect(afterConfirm(submitting({stage: "broadcast", sourceHash: HASH}), "Base")).toEqual({step: "status"});
    // Signed orders (no source transaction) and maybe-sent broadcasts are tracked records: the status follows them.
    expect(afterConfirm({...submitting(), id: "awk1.cctp.x", status: "pending"}, "Base")).toEqual({step: "status"});
    expect(afterConfirm({...submitting(), status: "pending", maybeSent: true}, "Base")).toEqual({step: "status"});
  });

  it("a stop before the broadcast is the error phase with the record's reason; another tab's 'interrupted' is not", () => {
    const stopped = submitting({status: "not-sent", error: "You declined in your wallet — nothing was sent."});
    expect(afterConfirm(stopped, "Base")).toEqual({step: "error", message: "You declined in your wallet — nothing was sent."});
    expect(afterConfirm(submitting({status: "not-sent", error: INTERRUPTED_TEXT}), "Base")).toBeNull();
  });
});

describe("the review after Confirm", () => {
  it("stays, locked, through the approval and the swap's signing, and becomes the status at the broadcast", async () => {
    const {ports, set, startSwap} = fakePorts();
    const onClose = renderReview(ports);
    await confirm();
    expect(startSwap).toHaveBeenCalledTimes(1);
    const body = screen.getByTestId("swap-review-body");
    // The steps follow the record from its first step; Confirm stays loading, nothing closes the sheet.
    expect(within(body).getByTestId("swap-step-approve-active")).toBeTruthy();
    expect((screen.getByTestId("swap-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/^Check your wallet/);
    expect(screen.queryByTestId("sheet-close")).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), {key: "Escape"});
    expect(onClose).not.toHaveBeenCalled();
    // Compact once confirmed (D37): the amounts, the floor and the venue stay above the steps; the rest was reviewed.
    for (const id of ["swap-review-amount", "swap-review-pay", "swap-review-receive", "swap-review-min", "swap-review-route"]) expect(within(body).getByTestId(id)).toBeTruthy();
    for (const id of ["swap-review-approval", "swap-review-to"]) expect(within(body).queryByTestId(id)).toBeNull();

    // The approval went out — not the swap: still the review.
    set(submitting({stage: "signing", approved: true}));
    // The wallet holds the swap: its confirmation is the open step, never green before it signs.
    expect(within(screen.getByTestId("swap-review-body")).getByTestId("swap-step-confirm-active")).toBeTruthy();
    expect(within(screen.getByTestId("swap-review-body")).getByText("Confirm the transaction")).toBeTruthy();
    expect(within(screen.getByTestId("swap-review-body")).getByText("Waiting for your wallet")).toBeTruthy();
    expect(within(screen.getByTestId("swap-review-body")).queryByText("You confirmed the transaction")).toBeNull();
    expect(screen.queryByTestId("swap-status-view")).toBeNull();

    // The wallet returned the swap's hash: the sheet is its status now, and the record's id is followed from there.
    set(submitting({stage: "broadcast", approved: true, sourceHash: HASH}));
    expect(screen.queryByTestId("swap-review-body")).toBeNull();
    expect(screen.getByTestId("swap-status-view")).toBeTruthy();
    expect(screen.getByTestId("swap-background")).toBeTruthy();
    set({...submitting({approved: true, sourceHash: HASH}), id: `awk1.cctp.x.${HASH}`, status: "pending", stage: undefined});
    expect(screen.getByTestId("swap-status").textContent).toBe("In progress");
  });

  it("a swap that stops before its broadcast shows why, and can be reviewed again", async () => {
    const {ports, set} = fakePorts();
    renderReview(ports);
    await confirm();
    set(submitting({status: "not-sent", error: "You declined in your wallet — nothing was sent."}));
    expect(screen.queryByTestId("swap-status-view")).toBeNull();
    const error = screen.getByTestId("swap-review-error");
    expect(within(error).getByText("Not swapped")).toBeTruthy();
    expect(screen.getByTestId("swap-error").textContent).toBe("You declined in your wallet — nothing was sent.");
    fireEvent.click(screen.getByTestId("swap-retry"));
    expect(screen.getByTestId("swap-review-body")).toBeTruthy();
    expect((screen.getByTestId("swap-confirm") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a wallet that never answers: after a while 'Continue in background' closes the sheet; the record carries on", async () => {
    vi.useFakeTimers();
    const {ports} = fakePorts();
    const onClose = renderReview(ports);
    await confirm();
    expect(screen.queryByTestId("swap-review-background")).toBeNull();
    act(() => vi.advanceTimersByTime(BACKGROUND_AFTER_MS - 1_000));
    expect(screen.queryByTestId("swap-review-background")).toBeNull();
    act(() => vi.advanceTimersByTime(1_000));
    // Still locked otherwise: the offer is the only way out, and it doesn't touch the swap.
    expect(screen.queryByTestId("sheet-close")).toBeNull();
    expect(screen.queryByTestId("swap-review-cancel")).toBeNull();
    fireEvent.click(screen.getByTestId("swap-review-background"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a chain switch that never answers: the way out is 'Cancel', and a switch that lands afterwards starts nothing", async () => {
    vi.useFakeTimers();
    const {ports, startSwap} = fakePorts();
    let switched: (s: SourceSigner) => void = () => {};
    const getSigner = () => new Promise<SourceSigner>((resolve) => (switched = resolve));
    const onClose = renderReview({...ports, wallets: {...ports.wallets, getSigner}});
    await confirm();
    act(() => vi.advanceTimersByTime(BACKGROUND_AFTER_MS));
    // Nothing is started yet, so nothing would carry on "in the background".
    expect(screen.queryByTestId("swap-review-background")).toBeNull();
    fireEvent.click(screen.getByTestId("swap-review-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    // The wallet switches later (a phone answering at last): the review it was for is gone, no swap is asked for.
    await act(async () => switched({family: "evm"} as unknown as SourceSigner));
    expect(startSwap).not.toHaveBeenCalled();
  });

  it("a started swap the engine hasn't named yet: 'Continue in background', and a stop after leaving is a toast", async () => {
    vi.useFakeTimers();
    const {ports} = fakePorts();
    // A signed order waits for its signature before the engine's first step: startSwap hasn't resolved, no record.
    let refuse: (e: unknown) => void = () => {};
    const startSwap = () => new Promise<string>((_, reject) => (refuse = reject));
    const onClose = renderReview({...ports, execute: {...ports.execute, startSwap}});
    render(<Toaster />);
    await confirm();
    act(() => vi.advanceTimersByTime(BACKGROUND_AFTER_MS));
    expect(screen.queryByTestId("swap-review-cancel")).toBeNull();
    fireEvent.click(screen.getByTestId("swap-review-background"));
    expect(onClose).toHaveBeenCalledTimes(1);
    // The activity drawer has no record to show it: the stop is said where the user is now.
    await act(async () => refuse(new Error("quote expired")));
    expect(screen.getByText("Not swapped: The quote expired before signing — nothing was swapped. Review it again.")).toBeTruthy();
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByText(/^Not swapped: /)).toBeNull();
  });

  it("a stop while the review is still open is the error phase, never a toast", async () => {
    const {ports} = fakePorts();
    const startSwap = () => Promise.reject(new Error("quote expired"));
    renderReview({...ports, execute: {...ports.execute, startSwap}});
    render(<Toaster />);
    await confirm();
    expect(screen.getByTestId("swap-error").textContent).toBe("The quote expired before signing — nothing was swapped. Review it again.");
    expect(screen.queryByText(/^Not swapped: /)).toBeNull();
  });
});
