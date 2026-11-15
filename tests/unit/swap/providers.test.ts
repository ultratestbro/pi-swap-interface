import {beforeEach, describe, expect, it, vi} from "vitest";
import type {CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import {balancerProvider} from "@anywalletkit/protocol-swap2-balancer/provider";
import {cctpProvider} from "@anywalletkit/protocol-swap2-cctp/provider";
import {CCTP_DOMAINS} from "@anywalletkit/protocol-swap2-cctp/config";
import {chainflipProvider} from "@anywalletkit/protocol-swap2-chainflip/provider";
import {curveProvider} from "@anywalletkit/protocol-swap2-curve/provider";
import {fyndProvider} from "@anywalletkit/protocol-swap2-fynd/provider";
import {FYND_CHAINS, TYCHO_ROUTER_ABI} from "@anywalletkit/protocol-swap2-fynd/router";
import {jupiterProvider} from "@anywalletkit/protocol-swap2-jupiter/provider";
import {lifiProvider} from "@anywalletkit/protocol-swap2-lifi/provider";
import {nearIntentsProvider} from "@anywalletkit/protocol-swap2-near-intents/provider";
import {relayProvider} from "@anywalletkit/protocol-swap2-relay/provider";
import {symbiosisProvider} from "@anywalletkit/protocol-swap2-symbiosis/provider";
import {thorchainProvider} from "@anywalletkit/protocol-swap2-thorchain/provider";
import {uniswapProvider} from "@anywalletkit/protocol-swap2-uniswap/provider";
import {usdt0Provider} from "@anywalletkit/protocol-swap2-usdt0/provider";
import {wrapProvider} from "@anywalletkit/protocol-swap2-wrap/provider";
import {zeroExProvider} from "@anywalletkit/protocol-swap2-0x/provider";
import {acrossProvider} from "@anywalletkit/protocol-swap2-across/provider";
import {ACROSS_CHAINS} from "@anywalletkit/protocol-swap2-across/config";
import {encodeFunctionData, zeroAddress} from "viem";
import {customOverlay, standardSlots} from "../../../src/config/connection";
import {DEFAULT_RUNTIME_CONFIG, PROVIDER_KEYS} from "../../../src/config/defaults";
import {createProxyFetch, healthRoutes} from "../../../src/config/standard";
import type {ProviderName, RuntimeConfig} from "../../../src/contracts/config";
import {createQuoteEngine, eligibleProviders, enabledVenues} from "../../../src/swap/engine";
import {createVenueBackoff} from "../../../src/swap/limiter";
import {DEFAULT_ON_PROVIDERS, PROXY_KEY_PLACEHOLDER, STANDARD_ONLY_PROVIDERS, buildProviders, closeProviders, evmRpcByCaip2, zeroExSettlers} from "../../../src/swap/providers";
import {classifyRefusal} from "../../../src/swap/refusals";
import type {ProviderStores} from "../../../src/swap/stores";
import {request} from "./fixtures";

// Spy on every factory (the real one still runs), so the exact options each provider got can be asserted.
vi.mock("@anywalletkit/protocol-swap2-balancer/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-balancer/provider")>();
  return {...m, balancerProvider: vi.fn(m.balancerProvider)};
});
vi.mock("@anywalletkit/protocol-swap2-cctp/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-cctp/provider")>();
  return {...m, cctpProvider: vi.fn(m.cctpProvider)};
});
vi.mock("@anywalletkit/protocol-swap2-chainflip/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-chainflip/provider")>();
  return {...m, chainflipProvider: vi.fn(m.chainflipProvider)};
});
vi.mock("@anywalletkit/protocol-swap2-curve/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-curve/provider")>();
  return {...m, curveProvider: vi.fn(m.curveProvider)};
});
vi.mock("@anywalletkit/protocol-swap2-fynd/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-fynd/provider")>();
  return {...m, fyndProvider: vi.fn(m.fyndProvider)};
});
vi.mock("@anywalletkit/protocol-swap2-jupiter/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-jupiter/provider")>();
  return {...m, jupiterProvider: vi.fn(m.jupiterProvider)};
});
vi.mock("@anywalletkit/protocol-swap2-lifi/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-lifi/provider")>();
  return {...m, lifiProvider: vi.fn(m.lifiProvider)};
});
vi.mock("@anywalletkit/protocol-swap2-near-intents/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-near-intents/provider")>();
  return {...m, nearIntentsProvider: vi.fn(m.nearIntentsProvider)};
});
vi.mock("@anywalletkit/protocol-swap2-relay/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-relay/provider")>();
  return {...m, relayProvider: vi.fn(m.relayProvider)};
});
vi.mock("@anywalletkit/protocol-swap2-symbiosis/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-symbiosis/provider")>();
  return {...m, symbiosisProvider: vi.fn(m.symbiosisProvider)};
});
vi.mock("@anywalletkit/protocol-swap2-thorchain/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-thorchain/provider")>();
  return {...m, thorchainProvider: vi.fn(m.thorchainProvider)};
});
vi.mock("@anywalletkit/protocol-swap2-uniswap/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-uniswap/provider")>();
  return {...m, uniswapProvider: vi.fn(m.uniswapProvider)};
});
vi.mock("@anywalletkit/protocol-swap2-usdt0/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-usdt0/provider")>();
  return {...m, usdt0Provider: vi.fn(m.usdt0Provider)};
});
vi.mock("@anywalletkit/protocol-swap2-0x/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-0x/provider")>();
  return {...m, zeroExProvider: vi.fn(m.zeroExProvider)};
});
vi.mock("@anywalletkit/protocol-swap2-across/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-across/provider")>();
  return {...m, acrossProvider: vi.fn(m.acrossProvider)};
});
vi.mock("@anywalletkit/protocol-swap2-wrap/provider", async (orig) => {
  const m = await orig<typeof import("@anywalletkit/protocol-swap2-wrap/provider")>();
  return {...m, wrapProvider: vi.fn(m.wrapProvider)};
});

// The Omniston chunk is replaced by a recorder: these tests check WHEN it loads, not the SDK.
const omni = vi.hoisted(() => ({built: 0}));
vi.mock("../../../src/swap/omniston", () => ({
  buildOmniston: () => {
    omni.built++;
    const fake: CrossChainProvider = {
      name: "omniston",
      supportsSameChain: true,
      enabled: () => true,
      supportsRoute: () => true,
      getQuote: async () => null,
      buildDeposit: async () => {
        throw new Error("not in tests");
      },
      trackIntent: async () => ({state: "pending"}),
    };
    return fake;
  },
}));

const FACTORIES = [
  balancerProvider,
  cctpProvider,
  chainflipProvider,
  curveProvider,
  jupiterProvider,
  lifiProvider,
  nearIntentsProvider,
  relayProvider,
  symbiosisProvider,
  thorchainProvider,
  uniswapProvider,
  usdt0Provider,
  wrapProvider,
];

