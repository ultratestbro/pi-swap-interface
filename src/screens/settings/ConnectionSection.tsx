/**
 * Settings → Connection (D30): Standard (only in a build with a cp0x API, its default there), Public or Custom,
 * and Custom's own RPC rows and venue keys. The live Standard status and what each mode sends where sit behind the
 * heading's info button: plain information, nothing to act on, so it stays out of the way until asked for. The parent sheet
 * holds the draft and saves it with everything else; the page applies a new mode after a reload (D9).
 */
import {useId, useState} from "react";
import type {ConnectionMode, ConnectionStatus, CustomEndpoints, ProxyVenue, VenueKeys} from "../../contracts/config";
import {CHAIN_LIST} from "../../catalog";
import {providerName} from "../../swap";
import {Button, ChainLogo, Field, IconButton, Switch, Text} from "../../ui";
import {NetworkPicker, type PickerNetwork} from "./NetworkPicker";
import {addCustomRpc, connectionStatusText, removeCustomRpc, type CustomNetwork} from "./store";
import s from "./Settings.module.css";

const MODE_TITLE: Readonly<Record<ConnectionMode, string>> = {standard: "Standard", public: "Public", custom: "Custom"};

const MODE_TEXT: Readonly<Record<ConnectionMode, string>> = {
  standard: "Through cp0x's server, with cp0x's keys and RPC: fewer rate limits.",
  public: "Keyless public endpoints, asked straight from this browser.",
  custom: "Public endpoints plus your own RPCs and API keys, asked straight from this browser.",
};

/** Standard's swap counter (D36), said where the mode is picked. */
const STANDARD_COUNT = "Counts each swap you send — no address.";

/** The Custom key fields, labelled with the venue's own word for its key. */
const KEY_FIELDS: readonly {field: keyof VenueKeys; label: string}[] = [
  {field: "lifi", label: "LI.FI API key"},
  {field: "relay", label: "Relay API key"},
  {field: "nearIntents", label: "NEAR Intents (1Click) JWT"},
  {field: "jupiter", label: "Jupiter API key"},
  {field: "symbiosis", label: "Symbiosis partner API key"},
];

const hasKeys = (keys: VenueKeys): boolean => KEY_FIELDS.some((k) => !!keys[k.field]);

/** Catalog EVM networks a Custom RPC can be added for, display order. */
const EVM_NETWORKS = CHAIN_LIST.filter((c) => c.family === "evm" && c.chainId !== undefined);
const evmName = (id: number) => EVM_NETWORKS.find((c) => c.chainId === id)?.name ?? `Chain ${id}`;
const evmSlug = (id: number) => EVM_NETWORKS.find((c) => c.chainId === id)?.slug ?? "";
/** What the add row's network picker offers: those networks, then Solana. */
const PICKER_NETWORKS: readonly PickerNetwork[] = [
  ...EVM_NETWORKS.map((c) => ({value: String(c.chainId), name: c.name, slug: c.slug})),
  {value: "solana", name: "Solana", slug: "solana"},
];

export interface ConnectionDraft {
  mode: ConnectionMode;
  custom: CustomEndpoints;
  keys: VenueKeys;
}

/** What "Clear keys" did, on its own line (it acts at once, apart from Save). */
function KeysNote({note}: {note: "cleared" | "failed" | null}) {
  if (note === "cleared")
    return (
      <Text as="p" variant="meta" color="var(--ink2)" role="status" data-testid="settings-keys-cleared">
        Your API keys were removed from this browser.
      </Text>
    );
  if (note === "failed")
    return (
      <Text as="p" variant="meta" color="var(--red)" role="alert">
        This browser refused to change its storage (private window or blocked site data); the keys may still be there.
      </Text>
    );
  return null;
}

