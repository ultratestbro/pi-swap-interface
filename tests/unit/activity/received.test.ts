// What actually arrived (D41): read from the delivery transaction — EVM receipt logs / balances, Solana token
// balances, Tron TRC-20 logs. Every RPC is faked here.
import {afterEach, describe, expect, it, vi} from "vitest";
import {encodeAbiParameters, pad, type Hex} from "viem";
import type {SwapRecord} from "../../../src/contracts/activity";

const rpc = vi.hoisted(() => ({
  receipt: undefined as unknown,
  balances: new Map<bigint, bigint>(),
  sol: undefined as unknown,
  tron: undefined as unknown,
}));

vi.mock("../../../src/catalog", async (orig) => ({
  ...(await orig<typeof import("../../../src/catalog")>()),
  publicClient: () => ({
    getTransactionReceipt: async () => rpc.receipt,
    getBalance: async ({blockNumber}: {blockNumber: bigint}) => rpc.balances.get(blockNumber) ?? 0n,
  }),
  tronPost: async () => rpc.tron,
}));
vi.mock("../../../src/catalog/balances/solana", async (orig) => ({
  ...(await orig<typeof import("../../../src/catalog/balances/solana")>()),
  solRpc: async () => rpc.sol,
}));

import {newRecord} from "../../../src/activity";
import {base58ToBytes} from "../../../src/catalog";
import {readReceived} from "../../../src/activity/received";

const ME = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const rec = (to: {caip2: string; chain: string; symbol: string; decimals: number; key: string}, over: Partial<SwapRecord> = {}): SwapRecord => ({
  ...newRecord({
    id: "awk1.relay.r1.0xh",
    accountId: `evm:${ME}`,
    provider: "relay",
    from: {caip2: "eip155:42161", chain: "arbitrum", symbol: "ETH", decimals: 18, key: "arbitrum:native"},
    to,
    amountIn: 1n,
    expectedOut: 1n,
    minOut: 1n,
    recipient: ME,
  }),
  destHash: "0xdest",
  ...over,
});
const transferLog = (token: string, from: string, to: string, value: bigint) => ({
  address: token,
  topics: [TRANSFER, pad(from as Hex), pad(to as Hex)] as Hex[],
  data: encodeAbiParameters([{type: "uint256"}], [value]),
  blockNumber: 100n,
  transactionHash: "0xdest",
  logIndex: 0,
  blockHash: "0x00",
  transactionIndex: 0,
  removed: false,
});

afterEach(() => {
  rpc.receipt = undefined;
  rpc.balances.clear();
  rpc.sol = undefined;
  rpc.tron = undefined;
});

