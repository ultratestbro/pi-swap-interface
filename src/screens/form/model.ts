/**
 * The swap form's decisions as pure functions, so every state the screen can
 * show is unit-testable without rendering: whether a live quote request can be
 * built (D7: never with a made-up address) or only preview prices, what the
 * idle hint and the preview banner say, the CTA state machine (ui-port.md
 * §5.4; never "review" on a preview, nor on a route quoted for other terms),
 * which routes a QR payer may pick (D20), and the list as shown while it is
 * re-quoted (D32: rows keep their place, outdated ones are held). The screen
 * only wires these to state and ports.
 */
import type {RecipientCheck, SwapRecipient, SwapToken} from "../../contracts/domain";
import type {PreviewRequest, QuoteRequest, RouteRejection, RouteSnapshot, RoutesRequest, RoutesState, WebRoute} from "../../contracts/routes";
import type {WalletFamily} from "../../contracts/wallets";
import {omnistonSwapRouteSigned, tonCallSigned} from "../../execute";
import {canPreview, routeKey, routesKey, venueScope} from "../../swap";
import {FAMILY_LABEL, agoLabel, plural, walletFamilyOf} from "../labels";

/** What still stops a quote request, in the order the user meets it. */
export type Missing =
  | {kind: "tokens"; loading: boolean}
  | {kind: "connect"; family: WalletFamily}
  | {kind: "amount"}
  | {kind: "refund"; chainName: string; invalid: boolean}
  | {kind: "recipient"; chainName: string; invalid: boolean; canConnect: boolean};

/** The form fields a request is built from (already validated per family). */
export interface FormFields {
  from: SwapToken | undefined;
  to: SwapToken | undefined;
  /** Base units, null when the field is empty or not a number. */
  amountIn: bigint | null;
  slippageBps: number;
  /** True while tokens/balances are still loading (the hint says so). */
  loadingTokens: boolean;
  /** The recipient field is on (toggled, or forced because no wallet of that family is connected). */
  recipientOn: boolean;
  /** The user turned "Send to another address" on (not merely forced by a missing wallet). */
  toOther: boolean;
  /** swapRecipient() of the field while it is on. */
  recipient: SwapRecipient | null;
  /** checkRecipient() of the refund field (deposit payers only). */
  refund: RecipientCheck | null;
}

/** The quote request (D7: both addresses explicit) or what is still missing. */
export function buildRequest(f: FormFields): {req: QuoteRequest | null; missing: Missing | null} {
  const {from, to} = f;
  if (!from || !to) return {req: null, missing: {kind: "tokens", loading: f.loadingTokens}};
  const payFamily = walletFamilyOf(from.family);
  if (from.payMode === "connect" && payFamily) return {req: null, missing: {kind: "connect", family: payFamily}};
  if (f.amountIn === null || f.amountIn <= 0n) return {req: null, missing: {kind: "amount"}};

  if (from.payMode === "deposit" && f.refund?.kind !== "address")
    return {req: null, missing: {kind: "refund", chainName: from.chainName, invalid: f.refund?.kind === "invalid" || f.refund?.kind === "name"}};
  const refundAddress = f.refund?.kind === "address" ? f.refund.address : from.owner;
  if (!refundAddress) return {req: null, missing: {kind: "tokens", loading: f.loadingTokens}};

  let recipient: string | null;
  if (f.recipientOn) recipient = f.recipient?.kind === "ok" ? f.recipient.address : null;
  else recipient = to.owner;
  if (!recipient)
    return {
      req: null,
      missing: {
        kind: "recipient",
        chainName: to.chainName,
        invalid: f.recipient?.kind === "invalid",
        canConnect: to.owner === null && walletFamilyOf(to.family) !== null,
      },
    };

  return {req: {from, to, amountIn: f.amountIn, slippageBps: f.slippageBps, recipient, refundAddress}, missing: null};
}

/**
 * Preview prices while an address is still missing (D7): previews are on, the pair and amount are set, both families
 * have a preview sample (canPreview), and what's missing is the wallet, the refund address or the recipient. It
 * carries only the addresses the user really has; the engine fills a blank one per venue, inside its preview round.
 */
