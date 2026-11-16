/**
 * Review → execute (mobile app/swap/review.tsx → status.tsx, ui-port.md
 * §5.8-5.9). Everything Confirm authorizes is on screen before the wallet is
 * asked: venue, amounts, the minimum received (the execution floor), fees,
 * the approval and its spender, both addresses. The route is re-quoted every
 * 30 s while the review is open. Confirm gets a signer (EVM switches chain
 * first) and starts the swap. The review stays, locked, while the wallet is
 * asked — its steps follow the record once the engine names one — and becomes
 * the swap's status only once the swap itself is broadcast (an approval sent
 * first is not the swap); a swap that stops before that shows why. A wallet
 * that never answers doesn't trap the user: after 20 s a quiet way out shows —
 * "Cancel" while the chain switch is asked (nothing started, and nothing will),
 * "Continue in background" once the swap is started (leaving never cancels it;
 * a stop the drawer can't show yet is a toast). A QR payer gets a deposit
 * address instead (DepositPanel).
 */
import {useEffect, useEffectEvent, useRef, useState} from "react";
import type {SwapRecord} from "../../contracts/activity";
import type {DepositTicket, ReviewedSwap, SwapDraft} from "../../contracts/execution";
import type {SwapTokensState} from "../../contracts/ports";
import type {WebRoute} from "../../contracts/routes";
import type {WalletFamily, WalletsApi} from "../../contracts/wallets";
import {savedOverrides, usePorts} from "../../config";
import {chainBySlugWeb, destTokenId} from "../../catalog";
import {FYND_LICENSE_URL, PERMIT2_VENUES, balanceProblem, fyndRouterNotice, isStale, routeFloor} from "../../swap";
import {swapErrorText, swapFeeCap, uncappedFeeText} from "../../execute";
import {statusView, swapSteps, wasInterrupted} from "../../activity";
import {Button, Icon, ReviewSkeleton, Sheet, SheetHeader, SwapSteps, Text, TokenIcon, TxReviewCard, formatCountdown, showToast} from "../../ui";
import {StatusView, activeDetail} from "../activity/StatusView";
import {SavedNotice} from "../settings/SavedNotice";
import {amountText} from "../labels";
import {useNow} from "../useNow";
import {DepositPanel} from "./DepositPanel";
import {paysToOwn, reviewRows} from "./rows";
import s from "./Review.module.css";

/**
 * The route a phase acts on is held in it, so the screen doesn't change under the user while the wallet is asked.
 * `executing` is `started` once the signer is in hand and startSwap called, and carries the record's id once startSwap
 * names it (the engine's first step).
 */
type Phase =
  | {step: "review"}
  | {step: "executing"; route: WebRoute; started?: boolean; id?: string}
  | {step: "issuing"; route: WebRoute; ticket?: DepositTicket}
  | {step: "error"; title: string; message: string}
  | {step: "deposit"; route: WebRoute; ticket: DepositTicket}
  | {step: "status"; id: string};

/** How long the review waits on the wallet before it offers a way out ("Cancel" / "Continue in background"). */
export const BACKGROUND_AFTER_MS = 20_000;

/**
 * What the wallet will ask between the network switch and the swap's own signature: an exact approval, or — for a
 * Permit2 venue (0x, D38) — a one-time Permit2 signature for exactly the amount first, then Permit2's approval unless
 * it may already spend it (the engine leaves a standing Permit2 allowance that covers the input as it is).
 */
export function walletSteps(route: Pick<WebRoute, "provider" | "approvalSpender"> | null | undefined, amount: string): string {
  if (!route?.approvalSpender) return "";
  if (PERMIT2_VENUES.has(route.provider)) return `, then to sign a one-time Permit2 transfer of exactly ${amount}, then to approve Permit2 for it unless it already may`;
  return `, then to approve exactly ${amount}`;
}

/**
 * Where the review goes once the record it follows moves (ui-port.md §5.8): the status once the swap itself is out —
 * its hash is on the record, or the record left `submitting` for a tracked state (a signed order, a maybe-sent
 * broadcast) — the error phase when it stopped before, or nowhere while the wallet is still asked. An approval's
 * broadcast is not the swap's: the record stays `submitting` without a source hash. A record another tab took for
 * interrupted is this tab's to take back (its heartbeat does), so it is not an outcome.
 */
export function afterConfirm(r: SwapRecord, toChainName: string): {step: "status"} | {step: "error"; message: string} | null {
  if (wasInterrupted(r)) return null;
  if (r.status === "not-sent") return {step: "error", message: statusView(r, toChainName).detail};
  return r.status !== "submitting" || r.sourceHash ? {step: "status"} : null;
}