describe("readReceived", () => {
  const usdcBase = {caip2: "eip155:8453", chain: "base", symbol: "USDC", decimals: 6, key: `base:${USDC_BASE}`};
  const ethBase = {caip2: "eip155:8453", chain: "base", symbol: "ETH", decimals: 18, key: "base:native"};

  it("EVM, an ERC-20: the token's Transfer logs to the recipient, summed; another token or recipient is left out", async () => {
    rpc.receipt = {
      status: "success",
      from: "0x000000000000000000000000000000000000dEaD",
      blockNumber: 100n,
      gasUsed: 1n,
      effectiveGasPrice: 1n,
      logs: [
        transferLog(USDC_BASE, "0x1111111111111111111111111111111111111111", ME, 24_900_000n),
        transferLog(USDC_BASE, "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222", 5n),
        transferLog("0x4200000000000000000000000000000000000006", "0x1111111111111111111111111111111111111111", ME, 7n),
      ],
    };
    expect(await readReceived(rec(usdcBase))).toBe(24_900_000n);
  });

  it("EVM, the native coin: the balance change at the delivery's block, plus the gas when the recipient sent it", async () => {
    rpc.receipt = {status: "success", from: "0x000000000000000000000000000000000000dEaD", blockNumber: 100n, gasUsed: 21_000n, effectiveGasPrice: 10n, logs: []};
    rpc.balances.set(99n, 1_000n).set(100n, 501_000n);
    expect(await readReceived(rec(ethBase))).toBe(500_000n);
    // A swap on one network: the recipient paid its own gas (and an OP-stack L1 fee).
    rpc.receipt = {status: "success", from: ME, blockNumber: 100n, gasUsed: 21_000n, effectiveGasPrice: 10n, l1Fee: 5n, logs: []};
    expect(await readReceived(rec(ethBase))).toBe(500_000n + 210_005n);
  });

  it("EVM: a reverted delivery, no delivery hash, an unknown token or a failing RPC read as null", async () => {
    rpc.receipt = {status: "reverted", from: ME, blockNumber: 1n, gasUsed: 0n, effectiveGasPrice: 0n, logs: []};
    expect(await readReceived(rec(usdcBase))).toBeNull();
    expect(await readReceived(rec(usdcBase, {destHash: undefined}))).toBeNull();
    expect(await readReceived(rec({...usdcBase, key: "base:0xunknown"}))).toBeNull();
    rpc.receipt = undefined;
    expect(await readReceived(rec(usdcBase))).toBeNull();
  });

  it("a claimed delivery (CCTP) reads the claim's transaction", async () => {
    rpc.receipt = {status: "success", from: ME, blockNumber: 100n, gasUsed: 0n, effectiveGasPrice: 0n, logs: [transferLog(USDC_BASE, "0x0000000000000000000000000000000000000000", ME, 3n)]};
    expect(await readReceived(rec(usdcBase, {destHash: undefined, claimHash: "0xclaim"}))).toBe(3n);
  });

  it("Solana: the recipient's token balance after minus before; SOL: its lamports plus the fee it paid", async () => {
    const SOL_ME = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    rpc.sol = {
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [10_000_000, 0],
        postBalances: [12_995_000, 0],
        preTokenBalances: [{owner: SOL_ME, mint: USDC_SOL, uiTokenAmount: {amount: "1000000"}}],
        postTokenBalances: [
          {owner: SOL_ME, mint: USDC_SOL, uiTokenAmount: {amount: "25900000"}},
          {owner: "other", mint: USDC_SOL, uiTokenAmount: {amount: "9"}},
        ],
      },
      transaction: {message: {accountKeys: [{pubkey: SOL_ME}, {pubkey: "other"}]}},
    };
    const solSide = (key: string, symbol: string, decimals: number) => ({caip2: "solana:mainnet", chain: "solana", symbol, decimals, key});
    expect(await readReceived(rec(solSide(`solana:${USDC_SOL.toLowerCase()}`, "USDC", 6), {recipient: SOL_ME}))).toBe(24_900_000n);
    expect(await readReceived(rec(solSide("solana:native", "SOL", 9), {recipient: SOL_ME}))).toBe(3_000_000n);
  });

  it("Tron: the token's TRC-20 Transfer logs to the recipient", async () => {
    const TRON_ME = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
    const USDT_TRON = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    const hex20 = (a: string) => Array.from(base58ToBytes(a).slice(1, 21), (b) => b.toString(16).padStart(2, "0")).join("");
    const log = (to: string, value: bigint) => ({
      address: hex20(USDT_TRON),
      topics: [TRANSFER.slice(2), "0".repeat(64), `${"0".repeat(24)}${to}`],
      data: value.toString(16).padStart(64, "0"),
    });
    rpc.tron = {receipt: {result: "SUCCESS"}, log: [log(hex20(TRON_ME), 25_000_000n), log("87e94d6c6e9d32dcc2bfe5bdfad2d4e3dc6c6f41", 9n)]};
    const usdt = {caip2: "tron:728126428", chain: "tron", symbol: "USDT", decimals: 6, key: `tron:${USDT_TRON.toLowerCase()}`};
    expect(hex20(USDT_TRON)).toBe("a614f803b6fd780986a42c78ec9c7f77e6ded13c");
    expect(await readReceived(rec(usdt, {recipient: TRON_ME}))).toBe(25_000_000n);
    rpc.tron = {receipt: {result: "REVERT"}, log: [log(hex20(TRON_ME), 1n)]};
    expect(await readReceived(rec(usdt, {recipient: TRON_ME}))).toBeNull();
  });
});
