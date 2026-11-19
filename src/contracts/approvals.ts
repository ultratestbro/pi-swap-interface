/**
 * Token approvals (D46, owner 2026-11-20): what an EVM address lets others spend — ERC-20 allowances, NFT operators and
 * per-token approvals, Permit2 allowances, an EIP-7702 delegation — found and verified by
 * @anywalletkit/protocol-approvals-evm, and revoked by the connected wallet (execute's `revoke`, the only signer).
 */
import type {PriceMap, Token} from "./domain";

export type ApprovalStandard = "erc20" | "erc721" | "erc721-token" | "erc1155" | "permit2" | "eip7702";

/** The module's approval, as its scan returns it (plain, structured-clone safe). */
export interface ScannedApproval {
  id: string;
  standard: ApprovalStandard;
  chainId: number;
  token: string;
  spender: string;
  /** Base units; null for an operator approval or a delegation. */
  amount: bigint | null;
  unlimited: boolean;
  tokenId?: string;
  expiration?: number;
  permit2?: string;
  risks: readonly string[];
  spenderLabel?: {name: string; url?: string};
  /** The log the approval was last set in (its block and transaction), when the history named it. */
  grantedAt?: {block: number; txHash: string};
}

/** One approval as the section shows it. */
export interface ApprovalRow {
  approval: ScannedApproval;
  caip2: string;
  chainName: string;
  /** The ERC-20 the allowance spends (erc20, permit2), read on-chain; null for NFTs, a delegation or an unreadable token. */
  token: Token | null;
  /** The owner's balance of that token, base units; null when not read. */
  balance: bigint | null;
  /** The spender's name: a venue cp0x Swap pins ("verified"), else the explorer's contract name. */
  spenderName: string | null;
  verified: boolean;
  /** An NFT approval's collection name (its name()), read on-chain; null when it has none. */
  collection?: string | null;
  /** How many of an ERC-721 collection's NFTs the owner holds (balanceOf); null when unread or an ERC-1155. */
  nftCount?: bigint | null;
  /** When the approval was last set (its block's time, ms); null when unknown. */
  updatedAt?: number | null;
}

export type ChainScanStatus = "queued" | "scanning" | "done" | "failed" | "unsupported";

export interface ChainScan {
  caip2: string;
  name: string;
  status: ChainScanStatus;
  /** Where the history came from. */
  source?: "etherscan" | "blockscout" | "routescan";
  /** Approvals found (done). */
  count?: number;
  /** Plain words (failed, unsupported). */
  note?: string;
}

export interface ApprovalsState {
  /** The address scanned (checksummed); null while none is given. */
  owner: string | null;
  chains: readonly ChainScan[];
  rows: readonly ApprovalRow[];
  scanning: boolean;
  /** USD per token key, for the rows' tokens (DefiLlama by contract); {} until known. */
  prices: PriceMap;
  /** An imported token's logo (`data:` URL) by token key. */
  logos: Readonly<Record<string, string>>;
}

/** approvals: the scan, per address (react state; the network only through the module and the runtime RPCs). */
export interface ApprovalsPort {
  /** Scans `owner` on every EVM network the page lists once it is set; idle while null. */
  useApprovals(owner: string | null): ApprovalsState & {
    /** Scan again; `fresh` forgets the cached history first. */
    rescan(fresh?: boolean): void;
    /** Re-read one network (after a revoke there). */
    rescanChain(caip2: string): void;
  };
}

/** What execute's `revoke` needs: the approval, everything the same scan found on its network, and the owner. */
export interface RevokeInput {
  owner: string;
  approval: ScannedApproval;
  scanned: readonly ScannedApproval[];
}
