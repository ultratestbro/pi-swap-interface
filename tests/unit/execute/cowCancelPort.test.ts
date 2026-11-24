// The execute port's CoW cancel (D49): what lands on the record — off-chain the time, on-chain the hash — and an
// on-chain cancel the wallet may have broadcast (WalletConnect's maybe-sent) recorded so the page never offers another.
import "fake-indexeddb/auto";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {findSwap, getSwaps, newRecord, saveSwap} from "../../../src/activity";
import type {SwapRecord} from "../../../src/contracts/activity";

const cancel = vi.hoisted(() => ({cancelOrder: vi.fn(), previewCancel: vi.fn()}));
vi.mock("../../../src/execute/cancel", () => cancel);
const {executePort} = await import("../../../src/execute/port");

const TOKEN_ID = `awk1.cow.o%3A8453%3A0x${"11".repeat(56)}`;
const FLOW_ID = `awk1.cow.e%3A8453%3Aabc.0x${"ab".repeat(32)}`;
const record = (id: string): SwapRecord =>
  newRecord({
    id,
    accountId: "evm:0xme",
    provider: "cow",
    from: {caip2: "eip155:8453", chain: "base", symbol: "ETH", decimals: 18},
    to: {caip2: "eip155:8453", chain: "base", symbol: "USDC", decimals: 6},
    amountIn: 1n,
    expectedOut: 1n,
    minOut: 1n,
    recipient: "0xme",
  });
const signer = {family: "evm"} as never;

beforeEach(() => {
  cancel.cancelOrder.mockReset();
  saveSwap(record(TOKEN_ID));
  saveSwap(record(FLOW_ID));
});

describe("cancelOrder on the execute port", () => {
  it("off-chain: the time the orderbook took it; on-chain: the hash", async () => {
    cancel.cancelOrder.mockResolvedValueOnce({mode: "offchain", chain: "eip155:8453"});
    await executePort.cancelOrder(TOKEN_ID, signer);
    expect(findSwap(getSwaps(), TOKEN_ID)?.cancelRequestedAt).toBeGreaterThan(0);
    cancel.cancelOrder.mockResolvedValueOnce({mode: "onchain", chain: "eip155:8453", hash: "0xfeed"});
    await executePort.cancelOrder(FLOW_ID, signer);
    expect(findSwap(getSwaps(), FLOW_ID)?.cancelHash).toBe("0xfeed");
  });

  it("an on-chain cancel the wallet may have sent is recorded (no second offer); an off-chain one is not", async () => {
    const unsure = () => Object.assign(new Error("the request expired"), {maybeSent: true});
    cancel.cancelOrder.mockRejectedValueOnce(unsure());
    await expect(executePort.cancelOrder(FLOW_ID, signer)).rejects.toThrow(/expired/);
    expect(findSwap(getSwaps(), FLOW_ID)?.cancelRequestedAt).toBeGreaterThan(0);
    cancel.cancelOrder.mockRejectedValueOnce(unsure());
    await expect(executePort.cancelOrder(TOKEN_ID, signer)).rejects.toThrow(/expired/);
    expect(findSwap(getSwaps(), TOKEN_ID)?.cancelRequestedAt).toBeUndefined();
  });
});
