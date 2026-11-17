/**
 * One row of the route list in its states (ui-port.md §2.2, §5.5): a quoted
 * route (radio: venue, Best/Fastest, trust badge, guaranteed amount, ETA,
 * fees, gas), a venue still quoting, a venue that sat out (its short reason,
 * and behind a disclosure why and the venue's own text), and an enabled venue
 * that doesn't serve the pair. The row shows the expected amount — the number
 * the receive card shows for the chosen route — and the guaranteed minimum the
 * swap enforces under it (web, D37: the minimum alone read as a worse price than
 * the receive card's); a preview row (D7) marks it as an estimate ("≈", a
 * "Preview" tag), since it was priced before the user's addresses existed. A
 * row whose route was quoted for the previous slippage or address keeps its
 * place with its numbers dimmed until the venue answers again (D32); it says
 * "updating" only while a round runs.
 */
import type {Ref} from "react";
import type {SwapToken} from "../../contracts/domain";
import type {RouteRejection, WebRoute} from "../../contracts/routes";
import {formatAmount, formatUsd} from "../../catalog";
import {etaLabel, gasBound, providerName, routeFloor, venueTrustText} from "../../swap";
import {Badge, CopyButton, Icon, ProviderLogo, Spinner, Text, VenueBadge, useBreakpoint} from "../../ui";
import type {Held, NotForPair} from "../form/model";
import s from "./Routes.module.css";

export interface RouteRowProps {
  route: WebRoute;
  /** The receive token (amount, symbol, price). */
  to: SwapToken;
  /** The pay chain's name (the trust badge's "contracts on {chain}"). */
  payChainName: string;
  selected: boolean;
  /** Roving tab stop of the radiogroup. */
  tabbable: boolean;
  /** Show the trust sentence as a third line (the phone's route sheet has no hover). */
  trustLine?: boolean;
  /** A preview price (snapshot mode "preview"): an estimate to read, not a quote to review. */
  preview?: boolean;
  /** Quoted for other terms (D32): the numbers stay, dimmed; busy while the round for the new terms runs. */
  held?: Held;
  onSelect(): void;
  ref?: Ref<HTMLButtonElement>;
}

/** The row's ETA, or nothing when the venue gives none (Stargate; LI.FI between networks): never a bare "—". */
const etaPart = (seconds: number): string | null => {
  const eta = etaLabel(seconds);
  return eta === "—" ? null : eta;
};

/**
 * "~45 s · fees $0.41 · gas ≤ $0.03 · approval" (SwapRouteRow line 2). The fees are the venue's own plus a bridge fee
 * it charges on top and leaves out of them (USDT0's and Stargate's LayerZero fee, `bridgeFeeUsd`). An unknown ETA is
 * left out, as the review does.
 */
export function routeMeta(r: WebRoute): string {
  const feeUsd = r.feeUsd + (r.bridgeFeeUsd ?? 0);
  return [
    etaPart(r.etaSeconds),
    feeUsd > 0 ? `fees ${formatUsd(feeUsd)}` : r.gasUsd === null ? "fees in price" : null,
    r.gasUsd !== null ? gasBound(r.gasUsd) : null,
    r.approvalSpender ? "approval" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The "Preview" tag's tooltip: why the number is an estimate. */
export const PREVIEW_TAG_TEXT = "Priced for a sample address — your own quote loads once your wallet or address is in, and can differ slightly";

export function RouteRow({route, to, payChainName, selected, tabbable, trustLine, preview, held, onSelect, ref}: RouteRowProps) {
  const name = providerName(route.provider);
  // The expected amount, as the receive card shows it, and under it the minimum the swap enforces (the execution
  // floor), the same number the summary and the review show — not the venue's own minimum, a margin above it.
  const out = formatAmount(route.destAmount.toString(), to.decimals);
  const min = formatAmount(routeFloor(route).toString(), to.decimals);
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabbable ? 0 : -1}
      aria-label={`${name}, ${preview ? "preview, " : ""}about ${out} ${to.symbol}, at least ${min} ${to.symbol}${etaPart(route.etaSeconds) ? `, ${etaPart(route.etaSeconds)}` : ""}${held ? `, ${held}` : ""}`}
      aria-busy={held === "updating" || undefined}
      data-testid={`swap-route-${route.provider}`}
      data-provider={route.provider}
      className={held ? `${s.row} ${s.updating}` : s.row}
      onClick={onSelect}
    >
      <ProviderLogo provider={route.provider} size={32} name={name} />
      <span className={s.middle}>
        <span className={s.line1}>
          <Text variant="listTitle" lines={1} className={s.name}>
            {name}
          </Text>
          {route.tags.includes("best") ? <Badge kind="best" /> : null}
          {route.tags.includes("fastest") ? <Badge kind="fastest" /> : null}
          <VenueBadge trust={route.trust} providerName={name} chainName={payChainName} />
          {preview ? (
            <Badge kind="warning" title={PREVIEW_TAG_TEXT}>
              Preview
            </Badge>
          ) : null}
        </span>
        <Text variant="meta" color="var(--dim)" tabular lines={1} className={s.detail}>
          {routeMeta(route)}
        </Text>
        {trustLine ? (
          <Text variant="meta" color="var(--muted)" lines={2}>
            {venueTrustText(route.provider, payChainName)}
          </Text>
        ) : null}
      </span>
      <span className={s.right}>
        <Text variant="small" weight={600} tabular lines={1}>
          {`${preview ? "≈ " : ""}${out} ${to.symbol}`}
        </Text>
        <Text variant="meta" color="var(--dim)" tabular lines={1}>
          {`${preview ? "est. min" : "min"} ${min}`}
        </Text>
      </span>
    </button>
  );
}

