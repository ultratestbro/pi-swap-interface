/**
 * The connection modes (ARCHITECTURE D30): how this page reaches the venues and RPCs.
 * - standard: only in a build made with VITE_CP0X_API (the hosted one), and its default there. LI.FI, Relay, NEAR
 *   Intents, Jupiter, Symbiosis, Fynd, 0x and Across (while cp0x holds a key for them), the RPCs and THORChain's vault
 *   check go through cp0x's swap-web proxy, a transport that adds cp0x's keys; every answer is still verified here, in
 *   the browser.
 *   Fynd, 0x and Across exist only here: Fynd's API takes no browser calls (no CORS headers), and 0x's and Across's keys
 *   can't ship in a page (D38), so none of them has a direct fallback.
 * - public: the keyless public endpoints, straight from this browser. Never a cp0x host.
 * - custom: public plus the viewer's own RPCs (tried first; the public ones stay as the fallback unless the viewer
 *   chose "only my RPCs") and venue keys. Never a cp0x host.
 * Only standardSlots ever puts a cp0x API URL in the page's config: one from any other layer is dropped at boot
 * (withoutCp0xApi), and none reaches a wallet (runtime.ts isProxyUrl).
 * This file holds the pure parts: the build's API origin, what this browser saved (localStorage, every access
 * guarded, like userSettings.ts), the Custom rules, and the config each mode builds the page with. The Standard
 * runtime (health check, routing per request) is standard.ts.
 */
import type {ConnectionMode, ConnectionSettings, CustomEndpoints, ProxyVenue, RuntimeConfig, VenueKeys} from "../contracts/config";
import {EVM_CHAINS} from "../shared/chains";
import {isRpcUrl} from "./parse";
import {USER_SETTINGS_KEY} from "./userSettings";

/** localStorage key of the saved mode and Custom endpoints (JSON ConnectionSettings). */
export const CONNECTION_KEY = "cp0x.swap.connection.v1";
/** localStorage key of the viewer's venue keys (JSON VenueKeys), apart from the rest so "Clear" removes exactly them. */
export const VENUE_KEYS_KEY = "cp0x.swap.keys.v1";

const LOCAL_API_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * A cp0x API origin: https, or plain http on localhost / 127.0.0.1 (a local API in development), normalised to the
 * bare origin; null when unset or anything else. vite.config.ts refuses a bad value at build time already: this is
 * the same rule at run time, so a hand-edited bundle can't point Standard at plain http.
 */
export function apiOrigin(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const ok = u.protocol === "https:" || (u.protocol === "http:" && LOCAL_API_HOSTS.has(u.hostname));
  return ok && u.pathname === "/" && !u.search && !u.hash && !u.username && !u.password ? u.origin : null;
}

/** The cp0x API this build was made with, or null: such a build never contacts cp0x (D24). */
export const CP0X_API: string | null = apiOrigin(import.meta.env.VITE_CP0X_API);

/** The swap-web proxy's base under a cp0x API origin. */
export const swapWebBase = (api: string): string => `${api}/api/v2/swap-web`;

/** The swap-web proxy's path, on any host. */
const SWAP_WEB_PATH = /\/api\/v2\/swap-web(?:\/|$)/;

/**
 * A URL on this build's cp0x API origin, or on a swap-web proxy path anywhere. Only standardSlots may put one in the
 * page's config — in Standard mode, used only as health allows (D30). From any other layer (VITE_SWAP_CONFIG,
 * runtime-config.json, saved settings, a Custom RPC) it would reach cp0x in Public and Custom too, skip the health
 * check and the fallback, and land in wallets' chain lists, where the proxy answers 403.
 */
export function isCp0xApiUrl(url: string, api: string | null = CP0X_API): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (api !== null && u.origin === api) || SWAP_WEB_PATH.test(u.pathname);
}

const hostCount = (urls: readonly string[]): number =>
  new Set(
    urls.map((u) => {
      try {
        return new URL(u).host;
      } catch {
        return u;
      }
    }),
  ).size;

