/**
 * One network's approvals for an address (D46): the module's discovery over the network's history source
 * (sources.ts), its state check over the runtime RPCs (Standard: cp0x's proxy first), then what the list shows — the
 * ERC-20 each allowance spends and the owner's balance of it, read on-chain, and the spender's name. Read-only: the
 * scan holds no wallet; a revoke goes through execute.
 *
 * The history is cached per network and address in this browser (the module's incremental cache): a later scan asks
 * only for blocks since — less INDEXER_LAG_BLOCKS, since an indexer answers a little behind the head the module asks
 * up to (an approval in that gap would otherwise never be read). Etherscan calls are paced to one every
 * ETHERSCAN_GAP_MS from this page — the free key's 3–5 a second is shared by everyone — and the module retries its
 * "rate limit" answers. Every on-chain read here goes through a client with CCIP-Read off: a token's revert can't make
 * the page fetch a URL of its choosing (with the scanned address in it).
 */
import ApprovalsProtocolEvm, {BlockscoutSource, EtherscanLabels, EtherscanSource, STANDARDS, type ApprovalsCache, type EvmApproval, type LabelCache} from "@anywalletkit/protocol-approvals-evm";
import {createPublicClient, erc20Abi, getAddress, type Address, type PublicClient} from "viem";
import type {ApprovalRow, ScannedApproval} from "../contracts/approvals";
import type {Chain, Token} from "../contracts/domain";
import {TOKENS, VIEM_CHAINS, evmRpcUrls, importedToken, readEvmToken, readTransport} from "../catalog";
import {pinnedVenueOf} from "../execute";
import {PROVIDER_NAMES, providerName} from "../swap";
import type {HistorySource} from "./sources";

const CACHE_PREFIX = "cp0x.approvals.v1:";
export const ETHERSCAN_GAP_MS = 500;
/** Blocks a cached history is read again from (Ethereum ~7 days, Arbitrum ~3.5 h): the indexers' lag behind the head. */
export const INDEXER_LAG_BLOCKS = 50_000;
/** Addresses' histories kept in this browser; past it, the oldest go. */
const HISTORY_KEEP = 200;
/** A spender without a name (or whose lookup failed) is asked again after this long. */
const NO_NAME_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;

type Stored = Record<string, unknown> & {at?: number};

/** localStorage, failing soft: a lost entry only makes the next scan ask again. Each entry notes when it was written. */
function storage(prefix: string) {
  const full = (key: string) => `${CACHE_PREFIX}${prefix}${key}`;
  const read = (k: string): Stored | null => {
    try {
      const raw = localStorage.getItem(k);
      const v = raw ? (JSON.parse(raw) as unknown) : null;
      return v && typeof v === "object" ? (v as Stored) : null;
    } catch {
      return null;
    }
  };
  return {
    read: (key: string) => read(full(key)),
    write(key: string, value: Stored) {
      try {
        localStorage.setItem(full(key), JSON.stringify({...value, at: Date.now()}, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
      } catch {
        // Storage full or off: the next scan reads it again.
      }
    },
    drop(key: string) {
      try {
        localStorage.removeItem(full(key));
      } catch {
        // Nothing to forget.
      }
    },
    /** Keep the `keep` newest entries under this prefix. */
    prune(keep: number) {
      try {
        const mine: [string, number][] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k?.startsWith(`${CACHE_PREFIX}${prefix}`)) mine.push([k, read(k)?.at ?? 0]);
        }
        if (mine.length <= keep) return;
        for (const [k] of mine.sort((a, b) => b[1] - a[1]).slice(keep)) localStorage.removeItem(k);
      } catch {
        // Nothing to prune.
      }
    },
  };
}

const histories = storage("history:");
const labels = storage("");

/** The module's history cache, held INDEXER_LAG_BLOCKS behind what it read, and to HISTORY_KEEP addresses. */
export const historyCache: ApprovalsCache = {
  get: async (key) => histories.read(key) as Awaited<ReturnType<ApprovalsCache["get"]>>,
  async set(key, entry) {
    const e = entry as unknown as Stored & {fromBlock?: number; toBlock: number};
    histories.write(key, {...e, toBlock: Math.max(e.fromBlock ?? 0, e.toBlock - INDEXER_LAG_BLOCKS)});
    histories.prune(HISTORY_KEEP * 4);
  },
};

/** The module's label cache: a name for good, an empty one (none, or a failed lookup) for NO_NAME_MS. */
const labelCache: LabelCache = {
  get(key) {
    const v = labels.read(key);
    if (!v) return null;
    if (!v.name && Date.now() - (v.at ?? 0) > NO_NAME_MS) return null;
    return v;
  },
  set: (key, value) => labels.write(key, (value ?? {}) as Stored),
};

