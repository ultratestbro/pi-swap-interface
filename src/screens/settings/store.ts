/**
 * The Settings sheet's text helpers. The overrides themselves (key, read,
 * write) live in src/config (userSettings.ts, connection.ts), because the
 * boot merges them before the app module loads (D8/D9/D30); they are
 * re-exported here for the screens' public entry.
 */
import type {ConnectionStatus, CustomEndpoints, ProxyVenue} from "../../contracts/config";
import {MAX_CUSTOM_URLS, PROXY_ONLY, customRpcProblem} from "../../config";

export {USER_SETTINGS_KEY, readConnection, readUserSettings, readVenueKeys, writeConnection, writeUserSettings, writeVenueKeys} from "../../config";

/** One URL per line → a list (empty lines dropped). */
export const urlLines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Loopback hostnames: only a page served from this machine (the npx server) may reach a plain-http local RPC. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Why a plain-http (local node) RPC can't be used from this page, or null: the hosted, Docker and IPFS CSP allow only
 * https:/wss: (bin/headers.mjs), so saving one would silently break that chain's reads. Allowed when served from loopback.
 */
export function localHttpBlocked(url: string, pageHost: string): string | null {
  return !LOOPBACK.has(pageHost) && url.trim().startsWith("http:") ? `${url.trim()} works only when the app runs on this machine (npx) — this page's security policy blocks plain http` : null;
}

/** A network of Custom mode's RPC rows: an EVM chain id, or Solana. */
export type CustomNetwork = number | "solana";

const listOf = (c: CustomEndpoints, n: CustomNetwork): readonly string[] => (n === "solana" ? c.solanaRpc : (c.evmRpc[n] ?? []));

/** Custom endpoints with one URL added (checked: https, this page's CSP, the cap) — or why not. */
export function addCustomRpc(c: CustomEndpoints, network: CustomNetwork, url: string, pageHost: string): {custom: CustomEndpoints; error: string | null} {
  const u = url.trim();
  const error = customRpcProblem(u) ?? localHttpBlocked(u, pageHost);
  if (error) return {custom: c, error};
  const list = listOf(c, network);
  if (list.includes(u)) return {custom: c, error: "Already in the list."};
  if (list.length >= MAX_CUSTOM_URLS) return {custom: c, error: `At most ${MAX_CUSTOM_URLS} per network.`};
  return {custom: network === "solana" ? {...c, solanaRpc: [...list, u]} : {...c, evmRpc: {...c.evmRpc, [network]: [...list, u]}}, error: null};
}

/** Custom endpoints with one URL removed (a network left empty disappears). */
export function removeCustomRpc(c: CustomEndpoints, network: CustomNetwork, url: string): CustomEndpoints {
  const rest = listOf(c, network).filter((u) => u !== url);
  if (network === "solana") return {...c, solanaRpc: rest};
  const evmRpc = {...c.evmRpc};
  if (rest.length) evmRpc[network] = rest;
  else delete evmRpc[network];
  return {...c, evmRpc};
}

/** "LI.FI", "LI.FI and Relay", "LI.FI, Relay and Jupiter". */
const andList = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** Venues sent straight to the venue after a cp0x error; a proxy-only one (Fynd, 0x, Across) is paused instead. */
const sentDirect = (st: ConnectionStatus): readonly ProxyVenue[] => st.fellBack.filter((v) => !PROXY_ONLY.has(v));

/** What the line says about the venues when none goes through cp0x right now, or null when the fallback clause says it. */
function directVenues(st: ConnectionStatus): string | null {
  if (sentDirect(st).length) return null;
  // "No key" only when health keyed none: keyed venues may be direct because this browser pointed them elsewhere.
  return st.keyed.length ? "Venues asked directly" : "Venues asked directly (cp0x holds no key for them yet)";
}

/**
 * The live Standard line (D30): which venues go through cp0x with its keys, how many RPC networks, THORChain's
 * vault check, and any venue that fell back — or that the cp0x API is unreachable. Null outside Standard.
 */
export function connectionStatusText(st: ConnectionStatus, name: (v: ProxyVenue) => string): string | null {
  if (st.mode !== "standard" || st.health === "off") return null;
  if (st.health === "checking") return "Checking the cp0x API…";
  if (st.health === "unreachable") return "cp0x API unreachable — using public endpoints.";
  const venues = st.viaProxy.length ? `${andList(st.viaProxy.map(name))} through cp0x with its keys` : directVenues(st);
  const parts = [
    ...(venues ? [venues] : []),
    st.rpcNetworks ? `RPC for ${st.rpcNetworks} network${st.rpcNetworks === 1 ? "" : "s"} through cp0x` : "Public RPCs",
  ];
  if (st.thornode) parts.push("THORChain's vault check through cp0x");
  const direct = sentDirect(st);
  const paused = st.fellBack.filter((v) => PROXY_ONLY.has(v));
  if (direct.length) parts.push(`${andList(direct.map(name))} asked directly after a cp0x error`);
  if (paused.length) parts.push(`${andList(paused.map(name))} paused after a cp0x error`);
  return parts.join(" · ");
}

/**
 * The Settings venue row's line for a venue only Standard mode reaches (Fynd, through cp0x's proxy): where it can be
 * asked, and why this page doesn't ask it now (another mode, cp0x unreachable, no key, paused after an error).
 */
export function standardOnlyNote(venue: ProxyVenue, hasStandard: boolean, st: ConnectionStatus): string {
  const only = "Standard mode only";
  if (!hasStandard) return `${only} — not in this copy of the app`;
  if (st.mode !== "standard") return `${only} — not asked in this mode`;
  if (st.health === "unreachable") return `${only} — cp0x unreachable, not asked`;
  if (st.fellBack.includes(venue)) return `${only} — paused after a cp0x error`;
  if (st.health === "ok" && !st.keyed.includes(venue)) return `${only} — cp0x holds no key for it yet`;
  return `${only} — asked through cp0x's server`;
}