export function ConnectionSection({
  modes,
  draft,
  status,
  pageMode,
  pageHost,
  readOnly,
  storedKeys,
  keysNote,
  onChange,
  onClearKeys,
}: {
  /** The modes this build offers (Standard only with a cp0x API). */
  modes: readonly ConnectionMode[];
  draft: ConnectionDraft;
  status: ConnectionStatus;
  /** The mode this page runs in (a new one applies after a reload). */
  pageMode: ConnectionMode;
  pageHost: string;
  /** Demo mode, or an IPFS path gateway: nothing can be saved, so nothing can be cleared either. */
  readOnly: boolean;
  /** The keys in this browser's storage (the draft may hold unsaved ones). */
  storedKeys: VenueKeys;
  /** What the last "Clear keys" did. */
  keysNote: "cleared" | "failed" | null;
  onChange(patch: Partial<ConnectionDraft>): void;
  onClearKeys(): void;
}) {
  const heading = useId();
  const group = useId();
  const about = useId();
  const [aboutOpen, setAboutOpen] = useState(false);
  const statusLine = connectionStatusText(status, (v: ProxyVenue) => providerName(v));
  const standard = modes.includes("standard");
  return (
    <section className={s.section} aria-labelledby={heading} data-testid="settings-connection">
      <div className={s.headRow}>
        <Text as="h3" id={heading} variant="caps" color="var(--dim)">
          Connection
        </Text>
        <IconButton
          icon="info"
          variant="flat"
          size={24}
          iconSize={16}
          iconColor={aboutOpen ? "var(--ink2)" : "var(--dim)"}
          aria-label="How the connection modes work"
          aria-expanded={aboutOpen}
          aria-controls={about}
          onClick={() => setAboutOpen((v) => !v)}
          data-testid="settings-connection-info"
        />
      </div>
      <div role="radiogroup" aria-labelledby={heading} className={s.modes}>
        {modes.map((m) => (
          <label key={m} className={s.mode}>
            <input
              type="radio"
              name={group}
              value={m}
              checked={draft.mode === m}
              onChange={() => onChange({mode: m})}
              className={s.modeInput}
              data-testid={`settings-mode-${m}`}
            />
            {MODE_TITLE[m]}
          </label>
        ))}
      </div>
      <Text as="p" variant="meta" color="var(--muted)">
        {MODE_TEXT[draft.mode]}
        {draft.mode !== pageMode ? " Applies after you save and reload." : ""}
      </Text>
      {draft.mode === "standard" ? (
        <Text as="p" variant="meta" color="var(--dim)" data-testid="settings-standard-count">
          {STANDARD_COUNT}
        </Text>
      ) : null}
      {aboutOpen ? (
        <div id={about} className={s.about} data-testid="settings-connection-about">
          {statusLine ? (
            <Text as="p" variant="meta" color="var(--ink2)" role="status" data-testid="settings-connection-status">
              {statusLine}
            </Text>
          ) : null}
          <Text as="p" variant="meta" color="var(--dim)" data-testid="settings-connection-privacy">
            {standard
              ? "Standard sends quote requests and RPC calls through cp0x's server, which adds cp0x's API keys, and tells it once per swap you send which venue and networks it used — no address or transaction. It never sees your wallet keys and signs nothing; every transaction is still checked in this browser. Public and Custom never contact cp0x. The NEAR RPC is asked directly in every mode."
              : "This copy of the app has no Standard mode and never contacts cp0x."}
          </Text>
        </div>
      ) : null}
      {draft.mode === "custom" ? (
        <CustomPanel draft={draft} pageHost={pageHost} readOnly={readOnly} storedKeys={storedKeys} keysNote={keysNote} onChange={onChange} onClearKeys={onClearKeys} />
      ) : hasKeys(storedKeys) ? (
        // Saved keys stay when another mode is picked (they count only in Custom): say so, and keep Clear at hand.
        // Only keys really in storage: ones typed under Custom and left unsaved are not "still saved".
        <div className={s.keysElsewhere}>
          <Text as="p" variant="meta" color="var(--amber)" data-testid="settings-keys-saved">
            Your API keys are still saved in this browser; only Custom mode uses them.
          </Text>
          <Button kind="secondary" height={40} title="Clear keys" icon="close" iconPosition="left" disabled={readOnly} onClick={onClearKeys} data-testid="settings-keys-clear" />
        </div>
      ) : (
        <KeysNote note={keysNote} />
      )}
    </section>
  );
}

