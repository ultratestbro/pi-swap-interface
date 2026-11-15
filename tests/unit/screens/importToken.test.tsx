// Importing a token by its address in the screens (D39), on the demo ports (offline lookups of DEMO_IMPORTABLE): the
// sheet's import result and network chooser, the confirmation (verbatim warning, look-alike line, required "I
// understand"), the imported row with its badge and remove button, a pair link naming an unlisted token (empty side,
// confirmation first, never trusted), the review's note; plus the pure decisions behind them.
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import type {ReactNode} from "react";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {DEFAULT_RUNTIME_CONFIG, PortsProvider, setRuntimeConfig} from "../../../src/config";
import type {SwapToken} from "../../../src/contracts/domain";
import type {SwapTokensState} from "../../../src/contracts/ports";
import {importedToken, chainBySlugWeb, TOKENS, swapTokens} from "../../../src/catalog";
import {DEMO_EVM_ADDRESS, demoPorts, resetDemoState} from "../../../src/mocks";
import {SwapScreen} from "../../../src/screens";
import {openingPair} from "../../../src/screens/form/useSwapForm";
import {IMPORT_WARNING, linkedToken, lookalikeLine, lookupNetwork, provisional, tokenAt, unsupportedLine} from "../../../src/screens/tokens/importModel";

const SLOW = {timeout: 4000};
const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const FAKE_USDC = "0x1111111111111111111111111111111111111111";
const BASE_USDC_KEY = "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function renderScreen(hash: string) {
  history.replaceState(null, "", `/${hash}`);
  resetDemoState();
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  const tree = (children: ReactNode) => (
    <QueryClientProvider client={client}>
      <PortsProvider ports={demoPorts}>{children}</PortsProvider>
    </QueryClientProvider>
  );
  return render(tree(<SwapScreen />));
}

beforeEach(() => setRuntimeConfig(DEFAULT_RUNTIME_CONFIG));
afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

