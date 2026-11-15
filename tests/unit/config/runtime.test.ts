import {afterEach, describe, expect, it, vi} from "vitest";
import type {RuntimeConfigInput} from "../../../src/contracts/config";
import {DEFAULT_RUNTIME_CONFIG} from "../../../src/config/defaults";
import {demoFromLocation, demoWallets} from "../../../src/config/demo";
import {createTokenBucket} from "../../../src/config/pacing";
import {formatHash, parseHash} from "../../../src/config/hash";
import {parseRuntimeConfig, suspendedChainsFromEnv} from "../../../src/config/parse";
import {getRuntimeConfig, isSharedOriginPath, loadRuntimeConfig, savedOverrides, setRuntimeConfig} from "../../../src/config/runtime";
import {USER_SETTINGS_KEY, readUserSettings, writeUserSettings} from "../../../src/config/userSettings";

describe("parseRuntimeConfig", () => {
  it("returns the defaults for an empty file", () => {
    const {config, warnings} = parseRuntimeConfig({});
    expect(config).toEqual(DEFAULT_RUNTIME_CONFIG);
    expect(warnings).toEqual([]);
  });

  it("takes a Tron API list of https hosts only", () => {
    expect(parseRuntimeConfig({tronApi: ["https://tron.example.org"]}).config.tronApi).toEqual(["https://tron.example.org"]);
    for (const bad of [[], ["http://tron.example.org"], "https://tron.example.org", ["https://u:p@tron.example.org"]]) {
      const {config, warnings} = parseRuntimeConfig({tronApi: bad});
      expect(config.tronApi).toEqual(DEFAULT_RUNTIME_CONFIG.tronApi);
      expect(warnings).toEqual(["runtime-config: tronApi is not a non-empty list of https URLs — ignored"]);
    }
  });

  it("merges sections key by key and evmRpc per chain id", () => {
    const {config, warnings} = parseRuntimeConfig({
      providers: {symbiosis: false},
      api: {lifi: "https://lifi.example.org/v1"},
      evmRpc: {"8453": ["https://base.example.org", "http://127.0.0.1:8545"]},
      walletConnect: {projectId: "0123456789abcdef0123456789abcdef"},
    });
    expect(warnings).toEqual([]);
    expect(config.providers.symbiosis).toBe(false);
    expect(config.providers.balancer).toBe(true);
    expect(config.providers.lifi).toBe(true);
    expect(config.api.lifi).toBe("https://lifi.example.org/v1");
    expect(config.api.relay).toBe(DEFAULT_RUNTIME_CONFIG.api.relay);
    expect(config.evmRpc[8453]).toEqual(["https://base.example.org", "http://127.0.0.1:8545"]);
    expect(config.evmRpc[1]).toEqual(DEFAULT_RUNTIME_CONFIG.evmRpc[1]);
    expect(config.walletConnect.projectId).toBe("0123456789abcdef0123456789abcdef");
  });

  it("drops unknown keys and unsafe values with a warning, keeping the defaults", () => {
    const {config, warnings} = parseRuntimeConfig({
      bogus: 1,
      providers: {paraswap: true},
      api: {lifi: "http://li.quest/v1", omnistonWs: "https://omni.example", thorNodes: ["https://a.example", "https://a.example/x"]},
      solanaRpc: [],
    });
    expect(config).toEqual(DEFAULT_RUNTIME_CONFIG);
    expect(warnings).toHaveLength(6);
  });

  it("refuses URLs with user:pass@ (fetch refuses them, and a chain definition would hand them to wallets)", () => {
    const {config, warnings} = parseRuntimeConfig({evmRpc: {"1": ["https://user:secret@node.example"]}, api: {lifi: "https://u@lifi.example/v1"}, solanaRpc: ["https://node.example/token"]});
    expect(config.evmRpc[1]).toEqual(DEFAULT_RUNTIME_CONFIG.evmRpc[1]);
    expect(config.api.lifi).toBe(DEFAULT_RUNTIME_CONFIG.api.lifi);
    expect(config.solanaRpc).toEqual(["https://node.example/token"]);
    expect(warnings).toHaveLength(2);
  });

  it("takes the operator's NEAR RPC list, an empty one included (no NEAR reads)", () => {
    expect(DEFAULT_RUNTIME_CONFIG.nearRpc).toEqual(["https://rpc.mainnet.fastnear.com"]);
    expect(parseRuntimeConfig({nearRpc: ["https://near.example"]}).config.nearRpc).toEqual(["https://near.example"]);
    expect(parseRuntimeConfig({nearRpc: []}).config.nearRpc).toEqual([]);
    const bad = parseRuntimeConfig({nearRpc: ["http://near.example"]});
    expect(bad.config.nearRpc).toEqual(DEFAULT_RUNTIME_CONFIG.nearRpc);
    expect(bad.warnings).toEqual(["runtime-config: nearRpc is not a list of https URLs — ignored"]);
  });

  it("reads the server's suspendedChains env format", () => {
    expect(suspendedChainsFromEnv("eip155:10=HOT paused; ton:-239")).toEqual({"eip155:10": "HOT paused", "ton:-239": "paused by the app"});
    const {config} = parseRuntimeConfig({nearIntents: {suspendedChains: "eip155:56=down"}});
    expect(config.nearIntents.suspendedChains).toEqual({"eip155:56": "down"});
  });

  it("ships every EVM catalog chain with an RPC list, Elysium included", () => {
    expect(DEFAULT_RUNTIME_CONFIG.evmRpc[99901]?.[0]).toBe("https://rpc.elysium.kinetiq.xyz");
    expect(Object.values(DEFAULT_RUNTIME_CONFIG.evmRpc).every((l) => l.length >= 2)).toBe(true);
    expect(DEFAULT_RUNTIME_CONFIG.solanaRpc).not.toContain("https://api.mainnet-beta.solana.com");
  });
});