/**
 * `config` without a cp0x API URL (isCp0xApiUrl), and the config keys that held one. A dropped base or price API
 * takes `fallback`'s value; a list keeps its other URLs, or takes `fallback`'s list where what is left would be unusable
 * (an emptied RPC list, fewer than two THORChain quote hosts). `fallback` = the layer below (built-in defaults under
 * the operator's layers, the operator's config under the viewer's).
 */
export function withoutCp0xApi(config: RuntimeConfig, fallback: RuntimeConfig, api: string | null = CP0X_API): {config: RuntimeConfig; dropped: string[]} {
  const bad = (u: string) => isCp0xApiUrl(u, api);
  const dropped: string[] = [];
  const bases: Record<string, string | readonly string[]> = {...config.api};
  for (const [k, v] of Object.entries(config.api) as [keyof RuntimeConfig["api"], string | readonly string[]][]) {
    if (typeof v === "string") {
      if (!bad(v)) continue;
      dropped.push(`api.${k}`);
      bases[k] = fallback.api[k];
      continue;
    }
    if (!v.some(bad)) continue;
    dropped.push(`api.${k}`);
    const kept = v.filter((u) => !bad(u));
    bases[k] = k === "thorNodes" && hostCount(kept) < 2 ? fallback.api.thorNodes : kept;
  }
  const prices = {...config.prices};
  for (const k of Object.keys(prices) as (keyof RuntimeConfig["prices"])[]) {
    if (!bad(prices[k])) continue;
    dropped.push(`prices.${k}`);
    prices[k] = fallback.prices[k];
  }
  let tonApiUrl = config.tonApiUrl;
  if (bad(tonApiUrl)) {
    dropped.push("tonApiUrl");
    tonApiUrl = fallback.tonApiUrl;
  }
  const evmRpc: Record<number, readonly string[]> = {...config.evmRpc};
  for (const [k, urls] of Object.entries(config.evmRpc)) {
    if (!urls.some(bad)) continue;
    dropped.push(`evmRpc.${k}`);
    const kept = urls.filter((u) => !bad(u));
    evmRpc[Number(k)] = kept.length ? kept : (fallback.evmRpc[Number(k)] ?? []);
  }
  let solanaRpc = config.solanaRpc;
  if (solanaRpc.some(bad)) {
    dropped.push("solanaRpc");
    const kept = solanaRpc.filter((u) => !bad(u));
    solanaRpc = kept.length ? kept : fallback.solanaRpc;
  }
  let tronApi = config.tronApi;
  if (tronApi.some(bad)) {
    dropped.push("tronApi");
    const kept = tronApi.filter((u) => !bad(u));
    tronApi = kept.length ? kept : fallback.tronApi;
  }
  let nearRpc = config.nearRpc;
  if (nearRpc.some(bad)) {
    dropped.push("nearRpc");
    const kept = nearRpc.filter((u) => !bad(u));
    nearRpc = kept.length ? kept : fallback.nearRpc;
  }
  if (!dropped.length) return {config, dropped};
  return {config: {...config, api: bases as RuntimeConfig["api"], prices, tonApiUrl, tronApi, evmRpc, solanaRpc, nearRpc}, dropped};
}

/** The proxy's venues, in the order Settings names them. */
export const PROXY_VENUES: readonly ProxyVenue[] = ["lifi", "relay", "near_intents", "jupiter", "symbiosis", "fynd", "zeroex", "across", "kyberswap"];

/**
 * Venues reachable only through the proxy, so with no public base, no runtime-config base, no Custom key and no direct
 * fallback: Fynd's hosted API sends no CORS headers (checked 2026-11-12) and its key is cp0x's; 0x (Swap API v2,
 * `0x-api-key` on every request) and Across (API V5, `Authorization: Bearer`) want a key that can never ship in a page
 * (D38) — their modules run here with a placeholder the proxy replaces. KyberSwap (D52) in Standard mode: its keyed
 * gateway (KyberSwap's terms for cp0x's traffic: the key, never the keyless API, from cp0x's pages), so no direct
 * fallback there either; Public and Custom pages ask KyberSwap's keyless public API themselves (providers.ts).
 */