export function buildPreview(f: FormFields, missing: Missing | null, enabled: boolean): PreviewRequest | null {
  const {from, to} = f;
  if (!enabled || !missing || !from || !to) return null;
  if (missing.kind !== "connect" && missing.kind !== "refund" && missing.kind !== "recipient") return null;
  if (f.amountIn === null || f.amountIn <= 0n || !canPreview(from.family, to.family)) return null;
  const refundAddress = from.payMode === "deposit" ? (f.refund?.kind === "address" ? f.refund.address : null) : from.owner;
  const recipient = f.recipientOn ? (f.recipient?.kind === "ok" ? f.recipient.address : null) : to.owner;
  return {
    preview: true,
    from,
    to,
    amountIn: f.amountIn,
    slippageBps: f.slippageBps,
    toOther: f.toOther,
    ...(recipient ? {recipient} : {}),
    ...(refundAddress ? {refundAddress} : {}),
  };
}

/**
 * The route list's idle line when there is neither a request nor a preview (ui-port.md §5.5 "idle", D7 wording).
 * `previewsNeedAmount`: previews would show for this pair once an amount is typed, so a missing wallet asks for that.
 */
export function idleHint(m: Missing, previewsNeedAmount = false): string {
  switch (m.kind) {
    case "tokens":
      return m.loading ? "Loading your tokens…" : "Pick the tokens to swap.";
    case "connect":
      return previewsNeedAmount ? "Enter an amount to see routes from every venue." : "Connect a wallet to see routes";
    case "amount":
      return "Enter an amount to see routes from every venue.";
    case "refund":
      return m.invalid ? `Enter a valid ${m.chainName} refund address to see routes` : `Enter the ${m.chainName} refund address to see routes`;
    case "recipient":
      if (m.invalid) return `Enter a valid ${m.chainName} address to see routes`;
      return m.canConnect ? `Connect a wallet or paste the ${m.chainName} address to see routes` : `Enter the ${m.chainName} address to see routes`;
  }
}

/** One CTA state: its label, whether it can be pressed, and what pressing does. */
export interface CtaState {
  label: string;
  enabled: boolean;
  action: "connect" | "review" | "refresh" | "none";
  /** For "connect": the family to connect. */
  family?: WalletFamily;
  /** Stable name of the state (tests, data-state). */
  state: "tokens" | "connect" | "amount" | "address" | "balance" | "finding" | "updating" | "retry" | "no-route" | "unreachable" | "deposit" | "review";
}

export interface CtaInput {
  missing: Missing | null;
  /** venuesUnreachable(): every venue failed in transport (offline, blocked) — not a "no route" answer. */
  unreachable?: boolean;
  from: SwapToken | undefined;
  /** balanceProblem() of a loaded balance (unknown balances never block). */
  balanceProblem: string | null;
  routesLoading: boolean;
  chosen: WebRoute | undefined;
  /** The list holds preview prices (snapshot mode "preview"): nothing in it can be reviewed (D7). */
  preview?: boolean;
  /** The chosen route was quoted for other terms (slippage, an address) and its venue hasn't answered the new ones (D32). */
  held?: boolean;
  /** A route's display name (routeName: "Circle CCTP · Fast", D47). */
  providerName(p: string, routeId?: string): string;
}

/**
 * The CTA state machine: connect → amount → address → balance → routes →
 * review. Pressable for "connect" (opens the wallet menu) and a chosen route
 * of a LIVE list ("Review via {Provider}", or "Get deposit address" for a QR
 * payer); a preview list never yields "review", whatever is chosen in it, and
 * neither does a held route (D32): "Updating quote…" until its venue answers
 * for the terms on screen, or — the round over without that answer (it
 * failed) — "Couldn't update quote — try again", which only re-quotes.
 */