/** What a demo scene makes the review do by itself (src/screens/scenes.ts). */
export type ReviewAutoAction = "none" | "confirm" | "error" | "issue" | "expired";

export interface ReviewSheetProps {
  open: boolean;
  draft: SwapDraft;
  tokens: SwapTokensState;
  wallets: WalletsApi;
  /** "Auto slippage 0.5%" / "Slippage 1%" (the minimum received's tip). */
  slippage: string;
  onClose(): void;
  /** A QR payer pressed "I've sent it": follow the record in the activity drawer. */
  onShowStatus(id: string): void;
  onTryAgain(r: SwapRecord): void;
  onConnect(family: WalletFamily): void;
  auto?: ReviewAutoAction;
}

export function ReviewSheet({open, draft, tokens, wallets, slippage, onClose, onShowStatus, onTryAgain, onConnect, auto = "none"}: ReviewSheetProps) {
  const ports = usePorts();
  const [phase, setPhase] = useState<Phase>({step: "review"});
  const busy = useRef(false);
  // The user left the locked sheet ("Cancel" / "Continue in background"): a confirm still waiting acts on that.
  const away = useRef(false);
  const now = useNow();
  const requote = ports.swap.useRequote(phase.step === "review" ? draft : null, tokens.prices);

  const {req} = draft;
  // Balance and price as they are now (a refresh may have landed since the form).
  const from = tokens.byKey.get(req.from.key) ?? req.from;
  const to = req.to;
  const qr = from.payMode === "deposit";
  const chain = chainBySlugWeb(from.chain);
  const native = chain?.native;
  const route = phase.step === "executing" || phase.step === "issuing" || phase.step === "deposit" ? phase.route : requote.route;
  const stale = phase.step === "review" && !!route && isStale(route, now);
  const nativePrice = tokens.byKey.get(`${from.chain}:native`)?.priceUsd ?? (native ? tokens.prices[native.symbol] : undefined);
  // An EVM native with no price has no fee budget — such a swap isn't signed (execute swapFeeCap).
  const uncapped =
    !qr &&
    !!chain &&
    (chain.family === "evm" || chain.family === "solana") &&
    swapFeeCap(chain.family, {
      ...(chain.chainId !== undefined ? {chainId: chain.chainId} : {}),
      nativeSymbol: chain.native.symbol,
      decimals: chain.native.decimals,
      ...(nativePrice !== undefined ? {nativePriceUsd: nativePrice} : {}),
    }) === undefined;
  const problem =
    (from.balance === "loaded" && !qr ? balanceProblem(req.amountIn, BigInt(from.amount)) : null) ?? (uncapped && native ? uncappedFeeText(native.symbol) : null);
  const locked = phase.step === "executing" || phase.step === "issuing";

  // Confirmed: follow the record until the swap is broadcast (→ status) or stops before it (→ why).
  const followed = ports.activity.useSwap(phase.step === "executing" ? (phase.id ?? null) : null);
  const outcome = phase.step === "executing" && phase.id && followed ? afterConfirm(followed, to.chainName) : null;
  if (outcome && phase.step === "executing" && phase.id) {
    setPhase(outcome.step === "status" ? {step: "status", id: phase.id} : {step: "error", title: "Not swapped", message: outcome.message});
  }
  // A wallet that never answers: after a while the sheet may be left — before the swap is started that cancels it,
  // after, it carries on (closing never cancels a started swap).
  const [waited, setWaited] = useState(false);
  const leave = phase.step !== "executing" || !waited ? null : phase.started ? "background" : "cancel";
  useEffect(() => {
    if (phase.step !== "executing") return;
    const t = setTimeout(() => setWaited(true), BACKGROUND_AFTER_MS);
    return () => clearTimeout(t);
  }, [phase.step]);

  // A quote past its validity: show the skeleton and ask again (the review never confirms an expired price).
  const refetch = useEffectEvent(() => requote.refetch());
  useEffect(() => {
    if (stale && phase.step === "review") refetch();
  }, [stale, phase.step]);

  async function confirm() {
    if (busy.current || !route || problem || requote.gone || stale) return;
    busy.current = true;
    const minOut = routeFloor(route);
    const reviewed: ReviewedSwap = {
      provider: route.provider,
      fromChain: from.caip2,
      fromContract: from.contract,
      amountIn: req.amountIn,
      destChain: to.caip2,
      destToken: destTokenId(to),
      recipient: req.recipient,
      refundAddress: req.refundAddress,
      minOut,
      slippageBps: req.slippageBps,
      approvalSpender: route.approvalSpender,
      nativeFee: route.nativeFee,
    };
    setWaited(false);
    setPhase({step: "executing", route});
    let started = false;
    try {
      const signer = await ports.wallets.getSigner(from.caip2);
      // Cancelled while the wallet switched chains: nothing was started, and nothing is now.
      if (away.current) return;
      started = true;
      setPhase((p) => (p.step === "executing" ? {...p, started: true} : p));
      const id = await ports.execute.startSwap({
        from,
        to,
        reviewed,
        expectedOut: route.destAmount,
        signer,
        ...(nativePrice !== undefined ? {nativePriceUsd: nativePrice} : {}),
        onSettled: () => tokens.refresh(),
      });
      // The engine's first step started: the review stays until the record says the swap is out (afterConfirm).
      setPhase((p) => (p.step === "executing" ? {...p, id} : p));
    } catch (e) {
      // Stopped before anything was broadcast (declined, chain not switched, the route moved): say why — in a toast
      // too when the started swap was left for the background before the engine made a record the drawer could show.
      const message = swapErrorText(e, native?.symbol ?? "the native coin");
      if (away.current && started) showToast(`Not swapped: ${message}`, {tone: "red", ms: 10_000});
      setPhase({step: "error", title: "Not swapped", message});
    } finally {
      busy.current = false;
    }
  }

  async function issue(renewFrom?: DepositTicket) {
    if (busy.current || !route || stale) return;
    busy.current = true;
    const held = route;
    setPhase({step: "issuing", route: held, ...(renewFrom ? {ticket: renewFrom} : {})});
    try {
      const ticket = await ports.execute.issueDeposit({req, provider: held.provider, minOut: routeFloor(held)});
      setPhase({step: "deposit", route: held, ticket: auto === "expired" && !renewFrom ? {...ticket, validUntilMs: Date.now() - 1} : ticket});
    } catch (e) {
      setPhase({step: "error", title: "No deposit address", message: swapErrorText(e, from.symbol)});
    } finally {
      busy.current = false;
    }
  }

  // Demo scenes (review → executing / error / deposit) act once the fresh quote is in.
  const autoDone = useRef(false);
  const runAuto = useEffectEvent(() => {
    if (auto === "confirm") void confirm();
    else if (auto === "issue" || auto === "expired") void issue();
    else if (auto === "error") setPhase({step: "error", title: "Not swapped", message: "You declined in your wallet — nothing was sent."});
  });
  const ready = !!route && !requote.loading && phase.step === "review";
  useEffect(() => {
    if (auto === "none" || autoDone.current || !ready) return;
    const t = setTimeout(() => {
      autoDone.current = true;
      runAuto();
    }, 400);
    return () => clearTimeout(t);
  }, [auto, ready]);

  const close = () => {
    if (!locked) onClose();
  };

  // A new phase replaces the focused button: move focus to the new body's first control, not the dialog frame.
  const frame = useRef<HTMLDivElement>(null);
  const firstPhase = useRef(true);
  useEffect(() => {
    if (firstPhase.current) {
      firstPhase.current = false;
      return;
    }
    if (phase.step === "executing" || phase.step === "issuing") return;
    frame.current?.querySelector<HTMLElement>("[data-autofocus], button:not([disabled])")?.focus({preventScroll: true});
  }, [phase.step]);

  let body;
  if (phase.step === "status") {
    body = <StatusView id={phase.id} wallets={wallets} onClose={onClose} onTryAgain={onTryAgain} onConnect={onConnect} />;
  } else if (phase.step === "deposit" || (phase.step === "issuing" && phase.ticket)) {
    const ticket = phase.step === "deposit" ? phase.ticket : phase.ticket!;
    body = (
      <DepositPanel
        ticket={ticket}
        req={req}
        from={from}
        to={to}
        renewing={phase.step === "issuing"}
        onRenew={() => void issue(ticket)}
        onSent={() => onShowStatus(ticket.id)}
        onClose={close}
      />
    );
  } else if (phase.step === "error") {
    body = (
      <div className={s.body} data-testid="swap-review-error">
        <div className={s.error}>
          <span className={s.errorDisc} aria-hidden="true">
            <Icon name="close" size={26} color="var(--red)" />
          </span>
          <Text as="h2" variant="title" className={s.errorTitle}>
            {phase.title}
          </Text>
          <Text as="p" variant="small" color="var(--ink2)" selectable className={s.errorText} data-testid="swap-error" role="alert">
            {phase.message}
          </Text>
        </div>
        <div className={s.actions}>
          <Button kind="secondary" block title="Review again" onClick={() => setPhase({step: "review"})} data-testid="swap-retry" />
          <Button block title="Close" onClick={onClose} data-testid="swap-close" />
        </div>
      </div>
    );
  } else {
    body = (
      <ReviewBody
        draft={draft}
        from={from}
        native={native}
        slippage={slippage}
        route={stale ? null : route}
        gone={requote.gone}
        failed={requote.failed}
        problem={problem}
        executing={phase.step === "executing"}
        record={phase.step === "executing" ? followed : undefined}
        leave={leave}
        issuing={phase.step === "issuing"}
        now={now}
        onConfirm={() => void (qr ? issue() : confirm())}
        onClose={close}
        onLeave={() => {
          away.current = true;
          onClose();
        }}
      />
    );
  }

  return (
    <Sheet open={open} onClose={close} label={qr ? "Review deposit" : "Review swap"} locked={locked} width={440} phoneHeight="tall" data-testid="swap-review-sheet">
      <div ref={frame}>{body}</div>
    </Sheet>
  );
}