describe("loadRuntimeConfig", () => {
  afterEach(() => setRuntimeConfig(DEFAULT_RUNTIME_CONFIG));

  it("merges the fetched file and the hash demo flag", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({providers: {balancer: false}}), {status: 200}));
    const config = await loadRuntimeConfig({url: "https://app.example/runtime-config.json", fetchImpl, buildTime: "", location: {hash: "#/?demo=1", search: ""}});
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(config.providers.balancer).toBe(false);
    expect(config.demo).toBe(true);
    expect(getRuntimeConfig()).toBe(config);
  });

  it("treats an SPA fallback (index.html with 200) as no file, without a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("<!doctype html><html></html>", {status: 200, headers: {"content-type": "text/html"}}));
    const config = await loadRuntimeConfig({url: "https://app.example/runtime-config.json", fetchImpl, buildTime: "", userSettings: null, location: {hash: "", search: ""}});
    expect(config).toEqual(DEFAULT_RUNTIME_CONFIG);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("layers the viewer's saved settings after the file and before the hash demo flag", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({providers: {balancer: true}, api: {lifi: "https://op.example/lifi"}}), {status: 200}));
    const config = await loadRuntimeConfig({
      url: "https://app.example/runtime-config.json",
      fetchImpl,
      buildTime: "",
      userSettings: {providers: {balancer: false}, api: {relay: "https://me.example/relay"}, demo: true},
      location: {hash: "#/?demo=0", search: ""},
    });
    expect(config.providers.balancer).toBe(false);
    expect(config.api.lifi).toBe("https://op.example/lifi");
    expect(config.api.relay).toBe("https://me.example/relay");
    expect(config.demo).toBe(false);
  });

  it("names every host the saved settings redirect (the swap screen and the review show them)", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", {status: 404}));
    await loadRuntimeConfig({
      url: "https://app.example/runtime-config.json",
      fetchImpl,
      buildTime: "",
      userSettings: {api: {nearIntents: "https://proxy.example/v0"}, prices: {defillama: "https://llama.example"}, evmRpc: {1: ["https://rpc.example"]}},
      location: {hash: "", search: "", pathname: "/"},
    });
    expect(savedOverrides()).toEqual({
      ignored: false,
      hosts: [
        {key: "api.nearIntents", host: "proxy.example"},
        {key: "prices.defillama", host: "llama.example"},
      ],
      evmRpcChains: [1],
      solanaRpc: false,
    });
  });

  it("ignores saved settings on an IPFS path gateway, where every site shares the origin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("not found", {status: 404}));
    const planted = {api: {nearIntents: "https://attacker.example/v0", chainflip: "https://attacker.example/cf"}, prices: {defillama: "https://attacker.example/llama"}};
    const config = await loadRuntimeConfig({
      url: "https://ipfs.io/ipfs/bafytest/runtime-config.json",
      fetchImpl,
      buildTime: "",
      userSettings: planted,
      location: {hash: "#/", search: "", pathname: "/ipfs/bafytest/"},
    });
    expect(config.api.nearIntents).toBe(DEFAULT_RUNTIME_CONFIG.api.nearIntents);
    expect(config.prices.defillama).toBe(DEFAULT_RUNTIME_CONFIG.prices.defillama);
    expect(savedOverrides()).toMatchObject({ignored: true, hosts: []});
    expect(isSharedOriginPath("/ipns/app.eth/")).toBe(true);
    expect(isSharedOriginPath("/")).toBe(false);
    warn.mockRestore();
  });

  it("on an IPFS path gateway Omniston is off unless this page's operator layer turns it on (its HTLC secret is in shared storage)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const at = (file: unknown, pathname: string, buildTime = "") =>
      loadRuntimeConfig({
        url: "https://ipfs.io/ipfs/bafytest/runtime-config.json",
        fetchImpl: vi.fn(async () => (file ? new Response(JSON.stringify(file), {status: 200}) : new Response("not found", {status: 404}))),
        buildTime,
        userSettings: null,
        location: {hash: "#/", search: "", pathname},
      });
    const shared = await at(null, "/ipfs/bafytest/");
    expect(shared.providers.omniston).toBe(false);
    expect(shared.providers.symbiosis).toBe(true); // nothing of its own in the page's storage
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/omniston off — this page is on an IPFS path gateway/));
    expect((await at({providers: {omniston: true}}, "/ipfs/bafytest/")).providers.omniston).toBe(true);
    expect((await at(null, "/ipfs/bafytest/", JSON.stringify({providers: {omniston: true}}))).providers.omniston).toBe(true);
    // The file's later "false" wins over the build's "true"; at the origin's root the default holds.
    expect((await at({providers: {omniston: false}}, "/ipfs/bafytest/", JSON.stringify({providers: {omniston: true}}))).providers.omniston).toBe(false);
    expect((await at(null, "/")).providers.omniston).toBe(true);
    warn.mockRestore();
  });

  it("a viewer can switch a venue off, but not back on after the operator switched it off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({providers: {relay: false}}), {status: 200}));
    const config = await loadRuntimeConfig({
      url: "https://app.example/runtime-config.json",
      fetchImpl,
      buildTime: "",
      userSettings: {providers: {relay: true, lifi: false, balancer: true, omniston: false}},
      location: {hash: "", search: "", pathname: "/"},
    });
    expect(config.providers.relay).toBe(false); // the operator's emergency stop holds
    expect(config.providers.lifi).toBe(false); // off is always allowed
    expect(config.providers.omniston).toBe(false); // so for a venue on by default since 2026-11-12
    expect(config.providers.balancer).toBe(true); // on by default, and the operator didn't switch it off
    warn.mockRestore();
  });

  it("previews: a viewer may switch them off, never on against the operator, never loosen the operator's pacing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), {status: 200}));
    const load = (body: unknown, userSettings: RuntimeConfigInput) =>
      loadRuntimeConfig({url: "https://app.example/runtime-config.json", fetchImpl: file(body), buildTime: "", userSettings, location: {hash: "", search: "", pathname: "/"}});
    expect((await load({}, {preview: {enabled: false}})).preview.enabled).toBe(false);
    expect((await load({preview: {enabled: false}}, {preview: {enabled: true}})).preview.enabled).toBe(false);
    expect((await load({preview: {roundsBurst: 3}}, {preview: {roundsBurst: 20, roundRefillMs: 5_000}})).preview).toEqual({enabled: true, roundsBurst: 3, roundRefillMs: 20_000});
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/preview prices stay off/));
    warn.mockRestore();
  });

  it("parses the preview section within bounds", () => {
    expect(parseRuntimeConfig({preview: {enabled: false, roundsBurst: 8, roundRefillMs: 30_000}}).config.preview).toEqual({enabled: false, roundsBurst: 8, roundRefillMs: 30_000});
    const bad = parseRuntimeConfig({preview: {enabled: "no", roundsBurst: 0, roundRefillMs: 100}});
    expect(bad.config.preview).toEqual(DEFAULT_RUNTIME_CONFIG.preview);
    expect(bad.warnings).toHaveLength(3);
  });

  it("boots on the defaults when the file is missing", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", {status: 404}));
    const config = await loadRuntimeConfig({url: "https://app.example/runtime-config.json", fetchImpl, buildTime: "", location: {hash: "", search: ""}});
    expect(config).toEqual(DEFAULT_RUNTIME_CONFIG);
  });
});

