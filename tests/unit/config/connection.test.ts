// The connection modes (D30): the build's cp0x API origin, what a browser saved (mode, Custom endpoints, venue keys),
// Custom's rules, and the config each mode builds the page with — Standard's proxy slots included.
import {afterEach, describe, expect, it, vi} from "vitest";
import type {ConnectionSettings, RuntimeConfig} from "../../../src/contracts/config";
import {
  CONNECTION_KEY,
  PROXY_ONLY,
  PROXY_VENUES,
  VENUE_API_KEY,
  VENUE_KEYS_KEY,
  apiOrigin,
  connectionModes,
  customOverlay,
  customRpcProblem,
  defaultConnectionMode,
  isCp0xApiUrl,
  parseCustom,
  readConnection,
  readVenueKeys,
  standardSlots,
  venueKeyProblem,
  withoutCp0xApi,
  writeConnection,
  writeVenueKeys,
} from "../../../src/config/connection";
import {DEFAULT_RUNTIME_CONFIG} from "../../../src/config/defaults";
import {getRuntimeConfig, isProxyUrl, loadRuntimeConfig, pageConnection, savedOverrides, setRuntimeConfig, venueKeys} from "../../../src/config/runtime";
import {USER_SETTINGS_KEY} from "../../../src/config/userSettings";

const API = "https://cp0x-api.example.org";
const BASE = `${API}/api/v2/swap-web`;
const D = DEFAULT_RUNTIME_CONFIG;

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
});

describe("the build's cp0x API origin", () => {
  it("accepts an https origin (a trailing slash normalised away) and plain http only on localhost / 127.0.0.1", () => {
    expect(apiOrigin("https://cp0x-api.vercel.app")).toBe("https://cp0x-api.vercel.app");
    expect(apiOrigin(" https://cp0x-api.vercel.app/ ")).toBe("https://cp0x-api.vercel.app");
    expect(apiOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(apiOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    for (const bad of ["", undefined, null, "cp0x-api.vercel.app", "http://cp0x-api.vercel.app", "ftp://x.example", "https://x.example/api", "https://x.example/?a=1", "https://u:p@x.example", "http://192.168.1.2:3000"])
      expect(apiOrigin(bad), String(bad)).toBeNull();
  });

  it("offers Standard, as the default, only with an API", () => {
    expect(connectionModes(API)).toEqual(["standard", "public", "custom"]);
    expect(connectionModes(null)).toEqual(["public", "custom"]);
    expect(defaultConnectionMode(API)).toBe("standard");
    expect(defaultConnectionMode(null)).toBe("public");
  });
});

describe("the mode store", () => {
  it("round-trips, reads null when nothing is saved, and clears", () => {
    expect(readConnection(API)).toBeNull();
    const saved: ConnectionSettings = {mode: "custom", custom: {evmRpc: {42161: ["https://arb.example"]}, solanaRpc: ["https://sol.example"]}};
    expect(writeConnection(saved)).toBe(true);
    expect(readConnection(API)).toEqual(saved);
    expect(writeConnection(null)).toBe(true);
    expect(localStorage.getItem(CONNECTION_KEY)).toBeNull();
  });

  it("reads a mode the build doesn't offer, or garbage, as the default", () => {
    writeConnection({mode: "standard", custom: {evmRpc: {}, solanaRpc: []}});
    expect(readConnection(null)?.mode).toBe("public");
    expect(readConnection(API)?.mode).toBe("standard");
    localStorage.setItem(CONNECTION_KEY, JSON.stringify({mode: "turbo"}));
    expect(readConnection(API)).toEqual({mode: "standard", custom: {evmRpc: {}, solanaRpc: []}});
    localStorage.setItem(CONNECTION_KEY, "not json");
    expect(readConnection(API)).toBeNull();
  });

  it("survives a browser that refuses storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(readConnection(API)).toBeNull();
    expect(readVenueKeys()).toEqual({});
    expect(writeConnection({mode: "public", custom: {evmRpc: {}, solanaRpc: []}})).toBe(false);
    expect(writeVenueKeys({lifi: "test-key"})).toBe(false);
  });

  it("turns an older browser's saved RPC overrides into Custom endpoints that still replace each list (only: true)", () => {
    localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify({evmRpc: {"1": ["https://eth.example"]}, solanaRpc: ["https://sol.example"], prices: {defillama: "https://llama.example"}}));
    expect(readConnection(API)).toEqual({mode: "custom", custom: {evmRpc: {1: ["https://eth.example"]}, solanaRpc: ["https://sol.example"], only: true}});
    localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify({prices: {defillama: "https://llama.example"}}));
    expect(readConnection(API)).toBeNull();
  });
});

