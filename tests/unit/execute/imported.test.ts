/**
 * Executing a swap of a token imported by its address (D39), end to end without a network: the real SDK engine over an
 * in-process venue, the production executeSwap and gate, a fake wallet. The engine gets the contract and the decimals
 * read on-chain (swap2-core 0.14.0 `allowUnlistedTokens`, for that execution only), re-reads the decimals through the
 * account and refuses a mismatch; the gate holds the approval to exactly that contract, the reviewed spender and amount.
 */
import {afterEach, describe, expect, it, vi} from "vitest";
import type {WalletClient} from "viem";
import {base} from "viem/chains";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import type {SwapToken} from "../../../src/contracts/domain";
import type {EvmSourceSigner, ReviewedSwap} from "../../../src/contracts/execution";
import type {EvmChainReads, EvmReads} from "../../../src/execute/accounts/evm";
import {swapErrorText} from "../../../src/execute/errors";
import {engineConfig, executeSwap} from "../../../src/execute/execute";
import {approveData} from "../../../src/execute/gate";

const ME = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ROUTER = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"; // LI.FI Diamond (pinned)
const DATA = "0x4c279d6b00000000000000000000000000000000000000000000000000000000000000aa";
const AMOUNT = 100_000n * 10n ** 18n;

const swapToken = (over: Partial<SwapToken>): SwapToken => ({
  key: `base:${DEGEN.toLowerCase()}`,
  chain: "base",
  caip2: "eip155:8453",
  chainName: "Base",
  family: "evm",
  symbol: "DEGEN",
  catalogSymbol: DEGEN,
  decimals: 18,
  contract: DEGEN,
  gasToken: false,
  amount: (10n ** 24n).toString(),
  balance: "loaded",
  usd: 0,
  owner: ME,
  payMode: "wallet",
  imported: true,
  name: "Degen",
  ...over,
});
const FROM = swapToken({});
const TO = swapToken({key: `base:${USDC_BASE.toLowerCase()}`, symbol: "USDC", catalogSymbol: "USDC", decimals: 6, contract: USDC_BASE, imported: undefined, name: undefined});

const reviewed: ReviewedSwap = {
  provider: "lifi",
  fromChain: "eip155:8453",
  fromContract: DEGEN,
  amountIn: AMOUNT,
  destChain: "eip155:8453",
  destToken: USDC_BASE,
  recipient: ME,
  refundAddress: ME,
  minOut: 69_000_000n,
  slippageBps: 50,
  approvalSpender: ROUTER,
  nativeFee: 0n,
};

/** An in-process LI.FI-shaped venue that records what it was asked; `routeOf` names the route each quote is of (D47). */
function venue(routeOf?: (params: QuoteParams) => string): CrossChainProvider & {asked: QuoteParams[]} {
  const asked: QuoteParams[] = [];
  return {
    name: "lifi",
    asked,
    supportsSameChain: true,
    enabled: () => true,
    supportsRoute: () => true,
    getQuote: async (params): Promise<Quote> => {
      asked.push(params);
      return {
        provider: "lifi",
        ...(routeOf ? {routeId: routeOf(params)} : {}),
        intentId: "lifi:8453:8453",
        depositAddress: "",
        depositMemo: null,
        txRequest: {to: ROUTER, data: DATA, value: "0", chainId: 8453, approvalAddress: ROUTER},
        sourceAmount: params.amountIn,
        destAmount: "70000000",
        minDestAmount: "69650000",
        feeUsd: 0,
        etaSeconds: 5,
        reliability: 0.95,
        validUntilMs: Date.now() + 60_000,
      };
    },
    buildDeposit: async (q: Quote): Promise<UnsignedTx> => ({chain: "eip155:8453", to: q.txRequest!.to!, data: q.txRequest!.data!, value: q.txRequest!.value!, chainId: 8453, approvalAddress: ROUTER}),
    trackIntent: async () => ({state: "pending" as const}),
  };
}

function rig(o: {from?: SwapToken; to?: SwapToken; r?: ReviewedSwap; decimals?: number; routeOf?: (params: QuoteParams) => string} = {}) {
  const sends: {to?: string; data?: string; value?: bigint}[] = [];
  const wallet = {
    getAddresses: async () => [ME],
    getChainId: async () => 8453,
    sendTransaction: async (args: {to?: string; data?: string; value?: bigint}) => {
      sends.push(args);
      return `0x${sends.length.toString(16).padStart(64, "0")}`;
    },
  } as unknown as WalletClient;
  const pub = {getCode: async () => undefined, getBlockNumber: async () => 100n, waitForTransactionReceipt: async () => ({status: "success", blockNumber: 1n})} as unknown as EvmChainReads;
  const tokenInfo = vi.fn(async (token: string) => ({address: token, decimals: o.decimals ?? 18}) as never);
  const reads: EvmReads = {
    getBalance: async () => 10n ** 18n,
    getAllowance: async () => 0n,
    getTokenInfo: tokenInfo,
    quoteSendTransaction: async () => ({fee: 1_000n}),
    simulateTransaction: async () => ({ok: true, gas: 50_000n, returnData: "0x"}),
  };
  const signer: EvmSourceSigner = {family: "evm", wallet, pub: pub as EvmSourceSigner["pub"], chain: base, rpcUrls: [], owner: ME, transport: "injected"};
  const v = venue(o.routeOf);
  const router = new CrossChainRouter([v]);
  const run = () => executeSwap({from: o.from ?? FROM, to: o.to ?? TO, reviewed: o.r ?? reviewed, signer}, {router: () => router, evmReads: () => reads});
  return {run, sends, venue: v, tokenInfo};
}

