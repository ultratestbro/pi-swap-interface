/**
 * The "how permissionless is this quote" badge per venue (D21, ui-port §5.6):
 * quoted and settled by contracts over RPC, by a node, or by a provider's API
 * whose answer the module checks in the browser before anything is signed.
 * Classification follows each package's README.
 */
import type {VenueTrust} from "../contracts/routes";
import {providerName} from "./providerMeta";

export const VENUE_TRUST: Readonly<Record<string, VenueTrust>> = {
  // QuoterV2 quote + SwapRouter02 over RPC.
  uniswap: "contracts",
  // Router NG get_dy quote + exchange over RPC, pinned pools only.
  curve: "contracts",
  // WETH9 deposit() / withdraw().
  wrap: "contracts",
  // queryBatchSwap on the V2 Vault (paths from the SOR API, priced on-chain).
  balancer: "contracts",
  // OFT quoteSend over RPC; LayerZero DVNs deliver.
  usdt0: "contracts",
  // Burn/mint contracts; Circle's attestation to mint.
  cctp: "contracts",
  // THORNode quotes; a second node checks the vault.
  thorchain: "own-node",
  near_intents: "provider-api",
  lifi: "provider-api",
  relay: "provider-api",
  symbiosis: "provider-api",
  chainflip: "provider-api",
  omniston: "provider-api",
  jupiter: "provider-api",
  // Fynd's hosted solver API (through cp0x's proxy); settles through the pinned Tycho router.
  fynd: "provider-api",
  // 0x Swap API v2 through cp0x's proxy; the Settler from 0x's on-chain registry, calldata and Permit2 checked here.
  zeroex: "provider-api",
  // Across API V5 prices through cp0x's proxy; the SpokePool deposit is encoded and verified here.
  across: "provider-api",
};

/** A venue's badge level; an unknown venue counts as its own API. */
export const venueTrust = (provider: string): VenueTrust => VENUE_TRUST[provider] ?? "provider-api";

/** The badge's tooltip / route-sheet sub-line. */
export function venueTrustText(provider: string, chainName: string): string {
  switch (venueTrust(provider)) {
    case "contracts":
      return `Quoted and settled by contracts on ${chainName} — no company API`;
    case "own-node":
      return "Quoted by a THORChain node";
    case "provider-api":
      return `Quoted by ${providerName(provider)}'s API — checked in your browser before you sign`;
  }
}

/** The Fynd License, which every Fynd output (a quote, its calldata) is under. */
export const FYND_LICENSE_URL = "https://github.com/propeller-heads/fynd/blob/main/LICENSE.md";

/**
 * The notice the Fynd License (§3.4) asks of whoever hands a Fynd route to someone to settle: its router and
 * anti-circumvention terms. Shown on the review of every Fynd route; the SDK and the gate already enforce both.
 */
export const fyndRouterNotice = (chainName: string): string =>
  `Fynd routes settle only through Propeller Heads' Tycho Router on ${chainName}, with its fees intact, and must not be re-routed around it.`;