describe("Custom mode", () => {
  it("accepts https RPCs and plain http only to this machine", () => {
    expect(customRpcProblem("https://rpc.example")).toBeNull();
    expect(customRpcProblem("http://localhost:8545")).toBeNull();
    expect(customRpcProblem("http://127.0.0.1:8545")).toBeNull();
    expect(customRpcProblem("http://rpc.example")).toMatch(/https/);
    expect(customRpcProblem("wss://rpc.example")).toMatch(/https/);
    expect(customRpcProblem("  ")).toBe("Enter a URL.");
  });

  it("refuses user:pass@ URLs (fetch refuses them, so every call would fall back unseen) and cp0x's own server", () => {
    expect(customRpcProblem("https://user:secret@my-node.example")).toMatch(/browsers refuse user:pass@ URLs/);
    expect(customRpcProblem("https://user@my-node.example")).toMatch(/user:pass@/);
    expect(customRpcProblem("https://my-node.example/secret-token")).toBeNull();
    expect(customRpcProblem(`${BASE}/rpc/1`, API)).toMatch(/Custom never contacts cp0x/);
    expect(customRpcProblem(`${API}/anything`, API)).toMatch(/cp0x/);
    // A swap-web path is cp0x's on any host, even in a build that names no API.
    expect(customRpcProblem("https://elsewhere.example/api/v2/swap-web/rpc/1", null)).toMatch(/cp0x/);
    expect(parseCustom({evmRpc: {"1": ["https://user:secret@my-node.example", "https://ok.example", "https://x.example/api/v2/swap-web/rpc/1"]}})).toEqual({
      evmRpc: {1: ["https://ok.example"]},
      solanaRpc: [],
    });
  });

  it("drops unknown chains, bad URLs, duplicates and extras past the cap from stored endpoints", () => {
    const many = Array.from({length: 12}, (_, i) => `https://sol${i}.example`);
    expect(
      parseCustom({
        evmRpc: {"1": ["https://a.example", "https://a.example", "http://b.example", 7], "424242": ["https://x.example"], nope: ["https://y.example"], "8453": []},
        solanaRpc: many,
      }),
    ).toEqual({evmRpc: {1: ["https://a.example"]}, solanaRpc: many.slice(0, 8)});
    expect(parseCustom("nope")).toEqual({evmRpc: {}, solanaRpc: []});
  });

  it("puts the viewer's RPCs first and keeps the public ones after them as the fallback", () => {
    const c = customOverlay(D, {evmRpc: {42161: ["https://arb.example", D.evmRpc[42161]![0]!]}, solanaRpc: ["https://sol.example"]});
    expect(c.evmRpc[42161]).toEqual(["https://arb.example", ...D.evmRpc[42161]!]);
    expect(c.evmRpc[1]).toEqual(D.evmRpc[1]);
    expect(c.solanaRpc).toEqual(["https://sol.example", ...D.solanaRpc]);
    expect(customOverlay(D, {evmRpc: {}, solanaRpc: []})).toEqual(D);
  });

  it("only my RPCs: the viewer's URLs alone on their networks, every other network keeps its list; stored and read back", () => {
    const c = customOverlay(D, {evmRpc: {1: ["https://my-own-eth.example"]}, solanaRpc: ["https://my-own-solana.example"], only: true});
    expect(c.evmRpc[1]).toEqual(["https://my-own-eth.example"]);
    expect(c.solanaRpc).toEqual(["https://my-own-solana.example"]);
    expect(c.evmRpc[8453]).toEqual(D.evmRpc[8453]);
    writeConnection({mode: "custom", custom: {evmRpc: {1: ["https://my-own-eth.example"]}, solanaRpc: [], only: true}});
    expect(readConnection(API)?.custom.only).toBe(true);
    expect(parseCustom({only: "yes"}).only).toBeUndefined();
  });

  it("keys: visible ASCII within each SDK's limit, never echoed in the refusal", () => {
    expect(venueKeyProblem("lifi", "test-key")).toBeNull();
    const spaced = venueKeyProblem("jupiter", "test key");
    expect(spaced).toMatch(/visible characters/);
    expect(spaced).not.toContain("test key");
    expect(venueKeyProblem("relay", "k".repeat(257))).toMatch(/256/);
    expect(venueKeyProblem("nearIntents", `a.${"b".repeat(1000)}.c`)).toBeNull();
    // Symbiosis' SDK takes 1..256 printable characters (it throws at construction otherwise).
    expect(venueKeyProblem("symbiosis", "k".repeat(256))).toBeNull();
    expect(venueKeyProblem("symbiosis", "k".repeat(257))).toMatch(/256/);
  });

  it("keys: stored apart from everything else, invalid ones dropped, cleared with null or nothing left", () => {
    expect(writeVenueKeys({lifi: "test-key", relay: "bad key", nearIntents: "test-jwt", symbiosis: "test-sym"})).toBe(true);
    expect(readVenueKeys()).toEqual({lifi: "test-key", nearIntents: "test-jwt", symbiosis: "test-sym"});
    expect(localStorage.getItem(CONNECTION_KEY)).toBeNull();
    expect(localStorage.getItem(USER_SETTINGS_KEY)).toBeNull();
    localStorage.setItem(VENUE_KEYS_KEY, JSON.stringify({jupiter: "test key\n", relay: 5}));
    expect(readVenueKeys()).toEqual({});
    writeVenueKeys({jupiter: "test-key"});
    expect(writeVenueKeys(null)).toBe(true);
    expect(localStorage.getItem(VENUE_KEYS_KEY)).toBeNull();
    writeVenueKeys({jupiter: "test-key"});
    expect(writeVenueKeys({jupiter: ""})).toBe(true);
    expect(localStorage.getItem(VENUE_KEYS_KEY)).toBeNull();
  });
});

