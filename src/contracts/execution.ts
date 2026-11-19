/**
 * Review → execute contracts: the reviewed route Confirm authorizes, the
 * wallet handles execution signs with, and what an execution hands back.
 * Shapes follow docs/specs/engine.md §3, §6, §8 and mobile lib/swap/gate.ts.
 */
import type {Address, Chain as ViemChain, PublicClient, WalletClient} from "viem";
import type {Wallet, WalletAccount} from "@wallet-standard/base";
import type {SwapToken} from "./domain";
import type {QuoteRequest, WebRoute} from "./routes";

/** Copied from mobile lib/swap/gate.ts (756b115): the route the user confirmed on the review. */
export interface ReviewedSwap {
  provider: string;
  /** The venue's route the review showed (D47: CCTP "fast" | "standard"); the engine executes exactly it. Absent: the venue has one. */
  routeId?: string;
  fromChain: string;
  /** Source token contract; null = native. */
  fromContract: string | null;
  amountIn: bigint;
  destChain: string;
  destToken: string;
  recipient: string;
  refundAddress: string;
  /** The "Minimum received" the review showed (the execution floor). */
  minOut: bigint;
  /** The slippage the reviewed quote was asked with — the live quote is asked with the same. */
  slippageBps: number;
  /** The spender the review named; null = the route needs no approval. */
  approvalSpender: string | null;
  /** Native fee the reviewed quote charged on top of the input. */
  nativeFee: bigint;
}

/** Form → review handoff (mobile lib/swap/draft.ts, in React state instead of a module singleton). */
export interface SwapDraft {
  req: QuoteRequest;
  /** The route the user picked in the list. */
  route: WebRoute;
}

/** The engine's execution steps (swap2-core Swap2ExecutionPhase). */
export type ExecutionPhase = "approving" | "requoting" | "preflight" | "signing" | "broadcast";

/** swap2-core Swap2ExecutionPhaseDetail. */
export interface ExecutionPhaseDetail {
  index?: number;
  total?: number;
  hash?: string;
}

export type EvmTransport = "injected" | "walletconnect";

/**
 * An EVM wallet ready to sign on `chain`: wallets.getSigner switched the wallet
 * to that chain first. Only src/execute/accounts/** may call write methods on
 * `wallet` (ESLint rule, D10).
 */
export interface EvmSourceSigner {
  family: "evm";
  wallet: WalletClient;
  /** Public reads over the runtime RPC list (never the wallet's provider). */
  pub: PublicClient;
  chain: ViemChain;
  rpcUrls: readonly string[];
  owner: Address;
  transport: EvmTransport;
}

/** A Wallet Standard Solana wallet with `solana:signTransaction` (v1 requires it, engine.md §6.2). */
export interface SolanaSourceSigner {
  family: "solana";
  wallet: Wallet;
  account: WalletAccount;
  rpcUrls: readonly string[];
}

/**
 * The TronWeb an injected Tron wallet hands this origin (TronLink: `window.tron.tronWeb`), as far as execution reads
 * it. As untrusted as any wallet object: src/execute/accounts/tron.ts checks every answer it gives.
 */
export interface TronWebLike {
  defaultAddress?: {base58?: unknown};
  trx?: {sign?: unknown};
}

/** An injected Tron wallet: it only signs (`trx.sign`); the app builds, checks and broadcasts (D11, D20). */
export interface TronSourceSigner {
  family: "tron";
  tronWeb: TronWebLike;
  /** Base58 (T…): the connected account, which must be the reviewed refund address. */
  owner: string;
  walletName: string;
  /** The runtime config's Tron HTTP API hosts (`tronApi`), tried in order. */
  apiUrls: readonly string[];
}

/** A TON Connect `sendTransaction` request (the SDK's SendTransactionRequest), so execute needs no SDK import. */
export interface TonConnectRequest {
  /** Unix seconds. */
  validUntil: number;
  /** "-239" (mainnet). */
  network: string;
  /** The sender, raw `0:<hex>`. */
  from: string;
  messages: {address: string; amount: string; payload?: string; stateInit?: string}[];
}