/**
 * An "Imported token" note per side imported by its address (D39): its full contract, read before Confirm — a copy of a
 * real token differs from it only there. Steps aside once confirmed (D37), like the other notes.
 */
function ImportedNotes({tokens}: {tokens: readonly SwapDraft["req"]["from"][]}) {
  const imported = tokens.filter((t, i) => t.imported && t.contract && tokens.findIndex((x) => x.key === t.key) === i);
  if (!imported.length) return null;
  return (
    <>
      {imported.map((t) => (
        <div key={t.key} className={s.otherBox} role="note" data-testid="swap-review-imported">
          <Text variant="small" weight={600} color="var(--amber)">
            {`Imported token: ${t.symbol}`}
          </Text>
          <Text as="p" variant="meta" color="var(--ink2)" selectable className={s.fine}>
            {`Not on the token list — added by its address on ${t.chainName}: `}
            <span className={s.mono}>{t.contract}</span>
            {`. Check it against the project's official sources${t.priceUsd === undefined ? "; no price was found for it" : ""}.`}
          </Text>
        </div>
      ))}
    </>
  );
}

interface ReviewBodyProps {
  draft: SwapDraft;
  from: SwapDraft["req"]["from"];
  native: {symbol: string; decimals: number} | undefined;
  slippage: string;
  /** null while the first (or a stale) quote is fetched. */
  route: SwapDraft["route"] | null;
  gone: string | null;
  failed: boolean;
  problem: string | null;
  executing: boolean;
  /** The confirmed swap's record, once the engine's first step made one. */
  record: SwapRecord | undefined;
  /**
   * The wallet has been asked for a while: offer to leave the sheet — "cancel" before the swap is started (the chain
   * switch), "background" after (the swap and its record carry on).
   */
  leave: "cancel" | "background" | null;
  issuing: boolean;
  now: number;
  onConfirm(): void;
  onClose(): void;
  /** Close the locked sheet ("Cancel" / "Continue in background"). */
  onLeave(): void;
}