export function ctaState(x: CtaInput): CtaState {
  const m = x.missing;
  if (m?.kind === "tokens") return {label: m.loading ? "Loading your tokens…" : "Select a token", enabled: false, action: "none", state: "tokens"};
  if (m?.kind === "connect") return {label: `Connect ${FAMILY_LABEL[m.family]} wallet to swap`, enabled: true, action: "connect", family: m.family, state: "connect"};
  if (m?.kind === "amount") return {label: "Enter an amount", enabled: false, action: "none", state: "amount"};
  if (m?.kind === "refund") return {label: `Enter the ${m.chainName} refund address to swap`, enabled: false, action: "none", state: "address"};
  if (m?.kind === "recipient") return {label: `Enter the ${m.chainName} address to swap`, enabled: false, action: "none", state: "address"};
  if (x.balanceProblem && x.from) return {label: `Insufficient ${x.from.symbol} balance`, enabled: false, action: "none", state: "balance"};
  // A live request whose list still shows preview prices (the moment between the two): wait for the live round.
  if (x.preview) return {label: "Getting your quote…", enabled: false, action: "none", state: "finding"};
  if (!x.chosen)
    return x.routesLoading
      ? {label: "Finding routes…", enabled: false, action: "none", state: "finding"}
      : x.unreachable
        ? {label: "Can't reach the venues", enabled: false, action: "none", state: "unreachable"}
        : {label: "No route for this amount", enabled: false, action: "none", state: "no-route"};
  if (x.held)
    return x.routesLoading
      ? {label: "Updating quote…", enabled: false, action: "none", state: "updating"}
      : {label: "Couldn't update quote — try again", enabled: true, action: "refresh", state: "retry"};
  if (x.from?.payMode === "deposit") return {label: "Get deposit address", enabled: true, action: "review", state: "deposit"};
  return {label: `Review via ${x.providerName(x.chosen.provider, x.chosen.routeId)}`, enabled: true, action: "review", state: "review"};
}

/** An enabled venue that isn't asked for this pair, with its scope in one line ("Same-network swaps only"). */
export interface NotForPair {
  provider: string;
  scope: string;
}

/** What the route list shows: selectable routes, venues still quoting, and the ones that sat out (with why). */
export interface RouteListModel {
  routes: WebRoute[];
  pending: string[];
  /** The venues that didn't quote ("Didn't quote", by section); never a `deferred` one. */
  refused: RouteRejection[];
  /** Venues a preview round left for the live quote (`deferred`, D7), each worded for what is missing: a quiet group. */
  deferred: RouteRejection[];
  /** That group's title (deferredCopy): "Quoted after you connect", "Quoted after you add the address". */
  deferredTitle: string;
  /** Routes that exist but a QR payer can't use (the status line says so when nothing else is left). */
  qrRefusedCount: number;
  /** Routes that exist but the connected wallet can't sign here (a TON wallet and a contract call), likewise. */
  walletRefusedCount: number;
  /** Enabled venues the round didn't ask (snapshot.venues − asked): the collapsed "Not for this pair" group. */
  notForPair: NotForPair[];
  /** "4 of 10 venues serve this pair", or null before a snapshot names the venues. */
  coverage: string | null;
  /** Routes on screen quoted for other terms, waiting for their venue's new answer (D32): dimmed (heldAs), never reviewed. By routeKey. */
  held: string[];
}

/**
 * The quiet group of venues a preview round left for the live quote (D7: LI.FI while cp0x's proxy doesn't carry it;
 * Fynd without its slot is asked by no round, so it is absent, not here) and the short line of each row, worded for
 * what is still missing — a wallet, the address to pay, a refund address. Nothing is wrong with them, so nothing
 * here reads like a refusal: the quote comes with the user's own address.
 */
export function deferredCopy(missing: Missing | null | undefined): {title: string; reason: string} {
  switch (missing?.kind) {
    case "recipient":
      return {title: "Quoted after you add the address", reason: "Paste the address to get this quote"};
    case "refund":
      return {title: "Quoted after you add the address", reason: "Enter the refund address to get this quote"};
    default:
      return {title: "Quoted after you connect", reason: "Connect a wallet to get this quote"};
  }
}

/** Why a QR (deposit-address) payer can't take a route (D20): a categorised refusal like a venue's own, or null. */
export function qrRefusal(route: WebRoute, payChainName: string): RouteRejection | null {
  if (route.execution === "calldata")
    return {
      provider: route.provider,
      reason: `Needs a wallet that signs on ${payChainName}`,
      category: "setup",
      detail: `This route needs a wallet to sign on ${payChainName}; QR payments can only use routes paid to a deposit address.`,
      raw: "app: the route is a signed transaction (execution: calldata), and QR payers can only send to a deposit address",
    };
  if (route.hasMemo)
    return {
      provider: route.provider,
      reason: "Needs a memo — not for QR payments",
      category: "setup",
      detail: "This route identifies your payment by a memo many wallets can't add, so it isn't offered for QR payments.",
      raw: "app: the deposit needs a memo (hasMemo), which a QR payment can't carry",
    };
  return null;
}