/** The connected TON Connect wallet as execute reaches it. Only src/execute/accounts/** may call it (D10). */
export interface TonSender {
  /** The wallet's account right now (raw address, TON Connect network id); null once it disconnected. */
  readonly account: {address: string; chain: string} | null;
  /** How the wallet is reached: "injected" (its extension's JS bridge) or "http" (TON Connect's bridge); absent counts as "http". */
  readonly wallet?: {provider: "http" | "injected"} | null;
  sendTransaction(tx: TonConnectRequest, options?: {onRequestSent?: () => void; signal?: AbortSignal}): Promise<{boc: string}>;
}

/** A TON Connect wallet on TON mainnet: the wallet builds, signs and sends the message execute hands it. */
export interface TonSourceSigner {
  family: "ton";
  /** User-friendly, non-bounceable (UQ…): the reviewed refund address. */
  address: string;
  /** Raw `0:<hex>`, as the wallet reported it. */
  rawAddress: string;
  walletName: string;
  sender: TonSender;
  /** TonAPI base (runtime config `tonApiUrl`): the jetton wallet lookup. */
  tonApiUrl: string;
}

/**
 * A NEAR wallet as a browser extension injects it (NEAR Connect's `near-wallet-injected` event, D11): only the
 * members used here. The wallet builds, signs and broadcasts; only src/execute/accounts/** may call
 * `signAndSendTransaction` (D10).
 */
export interface NearInjectedWallet {
  manifest: {id: string; name: string; icon?: string; features?: Readonly<Record<string, unknown>>};
  signIn(data?: {network?: "mainnet"}): Promise<unknown>;
  signOut(data?: {network?: "mainnet"}): Promise<unknown>;
  getAccounts(data?: {network?: "mainnet"}): Promise<unknown>;
  signAndSendTransaction(params: {network: "mainnet"; signerId: string; receiverId: string; actions: readonly unknown[]}): Promise<unknown>;
}

/** A connected NEAR account (implicit or `.near`) and the injected wallet that signs for it. */
export interface NearSourceSigner {
  family: "near";
  wallet: NearInjectedWallet;
  accountId: string;
  /** NEAR JSON-RPCs for the account's own reads (its NEAR balance, a token's storage registration). */
  rpcUrls: readonly string[];
}

export type SourceSigner = EvmSourceSigner | SolanaSourceSigner | TronSourceSigner | TonSourceSigner | NearSourceSigner;

/** What swap2() returned (mobile ExecuteResult). */
export interface ExecuteResult {
  /** awk1.<provider>.<intent>[.<srcHash>…] — all tracking needs. */
  id: string;
  hash?: string;
  depositTo?: string;
}

/** Confirm → execution (mobile runner StartSwapInput; the web passes the signer instead of an account id). */
export interface StartSwapInput {
  from: SwapToken;
  to: SwapToken;
  reviewed: ReviewedSwap;
  /** The re-quoted destAmount the review showed ("≈"). */
  expectedOut: bigint;
  signer: SourceSigner;
  nativePriceUsd?: number;
  /** After the outcome is known (balances moved, or the approval was revoked). */
  onSettled?: () => void;
}

/** "Get deposit address" for a QR payer (engine.md §9): a live (non-dry) quote from one provider, held to the reviewed floor. */
export interface IssueDepositInput {
  req: QuoteRequest;
  provider: string;
  /** The venue's route the review showed (D47), when it has several. */
  routeId?: string;
  /** executionFloor(route.minDestAmount) — the minimum the review showed. */
  minOut: bigint;
}

/** A live deposit address the payer sends to from any wallet. Saved as a `mode: "deposit"` SwapRecord before it is shown. */
export interface DepositTicket {
  /** encodeSwapId(provider, intentId) — the record's id. */
  id: string;
  provider: string;
  intentId: string;
  depositAddress: string;
  /** Always null in v1 (memo routes are refused for QR payers). */
  depositMemo: string | null;
  /** Exact base units to send. */
  sourceAmount: bigint;
  destAmount: bigint;
  minDestAmount: bigint;
  /** Deposit deadline (unix ms). */
  validUntilMs: number;
  etaSeconds: number;
}

/** A two-phase route's claim, read-only, shown before the user confirms it (engine.md §8.3). */
export interface ClaimPreview {
  chain: string;
  to: string;
  data: string;
  value: bigint;
}

/** claimSwap2's answer: poll the NEW id from here on. */
export interface ClaimResult {
  hash: string;
  chain: string;
  id: string;
}
