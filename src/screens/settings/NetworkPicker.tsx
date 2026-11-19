/**
 * The network picker, each network with its logo, in the app's own look (a native <select> opens the OS menu):
 * Custom's networks a Custom RPC can be added for (D30), and — as the `chip` variant — the networks a pasted token
 * contract was found on (the token sheet's import, D39). At ≥ 640 px a menu-look popover under the trigger, inside its
 * dialog; below that the app's bottom sheet. A search field (when `searchable`) keeps focus and drives the list (a
 * combobox over a listbox): arrow keys move, Enter picks, typing filters, Escape closes, and focus goes back to the
 * trigger. A letter typed on the closed trigger opens the list searching for it. Without the search the listbox itself
 * takes focus, with the same keys. Options without a `slug` show no logo: the Revoke list's sort picks with it too.
 */
import {useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode} from "react";
import {ChainLogo, Field, Icon, Sheet, SheetHeader, Text, useBreakpoint} from "../../ui";
import s from "./NetworkPicker.module.css";

/** One network the picker offers. */
export interface PickerNetwork {
  /** What the caller stores: an EVM chain id as text, or "solana". */
  value: string;
  name: string;
  /** Catalog slug, for the logo; none for an option that isn't a network (a sort order). */
  slug?: string;
}

/**
 * The networks a search matches (name, catalog slug or chain id): those it starts (a word of) first, so a typed "b"
 * lands on Base rather than Arbitrum; otherwise in the order given.
 */
export function matchNetworks(networks: readonly PickerNetwork[], query: string): readonly PickerNetwork[] {
  const q = query.trim().toLowerCase();
  if (!q) return networks;
  const starts = (n: PickerNetwork) => n.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || !!n.slug?.startsWith(q) || n.value === q;
  const matches = (n: PickerNetwork) => n.name.toLowerCase().includes(q) || !!n.slug?.includes(q) || n.value.startsWith(q);
  return [...networks.filter(starts), ...networks.filter((n) => !starts(n) && matches(n))];
}