/** Omniston's names for TON DEXes (its quote's route steps), as the route list words them. */
const TON_DEX_NAMES: Readonly<Record<string, string>> = {
  StonFiV1: "STON.fi v1",
  StonFiV2: "STON.fi v2",
  DeDust: "DeDust v1",
  DeDustCPMMV2: "DeDust CPMM v2",
  TonCoV2: "TONCO",
  SwapCoffee: "swap.coffee",
};

/**
 * Why a TON wallet can't take Omniston's swap on TON (D35 part C): a pair other than TON ↔ USDT (`signed` false), or a
 * quote whose route isn't one step through a DEX the gate pins — by the quote's own label, which only ever refuses here
 * (a STON.fi v2 quote through another router than the pinned one is refused by the gate, at Confirm).
 */
function tonSwapRefusal(route: WebRoute, signed: boolean): RouteRejection | null {
  if (!signed)
    return {
      provider: route.provider,
      reason: "Only TON ↔ USDT swaps are signed here",
      category: "setup",
      detail: "From a TON wallet this app signs Omniston's swaps on TON only between TON and USDT, through a DEX contract it pins; other tokens aren't checked yet.",
      raw: "app: an Omniston swap on TON between other tokens than TON and USDT, for which the app pins no DEX wallets",
    };
  const steps = route.tonSwapSteps ?? [];
  if (omnistonSwapRouteSigned(steps)) return null;
  const how = steps.length > 1 ? "in several hops" : steps.length === 1 ? `through ${TON_DEX_NAMES[steps[0]!] ?? "a DEX this app doesn't know"}` : "by a route its quote doesn't name";
  return {
    provider: route.provider,
    reason: "Routed through a DEX that isn't pinned here",
    category: "setup",
    detail: `Omniston routes this swap ${how}. A TON wallet here signs a TON ↔ USDT swap only in one step through a DEX contract this app pins: STON.fi v1, STON.fi v2's TON/USDT router or DeDust v1.`,
    raw: `app: Omniston's route (${steps.join("+").slice(0, 120) || "none"}) isn't one step through StonFiV1, StonFiV2 or DeDust, the DEXes whose contracts the app pins for TON ↔ USDT`,
  };
}

/**
 * Why a TON wallet payer can't take a route: the wallet here signs deposits (TON, jettons) and the contract calls
 * execute checks byte for byte (D35, `tonCallSigned`: Symbiosis paid in USDT for a token it releases directly on an
 * EVM network, Omniston's escrow paid in USDT for a token on an EVM network, Omniston's swap between TON and USDT in
 * one step through a DEX it pins), not other contract calls — Omniston's other TON swaps (other tokens, other DEXes,
 * several hops), either venue's cross-chain call from native TON or another jetton, Symbiosis to another destination
 * (Tron, a token it swaps to on arrival) — which are listed as refused, never offered. Without the token to receive
 * (`to`) no call is offered.
 */
export function tonWalletRefusal(route: WebRoute, from: Pick<SwapToken, "contract">, to: Pick<SwapToken, "caip2" | "contract"> | undefined): RouteRejection | null {
  if (route.execution !== "calldata") return null;
  const signed = !!to && tonCallSigned(route.provider, from.contract, to.caip2, to.contract);
  if (route.provider === "omniston" && to?.caip2 === "ton:-239") return tonSwapRefusal(route, signed);
  if (signed) return null;
  return {
    provider: route.provider,
    reason: "TON contract calls aren't signed here yet",
    category: "setup",
    detail: "This route pays through a TON contract call, which a TON wallet can't sign in this app yet; routes paid to a deposit address work.",
    raw: "app: the route is a TON contract call (execution: calldata) the app has no byte-exact check for; a TON wallet here signs deposits and checked calls only",
  };
}

