import {describe, expect, it} from "vitest";
import type {ApprovalRow, ScannedApproval} from "../../../src/contracts/approvals";
import type {Token} from "../../../src/contracts/domain";
import {CHAIN_LIST} from "../../../src/catalog";
import {allowanceUsd, atRiskUnits, BLOCKSCOUT_URLS, ETHERSCAN_FREE_CHAIN_IDS, evmOwner, historySource, noSourceNote, ROUTESCAN_URLS, scannedOn, sortedRows, sortRows, usdAtRisk, valueAtRisk} from "../../../src/approvals";
import {spenderName} from "../../../src/approvals/scan";

const PROXY = "https://cp0x-api.test/api/v2/swap-web/venue/etherscan/v2/api";
const USDC: Token = {
  key: "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  chain: "base",
  caip2: "eip155:8453",
  chainName: "Base",
  family: "evm",
  symbol: "USDC",
  catalogSymbol: "USDC",
  decimals: 6,
  contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  gasToken: false,
} as Token;

const approval = (over: Partial<ScannedApproval> = {}): ScannedApproval => ({
  id: "8453:erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
  standard: "erc20",
  chainId: 8453,
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  spender: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
  amount: 2n ** 256n - 1n,
  unlimited: true,
  risks: ["unlimited"],
  ...over,
});
const row = (over: Partial<ApprovalRow> = {}, a: Partial<ScannedApproval> = {}): ApprovalRow => ({
  approval: approval(a),
  caip2: "eip155:8453",
  chainName: "Base",
  token: USDC,
  balance: 500_000_000n,
  spenderName: "LI.FI",
  verified: true,
  ...over,
});