describe("the token sheet's import", () => {
  it("reads a pasted contract on the sheet's network, lets another be chosen, and confirms with the warning", async () => {
    renderScreen("#/?amount=0.1");
    fireEvent.click(screen.getByTestId("swap-receive-token"));
    const sheet = await screen.findByTestId("swap-token-sheet");
    fireEvent.change(within(sheet).getByTestId("swap-token-search"), {target: {value: FAKE_USDC}});
    // Opened on Arbitrum (the receive token's network): the demo token isn't there.
    const result = within(sheet).getByTestId("swap-import-result");
    expect((within(result).getByTestId("swap-import-network") as HTMLSelectElement).value).toBe("arbitrum");
    expect(within(result).getByTestId("swap-import-failed").textContent).toMatch(/Demo mode reads only/);
    fireEvent.change(within(result).getByTestId("swap-import-network"), {target: {value: "base"}});
    fireEvent.click(await within(sheet).findByTestId("swap-import-open"));

    const confirm = await within(sheet).findByTestId("swap-import-confirm");
    expect(within(confirm).getByTestId("swap-import-symbol").textContent).toBe("USDC");
    expect(within(confirm).getByTestId("swap-import-address").textContent).toBe(FAKE_USDC);
    expect(within(confirm).getByTestId("swap-import-warning").textContent).toBe(IMPORT_WARNING);
    expect(within(confirm).getByTestId("swap-import-lookalike").textContent).toBe("Not the listed USDC — that one's address is 0x8335…2913");
    expect(within(confirm).getByTestId("swap-import-explorer").getAttribute("href")).toBe(`https://basescan.org/address/${FAKE_USDC}`);
    const importButton = within(confirm).getByTestId("swap-import-confirm-button") as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);
    fireEvent.click(within(confirm).getByTestId("swap-import-understand"));
    expect(importButton.disabled).toBe(false);
    fireEvent.click(importButton);

    await waitFor(() => expect(screen.getByTestId("swap-receive-token").getAttribute("aria-label")).toBe("USDC on Base, change token"), SLOW);
    // Listed under the catalog with its badge, and removable.
    fireEvent.click(screen.getByTestId("swap-receive-token"));
    const again = await screen.findByTestId("swap-token-sheet");
    const row = await within(again).findByTestId(`swap-token-base:${FAKE_USDC}`);
    expect(row.textContent).toContain("Imported");
    expect(row.getAttribute("aria-label")).toBe("USDC (imported) on Base");
    const keys = within(again)
      .getAllByRole("listitem")
      .map((li) => li.querySelector("[data-testid^='swap-token-']")?.getAttribute("data-testid"));
    expect(keys.indexOf(`swap-token-base:${FAKE_USDC}`)).toBeGreaterThan(keys.indexOf(`swap-token-${BASE_USDC_KEY}`));
    fireEvent.click(within(again).getByTestId(`swap-token-remove-base:${FAKE_USDC}`));
    await waitFor(() => expect(within(again).queryByTestId(`swap-token-base:${FAKE_USDC}`)).toBeNull());
  });

  it("shows the listed token for a listed address — nothing to import", async () => {
    renderScreen("#/?amount=0.1");
    fireEvent.click(screen.getByTestId("swap-receive-token"));
    const sheet = await screen.findByTestId("swap-token-sheet");
    fireEvent.click(within(sheet).getByTestId("swap-net-base"));
    fireEvent.change(within(sheet).getByTestId("swap-token-search"), {target: {value: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}});
    expect(within(sheet).queryByTestId("swap-import-result")).toBeNull();
    expect(within(sheet).getByTestId(`swap-token-${BASE_USDC_KEY}`)).toBeTruthy();
  });

  it("says a TON address can't be imported yet", async () => {
    renderScreen("#/");
    fireEvent.click(screen.getByTestId("swap-pay-token"));
    const sheet = await screen.findByTestId("swap-token-sheet");
    fireEvent.change(within(sheet).getByTestId("swap-token-search"), {target: {value: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"}});
    expect(within(sheet).getByTestId("swap-import-unsupported").textContent).toBe(unsupportedLine("ton"));
  });

  it("goes back from the confirmation to the search", async () => {
    renderScreen("#/");
    fireEvent.click(screen.getByTestId("swap-receive-token"));
    const sheet = await screen.findByTestId("swap-token-sheet");
    fireEvent.click(within(sheet).getByTestId("swap-net-base"));
    fireEvent.change(within(sheet).getByTestId("swap-token-search"), {target: {value: DEGEN}});
    fireEvent.click(await within(sheet).findByTestId("swap-import-open"));
    const confirm = await within(sheet).findByTestId("swap-import-confirm");
    expect(within(confirm).queryByTestId("swap-import-lookalike")).toBeNull();
    fireEvent.click(within(confirm).getByTestId("swap-import-cancel"));
    expect(await within(sheet).findByTestId("swap-import-result")).toBeTruthy();
  });
});

describe("a pair link naming an unlisted token (D39)", () => {
  it("opens with that side empty and the confirmation first; confirmed, the side is the token and the review notes it", async () => {
    renderScreen(`#/?pay=arbitrum:native&receive=base:${DEGEN.toLowerCase()}&amount=0.1&demoWallets=evm`);
    const confirm = await screen.findByTestId("swap-import-confirm");
    expect(within(confirm).getByTestId("swap-import-symbol").textContent).toBe("DEGEN");
    // No "Back" from a link's confirmation: it is the whole sheet.
    expect(within(confirm).queryByTestId("sheet-back")).toBeNull();
    expect(screen.getByTestId("swap-receive-token").getAttribute("aria-label")).toBe("Select a token");
    expect((screen.getByTestId("swap-review") as HTMLButtonElement).textContent).toBe("Select a token");
    fireEvent.click(within(confirm).getByTestId("swap-import-understand"));
    fireEvent.click(within(confirm).getByTestId("swap-import-confirm-button"));
    await waitFor(() => expect(screen.getByTestId("swap-receive-token").getAttribute("aria-label")).toBe("DEGEN on Base, change token"), SLOW);
    expect(screen.getByTestId("swap-pay-token").getAttribute("aria-label")).toBe("ETH on Arbitrum, change token");
    // Relay serves EVM → EVM with any destination token in the demo, as the real one does.
    await waitFor(() => expect((screen.getByTestId("swap-review") as HTMLButtonElement).textContent).toMatch(/^Review via /), {timeout: 6000});
    fireEvent.click(screen.getByTestId("swap-review"));
    const note = await screen.findByTestId("swap-review-imported", {}, SLOW);
    expect(note.textContent).toContain("Imported token: DEGEN");
    expect(note.textContent).toContain(DEGEN);
  });

  it("cancelled, the side stays empty — nothing is quoted for a token the viewer didn't confirm", async () => {
    renderScreen(`#/?pay=arbitrum:native&receive=base:${DEGEN.toLowerCase()}&amount=0.1&demoWallets=evm`);
    const confirm = await screen.findByTestId("swap-import-confirm");
    fireEvent.click(within(confirm).getByTestId("swap-import-cancel"));
    await waitFor(() => expect(screen.queryByTestId("swap-import-confirm")).toBeNull());
    expect(screen.getByTestId("swap-receive-token").getAttribute("aria-label")).toBe("Select a token");
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("ignores an address it can't read: no confirmation, the default takes that side", async () => {
    renderScreen(`#/?pay=arbitrum:native&receive=base:0x2222222222222222222222222222222222222222&amount=0.1&demoWallets=evm`);
    await waitFor(() => expect(screen.getByTestId("swap-receive-token").getAttribute("aria-label")).toBe("USDC on Arbitrum, change token"), SLOW);
    expect(screen.queryByTestId("swap-import-confirm")).toBeNull();
  });
});

// ── the pure decisions ───────────────────────────────────────────────────────────────────────────────────────────

const BASE = chainBySlugWeb("base")!;
const owners = {evm: DEMO_EVM_ADDRESS};
const LIST = swapTokens(TOKENS, {}, {}, owners);
const degen = importedToken(BASE, DEGEN, {decimals: 18, symbol: "DEGEN", name: "Degen"});

describe("import decisions", () => {
  it("looks a contract up on the sheet's network, else the other side's, else this side's, else Ethereum; a mint on Solana", () => {
    const on = (chain: string) => ({chain});
    expect(lookupNetwork({family: "evm", sheetNet: "base", other: on("arbitrum")})).toBe("base");
    expect(lookupNetwork({family: "evm", sheetNet: null, other: on("arbitrum"), own: on("base")})).toBe("arbitrum");
    expect(lookupNetwork({family: "evm", sheetNet: "solana", other: on("bitcoin"), own: on("optimism")})).toBe("optimism");
    expect(lookupNetwork({family: "evm", sheetNet: null})).toBe("ethereum");
    expect(lookupNetwork({family: "solana", sheetNet: "base"})).toBe("solana");
  });

  it("finds a token on the list at an address: any case on EVM, exactly on Solana", () => {
    expect(tokenAt(LIST, "base", "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913")?.symbol).toBe("USDC");
    expect(tokenAt(LIST, "arbitrum", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")).toBeUndefined();
    expect(tokenAt(LIST, "solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")?.symbol).toBe("USDC");
  });

  it("words the look-alike line by address, or as the network's own coin", () => {
    expect(lookalikeLine({...degen, symbol: "usdc"})).toBe("Not the listed USDC — that one's address is 0x8335…2913");
    expect(lookalikeLine({...degen, symbol: "ETH"})).toBe("Not the listed ETH — that one is Base's own coin");
    expect(lookalikeLine(degen)).toBeNull();
  });

  it("picks an import at once with its network's state", () => {
    expect(provisional(degen, LIST)).toMatchObject({key: degen.key, owner: DEMO_EVM_ADDRESS, payMode: "wallet", balance: "loading", amount: "0", usd: 0});
    expect(provisional(degen, swapTokens(TOKENS, {}, {}, {}))).toMatchObject({owner: null, payMode: "connect", balance: "none"});
  });

  it("reads a link's key: known in any EVM case, a listed Solana mint as written, an import, or nothing", () => {
    const byKey = new Map(LIST.map((t) => [t.key, t]));
    expect(linkedToken(BASE_USDC_KEY.toUpperCase().replace("BASE", "base"), byKey)).toEqual({kind: "known", key: BASE_USDC_KEY});
    expect(linkedToken("solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", byKey)).toEqual({kind: "known", key: "solana:epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v"});
    expect(linkedToken(`base:${DEGEN}`, byKey)).toEqual({kind: "import", key: `base:${DEGEN.toLowerCase()}`, caip2: "eip155:8453", address: DEGEN});
    expect(linkedToken(`base:${DEGEN}`, new Map([...byKey, [degen.key, degen]]))).toEqual({kind: "known", key: degen.key});
    expect(linkedToken("tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", byKey)).toEqual({kind: "known", key: "tron:tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t"});
    expect(linkedToken("base:garbage", byKey)).toBeNull();
    // The listed USDT on TON, as written in the catalog; an unlisted jetton is never imported (v1: EVM and Solana).
    expect(linkedToken("ton:EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", byKey)).toEqual({kind: "known", key: "ton:eqcxe6mutqjkfngfarotkot1lzbdiix1kcixrv7nw2id_sds"});
    expect(linkedToken("ton:EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT", byKey)).toBeNull();
    expect(linkedToken(undefined, byKey)).toBeNull();
  });
});

describe("openingPair", () => {
  const state = (all: SwapToken[]): SwapTokensState => ({all, pay: all, receive: all, byKey: new Map(all.map((t) => [t.key, t])), prices: {}, loading: false, refresh: () => {}});
  const held = (t: SwapToken): SwapToken => ({...t, amount: "1000", balance: "loaded"});

  it("never opens on an imported token the link didn't name, even a held one", () => {
    const tokens = state([...LIST, held(provisional(degen, LIST))]);
    const p = openingPair(tokens, {amount: ""}, new Set(tokens.pay.map((t) => t.key)));
    expect(p?.pay).not.toBe(degen.key);
    expect(p?.receive).not.toBe(degen.key);
  });

  it("keeps an awaited side's key (an empty side) and picks the other as if it were unset", () => {
    const tokens = state(LIST);
    const keys = new Set(LIST.map((t) => t.key));
    const p = openingPair(tokens, {pay: "arbitrum:native", receive: degen.key, amount: ""}, keys, {side: "receive", key: degen.key, settled: false});
    expect(p).toEqual({pay: "arbitrum:native", receive: degen.key});
    const q = openingPair(tokens, {pay: degen.key, amount: ""}, keys, {side: "pay", key: degen.key, settled: true});
    expect(q?.pay).toBe(degen.key);
    expect(q?.receive).toBeTruthy();
  });
});
