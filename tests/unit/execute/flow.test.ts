/**
 * The execution security model end to end, without a network (port of mobile lib/swap/flow.test.ts): the real SDK
 * engine (RouterSwap2Protocol) over an in-process venue, the production executeSwap, and a fake viem WalletClient
 * that records every request — the assertion that matters is how often, and with what, the WALLET was called.
 */
import {afterEach, describe, expect, it, vi} from "vitest";
import type {WalletClient} from "viem";
import {base} from "viem/chains";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import {Swap2InFlightError, Swap2InsufficientGasError} from "@anywalletkit/protocol-swap2-core/errors";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import type {CrossChainProvider, Quote, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import type {SwapToken} from "../../../src/contracts/domain";
import type {EvmSourceSigner, ReviewedSwap} from "../../../src/contracts/execution";
import {evmEngineAccount, type EvmChainReads, type EvmReads} from "../../../src/execute/accounts/evm";
import {gateAccount} from "../../../src/execute/accounts/gated";
import {WALLET_DECLINED_TEXT, swapErrorText} from "../../../src/execute/errors";
import {engineConfig, executeSwap, nativeFeeCeiling, type ExecuteDeps} from "../../../src/execute/execute";
import {approveData, createSwapGate, planWrites, SwapGateRefusal, SwapReviewMismatch} from "../../../src/execute/gate";

const ME = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const OTHER = "0x1111111111111111111111111111111111111111";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** The engine names the source token by the catalog's (lowercase) contract. */
const USDC_LC = USDC_BASE.toLowerCase();
const WETH_BASE = "0x4200000000000000000000000000000000000006";
const ROUTER = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"; // LI.FI Diamond (pinned)
const EVIL = "0x000000000000000000000000000000000000dEaD";
const DATA = "0x4c279d6b00000000000000000000000000000000000000000000000000000000000000aa";
const DATA2 = "0x4c279d6b00000000000000000000000000000000000000000000000000000000000000ab";
const AMOUNT = 100_000_000n;

const token = (over: Partial<SwapToken>): SwapToken => ({
  key: "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  chain: "base",
  caip2: "eip155:8453",
  chainName: "Base",
  family: "evm",
  symbol: "USDC",
  catalogSymbol: "USDC",
  decimals: 6,
  contract: USDC_BASE,
  gasToken: false,
  amount: "1000000000",
  balance: "loaded",
  usd: 1000,
  owner: ME,
  payMode: "wallet",
  ...over,
});
const FROM = token({});
const TO = token({key: "base:0x4200000000000000000000000000000000000006", symbol: "WETH", catalogSymbol: "WETH", decimals: 18, contract: WETH_BASE});

const reviewed: ReviewedSwap = {
  provider: "lifi",
  fromChain: "eip155:8453",
  fromContract: USDC_BASE,
  amountIn: AMOUNT,
  destChain: "eip155:8453",
  destToken: WETH_BASE,
  recipient: ME,
  refundAddress: ME,
  minOut: 39_600_000_000_000_000n,
  slippageBps: 50,
  approvalSpender: ROUTER,
  nativeFee: 0n,
};

/** An in-process LI.FI-shaped venue; `quotes` lets a test change what each successive quote says. */
function venue(quotes: ((n: number) => Partial<Quote>) | Partial<Quote> = {}): CrossChainProvider & {asked: number} {
  let asked = 0;
  const quote = (): Quote => {
    asked++;
    const over = typeof quotes === "function" ? quotes(asked) : quotes;
    return {
      provider: "lifi",
      intentId: "lifi:8453:8453",
      depositAddress: "",
      depositMemo: null,
      txRequest: {to: ROUTER, data: DATA, value: "0", chainId: 8453, approvalAddress: ROUTER},
      sourceAmount: AMOUNT.toString(),
      destAmount: "40000000000000000",
      minDestAmount: "39800000000000000",
      feeUsd: 0.05,
      etaSeconds: 5,
      reliability: 0.95,
      validUntilMs: Date.now() + 60_000,
      ...over,
    };
  };
  const v = {
    name: "lifi",
    supportsSameChain: true,
    enabled: () => true,
    supportsRoute: () => true,
    getQuote: async () => quote(),
    buildDeposit: async (q: Quote): Promise<UnsignedTx> => ({
      chain: "eip155:8453",
      to: q.txRequest!.to!,
      data: q.txRequest!.data!,
      value: q.txRequest!.value!,
      chainId: 8453,
      approvalAddress: q.txRequest!.approvalAddress!,
    }),
    trackIntent: async () => ({state: "pending" as const}),
    get asked() {
      return asked;
    },
  };
  return v;
}

interface WalletCall {
  method: "sendTransaction" | "signTypedData";
  args: {to?: string; data?: string; value?: bigint; account?: string};
}

/** A viem WalletClient stand-in that records every write it is asked for. */
function fakeWallet(opts: {onSend?: (n: number, args: WalletCall["args"]) => void | Promise<void>; chainIds?: number[]} = {}) {
  const calls: WalletCall[] = [];
  const state = {address: ME, chainId: 8453, chainReads: 0};
  const wallet = {
    getAddresses: async () => [state.address],
    getChainId: async () => {
      const scripted = opts.chainIds?.[state.chainReads];
      state.chainReads++;
      return scripted ?? state.chainId;
    },
    sendTransaction: async (args: WalletCall["args"]) => {
      calls.push({method: "sendTransaction", args});
      await opts.onSend?.(calls.length, args);
      return `0x${calls.length.toString(16).padStart(64, "0")}`;
    },
    signTypedData: async (args: WalletCall["args"]) => {
      calls.push({method: "signTypedData", args});
      return "0xsig";
    },
  };
  return {wallet: wallet as unknown as WalletClient, calls, state};
}

function fakeReads(over: Partial<EvmReads> = {}): EvmReads {
  return {
    getBalance: async () => 10n ** 18n,
    getAllowance: async () => 0n,
    getTokenInfo: async () => ({decimals: 6}) as never,
    quoteSendTransaction: async () => ({fee: 1_000n}),
    simulateTransaction: async () => ({ok: true, gas: 50_000n, returnData: "0x"}),
    ...over,
  };
}

function fakePub(over: Partial<{code: string | undefined; receiptDelayMs: number}> = {}): EvmChainReads {
  const pub = {
    getCode: async () => over.code,
    getBlockNumber: async () => 100n,
    waitForTransactionReceipt: async () => {
      if (over.receiptDelayMs) await new Promise((r) => setTimeout(r, over.receiptDelayMs));
      return {status: "success", blockNumber: 1n};
    },
  };
  return pub as unknown as EvmChainReads;
}

function rig(
  provider: CrossChainProvider,
  o: {r?: ReviewedSwap; wallet?: ReturnType<typeof fakeWallet>; reads?: EvmReads; pub?: EvmChainReads; plans?: Swap2ExecutionPlan[]} = {},
) {
  const w = o.wallet ?? fakeWallet();
  const signer: EvmSourceSigner = {
    family: "evm",
    wallet: w.wallet,
    pub: (o.pub ?? fakePub()) as EvmSourceSigner["pub"],
    chain: base,
    rpcUrls: [],
    owner: ME,
    transport: "injected",
  };
  const router = new CrossChainRouter([provider]);
  const deps: ExecuteDeps = {router: () => router, evmReads: () => o.reads ?? fakeReads(), evmRecheckMs: 1};
  const phases: string[] = [];
  const run = () => executeSwap({from: FROM, to: TO, reviewed: o.r ?? reviewed, signer, onPhase: (p) => phases.push(p)}, deps);
  return {run, calls: w.calls, wallet: w, phases, signer};
}

const sends = (calls: WalletCall[]) => calls.filter((c) => c.method === "sendTransaction").map((c) => c.args);

afterEach(() => vi.restoreAllMocks());

describe("executeSwap through the gate (real engine, fake wallet)", () => {
  it("signs exactly the reviewed approval and swap call, in that order", async () => {
    const {run, calls, phases} = rig(venue());
    const res = await run();
    expect(res.id).toMatch(/^awk1\.lifi\./);
    expect(res.hash).toMatch(/^0x0+2$/);
    expect(res.depositTo).toBe(ROUTER);
    expect(sends(calls)).toHaveLength(2);
    expect(sends(calls)[0]).toMatchObject({to: USDC_LC, data: approveData(ROUTER, AMOUNT), value: 0n, account: ME});
    expect(sends(calls)[1]).toMatchObject({to: ROUTER, data: DATA, value: 0n, account: ME});
    expect(phases).toEqual(["approving", "signing", "broadcast"]);
  });

  it("skips the approval when the allowance is already exact", async () => {
    const {run, calls} = rig(venue(), {reads: fakeReads({getAllowance: async () => AMOUNT})});
    await run();
    expect(sends(calls)).toEqual([expect.objectContaining({to: ROUTER, data: DATA})]);
  });

  it("refuses a live route below the reviewed minimum — the wallet is never called", async () => {
    const {run, calls} = rig(venue(), {r: {...reviewed, minOut: 39_900_000_000_000_000n}});
    await expect(run()).rejects.toThrow(/no route available/);
    expect(calls).toHaveLength(0);
  });

  it("refuses an approval for a spender the review didn't name — the wallet is never called", async () => {
    const {run, calls} = rig(venue(), {r: {...reviewed, approvalSpender: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"}});
    const e = await run().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SwapReviewMismatch);
    expect((e as Error).message).toMatch(/spender/);
    expect(swapErrorText(e, "ETH")).toMatch(/isn't the one you reviewed.*nothing was signed/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a call to a contract outside LI.FI's pins even when the review named it — the wallet is never called", async () => {
    const evil = venue({txRequest: {to: EVIL, data: DATA, value: "0", chainId: 8453, approvalAddress: EVIL}});
    const {run, calls} = rig(evil, {r: {...reviewed, approvalSpender: EVIL}});
    await expect(run()).rejects.toThrow(/doesn't trust/);
    expect(calls).toHaveLength(0);
  });

  it("refuses before any request when the review, the tokens and the signer don't describe one swap", async () => {
    const cases: [Partial<ReviewedSwap>, RegExp][] = [
      [{recipient: "0x123"}, /recipient isn't a Base address/],
      [{refundAddress: OTHER}, /isn't the reviewed one/],
      [{fromContract: WETH_BASE}, /token you pay changed/],
      [{destToken: USDC_BASE}, /networks or the token changed/],
      [{minOut: 0n}, /no minimum/],
      [{fromChain: "eip155:1"}, /networks or the token changed/],
    ];
    for (const [over, why] of cases) {
      const {run, calls} = rig(venue(), {r: {...reviewed, ...over}});
      await expect(run(), Object.keys(over).join()).rejects.toThrow(why);
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses a catalog symbol that resolves to another token than the reviewed one", async () => {
    const w = fakeWallet();
    const signer: EvmSourceSigner = {family: "evm", wallet: w.wallet, pub: fakePub() as EvmSourceSigner["pub"], chain: base, rpcUrls: [], owner: ME, transport: "injected"};
    const lying = {...FROM, catalogSymbol: "WETH"};
    await expect(executeSwap({from: lying, to: TO, reviewed, signer}, {router: () => new CrossChainRouter([venue()]), evmReads: () => fakeReads()})).rejects.toThrow(/token you pay changed/);
    expect(w.calls).toHaveLength(0);
  });

  it("insufficient gas: nothing is sent", async () => {
    const {run, calls} = rig(venue(), {reads: fakeReads({getBalance: async () => 0n})});
    await expect(run()).rejects.toBeInstanceOf(Swap2InsufficientGasError);
    expect(calls).toHaveLength(0);
  });

  it("a rejected swap prompt revokes the allowance this run granted", async () => {
    const w = fakeWallet({
      onSend: (n) => {
        if (n === 2) throw Object.assign(new Error("User rejected the request."), {code: 4001});
      },
    });
    const {run, calls} = rig(venue(), {wallet: w});
    const e = await run().catch((x: unknown) => x);
    expect(swapErrorText(e, "ETH")).toBe(WALLET_DECLINED_TEXT);
    expect(sends(calls)).toHaveLength(3);
    expect(sends(calls)[2]).toMatchObject({to: USDC_LC, data: approveData(ROUTER, 0n), value: 0n});
  });

  it("a rejected approval leaves nothing to revoke: no second prompt", async () => {
    const w = fakeWallet({
      onSend: (n) => {
        if (n === 1) throw Object.assign(new Error("User rejected the request."), {code: 4001});
      },
    });
    const {run, calls} = rig(venue(), {wallet: w});
    const e = await run().catch((x: unknown) => x);
    expect(swapErrorText(e, "ETH")).toBe(WALLET_DECLINED_TEXT);
    expect(sends(calls)).toHaveLength(1);
  });

  it("the wallet switching accounts mid-flow stops the swap before its prompt", async () => {
    const w = fakeWallet({
      onSend: (n) => {
        if (n === 1) w.state.address = OTHER;
      },
    });
    const {run, calls} = rig(venue(), {wallet: w});
    await expect(run()).rejects.toThrow(/switched accounts/);
    expect(sends(calls)).toHaveLength(1); // the approval only — the swap and the revoke never reached the wallet
  });

  it("the wallet switching networks mid-flow stops the swap before its prompt", async () => {
    const w = fakeWallet({
      onSend: (n) => {
        if (n === 1) w.state.chainId = 1;
      },
    });
    const {run, calls} = rig(venue(), {wallet: w});
    await expect(run()).rejects.toThrow(/switched networks/);
    expect(sends(calls)).toHaveLength(1);
  });

  it("refuses at Confirm when the wallet shows another account", async () => {
    const w = fakeWallet();
    w.state.address = OTHER;
    const {run, calls} = rig(venue(), {wallet: w});
    await expect(run()).rejects.toThrow(/switched accounts/);
    expect(calls).toHaveLength(0);
  });

  it("the engine asks the LIVE wallet chain (no accountChain short-circuit): a chain change after Confirm is refused", async () => {
    // Confirm's own check sees 8453; the engine's account-chain check (the next read) sees 1.
    const w = fakeWallet({chainIds: [8453, 1]});
    const {run, calls} = rig(venue(), {wallet: w});
    await expect(run()).rejects.toThrow(/account is bound to 1, but fromChain is eip155:8453/);
    expect(calls).toHaveLength(0);
  });

  it("the engine config never sets accountChain / skipAccountChainCheck; its one fee hook is nativeFeeCeiling", () => {
    const cfg = engineConfig({fromChain: "eip155:8453", router: new CrossChainRouter([venue()]), reviewExecution: () => {}});
    expect(Object.keys(cfg).sort()).toEqual(["fromChain", "nativeFeeCeiling", "onExecutionPhase", "reviewExecution", "router"]);
    expect(cfg.nativeFeeCeiling).toBe(nativeFeeCeiling);
    expect(cfg).not.toHaveProperty("accountChain");
    expect(cfg).not.toHaveProperty("skipAccountChainCheck");
  });

  it("nativeFeeCeiling lets Stargate pay its LayerZero fee from Avalanche and Polygon, where it sits above or at the cap", () => {
    const ctx = (fromChain: string, provider = "stargate") => ({provider, intentId: "stargate:1:30106:30110:1:taxi:a:b:1:1:0", fromChain, destChain: "eip155:42161", nativeFee: 1n, defaultCap: 1n, maxCeiling: 1n});
    expect(nativeFeeCeiling(ctx("eip155:43114"))).toBe(5n * 10n ** 17n); // 0.5 AVAX (cap 0.1; 0.231 charged 2026-11-17)
    expect(nativeFeeCeiling(ctx("eip155:137"))).toBe(40n * 10n ** 18n); // 40 POL (cap 20; 19.4 charged)
    // Every other Stargate network keeps its cap, and another venue on those networks too.
    for (const c of ["eip155:1", "eip155:42161", "eip155:8453", "eip155:56", "eip155:5000", "eip155:14"]) expect(nativeFeeCeiling(ctx(c)), c).toBeUndefined();
    expect(nativeFeeCeiling(ctx("eip155:43114", "lifi"))).toBeUndefined();
  });
  it("nativeFeeCeiling raises the cap for USDT0's Legacy Mesh into Tron from Ethereum or Arbitrum only", () => {
    const ctx = (o: Partial<Parameters<typeof nativeFeeCeiling>[0]> = {}) => ({
      provider: "usdt0",
      intentId: "usdt0-mesh:30101:30420",
      fromChain: "eip155:1",
      destChain: "tron:728126428",
      nativeFee: 6_676_000_000_000_000n,
      defaultCap: 5n * 10n ** 15n,
      maxCeiling: 10n ** 17n,
      ...o,
    });
    expect(nativeFeeCeiling(ctx())).toBe(10n ** 16n);
    expect(nativeFeeCeiling(ctx({fromChain: "eip155:42161", intentId: "usdt0-mesh:30110:30420"}))).toBe(10n ** 16n);
    // Through a swap2 server the intent id ends in ~<token>.
    expect(nativeFeeCeiling(ctx({intentId: "usdt0-mesh:30101:30420~abc"}))).toBe(10n ** 16n);
    // Every other route keeps the chain's cap: another source, TON, another venue, another intent, a look-alike.
    expect(nativeFeeCeiling(ctx({fromChain: "eip155:42220"}))).toBeUndefined();
    expect(nativeFeeCeiling(ctx({fromChain: "eip155:8453"}))).toBeUndefined();
    expect(nativeFeeCeiling(ctx({fromChain: "constructor"}))).toBeUndefined();
    expect(nativeFeeCeiling(ctx({destChain: "ton:-239", intentId: "usdt0-mesh:30101:30343"}))).toBeUndefined();
    expect(nativeFeeCeiling(ctx({provider: "lifi"}))).toBeUndefined();
    expect(nativeFeeCeiling(ctx({intentId: "usdt0:30101:30110"}))).toBeUndefined();
    expect(nativeFeeCeiling(ctx({intentId: "usdt0-mesh:30101:304201"}))).toBeUndefined();
    // Within the engine's hard maximum (20× the 0.005 ETH default).
    expect(nativeFeeCeiling(ctx())! <= ctx().maxCeiling).toBe(true);
  });

  it("refuses a smart-contract account; an EIP-7702 delegated EOA is fine", async () => {
    const sca = rig(venue(), {pub: fakePub({code: "0x6080604052"})});
    await expect(sca.run()).rejects.toThrow(/Smart-contract wallets/);
    expect(sca.calls).toHaveLength(0);
    const eoa7702 = rig(venue(), {pub: fakePub({code: `0xef0100${"ab".repeat(20)}`})});
    await expect(eoa7702.run()).resolves.toMatchObject({id: expect.stringMatching(/^awk1\.lifi\./)});
  });

  it("refuses a wallet client that appends data to calldata", async () => {
    const w = fakeWallet();
    Object.assign(w.wallet, {dataSuffix: "0xdeadbeef"});
    const {run, calls} = rig(venue(), {wallet: w});
    await expect(run()).rejects.toThrow(/appends data/);
    expect(calls).toHaveLength(0);
  });

  it("a swap call that reverts in eth_call never reaches the wallet (the approval is revoked)", async () => {
    let asked = 0;
    const reads = fakeReads({simulateTransaction: async (tx) => (tx.data === DATA ? (asked++, {ok: false, reason: "STF"}) : {ok: true, gas: 1n, returnData: "0x"})});
    const {run, calls} = rig(venue(), {reads});
    await expect(run()).rejects.toThrow(/would fail on-chain/);
    expect(sends(calls).map((a) => a.data)).toEqual([approveData(ROUTER, AMOUNT), approveData(ROUTER, 0n)]);
    // Right after its approval was mined: asked again twice (a lagging RPC), then it stands.
    expect(asked).toBe(3);
  });

  it("a swap call that reverts only until the RPC sees the approval is sent, not refused and revoked", async () => {
    let asked = 0;
    const reads = fakeReads({
      simulateTransaction: async (tx) => (tx.data === DATA && asked++ === 0 ? {ok: false, reason: "TRANSFER_FROM_FAILED"} : {ok: true, gas: 1n, returnData: "0x"}),
    });
    const {run, calls} = rig(venue(), {reads});
    await run();
    expect(sends(calls).map((a) => a.data)).toEqual([approveData(ROUTER, AMOUNT), DATA]);
  });

  it("the engine's dry run that reverts just after the approval is asked again, then the swap goes", async () => {
    // The engine estimates the call itself (ownGasEstimate, as for a Permit2 swap): before the approval (the gas check,
    // expected to revert) and after it (the dry run, which a lagging RPC fails once).
    const estimates: number[] = [];
    const reads = fakeReads({
      quoteSendTransaction: async (tx) => {
        if (tx.data !== DATA) return {fee: 1_000n};
        estimates.push(estimates.length);
        if (estimates.length <= 2) throw new Error("Execution reverted for an unknown reason.");
        return {fee: 1_000n};
      },
    });
    const {run, calls} = rig(Object.assign(venue(), {ownGasEstimate: true}), {reads});
    await run();
    expect(estimates).toHaveLength(3);
    expect(sends(calls).map((a) => a.data)).toEqual([approveData(ROUTER, AMOUNT), DATA]);
  });

  it("without an approval mined first a revert is not asked again", async () => {
    let asked = 0;
    const reads = fakeReads({getAllowance: async () => AMOUNT, simulateTransaction: async () => (asked++, {ok: false, reason: "STF"})});
    const {run, calls} = rig(venue(), {reads});
    await expect(run()).rejects.toThrow(/would fail on-chain/);
    expect(asked).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("a second Confirm while the first runs is refused (same payer, same chain)", async () => {
    let release!: () => void;
    const w = fakeWallet({onSend: (n) => (n === 1 ? new Promise<void>((r) => (release = r)) : undefined)});
    const {run} = rig(venue(), {wallet: w});
    const first = run();
    await vi.waitFor(() => expect(w.calls).toHaveLength(1));
    await expect(run()).rejects.toBeInstanceOf(Swap2InFlightError);
    release();
    await expect(first).resolves.toMatchObject({id: expect.stringMatching(/^awk1\./)});
  });

  describe("quote expiry after the approval (engine re-quote, swap2-core 0.10.3)", () => {
    const slow = () => fakePub({receiptDelayMs: 150});
    const expiring = (later: Partial<Quote>) => venue((n) => (n === 1 ? {validUntilMs: Date.now() + 100} : later));

    it("an identical re-quote needs no second review: the armed call is spent", async () => {
      const v = expiring({});
      const {run, calls, phases} = rig(v, {pub: slow()});
      await run();
      expect(phases).toContain("requoting");
      expect(v.asked).toBe(2);
      expect(sends(calls).map((a) => a.data)).toEqual([approveData(ROUTER, AMOUNT), DATA]);
    });

    it("a changed re-quote is reviewed again (requoted) and its new call armed", async () => {
      const {run, calls} = rig(expiring({txRequest: {to: ROUTER, data: DATA2, value: "0", chainId: 8453, approvalAddress: ROUTER}}), {pub: slow()});
      await run();
      expect(sends(calls).map((a) => a.data)).toEqual([approveData(ROUTER, AMOUNT), DATA2]);
    });

    it("a re-quote calling an untrusted contract is refused and the allowance revoked", async () => {
      const {run, calls} = rig(expiring({txRequest: {to: EVIL, data: DATA, value: "0", chainId: 8453, approvalAddress: ROUTER}}), {pub: slow()});
      await expect(run()).rejects.toThrow(/doesn't trust/);
      expect(sends(calls).map((a) => [a.to, a.data])).toEqual([
        [USDC_LC, approveData(ROUTER, AMOUNT)],
        [USDC_LC, approveData(ROUTER, 0n)],
      ]);
    });

    it("a re-quote below the reviewed floor is refused and the allowance revoked", async () => {
      const {run, calls} = rig(expiring({minDestAmount: "39500000000000000"}), {pub: slow()});
      await expect(run()).rejects.toThrow();
      expect(sends(calls).map((a) => a.data)).toEqual([approveData(ROUTER, AMOUNT), approveData(ROUTER, 0n)]);
    });

    it("a re-quote that moved the spender: the engine revokes and aborts", async () => {
      const {run, calls} = rig(expiring({txRequest: {to: ROUTER, data: DATA, value: "0", chainId: 8453, approvalAddress: EVIL}}), {pub: slow()});
      await expect(run()).rejects.toThrow(/moved the spender/);
      expect(sends(calls).map((a) => a.data)).toEqual([approveData(ROUTER, AMOUNT), approveData(ROUTER, 0n)]);
    });
  });
});

describe("the gated EVM account on its own", () => {
  const plan: Swap2ExecutionPlan = {
    provider: "lifi",
    fromChain: "eip155:8453",
    destChain: "eip155:8453",
    destToken: WETH_BASE,
    recipient: ME,
    refundAddress: ME,
    sourceAmount: AMOUNT,
    destAmount: 1n,
    minDestAmount: 1n,
    feeUsd: 0,
    etaSeconds: 1,
    validUntilMs: 0,
    approvals: [{token: USDC_BASE, spender: ROUTER, amount: AMOUNT}],
    source: {kind: "call", to: ROUTER, data: DATA, value: 0n},
  };

  function gated(wallet = fakeWallet()) {
    const signer: EvmSourceSigner = {family: "evm", wallet: wallet.wallet, pub: fakePub() as EvmSourceSigner["pub"], chain: base, rpcUrls: [], owner: ME, transport: "injected"};
    const gate = createSwapGate("eip155:8453");
    const account = gateAccount(evmEngineAccount(signer, {reads: fakeReads()}), gate);
    return {gate, account, calls: wallet.calls};
  }

  it("a write nobody armed is refused before the wallet — and disarms the rest", async () => {
    const {gate, account, calls} = gated();
    await expect(account.sendTransaction({to: ROUTER, data: DATA, value: 0n})).rejects.toBeInstanceOf(SwapGateRefusal);
    const {writes, revokes} = planWrites(plan);
    gate.arm(writes, revokes);
    await expect(account.sendTransaction({to: ROUTER, data: DATA, value: 1n})).rejects.toBeInstanceOf(SwapGateRefusal);
    await expect(account.sendTransaction({to: ROUTER, data: DATA, value: 0n})).rejects.toBeInstanceOf(SwapGateRefusal);
    await expect(account.signTypedData({domain: {}, types: {}, primaryType: "Order", message: {}})).rejects.toBeInstanceOf(SwapGateRefusal);
    expect(calls).toHaveLength(0);
  });

  it("each armed write passes once; a revoke only after the approval was sent", async () => {
    const {gate, account, calls} = gated();
    const {writes, revokes} = planWrites(plan);
    gate.arm(writes, revokes);
    const revoke = {to: USDC_BASE, data: approveData(ROUTER, 0n), value: 0n};
    await expect(account.sendTransaction(revoke)).rejects.toBeInstanceOf(SwapGateRefusal);
    gate.arm(writes, revokes);
    await account.sendTransaction({to: USDC_BASE, data: approveData(ROUTER, AMOUNT), value: 0n});
    await account.sendTransaction({to: ROUTER, data: DATA, value: 0n});
    await expect(account.sendTransaction({to: ROUTER, data: DATA, value: 0n})).rejects.toBeInstanceOf(SwapGateRefusal);
    await account.sendTransaction(revoke);
    expect(sends(calls).map((a) => a.data)).toEqual([approveData(ROUTER, AMOUNT), DATA, approveData(ROUTER, 0n)]);
  });

  it("the wallet gets the request the gate checked, even if the caller's object changes afterwards", async () => {
    const {gate, account, calls} = gated();
    gate.arm(planWrites({...plan, approvals: []}).writes);
    const tx = {to: ROUTER, data: DATA, value: 0n};
    const pending = account.sendTransaction(tx);
    tx.to = EVIL;
    tx.value = 10n ** 18n;
    await pending;
    expect(sends(calls)[0]).toMatchObject({to: ROUTER, value: 0n});
  });

  it("refuses shapes the engine never sends, after the gate and before the wallet", async () => {
    const {gate, account, calls} = gated();
    gate.arm([{kind: "call", to: ROUTER, data: DATA, value: 0n}]);
    await expect(account.sendTransaction({to: ROUTER, data: DATA, value: 0n, chainId: 1})).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("only the engine's members survive the wrapper", () => {
    const inner = {...evmEngineAccount({family: "evm", wallet: fakeWallet().wallet, pub: fakePub() as EvmSourceSigner["pub"], chain: base, rpcUrls: [], owner: ME, transport: "injected"}, {reads: fakeReads()}), signMessage: async () => "0x"};
    const account = gateAccount(inner, createSwapGate("eip155:8453")) as Record<string, unknown>;
    expect(account.signMessage).toBeUndefined();
    expect(account.chain).toBeUndefined();
    expect(Object.isFrozen(account)).toBe(true);
  });
});
