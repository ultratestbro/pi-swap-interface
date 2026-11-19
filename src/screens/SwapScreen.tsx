/**
 * The swap screen, layout "version B" (D23, ui-port.md §5): the form (pay /
 * receive, flip, refund and recipient addresses, slippage, summary, CTA) and
 * the route list — side by side from 1024 px, stacked below, compact with a
 * sticky CTA on phones — plus every sheet: tokens, review (→ deposit /
 * status), activity, wallets, settings. Effects go through the ports only
 * (D15); the hash keeps pair, amount and an open swap (D22). Before a wallet
 * or address exists the list shows preview prices (D7), which never open the
 * review: only a live request with a live snapshot does. A re-quote of the same
 * pair and amount (slippage, an address, the refresh) keeps the screen's shape
 * (D32): rows, summary and receive amount stay, dimmed while quoted for other
 * terms, and the CTA waits for the chosen venue's new answer.
 */
import {useEffect, useEffectEvent, useMemo, useRef, useState} from "react";
import type {SwapRecord} from "../contracts/activity";
import type {SwapDraft} from "../contracts/execution";
import type {RoutesRequest} from "../contracts/routes";
import type {WalletFamily} from "../contracts/wallets";
import {isDemo, readHash, savedOverrides, setHashQuery, useHashRoute, usePorts} from "../config";
import {keepSelection, routeKey, routeName} from "../swap";
import {useBreakpoint} from "../ui";
import {ActivityDrawer} from "./activity/ActivityDrawer";
import {RecipientBox, RefundBox} from "./form/AddressBoxes";
import {FlipButton, PayCard, ReceiveCard} from "./form/AmountCards";
import {CtaBar, SlippageControl, SummaryCard, bpsLabel, slippageText} from "./form/FormParts";
import {ctaState, heldAs, routeListModel, venuesUnreachable} from "./form/model";
import {useSwapForm, type AwaitingSide, type FormPreset} from "./form/useSwapForm";
import {FAMILY_LABEL, plainUnits, walletFamilyOf} from "./labels";
import {ReviewSheet} from "./review/ReviewSheet";
import {RoutesPanel} from "./routelist/RoutesPanel";
import {REVIEW_SCENES, sceneFrom, scenePreset, sceneStatusId, type Scene} from "./scenes";
import {SavedNotice} from "./settings/SavedNotice";
import {SettingsSheet} from "./settings/SettingsSheet";
import {AppShell} from "./shell/AppShell";
import {TokenSheet, type ImportTarget} from "./tokens/TokenSheet";
import {linkedToken} from "./tokens/importModel";
import {useShownRoutes} from "./useShownRoutes";
import {ConnectSheet} from "./wallets/ConnectSheet";
import f from "./form/Form.module.css";
import s from "./SwapScreen.module.css";

/** Demo mode opens with an amount, so the route list streams at once (screenshots, e2e smoke). */
const DEMO_AMOUNT = "0.1";

/** The form's start: a demo scene, else the hash (`pay`, `receive`, `amount`), else empty (demo: a small amount). */
function presetOf(q: URLSearchParams, scene: Scene | null, demo: boolean): FormPreset {
  const sp = scenePreset(scene);
  const raw = q.get("amount") ?? "";
  const amount = /^\d*\.?\d*$/.test(raw) ? raw : "";
  return {
    pay: sp?.pay ?? q.get("pay") ?? undefined,
    receive: sp?.receive ?? q.get("receive") ?? undefined,
    amount: sp?.amount ?? (q.has("amount") ? amount : demo ? DEMO_AMOUNT : ""),
    refund: sp?.refund,
  };
}

/** A side of a pair link that names a token to import (D39): its key as the list will write it, and the address to read. */
interface LinkImport {
  side: "pay" | "receive";
  key: string;
  caip2: string;
  address: string;
}

/**
 * The preset with a link's token keys read against the list (D39, linkedToken): known keys as the list writes them,
 * unusable ones dropped (the default fills that side), and at most one side — the pay side first — to import.
 */
function linkedPreset(preset: FormPreset, byKey: ReadonlyMap<string, unknown>): {preset: FormPreset; link: LinkImport | null} {
  let link: LinkImport | null = null;
  const side = (s: "pay" | "receive"): string | undefined => {
    const l = linkedToken(preset[s], byKey);
    if (l?.kind === "known") return l.key;
    if (l?.kind === "import" && !link) {
      link = {side: s, key: l.key, caip2: l.caip2, address: l.address};
      return l.key;
    }
    return undefined;
  };
  const pay = side("pay");
  const receive = side("receive");
  const {pay: _p, receive: _r, ...rest} = preset;
  return {preset: {...rest, ...(pay ? {pay} : {}), ...(receive ? {receive} : {})}, link};
}

