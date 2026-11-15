/**
 * Settings, for people who run their own infrastructure or want to: the
 * connection (D30: Standard through cp0x where the build has it, Public, or
 * Custom with your own RPCs and venue keys), which venues are asked, preview
 * prices before a wallet (off only), and outside Standard API base overrides
 * (your own proxy or node) and a WalletConnect project id: Standard uses the
 * site's own, so it shows and saves neither. Saved in this browser only and
 * applied on reload (the config is fixed per page, D9). Values are checked
 * with the same parser as runtime-config.json. The only secrets are Custom's
 * venue keys: kept in this browser's storage, never in the config.
 */
import {useId, useState} from "react";
import type {ConnectionSettings, ProviderName, ProxyVenue, RuntimeConfig, RuntimeConfigInput, VenueKeys} from "../../contracts/config";
import {
  DEFAULT_RUNTIME_CONFIG,
  PROVIDER_KEYS,
  PROXY_VENUES,
  VENUE_API_KEY,
  connectionModes,
  defaultConnectionMode,
  getRuntimeConfig,
  isDemo,
  isProxyUrl,
  isSharedOriginPath,
  pageConnection,
  parseRuntimeConfig,
  useConnectionStatus,
  venueKeyProblem,
} from "../../config";
import {STANDARD_ONLY_PROVIDERS, providerName} from "../../swap";
import {Button, Field, Icon, ProviderLogo, Sheet, SheetHeader, Switch, Text} from "../../ui";
import {ConnectionSection, type ConnectionDraft} from "./ConnectionSection";
import {
  localHttpBlocked,
  readConnection,
  readUserSettings,
  readVenueKeys,
  standardOnlyNote,
  urlLines,
  writeConnection,
  writeUserSettings,
  writeVenueKeys,
} from "./store";
import s from "./Settings.module.css";

type ApiKey = Exclude<keyof RuntimeConfig["api"], "thorNodes" | "thorConfirmNodes">;

const API_FIELDS: readonly {key: ApiKey; label: string}[] = [
  {key: "lifi", label: "LI.FI"},
  {key: "nearIntents", label: "NEAR Intents (1Click)"},
  {key: "relay", label: "Relay"},
  {key: "jupiter", label: "Jupiter"},
  {key: "chainflip", label: "Chainflip"},
  {key: "cctp", label: "Circle attestations (CCTP)"},
  {key: "layerZeroScan", label: "LayerZero Scan (USDT0)"},
  {key: "symbiosis", label: "Symbiosis"},
  {key: "balancer", label: "Balancer"},
  {key: "omnistonWs", label: "Omniston (wss)"},
];

/** The form's text state, built from what is saved (empty = use the default). */
interface Draft {
  providers: Partial<Record<ProviderName, boolean>>;
  /** The viewer turned preview prices off (they can't turn them on against the operator, D8). */
  previewOff: boolean;
  /** The connection mode, Custom's RPCs and keys (D30). */
  connection: ConnectionDraft;
  api: Partial<Record<ApiKey, string>>;
  thorNodes: string;
  walletConnect: string;
  defillama: string;
  coingecko: string;
}

function draftOf(saved: RuntimeConfigInput | null, connection: ConnectionSettings | null, keys: VenueKeys): Draft {
  return {
    providers: {...(saved?.providers ?? {})},
    previewOff: saved?.preview?.enabled === false,
    connection: {mode: connection?.mode ?? defaultConnectionMode(pageConnection().api), custom: connection?.custom ?? {evmRpc: {}, solanaRpc: []}, keys},
    api: Object.fromEntries(API_FIELDS.map((f) => [f.key, (saved?.api?.[f.key] as string | undefined) ?? ""])),
    thorNodes: (saved?.api?.thorNodes ?? []).join("\n"),
    walletConnect: saved?.walletConnect?.projectId ?? "",
    defillama: saved?.prices?.defillama ?? "",
    coingecko: saved?.prices?.coingecko ?? "",
  };
}

/**
 * The overrides to save: only what the viewer set (RPCs are the connection's, D30). Standard runs on the site's own
 * bases, price APIs and WalletConnect id: their fields are hidden there, and saving in Standard drops any kept from
 * another mode, so none applies unseen.
 */