/** The review rows still shown once Confirm is pressed: the amounts, the floor and the venue. */
const EXECUTING_ROWS: ReadonlySet<string> = new Set(["swap-review-pay", "swap-review-receive", "swap-review-min", "swap-review-route"]);

/** The review phase: headline, rows, warnings, fine print, Confirm (or "Get deposit address"); while executing, the steps. */
function ReviewBody({draft, from, native, slippage, route, gone, failed, problem, executing, record, leave, issuing, now, onConfirm, onClose, onLeave}: ReviewBodyProps) {
  const {req} = draft;
  const to = req.to;
  const qr = from.payMode === "deposit";
  const cross = from.caip2 !== to.caip2;
  const toOther = !paysToOwn(req);
  const left = route && route.validUntilMs > 0 ? route.validUntilMs - now : null;
  const valid = left !== null && left > 0 ? formatCountdown(left) : null;
  // Confirm's block is what the user watches while the wallet is asked: the steps (taller than the fine print they
  // replace) and the late offer to leave would push it under the sheet's edge, so it is scrolled back into view —
  // with the sheet's bottom padding (its scroll margin), never flush against the edge.
  const actions = useRef<HTMLDivElement>(null);
  const steps = executing && !!record;
  useEffect(() => {
    if (executing) actions.current?.scrollIntoView?.({block: "nearest"});
  }, [executing, steps, leave]);
  return (
    <div className={s.body} data-testid="swap-review-body">
      <SheetHeader
        icon={<TokenIcon token={from} size={44} />}
        title={qr ? "Review deposit" : "Review swap"}
        sub={cross ? `${from.chainName} → ${to.chainName}` : `on ${from.chainName}`}
        onClose={executing || issuing ? undefined : onClose}
      />
      {/* The networks are the header's sub line; said once. */}
      <Text variant="amount" tabular className={s.headline} data-testid="swap-review-amount">
        {`${amountText(req.amountIn, from.decimals, from.symbol)} → ${to.symbol}`}
      </Text>
      {route ? (
        // Once confirmed, the card keeps what is being swapped, at what price and through whom; the rest was reviewed,
        // and the steps and Confirm must stay on screen with the swap's terms above them (web, D37).
        <TxReviewCard compact rows={executing ? reviewRows({req, route, from, to, native, slippage}).filter((r) => r.testId !== undefined && EXECUTING_ROWS.has(r.testId)) : reviewRows({req, route, from, to, native, slippage})} />
      ) : gone ? null : (
        <ReviewSkeleton label="Getting a fresh quote…" />
      )}
      {route && toOther ? (
        <div className={s.otherBox} data-testid="swap-review-other">
          <Text variant="small" weight={600} color="var(--amber)">
            Paid out to another address
          </Text>
          <Text as="p" variant="meta" color="var(--ink2)" selectable className={s.fine}>
            {`${req.recipient} on ${to.chainName}. Check every character — a swap sent to the wrong address can't be undone.`}
          </Text>
        </div>
      ) : null}
      {route && !executing ? <ImportedNotes tokens={[from, to]} /> : null}
      {route?.provider === "fynd" && !executing ? (
        <div className={s.licenseBox} role="note" data-testid="swap-review-fynd-license">
          <Text as="p" variant="meta" color="var(--ink2)" selectable className={s.fine}>
            {`${fyndRouterNotice(from.chainName)} `}
            <a className={s.licenseLink} href={FYND_LICENSE_URL} target="_blank" rel="noopener noreferrer">
              Fynd License
            </a>
          </Text>
        </div>
      ) : null}
      {gone ? (
        <div className={s.actions}>
          <Text as="p" variant="meta" color="var(--red)" data-testid="swap-route-gone">
            {gone}
          </Text>
          <Button kind="secondary" height={40} title="Pick another route" onClick={onClose} />
        </div>
      ) : null}
      {failed ? (
        <Text as="p" variant="meta" color="var(--amber)">
          Couldn&apos;t refresh the quote — showing the one you picked. The swap re-checks it before signing.
        </Text>
      ) : null}
      {problem ? (
        <Text as="p" variant="meta" color="var(--red)" data-testid="swap-review-problem">
          {problem}
        </Text>
      ) : null}
      {executing ? null : <SavedNotice overrides={savedOverrides()} />}
      {/* Once confirmed, the steps take the fine print's place: what it promised is what they show happening. */}
      {executing ? (
        record ? (
          <SwapSteps steps={swapSteps(record, to.chainName)} activeDetail={activeDetail(record)} />
        ) : null
      ) : (
        <Text as="p" variant="meta" color="var(--dim)" className={s.fine} data-testid="swap-review-fine">
          {/* Two lines at 400 px (D34): the countdown leads instead of a sentence of its own. */}
          {valid ? `Valid ${valid} · ` : ""}
          {qr
            ? `${valid ? "the" : "The"} deposit address is issued by the venue for this quote only. Send from any wallet; if the swap can't complete, ${from.symbol} goes back to the refund address.`
            : `${valid ? "re-quoted" : "Re-quoted"} before signing; refused below the minimum, to another address or with an unseen approval · signed in your browser`}
        </Text>
      )}
      <div ref={actions} className={s.actions}>
        <Button
          block
          height={54}
          title={qr ? "Get deposit address" : "Confirm swap"}
          loading={executing || issuing}
          disabled={!route || !!problem || !!gone || executing || issuing}
          onClick={onConfirm}
          data-testid={qr ? "swap-get-deposit" : "swap-confirm"}
        />
        {executing ? (
          <Text as="p" variant="meta" color="var(--muted)" className={s.fine} role="status">
            {`Check your wallet: it may ask to switch to ${from.chainName} first${walletSteps(route, amountText(req.amountIn, from.decimals, from.symbol))}, then to sign the swap.`}
          </Text>
        ) : null}
        {executing && leave === "cancel" ? <Button block kind="ghost" height={40} title="Cancel" onClick={onLeave} data-testid="swap-review-cancel" /> : null}
        {executing && leave === "background" ? (
          <Button block kind="ghost" height={40} title="Continue in background" onClick={onLeave} data-testid="swap-review-background" />
        ) : null}
      </div>
    </div>
  );
}
