/**
 * What the browser trusts about each venue's EVM source leg (engine.md §7.3 LOCAL_PINS, defence in depth on top of
 * the providers' own checks): the contracts its calldata may call and the spenders it may approve. The lists come
 * from the provider packages themselves — the same code the providers run with — never from config or a server, so
 * a venue's API cannot name its own contract. They must agree with the provider options swap builds (LI.FI's Flare
 * Diamond is in `lifiPins`; a test checks it).
 *
 * 0x (D38): its call target is whatever 0x's on-chain registry names as the Settler in force (or the one it replaced),
 * read over the page's RPCs by the very resolver the 0x provider quoted through — never the API's word — and its only
 * spender is canonical Permit2; its rule also takes a Permit2 signature transfer, held by the gate to exactly this
 * swap (gate.ts permit2Problem; deadline at most the package's ZEROEX_MAX_PERMIT_SECONDS). Across: its pinned
 * SpokePools, as call target and spender (`acrossPins`).
 *
 * NEAR Intents only ever pays a per-quote deposit address (nothing to pin: the "deposit" rule); Jupiter is a Solana
 * transaction the SDK account guards itself; Omniston's only spenders are its audited order protocols (swap's
 * `orderSpender`, so this file never imports the Omniston package — it stays out of the main bundle).
 *
 * Tron sources (a TronLink payment) have their own table, TRON_RULES: NEAR Intents' deposit address, and Chainflip's
 * Tron Vault (CF_VAULTS, from its package) with its hex note. THORChain's Tron source stays off (`tronSource: false`
 * in swap's providers), so it has no Tron rule either.
 */
import {balancerPins} from "@anywalletkit/protocol-swap2-balancer/provider";
import {cctpPins} from "@anywalletkit/protocol-swap2-cctp/provider";
import {CF_VAULTS, chainflipPins} from "@anywalletkit/protocol-swap2-chainflip/config";
import type {RemotePins} from "@anywalletkit/protocol-swap2-core/types";
import {curvePins} from "@anywalletkit/protocol-swap2-curve";
import {fyndPins} from "@anywalletkit/protocol-swap2-fynd/router";
import {lifiPins} from "@anywalletkit/protocol-swap2-lifi/provider";
import {relayPins} from "@anywalletkit/protocol-swap2-relay/verify";
import {symbiosisPins} from "@anywalletkit/protocol-swap2-symbiosis/verify";
import {thorchainPins} from "@anywalletkit/protocol-swap2-thorchain/provider";
import {uniswapPins} from "@anywalletkit/protocol-swap2-uniswap";
import {usdt0Pins} from "@anywalletkit/protocol-swap2-usdt0/config";
import {stargateRegistry} from "@anywalletkit/protocol-swap2-stargate/deployments";
import {wrapPins} from "@anywalletkit/protocol-swap2-wrap/provider";
import {ZEROEX_PERMIT2} from "@anywalletkit/protocol-swap2-0x/chains";
import {ZEROEX_MAX_PERMIT_SECONDS} from "@anywalletkit/protocol-swap2-0x/settler";
import {acrossPins} from "@anywalletkit/protocol-swap2-across/verify";
import {GPV2_VAULT_RELAYER} from "@anywalletkit/protocol-swap2-core";
import {COW_DEPLOYMENTS, deploymentOf} from "@anywalletkit/protocol-swap2-cow";
import {kyberChain, kyberPins} from "@anywalletkit/protocol-swap2-kyberswap/router";
import {appProviders, orderSpender, zeroExServes, zeroExSettlers} from "../swap";
import type {TronRule, VenueRule} from "./gate";

type Pins = Pick<RemotePins, "callTargets" | "spenders">;

const pinned = (pins: Pins): VenueRule => ({kind: "pins", pins});

let thor: Pins | null = null;
/** thorchainPins() builds a node client for its build check; only its router lists are used here, built on first use. */
const thorPins: Pins = {
  callTargets: (c) => (thor ??= thorchainPins()).callTargets(c),
  spenders: (c) => (thor ??= thorchainPins()).spenders(c),
};

const omnistonPins: Pins = {
  callTargets: () => [],
  spenders: (c) => {
    const s = orderSpender("omniston", c);
    return s ? [s] : [];
  },
};

/**
 * 0x: the Settlers the page's 0x provider last read from the registry (its resolver's fresh set, the one its live quote
 * was checked against; [] before one — then nothing is called), and canonical Permit2 as the one spender.
 */
const zeroExPins: Pins = {
  callTargets: (c) => zeroExSettlers(appProviders(), c),
  spenders: (c) => (zeroExServes(c) ? [ZEROEX_PERMIT2] : []),
};