/** "4 of 10 venues serve this pair" from the snapshot's venues and the ones asked; null while venues are unknown. */
export function coverageLine(snapshot: Pick<RouteSnapshot, "asked" | "venues"> | null): string | null {
  const total = snapshot?.venues.length ?? 0;
  if (!snapshot || !total) return null;
  const n = snapshot.asked.length;
  if (n === total) return `All ${total} venues serve this pair`;
  return `${n} of ${total} venues ${n === 1 ? "serves" : "serve"} this pair`;
}

/**
 * Split the snapshot for the payer: a deposit-only payer (BTC, ZEC…) can only
 * take `execution === "deposit" && !hasMemo` routes, a TON wallet deposit
 * routes (a memo rides as the comment) and the contract calls execute checks
 * (tonWalletRefusal); the rest are listed as refused with the
 * reason, never offered. `to` names the scope of each enabled venue that wasn't
 * asked; `missing` words the venues a preview left for the live quote
 * (deferredCopy), which never count as refused; `held` the routes quoted for
 * other terms (D32).
 */
export function routeListModel(
  snapshot: RouteSnapshot | null,
  from: SwapToken | undefined,
  to?: SwapToken,
  missing?: Missing | null,
  held: readonly string[] = [],
): RouteListModel {
  const copy = deferredCopy(missing);
  if (!snapshot)
    return {routes: [], pending: [], refused: [], deferred: [], deferredTitle: copy.title, qrRefusedCount: 0, walletRefusedCount: 0, notForPair: [], coverage: null, held: []};
  const asked = new Set(snapshot.asked);
  const notForPair = from && to ? snapshot.venues.filter((v) => !asked.has(v)).map((provider) => ({provider, scope: venueScope(provider, from, to)})) : [];
  const coverage = coverageLine(snapshot);
  const rejections = snapshot.rejections.filter((x) => x.category !== "deferred");
  const deferred = snapshot.rejections.filter((x) => x.category === "deferred").map((x) => ({...x, reason: copy.reason}));
  const heldOf = (routes: readonly WebRoute[]) => routes.map(routeKey).filter((k) => held.includes(k));
  const lists = {pending: snapshot.pending, deferred, deferredTitle: copy.title, notForPair, coverage};
  const tonWallet = from?.payMode === "wallet" && from.family === "ton";
  if (from?.payMode !== "deposit" && !tonWallet)
    return {...lists, routes: snapshot.routes, refused: rejections, qrRefusedCount: 0, walletRefusedCount: 0, held: heldOf(snapshot.routes)};
  const routes: WebRoute[] = [];
  const payer: RouteRejection[] = [];
  for (const r of snapshot.routes) {
    const why = tonWallet ? tonWalletRefusal(r, from, to) : qrRefusal(r, from!.chainName);
    // One row per venue: its routes (D47) are refused for the same reason.
    if (why) {
      if (!payer.some((x) => x.provider === why.provider)) payer.push(why);
    } else routes.push(r);
  }
  return {
    ...lists,
    routes,
    refused: [...payer, ...rejections],
    qrRefusedCount: tonWallet ? 0 : payer.length,
    walletRefusedCount: tonWallet ? payer.length : 0,
    held: heldOf(routes),
  };
}

/**
 * How a held route reads (D32): "updating" while a round for the new terms runs (dimmed, a spinner, `aria-busy`);
 * "outdated" once no round runs and its venue never answered them — the round failed, or a preview waits for its
 * token: still dimmed and never reviewed, but nothing claims to be updating.
 */
export type Held = "updating" | "outdated";

/** A route's held state on screen (`key`: its routeKey): undefined when it was quoted for the request's own terms. */
export function heldAs(held: readonly string[], key: string | undefined, loading: boolean): Held | undefined {
  if (key === undefined || !held.includes(key)) return undefined;
  return loading ? "updating" : "outdated";
}

/** Venues still quoting that have no row yet: a venue re-quoted keeps its route or refusal row until it answers (D32). */
export function stillQuoting(m: Pick<RouteListModel, "pending" | "routes" | "refused" | "deferred">): string[] {
  return m.pending.filter((p) => ![...m.routes, ...m.refused, ...m.deferred].some((x) => x.provider === p));
}

