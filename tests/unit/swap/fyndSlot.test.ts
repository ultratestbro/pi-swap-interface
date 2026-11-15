// Which page builds Fynd (D3, D30), the way a page decides it: startConnection() for the page's mode, then
// buildProviders() with its default extras, whose `fynd` is standardFynd(). Only a Standard page with Fynd on gets the
// slot (at the proxy, live once health keys it); Public and Custom never build Fynd and install no routing fetch.
import {afterEach, describe, expect, it, vi} from "vitest";
import type {ConnectionMode} from "../../../src/contracts/config";

const API = "https://cp0x-api.example.org";
const HEALTH = {
  venues: {lifi: "anonymous", relay: "anonymous", near_intents: "anonymous", jupiter: "anonymous", fynd: "keyed"},
  rpc: {configured: false, chains: []},
  thornode: false,
};
const realFetch = globalThis.fetch;
const pair = [{chain: "eip155:1", token: "USDC"}, {chain: "eip155:1", token: "0xdAC17F958D2ee523a2206206994597C13D831ec7"}] as const;

/** A fresh page (module state included) in `mode`, booted the way main.tsx boots it, its health answering `fynd` (and `lifi`). */
async function boot(mode: ConnectionMode, opts: {fynd?: boolean; health?: "keyed" | "anonymous"; lifi?: "keyed" | "anonymous"} = {}) {
  vi.resetModules();
  const health = {...HEALTH, venues: {...HEALTH.venues, fynd: opts.health ?? "keyed", lifi: opts.lifi ?? "anonymous"}};
  const sent: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    sent.push(String(input));
    return new Response(JSON.stringify(health), {status: 200, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
  const cfg = await import("../../../src/config");
  const {buildProviders} = await import("../../../src/swap/providers");
  const base = opts.fynd === false ? {...cfg.DEFAULT_RUNTIME_CONFIG, providers: {...cfg.DEFAULT_RUNTIME_CONFIG.providers, fynd: false}} : cfg.DEFAULT_RUNTIME_CONFIG;
  if (mode === "standard") {
    const {config, plan} = cfg.standardSlots(base, API);
    cfg.setRuntimeConfig(config, undefined, {mode, api: API, plan, keys: {}});
  } else {
    cfg.setRuntimeConfig(base, undefined, {mode, api: API, plan: null, keys: mode === "custom" ? {lifi: "test-lifi"} : {}});
  }
  cfg.startConnection();
  if (mode === "standard") await vi.waitFor(() => expect(cfg.connectionStatus().health).toBe("ok"));
  return {cfg, sent, build: () => buildProviders()};
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the page's Fynd slot (standardFynd) and buildProviders' default extras", () => {
  it("Standard with Fynd keyed: the slot at the proxy, live, and Fynd built and routing", async () => {
    const {cfg, build} = await boot("standard");
    const slot = cfg.standardFynd();
    expect(slot?.base).toBe(`${API}/api/v2/swap-web/venue/fynd`);
    expect(slot?.live()).toBe(true);
    const fynd = build().find((p) => p.name === "fynd");
    expect(fynd?.supportsRoute(...pair)).toBe(true);
  });

  it("Standard without cp0x's Fynd key: built (the slot exists) but never routes", async () => {
    const {cfg, build} = await boot("standard", {health: "anonymous"});
    expect(cfg.standardFynd()?.live()).toBe(false);
    const fynd = build().find((p) => p.name === "fynd");
    expect(fynd?.supportsRoute(...pair)).toBe(false);
  });

  it("Standard with Fynd switched off: no slot, not built", async () => {
    const {cfg, build} = await boot("standard", {fynd: false});
    expect(cfg.standardFynd()).toBeUndefined();
    expect(build().map((p) => p.name)).not.toContain("fynd");
  });

  it.each(["public", "custom"] as const)("%s: no slot, Fynd not built, no routing fetch and no cp0x request", async (mode) => {
    const {cfg, sent, build} = await boot(mode);
    expect(cfg.standardFynd()).toBeUndefined();
    expect(cfg.standardFetch()).toBeUndefined();
    const names = build().map((p) => p.name);
    expect(names).toContain("curve");
    expect(names).not.toContain("fynd");
    expect(sent).toEqual([]);
  });
});

// What a preview round reads per round (D7): cp0x's proxy carries LI.FI and Fynd with cp0x's key only on a Standard
// page whose health keys them; every other page leaves both for the live quote and contacts no cp0x host for it.
describe("preview liveness per page (proxyVenueLive, proxySettled)", () => {
  it("Standard: live exactly for the venues health keys and the page has a slot for; settled once health answered", async () => {
    const {cfg} = await boot("standard", {lifi: "keyed"});
    await cfg.proxySettled();
    expect(cfg.proxyVenueLive("lifi")).toBe(true);
    expect(cfg.proxyVenueLive("fynd")).toBe(true);
    expect(cfg.proxyVenueLive("relay")).toBe(false);
    expect(cfg.proxyVenueLive("uniswap")).toBe(false);
  });

  it("Standard with LI.FI and Fynd anonymous at cp0x: neither is live", async () => {
    const {cfg} = await boot("standard", {lifi: "anonymous", health: "anonymous"});
    await cfg.proxySettled();
    expect(cfg.proxyVenueLive("lifi")).toBe(false);
    expect(cfg.proxyVenueLive("fynd")).toBe(false);
  });

  it.each(["public", "custom"] as const)("%s: never live (a Custom LI.FI key included), settled at once, nothing sent", async (mode) => {
    const {cfg, sent} = await boot(mode, {lifi: "keyed"});
    await cfg.proxySettled();
    expect(cfg.proxyVenueLive("lifi")).toBe(false);
    expect(cfg.proxyVenueLive("fynd")).toBe(false);
    expect(sent).toEqual([]);
  });
});

// 0x and Across (D38): the same proxy-only slots, decided the same way by the page's mode and health.
describe("the page's 0x and Across slots (standardProxyOnly) and buildProviders' default extras", () => {
  const sameBase = [{chain: "eip155:8453", token: "ETH"}, {chain: "eip155:8453", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}] as const;
  const baseToArb = [{chain: "eip155:8453", token: "USDC"}, {chain: "eip155:42161", token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"}] as const;

  it("Standard: a slot each at the proxy, live only for the one health keys; both built after Fynd", async () => {
    vi.resetModules();
    const health = {...HEALTH, venues: {...HEALTH.venues, zeroex: "keyed", across: "anonymous"}};
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(health), {status: 200})) as unknown as typeof fetch;
    const cfg = await import("../../../src/config");
    const {buildProviders} = await import("../../../src/swap/providers");
    const {config, plan} = cfg.standardSlots(cfg.DEFAULT_RUNTIME_CONFIG, API);
    cfg.setRuntimeConfig(config, undefined, {mode: "standard", api: API, plan, keys: {}});
    cfg.startConnection();
    await vi.waitFor(() => expect(cfg.connectionStatus().health).toBe("ok"));
    expect(cfg.standardProxyOnly("zeroex")?.base).toBe(`${API}/api/v2/swap-web/venue/zeroex`);
    expect(cfg.standardProxyOnly("across")?.base).toBe(`${API}/api/v2/swap-web/venue/across`);
    expect([cfg.standardProxyOnly("zeroex")?.live(), cfg.standardProxyOnly("across")?.live()]).toEqual([true, false]);
    expect([cfg.proxyVenueLive("zeroex"), cfg.proxyVenueLive("across")]).toEqual([true, false]);
    const providers = buildProviders();
    expect(providers.map((p) => p.name).slice(-3)).toEqual(["fynd", "zeroex", "across"]);
    expect(providers.find((p) => p.name === "zeroex")?.supportsRoute(...sameBase)).toBe(true);
    expect(providers.find((p) => p.name === "across")?.supportsRoute(...baseToArb)).toBe(false);
  });

  it("a 0x 403 about one token (BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE) refuses that pair only: 0x stays on for every other", async () => {
    vi.resetModules();
    const health = {...HEALTH, venues: {...HEALTH.venues, zeroex: "keyed"}};
    const sent: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      sent.push(url);
      if (url.includes("/venue/zeroex/")) {
        const body = {name: "BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE", message: "Buy token not authorized for trade", data: {zid: "0x1"}};
        return new Response(JSON.stringify(body), {status: 403, headers: {"content-type": "application/json", "x-swap-web-answer": "upstream"}});
      }
      return new Response(JSON.stringify(health), {status: 200});
    }) as unknown as typeof fetch;
    const cfg = await import("../../../src/config");
    const {buildProviders} = await import("../../../src/swap/providers");
    const {config, plan} = cfg.standardSlots(cfg.DEFAULT_RUNTIME_CONFIG, API);
    cfg.setRuntimeConfig(config, undefined, {mode: "standard", api: API, plan, keys: {}});
    cfg.startConnection();
    await vi.waitFor(() => expect(cfg.connectionStatus().health).toBe("ok"));
    const zeroex = buildProviders().find((p) => p.name === "zeroex")!;
    const heard: {text: string; reason?: string}[] = [];
    const q = await zeroex.getQuote({
      sourceChain: "eip155:8453",
      destChain: "eip155:8453",
      sourceToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      destToken: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
      amountIn: "25000000",
      destAddress: "",
      dry: true,
      onRefusal: (text, info) => heard.push({text, reason: info?.reason}),
    });
    expect(q).toBeNull();
    expect(heard).toEqual([{text: "zeroex: 0x does not serve the token being bought (BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE)", reason: "unsupported_pair"}]);
    expect(sent.filter((u) => u.includes("/venue/zeroex/swap/permit2/price?"))).toHaveLength(1);
    expect(cfg.proxyVenueLive("zeroex")).toBe(true);
    expect(zeroex.supportsRoute(...sameBase)).toBe(true);
    expect(cfg.connectionStatus()).toMatchObject({viaProxy: ["fynd", "zeroex"], fellBack: []});
  });

  it.each(["public", "custom"] as const)("%s: no slots, neither built, no cp0x request", async (mode) => {
    const {cfg, sent, build} = await boot(mode);
    expect([cfg.standardProxyOnly("zeroex"), cfg.standardProxyOnly("across")]).toEqual([undefined, undefined]);
    const names = build().map((p) => p.name);
    expect(names).not.toContain("zeroex");
    expect(names).not.toContain("across");
    expect(sent).toEqual([]);
  });
});
