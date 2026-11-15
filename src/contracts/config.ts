/**
 * Runtime configuration: everything an operator may change without a rebuild
 * (./runtime-config.json next to index.html). Every value is public — no keys,
 * ever: a key in a static bundle is public (a viewer's own keys, Custom mode,
 * live outside it: VenueKeys). Shape = providers.md §3 plus the
 * app's own fields (demo, walletConnect, prices). Pinned allowlists (LI.FI
 * targets, THORChain routers, Omniston contracts) are code, never config.
 */

/** Every swap2 provider the app can construct. All default on; fynd, zeroex and across only in Standard mode (D3, D38). */
export type ProviderName =
  | "uniswap"
  | "curve"
  | "wrap"
  | "usdt0"
  | "cctp"
  | "thorchain"
  | "chainflip"
  | "near_intents"
  | "lifi"
  | "relay"
  | "jupiter"
  | "fynd"
  | "symbiosis"
  | "balancer"
  | "omniston"
  | "zeroex"
  | "across";

export interface RuntimeConfig {
  /** Render fixtures only: no wallets, no network (also `?demo=1` in the hash query). */
  demo: boolean;
  /** Construct the provider at all. A disabled provider is simply not built. */
  providers: Readonly<Record<ProviderName, boolean>>;
  /** EVM JSON-RPC by chain id, tried in order. The single source of RPC URLs for reads, providers and wallets' public clients. */
  evmRpc: Readonly<Record<number, readonly string[]>>;
  /** Solana JSON-RPC, tried in order (browser-usable endpoints only: mainnet-beta 403s browser origins). */
  solanaRpc: readonly string[];
  /**
   * NEAR JSON-RPC, tried in order: a NEAR wallet's balances, and at Confirm its NEAR balance and a token's storage
   * registration. [] = no NEAR reads: balances stay unknown and a NEAR wallet's deposits are refused before signing.
   * Asked straight from the browser in every mode: the proxy has no NEAR slot (D30).
   */
  nearRpc: readonly string[];
  /** TonAPI base: a TON wallet's balances and jetton wallet (D11), Omniston's validators. */
  tonApiUrl: string;
  /**
   * Tron full-node HTTP API hosts (`/wallet/*`), tried in order: balances, the reference block a TronLink payment is
   * built on, its broadcast and receipt. Contacted only once a Tron wallet is connected.
   */
  tronApi: readonly string[];
  /** API bases, each overridable (e.g. your own CORS proxy). Overriding LI.FI or THORChain is a trust decision. */
  api: {
    nearIntents: string;
    lifi: string;
    cctp: string;
    layerZeroScan: string;
    chainflip: string;
    relay: string;
    jupiter: string;
    symbiosis: string;
    balancer: string;
    /** wss: */
    omnistonWs: string;
    /** ≥ 2 distinct hosts (THORChain needs a second operator to confirm the vault). */
    thorNodes: readonly string[];
    /** [] = "the other nodeUrl hosts". */
    thorConfirmNodes: readonly string[];
  };
  nearIntents: {suspendedChains: Readonly<Record<string, string>>};
  cctp: {mode: "auto" | "fast" | "standard"};
  thorchain: {clientId: string};
  omniston: {maxUsd: number; evmSource: boolean};
  pacing: {symbiosisGapMs: number; jupiterGapMs: number};
  /**
   * Preview prices before a wallet or address exists (D7, D29): on by default; a viewer's saved settings may only
   * turn it off. Each tab spends one of `roundsBurst` preview rounds per quote, one back every `roundRefillMs`.
   */
  preview: {enabled: boolean; roundsBurst: number; roundRefillMs: number};
  /** WalletConnect Cloud project id (public by design). "" hides WalletConnect. */
  walletConnect: {projectId: string};
  /** Price API bases (keyless): DefiLlama primary, CoinGecko fallback. */
  prices: {defillama: string; coingecko: string};
}

/** What runtime-config.json may contain: any subset; sections merge key by key; evmRpc per chain id (D8). */
export type RuntimeConfigInput = {
  [K in keyof RuntimeConfig]?: RuntimeConfig[K] extends readonly unknown[]
    ? RuntimeConfig[K]
    : RuntimeConfig[K] extends object
      ? Partial<RuntimeConfig[K]>
      : RuntimeConfig[K];
};

