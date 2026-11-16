/**
 * The token picker (mobile components/SwapTokenSheet.tsx, ui-port.md §5.7): a
 * search field, a rail of networks (pinned six, then held, then the rest) and
 * the chosen network's tokens, held first. "All" lists what the connected
 * wallets hold anywhere; typing searches every network. Long lists (search,
 * a big network) are virtualized.
 *
 * Importing by address (D39): a pasted EVM contract or Solana mint that no
 * token on the lookup network has shows an "Import token" result, read
 * on-chain — an EVM contract on the network the sheet is filtered to (with
 * "All networks", the other side's, else this side's, else Ethereum), with a
 * chooser for another; a mint on Solana. Opening it shows the confirmation
 * (ImportToken.tsx); a confirmed import is kept in this browser and listed
 * under the catalog with an "Imported" badge and a remove button. An address of
 * TON, Tron, NEAR, Bitcoin or Zcash says it can't be imported yet (unless it is a
 * listed token's, which simply shows as its row).
 */
import {useVirtualizer} from "@tanstack/react-virtual";
import {useMemo, useRef, useState, type ReactNode, type RefObject} from "react";
import type {SwapToken} from "../../contracts/domain";
import {usePorts} from "../../config";
import {chainBySlugWeb, detectTokenAddress, formatAmount, formatUsd, importable, matchesToken, pickerNetworks} from "../../catalog";
import {AssetIcon, Divider, Field, Icon, IconButton, Sheet, SheetHeader, Tag, Text, TokenIcon} from "../../ui";
import {ImportConfirm, ImportResult} from "./ImportToken";
import {EVM_IMPORT_NETWORKS, importCandidates, importNetworks, lookupNetwork, shownImportNetwork, showsAddress, tokenAt, unsupportedLine} from "./importModel";
import s from "./TokenSheet.module.css";

const ALL = "all";
/** Rows of the list; above this many the list is virtualized. */
const ROW_PX = 52;
const VIRTUAL_FROM = 60;

/** An import to confirm: the address and the network it was read on. */
export interface ImportTarget {
  caip2: string;
  address: string;
}

export interface TokenSheetProps {
  open: boolean;
  side: "pay" | "receive";
  tokens: readonly SwapToken[];
  /** The side's current token key. */
  selected?: string;
  /** The other side's token: where a pasted EVM contract is looked up with "All networks" (D39). */
  other?: SwapToken;
  /** Open on this import's confirmation (a pair link naming a token the list doesn't have, D39). */
  importing?: ImportTarget | null;
  onPick(t: SwapToken): void;
  onClose(): void;
}

export function TokenSheet({open, side, tokens, selected, other, importing, onPick, onClose}: TokenSheetProps) {
  const search = useRef<HTMLInputElement>(null);
  const title = side === "pay" ? "You pay" : "You receive";
  return (
    <Sheet open={open} onClose={onClose} label={title} width={480} phoneHeight="full" flush initialFocus={importing ? undefined : search} data-testid="swap-token-sheet">
      {/* the sheet mounts its content only while open (and while closing), so each opening starts fresh */}
      <Picker
        key={`${side}:${importing?.address ?? ""}`}
        title={title}
        side={side}
        tokens={tokens}
        selected={selected}
        other={other}
        importing={importing}
        onPick={onPick}
        onClose={onClose}
        search={search}
      />
    </Sheet>
  );
}

interface PickerProps extends Omit<TokenSheetProps, "open"> {
  title: string;
  search: RefObject<HTMLInputElement | null>;
}

