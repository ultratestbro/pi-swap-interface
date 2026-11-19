/**
 * The live route list (ui-port.md §5.5): header with refresh, the status line
 * (who is still quoting, how fresh the list is, how many venues serve the
 * pair), then the rows — routes as a radiogroup (↑/↓ select, Enter = the
 * CTA), venues still quoting, the ones that sat out (grouped by what the user
 * can do about it), and the enabled venues this pair isn't for. Phones get
 * the compact form: the chosen route and "N more routes", which opens the
 * full list in a bottom sheet. Preview prices (D7) get a "Preview" tag per row
 * (the CTA says what makes them a quote), and the venues a preview leaves for
 * the live quote sit in a quiet group of their own ("Quoted after you
 * connect"), never under "Didn't quote"; while the tab's preview budget is
 * spent the refresh button waits, with a countdown (D29). Re-quoted (new
 * slippage or address, the refresh), the list keeps its rows and height: a
 * venue asked again keeps its row, dimmed when quoted for other terms (D32).
 */
import {useRef, useState, type KeyboardEvent, type ReactNode} from "react";
import type {SwapToken} from "../../contracts/domain";
import type {RefusalCategory, RouteRejection, RoutesState} from "../../contracts/routes";
import {providerName, routeKey} from "../../swap";
import {Button, Card, Icon, IconButton, Sheet, SheetHeader, Skeleton, Spinner, Text} from "../../ui";
import {plural} from "../labels";
import {useNow} from "../useNow";
import {heldAs, routesStatus, stillQuoting, type NotForPair, type RouteListModel} from "../form/model";
import {NotForPairRow, PendingRow, RefusedRow, RouteRow} from "./RouteRow";
import s from "./Routes.module.css";

/** The "Didn't quote" sections, in this order; empty ones are not shown. Safety skips last, in green, never red. */
const SECTIONS: readonly {title: string; categories: readonly RefusalCategory[]; safety?: true}[] = [
  {title: "Needs a different amount", categories: ["amount"]},
  {title: "Needs a change on your side", categories: ["setup"]},
  {title: "Not available right now", categories: ["unavailable", "unreachable", "busy", "other"]},
  {title: "Doesn't support this pair", categories: ["pair"]},
  {title: "Skipped for your safety", categories: ["safety"], safety: true},
];

interface RefusedGroupsProps {
  refused: readonly RouteRejection[];
  /** Open rows by venue ("lifi"; "lifi:raw" = its "Technical reason"), held by the list across refreshes. */
  opened: ReadonlySet<string>;
  onToggle(id: string, open: boolean): void;
}