afterEach(() => vi.restoreAllMocks());

describe("executeSwap with an imported source", () => {
  it("names it by contract with the decimals read on-chain, and signs exactly its approval and the swap", async () => {
    const {run, sends, venue: v, tokenInfo} = rig();
    const res = await run();
    expect(res.id).toMatch(/^awk1\.lifi\./);
    // The engine re-read the decimals through the account (getTokenInfo) and agreed with ours.
    expect(tokenInfo).toHaveBeenCalledWith(DEGEN);
    expect(v.asked.at(-1)).toMatchObject({sourceToken: DEGEN, sourceDecimals: 18, destToken: USDC_BASE, dry: false});
    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({to: DEGEN, data: approveData(ROUTER, AMOUNT), value: 0n});
    expect(sends[1]).toMatchObject({to: ROUTER, data: DATA, value: 0n});
  });

  it("refuses when the chain's decimals differ from the ones read at import — the wallet is never called", async () => {
    const {run, sends} = rig({decimals: 6});
    const e = await run().catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/fromTokenDecimals 18 does not match the token's 6/);
    expect(swapErrorText(e, "ETH")).toMatch(/decimals.*don't match.*nothing was signed/i);
    expect(sends).toHaveLength(0);
  });

  it("refuses an 'import' that is a listed token or another contract than the reviewed one — nothing is asked", async () => {
    const listed = swapToken({contract: USDC_BASE, catalogSymbol: USDC_BASE, decimals: 6});
    const a = rig({from: listed, r: {...reviewed, fromContract: USDC_BASE}});
    await expect(a.run()).rejects.toThrow(/token you pay changed/);
    expect(a.venue.asked).toHaveLength(0);
    const b = rig({r: {...reviewed, fromContract: "0x1111111111111111111111111111111111111111"}});
    await expect(b.run()).rejects.toThrow(/token you pay changed/);
    expect(b.sends).toHaveLength(0);
  });

  it("refuses an approval to another spender than the reviewed one, as for any token", async () => {
    const {run, sends} = rig({r: {...reviewed, approvalSpender: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"}});
    await expect(run()).rejects.toThrow(/spender/);
    expect(sends).toHaveLength(0);
  });
});

describe("executeSwap into an imported destination", () => {
  it("asks the venue for its contract", async () => {
    const from = swapToken({key: `base:${USDC_BASE.toLowerCase()}`, symbol: "USDC", catalogSymbol: "USDC", decimals: 6, contract: USDC_BASE, imported: undefined, name: undefined});
    const {run, venue: v, sends} = rig({from, to: FROM, r: {...reviewed, fromContract: USDC_BASE, amountIn: 100_000_000n, destToken: DEGEN, minOut: 1n}});
    await run();
    expect(v.asked.at(-1)).toMatchObject({sourceToken: "USDC", destToken: DEGEN});
    expect("sourceDecimals" in v.asked.at(-1)!).toBe(false);
    expect(sends).toHaveLength(2);
  });
});

describe("a venue's reviewed route (D47)", () => {
  it("every quote of the execution asks the reviewed routeId, and the swap goes out", async () => {
    const {run, sends, venue: v} = rig({r: {...reviewed, routeId: "standard"}, routeOf: (p) => p.routeId ?? "fast"});
    await run();
    expect(v.asked.length).toBeGreaterThan(0);
    expect(v.asked.every((p) => p.routeId === "standard")).toBe(true);
    expect(sends).toHaveLength(2);
  });
  it("a quote of another route is refused before anything is sent (the router already; the gate behind it, gate.test)", async () => {
    const {run, sends} = rig({r: {...reviewed, routeId: "standard"}, routeOf: () => "fast"});
    await expect(run()).rejects.toThrow(/no route available|route moved/);
    expect(sends).toHaveLength(0);
  });
});

describe("engineConfig", () => {
  const base0 = {fromChain: "eip155:8453", router: new CrossChainRouter([]), reviewExecution: () => {}};
  it("allows unlisted tokens only for an execution that has one", () => {
    expect("allowUnlistedTokens" in engineConfig(base0)).toBe(false);
    expect(engineConfig({...base0, unlisted: true}).allowUnlistedTokens).toBe(true);
    expect(Object.keys(engineConfig({...base0, unlisted: true}))).not.toContain("accountChain");
  });
  it("carries the reviewed routeId of a venue with several routes (D47), and none otherwise", () => {
    expect(engineConfig({...base0, routeId: "standard"}).routeId).toBe("standard");
    expect("routeId" in engineConfig(base0)).toBe(false);
  });
});