function Picker({title, side, tokens, selected, other, importing, onPick, onClose, search}: PickerProps) {
  const ports = usePorts();
  const networks = useMemo(() => pickerNetworks(tokens), [tokens]);
  const anyHeld = networks.some((n) => n.held);
  const own = tokens.find((t) => t.key === selected);
  // Open on the selected token's network, else "All" when something is held, else the first network (mobile L117-122).
  const [net, setNet] = useState<string>(() => own?.chain ?? (anyHeld ? ALL : (networks[0]?.slug ?? ALL)));
  const [q, setQ] = useState("");
  // The import being confirmed (D39): opened from the search, or given by a pair link (then it is the whole sheet).
  const [confirming, setConfirming] = useState<ImportTarget | null>(importing ?? null);
  /** The network the viewer picked for a pasted EVM contract (the result's chooser), or null for the default. */
  const [lookupPick, setLookupPick] = useState<string | null>(null);
  const searching = q.trim().length > 0;

  // A pasted token address (D39): an EVM contract is read on every EVM network whose list doesn't have it (the chooser
  // lists where it is a token), a Solana mint on Solana; then the network shown, and whether the list already has it.
  const pasted = searching ? detectTokenAddress(q) : null;
  const importAddr = pasted && pasted.family !== "unsupported" ? pasted : null;
  const evmAddr = importAddr?.family === "evm" ? importAddr.address : null;
  const candidates = evmAddr ? importCandidates(tokens, evmAddr) : [];
  const probe = ports.catalog.useTokenLookups(candidates.map((c) => c.caip2), evmAddr);
  const found = evmAddr ? importNetworks(candidates, probe.lookups) : undefined;
  const preferred = importAddr ? lookupNetwork({family: importAddr.family, sheetNet: net === ALL ? null : net, other, own}) : null;
  const lookupSlug =
    importAddr && preferred
      ? importAddr.family === "evm"
        ? shownImportNetwork({pick: lookupPick, preferred, candidates, lookups: probe.lookups})
        : preferred
      : null;
  const lookupChain = lookupSlug ? chainBySlugWeb(lookupSlug) : undefined;
  const listedThere = importAddr && lookupSlug ? tokenAt(tokens, lookupSlug, importAddr.address) : undefined;
  const lookupFor = importAddr && importable(lookupChain) && !listedThere ? {caip2: lookupChain.caip2, address: importAddr.address} : null;
  const lookup = ports.catalog.useTokenLookup(lookupFor?.caip2 ?? null, lookupFor?.address ?? null);

  const shown = useMemo(() => {
    if (searching) return tokens.filter((t) => matchesToken(t, q));
    if (net === ALL) return tokens.filter((t) => t.amount !== "0");
    return tokens.filter((t) => t.chain === net);
  }, [tokens, q, net, searching]);
  const current = networks.find((n) => n.slug === net);
  const heading = searching ? "Search results" : net === ALL ? "Your tokens" : (current?.name ?? "");
  const headingValue = searching ? "" : net === ALL ? (anyHeld ? formatUsd(networks.reduce((sum, n) => sum + n.usd, 0)) : "") : current?.held ? formatUsd(current.usd) : "";
  const showNetwork = searching || net === ALL;

  const scroller = useRef<HTMLDivElement>(null);
  const long = shown.length > VIRTUAL_FROM;

  const pick = (t: SwapToken) => {
    setQ("");
    onPick(t);
  };
  const row = (t: SwapToken) => (
    <TokenRow
      key={t.key}
      t={t}
      side={side}
      selected={t.key === selected}
      showNetwork={showNetwork}
      onPick={() => pick(t)}
      onRemove={t.imported ? () => ports.catalog.removeImportedToken(t.key) : undefined}
    />
  );

  if (confirming) {
    return (
      <ImportConfirm
        caip2={confirming.caip2}
        address={confirming.address}
        tokens={tokens}
        // From the search, Back returns to it; a pair link's confirmation is the whole sheet.
        onBack={importing ? undefined : () => setConfirming(null)}
        onClose={onClose}
        onImported={pick}
      />
    );
  }

  const importBlock = pasted ? (
    pasted.family === "unsupported" ? (
      // A listed token's address (TON USDT's master, say) is just that token's row below.
      showsAddress(shown, q) ? null : (
        <Text as="p" variant="small" color="var(--muted)" className={s.empty} data-testid="swap-import-unsupported">
          {unsupportedLine(pasted.addressFamily)}
        </Text>
      )
    ) : found ? (
      // Found nowhere while the list has it on some network: that row is the answer, with nothing to import.
      !lookupFor && !found.reading && candidates.length < EVM_IMPORT_NETWORKS.length ? null : (
        <ImportResult
          chain={lookupFor ? lookupSlug : null}
          address={pasted.address}
          family="evm"
          lookup={lookup}
          networks={found}
          onNetwork={setLookupPick}
          onRetry={probe.retry}
          onImport={(t) => setConfirming({caip2: t.caip2, address: t.contract ?? pasted.address})}
        />
      )
    ) : lookupFor && lookupSlug ? (
      <ImportResult
        chain={lookupSlug}
        address={lookupFor.address}
        family={pasted.family}
        lookup={lookup}
        onNetwork={setLookupPick}
        onImport={(t) => setConfirming({caip2: t.caip2, address: t.contract ?? lookupFor.address})}
      />
    ) : null
  ) : null;

  return (
    <>
      <div className={s.top}>
        <SheetHeader title={title} onClose={onClose} />
        <Field
          ref={search}
          aria-label="Search tokens or networks, or paste a token address"
          placeholder="Search, or paste a token address"
          leading={<Icon name="search" size={16} color="var(--muted)" />}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setLookupPick(null);
          }}
          data-testid="swap-token-search"
          enterKeyHint="search"
        />
      </div>
      <Divider />
      <div className={s.body}>
        <nav className={s.rail} aria-label="Networks">
          {[{slug: ALL, name: "All networks", held: false}, ...networks].map((n) => (
            <button
              key={n.slug}
              type="button"
              className={s.railItem}
              aria-pressed={!searching && n.slug === net}
              aria-label={n.held ? `${n.name}, has balance` : n.name}
              title={n.name}
              data-testid={`swap-net-${n.slug}`}
              onClick={() => {
                setQ("");
                setNet(n.slug);
              }}
            >
              {n.slug === ALL ? (
                <span className={s.all}>
                  <Text variant="tag" color="var(--ink2)">
                    All
                  </Text>
                </span>
              ) : (
                <AssetIcon network={n.slug} size={30} />
              )}
              {n.held ? <span className={s.heldDot} aria-hidden="true" /> : null}
            </button>
          ))}
        </nav>
        <div className={s.pane}>
          <div className={s.heading}>
            <Text variant="bodyStrong" lines={1}>
              {heading}
            </Text>
            {headingValue ? (
              <Text variant="meta" color="var(--muted)" tabular>
                {headingValue}
              </Text>
            ) : null}
          </div>
          <div ref={scroller} className={s.scroll} role="list" aria-label={heading}>
            {importBlock}
            {shown.length === 0 ? (
              importBlock ? null : (
                <Text as="p" variant="small" color="var(--muted)" className={s.empty}>
                  {searching ? `Nothing matches “${q.trim()}”.` : net === ALL ? "No balances yet — pick a network on the left." : "No tokens on this network."}
                </Text>
              )
            ) : long ? (
              <VirtualRows count={shown.length} scroller={scroller} render={(i) => row(shown[i]!)} />
            ) : (
              shown.map(row)
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** Only the rows in view (plus overscan) are in the DOM: "All" + a search can list ~400 tokens. */
function VirtualRows({count, scroller, render}: {count: number; scroller: RefObject<HTMLDivElement | null>; render(i: number): ReactNode}) {
  // TanStack Virtual hands back fresh functions every render, so this component must not be memoized (and isn't).
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtual = useVirtualizer({count, getScrollElement: () => scroller.current, estimateSize: () => ROW_PX, overscan: 8});
  return (
    <div className={s.virtual} style={{height: virtual.getTotalSize()}}>
      {virtual.getVirtualItems().map((v) => (
        <div key={v.key} className={s.virtualRow} style={{transform: `translateY(${v.start}px)`}}>
          {render(v.index)}
        </div>
      ))}
    </div>
  );
}

interface TokenRowProps {
  t: SwapToken;
  side: "pay" | "receive";
  selected: boolean;
  showNetwork: boolean;
  onPick(): void;
  /** An imported token (D39): forget it in this browser. */
  onRemove?: (() => void) | undefined;
}

/**
 * One token: icon (network badge when the list mixes networks), symbol, chain, and the held amount + USD. An imported
 * token (D39) carries an "Imported" badge, its name, and a remove button beside the row.
 */
function TokenRow({t, side, selected, showNetwork, onPick, onRemove}: TokenRowProps) {
  const held = t.amount !== "0";
  const qr = side === "pay" && t.payMode === "deposit";
  const connect = side === "pay" && t.payMode === "connect";
  const sub = [t.imported ? t.name : null, showNetwork ? t.chainName : null, qr ? "pay by QR" : connect ? "connect a wallet" : null].filter(Boolean).join(" · ");
  return (
    <div role="listitem" className={s.tokenItem}>
      <button
        type="button"
        className={s.token}
        aria-current={selected || undefined}
        aria-label={`${t.symbol}${t.imported ? " (imported)" : ""} on ${t.chainName}${held ? `, ${formatAmount(t.amount, t.decimals)} held` : ""}`}
        data-testid={`swap-token-${t.key}`}
        onClick={onPick}
      >
        <TokenIcon token={t} size={34} badge={showNetwork} />
        <span className={s.tokenText}>
          <span className={s.symbolLine}>
            <Text variant="listTitle" lines={1}>
              {t.symbol}
            </Text>
            {t.imported ? <Tag tone="amber">Imported</Tag> : null}
          </span>
          {sub ? (
            <Text variant="meta" color="var(--dim)" lines={1}>
              {sub}
            </Text>
          ) : null}
        </span>
        {held ? (
          <span className={s.held}>
            <Text variant="small" color="var(--ink2)" tabular>
              {formatAmount(t.amount, t.decimals)}
            </Text>
            <Text variant="meta" color="var(--dim)" tabular>
              {t.priceUsd !== undefined ? formatUsd(t.usd) : "—"}
            </Text>
          </span>
        ) : null}
      </button>
      {onRemove ? (
        <IconButton
          icon="close"
          size={30}
          iconSize={12}
          variant="flat"
          className={s.remove}
          aria-label={`Remove the imported ${t.symbol} on ${t.chainName}`}
          title="Remove from this browser"
          onClick={onRemove}
          data-testid={`swap-token-remove-${t.key}`}
        />
      ) : null}
    </div>
  );
}
