/**
 * The public entry (`index.ts`) of every module, name by name. A module may
 * export more; it may not export less or change a signature —
 * src/contracts/conformance.ts fails the typecheck when it does. Effectful
 * APIs are the ports (ports.ts); everything else listed here is pure or
 * module-internal plumbing other modules call (never screens).
 */
import type {ReactNode} from "react";
import type {Chain as ViemChain, PublicClient} from "viem";
import type {Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import type {CrossChainProvider, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import type {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import type {NewRecordInput, RecordSide, StatusView, SwapRecord, SwapStatus, SwapStep} from "./activity";
import type {ProviderName} from "./config";
import type {
  Chain,
  ChainFamily,
  Family,
  Pair,
  PickerNetwork,
  RecipientCheck,
  SwapRecipient,
  SwapToken,
  Token,
  TokenAddress,
} from "./domain";
import type {ActivityPort, CatalogPort, ExecutePort, SwapPort, WalletsPort} from "./ports";
import type {PaySide, QuoteRequest, RoutePick, RouteRejection, RouteSnapshot, RoutesRequest, RouteView, VenueTrust, WebRoute} from "./routes";
import type {
  AssetIconProps,
  Breakpoint,
  ButtonProps,
  CardProps,
  FactsProps,
  FieldProps,
  GlassProps,
  IconButtonProps,
  IconProps,
  ProviderLogoProps,
  QrCodeProps,
  ReviewSkeletonProps,
  SheetHeaderProps,
  SheetProps,
  SkeletonProps,
  SpinnerProps,
  SwapStepsProps,
  SwitchProps,
  TagProps,
  TextProps,
  TilesProps,
  TokenIconProps,
  TxReviewCardProps,
  VenueBadgeProps,
} from "./ui";
import type {ConnectOptionGroups, WalletFamily, WalletOption} from "./wallets";

/** A function component with props P. */
type Component<P> = (props: P) => ReactNode;

/** src/catalog/index.ts */
export interface CatalogModule {
  catalogPort: CatalogPort;
  /** Every web chain, display order (catalog.md §2.3). */
  CHAIN_LIST: readonly Chain[];
  chainByCaip2Web(caip2: string): Chain | undefined;
  chainBySlugWeb(slug: string): Chain | undefined;
  /** Families the browser signs a source for: evm, solana, tron, ton, near. */
  SIGNING_FAMILIES: ReadonlySet<Family>;
  /** Signing families that pay from a deposit address (QR) while no wallet of theirs is connected: tron, ton, near (D20). */
  QR_FALLBACK_FAMILIES: ReadonlySet<Family>;
  TOKENS: readonly Token[];
  TOKEN_BY_KEY: ReadonlyMap<string, Token>;
  ZERO_ADDRESS: string;
  tokenKey(slug: string, contract: string | null): string;
  /** The engine's destination token id: contract, or the zero address for a native coin (every family). */
  destTokenId(t: Pick<Token, "contract">): string;
  matchesToken(t: SwapToken, q: string): boolean;
  PINNED_NETWORKS: readonly string[];
  pickerNetworks(tokens: readonly SwapToken[]): PickerNetwork[];
  pickSide(pair: Pair, side: "pay" | "receive", key: string): Pair;
  flipPair(pair: Pair): Pair;
  /** Pass only payMode "wallet" tokens as `pay` when choosing the opening pair. */
  defaultPair(pay: readonly SwapToken[], receive: readonly SwapToken[], prefer?: string): Pair | null;
  checkRecipient(input: string, family: Family): RecipientCheck;
  isAddressFor(family: Family, address: string): boolean;
  shortAddress(address: string, head?: number, tail?: number): string;
  /** EVM eth_getCode ≠ "0x" over the runtime RPC list (recipient warning). false off EVM. */
  isContractAddress(caip2: string, address: string): Promise<boolean>;
  txUrl(caip2: string, hash: string): string | undefined;
  addressUrl(caip2: string, address: string): string | undefined;
  formatUsd(value: number): string;
  formatAmount(amount: string, decimals: number): string;
  unitsToDecimal(amount: string, decimals: number): string;
  /** viem chain definitions for all EVM catalog chains (incl. Elysium 99901), RPCs = runtime config. */
  VIEM_CHAINS: readonly [ViemChain, ...ViemChain[]];
  /** Cached public client per chain over the runtime RPC list (fallback transport). Throws for an unknown chain id. */
  publicClient(chainId: number): PublicClient;
  /** Runtime-config RPC list for a chain id ([] when none). */
  evmRpcUrls(chainId: number): readonly string[];
  // ── imported tokens (D39) ──
  /** The search text as a token address: an EVM contract or Solana mint (importable), another family's address ("unsupported"), else null. */
  detectTokenAddress(input: string): TokenAddress | null;
  /** EVM networks and Solana (not receive-only): where a token can be imported in v1. */
  importable(chain: Pick<Chain, "family" | "receiveOnly"> | undefined): chain is Chain;
  /** An imported token's key: `<slug>:<contract>`, lowercased on EVM, verbatim on Solana. */
  importKey(chain: Pick<Chain, "slug" | "family">, contract: string): string;
  /** The catalog token at this contract on this network, if it is one. */
  listedToken(caip2: string, contract: string): Token | undefined;
  /** A pair link's key naming an importable unlisted token, or null. */
  parseTokenKey(key: string): {chain: Chain; address: string} | null;
  /** The address an import is read and cached under: checksummed on EVM, verbatim elsewhere. */
  canonicalTokenAddress(caip2: string, address: string): string;
  /** The listed token an imported one reads like on its network (symbol or name, look-alike letters folded), or null. */
  lookalikeOf(t: Pick<Token, "caip2" | "symbol" | "name">, listed?: readonly Token[]): Token | null;
}

/** src/wallets/index.ts */
export interface WalletsModule {
  walletsPort: WalletsPort;
  /** "eip155:…" → evm, "solana:…" → solana, "tron:…" → tron, "ton:…" → ton, "near:…" → near, else null (no connector). */
  familyOfCaip2(caip2: string): WalletFamily | null;
  /** The connect menu grouped by family, through usePorts() (demo wallets in demo mode). */
  useConnectOptions(): ConnectOptionGroups;
  /** Pure grouping behind useConnectOptions (installed first, WalletConnect last). */
  connectOptionGroups(options: readonly WalletOption[]): ConnectOptionGroups;
  /** WalletOption.id of WalletConnect (the screens show its pairing QR). */
  WALLETCONNECT_ID: string;
}

/** src/swap/index.ts */
export interface SwapModule {
  swapPort: SwapPort;
  // ── provider registry (providers.md §6) ──
  /** Built by default in every mode, in ask order (D3). */
  DEFAULT_ON_PROVIDERS: readonly ProviderName[];
  /** Built only in Standard mode, through cp0x's proxy (fynd, zeroex, across; D38). */
  STANDARD_ONLY_PROVIDERS: readonly ProviderName[];
  /** Every enabled provider, built once per page from runtime config. Never closed except on pagehide. */
  appProviders(): CrossChainProvider[];
  /** The unpriced router over appProviders() (discovery, tracking, only(name)). Never closed. */
  appRouter(): CrossChainRouter;
  // ── engine (engine.md §2.6) ──
  quoteParams(req: QuoteRequest): QuoteParams;
  /** A live round, or a preview round with per-venue placeholders inside the round only (D7). */
  quoteRoutes(r: RoutesRequest, onUpdate: (s: RouteSnapshot) => void, prices?: Readonly<Record<string, number>>): Promise<RouteSnapshot | null>;
  /** Both families have a preview placeholder (EVM, Solana, Bitcoin, TON, Tron, Zcash; not NEAR): previews can be priced. */
  canPreview(fromFamily: Family, toFamily: Family): boolean;
  requoteRoute(req: QuoteRequest, route: RoutePick, prices?: Readonly<Record<string, number>>): Promise<{route: WebRoute | null; reason: string | null}>;
  /** getSwap2Status over appRouter's providers (no account), plus the venue's "deposit arrived" the SDK drops (D36). */
  swapStatus(id: string, fromChain: string): Promise<{status: SwapStatus; transactions: {hash: string; type?: string}[]; depositReceived?: true}>;
  // ── display names / venue facts ──
  PROVIDER_NAMES: Readonly<Record<string, string>>;
  providerName(p: string): string;
  /** A route's name: "Circle CCTP · Standard" for a venue's named route (D47), else the venue's. */
  routeName(provider: string, routeId?: string): string;
  /** A route's identity: "cctp/fast", or the venue for a route without a routeId (D47). */
  routeKey(r: RoutePick): string;
  /** Delivery needs a claim on the destination chain: cctp. */
  TWO_PHASE: ReadonlySet<string>;
  VENUE_TRUST: Readonly<Record<string, VenueTrust>>;
  /** The spender a dry quote leaves unnamed (chainflip → CF_VAULTS, omniston → order protocol, zeroex → Permit2), or null. */
  orderSpender(provider: string, chain: string): string | null;
  /** 0x serves this EVM network on this page (the module's chains and Monad, D51): Permit2 is its one spender there. */
  zeroExServes(chain: string): boolean;
  /** Why an enabled venue isn't asked for this pair, in one line ("Same-network swaps only"). */
  venueScope(
    provider: string,
    from: {caip2: string; family: string; symbol: string; contract?: string | null},
    to: {caip2: string; family: string; symbol: string; contract?: string | null},
  ): string;
  // ── route list (mobile routes.ts) ──
  REFRESH_MS: number;
  /** Everything about a request that changes its quotes, mode first: useRoutes' key, and what a route on screen was quoted for (D32). */
  routesKey(r: RoutesRequest): string;
  orderRoutes<R extends RouteView>(routes: readonly R[]): R[];
  /** The selected route's key (routeKey) while it is still listed, else the best one's. */
  keepSelection(routes: readonly Pick<WebRoute, "provider" | "routeId" | "tags">[], selected: string | null): string | null;
  isStale(route: Pick<RouteView, "validUntilMs">, now?: number, marginMs?: number): boolean;
  friendlyReason(provider: string, reason: string, pay?: PaySide): string;
  /**
   * A venue's refusal text → short line, section, one sentence and the redacted original (refusals.ts, D28); `reason`
   * (the venue's Swap2RefusalReason) words a text no rule knows.
   */
  classifyRefusal(provider: string, raw: string, pay?: PaySide, reason?: Swap2RefusalReason): Omit<RouteRejection, "provider">;
  // ── amounts (mobile math.ts, send/amount.ts) ──
  sanitizeAmountInput(text: string, decimals: number): string;
  parseUnits(text: string, decimals: number): bigint | null;
  formatUnits(value: bigint, decimals: number): string;
  fieldText(value: bigint, decimals: number, digits?: number): string;
  formatFee(value: bigint, decimals: number, sig?: number): string;
  usdOf(value: bigint, decimals: number, priceUsd: number | undefined): number | undefined;
  autoSlippageBps(fromSymbol: string, toSymbol: string, sameChain?: boolean): number;
  slippageLabel(bps: number): string;
  executionFloor(minDest: bigint, toleranceBps?: bigint): bigint;
  impliedSlippagePct(expected: bigint, min: bigint): number;
  rate(amountIn: bigint, inDecimals: number, amountOut: bigint, outDecimals: number): number | null;
  formatRate(r: number): string;
  etaLabel(seconds: number | undefined): string;
  gasReserve(family: ChainFamily, nativeSymbol: string, decimals: number, chainId?: number): bigint;
  maxSwappable(balance: bigint, isNative: boolean, reserve: bigint): bigint;
  balanceProblem(amount: bigint | null, balance: bigint): string | null;
  /** owner null = no connected wallet on that family: the "own address" refusal does not apply. */
  swapRecipient(input: string, to: {family: Family; chainName: string; owner: string | null}): SwapRecipient;
}

/** src/execute/index.ts */
export interface ExecuteModule {
  executePort: ExecutePort;
  /** One line for a failed swap or claim (mobile execute.ts swapErrorText, web texts). */
  swapErrorText(e: unknown, nativeSymbol: string): string;
  swapFailureExpected(e: unknown): boolean;
  maybeSent(e: unknown): {id?: string; hash?: string} | null;
  encodeSwapId(provider: string, intentId: string, sourceTxHash?: string, destTxHash?: string, destTxConfirmed?: boolean): string;
  decodeSwapId(id: string): {provider: string; intentId: string; sourceTxHash?: string} | null;
  /** Advisory on EVM (the wallet picks gas), enforced off EVM. undefined = unpriced native → the review blocks Confirm. */
  swapFeeCap(family: ChainFamily, opts: {chainId?: number; nativeSymbol: string; decimals: number; nativePriceUsd?: number}): bigint | undefined;
  uncappedFeeText(nativeSymbol: string): string;
  FEE_CEILING: Readonly<Partial<Record<ChainFamily, bigint>>>;
  /**
   * Whether a TON wallet here signs `provider`'s contract call paid in `contract` (null = native TON) for `destToken`
   * on `destChain` (null = native; D35).
   */
  tonCallSigned(provider: string, contract: string | null, destChain: string, destToken: string | null): boolean;
  /**
   * Whether an Omniston swap on TON whose quote names these route steps (WebRoute `tonSwapSteps`) could be signed: one
   * step through a DEX pinned here (D35 part C). Only ever a reason to refuse; the gate decides by the BoC.
   */
  omnistonSwapRouteSigned(steps: readonly string[] | undefined): boolean;
}

/** src/activity/index.ts */
export interface ActivityModule {
  activityPort: ActivityPort;
  statusView(
    r: Pick<SwapRecord, "status" | "toSymbol" | "maybeSent"> &
      Partial<Pick<SwapRecord, "id" | "stage" | "fromSymbol" | "error" | "approved" | "provider" | "mode" | "deposit" | "sourceHash">>,
    toChainName: string,
  ): StatusView;
  swapSteps(r: SwapRecord, toChainName: string): SwapStep[];
  isFinal(s: SwapStatus): boolean;
  isLocalId(id: string): boolean;
  findSwap(list: readonly SwapRecord[], id: string | undefined): SwapRecord | undefined;
  newRecord(x: NewRecordInput, now?: number): SwapRecord;
  /** A swap side as its record keeps it (the token's key; an imported token's contract, D39). */
  recordSide(t: Pick<Token, "caip2" | "chain" | "symbol" | "decimals" | "key" | "contract" | "imported">): RecordSide;
  /** Unfinished swaps plus anything changed in the last 10 minutes (web: every payer in this browser). */
  visibleSwaps(list: readonly SwapRecord[], now?: number): SwapRecord[];
  STUCK_MS: number;
  // ── store (execute's runner writes through these; screens read through activityPort) ──
  loadSwaps(): Promise<void>;
  getSwaps(): readonly SwapRecord[];
  saveSwap(r: SwapRecord): void;
  replaceSwap(oldId: string, r: SwapRecord): void;
  updateSwap(id: string, change: (r: SwapRecord) => SwapRecord): SwapRecord | undefined;
  setRunning(id: string, on: boolean): void;
}

/** src/ui/index.ts — importing it also loads the global theme CSS (tokens.css, fonts.css, base.css). */
export interface UiModule {
  Text: Component<TextProps>;
  Button: Component<ButtonProps>;
  IconButton: Component<IconButtonProps>;
  Icon: Component<IconProps>;
  Card: Component<CardProps>;
  Field: Component<FieldProps>;
  Switch: Component<SwitchProps>;
  Skeleton: Component<SkeletonProps>;
  ReviewSkeleton: Component<ReviewSkeletonProps>;
  Spinner: Component<SpinnerProps>;
  Tag: Component<TagProps>;
  VenueBadge: Component<VenueBadgeProps>;
  Glass: Component<GlassProps>;
  Sheet: Component<SheetProps>;
  SheetHeader: Component<SheetHeaderProps>;
  Tiles: Component<TilesProps>;
  Facts: Component<FactsProps>;
  TxReviewCard: Component<TxReviewCardProps>;
  SwapSteps: Component<SwapStepsProps>;
  AssetIcon: Component<AssetIconProps>;
  TokenIcon: Component<TokenIconProps>;
  ProviderLogo: Component<ProviderLogoProps>;
  QrCode: Component<QrCodeProps>;
  /** phone < 640 ≤ tablet < 1024 ≤ desktop; updates on resize (matchMedia). */
  useBreakpoint(): Breakpoint;
}

/** src/screens/index.ts */
export interface ScreensModule {
  /** The whole app below the providers: AppShell + SwapForm + RoutesPanel + sheets. */
  SwapScreen: Component<Record<string, never>>;
  /** What App mounts for every hash path but `#/gallery` (the swap screen, which resolves demo scenes itself). */
  Routes: Component<Record<string, never>>;
}
