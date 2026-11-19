/**
 * The Approvals section's only write (D46, accounts/revoke.ts), against a fake viem wallet that records every
 * request: what matters is whether the wallet is asked at all, and with exactly what.
 */
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, erc20Abi, parseAbi, type WalletClient} from "viem";
import {base, mainnet} from "viem/chains";
import type {ScannedApproval} from "../../../src/contracts/approvals";
import type {EvmSourceSigner} from "../../../src/contracts/execution";
import type {EvmReads} from "../../../src/execute/accounts/evm";
import {sendRevoke} from "../../../src/execute/accounts/revoke";
import {executePort} from "../../../src/execute";

const ME = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER = "0x1111111111111111111111111111111111111111";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const LIFI = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const BAYC = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";
const SEAPORT = "0x1E0049783F008A0085193E00003D00cd54003c71";

const erc20 = (over: Partial<ScannedApproval> = {}): ScannedApproval => ({
  id: `8453:erc20:${USDC.toLowerCase()}:${LIFI.toLowerCase()}`,
  standard: "erc20",
  chainId: 8453,
  token: USDC,
  spender: LIFI,
  amount: 2n ** 256n - 1n,
  unlimited: true,
  risks: ["unlimited"],
  ...over,
});
const permit2: ScannedApproval = {...erc20(), id: `8453:permit2:${USDC.toLowerCase()}:${OTHER.toLowerCase()}`, standard: "permit2", spender: OTHER, amount: 5n, unlimited: false, risks: []};
const operator: ScannedApproval = {...erc20(), id: `8453:erc721:${BAYC.toLowerCase()}:${SEAPORT.toLowerCase()}`, standard: "erc721", token: BAYC, spender: SEAPORT, amount: null};

function rig(o: {address?: string; chainId?: number; sim?: EvmReads["simulateTransaction"]; send?: () => Promise<string>; erc721?: boolean | Error} = {}) {
  const sent: {to: string; data: string; value: bigint}[] = [];
  const wallet = {
    getAddresses: async () => [o.address ?? ME],
    getChainId: async () => o.chainId ?? 8453,
    sendTransaction: vi.fn(async (args: {to: string; data: string; value: bigint}) => {
      sent.push({to: args.to, data: args.data, value: args.value});
      return o.send ? o.send() : `0x${"aa".repeat(32)}`;
    }),
  };
  const pub = {
    waitForTransactionReceipt: async () => ({status: "success", blockNumber: 1n}),
    getBlockNumber: async () => 2n,
    // ERC-165 supportsInterface(0x80ac58cd): an ERC-20 reverts (no such function).
    readContract: vi.fn(async () => {
      if (o.erc721 instanceof Error) throw o.erc721;
      if (o.erc721) return true;
      throw new Error("execution reverted");
    }),
  };
  const signer = {family: "evm", wallet: wallet as unknown as WalletClient, pub, chain: base, rpcUrls: [], owner: ME, transport: "injected"} as unknown as EvmSourceSigner;
  const reads = {simulateTransaction: o.sim ?? (async () => ({ok: true, gas: 1n, returnData: "0x"}))} as unknown as EvmReads;
  return {signer, sent, wallet, reads};
}

afterEach(() => vi.restoreAllMocks());