function CustomPanel({
  draft,
  pageHost,
  readOnly,
  storedKeys,
  keysNote,
  onChange,
  onClearKeys,
}: {
  draft: ConnectionDraft;
  pageHost: string;
  readOnly: boolean;
  storedKeys: VenueKeys;
  keysNote: "cleared" | "failed" | null;
  onChange(patch: Partial<ConnectionDraft>): void;
  onClearKeys(): void;
}) {
  const only = draft.custom.only === true;
  const rows = [
    ...Object.entries(draft.custom.evmRpc).flatMap(([id, urls]) => urls.map((url) => ({network: Number(id) as CustomNetwork, url}))),
    ...draft.custom.solanaRpc.map((url) => ({network: "solana" as CustomNetwork, url})),
  ];
  return (
    <div className={s.custom} data-testid="settings-custom">
      <Text as="p" variant="meta" color="var(--amber)" data-testid="settings-rpc-trust">
        An RPC is trusted too: it answers the on-chain quotes (Uniswap, Curve, Wrap, USDT0, CCTP) and their minimums, your balances and allowances, the
        smart-account check and whether a swap landed — and your wallet may use it for a network it doesn&apos;t know yet. Use one you run or
        trust.
      </Text>
      <h4 className={s.subhead}>
        <Text variant="small" weight={600}>
          Your RPC endpoints
        </Text>
      </h4>
      <Text as="p" variant="meta" color="var(--muted)" data-testid="settings-custom-fallback">
        {only
          ? "Used alone on their networks: no public RPC is asked there, even when yours fails."
          : "Tried before the public ones, which stay as the fallback."}
      </Text>
      <div className={s.venues}>
        <div className={s.venue}>
          <span className={s.venueName}>
            <Text variant="small" weight={600}>
              Use only my RPCs
            </Text>
            <Text variant="meta" color="var(--dim)">
              On a network you added one for. Your addresses and transactions then reach no public RPC operator there.
            </Text>
          </span>
          <Switch
            checked={only}
            onChange={(on) => onChange({custom: {...draft.custom, only: on}})}
            aria-label="Use only my RPCs"
            data-testid="settings-custom-only"
          />
        </div>
      </div>
      <AddRpc custom={draft.custom} pageHost={pageHost} onAdd={(custom) => onChange({custom})} />
      {rows.length ? (
        <ul className={s.rows} aria-label="Your RPC endpoints" data-testid="settings-custom-rpcs">
          {rows.map(({network, url}) => {
            const name = network === "solana" ? "Solana" : evmName(network);
            return (
              <li key={`${network} ${url}`} className={s.row}>
                <ChainLogo slug={network === "solana" ? "solana" : evmSlug(network)} size={20} />
                <span className={s.rowText}>
                  <Text variant="small" weight={600}>
                    {name}
                  </Text>
                  <Text variant="meta" color="var(--muted)" lines={1} selectable>
                    {url}
                  </Text>
                </span>
                <IconButton
                  icon="close"
                  size={32}
                  iconSize={14}
                  variant="flat"
                  aria-label={`Remove ${url} for ${name}`}
                  onClick={() => onChange({custom: removeCustomRpc(draft.custom, network, url)})}
                />
              </li>
            );
          })}
        </ul>
      ) : null}

      <h4 className={s.subhead}>
        <Text variant="small" weight={600}>
          Your API keys
        </Text>
      </h4>
      <Text as="p" variant="meta" color="var(--amber)" data-testid="settings-keys-note">
        Stored only in this browser — anyone with access to this browser profile can read them. Each key goes only to its own venue, in a request
        header. Empty: that venue is asked without a key.
      </Text>
      {KEY_FIELDS.map(({field, label}) => (
        <Field
          key={field}
          label={label}
          type="password"
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          placeholder="Not set"
          value={draft.keys[field] ?? ""}
          onChange={(e) => onChange({keys: {...draft.keys, [field]: e.target.value.trim()}})}
          data-testid={`settings-key-${field}`}
        />
      ))}
      <Button
        kind="secondary"
        height={40}
        title="Clear keys"
        icon="close"
        iconPosition="left"
        disabled={readOnly || !(hasKeys(draft.keys) || hasKeys(storedKeys))}
        onClick={onClearKeys}
        data-testid="settings-keys-clear"
      />
      <KeysNote note={keysNote} />
    </div>
  );
}

/** One row to add an RPC: the network picker, the URL, Add (Enter in the URL adds too). */
function AddRpc({custom, pageHost, onAdd}: {custom: CustomEndpoints; pageHost: string; onAdd(custom: CustomEndpoints): void}) {
  const [network, setNetwork] = useState<string>(String(EVM_NETWORKS[0]?.chainId ?? "solana"));
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const net: CustomNetwork = network === "solana" ? "solana" : Number(network);
  const netName = net === "solana" ? "Solana" : evmName(net);
  const add = () => {
    const r = addCustomRpc(custom, net, url, pageHost);
    setError(r.error);
    if (r.error) return;
    onAdd(r.custom);
    setUrl("");
  };
  return (
    <div className={s.addRpc}>
      <NetworkPicker networks={PICKER_NETWORKS} value={network} label="Network" onChange={setNetwork} data-testid="settings-custom-network" />
      <div className={s.addUrl}>
        <Field
          aria-label={`RPC URL for ${netName}`}
          placeholder="https://…"
          inputMode="url"
          value={url}
          error={error}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          data-testid="settings-custom-url"
        />
        <Button kind="secondary" height={48} title="Add" icon="plus" iconPosition="left" disabled={!url.trim()} onClick={add} data-testid="settings-custom-add" />
      </div>
    </div>
  );
}
