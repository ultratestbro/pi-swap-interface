/**
 * Importing a token by its address (D39), inside the token sheet: the search result for an address no listed token has
 * on the lookup network (read on-chain, with a network chooser for an EVM contract), and the confirmation — monogram,
 * symbol, name, network, the full address with its explorer page, the warning, an amber line when it reads like a
 * listed token, and a required "I understand" before "Import". Reads go through the catalog port only.
 */
import {useId, useState} from "react";
import type {SwapToken, Token, TokenLookup} from "../../contracts/domain";
import {usePorts} from "../../config";
import {addressUrl, chainBySlugWeb, shortAddress} from "../../catalog";
import {Button, CopyButton, Icon, SheetHeader, Skeleton, Tag, Text, TokenIcon} from "../../ui";
import {EVM_IMPORT_NETWORKS, IMPORT_WARNING, lookalikeLine, provisional} from "./importModel";
import s from "./TokenSheet.module.css";

export interface ImportResultProps {
  /** The lookup network's slug. */
  chain: string;
  address: string;
  family: "evm" | "solana";
  lookup: TokenLookup;
  /** Look the contract up on another EVM network (EVM only). */
  onNetwork(slug: string): void;
  onImport(token: Token): void;
}

/** The "Import token" search result: what the chain says the address is, or why it can't be imported, and where to look. */
export function ImportResult({chain, address, family, lookup, onNetwork, onImport}: ImportResultProps) {
  const id = useId();
  const net = chainBySlugWeb(chain);
  const token = lookup.status === "found" ? lookup.token : null;
  return (
    <div className={s.importCard} data-testid="swap-import-result" aria-live="polite">
      <div className={s.importHead}>
        <Text variant="caps" color="var(--dim)">
          Import token
        </Text>
        {family === "evm" ? (
          <label className={s.importNet} htmlFor={id}>
            <span className={s.srOnly}>Look it up on</span>
            <select id={id} className={s.importSelect} value={chain} onChange={(e) => onNetwork(e.target.value)} data-testid="swap-import-network">
              {EVM_IMPORT_NETWORKS.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
            <Icon name="chevronDown" size={12} color="var(--muted)" />
          </label>
        ) : null}
      </div>
      {token ? (
        <button type="button" className={s.token} onClick={() => onImport(token)} data-testid="swap-import-open" aria-label={`Import ${token.symbol} on ${token.chainName}`}>
          <TokenIcon token={token} size={34} />
          <span className={s.tokenText}>
            <Text variant="listTitle" lines={1}>
              {token.symbol}
            </Text>
            <Text variant="meta" color="var(--dim)" lines={1}>
              {`${token.name} · ${token.chainName} · ${shortAddress(address)}`}
            </Text>
          </span>
          <Tag tone="amber">Import</Tag>
        </button>
      ) : lookup.status === "failed" ? (
        <Text as="p" variant="small" color="var(--amber)" className={s.importNote} role="status" data-testid="swap-import-failed">
          {lookup.reason}
        </Text>
      ) : (
        <div className={s.importLoading} role="status" aria-label={`Reading the token on ${net?.name ?? chain}`}>
          <Skeleton width={34} height={34} radius={17} />
          <span className={s.tokenText}>
            <Skeleton width={70} height={14} />
            <Text variant="meta" color="var(--dim)" lines={1}>
              {`Reading it on ${net?.name ?? chain}…`}
            </Text>
          </span>
        </div>
      )}
    </div>
  );
}

export interface ImportConfirmProps {
  caip2: string;
  address: string;
  /** The side's list (the picked token's network state comes from it). */
  tokens: readonly SwapToken[];
  /** Back to the list (from the search); absent when the confirmation is all there is (a pair link). */
  onBack?(): void;
  onClose(): void;
  /** Confirmed: kept in this browser; the form picks it. */
  onImported(t: SwapToken): void;
}

/** The import confirmation (D39): the warning and a required "I understand" before the token is kept. */
export function ImportConfirm({caip2, address, tokens, onBack, onClose, onImported}: ImportConfirmProps) {
  const ports = usePorts();
  const lookup = ports.catalog.useTokenLookup(caip2, address);
  const [understood, setUnderstood] = useState(false);
  const check = useId();
  const token = lookup.status === "found" ? lookup.token : null;
  const lookalike = token ? lookalikeLine(token) : null;
  const explorer = token ? addressUrl(token.caip2, address) : undefined;

  const confirm = () => {
    if (!token || !understood) return;
    ports.catalog.importToken(token);
    onImported(provisional(token, tokens));
  };

  return (
    <div className={s.confirm} data-testid="swap-import-confirm">
      <SheetHeader title="Import token" sub={token ? `on ${token.chainName}` : undefined} onBack={onBack} onClose={onClose} />
      <div className={s.confirmBody}>
        {token ? (
          <>
            <div className={s.confirmToken}>
              <TokenIcon token={token} size={52} />
              <div className={s.confirmNames}>
                <Text as="h3" variant="title" lines={1} selectable data-testid="swap-import-symbol">
                  {token.symbol}
                </Text>
                <Text variant="small" color="var(--ink2)" lines={2} selectable data-testid="swap-import-name">
                  {token.name}
                </Text>
                <Text variant="meta" color="var(--muted)">
                  {`${token.chainName} · ${token.decimals} decimals`}
                </Text>
              </div>
            </div>
            <div className={s.addressBox}>
              <Text variant="caps" color="var(--dim)">
                Contract address
              </Text>
              <div className={s.addressRow}>
                <Text as="p" variant="small" selectable className={s.mono} data-testid="swap-import-address">
                  {address}
                </Text>
                <CopyButton value={address} aria-label="Copy the contract address" data-testid="swap-import-copy" />
              </div>
              {explorer ? (
                <a className={s.explorer} href={explorer} target="_blank" rel="noopener noreferrer" data-testid="swap-import-explorer">
                  View on the {token.chainName} explorer
                  <Icon name="external" size={13} />
                </a>
              ) : null}
            </div>
            <div className={s.warnBox} role="note" data-testid="swap-import-warning">
              <Icon name="info" size={16} color="var(--amber)" />
              <Text as="p" variant="small" color="var(--ink2)" className={s.warnText}>
                {IMPORT_WARNING}
              </Text>
            </div>
            {lookalike ? (
              <Text as="p" variant="small" weight={600} color="var(--amber)" role="alert" data-testid="swap-import-lookalike">
                {lookalike}
              </Text>
            ) : null}
            <label className={s.understand} htmlFor={check}>
              <input id={check} type="checkbox" className={s.checkbox} checked={understood} onChange={(e) => setUnderstood(e.target.checked)} data-testid="swap-import-understand" />
              <Text variant="small" weight={600}>
                I understand
              </Text>
            </label>
            <div className={s.confirmActions}>
              <Button block height={48} title="Import" disabled={!understood} onClick={confirm} data-testid="swap-import-confirm-button" />
              <Button block kind="ghost" height={40} title="Cancel" onClick={onBack ?? onClose} data-testid="swap-import-cancel" />
            </div>
          </>
        ) : lookup.status === "failed" ? (
          <>
            <Text as="p" variant="small" color="var(--amber)" role="alert" data-testid="swap-import-failed">
              {lookup.reason}
            </Text>
            <Text as="p" variant="meta" color="var(--muted)" selectable className={s.mono}>
              {address}
            </Text>
            <Button block kind="secondary" height={40} title={onBack ? "Back" : "Close"} onClick={onBack ?? onClose} />
          </>
        ) : (
          <div className={s.importLoading} role="status" aria-label="Reading the token">
            <Skeleton width={52} height={52} radius={26} />
            <span className={s.tokenText}>
              <Skeleton width={90} height={18} />
              <Text variant="meta" color="var(--dim)">
                {`Reading ${shortAddress(address)} on-chain…`}
              </Text>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
