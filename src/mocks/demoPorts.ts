/**
 * Demo ports (D15): every port backed by fixtures and timers — no wallet, no
 * network, no storage. App.tsx uses these when demo mode is on; the contracts
 * phase stubs re-export them until each owner ships the real module. Quotes
 * stream like the real auction (pending → routes → a refusal) and respond to
 * the amount and pair, so the form, list and review can be reviewed live.
 * Preview rounds (no wallet yet, D7) skip LI.FI and spend the same per-tab
 * preview budget as the real port (D29), so the limiter is reviewable too.
 */
import {createElement, Fragment, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode} from "react";
import type {ActivityItem, ActivityState, ActivityUrgency, StatusView, SwapRecord} from "../contracts/activity";
import type {Owners, PriceMap, SwapToken, Token, TokenLookup} from "../contracts/domain";
import type {
  ClaimPreview,
  ClaimResult,
  DepositTicket,
  ExecutionPhase,
  IssueDepositInput,
  SourceSigner,
  StartSwapInput,
  SwapDraft,
} from "../contracts/execution";
import type {
  ActivityPort,
  AppPorts,
  BalancesState,
  CatalogPort,
  ExecutePort,
  SwapPort,
  SwapTokensState,
  WalletsPort,
} from "../contracts/ports";
import type {QuoteRequest, RequoteState, RouteRejection, RouteSnapshot, RoutesRequest, RoutesState, VenueTrust, WebRoute} from "../contracts/routes";
import type {WalletFamily, WalletOption, WalletsApi, WalletsState} from "../contracts/wallets";
import {demoWallets} from "../config/demo";
import {createTokenBucket, type TokenBucket} from "../config/pacing";
import {getRuntimeConfig} from "../config/runtime";
import {chainByCaip2} from "../shared/chains";
import {
  DEMO_BALANCES,
  DEMO_CHAINS,
  DEMO_DEPOSIT_ADDRESS,
  DEMO_EVM_ADDRESS,
  DEMO_IMPORTABLE,
  DEMO_PRICES,
  DEMO_REFUSALS,
  DEMO_SOLANA_ADDRESS,
  DEMO_TRON_ADDRESS,
  DEMO_TON_ADDRESS,
  DEMO_TOKENS,
  demoActivity,
  demoSwapTokens,
} from "./fixtures";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A tiny external store: a lazily created value, subscribers, a setter. get() never notifies (safe in render). */
function store<T>(init: () => T) {
  let value: T | undefined;
  const listeners = new Set<() => void>();
  return {
    get: (): T => (value ??= init()),
    set(next: T | undefined) {
      value = next;
      for (const l of listeners) l();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

// ── wallets ──────────────────────────────────────────────────────────────────────────────────────────────────────

const OPTIONS: readonly WalletOption[] = [
  {id: "io.metamask", family: "evm", name: "MetaMask", kind: "injected"},
  {id: "walletconnect", family: "evm", name: "WalletConnect", kind: "walletconnect"},
  {id: "Phantom", family: "solana", name: "Phantom", kind: "wallet-standard"},
  {id: "tron:org.tronlink.www", family: "tron", name: "TronLink", kind: "injected"},
  {id: "tonconnect", family: "ton", name: "TON Connect", kind: "tonconnect"},
];

function initialWallets(): WalletsState {
  const w = demoWallets();
  const evm = w === "evm" || w === "both";
  const sol = w === "solana" || w === "both";
  return {
    evm: evm ? {family: "evm", address: DEMO_EVM_ADDRESS, chainId: 42161, walletName: "MetaMask", transport: "injected"} : null,
    solana: sol ? {family: "solana", address: DEMO_SOLANA_ADDRESS, walletName: "Phantom"} : null,
    tron: null,
    ton: null,
    near: null,
    owners: {...(evm ? {evm: DEMO_EVM_ADDRESS} : {}), ...(sol ? {solana: DEMO_SOLANA_ADDRESS} : {})},
    options: OPTIONS,
    connecting: null,
    pairingUri: null,
    error: null,
  };
}

const wallets = store<WalletsState>(initialWallets);
const walletState = wallets.get;

async function connect(optionId: string): Promise<void> {
  const opt = OPTIONS.find((o) => o.id === optionId);
  if (!opt) return;
  wallets.set({...walletState(), connecting: optionId, error: null});
  await sleep(500);
  const s = walletState();
  // TON's one option is TON Connect's modal, where the viewer picks the wallet: the demo's is Tonkeeper.
  const next: WalletsState =
    opt.family === "evm"
      ? {...s, evm: {family: "evm", address: DEMO_EVM_ADDRESS, chainId: 42161, walletName: opt.name, transport: opt.kind === "walletconnect" ? "walletconnect" : "injected"}}
      : opt.family === "solana"
        ? {...s, solana: {family: "solana", address: DEMO_SOLANA_ADDRESS, walletName: opt.name}}
        : opt.family === "tron"
          ? {...s, tron: {family: "tron", address: DEMO_TRON_ADDRESS, walletName: opt.name}}
          : {...s, ton: {family: "ton", address: DEMO_TON_ADDRESS, walletName: "Tonkeeper"}};
  wallets.set({...next, owners: ownersOf(next), connecting: null});
}

async function disconnect(family: WalletFamily): Promise<void> {
  const s = walletState();
  const next: WalletsState = {...s, [family]: null};
  wallets.set({...next, owners: ownersOf(next)});
}

const ownersOf = (s: Pick<WalletsState, "evm" | "solana" | "tron" | "ton">): Owners => ({
  ...(s.evm ? {evm: s.evm.address} : {}),
  ...(s.solana ? {solana: s.solana.address} : {}),
  ...(s.tron ? {tron: s.tron.address} : {}),
  ...(s.ton ? {ton: s.ton.address} : {}),
});

function useDemoWallets(): WalletsApi {
  const s = useSyncExternalStore(wallets.subscribe, walletState, walletState);
  return useMemo(() => ({...s, connect, disconnect}), [s]);
}

export const demoWalletsPort: WalletsPort = {
  Provider: ({children}: {children: ReactNode}) => createElement(Fragment, null, children),
  useWallets: useDemoWallets,
  async getSigner(caip2: string): Promise<SourceSigner> {
    await sleep(300);
    const family = caip2.startsWith("solana:") ? "solana" : caip2.startsWith("tron:") ? "tron" : caip2.startsWith("ton:") ? "ton" : "evm";
    const s = walletState();
    const article = {evm: "an EVM", solana: "a Solana", tron: "a Tron", ton: "a TON"}[family];
    if (!s[family]) throw Object.assign(new Error(`Connect ${article} wallet first.`), {answered: true});
    // Demo only: the demo execute port never touches the signer, so an inert stand-in is enough.
    return {family, demo: true} as unknown as SourceSigner;
  },
};

// ── catalog ──────────────────────────────────────────────────────────────────────────────────────────────────────

function useDemoBalances(owners: Owners): BalancesState {
  return useMemo(() => {
    const byKey = {...(owners.evm ? DEMO_BALANCES.evm : {}), ...(owners.solana ? DEMO_BALANCES.solana : {})};
    return {byKey, loading: false, refresh: () => {}};
  }, [owners.evm, owners.solana]);
}

/** Demo imports (D39): in memory only — demo mode writes no storage. */
const demoImports = store<readonly Token[]>(() => []);

/** An imported token with the viewer's state: unpriced, no balance read offline. */
const importedSwapToken = (t: Token, owners: Owners): SwapToken => {
  const owner = owners[t.family] ?? null;
  return {...t, amount: "0", balance: owner ? "loaded" : "none", usd: 0, owner, payMode: owner ? "wallet" : "connect"};
};

function useDemoSwapTokens(owners: Owners): SwapTokensState {
  const imported = useSyncExternalStore(demoImports.subscribe, demoImports.get, demoImports.get);
  return useMemo(() => {
    const all = [...demoSwapTokens(owners), ...imported.map((t) => importedSwapToken(t, owners))];
    return {
      all,
      pay: all.filter((x) => x.payMode !== "none"),
      receive: all,
      byKey: new Map(all.map((x) => [x.key, x])),
      prices: DEMO_PRICES,
      loading: false,
      refresh: () => {},
    };
  }, [owners, imported]);
}

/** Offline reads: DEMO_IMPORTABLE by network and address; anything else isn't found (demo contacts no network). */
function useDemoTokenLookup(caip2: string | null, address: string | null): TokenLookup {
  if (!caip2 || !address) return {status: "idle"};
  const a = address.toLowerCase();
  const token = DEMO_IMPORTABLE.find((t) => t.caip2 === caip2 && t.contract?.toLowerCase() === a);
  return token ? {status: "found", token} : {status: "failed", reason: "Demo mode reads only its sample tokens — no network is contacted."};
}

/** Offline contract check: a fixture token's own contract address reads as a contract, so the warning is reviewable. */
function useDemoIsContract(caip2: string, address: string | null): boolean | null {
  if (!address || !caip2.startsWith("eip155:")) return null;
  const a = address.toLowerCase();
  return DEMO_TOKENS.some((t) => t.caip2 === caip2 && t.contract?.toLowerCase() === a);
}

export const demoCatalogPort: CatalogPort = {
  useChains: () => DEMO_CHAINS,
  useTokens: () => DEMO_TOKENS,
  useBalances: useDemoBalances,
  usePrices: () => DEMO_PRICES,
  useSwapTokens: useDemoSwapTokens,
  useIsContract: useDemoIsContract,
  useTokenLookup: useDemoTokenLookup,
  importToken: (t) => demoImports.set([t, ...demoImports.get().filter((x) => x.key !== t.key)]),
  removeImportedToken: (key) => demoImports.set(demoImports.get().filter((x) => x.key !== key)),
};

// ── swap ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Venue {
  provider: string;
  /** Applies to this pair. */
  serves(from: SwapToken, to: SwapToken): boolean;
  /** Output lost to fees, bps. */
  costBps: number;
  /** Guaranteed minimum below the quote at 0.5 % slippage, bps (0: fills at the quote); the request's own moves it. */
  slipBps: number;
  eta: number;
  /** When it answers in the round, ms. */
  delayMs: number;
  trust: VenueTrust;
  execution: WebRoute["execution"];
  spender?: string;
  hasMemo?: boolean;
  /** Answers with this refusal (in the app's words, src/mocks DEMO_REFUSALS) instead of a quote, or null to quote. */
  refuses?: (req: Priced) => Omit<RouteRejection, "provider"> | null;
}

/** What a demo price depends on: a live request and a preview alike. */
type Priced = Pick<QuoteRequest, "from" | "to" | "amountIn" | "slippageBps">;

/** The slippage the venues' `slipBps` are set for: a request's own setting moves each minimum by the difference. */
const BASE_SLIPPAGE_BPS = 50;

const evm = (x: SwapToken) => x.family === "evm";
const cross = (a: SwapToken, b: SwapToken) => a.caip2 !== b.caip2;
const CHAINFLIP_CHAINS = new Set(["ethereum", "arbitrum", "solana", "bitcoin"]);
const CHAINFLIP_ASSETS = new Set(["ETH", "BTC", "SOL", "USDC", "USDT"]);
const STABLES = new Set(["USDC", "USDT", "DAI"]);
/** The demo's EVM networks on Balancer's, Symbiosis' and Omniston's lists alike (Elysium is on none). */
const BIG_EVM = new Set(["ethereum", "arbitrum", "base"]);

/** Venues whose providers take a token the catalog doesn't list (D39, probed 2026-11-15): the rest sit an import out. */
const ANY_TOKEN_VENUES: ReadonlySet<string> = new Set(["uniswap", "curve", "balancer", "lifi", "relay", "jupiter", "fynd", "zeroex"]);

/** The page's default venues (DEFAULT_ON_PROVIDERS order), each with the pairs it serves here and how it answers. */
const VENUES: readonly Venue[] = [
  {provider: "uniswap", serves: (a, b) => !cross(a, b) && evm(a), costBps: 30, slipBps: 50, eta: 12, delayMs: 350, trust: "contracts", execution: "calldata", spender: "0x2626664c2603336E57B271c5C0b26F421741e481"},
  // Stablecoin swaps on Ethereum through its pinned Router NG (the demo's pairs are mostly cross-network: it sits out).
  {provider: "curve", serves: (a, b) => !cross(a, b) && a.chain === "ethereum" && STABLES.has(a.symbol) && STABLES.has(b.symbol), costBps: 2, slipBps: 10, eta: 12, delayMs: 400, trust: "contracts", execution: "calldata", spender: "0x45312ea0eFf7E09C83CBE249fa1d7598c4C8cd4e"},
  // The Vault's v2 pools, a little thinner than Uniswap's here.
  {provider: "balancer", serves: (a, b) => !cross(a, b) && BIG_EVM.has(a.chain), costBps: 35, slipBps: 50, eta: 15, delayMs: 550, trust: "contracts", execution: "calldata", spender: "0xBA12222222228d8Ba445958a75a0704d566BF2C8"},
  // No WETH among the demo tokens: listed under "Not for this pair" everywhere.
  {provider: "wrap", serves: () => false, costBps: 0, slipBps: 0, eta: 12, delayMs: 200, trust: "contracts", execution: "calldata"},
  {provider: "usdt0", serves: (a, b) => cross(a, b) && evm(a) && evm(b) && a.symbol.startsWith("USDT") && b.symbol.startsWith("USDT"), costBps: 2, slipBps: 0, eta: 60, delayMs: 400, trust: "contracts", execution: "calldata"},
  {provider: "cctp", serves: (a, b) => cross(a, b) && evm(a) && evm(b) && a.symbol === "USDC" && b.symbol === "USDC", costBps: 1.5, slipBps: 0, eta: 45, delayMs: 300, trust: "contracts", execution: "calldata", spender: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"},
  {provider: "thorchain", serves: (a, b) => cross(a, b) && a.family === "btc" && evm(b), costBps: 25, slipBps: 100, eta: 900, delayMs: 900, trust: "own-node", execution: "deposit", hasMemo: true},
  {
    provider: "chainflip",
    serves: (a, b) => cross(a, b) && a.family !== "btc" && CHAINFLIP_CHAINS.has(a.chain) && CHAINFLIP_CHAINS.has(b.chain) && CHAINFLIP_ASSETS.has(a.symbol) && CHAINFLIP_ASSETS.has(b.symbol),
    costBps: 18,
    slipBps: 100,
    eta: 240,
    delayMs: 700,
    trust: "provider-api",
    execution: "calldata",
    // Its minimum deposit: 0.01 ETH, 20 USDC.
    refuses: ({from, amountIn}) =>
      from.symbol === "ETH" && amountIn < 10n ** 16n ? DEMO_REFUSALS.minimumEth : from.symbol === "USDC" && amountIn < 20_000_000n ? DEMO_REFUSALS.minimumUsdc : null,
  },
  {provider: "near_intents", serves: (a, b) => cross(a, b), costBps: 7, slipBps: 100, eta: 27, delayMs: 450, trust: "provider-api", execution: "deposit"},
  {
    provider: "lifi",
    // Like providers.ts: EVM and Solana, never asked EVM → Solana (its SDK can't check that recipient yet).
    serves: (a, b) => (evm(a) || a.family === "solana") && (evm(b) || b.family === "solana") && !(evm(a) && b.family === "solana"),
    costBps: 0,
    slipBps: 0,
    eta: 0,
    delayMs: 1400,
    trust: "provider-api",
    execution: "calldata",
    // The owner's case: a route to Ethereum whose transaction pays someone else is skipped; elsewhere it times out.
    refuses: ({from, to}) => (cross(from, to) && to.chain === "ethereum" ? DEMO_REFUSALS.paysElsewhere : DEMO_REFUSALS.timeout),
  },
  {provider: "relay", serves: (a, b) => cross(a, b) && evm(a) && evm(b), costBps: 43, slipBps: 100, eta: 2, delayMs: 600, trust: "provider-api", execution: "calldata", spender: "0x4cd00e387622c35bddb9b4c962c136462338bc31"},
  // Paced at 1 request/s, so it answers late; the MetaRouterGateway is the spender.
  {provider: "symbiosis", serves: (a, b) => cross(a, b) && BIG_EVM.has(a.chain) && BIG_EVM.has(b.chain), costBps: 12, slipBps: 50, eta: 64, delayMs: 1300, trust: "provider-api", execution: "calldata", spender: "0x3743c756b64ECd0770f1d4f47696A73d2A46dcbe"},
  {provider: "jupiter", serves: (a, b) => !cross(a, b) && a.family === "solana", costBps: 20, slipBps: 50, eta: 5, delayMs: 500, trust: "provider-api", execution: "calldata"},
  {
    provider: "omniston",
    // Asked for any pair between its networks, as its module is; a native coin on either side is refused.
    serves: (a, b) => cross(a, b) && BIG_EVM.has(a.chain) && BIG_EVM.has(b.chain),
    costBps: 5,
    // An HTLC order fills at the quoted amount or refunds.
    slipBps: 0,
    eta: 240,
    delayMs: 1800,
    trust: "provider-api",
    execution: "calldata",
    spender: "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
    refuses: ({from, to}) => (from.contract && to.contract ? null : DEMO_REFUSALS.nativeLeg),
  },
];

const priceOf = (x: SwapToken, prices: PriceMap) => x.priceUsd ?? prices[x.symbol] ?? prices[x.catalogSymbol];

function quoteOf(v: Venue, req: Priced, prices: PriceMap, now: number): WebRoute {
  const {from, to, amountIn} = req;
  const pIn = priceOf(from, prices) ?? 1;
  const pOut = priceOf(to, prices) ?? 1;
  const usdIn = (Number(amountIn) / 10 ** from.decimals) * pIn;
  const dest = BigInt(Math.max(0, Math.floor(((usdIn / pOut) * 10 ** to.decimals * (10_000 - v.costBps)) / 10_000)));
  // A venue that holds the user's slippage moves its minimum with it, so a new slippage shows in the list (D32).
  const slip = v.slipBps > 0 ? Math.max(1, v.slipBps + req.slippageBps - BASE_SLIPPAGE_BPS) : 0;
  const min = (dest * BigInt(10_000 - slip)) / 10_000n;
  const gasUsd = evm(from) ? 0.02 + (v.spender && from.contract ? 0.01 : 0) : null;
  return {
    provider: v.provider,
    sourceAmount: amountIn,
    destAmount: dest,
    minDestAmount: min,
    etaSeconds: v.eta,
    feeUsd: 0,
    fees: [],
    tags: [],
    relativeValue: 1,
    netValueUsd: (Number(min) / 10 ** to.decimals) * pOut - (gasUsd ?? 0),
    approvalSpender: from.contract && v.spender ? v.spender : null,
    nativeFee: 0n,
    validUntilMs: now + 60_000,
    gasUsd,
    execution: v.execution,
    hasMemo: !!v.hasMemo,
    trust: v.trust,
  };
}

/** Ranked like the auction: relativeValue vs the best minimum, "best" = top value, "fastest" = lowest eta when another route. */
function rank(routes: WebRoute[]): WebRoute[] {
  if (!routes.length) return routes;
  const top = routes.reduce((m, r) => (r.minDestAmount > m ? r.minDestAmount : m), 0n);
  const scored = routes.map((r) => ({...r, relativeValue: top > 0n ? Number((r.minDestAmount * 10_000n) / top) / 10_000 : 0, tags: [] as WebRoute["tags"]}));
  scored.sort((a, b) => b.relativeValue - a.relativeValue || a.etaSeconds - b.etaSeconds);
  const fastest = scored.reduce((f, r) => (r.etaSeconds < f.etaSeconds ? r : f));
  scored[0]!.tags = ["best"];
  if (fastest !== scored[0] && scored.length > 1) fastest.tags = ["fastest"];
  return scored;
}

const reqKey = ({mode, req}: RoutesRequest) =>
  `${mode}|${req.from.key}|${req.to.key}|${req.amountIn}|${req.slippageBps}|${req.recipient ?? ""}|${req.refundAddress ?? ""}|${"toOther" in req && req.toOther ? "other" : "own"}`;

const IDLE: RoutesState = {snapshot: null, loading: false, error: null, updatedAt: 0, limitedUntil: 0};

/** The tab's preview budget, sized like the real port's (runtime config `preview`); resetDemoState empties it. */
let previewBucket: TokenBucket | null = null;
const bucket = (): TokenBucket => (previewBucket ??= createTokenBucket(getRuntimeConfig().preview.roundsBurst, getRuntimeConfig().preview.roundRefillMs));

/**
 * How a venue sits out a preview round (`skipped`, nothing sent): LI.FI waits for the live quote, as on a page whose
 * cp0x proxy doesn't carry it (demo contacts nothing); Jupiter / Wrap on "another address".
 */
function previewRefusal(v: Venue, r: RoutesRequest): Omit<RouteRejection, "provider"> | null {
  if (r.mode !== "preview") return null;
  if (v.provider === "lifi") return {...DEMO_REFUSALS.liveOnly, skipped: true};
  return r.req.toOther && (v.provider === "jupiter" || v.provider === "wrap") ? {...DEMO_REFUSALS.signerOnly, skipped: true} : null;
}

function useDemoRoutes(r: RoutesRequest | null, prices: PriceMap): RoutesState & {refresh(): void} {
  // The state belongs to one key: a new pair, amount or mode (preview → live) never shows the old key's rows.
  const [slot, setSlot] = useState<{key: string | null; state: RoutesState}>({key: null, state: IDLE});
  const [tick, setTick] = useState(0);
  const key = r ? reqKey(r) : null;
  useEffect(() => {
    if (!r) return;
    const {mode, req} = r;
    const venues = VENUES.filter((v) => v.serves(req.from, req.to) && (!(req.from.imported || req.to.imported) || ANY_TOKEN_VENUES.has(v.provider)));
    const asked = venues.map((v) => v.provider);
    const all = VENUES.map((v) => v.provider);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const round = () => {
      // A preview round spends a token of the tab's budget, or waits for the next one (D29).
      let limitedUntil = 0;
      if (mode === "preview") {
        if (!bucket().take()) {
          const at = bucket().nextAt();
          setSlot((s) => ({key, state: {...(s.key === key ? s.state : IDLE), loading: false, limitedUntil: at}}));
          timers.push(setTimeout(round, Math.max(1, at - Date.now())));
          return;
        }
        limitedUntil = bucket().nextAt();
      }
      const now = Date.now();
      const routes: WebRoute[] = [];
      const rejections: RouteSnapshot["rejections"] = [];
      let pending = [...asked];
      // A refresh keeps the old list until the first answer; a new key starts empty.
      setSlot((s) => {
        const prev = s.key === key ? s.state : IDLE;
        return {key, state: {...prev, loading: true, error: null, limitedUntil, snapshot: {mode, routes: prev.snapshot?.routes ?? [], pending, rejections: [], asked, venues: all}}};
      });
      for (const v of venues) {
        const skip = previewRefusal(v, r);
        timers.push(
          setTimeout(
            () => {
              pending = pending.filter((p) => p !== v.provider);
              const refusal = skip ?? v.refuses?.(req);
              if (refusal) rejections.push({provider: v.provider, ...refusal});
              else routes.push(quoteOf(v, req, prices, now));
              const done = pending.length === 0;
              setSlot({
                key,
                state: {
                  snapshot: {mode, routes: rank([...routes]), pending: [...pending], rejections: [...rejections], asked, venues: all},
                  loading: !done,
                  error: null,
                  updatedAt: done ? Date.now() : 0,
                  limitedUntil,
                },
              });
            },
            skip ? 50 : v.delayMs,
          ),
        );
      }
    };
    // Every update comes from a timer, like venues answering.
    timers.push(setTimeout(round, 0));
    return () => timers.forEach(clearTimeout);
    // The key captures everything about r that changes the quote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  return useMemo(() => {
    const state = key === null ? IDLE : slot.key === key ? slot.state : {...IDLE, loading: true};
    return {...state, refresh: () => setTick((x) => x + 1)};
  }, [key, slot]);
}

function useDemoRequote(draft: SwapDraft | null, prices: PriceMap): RequoteState & {refetch(): void} {
  const [tick, setTick] = useState(0);
  const [fresh, setFresh] = useState<{for: SwapDraft; route: WebRoute} | null>(null);
  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(() => {
      const v = VENUES.find((x) => x.provider === draft.route.provider);
      const route = v && !v.refuses?.(draft.req) ? {...quoteOf(v, draft.req, prices, Date.now()), tags: draft.route.tags} : {...draft.route, validUntilMs: Date.now() + 60_000};
      setFresh({for: draft, route});
    }, 600);
    const every = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => {
      clearTimeout(t);
      clearInterval(every);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, tick]);
  return useMemo(() => {
    const mine = fresh && fresh.for === draft ? fresh.route : null;
    return {route: mine ?? draft?.route ?? null, gone: null, failed: false, loading: !!draft && !mine, refetch: () => setTick((x) => x + 1)};
  }, [draft, fresh]);
}

export const demoSwapPort: SwapPort = {useRoutes: useDemoRoutes, useRequote: useDemoRequote};

// ── activity ─────────────────────────────────────────────────────────────────────────────────────────────────────

const records = store<readonly SwapRecord[]>(() => demoActivity());
const recordList = records.get;

function upsertRecord(r: SwapRecord, replaceId?: string) {
  records.set([r, ...recordList().filter((x) => x.id !== r.id && x.id !== replaceId)].sort((a, b) => b.createdAt - a.createdAt));
}

function patchRecord(id: string, change: (r: SwapRecord) => SwapRecord) {
  const r = recordList().find((x) => x.id === id);
  if (r) upsertRecord({...change(r), id});
}

const chainName = (caip2: string) => chainByCaip2(caip2)?.name ?? caip2;

/** Enough of activity's statusView for the demo drawer (the real one is mobile inflight.ts + ui-port.md §4.6). */
function demoStatusView(r: SwapRecord): StatusView {
  const to = chainName(r.toChain);
  switch (r.status) {
    case "submitting":
      return {label: r.stage === "approving" ? `Approving ${r.fromSymbol}` : r.stage === "signing" ? "Signing the swap" : "Sending the swap", tone: "progress", detail: "Keep this tab open until the swap is sent."};
    case "pending":
      if (r.mode === "deposit" && !r.sourceHash) return {label: "Waiting for your deposit", tone: "action", detail: "Send exactly the amount to the address."};
      return r.maybeSent
        ? r.id.startsWith("local.")
          ? {label: "Check your wallet", tone: "warn", detail: "The swap may have been sent — check your wallet's activity before trying again."}
          : {label: "Checking", tone: "warn", detail: "The swap may have been sent. Don't retry; this updates on its own."}
        : {label: "In progress", tone: "progress", detail: `Delivering ${r.toSymbol} on ${to}. You can close this tab — tracking picks up when you come back.`};
    case "action-required":
      return {label: "Claim needed", tone: "action", detail: `The transfer is attested. Claim your ${r.toSymbol} on ${to} to finish — it costs a little gas there.`};
    case "completed":
      return {label: "Completed", tone: "ok", detail: `${r.toSymbol} arrived on ${to}.`};
    case "not-sent":
      return {label: "Not swapped", tone: "bad", detail: r.error ?? "The swap stopped before it was sent."};
    case "refund-pending":
    case "refunded":
    case "partial":
      return {label: r.status === "refund-pending" ? "Refunding" : r.status === "refunded" ? "Refunded" : "Partly filled", tone: "warn", detail: "The route couldn't complete."};
    default:
      return {label: r.status[0]!.toUpperCase() + r.status.slice(1), tone: "bad", detail: "The swap failed."};
  }
}

const URGENCY: Record<StatusView["tone"], ActivityUrgency> = {action: "action", bad: "failed", warn: "pending", progress: "pending", ok: "done"};
const ORDER: Record<ActivityUrgency, number> = {action: 0, failed: 1, pending: 2, done: 3};

function activityState(list: readonly SwapRecord[], now = Date.now()): ActivityState {
  const items: ActivityItem[] = list
    .map((record) => {
      const view = demoStatusView(record);
      return {record, view, urgency: URGENCY[view.tone], fromChainName: chainName(record.fromChain), toChainName: chainName(record.toChain)};
    })
    .sort((a, b) => ORDER[a.urgency] - ORDER[b.urgency] || b.record.createdAt - a.record.createdAt);
  const visible = items.filter((i) => i.urgency !== "done" || now - i.record.updatedAt < 8_000);
  return {items, badge: visible[0] ?? null, visibleCount: visible.length, loaded: true};
}

function useDemoActivity(): ActivityState {
  const list = useSyncExternalStore(records.subscribe, recordList, recordList);
  return useMemo(() => activityState(list), [list]);
}

function useDemoSwap(id: string | null): SwapRecord | undefined {
  const list = useSyncExternalStore(records.subscribe, recordList, recordList);
  return id ? list.find((r) => r.id === id || r.localId === id) : undefined;
}

export const demoActivityPort: ActivityPort = {
  useActivity: useDemoActivity,
  useSwap: useDemoSwap,
  useSwapTracker: () => {},
  pollSwap: async (id) => {
    await sleep(400);
    return recordList().find((r) => r.id === id || r.localId === id);
  },
  markNotSent: (id) =>
    patchRecord(id, (r) =>
      r.status === "pending" && r.maybeSent && r.id.startsWith("local.")
        ? {...r, status: "not-sent", maybeSent: false, error: "You checked your wallet and marked this swap as not sent.", updatedAt: Date.now()}
        : r,
    ),
};

// ── execute ──────────────────────────────────────────────────────────────────────────────────────────────────────

const fakeHash = () => `0x${Array.from({length: 64}, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")}`;

/**
 * Walks approving → signing → broadcast → pending → completed on timers; resolves when the first phase starts. The
 * hash lands on the record at `broadcast`, as the runner keeps it (the review becomes the status there).
 */
async function demoStartSwap(input: StartSwapInput): Promise<string> {
  const {from, to, reviewed, expectedOut} = input;
  await sleep(400);
  const localId = `local.${Date.now()}`;
  const now = Date.now();
  const approvals = reviewed.approvalSpender ? 1 : 0;
  const stage = (s: ExecutionPhase): ((r: SwapRecord) => SwapRecord) => (r) => ({...r, stage: s, approved: r.approved || (r.stage === "approving" && s !== "approving"), updatedAt: Date.now()});
  upsertRecord({
    id: localId,
    localId,
    accountId: `${from.family}:${reviewed.refundAddress}`,
    provider: reviewed.provider,
    fromChain: from.caip2,
    fromSlug: from.chain,
    toChain: to.caip2,
    toSlug: to.chain,
    fromSymbol: from.symbol,
    fromDecimals: from.decimals,
    toSymbol: to.symbol,
    toDecimals: to.decimals,
    amountIn: reviewed.amountIn.toString(),
    expectedOut: expectedOut.toString(),
    minOut: reviewed.minOut.toString(),
    recipient: reviewed.recipient,
    status: "submitting",
    stage: approvals ? "approving" : "signing",
    approvals,
    createdAt: now,
    updatedAt: now,
    checkedAt: now,
    failures: 0,
    fromKey: from.key,
    toKey: to.key,
  });
  void (async () => {
    if (approvals) {
      await sleep(1500);
      patchRecord(localId, stage("signing"));
    }
    await sleep(1500);
    const hash = fakeHash();
    patchRecord(localId, (r) => ({...stage("broadcast")(r), sourceHash: hash}));
    await sleep(800);
    const id = `awk1.${reviewed.provider}.demo${Date.now()}.${hash}`;
    const r = recordList().find((x) => x.id === localId);
    if (r) upsertRecord({...r, id, status: "pending", sourceHash: hash, stage: undefined, approved: !!approvals, updatedAt: Date.now()}, localId);
    await sleep(6000);
    patchRecord(id, (x) => ({...x, status: reviewed.provider === "cctp" ? "action-required" : "completed", destHash: fakeHash(), updatedAt: Date.now()}));
    input.onSettled?.();
  })();
  return localId;
}

async function demoIssueDeposit(input: IssueDepositInput): Promise<DepositTicket> {
  await sleep(900);
  const {req, provider, minOut} = input;
  const now = Date.now();
  const intentId = `demo${now}`;
  const ticket: DepositTicket = {
    id: `awk1.${provider}.${intentId}`,
    provider,
    intentId,
    depositAddress: DEMO_DEPOSIT_ADDRESS,
    depositMemo: null,
    sourceAmount: req.amountIn,
    destAmount: (minOut * 10_100n) / 10_000n,
    minDestAmount: minOut,
    validUntilMs: now + 20 * 60_000,
    etaSeconds: 600,
  };
  upsertRecord({
    id: ticket.id,
    accountId: `deposit:${req.refundAddress}`,
    provider,
    fromChain: req.from.caip2,
    fromSlug: req.from.chain,
    toChain: req.to.caip2,
    toSlug: req.to.chain,
    fromSymbol: req.from.symbol,
    fromDecimals: req.from.decimals,
    toSymbol: req.to.symbol,
    toDecimals: req.to.decimals,
    amountIn: req.amountIn.toString(),
    expectedOut: ticket.destAmount.toString(),
    minOut: minOut.toString(),
    recipient: req.recipient,
    status: "pending",
    mode: "deposit",
    deposit: {address: ticket.depositAddress, memo: null, amount: req.amountIn.toString(), validUntilMs: ticket.validUntilMs},
    createdAt: now,
    updatedAt: now,
    checkedAt: now,
    failures: 0,
    fromKey: req.from.key,
    toKey: req.to.key,
  });
  return ticket;
}

export const demoExecutePort: ExecutePort = {
  startSwap: demoStartSwap,
  issueDeposit: demoIssueDeposit,
  async previewClaim(id: string): Promise<ClaimPreview | null> {
    await sleep(500);
    const r = recordList().find((x) => x.id === id);
    return r ? {chain: r.toChain, to: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", data: "0x57ecfd28", value: 0n} : null;
  },
  async claimSwap(id: string): Promise<ClaimResult> {
    await sleep(1500);
    const r = recordList().find((x) => x.id === id);
    const hash = fakeHash();
    const next = `${id}.${hash}`;
    if (r) patchRecord(id, (x) => ({...x, status: "pending", claimHash: hash, trackId: next, updatedAt: Date.now()}));
    setTimeout(() => patchRecord(id, (x) => ({...x, status: "completed", updatedAt: Date.now()})), 4000);
    return {hash, chain: r?.toChain ?? "eip155:8453", id: next};
  },
};

/** Every port, fixture-backed. */
export const demoPorts: AppPorts = {
  catalog: demoCatalogPort,
  wallets: demoWalletsPort,
  swap: demoSwapPort,
  execute: demoExecutePort,
  activity: demoActivityPort,
};

/** Tests: put the demo stores back to their first state. */
export function resetDemoState(): void {
  wallets.set(undefined);
  records.set(undefined);
  demoImports.set(undefined);
  previewBucket = null;
}