/** The refused venues by section, each a titled list; rows keep the router's order inside a section, keyed by venue. */
function RefusedGroups({refused, opened, onToggle}: RefusedGroupsProps) {
  return (
    <div className={s.list} data-testid="swap-refused">
      {SECTIONS.map(({title, categories, safety}) => {
        const rows = refused.filter((x) => categories.includes(x.category));
        if (!rows.length) return null;
        return (
          <div key={title} className={s.section}>
            <div className={s.sectionHead}>
              {safety ? <Icon name="lock" size={12} color="var(--green)" /> : null}
              <Text as="h3" variant="caps" color={safety ? "var(--green)" : "var(--dim)"}>
                {title}
              </Text>
            </div>
            <div role="list" aria-label={title} className={s.list}>
              {rows.map((x, i) => {
                const id = x.provider || `?${i}`;
                return (
                  <RefusedRow
                    key={id}
                    rejection={x}
                    open={opened.has(id)}
                    rawOpen={opened.has(`${id}:raw`)}
                    onToggle={(part, open) => onToggle(part === "raw" ? `${id}:raw` : id, open)}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface GroupProps {
  label: string;
  open: boolean;
  onToggle(): void;
  testId: string;
  /** Dimmer label: a group about venues that were never asked. */
  quiet?: boolean;
  children: ReactNode;
}

/** A collapsed group: a toggle and, open, its rows. */
function Group({label, open, onToggle, testId, quiet, children}: GroupProps) {
  return (
    <>
      <button type="button" className={s.group} aria-expanded={open} onClick={onToggle} data-testid={testId}>
        <Text variant="meta" weight={quiet ? 500 : 600} color={quiet ? "var(--dim)" : "var(--muted)"}>
          {label}
        </Text>
        <Icon name="chevronDown" size={12} className={s.chevron} />
      </button>
      {open ? children : null}
    </>
  );
}

interface DeferredGroupProps {
  /** deferredCopy's title: "Quoted after you connect", "Quoted after you add the address". */
  title: string;
  venues: readonly RouteRejection[];
  opened: ReadonlySet<string>;
  onToggle(id: string, open: boolean): void;
}

/**
 * "Quoted after you connect (N)": the venues a preview round left for the live quote (D7: LI.FI while cp0x's proxy
 * doesn't carry it; Fynd without its slot is asked by no round and absent from the list). Nothing is wrong with
 * them, so the group is quiet and collapsed, like "Not for this pair", and never part of "Didn't quote"; each row is
 * the usual disclosure (why, and the technical reason).
 */
function DeferredGroup({title, venues, opened, onToggle}: DeferredGroupProps) {
  const [open, setOpen] = useState(false);
  if (!venues.length) return null;
  return (
    <Group label={`${title} (${venues.length})`} open={open} onToggle={() => setOpen((v) => !v)} testId="swap-deferred-toggle" quiet>
      <div role="list" aria-label={title} className={s.list} data-testid="swap-deferred">
        {venues.map((x) => (
          <RefusedRow
            key={x.provider}
            rejection={x}
            open={opened.has(x.provider)}
            rawOpen={opened.has(`${x.provider}:raw`)}
            onToggle={(part, o) => onToggle(part === "raw" ? `${x.provider}:raw` : x.provider, o)}
          />
        ))}
      </div>
    </Group>
  );
}

/** "Not for this pair (N)": enabled venues the round didn't ask, each with its scope. Collapsed by default. */
function NotForPairGroup({venues}: {venues: readonly NotForPair[]}) {
  const [open, setOpen] = useState(false);
  if (!venues.length) return null;
  return (
    <Group label={`Not for this pair (${venues.length})`} open={open} onToggle={() => setOpen((v) => !v)} testId="swap-uncovered-toggle" quiet>
      <div role="list" aria-label="Not for this pair" className={s.list}>
        {venues.map((v) => (
          <NotForPairRow key={v.provider} venue={v} />
        ))}
      </div>
    </Group>
  );
}

export interface RouteListProps {
  model: RouteListModel;
  loading: boolean;
  to: SwapToken;
  payChainName: string;
  /** The chosen route's routeKey. */
  chosen: string | null;
  /** A route picked, by routeKey (D47: "cctp/fast"). */
  onSelect(key: string): void;
  /** Enter on a route = the CTA. */
  onSubmit(): void;
  /** The "Didn't quote" group starts open (demo scene, no-route state). */
  refusedOpen?: boolean;
  /** A finished list is being re-quoted (the 30 s refresh), not a new pair's first round. */
  refreshing?: boolean;
  trustLine?: boolean;
  /** The rows are preview prices: each says so, and Enter still goes to the CTA (connect / address, never review). */
  preview?: boolean;
}

/**
 * The full list: radiogroup of routes, pending rows, then the refused group (open when nothing quoted), the quiet
 * group of venues a preview left for the live quote, and "Not for this pair".
 */
export function RouteList({model, loading, to, payChainName, chosen, onSelect, onSubmit, refusedOpen, refreshing, trustLine, preview}: RouteListProps) {
  const group = useRef<HTMLDivElement>(null);
  const [showRefused, setShowRefused] = useState(!!refusedOpen);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const {routes, refused, deferred, deferredTitle, notForPair, held} = model;
  const empty = routes.length === 0;
  // Re-quoting a list where nothing quoted leaves its sections in place (rows open, text selected) until the new
  // answers land: no skeleton.
  const holding = empty && loading && !!refreshing && refused.length > 0;
  // A venue asked again keeps its route, refusal or deferred row: it isn't repeated as "Quoting…" (D32).
  const quoting = stillQuoting(model);

  const toggle = (id: string, open: boolean) =>
    setOpened((was) => {
      if (was.has(id) === open) return was;
      const next = new Set(was);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
      return;
    }
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step || empty) return;
    e.preventDefault();
    const i = Math.max(0, routes.findIndex((r) => routeKey(r) === chosen));
    const next = routes[(i + step + routes.length) % routes.length]!;
    onSelect(routeKey(next));
    // By the row's own data-route, not a selector: a routeId is the venue's string (printable ASCII, quotes included).
    const key = routeKey(next);
    [...(group.current?.querySelectorAll<HTMLElement>("[data-route]") ?? [])].find((el) => el.dataset.route === key)?.focus();
  };

  return (
    <Card padding={4} className={s.list}>
      {empty && loading && !holding ? (
        <div className={s.skeleton} aria-hidden="true">
          <Skeleton width="70%" height={14} />
          <Skeleton width="45%" height={11} />
        </div>
      ) : null}
      {routes.length ? (
        <div ref={group} role="radiogroup" aria-label="Routes" className={s.list} onKeyDown={onKeyDown}>
          {routes.map((r, i) => {
            const k = routeKey(r);
            return (
              <RouteRow
                key={k}
                route={r}
                to={to}
                payChainName={payChainName}
                selected={k === chosen}
                tabbable={chosen ? k === chosen : i === 0}
                trustLine={trustLine}
                preview={preview}
                held={heldAs(held, k, loading)}
                onSelect={() => onSelect(k)}
              />
            );
          })}
        </div>
      ) : null}
      {quoting.length ? (
        <div role="list" aria-label="Still quoting" className={s.list}>
          {quoting.map((p) => (
            <PendingRow key={p} provider={p} />
          ))}
        </div>
      ) : null}
      {refused.length ? (
        empty && (!loading || holding) ? (
          <RefusedGroups refused={refused} opened={opened} onToggle={toggle} />
        ) : (
          <Group label={`Didn't quote (${refused.length})`} open={showRefused} onToggle={() => setShowRefused((v) => !v)} testId="swap-refused-toggle">
            <RefusedGroups refused={refused} opened={opened} onToggle={toggle} />
          </Group>
        )
      ) : empty && !loading ? (
        <div className={s.skeleton}>
          <Text variant="meta" color="var(--dim)">
            Try another amount or token.
          </Text>
        </div>
      ) : null}
      <DeferredGroup title={deferredTitle} venues={deferred} opened={opened} onToggle={toggle} />
      <NotForPairGroup venues={notForPair} />
    </Card>
  );
}

export interface RoutesPanelProps {
  mode: "full" | "compact";
  /** The idle line when nothing can be quoted (what is missing), or null when quoting (live or preview). */
  hint: string | null;
  state: RoutesState & {refresh(): void};
  model: RouteListModel;
  from: SwapToken | undefined;
  to: SwapToken | undefined;
  /** The chosen route's routeKey. */
  chosen: string | null;
  onSelect(key: string): void;
  onSubmit(): void;
  refusedOpen?: boolean;
  /** Phone: the route sheet (controlled, so a demo scene can open it). */
  sheetOpen?: boolean;
  onSheet?(open: boolean): void;
}

/** Header, status line and the list in its full or compact (phone) form. */
export function RoutesPanel(p: RoutesPanelProps) {
  const now = useNow();
  const {state, model, to, from} = p;
  const status = routesStatus(p.hint === null, state, model, providerName, now);
  const chosenRoute = model.routes.find((r) => routeKey(r) === p.chosen);
  const more = model.routes.length - (chosenRoute ? 1 : 0);
  const quoting = stillQuoting(model).length;
  const moreLabel =
    more > 0
      ? plural(more, "more route")
      : model.refused.length
        ? `${model.refused.length} didn't quote`
        : quoting
          ? `${quoting} still quoting`
          : null;
  const payChainName = from?.chainName ?? "";
  // A round of this pair finished before (useRoutes keeps updatedAt across a refresh, resets it for a new pair).
  const refreshing = state.loading && state.updatedAt > 0;
  const preview = state.snapshot?.mode === "preview";
  // The tab's preview budget is spent: refresh waits for the next token (D29).
  const waitS = state.limitedUntil > now ? Math.ceil((state.limitedUntil - now) / 1000) : 0;

  const list = (compact: boolean) =>
    to ? (
      compact && chosenRoute ? (
        <Card padding={4}>
          <div role="radiogroup" aria-label="Chosen route">
            <RouteRow
              route={chosenRoute}
              to={to}
              payChainName={payChainName}
              selected
              tabbable
              preview={preview}
              held={heldAs(model.held, routeKey(chosenRoute), state.loading)}
              onSelect={() => p.onSheet?.(true)}
            />
          </div>
        </Card>
      ) : (
        <RouteList
          model={compact ? {...model, pending: []} : model}
          loading={state.loading}
          to={to}
          payChainName={payChainName}
          chosen={p.chosen}
          onSelect={p.onSelect}
          onSubmit={p.onSubmit}
          refusedOpen={p.refusedOpen}
          refreshing={refreshing}
          preview={preview}
        />
      )
    ) : null;

  return (
    <section className={s.panel} aria-label="Routes" data-testid="swap-routes">
      <div className={s.head}>
        <Text as="h2" variant="caps" color="var(--dim)">
          Routes
        </Text>
        {p.hint === null ? (
          state.loading ? (
            <span aria-label="Refreshing routes" role="status">
              <Spinner size={16} color="var(--muted)" />
            </span>
          ) : waitS > 0 ? (
            <span className={s.wait}>
              <Text variant="meta" color="var(--dim)" tabular data-testid="swap-refresh-wait">
                {`${waitS} s`}
              </Text>
              <IconButton icon="refresh" aria-label={`Refresh routes — preview prices again in ${waitS} s`} size={32} iconSize={16} variant="flat" disabled data-testid="swap-refresh" />
            </span>
          ) : (
            <IconButton icon="refresh" aria-label="Refresh routes" size={32} iconSize={16} variant="flat" onClick={state.refresh} data-testid="swap-refresh" />
          )
        ) : null}
      </div>
      {p.hint !== null ? (
        <Text as="p" variant="small" color="var(--dim)" className={s.hint} data-testid="swap-hint">
          {p.hint}
        </Text>
      ) : (
        <>
          {status ? (
            <div className={s.statusRow}>
              {/* not a live region: the freshness ticks every second. One line (the full text on hover), so its length
                  never moves the list (D32); an error wraps, to be read in full. */}
              <Text
                as="p"
                variant="meta"
                color={status.error ? "var(--red)" : "var(--dim)"}
                lines={status.error ? undefined : 1}
                title={status.text}
                className={s.status}
                data-testid="swap-routes-status"
              >
                {status.text}
              </Text>
              {model.coverage ? (
                <Text as="p" variant="meta" color="var(--dim)" className={s.coverage} data-testid="swap-coverage">
                  {model.coverage}
                </Text>
              ) : null}
            </div>
          ) : null}
          {list(p.mode === "compact")}
          {p.mode === "compact" && chosenRoute && moreLabel ? (
            <Button
              kind="ghost"
              height={40}
              block
              icon="chevronRight"
              className={s.more}
              title={moreLabel}
              onClick={() => p.onSheet?.(true)}
              data-testid="swap-more-routes"
            />
          ) : null}
        </>
      )}
      {p.mode === "compact" && to ? (
        <Sheet open={!!p.sheetOpen} onClose={() => p.onSheet?.(false)} label="Routes" width={440} phoneHeight="half" data-testid="swap-route-sheet">
          <div className={s.sheetBody}>
            {/* the coverage under the header, as beside the panel's status line: the sheet is the phone's only full list */}
            <div className={s.sheetHead}>
              <SheetHeader title="Routes" sub={status?.text} onClose={() => p.onSheet?.(false)} />
              {model.coverage ? (
                <Text as="p" variant="meta" color="var(--dim)" data-testid="swap-coverage">
                  {model.coverage}
                </Text>
              ) : null}
            </div>
            <RouteList
              model={model}
              loading={state.loading}
              to={to}
              payChainName={payChainName}
              chosen={p.chosen}
              trustLine
              refusedOpen={p.refusedOpen}
              refreshing={refreshing}
              preview={preview}
              onSelect={(x) => {
                p.onSelect(x);
                p.onSheet?.(false);
              }}
              onSubmit={() => p.onSheet?.(false)}
            />
          </div>
        </Sheet>
      ) : null}
    </section>
  );
}