describe("Standard mode's page config (proxy slots)", () => {
  it("gives the five venues the proxy base and remembers each public base", () => {
    const {config, plan} = standardSlots(D, API);
    expect(config.api.lifi).toBe(`${BASE}/venue/lifi`);
    expect(config.api.relay).toBe(`${BASE}/venue/relay`);
    expect(config.api.nearIntents).toBe(`${BASE}/venue/near_intents`);
    expect(config.api.jupiter).toBe(`${BASE}/venue/jupiter`);
    expect(config.api.symbiosis).toBe(`${BASE}/venue/symbiosis`);
    expect(plan.base).toBe(BASE);
    // Fynd's, 0x's and Across's slots have no public base (null): reachable only through the proxy, never falling back.
    expect(plan.venues).toEqual({
      lifi: D.api.lifi,
      relay: D.api.relay,
      near_intents: D.api.nearIntents,
      jupiter: D.api.jupiter,
      symbiosis: "https://api.symbiosis.finance/crosschain",
      fynd: null,
      zeroex: null,
      across: null,
    });
    // Nothing else moves: Chainflip, CCTP, prices and the rest stay public.
    expect(config.api.chainflip).toBe(D.api.chainflip);
    expect(config.prices).toEqual(D.prices);
  });

  it("Fynd gets its proxy-only slot whenever the page builds it, a plain-http local API included; never when it is off", () => {
    expect(standardSlots(D, "http://127.0.0.1:3000").plan.venues.fynd).toBeNull();
    expect("fynd" in standardSlots({...D, providers: {...D.providers, fynd: false}}, API).plan.venues).toBe(false);
    // No runtime-config base and no viewer key exist for it: nothing in the config changes for Fynd.
    expect(Object.keys(standardSlots(D, API).config.api)).toEqual(Object.keys(D.api));
  });

  it("0x and Across get proxy-only slots the same way (D38): no public base, no config base, no viewer key; off, none", () => {
    expect(PROXY_ONLY).toEqual(new Set(["fynd", "zeroex", "across"]));
    expect(PROXY_VENUES.slice(-3)).toEqual(["fynd", "zeroex", "across"]);
    const local = standardSlots(D, "http://127.0.0.1:3000").plan.venues;
    expect([local.zeroex, local.across]).toEqual([null, null]);
    const off = standardSlots({...D, providers: {...D.providers, zeroex: false, across: false}}, API).plan.venues;
    expect(["zeroex" in off, "across" in off]).toEqual([false, false]);
    expect(VENUE_API_KEY.zeroex).toBeUndefined();
    expect(VENUE_API_KEY.across).toBeUndefined();
  });

  it("puts the proxy RPC FIRST in every list, the public URLs after it; an emptied list stays empty", () => {
    const emptied: RuntimeConfig = {...D, evmRpc: {...D.evmRpc, 98866: []}};
    const {config, plan} = standardSlots(emptied, API);
    expect(config.evmRpc[8453]).toEqual([`${BASE}/rpc/8453`, ...D.evmRpc[8453]!]);
    expect(config.evmRpc[99901]).toEqual([`${BASE}/rpc/99901`, ...D.evmRpc[99901]!]);
    expect(config.solanaRpc).toEqual([`${BASE}/rpc/solana`, ...D.solanaRpc]);
    // The proxy has no NEAR route: NEAR's list stays direct.
    expect(config.nearRpc).toEqual(D.nearRpc);
    expect(config.evmRpc[98866]).toEqual([]);
    expect(plan.rpc.has("8453")).toBe(true);
    expect(plan.rpc.has("solana")).toBe(true);
    expect(plan.rpc.has("98866")).toBe(false);
  });

  it("THORChain: the proxy confirms first; the quote nodes stay direct and unchanged, Liquify first", () => {
    const {config, plan} = standardSlots(D, API);
    expect(config.api.thorNodes).toEqual(D.api.thorNodes);
    expect(config.api.thorNodes[0]).toBe("https://gateway.liquify.com/chain/thorchain_api");
    expect(config.api.thorConfirmNodes).toEqual([`${BASE}/venue/thornode`]);
    expect(config.api.thorNodes.some((u) => u.startsWith(API))).toBe(false);
    expect(plan.thornode).toBe(true);
    const third = standardSlots({...D, api: {...D.api, thorConfirmNodes: ["https://thor.example"]}}, API).config.api.thorConfirmNodes;
    expect(third).toEqual([`${BASE}/venue/thornode`, "https://thor.example"]);
  });

  it("leaves alone a venue the viewer pointed elsewhere, a venue the page doesn't build, and LI.FI / THORNode against a plain-http API", () => {
    const viewer: RuntimeConfig = {...D, api: {...D.api, relay: "https://my-relay.example"}};
    const s = standardSlots(viewer, API, D);
    expect(s.config.api.relay).toBe("https://my-relay.example");
    expect(s.plan.venues.relay).toBeUndefined();
    const off = standardSlots({...D, providers: {...D.providers, jupiter: false, symbiosis: false, thorchain: false}}, API);
    expect(off.config.api.jupiter).toBe(D.api.jupiter);
    expect(off.config.api.symbiosis).toBe(D.api.symbiosis);
    expect("symbiosis" in off.plan.venues).toBe(false);
    expect(off.plan.thornode).toBe(false);
    expect(off.config.api.thorConfirmNodes).toEqual([]);
    const ownSymbiosis = standardSlots({...D, api: {...D.api, symbiosis: "https://my-symbiosis.example"}}, API, D);
    expect(ownSymbiosis.config.api.symbiosis).toBe("https://my-symbiosis.example");
    expect(ownSymbiosis.plan.venues.symbiosis).toBeUndefined();
    const local = standardSlots(D, "http://localhost:3000");
    expect(local.config.api.lifi).toBe(D.api.lifi);
    expect(local.plan.venues.lifi).toBeUndefined();
    expect(local.plan.thornode).toBe(false);
    expect(local.config.api.relay).toBe("http://localhost:3000/api/v2/swap-web/venue/relay");
    // Symbiosis' SDK takes an http apiUrl: slotted against a local API too.
    expect(local.config.api.symbiosis).toBe("http://localhost:3000/api/v2/swap-web/venue/symbiosis");
  });
});