/** Stargate: its reviewed deployments' pools / OFTs and messaging contracts as call targets, ERC-20 pools as spenders. */
const stargateGatePins: Pins = {
  callTargets: (c) => stargateRegistry.callTargets(c),
  spenders: (c) => stargateRegistry.spenders(c),
};

/** Venue → its EVM rule. A venue missing here gets no EVM calldata or order signature at all (checkPlanBrowser). */
export const VENUE_RULES: Readonly<Record<string, VenueRule>> = {
  lifi: pinned(lifiPins),
  relay: pinned(relayPins),
  cctp: pinned(cctpPins),
  usdt0: pinned(usdt0Pins),
  stargate: pinned(stargateGatePins),
  chainflip: pinned(chainflipPins),
  uniswap: pinned(uniswapPins),
  // The pinned Router NG per chain (call target and the one spender).
  curve: pinned(curvePins),
  wrap: pinned(wrapPins),
  thorchain: pinned(thorPins),
  balancer: pinned(balancerPins),
  symbiosis: pinned(symbiosisPins),
  omniston: pinned(omnistonPins),
  // TychoRouterV3 per chain: every Fynd route settles through it (Fynd License).
  fynd: pinned(fyndPins),
  // The registry's Settler and Permit2 (above); a one-time Permit2 transfer for exactly the input, ≤ 10 min (D38).
  zeroex: {kind: "pins", pins: zeroExPins, permit2: {maxSeconds: ZEROEX_MAX_PERMIT_SECONDS}},
  // The pinned SpokePool per chain: the deposit's call target and its one spender.
  across: pinned(acrossPins),
  // CoW Protocol (D48): a signed GPv2 order for a token sale, eth-flow's createOrder for a native one, the vault relayer
  // as the only spender — held by gate.ts gpv2Problem to the package's pinned deployments.
  cow: {kind: "gpv2"},
  // KyberSwap (D52): MetaAggregationRouterV2 on its 18 chains, the call target and the one spender (exact approval,
  // spent by the swap itself).
  kyberswap: pinned(kyberPins),
  near_intents: {kind: "deposit"},
};

/** CoW's spender on `caip2`: the canonical GPv2 vault relayer where the app's CoW package serves the network. */
const cowSpenders = (caip2: string): readonly string[] =>
  caip2.startsWith("eip155:") && deploymentOf(COW_DEPLOYMENTS, Number(caip2.slice("eip155:".length))) ? [GPV2_VAULT_RELAYER] : [];

/** The rule checkPlanBrowser holds `provider`'s live plan to (undefined = none: calldata refused). */
export const venueRule = (provider: string): VenueRule | undefined => VENUE_RULES[provider];

/**
 * The venue whose rule pins `address` as a SPENDER on `caip2` (the Approvals section's "verified by cp0x" label, D46),
 * or null. Spenders only: a call target is not a contract to give an allowance to (0x's Settlers, learned per quote,
 * take none — anyone could spend one), and 0x's spender is canonical Permit2, which the section names before asking.
 */
export function pinnedVenueOf(caip2: string, address: string): string | null {
  const a = address.toLowerCase();
  for (const [venue, rule] of Object.entries(VENUE_RULES)) {
    if (rule.kind === "deposit") continue;
    // KyberSwap's router where it is the 2022 build (`generic`: swapGeneric and an owner-managed whitelist) could be
    // made to spend an allowance left on it by its owner's key: the swap never leaves one, so one that is there is not
    // "verified" — it is one to revoke.
    if (venue === "kyberswap" && kyberChain(Number(caip2.slice("eip155:".length)))?.build !== "lite") continue;
    let listed: readonly string[] = [];
    try {
      listed = rule.kind === "gpv2" ? cowSpenders(caip2) : rule.pins.spenders(caip2);
    } catch {
      // A rule that doesn't know the network lists nothing on it.
    }
    if (listed.some((x) => x.toLowerCase() === a)) return venue;
  }
  return null;
}

const TRON = "tron:728126428";
const cfTronVault = (CF_VAULTS as Readonly<Record<string, string>>)[TRON];

/** Venue → how it may be paid from a Tron wallet. A venue missing here is never paid from one (checkPlanBrowser). */
export const TRON_RULES: Readonly<Record<string, TronRule>> = {
  near_intents: {kind: "deposit"},
  ...(cfTronVault ? {chainflip: {kind: "vault", to: [cfTronVault], memo: "hex"} as const} : {}),
};

/** The Tron rule checkPlanBrowser holds `provider`'s live plan to (undefined = none: refused). */
export const tronRule = (provider: string): TronRule | undefined => TRON_RULES[provider];