export const PROXY_ONLY: ReadonlySet<ProxyVenue> = new Set(["fynd", "zeroex", "across", "kyberswap"]);

/** The runtime config's `api.*` key (and VenueKeys field) of each proxy venue that has one (not the PROXY_ONLY ones). */
export const VENUE_API_KEY: Readonly<Partial<Record<ProxyVenue, keyof VenueKeys & keyof RuntimeConfig["api"]>>> = {
  lifi: "lifi",
  relay: "relay",
  near_intents: "nearIntents",
  jupiter: "jupiter",
  symbiosis: "symbiosis",
};

/** The modes a build offers: Standard only with a cp0x API. */
export const connectionModes = (api: string | null = CP0X_API): readonly ConnectionMode[] => (api ? ["standard", "public", "custom"] : ["public", "custom"]);

/** Standard where it exists (the hosted build), else Public. */
export const defaultConnectionMode = (api: string | null = CP0X_API): ConnectionMode => (api ? "standard" : "public");

// ── Custom mode ──

/** EVM chains a Custom RPC may be given for: the catalog's. */
const EVM_IDS: ReadonlySet<number> = new Set(EVM_CHAINS.map((c) => c.chainId!));
/** Enough for a node of your own plus spares; bounds what a stored value can grow to. */
export const MAX_CUSTOM_URLS = 8;

const NO_CUSTOM: CustomEndpoints = {evmRpc: {}, solanaRpc: []};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const dedupe = (urls: readonly string[]): string[] => [...new Set(urls)];

const hasCredentials = (v: string): boolean => {
  try {
    const u = new URL(v);
    return !!(u.username || u.password);
  } catch {
    return false;
  }
};

/**
 * Why a Custom RPC URL is refused, or null: https:, or plain http to this machine (the parser's own rule, D8); no
 * `user:pass@` (fetch refuses it, so every call would fail over to the public RPCs unseen); never cp0x's API.
 */
export function customRpcProblem(url: string, api: string | null = CP0X_API): string | null {
  const v = url.trim();
  if (!v) return "Enter a URL.";
  if (hasCredentials(v)) return "Put credentials in the URL's path or query: browsers refuse user:pass@ URLs.";
  if (!isRpcUrl(v)) return "Use an https:// URL (plain http only for localhost or 127.0.0.1).";
  return isCp0xApiUrl(v, api) ? "That is cp0x's server: Custom never contacts cp0x (Standard mode uses it by itself)." : null;
}

const urlsOf = (v: unknown): string[] =>
  Array.isArray(v) ? dedupe(v.filter((u): u is string => typeof u === "string" && isRpcUrl(u) && !isCp0xApiUrl(u))).slice(0, MAX_CUSTOM_URLS) : [];

/** Custom endpoints from stored JSON: unknown chains, bad URLs and extras past the cap are dropped, never a throw. */
export function parseCustom(raw: unknown): CustomEndpoints {
  if (!isObj(raw)) return NO_CUSTOM;
  const evmRpc: Record<number, string[]> = {};
  if (isObj(raw.evmRpc)) {
    for (const [k, v] of Object.entries(raw.evmRpc)) {
      const id = Number(k);
      const urls = urlsOf(v);
      if (EVM_IDS.has(id) && urls.length) evmRpc[id] = urls;
    }
  }
  return {evmRpc, solanaRpc: urlsOf(raw.solanaRpc), ...(raw.only === true ? {only: true} : {})};
}

/**
 * Custom mode's page config: the viewer's URLs first, then the list the page had, so the public ones stay as the
 * fallback — or, with `only`, the viewer's URLs alone on their networks.
 */