describe("cp0x API URLs outside Standard's slots", () => {
  it("are this build's API origin, or a swap-web path on any host", () => {
    expect(isCp0xApiUrl(`${BASE}/venue/lifi`, API)).toBe(true);
    expect(isCp0xApiUrl(`${API}/api/v1/other`, API)).toBe(true);
    expect(isCp0xApiUrl("https://other.example/api/v2/swap-web/rpc/1", null)).toBe(true);
    expect(isCp0xApiUrl("https://cp0x-api.example.org.evil.example/x", API)).toBe(false);
    expect(isCp0xApiUrl("https://li.quest/v1", API)).toBe(false);
    expect(isCp0xApiUrl("https://x.example/api/v2/swap-webby", null)).toBe(false);
    expect(isCp0xApiUrl("not a url", API)).toBe(false);
  });

  it("are dropped: a base or price takes the layer below's value, a list keeps the rest (or the layer below's when unusable)", () => {
    const dirty: RuntimeConfig = {
      ...D,
      api: {...D.api, relay: `${BASE}/venue/relay`, thorNodes: [D.api.thorNodes[0]!, `${BASE}/venue/thornode`], thorConfirmNodes: [`${BASE}/venue/thornode`, "https://thor.example"]},
      prices: {...D.prices, coingecko: `${API}/prices`},
      evmRpc: {...D.evmRpc, 1: [`${BASE}/rpc/1`], 8453: [`${BASE}/rpc/8453`, "https://base.example"]},
      solanaRpc: [`${BASE}/rpc/solana`],
      tronApi: [`${API}/tron`, "https://tron.example"],
      nearRpc: [`${API}/near`],
    };
    const {config, dropped} = withoutCp0xApi(dirty, D, API);
    expect(dropped).toEqual(["api.relay", "api.thorNodes", "api.thorConfirmNodes", "prices.coingecko", "evmRpc.1", "evmRpc.8453", "solanaRpc", "tronApi", "nearRpc"]);
    expect(config.tronApi).toEqual(["https://tron.example"]);
    expect(config.api.relay).toBe(D.api.relay);
    expect(config.api.thorNodes).toEqual(D.api.thorNodes);
    expect(config.api.thorConfirmNodes).toEqual(["https://thor.example"]);
    expect(config.prices.coingecko).toBe(D.prices.coingecko);
    expect(config.evmRpc[1]).toEqual(D.evmRpc[1]);
    expect(config.evmRpc[8453]).toEqual(["https://base.example"]);
    expect(config.solanaRpc).toEqual(D.solanaRpc);
    expect(config.nearRpc).toEqual(D.nearRpc);
    expect(withoutCp0xApi(D, D, API)).toEqual({config: D, dropped: []});
  });
});