describe("history sources (D46)", () => {
  it("cp0x's Etherscan slot on the free plan's networks, else public Blockscout, else Routescan, else none", () => {
    expect(historySource(1, PROXY)).toEqual({kind: "etherscan", url: PROXY});
    expect(historySource(1, null)).toEqual({kind: "blockscout", url: BLOCKSCOUT_URLS[1]});
    // Base is a paid Etherscan chain: Blockscout even in Standard mode.
    expect(historySource(8453, PROXY)).toEqual({kind: "blockscout", url: "https://base.blockscout.com"});
    expect(historySource(43114, PROXY)).toEqual({kind: "routescan", url: ROUTESCAN_URLS[43114]});
    expect(historySource(56, PROXY)).toBeNull();
    // Monad: Etherscan only — Standard mode only.
    expect(historySource(143, null)).toBeNull();
    expect(noSourceNote(143, null)).toBe("Checked in Standard mode only");
    expect(noSourceNote(56, PROXY)).toBe("No free history source yet");
  });

  it("the Etherscan list is cp0x-api's ETHERSCAN_FREE_CHAIN_IDS, and every listed network is one the page knows", () => {
    expect([...ETHERSCAN_FREE_CHAIN_IDS].sort((a, b) => a - b)).toEqual([1, 130, 137, 143, 146, 480, 999, 1329, 4326, 5000, 9745, 42161, 59144, 80094]);
    const ids = new Set(CHAIN_LIST.flatMap((c) => (c.chainId ? [c.chainId] : [])));
    for (const id of [...ETHERSCAN_FREE_CHAIN_IDS, ...Object.keys(BLOCKSCOUT_URLS).map(Number), ...Object.keys(ROUTESCAN_URLS).map(Number)]) expect(ids.has(id), String(id)).toBe(true);
    for (const url of [...Object.values(BLOCKSCOUT_URLS), ...Object.values(ROUTESCAN_URLS)]) expect(url).toMatch(/^https:\/\/[^/]+(?:\/[^?#]*)?$/);
  });
});

describe("what an approval puts at risk", () => {
  it("the allowance capped by the balance; unlimited = the balance; USD at the token's price", () => {
    expect(atRiskUnits(row())).toBe(500_000_000n);
    expect(atRiskUnits(row({}, {unlimited: false, amount: 100_000_000n}))).toBe(100_000_000n);
    expect(atRiskUnits(row({balance: null}))).toBeNull();
    expect(atRiskUnits(row({token: null}))).toBeNull();
    expect(usdAtRisk(row(), {[USDC.key]: 1})).toBe(500);
    expect(usdAtRisk(row(), {})).toBeNull();
  });

  it("most at risk first: by USD, then unlimited, then a plain-address spender", () => {
    const small = row({balance: 1_000_000n}, {id: "a"});
    const big = row({}, {id: "b"});
    const nft = row({token: null, balance: null}, {id: "c", standard: "erc721", amount: null, unlimited: true});
    const eoaNft = row({token: null, balance: null}, {id: "d", standard: "erc721", amount: null, unlimited: true, risks: ["unlimited", "eoa-spender"]});
    expect(sortRows([nft, small, eoaNft, big], {[USDC.key]: 1}).map((r) => r.approval.id)).toEqual(["b", "a", "d", "c"]);
    expect(scannedOn([small, big], "eip155:8453").map((a) => a.id)).toEqual(["a", "b"]);
    expect(scannedOn([small], "eip155:1")).toEqual([]);
  });

  it("the table's columns: the approved amount in USD, the value at risk (an NFT: $0 with none held, else unknown), the sort orders", () => {
    expect(allowanceUsd(row({}, {unlimited: false, amount: 100_000_000n}), {[USDC.key]: 1})).toBe(100);
    expect(allowanceUsd(row(), {[USDC.key]: 1})).toBeNull();
    expect(valueAtRisk(row(), {[USDC.key]: 1})).toBe(500);
    const nft = (count: bigint | null) => row({token: null, balance: null, nftCount: count}, {standard: "erc721", amount: null});
    expect(valueAtRisk(nft(0n), {})).toBe(0);
    expect(valueAtRisk(nft(3n), {})).toBe("unknown");
    expect(valueAtRisk(row({}, {standard: "eip7702"}), {})).toBeNull();
    const old = row({updatedAt: 1_000}, {id: "old"});
    const fresh = row({updatedAt: 2_000, balance: 1_000_000n}, {id: "fresh"});
    expect(sortedRows([old, fresh], {[USDC.key]: 1}, "newest").map((r) => r.approval.id)).toEqual(["fresh", "old"]);
    expect(sortedRows([fresh, old], {[USDC.key]: 1}, "risk").map((r) => r.approval.id)).toEqual(["old", "fresh"]);
  });

  it("an address to check: EVM only, checksummed", () => {
    expect(evmOwner(" 0x70997970c51812dc3a010c7d01b50e0d17dc79c8 ")).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(evmOwner("vitalik.eth")).toBeNull();
    expect(evmOwner("")).toBeNull();
    expect(evmOwner(null)).toBeNull();
  });
});

describe("Etherscan's plan answers", () => {
  it("a spent daily limit or an unserved network is a 429 the module won't wait for (it would split the range forever); anything else passes", async () => {
    const {planLimited} = await import("../../../src/approvals/scan");
    const body = (result: string) => new Response(JSON.stringify({status: "0", message: "NOTOK", result}), {status: 200});
    for (const r of ["Community Free API Limit reached. Resets 2026-11-20 00:00:00 UTC.", "Free API access is not supported for this chain. Please upgrade your api plan"]) {
      const res = await planLimited(body(r));
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(60);
    }
    for (const r of ["Max rate limit reached", "No records found"]) expect((await planLimited(body(r))).status).toBe(200);
    expect((await planLimited(new Response("x", {status: 502}))).status).toBe(502);
  });
});

describe("the history cache", () => {
  it("keeps a history INDEXER_LAG_BLOCKS behind what was read (an indexer answers behind the head), never before its start", async () => {
    const {historyCache, INDEXER_LAG_BLOCKS} = await import("../../../src/approvals/scan");
    await historyCache.set("1:0xowner", {fromBlock: 0, toBlock: 21_000_000, candidates: []} as never);
    expect(((await historyCache.get("1:0xowner")) as {toBlock: number}).toBlock).toBe(21_000_000 - INDEXER_LAG_BLOCKS);
    await historyCache.set("1:0xnew", {fromBlock: 20_990_000, toBlock: 21_000_000, candidates: []} as never);
    expect(((await historyCache.get("1:0xnew")) as {toBlock: number}).toBlock).toBe(20_990_000);
  });
});

describe("the spender's name", () => {
  const base = CHAIN_LIST.find((c) => c.caip2 === "eip155:8453")!;
  it("Permit2, a venue cp0x Swap pins (verified), else the explorer's label", () => {
    expect(spenderName(base, approval({spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3"}))).toEqual({name: "Permit2", verified: true});
    expect(spenderName(base, approval())).toEqual({name: "LI.FI", verified: true});
    expect(spenderName(base, approval({spender: "0x9a3c5f40cE0c5B2a3eD8B0b4C1aE2f3A9B1d7e01", spenderLabel: {name: "SomeRouter"}}))).toEqual({name: "SomeRouter", verified: false});
    expect(spenderName(base, approval({spender: "0x9a3c5f40cE0c5B2a3eD8B0b4C1aE2f3A9B1d7e01"}))).toEqual({name: null, verified: false});
    // An explorer label is the deployer's word: one claiming a verified name shows the address instead.
    for (const name of ["Permit2", "LI.FI", " permit2 "]) {
      expect(spenderName(base, approval({spender: "0x9a3c5f40cE0c5B2a3eD8B0b4C1aE2f3A9B1d7e01", spenderLabel: {name}}))).toEqual({name: null, verified: false});
    }
  });
});
