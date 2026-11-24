// Cancelling a resting CoW order (D49): the gate's one cancellation write, the preview's byte-for-byte check against
// what the record's own id says, and the engine's cancelSwap2 through the gated account (fake wallet, no network).
import "fake-indexeddb/auto";
import {describe, expect, it} from "vitest";
import type {WalletClient} from "viem";
import {base, mainnet} from "viem/chains";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import type {CrossChainProvider, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {COW_ETH_FLOW, COW_SETTLEMENT, cancellationTypedData, encodeInvalidateOrder, packEthFlowData, type EthFlowData} from "@anywalletkit/protocol-swap2-cow";
import type {EvmSourceSigner} from "../../../src/contracts/execution";
import {cancelOrder, previewCancel} from "../../../src/execute/cancel";
import {SwapGateRefusal, matches, type ArmedWrite} from "../../../src/execute/gate";
import {encodeSwapId} from "../../../src/execute/ids";

const ME = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const OTHER = "0x0f0067cd819cB8F20BDa62046dAFF7a2b5c88280";
/** An order UID: 32-byte digest ++ owner ++ uint32 validTo. */
const uidOf = (owner: string, digestByte = "11", validTo = 0xffffffff) =>
  `0x${digestByte.repeat(32)}${owner.slice(2).toLowerCase()}${validTo.toString(16).padStart(8, "0")}`;
const UID = uidOf(ME);
const ORDER_ID = encodeSwapId("cow", `o:8453:${UID}`);
const FLOW: EthFlowData = {
  buyToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  receiver: ME,
  sellAmount: "200000000000000",
  buyAmount: "340000",
  appData: `0x${"22".repeat(32)}`,
  validTo: 4_000_000_000,
  quoteId: 7,
} as EthFlowData;
const FLOW_DATA = encodeInvalidateOrder(FLOW);
const FLOW_ID = encodeSwapId("cow", `e:8453:${packEthFlowData(FLOW)}`, `0x${"ab".repeat(32)}`);

/** What the engine hands the account's signTypedData: the typed data without its EIP712Domain type. */
function engineTyped(uids: string[], chainId = 8453) {
  const td = cancellationTypedData(chainId, uids) as {domain: unknown; types: Record<string, unknown>; primaryType: string; message: unknown};
  const {EIP712Domain: _d, ...types} = td.types;
  return {domain: td.domain, types, primaryType: td.primaryType, message: td.message};
}

function cowVenue(build: (onchain: boolean) => UnsignedTx | null, registered: string[] = []): CrossChainProvider {
  return {
    name: "cow",
    supportsSameChain: true,
    enabled: () => true,
    supportsRoute: () => true,
    getQuote: async () => null,
    buildDeposit: async () => ({chain: "", to: "", value: "0"}),
    trackIntent: async () => ({state: "pending"}),
    buildCancel: async (_ref, o) => build(o.onchain),
    registerCancel: async (_id, sig) => void registered.push(sig),
    cancelTargets: () => [COW_SETTLEMENT, COW_ETH_FLOW],
  };
}

const offchainTx = (uids = [UID]): UnsignedTx => ({chain: "eip155:8453", to: COW_SETTLEMENT, value: "0", chainId: 8453, typedData: JSON.stringify(cancellationTypedData(8453, uids))});
const onchainTx = (data: string = FLOW_DATA, to: string = COW_ETH_FLOW): UnsignedTx => ({chain: "eip155:8453", to, value: "0", data, chainId: 8453, gasLimit: "120000"});

function evmSigner(chain: EvmSourceSigner["chain"] = base) {
  const sent: unknown[] = [];
  const signed: unknown[] = [];
  const wallet = {
    getAddresses: async () => [ME],
    getChainId: async () => chain.id,
    sendTransaction: async (args: unknown) => {
      sent.push(args);
      return `0x${"c".repeat(64)}`;
    },
    signTypedData: async (args: unknown) => {
      signed.push(args);
      return `0x${"d".repeat(130)}`;
    },
  } as unknown as WalletClient;
  const pub = {
    getCode: async () => undefined,
    getBlockNumber: async () => 10n,
    waitForTransactionReceipt: async () => ({status: "success", blockNumber: 1n}),
  } as unknown as EvmSourceSigner["pub"];
  const signer: EvmSourceSigner = {family: "evm", wallet, pub, chain, rpcUrls: [], owner: ME, transport: "injected"};
  const reads = {
    getBalance: async () => 10n ** 18n,
    getAllowance: async () => 0n,
    getTokenInfo: async () => ({decimals: 6}) as never,
    quoteSendTransaction: async () => ({fee: 1n}),
    simulateTransaction: async () => ({ok: true as const, gas: 1n, returnData: "0x" as const}),
  };
  return {signer, sent, signed, reads};
}

describe("the gate's CoW cancellation (gpv2Cancel)", () => {
  const w: ArmedWrite = {kind: "gpv2Cancel", owner: ME, chainId: 8453, uid: UID};

  it("matches exactly the one order's OrderCancellations for this owner and network", () => {
    expect(matches(w, "signTypedData", engineTyped([UID]))).toBe(true);
    expect(matches(w, "signTypedData", engineTyped([UID.toUpperCase().replace("0X", "0x")]))).toBe(true);
  });

  it("refuses another order, a second order, another owner, another network or another method", () => {
    expect(matches(w, "signTypedData", engineTyped([uidOf(ME, "33")]))).toBe(false);
    expect(matches(w, "signTypedData", engineTyped([UID, uidOf(ME, "33")]))).toBe(false);
    expect(matches({...w, uid: uidOf(OTHER)}, "signTypedData", engineTyped([uidOf(OTHER)]))).toBe(false);
    expect(matches(w, "signTypedData", engineTyped([UID], 1))).toBe(false);
    expect(matches(w, "sendTransaction", engineTyped([UID]))).toBe(false);
    const order = {...engineTyped([UID]), primaryType: "Order"};
    expect(matches(w, "signTypedData", order)).toBe(false);
  });
});

describe("previewCancel", () => {
  it("a token order: the free off-chain cancellation of its own UID", async () => {
    const router = new CrossChainRouter([cowVenue(() => offchainTx())]);
    expect(await previewCancel(ORDER_ID, ME, {router: () => router})).toEqual({chain: "eip155:8453", mode: "offchain", to: COW_SETTLEMENT, uid: UID});
  });

  it("an eth-flow order: eth-flow's invalidateOrder, exactly as the record's order encodes it", async () => {
    const router = new CrossChainRouter([cowVenue(() => onchainTx())]);
    expect(await previewCancel(FLOW_ID, ME, {router: () => router})).toEqual({chain: "eip155:8453", mode: "onchain", to: COW_ETH_FLOW, data: FLOW_DATA});
  });

  it("null when nothing is left to cancel", async () => {
    const router = new CrossChainRouter([cowVenue(() => null)]);
    expect(await previewCancel(ORDER_ID, ME, {router: () => router})).toBeNull();
  });

  it("refuses a build that isn't what the order takes — calldata for a token order, other bytes, another contract or network", async () => {
    const at = (b: () => UnsignedTx) => ({router: () => new CrossChainRouter([cowVenue(b)])});
    await expect(previewCancel(ORDER_ID, ME, at(() => onchainTx()))).rejects.toThrow(/isn't the one this order takes/);
    await expect(previewCancel(FLOW_ID, ME, at(() => offchainTx()))).rejects.toThrow(/isn't the one this order takes/);
    await expect(previewCancel(FLOW_ID, ME, at(() => onchainTx(`${FLOW_DATA.slice(0, -2)}00`)))).rejects.toThrow(/isn't the one/);
    await expect(previewCancel(FLOW_ID, ME, at(() => onchainTx(FLOW_DATA, COW_SETTLEMENT)))).rejects.toThrow(/isn't the one/);
    await expect(previewCancel(FLOW_ID, ME, at(() => ({...onchainTx(), chain: "eip155:1"})))).rejects.toThrow(/isn't the one/);
    await expect(previewCancel(FLOW_ID, ME, at(() => ({...onchainTx(), value: "1"})))).rejects.toThrow(/isn't the one/);
  });

  it("refuses an id that is no CoW order", async () => {
    const router = new CrossChainRouter([cowVenue(() => offchainTx())]);
    await expect(previewCancel(encodeSwapId("relay", "x"), ME, {router: () => router})).rejects.toThrow(/Only a CoW order/);
    await expect(previewCancel(encodeSwapId("cow", "q:8453:abc"), ME, {router: () => router})).rejects.toThrow(/isn't a CoW order/);
    await expect(previewCancel(encodeSwapId("cow", `o:10:${UID}`), ME, {router: () => router})).rejects.toThrow(/isn't a CoW order/);
  });
});

describe("cancelOrder", () => {
  it("off-chain: the wallet signs only the order's cancellation, and the orderbook gets that signature", async () => {
    const registered: string[] = [];
    const router = new CrossChainRouter([cowVenue(() => offchainTx(), registered)]);
    const {signer, sent, signed, reads} = evmSigner();
    expect(await cancelOrder(ORDER_ID, signer, {router: () => router, evmReads: () => reads})).toEqual({mode: "offchain", chain: "eip155:8453"});
    expect(signed).toEqual([expect.objectContaining({primaryType: "OrderCancellations", message: {orderUids: [UID]}})]);
    expect(registered).toEqual([`0x${"d".repeat(130)}`]);
    expect(sent).toHaveLength(0);
  });

  it("on-chain (eth-flow): sends exactly the invalidateOrder call, no value", async () => {
    const router = new CrossChainRouter([cowVenue(() => onchainTx())]);
    const {signer, sent, signed, reads} = evmSigner();
    expect(await cancelOrder(FLOW_ID, signer, {router: () => router, evmReads: () => reads})).toEqual({mode: "onchain", chain: "eip155:8453", hash: `0x${"c".repeat(64)}`});
    expect(sent).toEqual([expect.objectContaining({to: COW_ETH_FLOW, data: FLOW_DATA, value: 0n})]);
    expect(signed).toHaveLength(0);
  });

  it("a cancellation the venue rebuilds for more orders is refused by the gate — the wallet is never asked", async () => {
    let n = 0;
    const router = new CrossChainRouter([cowVenue(() => (n++ === 0 ? offchainTx() : offchainTx([UID, uidOf(ME, "33")])))]);
    const {signer, sent, signed, reads} = evmSigner();
    await expect(cancelOrder(ORDER_ID, signer, {router: () => router, evmReads: () => reads})).rejects.toBeInstanceOf(SwapGateRefusal);
    expect(signed).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("refuses another network or a non-EVM signer before anything is built", async () => {
    const router = new CrossChainRouter([cowVenue(() => offchainTx())]);
    const {signer, sent, signed, reads} = evmSigner(mainnet);
    await expect(cancelOrder(ORDER_ID, signer, {router: () => router, evmReads: () => reads})).rejects.toThrow(/Switch your wallet to Base/);
    await expect(cancelOrder(ORDER_ID, {family: "solana"} as never, {router: () => router})).rejects.toThrow(/Connect the EVM wallet/);
    expect([...sent, ...signed]).toHaveLength(0);
  });

  it("nothing left to cancel is a status answer, not a signature", async () => {
    const router = new CrossChainRouter([cowVenue(() => null)]);
    const {signer, signed, reads} = evmSigner();
    await expect(cancelOrder(ORDER_ID, signer, {router: () => router, evmReads: () => reads})).rejects.toThrow(/nothing to cancel/);
    expect(signed).toHaveLength(0);
  });
});
