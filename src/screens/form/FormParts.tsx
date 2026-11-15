/**
 * The rest of the form column: the slippage setting (auto per pair by
 * default, as on the phone; a manual value on the web), the summary of the
 * chosen route (mobile index.tsx L495-512) and the CTA. While the chosen
 * route is re-quoted for new terms the summary stays, its numbers dimmed (D32).
 */
import {useState} from "react";
import type {SwapToken} from "../../contracts/domain";
import type {WebRoute} from "../../contracts/routes";
import {formatAmount} from "../../catalog";
import {FLOOR_TOLERANCE_BPS, formatRate, providerName, rate, routeFloor} from "../../swap";
import {Button, Field, Icon, ProviderLogo, Sheet, SheetHeader, Spinner, Text, TxReviewCard} from "../../ui";
import type {CtaState, Held} from "./model";
import s from "./Form.module.css";

/** The market's usual presets (0.01%, 0.05%, 0.3%); anything else is typed. */
const PRESETS = [1, 5, 30] as const;
/** Bounds of a typed slippage (0.01 %–50 %): below that nothing fills, above it the floor means little. */
const MIN_BPS = 1;
const MAX_BPS = 5000;

/** "0.5%", "0.05%" — every slippage keeps its own precision (math.ts slippageLabel rounds to one decimal). */
export const bpsLabel = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;

/** What the slippage row says: "Auto · 0.5%" or "1% (custom)". */
export const slippageText = (custom: number | null, autoBps: number): string =>
  custom === null ? `Auto · ${bpsLabel(autoBps)}` : `${bpsLabel(custom)} (custom)`;

/** Typed percent → bps within bounds, or null. */
export function parseSlippage(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps >= MIN_BPS && bps <= MAX_BPS ? bps : null;
}

export interface SlippageProps {
  custom: number | null;
  autoBps: number;
  onChange(bps: number | null): void;
}

/** The slippage row and its picker sheet: Auto (per pair), presets, or a typed percent. */
export function SlippageControl({custom, autoBps, onChange}: SlippageProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const parsed = typed ? parseSlippage(typed) : null;
  const close = () => {
    setOpen(false);
    setTyped("");
  };
  const pick = (bps: number | null) => {
    onChange(bps);
    close();
  };
  const current = custom ?? autoBps;
  return (
    <div className={s.slippage}>
      <Text variant="small" color="var(--muted)">
        Max slippage
      </Text>
      <button type="button" className={s.slippageButton} onClick={() => setOpen(true)} data-testid="swap-slippage" aria-label={`Max slippage ${slippageText(custom, autoBps)}, change`}>
        {slippageText(custom, autoBps)}
        <Icon name="chevronDown" size={11} color="var(--muted)" />
      </button>
      <Sheet open={open} onClose={close} label="Max slippage" width={400} phoneHeight="half">
        <div className={s.sheetBody}>
          <SheetHeader title="Max slippage" sub="How far the price may move before the swap is refused" onClose={close} />
          <div className={s.presets} role="group" aria-label="Slippage presets">
            <button type="button" className={s.preset} aria-pressed={custom === null} onClick={() => pick(null)}>
              {`Auto ${bpsLabel(autoBps)}`}
            </button>
            {PRESETS.map((bps) => (
              <button key={bps} type="button" className={s.preset} aria-pressed={custom === bps} onClick={() => pick(bps)}>
                {bpsLabel(bps)}
              </button>
            ))}
          </div>
          <Field
            label="Custom"
            placeholder="e.g. 0.8"
            inputMode="decimal"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && parsed !== null) pick(parsed);
            }}
            trailing={<Text variant="small" color="var(--muted)">%</Text>}
            error={typed && parsed === null ? "Between 0.01% and 50%." : null}
          />
          {current > 300 ? (
            <Text as="p" variant="meta" color="var(--amber)">
              A high slippage lets the price move further against you before the swap is refused.
            </Text>
          ) : current < autoBps ? (
            <Text as="p" variant="meta" color="var(--amber)">
              Below the automatic setting for this pair: venues may quote less often, and a moving price can stop the swap.
            </Text>
          ) : (
            <Text as="p" variant="meta" color="var(--dim)">
              Auto picks 0.05% for one asset on one network (USDC → DAI, WETH → wstETH), 0.3% for stablecoins across networks, 0.5% for majors, 1% for anything else. The review shows the minimum you receive.
            </Text>
          )}
          <Button block title={parsed !== null ? `Use ${bpsLabel(parsed)}` : "Done"} disabled={!!typed && parsed === null} onClick={() => (parsed !== null ? pick(parsed) : close())} />
        </div>
      </Sheet>
    </div>
  );
}

export interface SummaryProps {
  from: SwapToken;
  to: SwapToken;
  amountIn: bigint;
  route: WebRoute;
  slippage: string;
  /** The route is a preview price (D7). */
  preview?: boolean;
  /** The route was quoted for other terms (D32): rate and minimum stay, dimmed, the minimum with a spinner while the round runs. */
  held?: Held;
}

/**
 * The minimum the swap enforces sits an execution margin below the venue's own (its slippage) — min(0.5%, slippage),
 * the route's floorBps: said next to every "Minimum received", so "Max slippage 0.5%" is not read as the whole tolerance.
 */
export const floorMarginText = (route: Pick<WebRoute, "floorBps">): string =>
  `Slippage plus a ${bpsLabel(route.floorBps ?? Number(FLOOR_TOLERANCE_BPS))} execution margin`;

/**
 * Rate, route, slippage and the minimum received — the floor the review will hold the swap to. On a preview price
 * (D7) the minimum is labelled an estimate: nothing holds a swap to it. While the route is re-quoted for a new
 * slippage or address (D32) the slippage row already shows the new setting and the numbers wait, dimmed — with a
 * spinner only while a round runs: after a failed one nothing turns (the status line says why).
 */
export function SummaryCard({from, to, amountIn, route, slippage, preview, held}: SummaryProps) {
  const r = rate(amountIn, from.decimals, route.destAmount, to.decimals);
  const cross = to.chain !== from.chain;
  const floor = `${formatAmount(routeFloor(route).toString(), to.decimals)} ${to.symbol}`;
  const wait = held ? {color: "var(--dim)"} : {};
  const spinner = held === "updating" ? {icon: <Spinner size={12} color="var(--dim)" label="Updating" />} : {};
  return (
    <TxReviewCard
      rows={[
        {k: "Rate", v: r !== null ? `1 ${from.symbol} = ${formatRate(r)} ${to.symbol}` : "—", ...wait},
        {
          k: "Route",
          v: `${providerName(route.provider)}${cross ? ` · ${from.chainName} → ${to.chainName}` : ""}`,
          icon: <ProviderLogo provider={route.provider} size={18} />,
        },
        {k: "Slippage", v: slippage},
        preview
          ? {k: "Estimated minimum", v: `≈ ${floor}`, testId: "swap-min-estimate", ...wait, ...spinner}
          : {k: "Minimum received", v: floor, sub: floorMarginText(route), testId: "swap-min-received", ...wait, ...spinner},
      ]}
    />
  );
}

/** The main button; sticky at the bottom on phones (CSS), at the end of the form column otherwise. */
export function CtaBar({cta, onPress}: {cta: CtaState; onPress(): void}) {
  return (
    <div className={s.cta}>
      <Button block height={54} title={cta.label} disabled={!cta.enabled} onClick={onPress} data-testid="swap-review" data-state={cta.state} />
    </div>
  );
}