/**
 * Nothing quoted and every venue that was sent a request failed in transport (offline, DNS, CORS, an extension
 * blocking them), or the browser says it is offline: the connection is the problem, not the pair or the amount. A
 * venue the round sat out itself (`skipped`: a back-off, the signer-only skip; a preview's `deferred` venues are not
 * in `refused` at all) answered nothing either way. Read by category and flag, so rewording a refusal can't silently
 * turn this off.
 */
export function venuesUnreachable(model: RouteListModel, loading: boolean, online = typeof navigator === "undefined" ? true : navigator.onLine !== false): boolean {
  if (loading || model.routes.length || model.qrRefusedCount || model.walletRefusedCount) return false;
  if (!online) return true;
  const sent = model.refused.filter((r) => !r.skipped);
  return sent.length > 0 && sent.every((r) => r.category === "unreachable");
}

/** The status line under "Routes" (mobile index.tsx L192-204, plus freshness). `error` paints it red. */
export function routesStatus(
  hasRequest: boolean,
  state: Pick<RoutesState, "loading" | "error" | "updatedAt" | "snapshot" | "limitedUntil">,
  model: RouteListModel,
  providerName: (p: string) => string,
  now: number,
  online?: boolean,
): {text: string; error: boolean} | null {
  if (!hasRequest) return null;
  if (state.loading && model.pending.length) return {text: `Asking ${model.pending.map(providerName).join(", ")}…`, error: false};
  if (state.loading) return {text: model.routes.length ? "Updating routes…" : "Finding routes…", error: false};
  // A preview round waiting for the tab's next preview token (D29); a list already shown keeps its own line, unless
  // its rows are held for that round (D32).
  if ((!state.snapshot || model.held.length) && state.limitedUntil > now)
    return {text: `Preview paused for ${Math.ceil((state.limitedUntil - now) / 1000)} s — too many price checks.`, error: false};
  if (state.error) return {text: `Couldn't quote: ${state.error}`, error: true};
  if (model.routes.length) {
    const fresh = state.updatedAt > 0 ? ` · updated ${agoLabel(now - state.updatedAt)}` : "";
    return {text: `${plural(model.routes.length, "route")}${fresh}`, error: false};
  }
  if (model.qrRefusedCount) return {text: "No route takes a QR payment for this pair right now.", error: false};
  if (model.walletRefusedCount) return {text: "No route your wallet can sign for this pair yet.", error: false};
  if (venuesUnreachable(model, state.loading, online)) return {text: "Couldn't reach any venue — check your connection and refresh.", error: true};
  if (state.snapshot && !state.snapshot.asked.length) return {text: "No venue swaps this pair yet.", error: false};
  return {text: "No route for this pair and amount right now.", error: false};
}

/** The list a request's routes belong to: mode, pair and amount. Rows carry over a new round only within one list. */
export function listKey(r: RoutesRequest): string {
  return [r.mode, r.req.from.key, r.req.to.key, r.req.amountIn.toString()].join("|");
}

/**
 * The route list as the screen shows it (D32, owner 2026-11-13: a slippage change must not rebuild the screen).
 * Folded from the port's state render by render: within one list (same mode, pair and amount) a round over rows
 * already on screen — new terms, or any round after the list's first finished — never clears them: each venue keeps
 * its row, its place and its last route until it answers, an answer replaces the route in place, and only the
 * finished round re-ranks the list. A new pair, amount or mode (D7: a preview list never turns into a live one), and
 * the first round of a list, show exactly what the port says.
 */
export interface ShownList {
  /** listKey of the request this list is shown for. */
  list: string;
  snapshot: RouteSnapshot | null;
  /** A route on screen (routeKey) → the routesKey it was quoted for; any other than the request's own is held. */
  quotedFor: Readonly<Record<string, string>>;
  /** When the list last finished a round (the port's, or the one before a new round started). */
  updatedAt: number;
  /** The rows are established (a round finished, or new terms came over them): the next rounds merge into them. */
  stable: boolean;
  /** The port state this was folded from: the same state folds to the same object. */
  source: {key: string; snapshot: RouteSnapshot | null; loading: boolean; error: string | null; updatedAt: number};
}

/**
 * One fold step. The port's snapshot always belongs to the request it is given (a new key starts empty), so a route
 * taken from it is quoted for `routesKey(r)`; a route kept from before keeps the key it was quoted for. Returns `prev`
 * itself when nothing changed, so a render can fold without looping.
 */
