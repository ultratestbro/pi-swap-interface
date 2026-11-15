/**
 * Built-in runtime config: what the app uses when runtime-config.json is
 * absent. Public, keyless endpoints only, each checked for browser CORS on
 * 2026-11-11 (providers.md §3, §8; catalog.md §2.5, §5.2).
 */
import type {ProviderName, RuntimeConfig} from "../contracts/config";
import {EVM_CHAINS} from "../shared/chains";

/**
 * cp0x-api's public EVM RPC column (apps/api lib/crossChain evmPublicRpcUrls, env-keyed entries dropped): tried
 * first, because the server's providers have run against exactly these. The catalog's own lists follow as failover.
 */
export const SERVER_PUBLIC_EVM_RPC: Readonly<Record<number, string>> = {
  1: "https://ethereum-rpc.publicnode.com",
  8453: "https://base-rpc.publicnode.com",
  42161: "https://arbitrum-one-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  56: "https://bsc-rpc.publicnode.com",
  43114: "https://avalanche-c-chain-rpc.publicnode.com",
  4663: "https://rpc.mainnet.chain.robinhood.com",
  324: "https://mainnet.era.zksync.io",
  42220: "https://forno.celo.org",
  4326: "https://mainnet.megaeth.com/rpc",
  9745: "https://rpc.plasma.to",
  59144: "https://rpc.linea.build",
  146: "https://rpc.soniclabs.com",
  480: "https://worldchain-mainnet.g.alchemy.com/public",
  57073: "https://rpc-gel.inkonchain.com",
  196: "https://rpc.xlayer.tech",
  1329: "https://evm-rpc.sei-apis.com",
  98866: "https://rpc.plume.org",
  5042: "https://rpc.mainnet.arc.io",
  5000: "https://rpc.mantle.xyz",
  747474: "https://rpc.katana.network",
  2818: "https://rpc.morphl2.io",
  14: "https://flare-api.flare.network/ext/C/rpc",
  99901: "https://rpc.elysium.kinetiq.xyz",
  100: "https://gnosis-rpc.publicnode.com",
  130: "https://unichain-rpc.publicnode.com",
  143: "https://rpc.monad.xyz",
  999: "https://rpc.hyperliquid.xyz/evm",
  534352: "https://rpc.scroll.io",
  80094: "https://rpc.berachain.com",
};

/**
 * Solana RPCs a browser can use: publicnode (no indexed methods, getMultipleAccounts ≤ 10) then solanavibestation.
 * api.mainnet-beta.solana.com is left out on purpose: it answers 403 to every real browser request (catalog.md §5.2).
 */
export const DEFAULT_SOLANA_RPCS: readonly string[] = ["https://solana-rpc.publicnode.com", "https://public.rpc.solanavibestation.com"];

/**
 * Tron full-node HTTP APIs a browser can use (CORS open, keyless, `/wallet/*` incl. broadcasthex; checked 2026-11-12):
 * publicnode first, TronGrid (rate-limited without a key) after it.
 */
export const DEFAULT_TRON_API: readonly string[] = ["https://tron-rpc.publicnode.com", "https://api.trongrid.io"];

/** NEAR RPCs a browser can use: FastNear (the shared chain row's; it allows browser origins). */
export const DEFAULT_NEAR_RPCS: readonly string[] = ["https://rpc.mainnet.fastnear.com"];

/** Every EVM catalog chain: the server's public RPC first, then the catalog's list, deduped. */
function defaultEvmRpc(): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const c of EVM_CHAINS) {
    const id = c.chainId!;
    out[id] = [...new Set([SERVER_PUBLIC_EVM_RPC[id], ...c.rpc].filter((u): u is string => !!u))];
  }
  return out;
}

/**
 * Every venue constructs by default, in ask order (Settings lists them so); fynd, zeroex and across are built only in
 * Standard mode (D3, D38).
 * An operator's layer or a viewer's Settings can switch any of them off.
 */
export const DEFAULT_PROVIDERS: Readonly<Record<ProviderName, boolean>> = {
  uniswap: true,
  curve: true,
  balancer: true,
  wrap: true,
  usdt0: true,
  cctp: true,
  thorchain: true,
  chainflip: true,
  near_intents: true,
  lifi: true,
  relay: true,
  symbiosis: true,
  jupiter: true,
  omniston: true,
  fynd: true,
  zeroex: true,
  across: true,
};

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  demo: false,
  providers: DEFAULT_PROVIDERS,
  evmRpc: defaultEvmRpc(),
  solanaRpc: DEFAULT_SOLANA_RPCS,
  nearRpc: DEFAULT_NEAR_RPCS,
  tonApiUrl: "https://tonapi.io",
  tronApi: DEFAULT_TRON_API,
  api: {
    nearIntents: "https://1click.chaindefuser.com/v0",
    lifi: "https://li.quest/v1",
    cctp: "https://iris-api.circle.com",
    layerZeroScan: "https://scan.layerzero-api.com",
    chainflip: "https://chainflip-swap.chainflip.io",
    relay: "https://api.relay.link",
    jupiter: "https://api.jup.ag/swap/v2",
    symbiosis: "https://api.symbiosis.finance/crosschain",
    balancer: "https://api-v3.balancer.fi/",
    omnistonWs: "wss://omni-ws.ston.fi",
    // Liquify first. The THORWallet balancer fell ~3 min behind on 2026-11-12 and its quote endpoint refuses ("stale
    // state"); the SDK takes that answer as final instead of trying the next node, so a lagging node must not quote.
    // THORWallet stays second: its vault list still confirms Liquify's (providers.md §4.3).
    thorNodes: ["https://gateway.liquify.com/chain/thorchain_api", "https://thorchain-thornode-lb-1.thorwallet.org"],
    thorConfirmNodes: [],
  },
  nearIntents: {suspendedChains: {}},
  cctp: {mode: "auto"},
  thorchain: {clientId: "cp0x-swap"},
  omniston: {maxUsd: 1000, evmSource: true},
  pacing: {symbiosisGapMs: 1100, jupiterGapMs: 2100},
  // Five preview rounds at once, then one per 20 s per tab (D29): typing pauses, a few refreshes, never a poll.
  preview: {enabled: true, roundsBurst: 5, roundRefillMs: 20_000},
  walletConnect: {projectId: ""},
  prices: {defillama: "https://coins.llama.fi", coingecko: "https://api.coingecko.com/api/v3"},
};

export const PROVIDER_KEYS = Object.keys(DEFAULT_PROVIDERS) as ProviderName[];