/** The page's fetch, called as a plain function (the module keeps it on an object, and a browser refuses a detached window.fetch), with a deadline. */
const pageFetch: typeof fetch = (input, init) => fetch(input, {...init, signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS)});

/** One Etherscan call at a time from this page, ETHERSCAN_GAP_MS apart. */
let etherscanTurn: Promise<void> = Promise.resolve();
const pacedFetch: typeof fetch = (input, init) => {
  const go = etherscanTurn.then(() => pageFetch(input, init));
  etherscanTurn = go.then(
    () => new Promise((r) => setTimeout(r, ETHERSCAN_GAP_MS)),
    () => new Promise((r) => setTimeout(r, ETHERSCAN_GAP_MS)),
  );
  return go;
};

/**
 * A keyless instance gets one retry, briefly: a viewer waits on it, and its per-IP window resets in minutes, not
 * seconds. cp0x's Etherscan slot keeps the module's retries (its "rate limit" answers clear within a second or two).
 */
const KEYLESS_RETRY = {retries: 1, retryDelay: 1_000, maxRetryWait: 5_000} as const;
const ETHERSCAN_RETRY = {retries: 3, retryDelay: 1_000, maxRetryWait: 10_000} as const;

function sourceOf(chainId: number, s: HistorySource) {
  if (s.kind === "blockscout") return new BlockscoutSource({chainId, baseUrl: s.url, fetch: pageFetch, ...KEYLESS_RETRY});
  if (s.kind === "routescan") return new EtherscanSource({chainId, baseUrl: s.url, fetch: pageFetch, ...KEYLESS_RETRY});
  return new EtherscanSource({chainId, baseUrl: s.url, fetch: pacedFetch, ...ETHERSCAN_RETRY});
}

/** The module's approval in the app's shape (amount kept in base units). */
function scanned(a: EvmApproval): ScannedApproval {
  return {
    id: a.id,
    standard: a.standard as ScannedApproval["standard"],
    chainId: Number(a.chainId),
    token: getAddress(a.token),
    spender: getAddress(a.spender),
    amount: a.amount === null || a.amount === undefined ? null : BigInt(a.amount),
    unlimited: a.unlimited,
    risks: [...a.risks],
    ...(a.tokenId !== undefined ? {tokenId: String(a.tokenId)} : {}),
    ...(a.expiration !== undefined ? {expiration: Number(a.expiration)} : {}),
    ...(a.permit2 ? {permit2: getAddress(a.permit2)} : {}),
    ...(a.spenderLabel?.name ? {spenderLabel: {name: a.spenderLabel.name, ...(a.spenderLabel.url ? {url: a.spenderLabel.url} : {})}} : {}),
  };
}

/** Names only a verified spender may carry: an explorer label is whatever its deployer called the contract. */
const RESERVED = new Set(["permit2", ...Object.values(PROVIDER_NAMES).map((n) => n.toLowerCase())]);

/**
 * The spender's name: Permit2, a venue cp0x Swap pins as a spender on this network ("verified"), else the explorer's
 * label — unless that label claims one of those names (then its address is shown).
 */
export function spenderName(chain: Chain, a: ScannedApproval): {name: string | null; verified: boolean} {
  if (STANDARDS.isPermit2Address(a.spender, a.chainId)) return {name: "Permit2", verified: true};
  const venue = pinnedVenueOf(chain.caip2, a.spender);
  if (venue) return {name: providerName(venue), verified: true};
  const label = a.spenderLabel?.name?.trim() ?? "";
  return {name: label && !RESERVED.has(label.toLowerCase()) ? label : null, verified: false};
}

/** One client per network for the scan's reads, CCIP-Read off (the module's own client has it off too). */
const readers = new Map<number, PublicClient>();
function reader(chainId: number): PublicClient {
  let c = readers.get(chainId);
  if (!c) {
    const chain = VIEM_CHAINS.find((x) => x.id === chainId);
    c = createPublicClient({...(chain ? {chain} : {}), transport: readTransport(chainId), ccipRead: false}) as PublicClient;
    readers.set(chainId, c);
  }
  return c;
}

/**
 * The ERC-20 an allowance spends: the catalog's token when it lists the contract (its own logo), else read on-chain as
 * an imported one (D39: by contract only, never trusted by its symbol) — per network and contract, for the page's life.
 */
