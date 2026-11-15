/**
 * Ports: the effectful half of each module's API (anything that reads the
 * network, a wallet or storage). Screens reach them only through
 * `usePorts()` (src/config/ports.tsx), so demo mode swaps every port for the
 * fixtures in src/mocks at one place (App.tsx) and the real modules never run
 * — no wallets, no network (D15). Pure helpers are imported directly.
 *
 * Hooks in a port are ordinary hooks: call them unconditionally, top level.
 * The port object is fixed for the page's lifetime (demo is decided at boot).
 */
import type {ComponentType, ReactNode} from "react";
import type {ActivityState, SwapRecord} from "./activity";
import type {Balance, Chain, Owners, PriceMap, SwapToken, Token, TokenLookup} from "./domain";
import type {
  ClaimPreview,
  ClaimResult,
  DepositTicket,
  IssueDepositInput,
  SourceSigner,
  StartSwapInput,
  SwapDraft,
} from "./execution";
import type {RequoteState, RoutesRequest, RoutesState} from "./routes";
import type {WalletsApi} from "./wallets";

export interface BalancesState {
  /** Token key → balance, for every token of every connected family. */
  byKey: Readonly<Record<string, Balance>>;
  /** Any balance query still loading. */
  loading: boolean;
  /** Re-read now (after a swap settles). */
  refresh(): void;
}

/** The token universe with the viewer's balances and prices (catalog.md §3.4 swapTokens, ui-port.md §4.5). */
export interface SwapTokensState {
  /**
   * Every catalog token, held first (by USD, then units), then catalog order with each chain's native first; then the
   * tokens imported in this browser (D39), held first among them, then newest first — never priced.
   */
  all: readonly SwapToken[];
  /** Pay side: payMode !== "none" (wallet, connect and deposit tokens). */
  pay: readonly SwapToken[];
  /** Receive side: every token (a wallet-less family pays out to a typed address). */
  receive: readonly SwapToken[];
  byKey: ReadonlyMap<string, SwapToken>;
  prices: PriceMap;
  loading: boolean;
  refresh(): void;
}

/** catalog: networks, tokens, balances, prices. */
export interface CatalogPort {
  useChains(): readonly Chain[];
  useTokens(): readonly Token[];
  useBalances(owners: Owners): BalancesState;
  /** {} until loaded, then one stable object per price update (the router and token list memoize on it). */
  usePrices(): PriceMap;
  useSwapTokens(owners: Owners): SwapTokensState;
  /**
   * Whether an EVM address holds contract code on `caip2` (an EIP-7702 delegated account counts as an account), for
   * the recipient's "this is a contract" warning: true / false once read, null while unknown, idle or not EVM. Never
   * blocks a swap (a Safe is a contract too); it is a port so the screen stays effect-free and demo stays offline.
   */
  useIsContract(caip2: string, address: string | null): boolean | null;
  /**
   * A pasted token address read on-chain for an import (D39): EVM — code, then decimals() (0..36), symbol() and name()
   * over the runtime RPCs; Solana — the mint account (SPL Token or Token-2022, initialized) and its Token-2022 or
   * Metaplex metadata over the runtime Solana RPCs. Never a token list, a third-party API or a venue. Idle while either
   * argument is null; cached per (network, address).
   */
  useTokenLookup(caip2: string | null, address: string | null): TokenLookup;
  /** Keep a confirmed import in this browser (D39; demo: in memory only). It joins useSwapTokens at once. */
  importToken(token: Token): void;
  /** Forget an imported token (by key) in this browser. */
  removeImportedToken(key: string): void;
}

/** wallets: connect / disconnect, and signers for execution. */
export interface WalletsPort {
  /** Wraps the app (WagmiProvider etc.). Must sit inside the app's QueryClientProvider. */
  Provider: ComponentType<{children: ReactNode}>;
  useWallets(): WalletsApi;
  /**
   * A signer for a source on `caip2`. EVM: switches the wallet to that chain
   * first (a wallet prompt) and binds the signer to it; Solana: the connected
   * Wallet Standard account; TON: the connected TON Connect wallet. Throws an `answered` Error with user text when not
   * connected or the switch is refused ("Switch your wallet to {Chain} to swap.").
   */
  getSigner(caip2: string): Promise<SourceSigner>;
}

/** swap: live quotes. */
export interface SwapPort {
  /**
   * Debounced streaming quote rounds (mobile useRoutes). Live: refreshed every 30 s while the tab is visible.
   * Preview: no timed refresh, each round (a refresh too) spends one of the tab's preview tokens (D29). null = idle.
   */
  useRoutes(r: RoutesRequest | null, prices: PriceMap): RoutesState & {refresh(): void};
  /** The review's re-quote of the drafted route every 30 s (requoteRoute). null draft = idle. */
  useRequote(draft: SwapDraft | null, prices: PriceMap): RequoteState & {refetch(): void};
}

/** execute: the only code that asks a wallet to sign. */
export interface ExecutePort {
  /** Resolves with the record id once the engine's first step starts; rejects if it fails before (mobile runner.startSwap). */
  startSwap(input: StartSwapInput): Promise<string>;
  /** Live deposit address for a QR payer; the record (mode "deposit") is saved before this resolves. */
  issueDeposit(input: IssueDepositInput): Promise<DepositTicket>;
  /** Read-only claim preview for a two-phase swap (null = attestation pending). */
  previewClaim(id: string): Promise<ClaimPreview | null>;
  /** Sends the claim from an EVM signer already on the destination chain; updates the record (claimHash, trackId). */
  claimSwap(id: string, signer: SourceSigner): Promise<ClaimResult>;
}

/** activity: persisted swaps and their tracking. */
export interface ActivityPort {
  useActivity(): ActivityState;
  /** The record by id or localId (findSwap); follows a local id after the engine renames it. */
  useSwap(id: string | null): SwapRecord | undefined;
  /** Mount once (App): loads the list, polls on schedule, re-polls on visibilitychange, leader tab only. */
  useSwapTracker(): void;
  /** "Refresh status" now. */
  pollSwap(id: string): Promise<SwapRecord | undefined>;
  /**
   * The viewer checked their wallet and saw no swap: an untracked maybe-sent record (a `local.` id, never polled)
   * becomes not-sent. Any other record is left as it is.
   */
  markNotSent(id: string): void;
}

export interface AppPorts {
  catalog: CatalogPort;
  wallets: WalletsPort;
  swap: SwapPort;
  execute: ExecutePort;
  activity: ActivityPort;
}