describe("preview token bucket (D29)", () => {
  it("lets a burst through, then one per refill period, and says when the next one is in", () => {
    let t = 0;
    const b = createTokenBucket(2, 20_000, () => t);
    expect(b.nextAt()).toBe(0);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    expect(b.nextAt()).toBe(20_000);
    t = 19_999;
    expect(b.take()).toBe(false);
    t = 20_000;
    expect(b.take()).toBe(true);
    t = 1_000_000;
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });
});

describe("hash routing", () => {
  it("parses and formats the one-screen route", () => {
    const r = parseHash("#/?pay=base:native&demo=1");
    expect(r.path).toBe("/");
    expect(r.query.get("pay")).toBe("base:native");
    expect(formatHash(r)).toBe("#/?pay=base%3Anative&demo=1");
    expect(parseHash("").path).toBe("/");
  });

  it("reads demo from the hash query first", () => {
    expect(demoFromLocation({hash: "#/?demo=1", search: ""})).toBe(true);
    expect(demoFromLocation({hash: "#/?demo=0", search: "?demo=1"})).toBe(false);
    expect(demoFromLocation({hash: "#/", search: ""})).toBeNull();
  });

  it("treats a #/demo/<scene> path as demo unless the query says demo=0", () => {
    expect(demoFromLocation({hash: "#/demo/deposit", search: ""})).toBe(true);
    expect(demoFromLocation({hash: "#/demo/deposit?demo=0", search: ""})).toBe(false);
    expect(demoFromLocation({hash: "#/demolition", search: ""})).toBeNull();
  });

  it("the preview scene opens without a wallet unless the query names one", () => {
    expect(demoWallets({hash: "#/demo/preview", search: ""})).toBe("none");
    expect(demoWallets({hash: "#/demo/preview?demoWallets=evm", search: ""})).toBe("evm");
    expect(demoWallets({hash: "#/demo/review", search: ""})).toBe("evm");
  });
});

describe("user settings (localStorage overrides)", () => {
  afterEach(() => localStorage.clear());

  it("round-trips, clears on null or {}, and drops operator-only sections and RPCs (now the connection's, D30) on read", () => {
    expect(readUserSettings()).toBeNull();
    expect(
      writeUserSettings({
        prices: {defillama: "https://llama.example"},
        solanaRpc: ["https://sol.example"],
        evmRpc: {1: ["https://eth.example"]},
        nearRpc: ["https://near.example"],
        demo: true,
        nearIntents: {suspendedChains: {}},
      }),
    ).toBe(true);
    expect(readUserSettings()).toEqual({prices: {defillama: "https://llama.example"}});
    expect(writeUserSettings({})).toBe(true);
    expect(localStorage.getItem(USER_SETTINGS_KEY)).toBeNull();
    localStorage.setItem(USER_SETTINGS_KEY, "not json");
    expect(readUserSettings()).toBeNull();
    localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify({demo: true}));
    expect(readUserSettings()).toBeNull();
  });
});