describe("loadRuntimeConfig: the connection layer", () => {
  const load = (o: Parameters<typeof loadRuntimeConfig>[0]) =>
    loadRuntimeConfig({url: "https://app.example/runtime-config.json", fetchImpl: async () => new Response("", {status: 404}), buildTime: "", userSettings: null, location: {hash: "", search: "", pathname: "/"}, ...o});

  it("a build without an API is Public and holds no proxy URL, whatever was saved", async () => {
    const config = await load({api: null, connection: {mode: "standard", custom: {evmRpc: {}, solanaRpc: []}}});
    expect(pageConnection()).toEqual({mode: "public", api: null, plan: null, keys: {}});
    expect(JSON.stringify(config)).not.toContain("swap-web");
  });

  it("Standard is the default with an API: the page is built with the proxy slots", async () => {
    const config = await load({api: API, connection: null});
    expect(pageConnection().mode).toBe("standard");
    expect(pageConnection().plan?.base).toBe(BASE);
    expect(config.evmRpc[1]?.[0]).toBe(`${BASE}/rpc/1`);
    expect(isProxyUrl(`${BASE}/rpc/1`)).toBe(true);
    expect(isProxyUrl(D.evmRpc[1]![0]!)).toBe(false);
    // The proxy is not a viewer's saved setting: the swap screen's notice stays quiet.
    expect(savedOverrides()).toEqual({ignored: false, hosts: [], evmRpcChains: [], solanaRpc: false});
  });

  it("Public with an API, and demo mode, never get a proxy slot", async () => {
    expect(JSON.stringify(await load({api: API, connection: {mode: "public", custom: {evmRpc: {}, solanaRpc: []}}}))).not.toContain(API);
    expect(pageConnection().mode).toBe("public");
    expect(JSON.stringify(await load({api: API, connection: null, location: {hash: "#/?demo=1", search: "", pathname: "/"}}))).not.toContain(API);
    expect(pageConnection().plan).toBeNull();
    // Matched on the API origin, not on Standard's plan: a cp0x URL never reaches a wallet in any mode.
    expect(isProxyUrl(`${BASE}/rpc/1`)).toBe(true);
    expect(isProxyUrl(D.evmRpc[1]![0]!)).toBe(false);
  });

  // The operator's layers (VITE_SWAP_CONFIG, runtime-config.json) pointing at the proxy: the review's repro.
  const operatorProxy = JSON.stringify({api: {lifi: `${BASE}/venue/lifi`}, evmRpc: {"1": [`${BASE}/rpc/1`]}});
  const fileProxy = async () => new Response(JSON.stringify({api: {thorConfirmNodes: [`${BASE}/venue/thornode`]}, solanaRpc: [`${BASE}/rpc/solana`]}), {status: 200});

  it("a proxy URL from the operator's layers is dropped in Public and Custom: the page never contacts cp0x there", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const connection of [{mode: "public", custom: {evmRpc: {}, solanaRpc: []}}, {mode: "custom", custom: {evmRpc: {}, solanaRpc: []}}] as const) {
      const config = await load({api: API, buildTime: operatorProxy, fetchImpl: fileProxy, connection});
      expect(JSON.stringify(config), connection.mode).not.toContain(API);
      expect(config.api.lifi).toBe(D.api.lifi);
      expect(config.evmRpc[1]).toEqual(D.evmRpc[1]);
      expect(config.solanaRpc).toEqual(D.solanaRpc);
      expect(config.api.thorConfirmNodes).toEqual([]);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^runtime-config: api\.lifi points at cp0x's API — ignored/));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^runtime-config: api\.thorConfirmNodes points at cp0x's API/));
    // In a build without an API, the swap-web path alone gives it away.
    expect(JSON.stringify(await load({api: null, buildTime: operatorProxy, fetchImpl: fileProxy, connection: null}))).not.toContain("swap-web");
  });

  it("in Standard, only standardSlots adds the proxy: an operator's proxy URL never becomes a venue's 'public' fallback", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = await load({api: API, buildTime: operatorProxy, fetchImpl: fileProxy, connection: null});
    expect(pageConnection().plan?.venues.lifi).toBe(D.api.lifi);
    expect(config.api.lifi).toBe(`${BASE}/venue/lifi`);
    expect(config.evmRpc[1]).toEqual([`${BASE}/rpc/1`, ...D.evmRpc[1]!]);
    expect(config.api.thorConfirmNodes).toEqual([`${BASE}/venue/thornode`]);
  });

  it("a viewer's saved base or Custom RPC pointing at cp0x is dropped too, so the venue is still slotted and health-checked", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await load({api: API, userSettings: {api: {jupiter: `${BASE}/venue/jupiter`}}, connection: null});
    expect(pageConnection().plan?.venues.jupiter).toBe(D.api.jupiter);
    expect(savedOverrides().hosts).toEqual([]);
    const custom = await load({api: API, connection: {mode: "custom", custom: {evmRpc: {1: [`${BASE}/rpc/1`, "https://mine.example"]}, solanaRpc: []}}});
    expect(custom.evmRpc[1]).toEqual(["https://mine.example", ...D.evmRpc[1]!]);
  });

  it("Custom: the viewer's RPCs first (named by the swap screen's notice), the keys handed on, no proxy", async () => {
    const config = await load({
      api: API,
      connection: {mode: "custom", custom: {evmRpc: {42161: ["https://arb.example"]}, solanaRpc: ["https://sol.example"]}},
      venueKeys: {lifi: "test-key"},
    });
    expect(config.evmRpc[42161]).toEqual(["https://arb.example", ...D.evmRpc[42161]!]);
    expect(config.solanaRpc[0]).toBe("https://sol.example");
    expect(JSON.stringify(config)).not.toContain(API);
    expect(JSON.stringify(config)).not.toContain("test-key");
    expect(venueKeys()).toEqual({lifi: "test-key"});
    expect(savedOverrides()).toMatchObject({evmRpcChains: [42161], solanaRpc: true});
    expect(getRuntimeConfig()).toBe(config);
  });

  it("keys count only in Custom mode", async () => {
    await load({api: API, connection: {mode: "public", custom: {evmRpc: {}, solanaRpc: []}}, venueKeys: {lifi: "test-key"}});
    expect(venueKeys()).toEqual({});
  });

  it("an IPFS path gateway ignores a saved connection (any site there could have planted it)", async () => {
    const config = await load({
      api: null,
      connection: {mode: "custom", custom: {evmRpc: {1: ["https://attacker.example"]}, solanaRpc: []}},
      venueKeys: {lifi: "test-key"},
      location: {hash: "", search: "", pathname: "/ipfs/bafy/"},
    });
    expect(config.evmRpc[1]).toEqual(D.evmRpc[1]);
    expect(pageConnection()).toEqual({mode: "public", api: null, plan: null, keys: {}});
    expect(savedOverrides().ignored).toBe(true);
  });
});
