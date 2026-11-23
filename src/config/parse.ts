/**
 * runtime-config.json → RuntimeConfig. Never throws: the app must boot on a
 * broken file, so every unknown key or bad value is dropped with a warning
 * and the built-in value stays. Sections merge key by key, `evmRpc` per chain
 * id, arrays replace (ARCHITECTURE.md D8).
 */
import type {ProviderName, RuntimeConfig} from "../contracts/config";
import {DEFAULT_RUNTIME_CONFIG, PROVIDER_KEYS} from "./defaults";

export interface ParsedConfig {
  config: RuntimeConfig;
  warnings: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * https: only (wss: where asked); plain http only to this machine, and only for RPCs (a local node in dev). Never
 * with `user:pass@`: fetch refuses such a URL outright, and a chain definition would hand the credentials to wallets.
 */
function url(v: unknown, opts: {wss?: boolean; localHttp?: boolean} = {}): string | null {
  if (typeof v !== "string") return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (opts.wss) return u.protocol === "wss:" ? v : null;
  if (u.protocol === "https:") return v;
  return opts.localHttp && u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname) ? v : null;
}

/** An RPC URL this parser accepts: https:, or plain http to this machine; no credentials. Custom mode's RPC rows use the same rule (D30). */
export const isRpcUrl = (v: unknown): v is string => url(v, {localHttp: true}) !== null;

function urlList(v: unknown, opts: {localHttp?: boolean; allowEmpty?: boolean} = {}): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    const u = url(x, opts);
    if (!u) return null;
    if (!out.includes(u)) out.push(u);
  }
  return out.length || opts.allowEmpty ? out : null;
}

/** The server's env format `caip2=reason;caip2=reason` (apps/api lib/crossChain suspendedChainsFromEnv, verbatim logic). */
export function suspendedChainsFromEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.trim().split(";")) {
    const i = part.indexOf("=");
    const chain = (i >= 0 ? part.slice(0, i) : part).trim();
    if (chain) out[chain] = (i >= 0 ? part.slice(i + 1) : "paused by the app").trim() || "paused by the app";
  }
  return out;
}

const hostOf = (u: string) => new URL(u).host;

