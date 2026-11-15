/**
 * The swap form's state (mobile app/swap/index.tsx L97-180, web addresses of
 * D7): the pair, the amount text, the picked route, the recipient and refund
 * fields and the slippage choice — plus everything derived from them, ending
 * in the live quote request, or what is still missing and the preview prices
 * that can be shown meanwhile (D7). Pair and amount mirror into the hash (D22)
 * on every user change, never addresses.
 */
import {useMemo, useState} from "react";
import type {Pair, SwapToken} from "../../contracts/domain";
import type {SwapTokensState} from "../../contracts/ports";
import {getRuntimeConfig, setHashQuery, usePorts} from "../../config";
import {chainBySlugWeb, checkRecipient, defaultPair, flipPair, pickSide} from "../../catalog";
import {
  DEFAULT_SLIPPAGE_BPS,
  autoSlippageBps,
  balanceProblem,
  canPreview,
  formatUnits,
  gasReserve,
  maxSwappable,
  trimNativeMax,
  parsePastedAmount,
  parseUnits,
  sanitizeAmountInput,
  swapRecipient,
} from "../../swap";
import {buildPreview, buildRequest, idleHint} from "./model";

/** Where the form starts: the hash (a shared pair, "Try again") or a demo scene. */
export interface FormPreset {
  pay?: string;
  receive?: string;
  amount: string;
  refund?: string;
}

const SHARED_FAMILIES = new Set(["evm", "solana", "ton", "tron", "btc", "near", "zcash"]);

/** The opening pair: the preset when both keys are known (pay side payable), else defaultPair over wallet tokens first. */
function openingPair(tokens: SwapTokensState, preset: FormPreset, payKeys: ReadonlySet<string>): Pair | null {
  const {byKey, pay, receive} = tokens;
  if (preset.pay && preset.receive && preset.pay !== preset.receive && payKeys.has(preset.pay) && byKey.has(preset.receive))
    return {pay: preset.pay, receive: preset.receive};
  const prefer = preset.pay && payKeys.has(preset.pay) ? preset.pay : undefined;
  const p = prefer
    ? defaultPair(pay, receive, prefer)
    : (defaultPair(
        pay.filter((t) => t.payMode === "wallet"),
        receive,
      ) ?? defaultPair(pay, receive));
  if (p && preset.receive && byKey.has(preset.receive) && preset.receive !== p.pay) return {pay: p.pay, receive: preset.receive};
  return p;
}

/**
 * The gas a MAX keeps back on a gas token (native, or Celo CELO / Arc USDC), 0 otherwise — in the TOKEN's own
 * units: Arc's gas token is listed by its 6-decimal ERC-20 face while the chain's native coin counts 18, and an
 * 18-decimal reserve on a 6-decimal balance would leave MAX at 0.
 */
export function reserveFor(t: Pick<SwapToken, "gasToken" | "chain" | "decimals">): bigint {
  if (!t.gasToken) return 0n;
  const chain = chainBySlugWeb(t.chain);
  if (!chain || !SHARED_FAMILIES.has(chain.family)) return 0n;
  return gasReserve(chain.family as Parameters<typeof gasReserve>[0], chain.native.symbol, t.decimals, chain.chainId);
}

/**
 * The form's state. `evmWalletChain` is the CAIP-2 of the chain the connected EVM wallet is on (null without one):
 * the default recipient is checked for contract code there as well as on the destination.
 */