export function customOverlay(config: RuntimeConfig, custom: CustomEndpoints): RuntimeConfig {
  const after = (list: readonly string[] | undefined): readonly string[] => (custom.only ? [] : (list ?? []));
  const evmRpc: Record<number, readonly string[]> = {...config.evmRpc};
  for (const [k, urls] of Object.entries(custom.evmRpc)) {
    const id = Number(k);
    if (urls.length) evmRpc[id] = dedupe([...urls, ...after(config.evmRpc[id])]);
  }
  const solanaRpc = custom.solanaRpc.length ? dedupe([...custom.solanaRpc, ...after(config.solanaRpc)]) : config.solanaRpc;
  return {...config, evmRpc, solanaRpc};
}

/** Header-safe and within what each SDK accepts (Relay and Symbiosis refuse more than 256 visible ASCII characters). */
const KEY_MAX: Readonly<Record<keyof VenueKeys, number>> = {lifi: 512, relay: 256, nearIntents: 4096, jupiter: 512, symbiosis: 256};

/** Why a venue key is refused, or null. Never echoes the key: the text may be shown and kept. */
export function venueKeyProblem(field: keyof VenueKeys, value: string): string | null {
  if (!/^[\x21-\x7e]+$/.test(value)) return "Use the key exactly as issued: visible characters only, no spaces.";
  return value.length > KEY_MAX[field] ? `Longer than ${KEY_MAX[field]} characters — not a key this venue issues.` : null;
}

/** Valid keys only, in field order (a stored value that fails the rule is dropped, never sent). */
export function parseVenueKeys(raw: unknown): VenueKeys {
  if (!isObj(raw)) return {};
  const out: VenueKeys = {};
  for (const field of Object.keys(KEY_MAX) as (keyof VenueKeys)[]) {
    const v = raw[field];
    if (typeof v === "string" && v && !venueKeyProblem(field, v)) out[field] = v;
  }
  return out;
}

// ── what this browser saved ──

/**
 * The saved connection, or null when nothing was saved. A mode this build doesn't offer (Standard without a cp0x
 * API) reads as the default. A browser whose older settings held RPC overrides (`evmRpc` / `solanaRpc` in
 * cp0x.swap.settings.v1, which replaced each list) gets them as Custom endpoints with `only` on, so they still
 * replace each list (someone who ran their own node to keep their addresses from public RPC operators keeps that);
 * userSettings.ts no longer applies them, so they count once.
 */
export function readConnection(api: string | null = CP0X_API): ConnectionSettings | null {
  try {
    const raw = globalThis.localStorage?.getItem(CONNECTION_KEY);
    if (raw) {
      const v: unknown = JSON.parse(raw);
      if (!isObj(v)) return null;
      const mode = typeof v.mode === "string" && connectionModes(api).includes(v.mode as ConnectionMode) ? (v.mode as ConnectionMode) : defaultConnectionMode(api);
      return {mode, custom: parseCustom(v.custom)};
    }
    const legacy: unknown = JSON.parse(globalThis.localStorage?.getItem(USER_SETTINGS_KEY) ?? "null");
    if (!isObj(legacy) || (legacy.evmRpc === undefined && legacy.solanaRpc === undefined)) return null;
    return {mode: "custom", custom: parseCustom({evmRpc: legacy.evmRpc, solanaRpc: legacy.solanaRpc, only: true})};
  } catch {
    return null;
  }
}

/** Save (or clear, with null). False when the browser refuses storage. */
export function writeConnection(next: ConnectionSettings | null): boolean {
  try {
    if (!globalThis.localStorage) return false;
    if (next === null) globalThis.localStorage.removeItem(CONNECTION_KEY);
    else globalThis.localStorage.setItem(CONNECTION_KEY, JSON.stringify({mode: next.mode, custom: parseCustom(next.custom)}));
    return true;
  } catch {
    return false;
  }
}

/** The saved venue keys ({} when none, unreadable or invalid). */
export function readVenueKeys(): VenueKeys {
  try {
    return parseVenueKeys(JSON.parse(globalThis.localStorage?.getItem(VENUE_KEYS_KEY) ?? "null"));
  } catch {
    return {};
  }
}

