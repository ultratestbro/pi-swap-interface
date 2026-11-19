/**
 * Where each EVM network's approval history comes from (D46): one indexer request for the whole history, then the
 * runtime RPCs verify the state (the module's Multicall3 read). Free sources only (owner 2026-11-20):
 *
 *   etherscan   cp0x's proxy slot with cp0x's free key (Standard mode, health "keyed"): the 14 networks Etherscan V2's
 *               free plan answered on 2026-11-20 (cp0x-api venues.ts ETHERSCAN_FREE_CHAIN_IDS, the same list).
 *   blockscout  a public Blockscout instance, straight from the browser (keyless; per-viewer limits).
 *   routescan   Routescan's keyless Etherscan-compatible API, straight from the browser.
 *
 * A network with none of them (BNB Chain, Gnosis, Celo, X Layer, Katana, Morph, Flare, Arc, Elysium; in Public mode
 * also the Etherscan-only ones) is listed as not checked, never scanned slowly over eth_getLogs.
 */

export const ETHERSCAN_FREE_CHAIN_IDS: readonly number[] = [1, 42161, 137, 59144, 130, 143, 999, 146, 80094, 9745, 4326, 480, 1329, 5000];

/**
 * Public Blockscout(-compatible) instances a browser can read the logs-by-owner query from (CORS open, no challenge;
 * probed from Chromium 2026-11-20). Each is its final host: a redirect to another host carries no CORS header
 * (optimism.blockscout.com → explorer.optimism.io, scroll.blockscout.com → scrollscan.com). Not here: Arbitrum's,
 * Gnosis', Linea's, Celo's and MegaETH's (a challenge, no CORS or no answer from a browser) — Arbitrum, Linea and
 * MegaETH are read through Etherscan in Standard mode.
 */
export const BLOCKSCOUT_URLS: Readonly<Record<number, string>> = {
  1: "https://eth.blockscout.com",
  10: "https://explorer.optimism.io",
  130: "https://unichain.blockscout.com",
  137: "https://polygon.blockscout.com",
  324: "https://zksync.blockscout.com",
  480: "https://worldchain-mainnet.explorer.alchemy.com",
  4663: "https://robinhoodchain.blockscout.com",
  8453: "https://base.blockscout.com",
  57073: "https://explorer.inkonchain.com",
  98866: "https://explorer.plume.org",
  534352: "https://scrollscan.com",
};

/** Routescan's keyless Etherscan-compatible endpoints: Avalanche only answers the logs query (Plasma: "chain not supported"). */
export const ROUTESCAN_URLS: Readonly<Record<number, string>> = {
  43114: "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api",
};

export type HistorySource = {kind: "etherscan" | "blockscout" | "routescan"; url: string};

/**
 * The source for `chainId`: cp0x's Etherscan slot where it serves the network (`etherscanUrl`, null without it),
 * else Blockscout, else Routescan; null when there is none.
 */
export function historySource(chainId: number, etherscanUrl: string | null): HistorySource | null {
  if (etherscanUrl && ETHERSCAN_FREE_CHAIN_IDS.includes(chainId)) return {kind: "etherscan", url: etherscanUrl};
  const blockscout = BLOCKSCOUT_URLS[chainId];
  if (blockscout) return {kind: "blockscout", url: blockscout};
  const routescan = ROUTESCAN_URLS[chainId];
  if (routescan) return {kind: "routescan", url: routescan};
  return null;
}

/** Why a network has no source here: plain words for the list's "not checked" line. */
export function noSourceNote(chainId: number, etherscanUrl: string | null): string {
  return ETHERSCAN_FREE_CHAIN_IDS.includes(chainId) && !etherscanUrl ? "Checked in Standard mode only" : "No free history source yet";
}