export function foldShownList(prev: ShownList | null, r: RoutesRequest, state: Pick<RoutesState, "snapshot" | "loading" | "error" | "updatedAt">): ShownList {
  const key = routesKey(r);
  const list = listKey(r);
  const src = prev?.source;
  if (prev && prev.list === list && src && src.key === key && src.snapshot === state.snapshot && src.loading === state.loading && src.error === state.error && src.updatedAt === state.updatedAt)
    return prev;
  const source = {key, snapshot: state.snapshot, loading: state.loading, error: state.error, updatedAt: state.updatedAt};
  const finished = !!state.snapshot && !state.loading && !state.error;
  const own = (stable: boolean): ShownList => ({
    list,
    snapshot: state.snapshot,
    quotedFor: Object.fromEntries((state.snapshot?.routes ?? []).map((x) => [routeKey(x), key])),
    updatedAt: state.updatedAt,
    stable,
    source,
  });
  // Another list, nothing shown yet, or a round that finished: the port's list as ranked.
  if (!prev || prev.list !== list || !prev.snapshot || finished) return own(finished);
  // New terms over the rows on screen, or a round after the list's first: the rows stay. The list's first round
  // itself streams as the port ranks it.
  const stable = prev.stable || prev.source.key !== key;
  if (!stable) return own(false);
  // Nothing of the new round yet (its debounce, a preview waiting for a token): the rows on screen stay as they are.
  if (!state.snapshot) return {...prev, stable, source};
  // The round streams (or failed part-way): merge it into the rows on screen.
  const shown = prev.snapshot;
  const next = state.snapshot;
  // By route (routeKey): a venue with several routes (D47: CCTP's Fast and Standard) answers for all of them at once.
  const answered = new Map(next.routes.map((x) => [routeKey(x), x]));
  const answeredBy = new Set(next.routes.map((x) => x.provider));
  const waiting = new Set(next.pending);
  const routes: WebRoute[] = [];
  const quotedFor = new Map<string, string>();
  for (const old of shown.routes) {
    const k = routeKey(old);
    const fresh = answered.get(k);
    // Best / Fastest stay where they were until the round is done: a partial auction's tags would move them twice.
    if (fresh) {
      routes.push({...fresh, tags: old.tags});
      quotedFor.set(k, key);
    } else if (waiting.has(old.provider)) {
      routes.push(old);
      quotedFor.set(k, Object.hasOwn(prev.quotedFor, k) ? prev.quotedFor[k]! : "");
    }
    // else: the venue answered the new round with a refusal (listed below), without this route, or isn't asked any more.
  }
  for (const x of next.routes)
    if (!quotedFor.has(routeKey(x))) {
      routes.push({...x, tags: []});
      quotedFor.set(routeKey(x), key);
    }
  // Refusal rows keep the order on screen until the round is done, like the routes: a venue that refuses again keeps
  // its place with the new reason, one still asked keeps its row, one that quotes now (or isn't asked) leaves, and a
  // venue new to the refusals comes last. Answer order alone would move rows whose venues haven't answered yet.
  const refusedNow = new Set(next.rejections.map((x) => x.provider));
  const order = new Set([...shown.rejections.map((x) => x.provider), ...refusedNow]);
  const rejections = [...order].flatMap((p) =>
    refusedNow.has(p)
      ? next.rejections.filter((x) => x.provider === p)
      : waiting.has(p) && !answeredBy.has(p)
        ? shown.rejections.filter((x) => x.provider === p)
        : [],
  );
  return {list, snapshot: {...next, routes, rejections}, quotedFor: Object.fromEntries(quotedFor), updatedAt: state.updatedAt || prev.updatedAt, stable, source};
}

/** The routes on screen quoted for other terms than the request's (`key` = its routesKey, D32): dimmed, never reviewed. */
export function heldRoutes(shown: ShownList | null, key: string | null): string[] {
  if (!shown?.snapshot || key === null) return [];
  return shown.snapshot.routes.map(routeKey).filter((k) => !Object.hasOwn(shown.quotedFor, k) || shown.quotedFor[k] !== key);
}