/** A venue still quoting: dimmed logo, muted name, a spinner; not selectable. */
export function PendingRow({provider}: {provider: string}) {
  const name = providerName(provider);
  return (
    <div className={s.row} data-testid={`swap-route-pending-${provider}`} aria-label={`${name}, still quoting`} role="listitem">
      <ProviderLogo provider={provider} size={32} state="pending" name={name} />
      <span className={s.middle}>
        <Text variant="listTitle" color="var(--muted)" lines={1}>
          {name}
        </Text>
        <Text variant="meta" color="var(--dim)">
          Quoting…
        </Text>
      </span>
      <Spinner size={16} color="var(--muted)" />
    </div>
  );
}

export interface RefusedRowProps {
  rejection: RouteRejection;
  /** The row's disclosure and its "Technical reason": the list holds them, so a refresh that remounts the row keeps them. */
  open: boolean;
  rawOpen: boolean;
  onToggle(part: "row" | "raw", open: boolean): void;
}

/**
 * A venue that sat out: grey logo, dim name and the short reason in full (never clamped), as a native disclosure —
 * opened, the plain sentence and a "Technical reason" with the venue's own text (selectable, copyable for support).
 * `<details>` can't take a role, so the list item is a wrapper; the copy button sits outside every `<summary>`.
 */
export function RefusedRow({rejection, open, rawOpen, onToggle}: RefusedRowProps) {
  const phone = useBreakpoint() === "phone";
  const name = rejection.provider ? providerName(rejection.provider) : "A venue";
  return (
    <div role="listitem" data-testid={`swap-route-refused-${rejection.provider || "unknown"}`} data-category={rejection.category}>
      <details className={s.refused} open={open} onToggle={(e) => onToggle("row", e.currentTarget.open)}>
        <summary className={s.row}>
          <ProviderLogo provider={rejection.provider || "?"} size={32} state="refused" name={name} />
          <span className={s.middle}>
            <Text variant="listTitle" color="var(--dim)" lines={1}>
              {name}
            </Text>
            <Text variant="meta" color={rejection.category === "safety" ? "var(--muted)" : "var(--dim)"}>
              {rejection.reason}
            </Text>
          </span>
          <Icon name="chevronDown" size={12} color="var(--dim)" className={s.chevron} />
        </summary>
        <div className={s.refusedBody}>
          {rejection.detail ? (
            <Text as="p" variant="meta" color="var(--muted)">
              {rejection.detail}
            </Text>
          ) : null}
          <details className={s.raw} open={rawOpen} onToggle={(e) => onToggle("raw", e.currentTarget.open)}>
            <summary className={s.rawSummary}>
              <Text variant="meta" color="var(--dim)">
                Technical reason
              </Text>
              <Icon name="chevronDown" size={10} color="var(--dim)" className={s.chevron} />
            </summary>
            <div className={s.rawLine}>
              <Text as="p" variant="meta" color="var(--dim)" selectable className={s.rawText} data-testid="swap-refused-raw">
                {rejection.raw}
              </Text>
              <CopyButton value={`${rejection.provider || "venue"}: ${rejection.raw}`} aria-label="Copy technical reason" size={phone ? 44 : 32} />
            </div>
          </details>
        </div>
      </details>
    </div>
  );
}

/** An enabled venue the round didn't ask: quiet logo and name, and its scope in one line. */
export function NotForPairRow({venue}: {venue: NotForPair}) {
  const name = providerName(venue.provider);
  return (
    <div className={`${s.row} ${s.uncovered}`} role="listitem" data-testid={`swap-route-uncovered-${venue.provider}`}>
      <ProviderLogo provider={venue.provider} size={24} state="refused" name={name} />
      <span className={s.middle}>
        <Text variant="small" weight={600} color="var(--dim)" lines={1}>
          {name}
        </Text>
        <Text variant="meta" color="var(--dim)">
          {venue.scope}
        </Text>
      </span>
    </div>
  );
}
