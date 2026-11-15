/**
 * The pay and receive cards with the flip button cutting into both (mobile
 * app/swap/index.tsx L215-348): token chip, amount, USD value, balance + MAX.
 * The receive side shows the chosen route's expected amount; the guaranteed
 * minimum is in the route list and the review. Both keep their height in every
 * state, so nothing under them moves while a quote loads or updates (D32).
 */
import type {SwapToken} from "../../contracts/domain";
import type {WebRoute} from "../../contracts/routes";
import {formatAmount, formatUsd} from "../../catalog";
import {formatUnits, usdOf} from "../../swap";
import {AmountInput, AmountText, Card, Chip, Icon, Skeleton, Text, TokenChip} from "../../ui";
import type {Held} from "./model";
import s from "./Form.module.css";

export interface PayCardProps {
  from: SwapToken | undefined;
  text: string;
  amountIn: bigint | null;
  /** Red line + red amount: "Insufficient balance". */
  problem: string | null;
  /** Base units when known (balance loaded), else null → "—" and MAX off. */
  balance: bigint | null;
  onAmount(text: string): void;
  /** A paste: the field's text with the clipboard text spliced in at the selection. */
  onPaste?(text: string): void;
  /** Why the last paste was refused (shown in the foot line). */
  note?: string | null;
  onMax(): void;
  onPickToken(): void;
}

/** "You pay": balance + MAX, token chip, the amount field and its USD value (or why there is none). */
export function PayCard({from, text, amountIn, problem, balance, onAmount, onPaste, note, onMax, onPickToken}: PayCardProps) {
  const usd = from && amountIn !== null ? usdOf(amountIn, from.decimals, from.priceUsd) : undefined;
  const qr = from?.payMode === "deposit";
  // An imported token (D39) is never priced: the foot says so instead of "$0.00".
  const foot =
    note ?? problem ?? (usd !== undefined ? `≈ ${formatUsd(usd)}` : from?.imported ? "Imported token · no price" : from && from.priceUsd === undefined && amountIn ? "No price" : "≈ $0.00");
  return (
    <Card className={s.card} data-testid="swap-pay-card">
      <div className={s.spread}>
        <Text variant="caps" color="var(--dim)">
          You pay
        </Text>
        <span className={s.balance}>
          <Text variant="meta" color="var(--muted)" tabular lines={1} data-testid="swap-balance">
            {qr ? "From any wallet" : `Balance ${from && balance !== null ? formatAmount(balance.toString(), from.decimals) : "—"}`}
          </Text>
          {qr ? null : (
            <Chip
              size="sm"
              label="Max"
              aria-label="Swap the maximum"
              data-testid="swap-max"
              disabled={!from || balance === null || balance === 0n}
              onClick={onMax}
            />
          )}
        </span>
      </div>
      <div className={s.amountRow}>
        <TokenChip token={from ?? null} onClick={onPickToken} data-testid="swap-pay-token" />
        <AmountInput
          className={s.amountInput}
          aria-label="Amount to pay"
          data-testid="swap-amount"
          value={text}
          invalid={!!problem}
          disabled={!from}
          onChange={(e) => onAmount(e.target.value)}
          onPaste={
            onPaste
              ? (e) => {
                  // A pasted "1,234.56" is a copied number, not keystrokes: read it whole (parsePastedAmount).
                  const clip = e.clipboardData.getData("text");
                  if (!clip) return;
                  e.preventDefault();
                  const el = e.currentTarget;
                  onPaste(el.value.slice(0, el.selectionStart ?? el.value.length) + clip + el.value.slice(el.selectionEnd ?? el.value.length));
                }
              : undefined
          }
        />
      </div>
      <Text
        as="p"
        variant="meta"
        tabular
        color={note ? "var(--amber)" : problem ? "var(--red)" : "var(--dim)"}
        className={s.footLine}
        data-testid={note ? "swap-amount-note" : problem ? "swap-amount-error" : "swap-pay-usd"}
        role={note ? "status" : undefined}
      >
        {foot}
      </Text>
    </Card>
  );
}

export interface ReceiveCardProps {
  from: SwapToken | undefined;
  to: SwapToken | undefined;
  /** The chosen route (expected amount), if any. */
  route: WebRoute | undefined;
  /** A request is quoting and nothing is chosen yet: skeleton. */
  quoting: boolean;
  /** The route was quoted for other terms (D32): the amount stays, dimmed; busy while the new round runs. */
  held?: Held;
  /** The route is a preview price (D7): the amount reads as an estimate, "≈ …". */
  preview?: boolean;
  onPickToken(): void;
}

/** "You receive": token chip and the chosen route's expected output (6 decimals at most), or a skeleton while quoting. */
export function ReceiveCard({from, to, route, quoting, held, preview, onPickToken}: ReceiveCardProps) {
  const usd = to && route ? usdOf(route.destAmount, to.decimals, to.priceUsd) : undefined;
  const amount = route && to ? formatUnits(route.destAmount, to.decimals).replace(/(\.\d{6})\d+$/, "$1") : null;
  const out = amount !== null && preview ? `≈ ${amount}` : amount;
  return (
    <Card className={s.card} data-testid="swap-receive-card">
      <Text variant="caps" color="var(--dim)">
        You receive
      </Text>
      <div className={s.amountRow}>
        <TokenChip token={to ?? null} onClick={onPickToken} data-testid="swap-receive-token" />
        <span className={s.receiveAmount} aria-busy={held === "updating" || undefined}>
          {quoting && !route ? (
            <Skeleton width={110} height={26} />
          ) : (
            <AmountText value={out} className={held ? s.updating : s.updatable} data-testid="swap-receive-amount" />
          )}
        </span>
      </div>
      <Text as="p" variant="meta" tabular color="var(--dim)" className={`${s.footLine} ${held ? s.updating : s.updatable}`}>
        {/* a no-break space when there is nothing to say: a collapsed line would lift everything under the card */}
        {usd !== undefined
          ? `≈ ${formatUsd(usd)}`
          : to?.imported
            ? `Imported token${to.chain !== from?.chain ? ` on ${to.chainName}` : ""} · no price`
            : to && to.chain !== from?.chain
              ? `on ${to.chainName}`
              : "\u00a0"}
      </Text>
    </Card>
  );
}

/** The flip between the cards; off when the receive token can't be paid with (receive-only chain). */
export function FlipButton({disabled, onFlip}: {disabled: boolean; onFlip(): void}) {
  return (
    <button type="button" className={s.flip} aria-label="Flip pay and receive" data-testid="swap-flip" disabled={disabled} onClick={onFlip}>
      <Icon name="flip" size={16} />
    </button>
  );
}