/** Save the valid keys (or clear them: null, or none left). False when the browser refuses storage. */
export function writeVenueKeys(keys: VenueKeys | null): boolean {
  try {
    if (!globalThis.localStorage) return false;
    const kept = parseVenueKeys(keys);
    if (Object.keys(kept).length === 0) globalThis.localStorage.removeItem(VENUE_KEYS_KEY);
    else globalThis.localStorage.setItem(VENUE_KEYS_KEY, JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}

// ── Standard mode ──

/** The proxy slots a Standard page was built with, and where each venue's requests go when its slot is unused. */
export interface StandardPlan {
  /** `<API>/api/v2/swap-web`. */
  base: string;
  /**
   * Each venue whose provider got the proxy base → the public base its requests fall back to (same path, query,
   * body); null for a proxy-only venue (Fynd, 0x, Across), which never falls back.
   */
  venues: Readonly<Partial<Record<ProxyVenue, string | null>>>;
  /** RPC networks whose list starts with the proxy: EVM chain ids as decimal strings, and "solana". */
  rpc: ReadonlySet<string>;
  /** THORChain's confirm list starts with the proxy's THORNode pass-through (its quote nodes stay direct). */
  thornode: boolean;
}

/**
 * Standard mode's page config: every proxy slot in place, because providers, RPC clients and wallets' chain lists
 * are built once per page (D9) and the health answer may land after they are built. standard.ts decides per
 * request which slots carry traffic (only what the health answer allows; an unused one costs no request).
 * - The five venues with a public base get the proxy base, except one the page doesn't build, one this browser's saved
 *   settings pointed elsewhere (the viewer's choice stands) and, against a plain-http local API, LI.FI (its SDK
 *   refuses an http apiUrl; the escape hatch stays off). Fynd, 0x and Across get their slot whenever the page builds
 *   them: they have no other way in (providers.ts gives each SDK the proxy as its only endpoint).
 * - Every non-empty EVM list and the Solana list start with the proxy, the public URLs after it (an operator's
 *   emptied list stays empty: no reads on that chain).
 * - THORChain: the proxy's THORNode pass-through goes FIRST in the confirm list; `thorNodes`, the QUOTE nodes, stay
 *   direct and unchanged (Liquify first). The confirm list never includes the quoting host, so the proxy alone can
 *   never both quote and confirm a vault. Not against a plain-http API (the SDK refuses an http node URL).
 * `operator` = the config before the viewer's saved settings.
 */
export function standardSlots(config: RuntimeConfig, api: string, operator: RuntimeConfig = config): {config: RuntimeConfig; plan: StandardPlan} {
  const base = swapWebBase(api);
  const https = api.startsWith("https:");
  const apiBases: RuntimeConfig["api"] = {...config.api};
  const venues: Partial<Record<ProxyVenue, string | null>> = {};
  for (const v of PROXY_VENUES) {
    if (!config.providers[v]) continue;
    const key = VENUE_API_KEY[v];
    if (!key) {
      // Proxy-only (Fynd, 0x, Across): no base of its own, nothing to fall back to.
      venues[v] = null;
      continue;
    }
    if (config.api[key] !== operator.api[key] || (v === "lifi" && !https)) continue;
    venues[v] = config.api[key].replace(/\/+$/, "");
    apiBases[key] = `${base}/venue/${v}`;
  }
  const rpc = new Set<string>();
  const evmRpc: Record<number, readonly string[]> = {};
  for (const [k, urls] of Object.entries(config.evmRpc)) {
    if (urls.length) rpc.add(k);
    evmRpc[Number(k)] = urls.length ? [`${base}/rpc/${k}`, ...urls] : urls;
  }
  const solanaRpc = config.solanaRpc.length ? [`${base}/rpc/solana`, ...config.solanaRpc] : config.solanaRpc;
  if (solanaRpc.length) rpc.add("solana");
  const thornode = config.providers.thorchain && https;
  if (thornode) apiBases.thorConfirmNodes = [`${base}/venue/thornode`, ...config.api.thorConfirmNodes];
  return {config: {...config, api: apiBases, evmRpc, solanaRpc}, plan: {base, venues, rpc, thornode}};
}