describe("sendRevoke (D46)", () => {
  it("an ERC-20 allowance: approve(spender, 0) to the token, value 0, then the receipt", async () => {
    const {signer, sent, reads} = rig();
    const res = await sendRevoke(signer, {owner: ME, approval: erc20(), scanned: [erc20(), operator]}, {reads});
    expect(res.hash).toMatch(/^0x(aa){32}$/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(USDC);
    expect(sent[0]!.value).toBe(0n);
    expect(decodeFunctionData({abi: erc20Abi, data: sent[0]!.data as `0x${string}`})).toEqual({functionName: "approve", args: [LIFI, 0n]});
  });

  it("a Permit2 allowance: lockdown on Permit2; an NFT operator: setApprovalForAll(operator, false) on the collection", async () => {
    let r = rig();
    await sendRevoke(r.signer, {owner: ME, approval: permit2, scanned: [permit2]}, {reads: r.reads});
    expect(r.sent[0]!.to).toBe(PERMIT2);
    expect(decodeFunctionData({abi: parseAbi(["function lockdown((address token, address spender)[] approvals)"]), data: r.sent[0]!.data as `0x${string}`}).functionName).toBe("lockdown");
    r = rig();
    await sendRevoke(r.signer, {owner: ME, approval: operator, scanned: [operator]}, {reads: r.reads});
    expect(r.sent[0]!.to).toBe(BAYC);
    expect(decodeFunctionData({abi: parseAbi(["function setApprovalForAll(address operator, bool approved)"]), data: r.sent[0]!.data as `0x${string}`}).args).toEqual([SEAPORT, false]);
  });

  it("never asks the wallet for another owner, another network, an approval the scan didn't find, a changed one or a delegation", async () => {
    const cases: [Parameters<typeof sendRevoke>[1], ReturnType<typeof rig>, RegExp][] = [
      [{owner: OTHER, approval: erc20(), scanned: [erc20()]}, rig(), /Connect the wallet that gave this approval/],
      [{owner: ME, approval: erc20({chainId: 1}), scanned: [erc20({chainId: 1})]}, rig(), /Switch your wallet to Base/],
      [{owner: ME, approval: erc20(), scanned: []}, rig(), /isn't in the last scan/],
      [{owner: ME, approval: erc20({spender: OTHER}), scanned: [erc20()]}, rig(), /isn't in the last scan/],
      [{owner: ME, approval: {...erc20(), standard: "eip7702"}, scanned: [{...erc20(), standard: "eip7702"}]}, rig(), /wallet's own settings/],
      // The wallet moved to another account or network after the switch: refused before any prompt.
      [{owner: ME, approval: erc20(), scanned: [erc20()]}, rig({address: OTHER}), /switched accounts/],
      [{owner: ME, approval: erc20(), scanned: [erc20()]}, rig({chainId: mainnet.id}), /switched networks/],
    ];
    for (const [input, r, why] of cases) {
      await expect(sendRevoke(r.signer, input, {reads: r.reads})).rejects.toThrow(why);
      expect(r.wallet.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it("one NFT: approve(0x0, id) on the collection", async () => {
    const one: ScannedApproval = {...operator, id: `8453:erc721-token:${BAYC.toLowerCase()}:${SEAPORT.toLowerCase()}:42`, standard: "erc721-token", tokenId: "42"};
    const r = rig();
    await sendRevoke(r.signer, {owner: ME, approval: one, scanned: [one]}, {reads: r.reads});
    expect(r.sent[0]!.to).toBe(BAYC);
    expect(decodeFunctionData({abi: parseAbi(["function approve(address to, uint256 tokenId)"]), data: r.sent[0]!.data as `0x${string}`}).args).toEqual(["0x0000000000000000000000000000000000000000", 42n]);
  });

  it("an 'ERC-20' allowance on a contract that says it is an ERC-721 is refused: approve(spender, 0) would approve token #0 (F31)", async () => {
    let r = rig({erc721: true});
    await expect(sendRevoke(r.signer, {owner: ME, approval: erc20(), scanned: [erc20()]}, {reads: r.reads})).rejects.toThrow(/NFT collection/);
    expect(r.wallet.sendTransaction).not.toHaveBeenCalled();
    // The network didn't answer the check: nothing sent either.
    r = rig({erc721: new Error("fetch failed")});
    await expect(sendRevoke(r.signer, {owner: ME, approval: erc20(), scanned: [erc20()]}, {reads: r.reads})).rejects.toThrow(/Couldn't check the token/);
    expect(r.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it("a revoke that would revert is refused before the wallet; a decline in the wallet reads as one", async () => {
    let r = rig({sim: async () => ({ok: false, reason: "execution reverted"}) as never});
    await expect(sendRevoke(r.signer, {owner: ME, approval: erc20(), scanned: [erc20()]}, {reads: r.reads})).rejects.toThrow(/would fail on-chain/);
    expect(r.wallet.sendTransaction).not.toHaveBeenCalled();
    r = rig({send: async () => Promise.reject(Object.assign(new Error("User rejected the request."), {code: 4001}))});
    await expect(sendRevoke(r.signer, {owner: ME, approval: erc20(), scanned: [erc20()]}, {reads: r.reads})).rejects.toThrow(/rejected/i);
  });

  it("the execute port revokes from an EVM signer only", async () => {
    const solana = {family: "solana"} as never;
    await expect(executePort.revoke({owner: ME, approval: erc20(), scanned: [erc20()]}, solana)).rejects.toThrow(/EVM wallet/);
  });
});