/**
 * The app below the providers (contract: ScreensModule.SwapScreen). In demo mode a `#/demo/<scene>` path (or
 * `scene=` query) opens a scene; a new scene remounts the screen with fresh state.
 */
export function SwapScreen() {
  const {path, query} = useHashRoute();
  const scene = isDemo() ? sceneFrom(path, query) : null;
  return <SwapApp key={scene ?? "swap"} scene={scene} />;
}

/** The screen, optionally opened in a demo scene (src/screens/scenes.ts). */
export function SwapApp({scene}: {scene: Scene | null}) {
  const ports = usePorts();
  const bp = useBreakpoint();
  const phone = bp === "phone";
  const demo = isDemo();
  const wallets = ports.wallets.useWallets();
  const tokens = ports.catalog.useSwapTokens(wallets.owners);
  const activity = ports.activity.useActivity();
  const hash = useHashRoute();

  // A pair link's token keys, read against the list (D39): a token the list doesn't have is never trusted on the link's
  // word — its side opens empty and the import confirmation opens for its address; a read that fails ignores it.
  const [{preset, link}] = useState(() => linkedPreset(presetOf(readHash().query, scene, demo), tokens.byKey));
  const linkLookup = ports.catalog.useTokenLookup(link?.caip2 ?? null, link?.address ?? null);
  const awaitingLink = !!link && !tokens.byKey.has(link.key) && linkLookup.status !== "failed";
  const linkRead = linkLookup.status === "found";
  const awaiting = useMemo((): AwaitingSide | null => (awaitingLink && link ? {side: link.side, key: link.key, settled: linkRead} : null), [awaitingLink, link, linkRead]);
  const form = useSwapForm(tokens, preset, Object.values(wallets.owners).some(Boolean), wallets.evm ? `eip155:${wallets.evm.chainId}` : null, awaiting);
  // Live when both addresses exist; preview prices meanwhile (D7). The mode is part of useRoutes' key, so the preview
  // list clears the moment the request becomes live and a live round runs.
  const request: RoutesRequest | null = form.req ? {mode: "live", req: form.req} : form.preview ? {mode: "preview", req: form.preview} : null;
  const quoted = ports.swap.useRoutes(request, tokens.prices);
  // The list as shown (D32): the same pair and amount re-quoted keeps its rows; ones quoted for other terms are held.
  const routes = useShownRoutes(request, quoted);
  const previewList = routes.snapshot?.mode === "preview";
  const model = useMemo(
    () => routeListModel(routes.snapshot, form.from, form.to, form.missing, routes.held),
    [routes.snapshot, form.from, form.to, form.missing, routes.held],
  );
  const chosenKey = keepSelection(model.routes, form.selected);
  const chosen = model.routes.find((r) => routeKey(r) === chosenKey);
  // Quoted for the previous slippage or address: shown dimmed, never reviewed, until its venue answers the new terms;
  // "updating" while the round runs, "outdated" once it is over without that answer (a failed round: the CTA retries).
  const chosenHeldAs = heldAs(model.held, chosen ? routeKey(chosen) : undefined, routes.loading);
  const chosenHeld = chosenHeldAs !== undefined;
  const cta = ctaState({
    missing: form.missing,
    unreachable: !!request && venuesUnreachable(model, routes.loading),
    from: form.from,
    balanceProblem: form.problem,
    routesLoading: routes.loading,
    chosen,
    preview: previewList,
    held: chosenHeld,
    providerName: routeName,
  });

  // Back online: ask again at once instead of leaving "can't reach" up until the next 30 s refresh.
  const requote = useEffectEvent(() => {
    if (form.req) routes.refresh();
  });
  useEffect(() => {
    const on = () => requote();
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, []);

  // The side stays set while the sheet animates closed, so its content doesn't switch lists on the way out. A pair link
  // naming a token to import opens it on that import's confirmation (D39).
  const [tokenSheet, setTokenSheet] = useState<{open: boolean; side: "pay" | "receive"; importing: ImportTarget | null}>(() => ({
    open: scene === "tokens" || !!link,
    side: link?.side ?? "pay",
    importing: link ? {caip2: link.caip2, address: link.address} : null,
  }));
  // The link's token couldn't be read: the confirmation closes and the side takes its default (awaiting is null).
  const tokenSheetOpen = tokenSheet.open && !(tokenSheet.importing && link && linkLookup.status === "failed");
  const [review, setReview] = useState<{draft: SwapDraft; n: number} | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [connect, setConnect] = useState<{open: boolean; focus: WalletFamily | null}>({open: scene === "connect", focus: null});
  const [activityOpen, setActivityOpen] = useState(scene === "activity");
  const [localStatus, setLocalStatus] = useState<string | null>(() => sceneStatusId(scene, activity.items));
  const [settingsOpen, setSettingsOpen] = useState(scene === "settings");
  const [routeSheet, setRouteSheet] = useState(scene === "routes");

  // The CTA's "Connect EVM wallet" closes the menu once that family is connected.
  if (connect.open && connect.focus !== null && wallets[connect.focus]) setConnect({open: false, focus: null});
  // A TON Connect attempt runs with the menu closed, for its own modal (D11): one that ends in an error (the modal
  // didn't load, no wallet answered in time, a testnet account) reopens the menu on TON, where the error shows.
  const tonModal = wallets.options.some((o) => o.kind === "tonconnect" && o.id === wallets.connecting);
  const [tonModalWas, setTonModalWas] = useState(tonModal);
  if (tonModal !== tonModalWas) {
    setTonModalWas(tonModal);
    if (!tonModal && wallets.error && !connect.open) setConnect({open: true, focus: "ton"});
  }

  const statusId = hash.query.get("swap") || localStatus;
  const drawerOpen = activityOpen || !!statusId;
  const openStatus = (id: string) => {
    setActivityOpen(true);
    setLocalStatus(id);
    setHashQuery({swap: id});
  };
  const showList = () => {
    setActivityOpen(true);
    setLocalStatus(null);
    setHashQuery({swap: null});
  };
  const closeDrawer = () => {
    setActivityOpen(false);
    setLocalStatus(null);
    setHashQuery({swap: null});
  };

  // Only a live request with a live snapshot is reviewable: a preview route never becomes a draft (D7), nor a route
  // quoted for other terms than form.req's (D32) — the review re-quotes, but falls back to the drafted route on a
  // network error and confirms with its floor and spender.
  function openReview() {
    if (!form.req || !chosen || routes.snapshot?.mode !== "live" || chosenHeld) return;
    const draft: SwapDraft = {req: form.req, route: chosen};
    setReview((r) => ({draft, n: (r?.n ?? 0) + 1}));
    setReviewOpen(true);
  }

  function onCta() {
    if (cta.action === "connect") setConnect({open: true, focus: cta.family ?? null});
    else if (cta.action === "review") openReview();
    // The round for new terms failed over a held route: ask again (never a review of the held number).
    else if (cta.action === "refresh") routes.refresh();
    // Enter on a (preview) route while an address is missing: to the field that needs it.
    else if (cta.state === "address")
      document.querySelector<HTMLInputElement>(`[data-testid="${form.missing?.kind === "refund" ? "swap-refund" : "swap-recipient"}"]`)?.focus();
  }

  function tryAgain(r: SwapRecord) {
    if (r.fromKey && r.toKey) form.restore({pay: r.fromKey, receive: r.toKey}, plainUnits(r.amountIn, r.fromDecimals));
    setReviewOpen(false);
    closeDrawer();
  }

  const connectFamily = (family: WalletFamily) => setConnect({open: true, focus: family});
  // A QR payer whose family also has a browser wallet (Tron, TON): the refund box offers connecting it instead.
  const payWallet = form.from ? walletFamilyOf(form.from.family) : null;

  // Demo scenes that start in the review open it once the routes are in (state set from a timer, not the effect).
  const sceneAuto = scene ? REVIEW_SCENES[scene] : undefined;
  const sceneOpened = useRef(false);
  const openFromScene = useEffectEvent(() => openReview());
  const routeReady = !!form.req && !!chosen && !chosenHeld && !routes.loading && routes.snapshot?.mode === "live";
  useEffect(() => {
    if (!sceneAuto || sceneOpened.current || !routeReady) return;
    const t = setTimeout(() => {
      sceneOpened.current = true;
      openFromScene();
    }, 300);
    return () => clearTimeout(t);
  }, [sceneAuto, routeReady]);

  const routesPanel = (mode: "full" | "compact") => (
    <RoutesPanel
      mode={mode}
      hint={form.hint}
      state={routes}
      model={model}
      from={form.from}
      to={form.to}
      chosen={chosenKey}
      onSelect={form.setSelected}
      onSubmit={onCta}
      refusedOpen={scene === "refused"}
      sheetOpen={routeSheet}
      onSheet={setRouteSheet}
    />
  );

  return (
    <AppShell
      wallets={wallets}
      activity={activity}
      demo={demo}
      onWallets={() => setConnect({open: true, focus: null})}
      onActivity={() => setActivityOpen(true)}
      onSettings={() => setSettingsOpen(true)}
    >
      <div className={s.layout}>
        <div className={s.formCol} data-testid="swap-form">
          <SavedNotice overrides={savedOverrides()} onSettings={() => setSettingsOpen(true)} />
          <div className={f.pair}>
            <PayCard
              from={form.from}
              text={form.text}
              amountIn={form.amountIn}
              problem={form.problem}
              balance={form.balance}
              onAmount={form.setAmount}
              onPaste={form.pasteAmount}
              note={form.pasteNote}
              // A route that charges its fee on top of the amount (Stargate) gets room for it in a native MAX.
              onMax={() => form.max(chosen?.nativeFee ?? 0n)}
              onPickToken={() => setTokenSheet({open: true, side: "pay", importing: null})}
            />
            <FlipButton disabled={!form.canFlip} onFlip={form.flip} />
            <ReceiveCard
              from={form.from}
              to={form.to}
              route={chosen}
              quoting={!!request && routes.loading}
              held={chosenHeldAs}
              preview={previewList}
              onPickToken={() => setTokenSheet({open: true, side: "receive", importing: null})}
            />
          </div>
          {form.from?.payMode === "deposit" ? (
            <RefundBox
              from={form.from}
              text={form.refundText}
              check={form.refund}
              onText={form.setRefundText}
              {...(payWallet ? {onConnect: () => connectFamily(payWallet), walletLabel: FAMILY_LABEL[payWallet]} : {})}
            />
          ) : null}
          {form.to ? (
            <RecipientBox
              to={form.to}
              toOther={form.toOther}
              forced={form.recipientForced}
              ownerIsContract={form.ownerIsContract}
              text={form.recipientText}
              check={form.recipient}
              onToggle={form.setToOther}
              onText={form.setRecipientText}
            />
          ) : null}
          <SlippageControl custom={form.slippage} autoBps={form.autoBps} onChange={form.setSlippage} />
          {bp === "desktop" ? null : routesPanel(phone ? "compact" : "full")}
          {chosen && form.from && form.to && form.amountIn ? (
            <SummaryCard
              from={form.from}
              to={form.to}
              amountIn={form.amountIn}
              route={chosen}
              slippage={slippageText(form.slippage, form.autoBps)}
              preview={previewList}
              held={chosenHeldAs}
            />
          ) : null}
          <CtaBar cta={cta} onPress={onCta} />
        </div>
        {bp === "desktop" ? <div className={s.routesCol}>{routesPanel("full")}</div> : null}
      </div>

      <TokenSheet
        open={tokenSheetOpen}
        side={tokenSheet.side}
        tokens={tokenSheet.side === "receive" ? tokens.receive : tokens.pay}
        selected={tokenSheet.side === "receive" ? form.pair?.receive : form.pair?.pay}
        {...(tokenSheet.side === "receive" ? (form.from ? {other: form.from} : {}) : form.to ? {other: form.to} : {})}
        importing={tokenSheet.importing}
        onPick={(t) => {
          // A token imported this moment (D39) isn't on the list until the next render: the form takes it as given.
          form.pick(tokenSheet.side, t.key, t.imported ? t : undefined);
          setTokenSheet((x) => ({...x, open: false}));
        }}
        onClose={() => setTokenSheet((x) => ({...x, open: false}))}
      />
      {review ? (
        <ReviewSheet
          key={review.n}
          open={reviewOpen}
          draft={review.draft}
          tokens={tokens}
          wallets={wallets}
          slippage={form.slippage === null ? `Auto slippage ${bpsLabel(form.autoBps)}` : `Slippage ${bpsLabel(form.slippage)}`}
          auto={sceneAuto && review.n === 1 ? sceneAuto : "none"}
          onClose={() => setReviewOpen(false)}
          onShowStatus={(id) => {
            setReviewOpen(false);
            openStatus(id);
          }}
          onTryAgain={tryAgain}
          onConnect={connectFamily}
        />
      ) : null}
      <ActivityDrawer
        open={drawerOpen}
        statusId={statusId}
        wallets={wallets}
        onOpenStatus={openStatus}
        onBack={showList}
        onClose={closeDrawer}
        onTryAgain={tryAgain}
        onConnect={connectFamily}
      />
      <ConnectSheet
        open={connect.open}
        focus={connect.focus}
        wallets={wallets}
        onClose={() => setConnect({open: false, focus: null})}
        onSettings={() => {
          setConnect({open: false, focus: null});
          setSettingsOpen(true);
        }}
      />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </AppShell>
  );
}