export function useSwapForm(tokens: SwapTokensState, preset: FormPreset, hasWallet: boolean, evmWalletChain: string | null = null) {
  const ports = usePorts();
  const [picked, setPicked] = useState<Pair | null>(null);
  const [text, setText] = useState(preset.amount);
  const [selected, setSelected] = useState<string | null>(null);
  const [toOther, setToOtherState] = useState(false);
  const [recipientText, setRecipientTextState] = useState("");
  const [refundText, setRefundTextState] = useState(preset.refund ?? "");
  /** null = auto (per pair). */
  const [slippage, setSlippage] = useState<number | null>(null);
  /** Why the last paste was refused (the field kept its value); cleared by the next edit. */
  const [pasteNote, setPasteNote] = useState<string | null>(null);

  const payKeys = useMemo(() => new Set(tokens.pay.map((t) => t.key)), [tokens.pay]);
  const opening = useMemo(() => openingPair(tokens, preset, payKeys), [tokens, preset, payKeys]);
  // Mobile L109-111: once balances are in, a balance refresh must not swap the token under the user.
  if (!picked && opening && hasWallet && !tokens.loading) setPicked(opening);
  const pair = picked ?? opening;

  const from = pair ? tokens.byKey.get(pair.pay) : undefined;
  const to = pair ? tokens.byKey.get(pair.receive) : undefined;
  const amountIn = from ? parseUnits(text, from.decimals) : null;
  const autoBps = from && to ? autoSlippageBps(from.symbol, to.symbol, from.caip2 === to.caip2) : DEFAULT_SLIPPAGE_BPS;
  const slippageBps = slippage ?? autoBps;
  const balance = from && from.balance === "loaded" ? BigInt(from.amount) : null;
  const problem = balance !== null ? balanceProblem(amountIn, balance) : null;

  // D10 refuses EVM smart-contract accounts as payers, partly because the same address on another chain may not be
  // the user's. The paying wallet is checked when it signs; the connected EVM wallet as the DEFAULT recipient of
  // another payer (Solana, a QR deposit) is not, so it is checked here, on the destination and on the chain the
  // wallet is on (a Safe that isn't deployed on the destination has no code there).
  const foreignPayout = !!to && to.family === "evm" && !!to.owner && !(from?.family === "evm" && from.payMode === "wallet");
  const ownerToCheck = foreignPayout ? to.owner : null;
  const contractOnDest = ports.catalog.useIsContract(to?.caip2 ?? "", ownerToCheck);
  const contractAtHome = ports.catalog.useIsContract(evmWalletChain ?? "", evmWalletChain && evmWalletChain !== to?.caip2 ? ownerToCheck : null);
  const ownerIsContract = foreignPayout && (contractOnDest === true || contractAtHome === true);
  // No wallet of the receive family, or one that is a contract account → the field is the only address there is.
  const recipientForced = !!to && (to.owner === null || ownerIsContract);
  const recipientOn = toOther || recipientForced;
  const recipient = useMemo(() => (recipientOn && to ? swapRecipient(recipientText, to) : null), [recipientOn, to, recipientText]);
  const refund = useMemo(() => (from?.payMode === "deposit" ? checkRecipient(refundText, from.family) : null), [from, refundText]);

  // Previews are fixed per page (runtime config, D9): the operator's kill switch or the viewer's own "off".
  const previews = getRuntimeConfig().preview.enabled;
  const {req, missing, preview} = useMemo(() => {
    const fields = {from, to, amountIn, slippageBps, loadingTokens: tokens.loading, recipientOn, toOther, recipient, refund};
    const built = buildRequest(fields);
    return {...built, preview: buildPreview(fields, built.missing, previews)};
  }, [from, to, amountIn, slippageBps, tokens.loading, recipientOn, toOther, recipient, refund, previews]);
  // The idle line, only while nothing is quoted (neither live nor preview).
  const previewsNeedAmount = previews && !!from && !!to && canPreview(from.family, to.family) && !(amountIn !== null && amountIn > 0n);
  const hint = req || preview || !missing ? null : idleHint(missing, previewsNeedAmount);

  const mirror = (p: Pair | null, amount: string) =>
    setHashQuery(p ? {pay: p.pay, receive: p.receive, amount: amount || null} : {amount: amount || null});

  /** Set the pair; the pay side stays payable, the amount is re-cut to the new decimals, family-bound addresses reset. */
  function setPair(next: Pair) {
    const safe = payKeys.has(next.pay) ? next : pair ? {pay: pair.pay, receive: next.receive === pair.pay ? pair.receive : next.receive} : next;
    const nextFrom = tokens.byKey.get(safe.pay);
    const nextTo = tokens.byKey.get(safe.receive);
    let nextText = text;
    if (nextFrom && nextFrom.key !== from?.key) {
      nextText = sanitizeAmountInput(text, nextFrom.decimals);
      setText(nextText);
    }
    if (nextFrom?.family !== from?.family) setRefundTextState("");
    if (nextTo?.family !== to?.family) {
      setRecipientTextState("");
      setToOtherState(false);
    }
    setPicked(safe);
    setSelected(null);
    mirror(safe, nextText);
  }

  return {
    pair,
    from,
    to,
    text,
    amountIn,
    balance,
    problem,
    selected,
    setSelected,
    slippage,
    slippageBps,
    autoBps,
    setSlippage,
    toOther,
    recipientForced,
    /** The connected EVM wallet is a smart-contract account and someone else pays: it is never the default payout. */
    ownerIsContract,
    recipientOn,
    recipientText,
    recipient,
    refundText,
    refund,
    req,
    missing,
    /** Preview prices while an address is missing (never reviewable), or null. */
    preview,
    /** The route list's idle line, or null while something is quoted. */
    hint,
    payKeys,
    canFlip: !!to && payKeys.has(to.key),
    pasteNote,
    setAmount(raw: string) {
      const next = from ? sanitizeAmountInput(raw, from.decimals) : "";
      setPasteNote(null);
      // The first edit pins the pair: a balance read that lands later must not swap the token under a typed amount.
      if (!picked && pair) setPicked(pair);
      setText(next);
      mirror(pair, next);
    },
    /** A paste (the field's text with the clipboard spliced in): read as a copied number, or refused with a note. */
    pasteAmount(raw: string) {
      if (!from) return;
      const r = parsePastedAmount(raw, from.decimals);
      if (!r.ok) {
        setPasteNote(r.reason);
        return;
      }
      setPasteNote(null);
      if (!picked && pair) setPicked(pair);
      setText(r.text);
      mirror(pair, r.text);
    },
    max() {
      if (!from || balance === null) return;
      setPasteNote(null);
      if (!picked && pair) setPicked(pair);
      const max = maxSwappable(balance, from.gasToken, reserveFor(from));
      const next = formatUnits(from.gasToken ? trimNativeMax(max, from.decimals) : max, from.decimals);
      setText(next);
      mirror(pair, next);
    },
    pick(side: "pay" | "receive", key: string) {
      if (pair) setPair(pickSide(pair, side, key));
      else if (side === "pay") setPair({pay: key, receive: to?.key ?? key});
    },
    flip() {
      if (pair) setPair(flipPair(pair));
    },
    setPair,
    /** "Try again": reopen with a stored pair and amount. */
    restore(p: Pair, amount: string) {
      setPicked(p);
      setText(amount);
      setSelected(null);
      mirror(p, amount);
    },
    setToOther(on: boolean) {
      setToOtherState(on);
      setSelected(null);
    },
    setRecipientText(t: string) {
      setRecipientTextState(t.trim());
      setSelected(null);
    },
    setRefundText(t: string) {
      setRefundTextState(t.trim());
      setSelected(null);
    },
  };
}

/** Everything the form hook hands the screen. */
export type SwapForm = ReturnType<typeof useSwapForm>;