function inputOf(d: Draft): RuntimeConfigInput {
  const out: RuntimeConfigInput = {};
  if (Object.keys(d.providers).length) out.providers = d.providers;
  if (d.previewOff) out.preview = {enabled: false};
  if (d.connection.mode === "standard") return out;
  const api: Partial<RuntimeConfig["api"]> = {};
  for (const f of API_FIELDS) {
    const v = d.api[f.key]?.trim();
    if (v) api[f.key] = v;
  }
  const thor = urlLines(d.thorNodes);
  if (thor.length) api.thorNodes = thor;
  if (Object.keys(api).length) out.api = api;
  if (d.walletConnect.trim()) out.walletConnect = {projectId: d.walletConnect.trim()};
  const prices: Partial<RuntimeConfig["prices"]> = {};
  if (d.defillama.trim()) prices.defillama = d.defillama.trim();
  if (d.coingecko.trim()) prices.coingecko = d.coingecko.trim();
  if (Object.keys(prices).length) out.prices = prices;
  return out;
}

/**
 * Plain-http (local node) RPCs this page can't reach: the hosted, Docker and IPFS CSP allow only https:/wss:
 * (bin/headers.mjs), so saving one would silently break that chain's reads. Allowed when served from loopback.
 */
export function blockedLocalRpcs(rpcs: {evmRpc?: Readonly<Partial<Record<number, readonly string[]>>>; solanaRpc?: readonly string[]}, pageHost: string): string[] {
  const urls: string[] = [...Object.values(rpcs.evmRpc ?? {}).flatMap((list) => list ?? []), ...(rpcs.solanaRpc ?? [])];
  return urls.flatMap((u) => localHttpBlocked(u, pageHost) ?? []);
}

/**
 * A field's placeholder: the base this page asks when the field is empty. In Standard mode that is the venue's
 * PUBLIC base, never the proxy slot standardSlots put in the config (the slot is used only as health allows;
 * pasted back as an override it would bypass both the check and the fallback).
 */
function basePlaceholder(key: ApiKey, effective: RuntimeConfig): string {
  const venue = PROXY_VENUES.find((v) => VENUE_API_KEY[v] === key);
  return (venue && pageConnection().plan?.venues[venue]) || effective.api[key];
}

/** Base and price fields that point at cp0x's own server: refused on save (only Standard mode reaches it, by itself; D30). */
function cp0xFields(d: Draft): string[] {
  const label = (key: ApiKey) => API_FIELDS.find((f) => f.key === key)?.label ?? key;
  const fields: [string, string][] = [
    ...API_FIELDS.map((f): [string, string] => [label(f.key), d.api[f.key]?.trim() ?? ""]),
    ...urlLines(d.thorNodes).map((u): [string, string] => ["THORChain nodes", u]),
    ["Prices: DefiLlama", d.defillama.trim()],
    ["Prices: CoinGecko", d.coingecko.trim()],
  ];
  return [...new Set(fields.filter(([, v]) => v && isProxyUrl(v)).map(([name]) => `${name}: that is cp0x's server. Standard mode uses it by itself; leave the field empty.`))];
}

const KEY_LABEL: Readonly<Record<keyof VenueKeys, string>> = {
  lifi: "LI.FI key",
  relay: "Relay key",
  nearIntents: "NEAR Intents JWT",
  jupiter: "Jupiter key",
  symbiosis: "Symbiosis key",
};

/** Why the draft's venue keys can't be saved (each named by its venue, never echoed). */
const keyProblems = (keys: VenueKeys): string[] =>
  (Object.entries(keys) as [keyof VenueKeys, string | undefined][]).flatMap(([field, v]) => {
    const why = v ? venueKeyProblem(field, v) : null;
    return why ? [`${KEY_LABEL[field]}: ${why}`] : [];
  });

export function SettingsSheet({open, onClose}: {open: boolean; onClose(): void}) {
  return (
    <Sheet open={open} onClose={onClose} label="Settings" width={480} phoneHeight="tall" data-testid="swap-settings">
      {/* mounted only while open (and closing): each opening re-reads what is saved */}
      <SettingsForm onClose={onClose} />
    </Sheet>
  );
}