const tokenMeta = new Map<string, Promise<Token | null>>();
function tokenOf(chain: Chain, contract: string): Promise<Token | null> {
  const key = `${chain.caip2}:${contract.toLowerCase()}`;
  const listed = TOKENS.find((t) => t.caip2 === chain.caip2 && t.contract?.toLowerCase() === contract.toLowerCase());
  if (listed) return Promise.resolve(listed);
  let p = tokenMeta.get(key);
  if (!p) {
    p = readEvmToken(chain, contract, reader(chain.chainId!)).then(
      (meta) => importedToken(chain, contract, meta),
      () => null,
    );
    tokenMeta.set(key, p);
  }
  return p;
}

/** A contract's own words, without control characters (a name() can carry anything). */
const printable = (text: string): string => [...text].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join("");

const NAME_ABI = [{type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{type: "string"}]}] as const;

/** Each NFT collection's name() (one multicall); absent where it has none or the read failed. */
async function namesOf(chain: Chain, contracts: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!contracts.length) return out;
  try {
    const res = await reader(chain.chainId!).multicall({
      contracts: contracts.map((c) => ({address: c as Address, abi: NAME_ABI, functionName: "name" as const})),
      allowFailure: true,
    });
    contracts.forEach((c, i) => {
      const name = res[i]?.status === "success" ? printable(String(res[i]!.result)).trim().slice(0, 40) : "";
      if (name) out.set(c.toLowerCase(), name);
    });
  } catch {
    // Unnamed: the list shows the contract's address.
  }
  return out;
}

/** The owner's balance of each ERC-20 (one multicall); null where a read failed. */
async function balancesOf(chain: Chain, owner: Address, tokens: readonly string[]): Promise<Map<string, bigint | null>> {
  const out = new Map<string, bigint | null>();
  if (!tokens.length) return out;
  try {
    const res = await reader(chain.chainId!).multicall({
      contracts: tokens.map((t) => ({address: t as Address, abi: erc20Abi, functionName: "balanceOf" as const, args: [owner] as const})),
      allowFailure: true,
    });
    tokens.forEach((t, i) => out.set(t.toLowerCase(), res[i]?.status === "success" ? (res[i]!.result as bigint) : null));
  } catch {
    for (const t of tokens) out.set(t.toLowerCase(), null);
  }
  return out;
}

export interface ChainScanResult {
  approvals: ScannedApproval[];
  rows: ApprovalRow[];
  /** False when part of the history couldn't be read (the module's coverage gaps). */
  complete: boolean;
}

/** Forget the cached history of `owner` on `chainId` (a scan from scratch). */
export const forgetHistory = (chainId: number, owner: string): void => histories.drop(`${chainId}:${owner.toLowerCase()}`);

/** Scan `owner` on `chain` through `source`. Throws when the network or its source can't be read. */
export async function scanChain(chain: Chain, owner: string, source: HistorySource): Promise<ChainScanResult> {
  const chainId = chain.chainId!;
  const rpc = evmRpcUrls(chainId);
  if (!rpc.length) throw new Error(`No RPC for ${chain.name}`);
  const protocol = new ApprovalsProtocolEvm(
    {getAddress: async () => owner},
    {
      provider: [...rpc],
      chainId,
      source: sourceOf(chainId, source),
      cache: historyCache,
      ...(source.kind === "etherscan" ? {labels: new EtherscanLabels({chainId, baseUrl: source.url, fetch: pacedFetch, cache: labelCache})} : {}),
      concurrency: 2,
    },
  );
  const {approvals, coverage} = await protocol.getApprovals();
  const list = approvals.map((a) => scanned(a as EvmApproval));
  const erc20 = [...new Set(list.filter((a) => a.standard === "erc20" || a.standard === "permit2").map((a) => a.token))];
  const nfts = [...new Set(list.filter((a) => a.standard === "erc721" || a.standard === "erc721-token" || a.standard === "erc1155").map((a) => a.token))];
  const [tokens, balances, names] = await Promise.all([Promise.all(erc20.map((t) => tokenOf(chain, t))), balancesOf(chain, getAddress(owner), erc20), namesOf(chain, nfts)]);
  const byToken = new Map(erc20.map((t, i) => [t.toLowerCase(), tokens[i] ?? null]));
  const rows = list.map((a): ApprovalRow => {
    const fungible = a.standard === "erc20" || a.standard === "permit2";
    const label = spenderName(chain, a);
    return {
      approval: a,
      caip2: chain.caip2,
      chainName: chain.name,
      token: fungible ? (byToken.get(a.token.toLowerCase()) ?? null) : null,
      balance: fungible ? (balances.get(a.token.toLowerCase()) ?? null) : null,
      spenderName: label.name,
      verified: label.verified,
      ...(fungible ? {} : {collection: names.get(a.token.toLowerCase()) ?? null}),
    };
  });
  return {approvals: list, rows, complete: coverage.complete};
}