const lastConfig = (f: unknown): Record<string, unknown> => {
  const calls = vi.mocked(f as (c: unknown) => unknown).mock.calls;
  return (calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;
};

const stores = (ready: boolean): ProviderStores => ({
  ready: async () => ready,
  relayCleared: {has: async () => false, add: async () => {}},
  omnistonQuotes: {save: async () => {}, load: async () => undefined, clear: async () => {}, claim: async () => true},
  omnistonSecrets: {save: async () => {}, load: async () => undefined, clear: async () => {}},
});

const withFlags = (flags: Partial<Record<ProviderName, boolean>>, extra: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  ...DEFAULT_RUNTIME_CONFIG,
  ...extra,
  providers: {...DEFAULT_RUNTIME_CONFIG.providers, ...flags},
});

const ALL_ON = Object.fromEntries([...DEFAULT_ON_PROVIDERS, ...STANDARD_ONLY_PROVIDERS].map((p) => [p, true])) as Record<ProviderName, boolean>;
const ALL_OFF = Object.fromEntries(DEFAULT_ON_PROVIDERS.map((p) => [p, false])) as Record<ProviderName, boolean>;

beforeEach(() => {
  vi.clearAllMocks();
  omni.built = 0;
});

describe("buildProviders: which providers", () => {
  it("defaults build every venue but Fynd, in ask order: Balancer after Curve, Symbiosis after Relay, Omniston last", async () => {
    const names = buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true)).map((p) => p.name);
    expect(names).toEqual([...DEFAULT_ON_PROVIDERS]);
    expect(names.slice(0, 3)).toEqual(["uniswap", "curve", "balancer"]);
    expect(names.slice(names.indexOf("relay"), names.indexOf("relay") + 2)).toEqual(["relay", "symbiosis"]);
    expect(names.at(-1)).toBe("omniston");
    expect(new Set(names).size).toBe(names.length);
    // No Standard slot: no Fynd.
    expect(names).not.toContain("fynd");
    expect(fyndProvider).not.toHaveBeenCalled();
    // Symbiosis, Balancer and Omniston are on by default (owner, 2026-11-12), each with its usual construction.
    for (const p of ["symbiosis", "balancer", "omniston"] as const) expect(DEFAULT_RUNTIME_CONFIG.providers[p]).toBe(true);
    expect(symbiosisProvider).toHaveBeenCalledOnce();
    expect(balancerProvider).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(omni.built).toBe(1));
    // Settings lists the venues in the same order (PROVIDER_KEYS = the defaults' keys), Standard's Fynd last.
    expect(PROVIDER_KEYS).toEqual([...DEFAULT_ON_PROVIDERS, ...STANDARD_ONLY_PROVIDERS]);
  });

  it("an operator (or a viewer) can still switch Symbiosis, Balancer or Omniston off like any venue", async () => {
    const names = buildProviders(withFlags({symbiosis: false, balancer: false, omniston: false}), stores(true)).map((p) => p.name);
    expect(names).toEqual(DEFAULT_ON_PROVIDERS.filter((p) => !["symbiosis", "balancer", "omniston"].includes(p)));
    expect(symbiosisProvider).not.toHaveBeenCalled();
    expect(balancerProvider).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(omni.built).toBe(0);
  });

  it("a provider flagged off is not constructed at all", () => {
    const names = buildProviders(withFlags({relay: false, jupiter: false}), stores(true)).map((p) => p.name);
    expect(names).not.toContain("relay");
    expect(names).not.toContain("jupiter");
    expect(relayProvider).not.toHaveBeenCalled();
    expect(jupiterProvider).not.toHaveBeenCalled();
  });

  it("no provider gets a key or a fee option (zero fee, keyless)", () => {
    buildProviders(withFlags(ALL_ON), stores(true));
    for (const f of FACTORIES) {
      expect(f).toHaveBeenCalledTimes(1);
      for (const k of Object.keys(lastConfig(f))) expect(k).not.toMatch(/fee|affiliate|integrator|partner|apiKey|jwt|enabled/i);
    }
  });
});