/**
 * How this page reaches venues and RPCs (D30). "standard" exists only in a build made with VITE_CP0X_API (the
 * hosted one, where it is the default): quote requests and RPC calls go through cp0x's proxy, which adds cp0x's
 * keys. "public": the keyless public endpoints, never a cp0x host. "custom": public plus the viewer's own RPCs
 * and venue keys, never a cp0x host. Every answer is verified in the browser in all three.
 */
export type ConnectionMode = "standard" | "public" | "custom";

/**
 * The venues cp0x's swap-web proxy forwards, by the proxy's (and the health answer's) names. Fynd, 0x and Across are
 * reachable only through it: Fynd's API sends no CORS headers, and all three need a key that is cp0x's (0x's
 * `0x-api-key`, Across's V5 `Authorization: Bearer`; D38), so they have no public base and no direct fallback.
 */
export type ProxyVenue = "lifi" | "relay" | "near_intents" | "jupiter" | "symbiosis" | "fynd" | "zeroex" | "across";

/**
 * The viewer's own venue keys (Custom mode only), each sent only to its venue in a request header: LI.FI
 * `x-lifi-api-key`, Relay `x-api-key`, NEAR Intents 1Click `authorization: Bearer`, Jupiter `x-api-key`, Symbiosis
 * `X-Api-Key`. Kept in this browser's localStorage and the providers' constructors, never in RuntimeConfig, a URL, a
 * record or a log.
 */
export interface VenueKeys {
  lifi?: string;
  relay?: string;
  nearIntents?: string;
  jupiter?: string;
  symbiosis?: string;
}

/** Custom mode's endpoints: tried BEFORE the public ones, which stay in each list as the fallback (unless `only`). */
export interface CustomEndpoints {
  evmRpc: Readonly<Record<number, readonly string[]>>;
  solanaRpc: readonly string[];
  /**
   * "Use only my RPCs": on each network the viewer gave an RPC for, theirs ALONE, no public fallback (a network
   * without one keeps the public list). On for an older browser whose saved RPCs replaced each list, so moving it to
   * Custom keeps that promise.
   */
  only?: boolean;
}

/** What this browser saved about its connection (localStorage `cp0x.swap.connection.v1`). */
export interface ConnectionSettings {
  mode: ConnectionMode;
  custom: CustomEndpoints;
}

/** Live state of this page's connection, for Settings (D30). */
export interface ConnectionStatus {
  mode: ConnectionMode;
  /** Standard's health check: "off" in the other modes (and in demo mode). */
  health: "off" | "checking" | "ok" | "unreachable";
  /** Venues the health answer calls "keyed" (cp0x holds a key), whether or not this page routes them. */
  keyed: readonly ProxyVenue[];
  /** Venues going through cp0x, with cp0x's key, right now. */
  viaProxy: readonly ProxyVenue[];
  /**
   * Venues taken off cp0x after a failure there (for a while, until 00:00 UTC, or for this page): sent straight to
   * the venue meanwhile — except the proxy-only ones (Fynd, 0x, Across), which are then not asked at all.
   */
  fellBack: readonly ProxyVenue[];
  /** RPC networks (EVM chains, Solana) going through cp0x right now. */
  rpcNetworks: number;
  /** THORChain's vault check asks cp0x's node first. */
  thornode: boolean;
}

/**
 * What the viewer's saved settings (localStorage, the Settings sheet) changed on this page (D8). The swap screen
 * and the review name every changed host: a quote, a deposit address or calldata then comes from a server the
 * viewer's browser picked, not the operator.
 */
export interface SavedOverrides {
  /** The saved layer was NOT applied: the page shares its origin with other sites (an IPFS path gateway). */
  ignored: boolean;
  /** Venue, price and Tron API bases pointing elsewhere: the config key (`api.lifi`, `prices.defillama`, `tronApi`, …) and its host. */
  hosts: readonly {key: string; host: string}[];
  /** EVM chain ids whose RPC list comes from the saved settings. */
  evmRpcChains: readonly number[];
  /** The Solana RPC list comes from the saved settings. */
  solanaRpc: boolean;
}
