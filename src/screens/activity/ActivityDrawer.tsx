/**
 * Every swap this browser started (ui-port.md §5.10): a right drawer on ≥ 640,
 * a bottom sheet on phones. Rows rank like the wallet's dock — claim needed,
 * then failures, then running, then done — with recent ones on top and older
 * finished swaps under "Earlier". A row opens its status in place.
 */
import {useMemo} from "react";
import type {ActivityItem, SwapRecord} from "../../contracts/activity";
import type {WalletFamily, WalletsApi} from "../../contracts/wallets";
import {usePorts} from "../../config";
import {visibleSwaps} from "../../activity";
import {Icon, Sheet, SheetHeader, Tag, Text} from "../../ui";
import {TONE_COLOR, agoLabel} from "../labels";
import {useNow} from "../useNow";
import {StatusView} from "./StatusView";
import s from "./Activity.module.css";

export interface ActivityDrawerProps {
  open: boolean;
  /** The swap shown in place of the list (hash `swap=<id>`), or null for the list. */
  statusId: string | null;
  wallets: WalletsApi;
  onOpenStatus(id: string): void;
  onBack(): void;
  onClose(): void;
  onTryAgain(r: SwapRecord): void;
  onConnect(family: WalletFamily): void;
}

export function ActivityDrawer({open, statusId, wallets, onOpenStatus, onBack, onClose, onTryAgain, onConnect}: ActivityDrawerProps) {
  const ports = usePorts();
  const activity = ports.activity.useActivity();
  // Closing while a swap is being sent is "Continue in background": the runner and the tracker carry on.
  return (
    <Sheet open={open} onClose={onClose} label="Activity" width={380} placement="drawer" phoneHeight="tall" data-testid="swap-activity">
      {statusId ? (
        <StatusView id={statusId} wallets={wallets} onBack={onBack} onClose={onClose} onTryAgain={onTryAgain} onConnect={onConnect} />
      ) : (
        <ActivityList items={activity.items} loaded={activity.loaded} onOpen={onOpenStatus} onClose={onClose} />
      )}
    </Sheet>
  );
}

function ActivityList({items, loaded, onOpen, onClose}: {items: readonly ActivityItem[]; loaded: boolean; onOpen(id: string): void; onClose(): void}) {
  const now = useNow();
  const {recent, earlier} = useMemo(() => {
    // Minute resolution is enough to move a row to "Earlier"; avoids re-splitting every second.
    const visible = new Set(visibleSwaps(items.map((i) => i.record), Math.floor(now / 60_000) * 60_000).map((r) => r.id));
    return {recent: items.filter((i) => visible.has(i.record.id)), earlier: items.filter((i) => !visible.has(i.record.id))};
  }, [items, now]);
  return (
    <div className={s.body}>
      <SheetHeader title="Activity" sub="Swaps started in this browser" onClose={onClose} />
      {!loaded ? (
        <Text as="p" variant="small" color="var(--muted)" className={s.empty}>
          Loading your swaps…
        </Text>
      ) : items.length === 0 ? (
        <Text as="p" variant="small" color="var(--muted)" className={s.empty}>
          No swaps yet. Swaps you start here are listed in this browser only; their status is asked of the venue that runs them.
        </Text>
      ) : (
        <>
          {recent.length ? <Section items={recent} now={now} onOpen={onOpen} /> : null}
          {earlier.length ? <Section title="Earlier" items={earlier} now={now} onOpen={onOpen} /> : null}
        </>
      )}
    </div>
  );
}

function Section({title, items, now, onOpen}: {title?: string; items: readonly ActivityItem[]; now: number; onOpen(id: string): void}) {
  return (
    <section className={s.section} aria-label={title ?? "Recent"}>
      {title ? (
        <Text as="h3" variant="caps" color="var(--dim)">
          {title}
        </Text>
      ) : null}
      <ul className={s.section}>
        {items.map((i) => (
          <li key={i.record.id}>
            <ActivityRow item={i} now={now} onOpen={() => onOpen(i.record.id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Tone dot, swap glyph, "{A} → {B}", the status label in its tone, the networks and how long ago. A side imported by
 * its address (D39) adds an amber "Imported" tag (and "(imported)" in the label): a swap into a copy named USDC never
 * reads like one into the listed USDC.
 */
function ActivityRow({item, now, onOpen}: {item: ActivityItem; now: number; onOpen(): void}) {
  const {record: r, view} = item;
  const color = TONE_COLOR[view.tone];
  const chains = item.fromChainName === item.toChainName ? item.fromChainName : `${item.fromChainName} → ${item.toChainName}`;
  const mark = (imported: string | undefined) => (imported ? " (imported)" : "");
  return (
    <button
      type="button"
      className={s.row}
      onClick={onOpen}
      data-testid={`swap-activity-${r.id}`}
      aria-label={`${r.fromSymbol}${mark(r.fromImportedContract)} to ${r.toSymbol}${mark(r.toImportedContract)}, ${view.label}, ${chains}`}
    >
      <span className={s.dot} style={{background: color}} aria-hidden="true" />
      <Icon name="swap" size={15} color="var(--ink2)" />
      <span className={s.rowText}>
        <span className={s.rowTitle}>
          <Text variant="small" weight={600} lines={1}>{`${r.fromSymbol} → ${r.toSymbol}`}</Text>
          {r.fromImportedContract || r.toImportedContract ? (
            <Tag tone="amber">Imported</Tag>
          ) : null}
        </span>
        <Text variant="meta" color={color} lines={1}>
          {view.label}
        </Text>
      </span>
      <span className={s.rowRight}>
        <span className={s.chip}>{chains}</span>
        <Text variant="meta" color="var(--dim)" tabular>
          {agoLabel(now - r.createdAt)}
        </Text>
      </span>
    </button>
  );
}