describe("buildProviders: options", () => {
  it("THORChain: both configured nodes, Tron dark, our client id; confirm nodes only when set", () => {
    buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true));
    expect(lastConfig(thorchainProvider)).toEqual({
      nodeUrl: [...DEFAULT_RUNTIME_CONFIG.api.thorNodes],
      clientId: "cp0x-swap",
      tronSource: false,
    });
    const third = ["https://thor.example.org"];
    buildProviders({...DEFAULT_RUNTIME_CONFIG, api: {...DEFAULT_RUNTIME_CONFIG.api, thorConfirmNodes: third}}, stores(true));
    expect(lastConfig(thorchainProvider).confirmNodeUrl).toEqual(third);
  });

  it("LI.FI: the Flare Diamond override for both targets and approvals", () => {
    buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true));
    const flare = {"eip155:14": ["0x198FC70Dfe05E755C81e54bd67Bff3F729344B9b"]};
    expect(lastConfig(lifiProvider)).toEqual({apiUrl: "https://li.quest/v1", trustedTransactionTargets: flare, trustedApprovalAddresses: flare});
  });

  it("LI.FI is asked EVM → Solana too (0.8.0 reads the Solana recipient itself); its own chain table decides the rest", () => {
    const lifi = buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true)).find((p) => p.name === "lifi")!;
    const eth = {chain: "eip155:1", token: "ETH"};
    const solMainnet = {chain: "solana:mainnet", token: "SOL"};
    expect(lifi.supportsRoute(eth, solMainnet)).toBe(true);
    expect(lifi.supportsRoute(solMainnet, eth)).toBe(true);
    expect(lifi.supportsRoute(eth, {chain: "eip155:8453", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"})).toBe(true);
    expect(lifi.supportsRoute(eth, {chain: "eip155:1", token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"})).toBe(true);
    // A Solana id LI.FI's table doesn't use (it names Solana "solana:mainnet", as the catalog does): not asked.
    expect(lifi.supportsRoute(eth, {chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", token: "SOL"})).toBe(false);
  });

  it("LI.FI cools down after its rate limit instead of re-asking every round", async () => {
    const lifi = buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true)).find((p) => p.name === "lifi")!;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({message: "Rate limit exceeded, retry in 2 hours", code: 1005}), {status: 429, headers: {"content-type": "application/json"}}),
    );
    try {
      const refusals: string[] = [];
      const params = {
        sourceChain: "eip155:42161",
        sourceToken: "USDC",
        destChain: "eip155:8453",
        destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amountIn: "5000000",
        slippageBps: 50,
        destAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        refundAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        dry: true,
        onRefusal: (r: string) => void refusals.push(r),
      };
      expect(await lifi.getQuote(params)).toBeNull();
      const sent = fetchMock.mock.calls.length;
      expect(sent).toBeGreaterThan(0);
      expect(await lifi.getQuote(params)).toBeNull();
      expect(fetchMock.mock.calls.length).toBe(sent); // the second round sent nothing
      expect(refusals).toEqual(["lifi: Rate limit exceeded, retry in 2 hours", "lifi: rate limit exceeded, retry in ~120 min"]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("Symbiosis' 429 starts the engine's back-off: the next rounds send it nothing until the wait is over", async () => {
    const pacing = {...DEFAULT_RUNTIME_CONFIG.pacing, symbiosisGapMs: 0};
    const [symbiosis] = buildProviders(withFlags({...ALL_OFF, symbiosis: true}, {pacing}), stores(true));
    // A 429 without a message: the SDK refuses with "Symbiosis API → 429" (chunk-K3EPNDVO.js:176-183, :453-454).
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", {status: 429}));
    try {
      let t = 1_000_000;
      const engine = createQuoteEngine({providers: () => [symbiosis!], gasPrice: async () => null, backoff: createVenueBackoff(() => t)});
      const round = () => engine.quoteRoutes({mode: "live", req: request()}, () => {});
      expect((await round())!.rejections).toMatchObject([{provider: "symbiosis", category: "busy", reason: "Busy right now — try again soon"}]);
      const sent = fetchMock.mock.calls.length;
      expect(sent).toBe(1);
      expect((await round())!.rejections).toMatchObject([{provider: "symbiosis", category: "busy", skipped: true}]);
      expect(fetchMock.mock.calls.length).toBe(sent);
      t += 60_001;
      await round();
      expect(fetchMock.mock.calls.length).toBe(sent + 1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("Relay gets the durable cleared-order store", () => {
    const s = stores(true);
    buildProviders(DEFAULT_RUNTIME_CONFIG, s);
    expect(lastConfig(relayProvider).clearedStore).toBe(s.relayCleared);
    expect(lastConfig(relayProvider).baseUrl).toBe("https://api.relay.link");
  });

  it("CCTP gets ONE first runtime RPC for every Circle EVM domain", () => {
    buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true));
    const rpc = lastConfig(cctpProvider).rpcUrls as Record<string, string>;
    expect(Object.keys(rpc).sort()).toEqual(Object.keys(CCTP_DOMAINS).sort());
    expect(rpc["eip155:8453"]).toBe(DEFAULT_RUNTIME_CONFIG.evmRpc[8453]![0]);
    expect(lastConfig(cctpProvider).mode).toBe("auto");
  });

  it("CCTP's one RPC per chain falls back through the rest of that chain's list (its fetchImpl), Circle's API untouched", async () => {
    const config = {...DEFAULT_RUNTIME_CONFIG, evmRpc: {...DEFAULT_RUNTIME_CONFIG.evmRpc, 8453: ["https://a.example", "https://b.example"]}};
    buildProviders(config, stores(true), {});
    const {rpcUrls, fetchImpl} = lastConfig(cctpProvider) as {rpcUrls: Record<string, string>; fetchImpl: typeof fetch};
    expect(rpcUrls["eip155:8453"]).toBe("https://a.example");
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seen.push(String(input));
      return new Response("{}", {status: String(input) === "https://a.example" ? 503 : 200});
    });
    expect((await fetchImpl("https://a.example", {method: "POST", body: "{}"})).status).toBe(200);
    await fetchImpl("https://iris-api.circle.com/v2/messages/6", {});
    expect(seen).toEqual(["https://a.example", "https://b.example", "https://iris-api.circle.com/v2/messages/6"]);
    vi.restoreAllMocks();
  });

  it("Custom mode's keys go only into their own venue's constructor; Standard's routing fetch to Relay, and to Symbiosis behind its pacer", async () => {
    const routing = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true), {
      keys: {lifi: "test-lifi", relay: "test-relay", nearIntents: "test-jwt", jupiter: "test-jup", symbiosis: "test-sym"},
      fetchImpl: routing,
    });
    expect(lastConfig(lifiProvider).apiKey).toBe("test-lifi");
    expect(lastConfig(relayProvider)).toMatchObject({apiKey: "test-relay", fetchImpl: routing});
    expect(lastConfig(nearIntentsProvider).jwt).toBe("test-jwt");
    expect(lastConfig(jupiterProvider).apiKey).toBe("test-jup");
    const sym = lastConfig(symbiosisProvider);
    expect(sym.apiKey).toBe("test-sym");
    // Its own pacer, which hands each request to the routing fetch with the same arguments.
    expect(sym.fetchImpl).not.toBe(routing);
    const init = {method: "POST", body: "{}"};
    await (sym.fetchImpl as typeof fetch)("https://api.symbiosis.finance/crosschain/v2/quote", init);
    expect(routing).toHaveBeenCalledWith("https://api.symbiosis.finance/crosschain/v2/quote", init);
    for (const f of [balancerProvider, chainflipProvider, thorchainProvider, uniswapProvider, usdt0Provider, wrapProvider, cctpProvider])
      expect(JSON.stringify(lastConfig(f))).not.toMatch(/test-/);
    // Without keys (Public, Standard): no key option at all, not even an empty one.
    buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true), {keys: {}});
    for (const f of [lifiProvider, relayProvider, nearIntentsProvider, jupiterProvider, symbiosisProvider]) expect(Object.keys(lastConfig(f))).not.toEqual(expect.arrayContaining(["apiKey"]));
    expect("jwt" in lastConfig(nearIntentsProvider)).toBe(false);
    expect("fetchImpl" in lastConfig(relayProvider)).toBe(false);
  });

  it("a viewer's Symbiosis key is sent as X-Api-Key, never in the URL", async () => {
    const seen: {url: string; headers: Headers}[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({url: String(input), headers: new Headers(init?.headers)});
      return new Response(JSON.stringify({message: "no route"}), {status: 400, headers: {"content-type": "application/json"}});
    });
    const pacing = {...DEFAULT_RUNTIME_CONFIG.pacing, symbiosisGapMs: 0};
    const [symbiosis] = buildProviders(withFlags({...ALL_OFF, symbiosis: true}, {pacing}), stores(true), {keys: {symbiosis: "test-sym-key"}, fetchImpl: fetchImpl as unknown as typeof fetch});
    await symbiosis!.getQuote({
      sourceChain: "eip155:8453",
      sourceToken: "USDC",
      destChain: "eip155:42161",
      destToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      amountIn: "1000000",
      destAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      refundAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) {
      expect(r.headers.get("x-api-key")).toBe("test-sym-key");
      expect(r.url).not.toContain("test-sym-key");
    }
  });

  it("a viewer's key is sent as its venue's header (Relay x-api-key), never in the URL", async () => {
    const seen: {url: string; headers: Headers}[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({url: String(input), headers: new Headers(init?.headers)});
      return new Response(JSON.stringify({message: "no route"}), {status: 400, headers: {"content-type": "application/json"}});
    });
    const relay = buildProviders(withFlags({}), stores(true), {keys: {relay: "test-relay-key"}, fetchImpl: fetchImpl as unknown as typeof fetch}).find((p) => p.name === "relay")!;
    await relay.getQuote({
      sourceChain: "eip155:8453",
      sourceToken: "USDC",
      destChain: "eip155:42161",
      destToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      amountIn: "1000000",
      destAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      refundAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) {
      expect(r.headers.get("x-api-key")).toBe("test-relay-key");
      expect(r.url).not.toContain("test-relay-key");
    }
  });

  it("USDT0 and the EVM venues read the runtime RPC table", () => {
    buildProviders(withFlags(ALL_ON), stores(true));
    expect(lastConfig(usdt0Provider).rpcUrls).toEqual(evmRpcByCaip2(DEFAULT_RUNTIME_CONFIG.evmRpc));
    // The Legacy Mesh into TON and Tron (Tron's fee cap: execute.ts nativeFeeCeiling), TON payouts checked on the operator's TonAPI.
    expect(lastConfig(usdt0Provider)).toMatchObject({meshDestinations: ["ton", "tron"], tonApiUrl: DEFAULT_RUNTIME_CONFIG.tonApiUrl, scanUrl: DEFAULT_RUNTIME_CONFIG.api.layerZeroScan});
    expect(lastConfig(uniswapProvider).rpcUrls).toBe(DEFAULT_RUNTIME_CONFIG.evmRpc);
    expect(lastConfig(wrapProvider).rpcUrls).toBe(DEFAULT_RUNTIME_CONFIG.evmRpc);
    expect(lastConfig(balancerProvider).rpcUrls).toBe(DEFAULT_RUNTIME_CONFIG.evmRpc);
  });

  it("NEAR gets the configured paused corridors; Jupiter the Solana RPCs; Symbiosis is paced, Tron/BTC off; Balancer the RPC table", () => {
    const paused = {"eip155:10": "HOT omni-bridge corridor paused"};
    buildProviders(withFlags({}, {nearIntents: {suspendedChains: paused}}), stores(true));
    expect(lastConfig(nearIntentsProvider)).toEqual({apiUrl: "https://1click.chaindefuser.com/v0", suspendedChains: paused});
    expect(lastConfig(jupiterProvider).rpcUrls).toEqual([...DEFAULT_RUNTIME_CONFIG.solanaRpc]);
    const sym = lastConfig(symbiosisProvider);
    expect(sym).toMatchObject({apiUrl: "https://api.symbiosis.finance/crosschain", tronSource: false, btcSource: false});
    expect(typeof sym.fetchImpl).toBe("function");
    expect(lastConfig(balancerProvider)).toEqual({rpcUrls: DEFAULT_RUNTIME_CONFIG.evmRpc, apiUrl: "https://api-v3.balancer.fi/"});
  });

  it("Symbiosis' one pacer holds through a burst (previews, live rounds, the re-quote): a request per gap at most", async () => {
    vi.useFakeTimers();
    const sent: {at: number; signal?: AbortSignal | null}[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      sent.push({at: Date.now(), signal: init?.signal});
      return new Response("{}");
    });
    try {
      buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true));
      const pacedFetch = lastConfig(symbiosisProvider).fetchImpl as typeof fetch;
      // Five rounds at once (preview.roundsBurst); the second was superseded while it waited its turn.
      const superseded = new AbortController();
      const burst = [1, 2, 3, 4, 5].map((i) => pacedFetch(`https://api.symbiosis.finance/crosschain/v2/quote?${i}`, i === 2 ? {signal: superseded.signal} : {}));
      superseded.abort();
      await vi.runAllTimersAsync();
      await Promise.all(burst);
      expect(sent).toHaveLength(5);
      for (let i = 1; i < sent.length; i++) expect(sent[i]!.at - sent[i - 1]!.at).toBeGreaterThanOrEqual(DEFAULT_RUNTIME_CONFIG.pacing.symbiosisGapMs);
      // It reaches fetch with its aborted signal, which fetch refuses without sending anything.
      expect(sent[1]!.signal?.aborted).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("evmRpcByCaip2 drops chains without a URL", () => {
    expect(evmRpcByCaip2({1: ["https://a"], 10: []})).toEqual({"eip155:1": ["https://a"]});
  });
});

const API = "https://cp0x-api.example.org";
const BASE = `${API}/api/v2/swap-web`;
const FYND_BASE = `${BASE}/venue/fynd`;
const ME = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

describe("Curve: built in every mode over the page's RPC table", () => {
  it("Public, Custom (the viewer's RPC first) and Standard (the proxy RPC first) each hand Curve the runtime table", () => {
    const names = buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true), {}).map((p) => p.name);
    expect(names).toContain("curve");
    expect(lastConfig(curveProvider)).toEqual({rpcUrls: DEFAULT_RUNTIME_CONFIG.evmRpc});

    const custom = customOverlay(DEFAULT_RUNTIME_CONFIG, {evmRpc: {1: ["https://my-node.example"]}, solanaRpc: []});
    buildProviders(custom, stores(true), {keys: {lifi: "test-lifi"}});
    const customRpc = lastConfig(curveProvider).rpcUrls as Record<number, readonly string[]>;
    expect(customRpc).toBe(custom.evmRpc);
    expect(customRpc[1]![0]).toBe("https://my-node.example");

    const standard = standardSlots(DEFAULT_RUNTIME_CONFIG, API).config;
    buildProviders(standard, stores(true), {fetchImpl: vi.fn() as unknown as typeof fetch});
    const standardRpc = lastConfig(curveProvider).rpcUrls as Record<number, readonly string[]>;
    expect(standardRpc[8453]![0]).toBe(`${BASE}/rpc/8453`);
    expect(standardRpc[8453]!.slice(1)).toEqual(DEFAULT_RUNTIME_CONFIG.evmRpc[8453]);
  });

  it("serves same-chain pairs on its offered chains only; flagged off, it is not constructed", () => {
    const curve = buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true), {}).find((p) => p.name === "curve")!;
    expect(curve.supportsSameChain).toBe(true);
    expect(curve.supportsRoute({chain: "eip155:1", token: "USDC"}, {chain: "eip155:1", token: USDT_ETH})).toBe(true);
    expect(curve.supportsRoute({chain: "eip155:1", token: "USDC"}, {chain: "eip155:8453", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"})).toBe(false);
    // BNB Chain has a pinned router but no allowlisted pool: not offered.
    expect(curve.supportsRoute({chain: "eip155:56", token: "USDT"}, {chain: "eip155:56", token: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"})).toBe(false);
    vi.clearAllMocks();
    expect(buildProviders(withFlags({curve: false}), stores(true), {}).map((p) => p.name)).not.toContain("curve");
    expect(curveProvider).not.toHaveBeenCalled();
  });
});

describe("Fynd: Standard only, through cp0x's proxy, while health keys it", () => {
  const slot = (live: () => boolean) => ({base: FYND_BASE, live});

  it("is never built without Standard's slot: Public, Custom (even with keys), or a page without a cp0x API", () => {
    expect(STANDARD_ONLY_PROVIDERS).toEqual(["fynd", "zeroex", "across"]);
    for (const extras of [{}, {keys: {lifi: "test-lifi", relay: "test-relay"}}, {fetchImpl: vi.fn() as unknown as typeof fetch}]) {
      expect(buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true), extras).map((p) => p.name)).not.toContain("fynd");
    }
    expect(fyndProvider).not.toHaveBeenCalled();
    // The operator's (or viewer's) flag still switches it off in Standard.
    expect(buildProviders(withFlags({fynd: false}), stores(true), {fynd: slot(() => true)}).map((p) => p.name)).not.toContain("fynd");
    expect(fyndProvider).not.toHaveBeenCalled();
  });

  it("in Standard: no key, the proxy as a keyless endpoint per Fynd chain, the RPC table, the SDK's own exclusions", () => {
    const config = standardSlots(DEFAULT_RUNTIME_CONFIG, API).config;
    const names = buildProviders(config, stores(true), {fynd: slot(() => true)}).map((p) => p.name);
    expect(names.slice(-1)).toEqual(["fynd"]);
    const opts = lastConfig(fyndProvider);
    expect(Object.keys(opts).sort()).toEqual(["rpcUrls", "selfHosted"]);
    expect(opts.selfHosted).toEqual(Object.fromEntries(Object.entries(FYND_CHAINS).map(([id, c]) => [Number(id), `${FYND_BASE}/${c.slug}`])));
    expect((opts.selfHosted as Record<number, string>)[1]).toBe(`${FYND_BASE}/ethereum`);
    expect(opts.rpcUrls).toBe(config.evmRpc);
    expect(JSON.stringify(opts)).not.toMatch(/apiKey|authorization|excludeProtocols|propellerheads/i);
  });

  it("routes only while its slot is live (health, every stop); enabled() stays the SDK's for the post-approval check", () => {
    let live = false;
    const providers = buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true), {fynd: slot(() => live)});
    const fynd = providers.find((p) => p.name === "fynd")!;
    const pair = {sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:1", destToken: USDT_ETH};
    const eth = [{chain: "eip155:1", token: "USDC"}, {chain: "eip155:1", token: USDT_ETH}] as const;
    // Shut: not asked, not offered on any chain, and not listed under "Not for this pair" either.
    expect(fynd.supportsRoute(...eth)).toBe(false);
    expect([fynd.supportsChain?.("eip155:1"), fynd.supportsChainPair?.("eip155:1", "eip155:1")]).toEqual([false, false]);
    expect(eligibleProviders(providers, pair)).not.toContain("fynd");
    expect(enabledVenues(providers)).not.toContain("fynd");
    // The engine re-reads enabled() after an approval is mined and revokes it on false: a shut slot must not do that.
    expect(fynd.enabled()).toBe(true);
    live = true;
    expect(fynd.supportsSameChain).toBe(true);
    expect(fynd.supportsRoute(...eth)).toBe(true);
    expect([fynd.supportsChain?.("eip155:1"), fynd.supportsChainPair?.("eip155:1", "eip155:1")]).toEqual([true, true]);
    expect(eligibleProviders(providers, pair)).toContain("fynd");
    expect(enabledVenues(providers)).toContain("fynd");
    expect(fynd.supportsRoute({chain: "eip155:10", token: "USDC"}, {chain: "eip155:10", token: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58"})).toBe(false);
  });

  it("a quote goes to the proxy at the hosted API's path, keyless; the SDK still checks it; a refusal of cp0x's key is never retried direct", async () => {
    const plan = standardSlots(DEFAULT_RUNTIME_CONFIG, API).plan;
    const routes = healthRoutes({venues: {fynd: "keyed"}, rpc: {configured: false, chains: []}, thornode: false}, plan);
    const stopped = new Map<string, number>();
    const router = FYND_CHAINS[1]!.router;
    const data = encodeFunctionData({
      abi: TYCHO_ROUTER_ABI,
      functionName: "singleSwap",
      args: [1_000_000n, USDC_ETH, USDT_ETH, 999_000n, 993_010n, ME, {clientFeeBps: 0, clientFeeReceiver: zeroAddress, maxClientContribution: 0n, deadline: 0n, clientSignature: "0x"}, "0x01"],
    });
    const order = {
      status: "success",
      amount_in: "1000000",
      amount_out: "999000",
      fee_breakdown: {router_fee: "1000", client_fee: "0", max_slippage: "4990", min_amount_received: "993010"},
      transaction: {to: router, value: "0", data},
      route: {swaps: [{protocol: "uniswap_v3"}]},
      gas_estimate: "150000",
    };
    let upstream = 200;
    const sent: {url: string; init?: RequestInit}[] = [];
    const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({url: String(input), init});
      const body = upstream === 200 ? {orders: [order]} : {error: "unauthorized"};
      return new Response(JSON.stringify(body), {status: upstream, headers: {"content-type": "application/json", "x-swap-web-answer": "upstream"}});
    });
    const proxied = createProxyFetch({
      plan,
      settled: async () => {},
      live: (key) => !stopped.has(key) && routes.venues.has(key.slice(6) as never),
      stop: (key, until) => void stopped.set(key, until),
      fetch: base as unknown as typeof fetch,
      now: () => Date.UTC(2026, 10, 12, 12),
      version: null,
    });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(proxied);
    try {
      const fynd = buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true), {fynd: slot(() => !stopped.has("venue:fynd"))}).find((p) => p.name === "fynd")!;
      const refusals: string[] = [];
      const params = {
        sourceChain: "eip155:1",
        sourceToken: "USDC",
        destChain: "eip155:1",
        destToken: USDT_ETH,
        amountIn: "1000000",
        slippageBps: 50,
        destAddress: ME,
        refundAddress: ME,
        dry: true,
        onRefusal: (r: string) => void refusals.push(r),
      };
      const quote = await fynd.getQuote(params);
      expect(refusals).toEqual([]);
      expect(quote).toMatchObject({provider: "fynd", destAmount: "998000", minDestAmount: "993010", txRequest: {to: router, approvalAddress: router}});
      expect(sent.map((r) => r.url)).toEqual([`${BASE}/venue/fynd/ethereum/quote`]);
      const headers = new Headers(sent[0]!.init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(sent[0]!.init?.method).toBe("POST");
      const body = JSON.parse(String(sent[0]!.init?.body)) as {orders: {token_in: string; receiver: string}[]; options: {route_filter: unknown}};
      expect(body.orders[0]).toMatchObject({token_in: USDC_ETH, receiver: ME});
      // The SDK's default exclusion stays on.
      expect(body.options.route_filter).toEqual({exclude_protocols: ["uniswap_v4_hooks"]});

      // Upstream 401 (cp0x's key refused): the slot stops, the SDK refuses, nothing goes to Fynd's own host.
      upstream = 401;
      expect(await fynd.getQuote(params)).toBeNull();
      expect(refusals).toEqual(["fynd: API key rejected (HTTP 401)"]);
      expect(stopped.get("venue:fynd")).toBe(Infinity);
      expect(sent.map((r) => r.url)).toEqual([`${BASE}/venue/fynd/ethereum/quote`, `${BASE}/venue/fynd/ethereum/quote`]);
      expect(sent.some((r) => r.url.includes("propellerheads"))).toBe(false);
      expect(classifyRefusal("fynd", refusals[0]!).reason).toBe("Unavailable right now — try later");
      // …and from then on it isn't asked at all; enabled() stays true, so a swap already approved still broadcasts.
      expect(fynd.supportsRoute({chain: "eip155:1", token: "USDC"}, {chain: "eip155:1", token: USDT_ETH})).toBe(false);
      expect(fynd.enabled()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

const ZEROEX_BASE = `${BASE}/venue/zeroex`;
const ACROSS_BASE = `${BASE}/venue/across`;
const USDC_BASE_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB_ADDR = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

/** The Standard routing over `base` (the original fetch), with health keying `keyed`; stops recorded in `stopped`. */
function standardRouting(keyed: readonly string[], base: typeof fetch, stopped: Map<string, number>) {
  const plan = standardSlots(DEFAULT_RUNTIME_CONFIG, API).plan;
  const routes = healthRoutes({venues: Object.fromEntries(keyed.map((v) => [v, "keyed"])), rpc: {configured: false, chains: []}, thornode: false}, plan);
  return createProxyFetch({
    plan,
    settled: async () => {},
    live: (key) => !stopped.has(key) && routes.venues.has(key.slice(6) as never),
    stop: (key, until) => void stopped.set(key, until),
    fetch: base,
    now: () => Date.UTC(2026, 10, 15, 12),
    version: null,
  });
}

describe("0x and Across: Standard only, through cp0x's proxy, while health keys each (D38)", () => {
  const slot = (b: string, live: () => boolean) => ({base: b, live});

  it("are never built without their Standard slot (Public, Custom with keys, no cp0x API), and a flag still switches each off", () => {
    for (const extras of [{}, {keys: {lifi: "test-lifi", relay: "test-relay"}}, {fetchImpl: vi.fn() as unknown as typeof fetch}, {fynd: slot(FYND_BASE, () => true)}]) {
      const names = buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true), extras).map((p) => p.name);
      expect(names).not.toContain("zeroex");
      expect(names).not.toContain("across");
    }
    expect(zeroExProvider).not.toHaveBeenCalled();
    expect(acrossProvider).not.toHaveBeenCalled();
    const off = buildProviders(withFlags({zeroex: false, across: false}), stores(true), {zeroex: slot(ZEROEX_BASE, () => true), across: slot(ACROSS_BASE, () => true)});
    expect(off.map((p) => p.name)).not.toContain("zeroex");
    expect(off.map((p) => p.name)).not.toContain("across");
    expect(zeroExProvider).not.toHaveBeenCalled();
    expect(acrossProvider).not.toHaveBeenCalled();
  });

  it("in Standard: the local providers with the proxy slot as baseUrl and only a placeholder key; the page's RPCs", () => {
    const config = standardSlots(DEFAULT_RUNTIME_CONFIG, API).config;
    const names = buildProviders(config, stores(true), {fynd: slot(FYND_BASE, () => true), zeroex: slot(ZEROEX_BASE, () => true), across: slot(ACROSS_BASE, () => true)}).map((p) => p.name);
    expect(names.slice(-3)).toEqual(["fynd", "zeroex", "across"]);
    const zx = lastConfig(zeroExProvider);
    expect(Object.keys(zx).sort()).toEqual(["apiKey", "baseUrl", "rpcUrls"]);
    expect(zx).toMatchObject({apiKey: PROXY_KEY_PLACEHOLDER, baseUrl: ZEROEX_BASE});
    expect(zx.rpcUrls).toBe(config.evmRpc);
    const ac = lastConfig(acrossProvider);
    expect(Object.keys(ac).sort()).toEqual(["apiKey", "baseUrl", "fetchImpl", "rpcUrls"]);
    expect(ac).toMatchObject({apiKey: PROXY_KEY_PLACEHOLDER, baseUrl: ACROSS_BASE});
    // ONE RPC per Across chain (its type), the page's first; the rest behind it through fetchImpl (rpcFailoverFetch).
    const rpc = ac.rpcUrls as Record<string, string>;
    expect(rpc["eip155:8453"]).toBe(config.evmRpc[8453]![0]);
    expect(rpc["eip155:8453"]).toBe(`${BASE}/rpc/8453`);
    for (const c of Object.keys(rpc)) expect(Object.keys(ACROSS_CHAINS)).toContain(c);
    // No fee option, no suggestedFeesUrl override (its keyless relayer-fee quote stays direct), no real key anywhere.
    expect(JSON.stringify({zx: {...zx, rpcUrls: undefined}, ac: {...ac, rpcUrls: undefined, fetchImpl: undefined}})).not.toMatch(/fee|integrator|suggestedFeesUrl|0x\.org|across\.to/i);
    expect(PROXY_KEY_PLACEHOLDER).toMatch(/^[\x21-\x7e]+$/);
  });

  it("route only while their slot is live; enabled() stays the SDK's; 0x keeps ownGasEstimate through the wrapper", () => {
    let zxLive = false;
    let acLive = false;
    const providers = buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true), {zeroex: slot(ZEROEX_BASE, () => zxLive), across: slot(ACROSS_BASE, () => acLive)});
    const zeroex = providers.find((p) => p.name === "zeroex")!;
    const across = providers.find((p) => p.name === "across")!;
    const sameBase = [{chain: "eip155:8453", token: "ETH"}, {chain: "eip155:8453", token: USDC_BASE_ADDR}] as const;
    const baseToArb = [{chain: "eip155:8453", token: "USDC"}, {chain: "eip155:42161", token: USDC_ARB_ADDR}] as const;
    expect(zeroex.supportsRoute(...sameBase)).toBe(false);
    expect(across.supportsRoute(...baseToArb)).toBe(false);
    expect(enabledVenues(providers)).not.toContain("zeroex");
    expect(enabledVenues(providers)).not.toContain("across");
    expect([zeroex.enabled(), across.enabled()]).toEqual([true, true]);
    zxLive = true;
    acLive = true;
    expect(zeroex.supportsSameChain).toBe(true);
    expect(zeroex.supportsRoute(...sameBase)).toBe(true);
    expect(zeroex.supportsRoute(sameBase[0], {chain: "eip155:42161", token: USDC_ARB_ADDR})).toBe(false);
    // 0x is not on Gnosis, Across never on one network nor into Ethereum (not priced yet), and only the same asset.
    expect(zeroex.supportsRoute({chain: "eip155:100", token: "XDAI"}, {chain: "eip155:100", token: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83"})).toBe(false);
    expect(across.supportsRoute(...baseToArb)).toBe(true);
    expect(across.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:1", token: USDC_ETH})).toBe(false);
    expect(across.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:8453", token: USDC_BASE_ADDR})).toBe(false);
    expect(across.supportsRoute({chain: "eip155:8453", token: "ETH"}, {chain: "eip155:42161", token: USDC_ARB_ADDR})).toBe(false);
    expect(enabledVenues(providers)).toEqual(expect.arrayContaining(["zeroex", "across"]));
    expect(zeroex.ownGasEstimate).toBe(true);
  });

  it("zeroExSettlers answers from the very resolver the 0x provider reads the registry through, never the network", () => {
    const providers = buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true), {zeroex: slot(ZEROEX_BASE, () => true)});
    const built = vi.mocked(zeroExProvider).mock.results.at(-1)!.value as ReturnType<typeof zeroExProvider>;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect(zeroExSettlers(providers, "eip155:8453")).toEqual([]);
      const known = vi.spyOn(built.settlerResolver, "known").mockReturnValue(["0x103502909141F7025a94b7b99A276dCD128e21a8"]);
      expect(zeroExSettlers(providers, "eip155:8453")).toEqual(["0x103502909141F7025a94b7b99A276dCD128e21a8"]);
      expect(known).toHaveBeenCalledWith(8453);
      expect(zeroExSettlers(providers, "eip155:100")).toEqual([]);
      expect(zeroExSettlers(providers, "solana:mainnet")).toEqual([]);
      expect(zeroExSettlers(buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true), {}), "eip155:8453")).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a 0x price goes to the proxy slot with the placeholder key, never to api.0x.org; a refusal of cp0x's key stops the slot", async () => {
    const stopped = new Map<string, number>();
    const price = {
      allowanceTarget: "0x000000000022d473030f116ddee9f6b43ac78ba3",
      blockNumber: "57501646",
      buyAmount: "14164402",
      buyToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      fees: {integratorFee: null, integratorFees: null, zeroExFee: {amount: "21279", token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", type: "volume"}, gasFee: null},
      issues: {allowance: null, balance: null, simulationIncomplete: false, invalidSourcesPassed: []},
      liquidityAvailable: true,
      minBuyAmount: "14093580",
      mode: "exact-in",
      route: {fills: [{from: "0x4200000000000000000000000000000000000006", to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", source: "Uniswap_V3", proportionBps: "10000"}], tokens: []},
      sellAmount: "8000000000000000",
      sellToken: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      tokenMetadata: {buyToken: {buyTaxBps: "0", sellTaxBps: "0", transferTaxBps: "0"}, sellToken: {buyTaxBps: "0", sellTaxBps: "0", transferTaxBps: "0"}},
      totalNetworkFee: "7094174664170",
      zid: "0xae307fd609a6170caec9eda4",
      gas: "250311",
      gasPrice: "27908743",
    };
    let upstream = 200;
    const sent: {url: string; init?: RequestInit}[] = [];
    const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({url: String(input), init});
      const body = upstream === 200 ? price : {name: "UNAUTHORIZED", message: "bad key"};
      return new Response(JSON.stringify(body), {status: upstream, headers: {"content-type": "application/json", "x-swap-web-answer": "upstream"}});
    });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(standardRouting(["zeroex"], base as unknown as typeof fetch, stopped));
    try {
      const zeroex = buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true), {zeroex: slot(ZEROEX_BASE, () => !stopped.has("venue:zeroex"))}).find((p) => p.name === "zeroex")!;
      const refusals: string[] = [];
      const params = {
        sourceChain: "eip155:8453",
        sourceToken: "ETH",
        destChain: "eip155:8453",
        destToken: USDC_BASE_ADDR,
        amountIn: "8000000000000000",
        slippageBps: 50,
        destAddress: ME,
        refundAddress: ME,
        dry: true,
        onRefusal: (r: string) => void refusals.push(r),
      };
      const quote = await zeroex.getQuote(params);
      expect(refusals).toEqual([]);
      // A price (dry) answer: amounts and fees, no transaction (executionOf reads it as signed: SIGNED_ONLY).
      expect(quote).toMatchObject({provider: "zeroex", sourceAmount: "8000000000000000", destAmount: "14164402", minDestAmount: "14093580"});
      expect(quote?.txRequest).toBeUndefined();
      expect(sent).toHaveLength(1);
      const url = new URL(sent[0]!.url);
      expect(`${url.origin}${url.pathname}`).toBe(`${ZEROEX_BASE}/swap/permit2/price`);
      expect([...url.searchParams.keys()]).toEqual(["chainId", "sellToken", "buyToken", "sellAmount", "slippageBps", "taker"]);
      expect(url.searchParams.get("chainId")).toBe("8453");
      const headers = new Headers(sent[0]!.init?.headers);
      expect(headers.get("0x-api-key")).toBe(PROXY_KEY_PLACEHOLDER);
      expect(headers.get("0x-version")).toBe("v2");
      expect(sent[0]!.init?.method).toBe("GET");
      expect(sent[0]!.init?.redirect).toBe("error");

      // Upstream 401 (cp0x's key refused): the slot stops, the SDK refuses, nothing goes to api.0x.org.
      upstream = 401;
      expect(await zeroex.getQuote(params)).toBeNull();
      expect(refusals).toEqual(["zeroex: API key rejected (HTTP 401)"]);
      expect(stopped.get("venue:zeroex")).toBe(Infinity);
      expect(sent.every((r) => r.url.startsWith(ZEROEX_BASE))).toBe(true);
      expect(classifyRefusal("zeroex", refusals[0]!).reason).toBe("Unavailable right now — try later");
      expect(zeroex.supportsRoute({chain: "eip155:8453", token: "ETH"}, {chain: "eip155:8453", token: USDC_BASE_ADDR})).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("an Across price: V5 through the proxy slot with the placeholder Bearer, its keyless relayer fee straight from app.across.to", async () => {
    const stopped = new Map<string, number>();
    const now = Math.floor(Date.now() / 1000);
    const token = (chainId: number, address: string) => ({chainId, address, decimals: 6, priceUsd: 0.9997});
    const v5 = {
      expectedFillTimeMs: 3000,
      origin: {token: token(8453, USDC_BASE_ADDR.toLowerCase()), amount: "25000000", amountUsd: "24.99"},
      destination: {token: token(42161, USDC_ARB_ADDR.toLowerCase()), amount: "24965431"},
      fee: {totalFee: {amount: "34569", token: token(42161, USDC_ARB_ADDR.toLowerCase())}, appFee: {amount: "0"}},
      gasEstimates: [],
    };
    const fees = {
      inputToken: {address: USDC_BASE_ADDR, chainId: 8453},
      outputToken: {address: USDC_ARB_ADDR, chainId: 42161},
      spokePoolAddress: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
      destinationSpokePoolAddress: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",
      totalRelayFee: {pct: "352160000000000", total: "8804"},
      outputAmount: "24991196",
      isAmountTooLow: false,
      limits: {minDeposit: "500156", maxDeposit: "685850520819"},
      timestamp: String(now - 200),
      estimatedFillTimeSec: 2,
    };
    const sent: {url: string; init?: RequestInit}[] = [];
    const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push({url, init});
      const body = url.startsWith("https://app.across.to/api/suggested-fees") ? fees : v5;
      return new Response(JSON.stringify(body), {status: 200, headers: {"content-type": "application/json", "x-swap-web-answer": "upstream"}});
    });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(standardRouting(["across"], base as unknown as typeof fetch, stopped));
    try {
      const across = buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true), {across: slot(ACROSS_BASE, () => true)}).find((p) => p.name === "across")!;
      const refusals: string[] = [];
      const quote = await across.getQuote({
        sourceChain: "eip155:8453",
        sourceToken: "USDC",
        destChain: "eip155:42161",
        destToken: USDC_ARB_ADDR,
        amountIn: "25000000",
        slippageBps: 50,
        destAddress: ME,
        refundAddress: ME,
        dry: true,
        onRefusal: (r: string) => void refusals.push(r),
      });
      expect(refusals).toEqual([]);
      expect(quote).toMatchObject({provider: "across", sourceAmount: "25000000", destAmount: "24965431", minDestAmount: "24965431"});
      // Encoded here from the pinned SpokePool: the approval and the call name it, whatever the API said.
      expect(quote?.txRequest).toMatchObject({to: expect.stringMatching(/^0x09aea4b2242abc8bb4bb78d537a67a245a7bec64$/i), approvalAddress: expect.stringMatching(/^0x09aea4b2242abc8bb4bb78d537a67a245a7bec64$/i)});
      const v5Call = sent.find((r) => r.url.startsWith(ACROSS_BASE))!;
      expect(v5Call.url).toBe(`${ACROSS_BASE}/v1/quotes`);
      expect(v5Call.init?.method).toBe("POST");
      const headers = new Headers(v5Call.init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${PROXY_KEY_PLACEHOLDER}`);
      expect(headers.get("content-type")).toBe("application/json");
      const feeCall = sent.find((r) => r.url.startsWith("https://app.across.to/"))!;
      expect(new URL(feeCall.url).pathname).toBe("/api/suggested-fees");
      // The fee quote is keyless and direct: no placeholder, no Authorization, never through cp0x.
      expect(new Headers(feeCall.init?.headers).get("authorization")).toBeNull();
      expect(sent.map((r) => new URL(r.url).host).sort()).toEqual(["app.across.to", new URL(API).host]);
      expect(sent.some((r) => r.url.includes("api.across.to"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("wrapped providers", () => {
  it("wrap is narrowed to native ↔ wrapped pairs", () => {
    const wrap = buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true)).find((p) => p.name === "wrap")!;
    const WETH_BASE = "0x4200000000000000000000000000000000000006";
    const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    expect(wrap.supportsRoute({chain: "eip155:8453", token: "ETH"}, {chain: "eip155:8453", token: WETH_BASE})).toBe(true);
    expect(wrap.supportsRoute({chain: "eip155:8453", token: "ETH"}, {chain: "eip155:8453", token: USDC_BASE})).toBe(false);
    expect(wrap.supportsSameChain).toBe(true);
  });

  it("jupiter keeps its flags behind the quote gap", () => {
    const jup = buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true)).find((p) => p.name === "jupiter")!;
    expect(jup.supportsSameChain).toBe(true);
    expect(jup.enabled()).toBe(true);
  });

  it("jupiter refuses a dry quote to another recipient instead of ranking a route that can't run", async () => {
    const jup = buildProviders(DEFAULT_RUNTIME_CONFIG, stores(true)).find((p) => p.name === "jupiter")!;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const refusals: string[] = [];
    const q = await jup.getQuote({
      sourceChain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      sourceToken: "USDC",
      destChain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      destToken: "So11111111111111111111111111111111111111112",
      amountIn: "5000000",
      destAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      refundAddress: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
      dry: true,
      onRefusal: (r) => refusals.push(r),
    });
    expect(q).toBeNull();
    expect(refusals[0]).toMatch(/recipient must be the signing wallet/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("Omniston (lazy chunk)", () => {
  const USDC_BASE = {chain: "eip155:8453", token: "USDC"};
  const USDC_ARB = {chain: "eip155:42161", token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"};

  it("loads its chunk only when flagged, and only with durable storage; off (uncounted) until it is in", async () => {
    const [p] = buildProviders(withFlags({...ALL_OFF, omniston: true}), stores(true));
    expect(p!.name).toBe("omniston");
    // supportsRoute is synchronous: nothing routes before the chunk is in, and the venue reports itself off meanwhile.
    expect(p!.supportsRoute(USDC_BASE, USDC_ARB)).toBe(false);
    expect(enabledVenues([p!])).toEqual([]);
    await vi.waitFor(() => expect(omni.built).toBe(1));
    expect(p!.supportsRoute(USDC_BASE, USDC_ARB)).toBe(true);
    expect(enabledVenues([p!])).toEqual(["omniston"]);
  });

  it("is never asked for a native coin between networks: its SDK refuses that pair before sending anything", async () => {
    const [p] = buildProviders(withFlags({...ALL_OFF, omniston: true}), stores(true));
    await vi.waitFor(() => expect(omni.built).toBe(1));
    expect(p!.supportsRoute({chain: "eip155:8453", token: "ETH"}, {chain: "eip155:42161", token: zeroAddress})).toBe(false);
    expect(p!.supportsRoute(USDC_BASE, {chain: "eip155:42161", token: zeroAddress})).toBe(false);
    expect(p!.supportsRoute({chain: "eip155:8453", token: "ETH"}, USDC_ARB)).toBe(false);
    // A token missing from the catalog is refused by the SDK the same way ("asset is not in the catalog").
    expect(p!.supportsRoute(USDC_BASE, {chain: "eip155:42161", token: "0x1"})).toBe(false);
    expect(eligibleProviders([p!], {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: USDC_ARB.token})).toEqual(["omniston"]);
  });

  it("without storage it never loads and reports itself disabled", async () => {
    const [p] = buildProviders(withFlags({...ALL_OFF, omniston: true}), stores(false));
    await vi.waitFor(() => expect(p!.enabled()).toBe(false));
    expect(omni.built).toBe(0);
    await expect(p!.getQuote({} as never)).rejects.toThrow(/site storage/);
  });
});

describe("closeProviders", () => {
  it("closes every provider that can, even if one throws", () => {
    const a = {close: vi.fn(() => {
      throw new Error("boom");
    })};
    const b = {close: vi.fn()};
    closeProviders([a, b, {}] as unknown as CrossChainProvider[]);
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
  });
});