export function NetworkPicker({
  networks,
  value,
  label,
  onChange,
  variant = "field",
  searchable = true,
  footer,
  listLabel = "Networks",
  "data-testid": testId = "network-picker",
}: {
  networks: readonly PickerNetwork[];
  value: string;
  /** The picker's name: visually hidden by the trigger, the sheet's title on phones. */
  label: string;
  onChange(value: string): void;
  /** "field": a full-width 48 px field (Settings); "chip": an inline 26 px chip, the popover right-aligned under it. */
  variant?: "field" | "chip";
  /** The search field above the list (a short list can do without). */
  searchable?: boolean;
  /** A line under the list (what is still loading). */
  footer?: ReactNode;
  /** The listbox's name (default "Networks"). */
  listLabel?: string;
  /** On the trigger; the list's parts get `-search`, `-list`, `-<value>` and the phone sheet `-sheet`. */
  "data-testid"?: string;
}) {
  const phone = useBreakpoint() === "phone";
  const [open, setOpen] = useState(false);
  // What the list opens searching for (a letter typed on the trigger); read once per opening.
  const [seed, setSeed] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const valueId = useId();
  const listId = useId();
  const chosen = networks.find((n) => n.value === value) ?? networks[0];

  const show = (query = "") => {
    // Focused first, so the phone sheet (which hands focus back to what was focused when it opened) returns here.
    trigger.current?.focus({preventScroll: true});
    setSeed(query);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    // The sheet restores focus to its opener by itself; the popover is ours to undo.
    if (!phone) trigger.current?.focus({preventScroll: true});
  };
  const pick = (n: PickerNetwork) => {
    onChange(n.value);
    close();
  };

  // The list lives inside the Settings sheet: Escape closes only the list. The phone sheet would see to that itself,
  // but Radix hands its Escape listener over from Settings to a newly opened sheet a few renders late, and an Escape
  // in those first milliseconds closed Settings too. A press anywhere else just closes the popover (the phone sheet
  // has its own backdrop).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Runs before the dialogs' own Escape listeners (document, capture), which leave a handled Escape alone.
      e.preventDefault();
      setOpen(false);
      // The sheet restores focus to its opener by itself; the popover is ours to undo.
      if (!phone) trigger.current?.focus({preventScroll: true});
    };
    const onPointer = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    if (!phone) document.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open, phone]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      show();
    } else if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      show(e.key);
    }
  };

  const list = (
    <NetworkList
      networks={networks}
      value={chosen?.value}
      initialQuery={searchable ? seed : ""}
      listId={listId}
      autoFocus={!phone}
      searchable={searchable}
      footer={footer}
      listLabel={listLabel}
      onPick={pick}
      onBack={phone ? undefined : close}
      testId={testId}
    />
  );
  const chip = variant === "chip";

  return (
    <div ref={box} className={chip ? `${s.picker} ${s.pickerChip}` : s.picker}>
      <span id={labelId} className={s.visuallyHidden}>
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        className={chip ? s.chipTrigger : s.pickerTrigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open && !phone ? listId : undefined}
        aria-labelledby={`${labelId} ${valueId}`}
        // Safari moves no focus to a pressed button: without this the open popover would lose it, close, and reopen.
        onMouseDown={(e) => open && e.preventDefault()}
        onClick={() => (open ? close() : show())}
        onKeyDown={onTriggerKey}
        data-testid={testId}
      >
        {chosen?.slug ? <ChainLogo slug={chosen.slug} size={chip ? 16 : 20} /> : null}
        <span id={valueId} className={s.pickerValue}>
          {chosen?.name}
        </span>
        <Icon name="chevronDown" size={12} color="var(--muted)" className={s.pickerChevron} />
      </button>
      {phone ? (
        <Sheet open={open} onClose={() => setOpen(false)} label={label} phoneHeight="tall" flush data-testid={`${testId}-sheet`}>
          {/* mounted only while open (and closing): each opening starts at the chosen network */}
          <div className={s.pickerSheet}>
            <SheetHeader title={label} onClose={() => setOpen(false)} />
            {list}
          </div>
        </Sheet>
      ) : open ? (
        <div
          ref={popover}
          className={chip ? `${s.popover} ${s.popoverChip}` : s.popover}
          // a press inside (an option, the gaps) keeps focus in the search, or the popover would lose its keyboard
          onMouseDown={(e) => !(e.target instanceof HTMLInputElement) && e.preventDefault()}
          // focus gone elsewhere (Tab on to the URL, a click outside) closes it; to the trigger, the trigger decides
          onBlur={(e) => {
            const to = e.relatedTarget;
            if (to instanceof Node && (popover.current?.contains(to) || to === trigger.current)) return;
            setOpen(false);
          }}
        >
          {list}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The search field and the networks it matches — or, not `searchable`, the list alone, focusable itself; the active
 * one (aria-activedescendant) starts at the chosen one.
 */
function NetworkList({
  networks,
  value,
  initialQuery,
  listId,
  autoFocus,
  searchable,
  footer,
  listLabel,
  onPick,
  onBack,
  testId,
}: {
  networks: readonly PickerNetwork[];
  value: string | undefined;
  initialQuery: string;
  listId: string;
  /** Focus the search (or the list) on open (the popover; phones never raise the keyboard by themselves). */
  autoFocus: boolean;
  searchable: boolean;
  footer?: ReactNode;
  listLabel: string;
  onPick(n: PickerNetwork): void;
  /** Shift+Tab out of the popover's search: closed, back on the trigger (Tab onward closes it by focus alone). */
  onBack?: () => void;
  testId: string;
}) {
  const chosenIn = (list: readonly PickerNetwork[]) => Math.max(0, list.findIndex((n) => n.value === value));
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(() => (initialQuery.trim() ? 0 : chosenIn(matchNetworks(networks, initialQuery))));
  const shown = matchNetworks(networks, query);
  const current = shown[Math.min(active, shown.length - 1)];
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listbox = useRef<HTMLUListElement>(null);
  const optionId = (n: PickerNetwork) => `${listId}-${n.value}`;

  useEffect(() => {
    if (!autoFocus) return;
    (searchable ? search.current : listbox.current)?.focus({preventScroll: true});
    // All of the popover in view inside the scrolling Settings body.
    panel.current?.scrollIntoView?.({block: "nearest"});
  }, [autoFocus, searchable]);

  // Keep the active option in view by scrolling the list alone (scrollIntoView would move the sheet or the page too).
  const currentId = current ? optionId(current) : undefined;
  useEffect(() => {
    const list = listbox.current;
    const option = currentId ? document.getElementById(currentId) : null;
    if (!list || !option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
  }, [currentId]);

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      const at = Math.min(active, shown.length - 1);
      setActive(e.key === "ArrowDown" ? Math.min(at + 1, shown.length - 1) : Math.max(at - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current) onPick(current);
    } else if (e.key === "Tab" && e.shiftKey && onBack) {
      e.preventDefault();
      onBack();
    }
  };

  return (
    <div ref={panel} className={s.pickerPanel}>
      {searchable ? (
        <Field
          ref={search}
          role="combobox"
          aria-label="Search networks"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={currentId}
          placeholder="Search networks"
          leading={<Icon name="search" size={16} color="var(--muted)" />}
          value={query}
          onChange={(e) => {
            const next = e.target.value;
            setQuery(next);
            setActive(next.trim() ? 0 : chosenIn(matchNetworks(networks, next)));
          }}
          onKeyDown={onKey}
          enterKeyHint="done"
          data-testid={`${testId}-search`}
        />
      ) : null}
      {/* rendered even when empty: the trigger and the search point at it */}
      <ul
        ref={listbox}
        id={listId}
        role="listbox"
        aria-label={listLabel}
        className={s.options}
        // Without the search, the list takes focus and the keys itself.
        {...(searchable ? {} : {tabIndex: 0, "aria-activedescendant": currentId, onKeyDown: onKey})}
        data-testid={`${testId}-list`}
      >
        {shown.map((n, i) => (
          <li
            key={n.value}
            id={optionId(n)}
            role="option"
            aria-selected={n === current}
            className={s.option}
            onMouseMove={() => setActive(i)}
            onClick={() => onPick(n)}
            data-testid={`${testId}-${n.value}`}
          >
            {n.slug ? <ChainLogo slug={n.slug} size={20} /> : null}
            <span className={s.optionName}>{n.name}</span>
            <span className={s.optionCheck}>{n.value === value ? <Icon name="check" size={12} color="var(--accent)" /> : null}</span>
          </li>
        ))}
      </ul>
      {shown.length ? null : (
        <Text as="p" variant="small" color="var(--muted)" role="status" className={s.pickerEmpty}>
          No network matches “{query.trim()}”.
        </Text>
      )}
      {footer ? <div className={s.pickerFoot}>{footer}</div> : null}
    </div>
  );
}