export function parseRuntimeConfig(raw: unknown, base: RuntimeConfig = DEFAULT_RUNTIME_CONFIG): ParsedConfig {
  const warnings: string[] = [];
  const warn = (path: string, why: string) => warnings.push(`runtime-config: ${path} ${why} — ignored`);
  if (raw === undefined || raw === null) return {config: base, warnings};
  if (!isObj(raw)) {
    warn("(root)", "is not an object");
    return {config: base, warnings};
  }

  // Each section starts as a copy of the base and takes the valid keys of the input.
  const c = {
    ...base,
    providers: {...base.providers},
    evmRpc: {...base.evmRpc},
    api: {...base.api},
    nearIntents: {...base.nearIntents},
    cctp: {...base.cctp},
    thorchain: {...base.thorchain},
    omniston: {...base.omniston},
    pacing: {...base.pacing},
    preview: {...base.preview},
    walletConnect: {...base.walletConnect},
    prices: {...base.prices},
  };

  const section = (key: string, body: (o: Obj) => void) => {
    const v = raw[key];
    if (v === undefined) return;
    if (!isObj(v)) return warn(key, "is not an object");
    body(v);
  };
  const eachKey = (key: string, o: Obj, known: readonly string[], body: (k: string, v: unknown) => void) => {
    for (const [k, v] of Object.entries(o)) {
      if (!known.includes(k)) warn(`${key}.${k}`, "is not a known key");
      else body(k, v);
    }
  };

  for (const k of Object.keys(raw)) {
    if (!(k in base)) warn(k, "is not a known key");
  }

  if (raw.demo !== undefined) {
    if (typeof raw.demo === "boolean") c.demo = raw.demo;
    else warn("demo", "is not a boolean");
  }

  section("providers", (o) =>
    eachKey("providers", o, PROVIDER_KEYS, (k, v) => {
      if (typeof v === "boolean") c.providers[k as ProviderName] = v;
      else warn(`providers.${k}`, "is not a boolean");
    }),
  );

  section("evmRpc", (o) => {
    for (const [k, v] of Object.entries(o)) {
      const id = Number(k);
      if (!Number.isSafeInteger(id) || id <= 0) {
        warn(`evmRpc.${k}`, "is not a chain id");
        continue;
      }
      const list = urlList(v, {localHttp: true, allowEmpty: true});
      if (list) c.evmRpc[id] = list;
      else warn(`evmRpc.${k}`, "is not a list of https URLs");
    }
  });

  if (raw.solanaRpc !== undefined) {
    const list = urlList(raw.solanaRpc, {localHttp: true});
    if (list) c.solanaRpc = list;
    else warn("solanaRpc", "is not a non-empty list of https URLs");
  }

  if (raw.tronApi !== undefined) {
    const list = urlList(raw.tronApi);
    if (list) c.tronApi = list;
    else warn("tronApi", "is not a non-empty list of https URLs");
  }

  if (raw.nearRpc !== undefined) {
    const list = urlList(raw.nearRpc, {localHttp: true, allowEmpty: true});
    if (list) c.nearRpc = list;
    else warn("nearRpc", "is not a list of https URLs");
  }

  if (raw.tonApiUrl !== undefined) {
    const u = url(raw.tonApiUrl);
    if (u) c.tonApiUrl = u;
    else warn("tonApiUrl", "is not an https URL");
  }

  section("api", (o) =>
    eachKey("api", o, Object.keys(base.api), (k, v) => {
      if (k === "thorNodes" || k === "thorConfirmNodes") {
        const list = urlList(v, {allowEmpty: k === "thorConfirmNodes"});
        if (!list) return warn(`api.${k}`, "is not a list of https URLs");
        if (k === "thorNodes" && new Set(list.map(hostOf)).size < 2)
          return warn("api.thorNodes", "needs at least 2 distinct hosts (THORChain confirms the vault on a second operator)");
        c.api[k] = list;
        return;
      }
      const u = url(v, {wss: k === "omnistonWs"});
      if (u) (c.api as Record<string, unknown>)[k] = u;
      else warn(`api.${k}`, k === "omnistonWs" ? "is not a wss: URL" : "is not an https URL");
    }),
  );

  if (raw.nearIntents !== undefined) {
    const v = isObj(raw.nearIntents) ? raw.nearIntents.suspendedChains : undefined;
    if (typeof v === "string") c.nearIntents = {suspendedChains: suspendedChainsFromEnv(v)};
    else if (isObj(v) && Object.values(v).every((x) => typeof x === "string"))
      c.nearIntents = {suspendedChains: v as Record<string, string>};
    else warn("nearIntents.suspendedChains", "is neither {caip2: reason} nor \"caip2=reason;…\"");
  }

  section("cctp", (o) =>
    eachKey("cctp", o, ["mode"], (_k, v) => {
      if (v === "auto" || v === "fast" || v === "standard") c.cctp.mode = v;
      else warn("cctp.mode", "is not auto | fast | standard");
    }),
  );

  section("thorchain", (o) =>
    eachKey("thorchain", o, ["clientId"], (_k, v) => {
      if (typeof v === "string" && /^[\x21-\x7e]{1,128}$/.test(v)) c.thorchain.clientId = v;
      else warn("thorchain.clientId", "is not 1-128 visible ASCII characters");
    }),
  );

  section("omniston", (o) =>
    eachKey("omniston", o, ["maxUsd", "evmSource"], (k, v) => {
      if (k === "maxUsd" && typeof v === "number" && Number.isFinite(v) && v > 0) c.omniston.maxUsd = v;
      else if (k === "evmSource" && typeof v === "boolean") c.omniston.evmSource = v;
      else warn(`omniston.${k}`, "has the wrong type");
    }),
  );

  section("pacing", (o) =>
    eachKey("pacing", o, ["symbiosisGapMs", "jupiterGapMs", "cowGapMs"], (k, v) => {
      // CoW's orderbook allows one quote a second per IP (D48): its gap never goes under that.
      const min = k === "cowGapMs" ? 1_000 : 0;
      if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= 10_000) c.pacing[k as keyof RuntimeConfig["pacing"]] = v;
      else warn(`pacing.${k}`, `is not a number of ms in ${min}..10000`);
    }),
  );

  section("preview", (o) =>
    eachKey("preview", o, ["enabled", "roundsBurst", "roundRefillMs"], (k, v) => {
      if (k === "enabled" && typeof v === "boolean") c.preview.enabled = v;
      else if (k === "roundsBurst" && Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 20) c.preview.roundsBurst = v as number;
      else if (k === "roundRefillMs" && typeof v === "number" && Number.isFinite(v) && v >= 5_000 && v <= 600_000) c.preview.roundRefillMs = v;
      else warn(`preview.${k}`, k === "enabled" ? "is not a boolean" : k === "roundsBurst" ? "is not a whole number in 1..20" : "is not a number of ms in 5000..600000");
    }),
  );

  section("walletConnect", (o) =>
    eachKey("walletConnect", o, ["projectId"], (_k, v) => {
      if (typeof v === "string" && /^[A-Za-z0-9_-]{0,64}$/.test(v)) c.walletConnect.projectId = v;
      else warn("walletConnect.projectId", "is not a WalletConnect project id");
    }),
  );

  section("prices", (o) =>
    eachKey("prices", o, ["defillama", "coingecko"], (k, v) => {
      const u = url(v);
      if (u) c.prices[k as keyof RuntimeConfig["prices"]] = u.replace(/\/+$/, "");
      else warn(`prices.${k}`, "is not an https URL");
    }),
  );

  return {config: c, warnings};
}
