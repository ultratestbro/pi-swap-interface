// Settings → Connection (D30): the modes a build offers, the copy about what goes where, Custom's RPC rows and keys
// (saved in this browser only, cleared at once) and its network picker, all keyboard-reachable like the rest of the sheet.
import {act, cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {CHAIN_LIST} from "../../../src/catalog";
import {CONNECTION_KEY, DEFAULT_RUNTIME_CONFIG, VENUE_KEYS_KEY, setRuntimeConfig, standardSlots} from "../../../src/config";
import {SettingsSheet} from "../../../src/screens/settings/SettingsSheet";
import {networkLogo} from "../../../src/ui";
import {installMatchMedia, type FakeViewport} from "../ui/matchMedia";

let viewport: FakeViewport;

beforeEach(() => {
  viewport = installMatchMedia(1280);
  setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
});
afterEach(() => {
  cleanup();
  viewport.restore();
  localStorage.clear();
  setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
});

const open = (onClose: () => void = () => {}) => render(<SettingsSheet open onClose={onClose} />);
const radios = () => within(screen.getByTestId("settings-connection")).getAllByRole("radio") as HTMLInputElement[];

/** The EVM networks Custom offers an RPC row for, in the picker's order (Solana comes last). */
const EVM = CHAIN_LIST.filter((c) => c.family === "evm" && c.chainId !== undefined);

/** Pick a network in Custom's add row as a pointer does: open the picker, click the option (the phone sheet is a portal). */
function pickNetwork(name: string) {
  fireEvent.click(screen.getByTestId("settings-custom-network"));
  fireEvent.click(within(screen.getByRole("listbox", {name: "Networks"})).getByRole("option", {name}));
}

describe("Settings → Connection", () => {
  it("a build without a cp0x API offers Public (chosen) and Custom, and says it never contacts cp0x", () => {
    open();
    expect(radios().map((r) => r.value)).toEqual(["public", "custom"]);
    expect(radios()[0]!.checked).toBe(true);
    fireEvent.click(screen.getByTestId("settings-connection-info"));
    expect(screen.getByTestId("settings-connection-privacy").textContent).toBe("This copy of the app has no Standard mode and never contacts cp0x.");
    expect(screen.queryByTestId("settings-connection-status")).toBeNull();
    expect(screen.queryByTestId("settings-custom")).toBeNull();
    expect(screen.queryByTestId("settings-standard-count")).toBeNull();
  });

  it("a build without a cp0x API shows Fynd as Standard-only, switched off for good; Curve is an ordinary venue", () => {
    open();
    expect(screen.getByTestId("settings-venue-fynd-note").textContent).toBe("Standard mode only — not in this copy of the app");
    const fynd = screen.getByTestId("settings-venue-fynd") as HTMLButtonElement;
    expect(fynd.disabled).toBe(true);
    expect(fynd.getAttribute("aria-checked")).toBe("false");
    const curve = screen.getByTestId("settings-venue-curve") as HTMLButtonElement;
    expect([curve.disabled, curve.getAttribute("aria-checked")]).toEqual([false, "true"]);
    expect(screen.queryByTestId("settings-venue-curve-note")).toBeNull();
  });

  it("the hosted build offers Standard first, as the default, with the privacy copy", () => {
    const api = "https://cp0x-api.example.org";
    const {config, plan} = standardSlots(DEFAULT_RUNTIME_CONFIG, api);
    setRuntimeConfig(config, undefined, {mode: "standard", api, plan, keys: {}});
    open();
    expect(radios().map((r) => r.value)).toEqual(["standard", "public", "custom"]);
    expect(radios()[0]!.checked).toBe(true);
    // The swap counter (D36), said right under the mode.
    expect(screen.getByTestId("settings-standard-count").textContent).toBe("Counts each swap you send — no address.");
    // Fynd can be turned off here (it is asked only in Standard, through cp0x). No Standard runtime runs in this test,
    // so the note's status part isn't checked here (model.test.ts covers each line, standard.spec.ts the live ones).
    expect(screen.getByTestId("settings-venue-fynd-note").textContent).toMatch(/^Standard mode only — /);
    expect((screen.getByTestId("settings-venue-fynd") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("settings-connection-info"));
    const privacy = screen.getByTestId("settings-connection-privacy").textContent!;
    expect(privacy).toMatch(/through cp0x's server, which adds cp0x's API keys/);
    expect(privacy).toMatch(/never sees your wallet keys and signs nothing/);
    expect(privacy).toMatch(/every transaction is still checked in this browser/);
    expect(privacy).toMatch(/Public and Custom never contact cp0x/);
    expect(privacy).toMatch(/once per swap you send which venue and networks it used — no address or transaction/);
    // Choosing another mode says when it applies, and Public counts nothing.
    fireEvent.click(radios()[1]!);
    expect(screen.getByTestId("settings-connection").textContent).toMatch(/Applies after you save and reload/);
    expect(screen.queryByTestId("settings-standard-count")).toBeNull();
  });

  it("Custom: add an RPC per network (Enter adds), refuse plain http here, remove a row, and save mode, RPCs and keys", () => {
    open();
    fireEvent.click(radios()[1]!);
    const panel = screen.getByTestId("settings-custom");
    expect(within(panel).getByTestId("settings-keys-note").textContent).toMatch(/Stored only in this browser — anyone with access to this browser profile can read them/);
    pickNetwork("Arbitrum");
    const url = within(panel).getByTestId("settings-custom-url");
    expect(url.getAttribute("aria-label")).toBe("RPC URL for Arbitrum");
    fireEvent.change(url, {target: {value: "http://arb.example"}});
    fireEvent.keyDown(url, {key: "Enter"});
    expect(within(panel).getByText(/Use an https:\/\/ URL/)).toBeTruthy();
    fireEvent.change(url, {target: {value: "https://arb.example"}});
    fireEvent.keyDown(url, {key: "Enter"});
    pickNetwork("Solana");
    fireEvent.change(url, {target: {value: "https://sol.example"}});
    fireEvent.click(within(panel).getByTestId("settings-custom-add"));
    const rows = within(panel).getByTestId("settings-custom-rpcs");
    expect(within(rows).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.change(url, {target: {value: "https://extra.example"}});
    fireEvent.keyDown(url, {key: "Enter"});
    fireEvent.click(within(panel).getByRole("button", {name: "Remove https://extra.example for Solana"}));
    expect(within(rows).getAllByRole("listitem")).toHaveLength(2);

    const relay = within(panel).getByTestId("settings-key-relay") as HTMLInputElement;
    expect(relay.type).toBe("password");
    fireEvent.change(relay, {target: {value: "test-key"}});
    // Symbiosis' partner key: its CORS allows X-Api-Key (checked 2026-11-12), so Custom offers it too.
    const symbiosis = within(panel).getByTestId("settings-key-symbiosis") as HTMLInputElement;
    expect(symbiosis.type).toBe("password");
    fireEvent.change(symbiosis, {target: {value: "test-sym"}});
    fireEvent.click(screen.getByTestId("settings-save"));
    expect(JSON.parse(localStorage.getItem(CONNECTION_KEY)!)).toEqual({mode: "custom", custom: {evmRpc: {42161: ["https://arb.example"]}, solanaRpc: ["https://sol.example"]}});
    expect(JSON.parse(localStorage.getItem(VENUE_KEYS_KEY)!)).toEqual({relay: "test-key", symbiosis: "test-sym"});
    // The key lives only under its own entry: not in the settings layer, the connection entry or the page.
    expect(localStorage.getItem("cp0x.swap.settings.v1") ?? "").not.toContain("test-key");
    expect(localStorage.getItem(CONNECTION_KEY)).not.toContain("test-key");
    expect(screen.getByTestId("settings-reload")).toBeTruthy();
  });

  it("a key the venue can't have is refused by name, without echoing it; Clear removes the saved keys at once", () => {
    localStorage.setItem(CONNECTION_KEY, JSON.stringify({mode: "custom", custom: {}}));
    localStorage.setItem(VENUE_KEYS_KEY, JSON.stringify({lifi: "test-key"}));
    open();
    const panel = screen.getByTestId("settings-custom");
    expect((within(panel).getByTestId("settings-key-lifi") as HTMLInputElement).value).toBe("test-key");
    fireEvent.change(within(panel).getByTestId("settings-key-jupiter"), {target: {value: "x".repeat(600)}});
    fireEvent.click(screen.getByTestId("settings-save"));
    const alert = screen.getByRole("alert").textContent!;
    expect(alert).toMatch(/^Jupiter key: Longer than 512 characters/);
    expect(alert).not.toContain("xxxx");
    fireEvent.click(within(panel).getByTestId("settings-keys-clear"));
    expect(localStorage.getItem(VENUE_KEYS_KEY)).toBeNull();
    expect((within(panel).getByTestId("settings-key-lifi") as HTMLInputElement).value).toBe("");
  });

  it("keys saved under Custom stay visible, and clearable, when another mode is picked", () => {
    localStorage.setItem(VENUE_KEYS_KEY, JSON.stringify({jupiter: "test-key"}));
    open();
    expect(radios()[0]!.checked).toBe(true);
    expect(screen.getByTestId("settings-keys-saved").textContent).toMatch(/only Custom mode uses them/);
    fireEvent.click(screen.getByTestId("settings-keys-clear"));
    expect(localStorage.getItem(VENUE_KEYS_KEY)).toBeNull();
    expect(screen.queryByTestId("settings-keys-saved")).toBeNull();
    expect(screen.getByTestId("settings-keys-cleared")).toBeTruthy();
    expect(screen.getByTestId("settings-save")).toBeTruthy();
  });

  it("Clear keys acts at once and says so, but leaves Save: the picked mode is still saved by Save, not lost on reload", () => {
    const api = "https://cp0x-api.example.org";
    setRuntimeConfig(DEFAULT_RUNTIME_CONFIG, undefined, {mode: "custom", api, plan: null, keys: {lifi: "test-key"}});
    localStorage.setItem(CONNECTION_KEY, JSON.stringify({mode: "custom", custom: {}}));
    localStorage.setItem(VENUE_KEYS_KEY, JSON.stringify({lifi: "test-key"}));
    open();
    fireEvent.click(screen.getByTestId("settings-mode-standard"));
    expect(screen.getByTestId("settings-keys-saved")).toBeTruthy();
    fireEvent.click(screen.getByTestId("settings-keys-clear"));
    expect(localStorage.getItem(VENUE_KEYS_KEY)).toBeNull();
    expect(screen.getByTestId("settings-keys-cleared").textContent).toBe("Your API keys were removed from this browser.");
    expect(screen.queryByTestId("settings-reload")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-save"));
    expect(JSON.parse(localStorage.getItem(CONNECTION_KEY)!).mode).toBe("standard");
    expect(screen.getByTestId("settings-reload")).toBeTruthy();
  });

  it("Clear keys inside Custom keeps the unsaved RPC rows for Save (375 px)", () => {
    viewport.restore();
    viewport = installMatchMedia(375);
    localStorage.setItem(VENUE_KEYS_KEY, JSON.stringify({jupiter: "test-key"}));
    open();
    fireEvent.click(radios()[1]!);
    const panel = screen.getByTestId("settings-custom");
    fireEvent.change(within(panel).getByTestId("settings-custom-url"), {target: {value: "https://eth.example"}});
    fireEvent.click(within(panel).getByTestId("settings-custom-add"));
    fireEvent.click(within(panel).getByTestId("settings-keys-clear"));
    expect(within(panel).getByTestId("settings-keys-cleared")).toBeTruthy();
    expect(localStorage.getItem(CONNECTION_KEY)).toBeNull();
    fireEvent.click(screen.getByTestId("settings-save"));
    // The picker starts on the first EVM network.
    expect(within(panel).getByTestId("settings-custom-network").textContent).toBe(EVM[0]!.name);
    expect(JSON.parse(localStorage.getItem(CONNECTION_KEY)!)).toEqual({mode: "custom", custom: {evmRpc: {[EVM[0]!.chainId!]: ["https://eth.example"]}, solanaRpc: []}});
  });

  it("keys typed under Custom and abandoned for another mode are neither called saved nor written by Save", () => {
    open();
    fireEvent.click(radios()[1]!);
    fireEvent.change(within(screen.getByTestId("settings-custom")).getByTestId("settings-key-jupiter"), {target: {value: "test-key"}});
    fireEvent.click(radios()[0]!);
    expect(screen.queryByTestId("settings-keys-saved")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-save"));
    expect(localStorage.getItem(VENUE_KEYS_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(CONNECTION_KEY)!).mode).toBe("public");
  });

  it("Save in another mode leaves the stored keys as they were, unsaved edits to them dropped", () => {
    localStorage.setItem(CONNECTION_KEY, JSON.stringify({mode: "custom", custom: {}}));
    localStorage.setItem(VENUE_KEYS_KEY, JSON.stringify({lifi: "test-key"}));
    open();
    fireEvent.change(within(screen.getByTestId("settings-custom")).getByTestId("settings-key-lifi"), {target: {value: "other-key"}});
    fireEvent.click(radios()[0]!);
    fireEvent.click(screen.getByTestId("settings-save"));
    expect(JSON.parse(localStorage.getItem(VENUE_KEYS_KEY)!)).toEqual({lifi: "test-key"});
    expect(screen.getByTestId("settings-keys-saved")).toBeTruthy();
  });

  it("on a Standard page, Public's venue base placeholders show each venue's public base, never the proxy slot; a pasted cp0x URL is refused", () => {
    const api = "https://cp0x-api.example.org";
    const {config, plan} = standardSlots(DEFAULT_RUNTIME_CONFIG, api);
    setRuntimeConfig(config, undefined, {mode: "standard", api, plan, keys: {}});
    open();
    fireEvent.click(screen.getByTestId("settings-mode-public"));
    const jupiter = screen.getByLabelText("Jupiter", {exact: true}) as HTMLInputElement;
    expect(jupiter.placeholder).toBe(DEFAULT_RUNTIME_CONFIG.api.jupiter);
    expect((screen.getByLabelText("LI.FI", {exact: true}) as HTMLInputElement).placeholder).toBe(DEFAULT_RUNTIME_CONFIG.api.lifi);
    expect((screen.getByLabelText("Chainflip", {exact: true}) as HTMLInputElement).placeholder).toBe(DEFAULT_RUNTIME_CONFIG.api.chainflip);
    fireEvent.change(jupiter, {target: {value: `${api}/api/v2/swap-web/venue/jupiter`}});
    fireEvent.click(screen.getByTestId("settings-save"));
    expect(screen.getByRole("alert").textContent).toMatch(/^Jupiter: that is cp0x's server/);
    expect(localStorage.getItem("cp0x.swap.settings.v1")).toBeNull();
  });

  it("the info button opens the status and what each mode sends where, and closes them again", () => {
    open();
    const info = screen.getByTestId("settings-connection-info");
    expect(info.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("settings-connection-about")).toBeNull();
    fireEvent.click(info);
    expect(info.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("settings-connection-about").id).toBe(info.getAttribute("aria-controls"));
    fireEvent.click(info);
    expect(screen.queryByTestId("settings-connection-about")).toBeNull();
  });

  it("Standard shows no venue API bases and no WalletConnect id (the site's own); another mode shows both", () => {
    const api = "https://cp0x-api.example.org";
    const {config, plan} = standardSlots(DEFAULT_RUNTIME_CONFIG, api);
    setRuntimeConfig(config, undefined, {mode: "standard", api, plan, keys: {}});
    open();
    expect(screen.queryByText("Venue API bases")).toBeNull();
    expect(screen.queryByLabelText("WalletConnect project id")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-mode-custom"));
    expect(screen.getByText("Venue API bases")).toBeTruthy();
    expect(screen.getByLabelText("WalletConnect project id")).toBeTruthy();
  });

  it("saving in Standard drops base, price and WalletConnect overrides kept from another mode, and keeps the venue switches", () => {
    localStorage.setItem(
      "cp0x.swap.settings.v1",
      JSON.stringify({providers: {lifi: false}, api: {jupiter: "https://jup.example.org"}, prices: {defillama: "https://llama.example.org"}, walletConnect: {projectId: "a".repeat(32)}}),
    );
    const api = "https://cp0x-api.example.org";
    const {config, plan} = standardSlots(DEFAULT_RUNTIME_CONFIG, api);
    setRuntimeConfig(config, undefined, {mode: "standard", api, plan, keys: {}});
    open();
    fireEvent.click(screen.getByTestId("settings-save"));
    expect(JSON.parse(localStorage.getItem("cp0x.swap.settings.v1")!)).toEqual({providers: {lifi: false}});
  });

  it("an older browser's RPCs come back as Custom with 'Use only my RPCs' on; switching it off saves the public fallback back", () => {
    localStorage.setItem("cp0x.swap.settings.v1", JSON.stringify({evmRpc: {"1": ["https://my-own-eth.example"]}}));
    open();
    expect(radios()[1]!.checked).toBe(true);
    const only = screen.getByTestId("settings-custom-only");
    expect(only.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("settings-custom-fallback").textContent).toMatch(/no public RPC is asked there/);
    fireEvent.click(only);
    expect(screen.getByTestId("settings-custom-fallback").textContent).toBe("Tried before the public ones, which stay as the fallback.");
    fireEvent.click(screen.getByTestId("settings-save"));
    expect(JSON.parse(localStorage.getItem(CONNECTION_KEY)!)).toEqual({mode: "custom", custom: {evmRpc: {1: ["https://my-own-eth.example"]}, solanaRpc: []}});
  });

  it("Reset clears the connection choice, Custom's RPCs and the keys too", () => {
    localStorage.setItem(CONNECTION_KEY, JSON.stringify({mode: "custom", custom: {solanaRpc: ["https://sol.example"]}}));
    localStorage.setItem(VENUE_KEYS_KEY, JSON.stringify({lifi: "test-key"}));
    open();
    fireEvent.click(screen.getByTestId("settings-reset"));
    expect(localStorage.getItem(CONNECTION_KEY)).toBeNull();
    expect(localStorage.getItem(VENUE_KEYS_KEY)).toBeNull();
    expect(radios()[0]!.checked).toBe(true);
  });
});

describe("Settings → Custom's network picker", () => {
  /** Open Settings in Custom; the picker's trigger. */
  function custom(onClose?: () => void) {
    open(onClose);
    fireEvent.click(radios()[1]!);
    return screen.getByTestId("settings-custom-network");
  }
  const search = () => screen.getByRole("combobox", {name: "Search networks"});
  /** An option's name, without its logo (a network with no bundled logo shows a monogram, e.g. Morph's "MORP"). */
  const nameOf = (o: Element | null) => o?.querySelector(":scope > span:not([aria-hidden])")?.textContent;
  const activeName = () => nameOf(document.getElementById(search().getAttribute("aria-activedescendant") ?? ""));
  const names = () => within(screen.getByRole("listbox")).getAllByRole("option").map(nameOf);

  it("is no native <select>: a button opens the app's own listbox of every network with its logo, the chosen one checked", () => {
    const trigger = custom();
    expect(screen.getByTestId("settings-custom").querySelector("select")).toBeNull();
    expect(trigger.tagName).toBe("BUTTON");
    expect([trigger.getAttribute("aria-haspopup"), trigger.getAttribute("aria-expanded")]).toEqual(["listbox", "false"]);
    expect(trigger.textContent).toBe(EVM[0]!.name);
    // Its name is the hidden label plus the network it shows.
    expect(screen.getByRole("button", {name: `Network ${EVM[0]!.name}`})).toBe(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("listbox", {name: "Networks"});
    expect(trigger.getAttribute("aria-controls")).toBe(list.id);
    const options = within(list).getAllByRole("option");
    expect(names()).toEqual([...EVM.map((c) => c.name), "Solana"]);
    // Each row leads with its network's logo (the bundled file; the monogram where there is none).
    expect(options.map((o) => o.querySelector("img")?.getAttribute("src") ?? null)).toEqual([...EVM.map((c) => c.slug), "solana"].map((slug) => networkLogo(slug)?.src ?? null));
    expect(options.every((o) => o.firstElementChild?.getAttribute("aria-hidden") === "true")).toBe(true);
    // The search has focus and drives the list; the chosen network is the active option and the only one checked.
    expect(document.activeElement).toBe(search());
    expect(search().getAttribute("aria-controls")).toBe(list.id);
    expect(activeName()).toBe(EVM[0]!.name);
    expect(options.filter((o) => o.getAttribute("aria-selected") === "true").map(nameOf)).toEqual([EVM[0]!.name]);
    expect(options.filter((o) => o.querySelector("svg")).map(nameOf)).toEqual([EVM[0]!.name]);
  });

  it("a click picks a network: the list closes, focus is back on the trigger, the URL field names it", () => {
    const trigger = custom();
    pickNetwork("Arbitrum");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger.textContent).toBe("Arbitrum");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByTestId("settings-custom-url").getAttribute("aria-label")).toBe("RPC URL for Arbitrum");
    // Reopened, the list starts on the chosen network.
    fireEvent.click(trigger);
    expect(activeName()).toBe("Arbitrum");
  });

  it("by keyboard: arrows open it and move, Enter picks; typing filters; a letter on the trigger starts a search", () => {
    const trigger = custom();
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, {key: "ArrowDown"});
    expect(document.activeElement).toBe(search());
    expect(activeName()).toBe(EVM[0]!.name);
    fireEvent.keyDown(search(), {key: "ArrowDown"});
    fireEvent.keyDown(search(), {key: "ArrowDown"});
    expect(activeName()).toBe(EVM[2]!.name);
    fireEvent.keyDown(search(), {key: "ArrowUp"});
    expect(activeName()).toBe(EVM[1]!.name);
    fireEvent.keyDown(search(), {key: "ArrowUp"});
    fireEvent.keyDown(search(), {key: "ArrowUp"});
    expect(activeName()).toBe(EVM[0]!.name);
    fireEvent.keyDown(search(), {key: "ArrowDown"});
    fireEvent.keyDown(search(), {key: "Enter"});
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger.textContent).toBe(EVM[1]!.name);
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(trigger, {key: "ArrowUp"});
    fireEvent.change(search(), {target: {value: "sol"}});
    expect(names()).toEqual(["Solana"]);
    expect(activeName()).toBe("Solana");
    fireEvent.keyDown(search(), {key: "Enter"});
    expect(trigger.textContent).toBe("Solana");
    expect(screen.getByTestId("settings-custom-url").getAttribute("aria-label")).toBe("RPC URL for Solana");

    // Typeahead: "b" lands on the first network starting with it, not on one merely containing it (Arbitrum).
    fireEvent.keyDown(trigger, {key: "b"});
    expect((search() as HTMLInputElement).value).toBe("b");
    expect(activeName()).toBe("Base");
    fireEvent.change(search(), {target: {value: "no such net"}});
    expect(within(screen.getByRole("listbox")).queryAllByRole("option")).toEqual([]);
    expect(search().getAttribute("aria-activedescendant")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("No network matches “no such net”.");
    fireEvent.keyDown(search(), {key: "Enter"});
    expect(trigger.textContent).toBe("Solana");
  });

  it("Escape closes only the list: Settings stays open, the network unchanged, focus back on the trigger", () => {
    const onClose = vi.fn();
    const trigger = custom(onClose);
    fireEvent.click(trigger);
    fireEvent.keyDown(search(), {key: "ArrowDown"});
    fireEvent.keyDown(search(), {key: "Escape"});
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("swap-settings")).toBeTruthy();
    expect(trigger.textContent).toBe(EVM[0]!.name);
    expect(document.activeElement).toBe(trigger);
    // The next Escape is the sheet's again.
    fireEvent.keyDown(trigger, {key: "Escape"});
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes when focus moves on (Tab to the URL) or a press lands outside it; Shift+Tab goes back to the trigger", () => {
    const trigger = custom();
    const url = screen.getByTestId("settings-custom-url");
    fireEvent.click(trigger);
    act(() => url.focus());
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByTestId("settings-custom-fallback"));
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.keyDown(search(), {key: "Tab", shiftKey: true});
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.textContent).toBe(EVM[0]!.name);
  });

  it("on a phone (375 px) the list is the app's bottom sheet; picking or Escape closes it, never Settings", () => {
    viewport.restore();
    viewport = installMatchMedia(375);
    const onClose = vi.fn();
    const trigger = custom(onClose);
    fireEvent.click(trigger);
    const sheet = screen.getByTestId("settings-custom-network-sheet");
    expect(screen.getByRole("dialog", {name: "Network"})).toBe(sheet);
    expect(within(sheet).getAllByRole("option")).toHaveLength(EVM.length + 1);
    // Phones never raise the keyboard by themselves: the search is there, not focused.
    expect(document.activeElement).not.toBe(search());
    fireEvent.click(within(sheet).getByRole("option", {name: "Solana"}));
    expect(screen.queryByTestId("settings-custom-network-sheet")).toBeNull();
    expect(trigger.textContent).toBe("Solana");
    // Settings itself is still open.
    expect(screen.getByTestId("swap-settings")).toBeTruthy();
    // Escape is the picker's own (Radix would hand it over from Settings a few renders after opening).
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByTestId("settings-custom-network-sheet"), {key: "Escape"});
    expect(screen.queryByTestId("settings-custom-network-sheet")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("swap-settings")).toBeTruthy();
    expect(trigger.textContent).toBe("Solana");
  });
});
