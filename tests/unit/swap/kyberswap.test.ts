// KyberSwap (D52) as this page builds it: Standard's slot (cp0x's proxy, placeholder key) and the module's own checks
// running here on what comes back — a tampered build (another router, receiver, minimum or a fee receiver) is refused
// before anything is signed. Fake network: the routes / build answers and the RPC are stubbed.
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {encodeFunctionData} from "viem";
import type {CrossChainProvider, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {KYBER_EXECUTOR, KYBER_NATIVE, KYBER_ROUTER_ABI, KYBER_ROUTER_V2} from "@anywalletkit/protocol-swap2-kyberswap/router";
import {DEFAULT_RUNTIME_CONFIG} from "../../../src/config";
import {buildProviders, PROXY_KEY_PLACEHOLDER} from "../../../src/swap/providers";
import {orderSpender} from "../../../src/swap/providerMeta";
import {toRouteView} from "../../../src/swap/routes";
import {APPROVE_GAS, routeGasUnits} from "../../../src/swap/gas";
import {createProviderStores} from "../../../src/swap/stores";

const SLOT = "https://api.test/api/v2/swap-web/venue/kyberswap";
const ME = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const EVIL = "0x000000000000000000000000000000000000dEaD";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ZERO = "0x0000000000000000000000000000000000000000";
const AMOUNT = 1_000_000_000_000_000n; // 0.001 ETH
const OUT = 1_694_107n;

const SUMMARY = {
  tokenIn: KYBER_NATIVE.toLowerCase(),
  amountIn: AMOUNT.toString(),
  amountInUsd: "1.69",
  tokenOut: USDC.toLowerCase(),
  amountOut: OUT.toString(),
  amountOutUsd: "1.686",
  gas: "537581",
  extraFee: {feeAmount: "", chargeFeeBy: "", isInBps: false, feeReceiver: ""},
  route: [[{pool: "0xabc", tokenIn: KYBER_NATIVE.toLowerCase(), tokenOut: USDC.toLowerCase(), swapAmount: AMOUNT.toString(), amountOut: OUT.toString(), exchange: "uniswap-v3"}]],
  routerAddress: KYBER_ROUTER_V2,
  routeID: "r1",
  checksum: "1",
  timestamp: 1795682876,
};

interface Build {
  router?: string;
  receiver?: string;
  min?: bigint;
  feeReceivers?: readonly string[];
  feeAmounts?: readonly bigint[];
}

/** The router call KyberSwap's build would encode for this swap, with one field tampered at a time. */
function calldata(b: Build, minOk: bigint): string {
  return encodeFunctionData({
    abi: KYBER_ROUTER_ABI,
    functionName: "swap",
    args: [
      {
        callTarget: KYBER_EXECUTOR,
        approveTarget: ZERO,
        targetData: "0x1234",
        desc: {
          srcToken: KYBER_NATIVE,
          dstToken: USDC,
          srcReceivers: [],
          srcAmounts: [],
          feeReceivers: [...(b.feeReceivers ?? [])] as `0x${string}`[],
          feeAmounts: [...(b.feeAmounts ?? [])],
          dstReceiver: (b.receiver ?? ME) as `0x${string}`,
          amount: AMOUNT,
          minReturnAmount: b.min ?? minOk,
          flags: 0x200n,
          permit: "0x",
        },
        clientData: "0x",
      },
    ],
  });
}

let build: Build = {};
let routesStatus = 200;
const calls: {url: string; headers: Record<string, string>}[] = [];

beforeEach(() => {
  build = {};
  routesStatus = 200;
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({url, headers: {...((init?.headers as Record<string, string>) ?? {})}});
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json"}});
      if (url.includes("/api/v1/routes")) {
        if (routesStatus === 429) return json({code: 429, message: "too many requests"}, 429);
        return json({code: 0, data: {routeSummary: SUMMARY, routerAddress: KYBER_ROUTER_V2}});
      }
      if (url.includes("/api/v1/route/build")) {
        const sent = JSON.parse(String(init?.body)) as {slippageTolerance: number};
        const bps = sent.slippageTolerance;
        const minOk = (OUT * BigInt(10_000 - bps)) / 10_000n - 1n;
        return json({
          code: 0,
          data: {amountIn: AMOUNT.toString(), amountOut: OUT.toString(), routerAddress: build.router ?? KYBER_ROUTER_V2, transactionValue: AMOUNT.toString(), data: calldata(build, minOk)},
        });
      }
      // The page's RPC: the swap's simulation (eth_call with a balance override) answers.
      return json({jsonrpc: "2.0", id: 1, result: "0x"});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function kyber(): CrossChainProvider {
  const providers = buildProviders({...DEFAULT_RUNTIME_CONFIG, providers: {...Object.fromEntries(Object.keys(DEFAULT_RUNTIME_CONFIG.providers).map((k) => [k, false])), kyberswap: true} as never}, createProviderStores(), {kyberswap: {base: SLOT, live: () => true}});
  expect(providers.map((p) => p.name)).toEqual(["kyberswap"]);
  return providers[0]!;
}

const params = (over: Partial<QuoteParams> = {}): QuoteParams =>
  ({
    sourceChain: "eip155:8453",
    sourceToken: "ETH",
    destChain: "eip155:8453",
    destToken: USDC,
    amountIn: AMOUNT.toString(),
    destAddress: ME,
    refundAddress: ME,
    sender: ME,
    slippageBps: 50,
    dry: false,
    ...over,
  }) as QuoteParams;

describe("KyberSwap through cp0x's slot (D52)", () => {
  it("asks the slot with the placeholder key only (never x-client-id); a live quote is the pinned router's swap, simulated", async () => {
    const refusals: string[] = [];
    const q = await kyber().getQuote(params({onRefusal: (r) => refusals.push(r)}));
    expect(refusals).toEqual([]);
    expect(q?.txRequest?.to).toBe(KYBER_ROUTER_V2);
    expect(q?.providerData?.simulated).toBe("swap");
    expect(BigInt(q!.minDestAmount)).toBeLessThan(OUT);
    const api = calls.filter((c) => c.url.startsWith(SLOT));
    expect(api.map((c) => c.url.slice(SLOT.length).split("?")[0])).toEqual(["/base/api/v1/routes", "/base/api/v1/route/build"]);
    for (const c of api) {
      expect(c.headers["x-api-key"]).toBe(PROXY_KEY_PLACEHOLDER);
      expect(c.headers["x-client-id"]).toBeUndefined();
    }
  });

  it.each([
    ["another router", {router: EVIL}, /targets 0x0+dEaD, not the KyberSwap router/],
    ["another receiver", {receiver: EVIL}, /calldata pays 0x0+dEaD/],
    ["a lower minimum", {min: 1n}, /guarantees 1, under the quoted minimum/],
    ["a fee receiver", {feeReceivers: [EVIL], feeAmounts: [1000n]}, /pays a fee receiver/],
  ] as const)("refuses a build with %s before anything is signed", async (_what, tamper, why) => {
    build = tamper;
    const refusals: string[] = [];
    expect(await kyber().getQuote(params({onRefusal: (r) => refusals.push(r)}))).toBeNull();
    expect(refusals.join(" ")).toMatch(why);
  });

  it("a dry quote is the route alone, with KyberSwap's own price impact for the value warning", async () => {
    const q = await kyber().getQuote(params({dry: true, destAddress: "", sender: undefined, refundAddress: undefined}));
    expect(q?.txRequest).toBeUndefined();
    expect(q?.destAmount).toBe(OUT.toString());
    expect(q?.providerData?.priceImpactBps).toBe("24");
    expect(calls.some((c) => c.url.includes("route/build"))).toBe(false);
  });

  it("a 429 is a quiet rate_limited refusal, no throw", async () => {
    routesStatus = 429;
    const why: unknown[] = [];
    expect(await kyber().getQuote(params({dry: true, onRefusal: (_r, info) => why.push(info)}))).toBeNull();
    expect(JSON.stringify(why)).toContain("rate_limited");
  });

  it("is never asked between networks or off its chains, and not for native ⇄ wrapped", () => {
    const p = kyber();
    expect(p.supportsChainPair?.("eip155:8453", "eip155:42161")).toBe(false);
    expect(p.supportsRoute({chain: "eip155:8453", token: "ETH"}, {chain: "eip155:42161", token: USDC})).toBe(false);
    expect(p.supportsChain?.("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBe(false);
    expect(p.supportsRoute({chain: "eip155:8453", token: "ETH"}, {chain: "eip155:8453", token: "WETH"})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:8453", token: "ETH"}, {chain: "eip155:8453", token: USDC})).toBe(true);
  });

  it("a token sale's dry quote is reviewed with the router as its spender, so the live plan's exact approval is the reviewed one", () => {
    // The dry quote carries no transaction: the review must still name the approval (it read "Not needed", and the
    // gate then refused the live plan's approval as one the user didn't review — Base USDC → ETH, 2026-11-26).
    const dry = {provider: "kyberswap", sourceAmount: "5000000", destAmount: "2944000000000000", minDestAmount: "2940000000000000", feeUsd: 0, providerData: {approvalAddress: KYBER_ROUTER_V2}} as never;
    expect(toRouteView(dry, {chain: "eip155:8453", isToken: true}).approvalSpender).toBe(KYBER_ROUTER_V2);
    expect(toRouteView(dry, {chain: "eip155:8453", isToken: false}).approvalSpender).toBeNull();
    expect(orderSpender("kyberswap", "eip155:143")).toBe(KYBER_ROUTER_V2);
    expect(orderSpender("kyberswap", "eip155:250")).toBeNull();
    expect(orderSpender("kyberswap", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBeNull();
    // The route row's gas counts that approval too.
    expect(routeGasUnits(dry, true) - routeGasUnits({...(dry as object), providerData: {}}, true)).toBe(APPROVE_GAS);
  });
});