function SettingsForm({onClose}: {onClose(): void}) {
  const effective = getRuntimeConfig();
  const [draft, setDraft] = useState<Draft>(() => draftOf(readUserSettings(), readConnection(pageConnection().api), readVenueKeys()));
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saved, setSaved] = useState<"no" | "yes" | "failed">("no");
  // Keys actually in this browser's storage (not the draft's): what the "still saved" line speaks for.
  const [storedKeys, setStoredKeys] = useState<VenueKeys>(() => readVenueKeys());
  // Clear keys acts at once and says so here, apart from Save: the rest of the draft is still unsaved.
  const [keysNote, setKeysNote] = useState<"cleared" | "failed" | null>(null);
  const status = useConnectionStatus();
  const demo = isDemo();
  // An IPFS path gateway shares one origin with every site on it: saved settings are not applied there (D8).
  const shared = isSharedOriginPath(typeof location !== "undefined" ? location.pathname : undefined);
  const pageHost = typeof location !== "undefined" ? location.hostname : "";
  const thorId = useId();
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({...d, ...patch}));
    setSaved("no");
    setKeysNote(null);
  };

  function save() {
    const input = inputOf(draft);
    const parsed = parseRuntimeConfig(input, DEFAULT_RUNTIME_CONFIG);
    const custom = draft.connection.custom;
    // Keys are written only with Custom, the one mode that uses them; another mode leaves the stored ones as they are.
    const inCustom = draft.connection.mode === "custom";
    const all = [
      ...parsed.warnings.map((w) => w.replace(/^runtime-config: /, "")),
      ...(draft.connection.mode === "standard" ? [] : cp0xFields(draft)),
      ...(inCustom ? blockedLocalRpcs(custom, pageHost) : []),
      ...(inCustom ? keyProblems(draft.connection.keys) : []),
    ];
    setWarnings(all);
    if (all.length) return;
    const ok = writeUserSettings(input) && writeConnection({mode: draft.connection.mode, custom}) && (!inCustom || writeVenueKeys(draft.connection.keys));
    if (ok && inCustom) setStoredKeys(readVenueKeys());
    // Keys typed under Custom and then left for another mode were never saved: the draft goes back to the stored ones.
    if (ok && !inCustom) setDraft((d) => ({...d, connection: {...d.connection, keys: storedKeys}}));
    setSaved(ok ? "yes" : "failed");
  }

  /** Back to the site's settings: the overrides, the connection choice, Custom's RPCs and keys all go. */
  function reset() {
    setDraft(draftOf(null, null, {}));
    setWarnings([]);
    setKeysNote(null);
    const ok = writeUserSettings(null) && writeConnection(null) && writeVenueKeys(null);
    if (ok) setStoredKeys({});
    setSaved(ok ? "yes" : "failed");
  }

  /**
   * Clear the venue keys at once (not only on Save): the note says where they live, this removes them. Says so on
   * its own line; Save stays, since the rest of the draft (a mode, RPC rows) is not written by this.
   */
  function clearKeys() {
    setDraft((d) => ({...d, connection: {...d.connection, keys: {}}}));
    const ok = writeVenueKeys(null);
    if (ok) setStoredKeys({});
    setKeysNote(ok ? "cleared" : "failed");
  }

  const venueOn = (p: ProviderName) => draft.providers[p] ?? effective.providers[p];
  // Off on this page although this browser didn't turn it off: the site's operator did, and a viewer can't undo that.
  const previewOperatorOff = !effective.preview.enabled && readUserSettings()?.preview?.enabled !== false;
  const standardOnly = new Set<ProviderName>(STANDARD_ONLY_PROVIDERS);
  // A build without a cp0x API has no Standard mode: its Standard-only venues (Fynd, 0x, Across) can never be asked here.
  const hasStandard = connectionModes(pageConnection().api).includes("standard");
  const unreachable = (p: ProviderName) => standardOnly.has(p) && !hasStandard;

  return (
    <div className={s.body}>
      <SheetHeader title="Settings" sub="Saved in this browser only · applied after a reload" onClose={onClose} />

      <ConnectionSection
        modes={connectionModes(pageConnection().api)}
        draft={draft.connection}
        status={status}
        pageMode={pageConnection().mode}
        pageHost={pageHost}
        readOnly={demo || shared}
        storedKeys={storedKeys}
        keysNote={keysNote}
        onChange={(patch) => set({connection: {...draft.connection, ...patch}})}
        onClearKeys={clearKeys}
      />

      <section className={s.section} aria-label="Venues">
        <Text as="h3" variant="caps" color="var(--dim)">
          Venues asked for quotes
        </Text>
        <div className={s.venues}>
          {PROVIDER_KEYS.map((p) => (
            <div key={p} className={s.venue}>
              <ProviderLogo provider={p} size={24} />
              <span className={s.venueName}>
                <Text variant="small" weight={600}>
                  {providerName(p)}
                </Text>
                {standardOnly.has(p) ? (
                  <Text variant="meta" color="var(--dim)" data-testid={`settings-venue-${p}-note`}>
                    {standardOnlyNote(p as ProxyVenue, hasStandard, status)}
                  </Text>
                ) : null}
              </span>
              <Switch
                checked={venueOn(p) && !unreachable(p)}
                disabled={unreachable(p)}
                onChange={(on) => set({providers: {...draft.providers, [p]: on}})}
                aria-label={`Ask ${providerName(p)}`}
                data-testid={`settings-venue-${p}`}
              />
            </div>
          ))}
        </div>
      </section>

      <section className={s.section} aria-label="Preview prices">
        <Text as="h3" variant="caps" color="var(--dim)">
          Preview prices
        </Text>
        <div className={s.venues}>
          <div className={s.venue}>
            <span className={s.venueName}>
              <Text variant="small" weight={600}>
                Show prices before a wallet is connected
              </Text>
              <Text variant="meta" color="var(--dim)">
                {previewOperatorOff
                  ? "The site's operator turned preview prices off."
                  : "Venues are asked with a sample address, a few times a minute at most. Off: routes appear once your wallet or address is in."}
              </Text>
            </span>
            <Switch
              checked={!previewOperatorOff && !draft.previewOff}
              disabled={previewOperatorOff}
              onChange={(on) => set({previewOff: !on})}
              aria-label="Show preview prices before a wallet is connected"
              data-testid="settings-preview"
            />
          </div>
        </div>
      </section>

      {/* Standard runs on the site's own bases, price APIs and WalletConnect id (inputOf saves none there). */}
      {draft.connection.mode === "standard" ? null : (
        <>
          <details className={s.disclosure}>
            <summary className={s.summary}>
              <Text variant="caps" color="var(--dim)">
                Venue API bases
              </Text>
              <Icon name="chevronDown" size={12} color="var(--dim)" className={s.chevron} />
            </summary>
            <div className={s.fields}>
              <Text as="p" variant="meta" color="var(--amber)">
                Pointing a venue at another server means trusting that server&apos;s quotes. Leave a field empty for the default.
              </Text>
              {API_FIELDS.map((f) => (
                <Field
                  key={f.key}
                  label={f.label}
                  placeholder={basePlaceholder(f.key, effective)}
                  value={draft.api[f.key] ?? ""}
                  onChange={(e) => set({api: {...draft.api, [f.key]: e.target.value}})}
                />
              ))}
              <label className={s.textareaLabel} htmlFor={thorId}>
                <Text variant="caps" color="var(--dim)">
                  THORChain nodes (two or more hosts)
                </Text>
                <textarea id={thorId} className={s.textarea} spellCheck={false} placeholder={effective.api.thorNodes.join("\n")} value={draft.thorNodes} onChange={(e) => set({thorNodes: e.target.value})} />
              </label>
              <Field label="Prices: DefiLlama" placeholder={effective.prices.defillama} value={draft.defillama} onChange={(e) => set({defillama: e.target.value})} />
              <Field label="Prices: CoinGecko" placeholder={effective.prices.coingecko} value={draft.coingecko} onChange={(e) => set({coingecko: e.target.value})} />
            </div>
          </details>

          <section className={s.section} aria-label="WalletConnect">
            <Field
              label="WalletConnect project id"
              placeholder={effective.walletConnect.projectId || "Not set — WalletConnect is hidden"}
              value={draft.walletConnect}
              onChange={(e) => set({walletConnect: e.target.value})}
              hint="Public by design (WalletConnect Cloud). Empty keeps the site's own, or hides WalletConnect."
            />
          </section>
        </>
      )}

      {warnings.length ? (
        <div role="alert">
          {warnings.map((w) => (
            <Text key={w} as="p" variant="meta" color="var(--red)">
              {w}
            </Text>
          ))}
        </div>
      ) : null}
      {saved === "failed" ? (
        <Text as="p" variant="meta" color="var(--red)" role="alert">
          This browser refused to store settings (private window or blocked site data).
        </Text>
      ) : null}
      {demo ? (
        <Text as="p" variant="meta" color="var(--amber)">
          Demo mode never saves anything.
        </Text>
      ) : null}
      {shared ? (
        <Text as="p" variant="meta" color="var(--amber)" data-testid="settings-shared-origin">
          This page is on an IPFS path gateway (/ipfs/…), whose origin every site on it shares — any of them could change saved settings, so
          they are not used here. Open the app on a subdomain gateway (https://&lt;cid&gt;.ipfs.dweb.link/) to save settings.
        </Text>
      ) : null}

      <div className={s.actions}>
        {saved === "yes" ? (
          <Button block title="Saved — reload to apply" icon="refresh" iconPosition="left" onClick={() => location.reload()} data-testid="settings-reload" />
        ) : (
          <Button block title="Save" disabled={demo || shared} onClick={save} data-testid="settings-save" />
        )}
        <Button block kind="ghost" height={40} title="Reset to the site's settings" disabled={demo} onClick={reset} data-testid="settings-reset" />
      </div>
    </div>
  );
}
