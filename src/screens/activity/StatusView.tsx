/**
 * One swap from Confirm to delivery (mobile app/swap/status.tsx, ui-port.md
 * §5.10): its steps while the runner sends it and the tracker follows it, its
 * transactions with explorer links, a QR deposit's address while it waits,
 * and — for two-phase routes (CCTP) — the claim on the destination chain,
 * shown (contract, recipient, who pays gas) before the wallet is asked.
 */
import {useState} from "react";
import type {SwapRecord} from "../../contracts/activity";
import type {ClaimPreview} from "../../contracts/execution";
import type {ReviewRow} from "../../contracts/ui";
import type {WalletFamily, WalletsApi} from "../../contracts/wallets";
import {usePorts} from "../../config";
import {chainByCaip2Web, formatAmount, shortAddress, txUrl} from "../../catalog";
import {routeName} from "../../swap";
import {isFinal, isLocalId, isUntrackedMaybeSent, statusView, swapSteps} from "../../activity";
import {swapErrorText} from "../../execute";
import {Button, LinkButton, ProviderLogo, SheetHeader, SwapSteps, Tag, Text, TxReviewCard} from "../../ui";
import {DepositDetails} from "../review/DepositPanel";
import {TONE_COLOR, walletFamilyOf} from "../labels";
import s from "./Activity.module.css";

/** What the running step waits on, under its label (mobile status.tsx activeDetail, web wording). */
export function activeDetail(r: SwapRecord): string | undefined {
  if (r.status === "submitting") {
    if (r.stage === "permit") return "Waiting for your wallet — a signature, nothing is sent";
    if (r.stage === "approving") return (r.approvals ?? 1) > 1 ? "Two approvals — waiting for the network" : "Waiting for the network to confirm it";
    if (r.stage === "requoting") return "The approval took a while — refreshing the quote";
    if (r.stage === "preflight") return "Checking the route";
    if (r.stage === "broadcast") return "Sending";
    return "Waiting for your wallet";
  }
  if (r.status === "action-required") return "Attested — claim it to finish";
  if (r.status === "pending") {
    if (r.mode === "deposit" && !r.sourceHash) return "Waiting for your deposit to arrive";
    if (r.maybeSent && isLocalId(r.id)) return r.sourceHash ? "Sent — follow it on the explorer" : "Only your wallet knows whether it went out";
    return r.maybeSent ? "Checking whether it reached the network" : "On its way";
  }
  return undefined;
}

/** The address part of `evm:0xabc…` / `deposit:bc1…`. */
const payerOf = (accountId: string) => accountId.slice(accountId.indexOf(":") + 1);

export interface StatusViewProps {
  id: string;
  wallets: WalletsApi;
  onClose(): void;
  /** Back to the activity list (drawer only). */
  onBack?: () => void;
  /** "Try again": the form with the same pair and amount. */
  onTryAgain(r: SwapRecord): void;
  onConnect(family: WalletFamily): void;
}

export function StatusView({id, wallets, onClose, onBack, onTryAgain, onConnect}: StatusViewProps) {
  const ports = usePorts();
  const r = ports.activity.useSwap(id);
  const [busy, setBusy] = useState<"refresh" | "claim" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ClaimPreview | null>(null);

  if (!r) {
    return (
      <div className={s.status} data-testid="swap-status-missing">
        <SheetHeader title="Swap" onBack={onBack} onClose={onClose} />
        <Text as="p" variant="small" color="var(--muted)">
          This swap is no longer tracked in this browser.
        </Text>
      </div>
    );
  }

  const fromChain = chainByCaip2Web(r.fromChain);
  const toChain = chainByCaip2Web(r.toChain);
  const fromName = fromChain?.name ?? r.fromChain;
  const toName = toChain?.name ?? r.toChain;
  const view = statusView(r, toName);
  const steps = swapSteps(r, toName);
  const destHash = r.claimHash ?? r.destHash;
  const srcUrl = r.sourceHash ? txUrl(r.fromChain, r.sourceHash) : undefined;
  const destUrl = destHash ? txUrl(r.toChain, destHash) : undefined;
  const destLabel = r.claimHash ? "Claim tx" : "Delivery tx";
  const submitting = r.status === "submitting";
  const stopped = r.status === "not-sent";
  const toNative = toChain?.native.symbol ?? "the native coin";
  const waitingDeposit = r.mode === "deposit" && r.status === "pending" && !r.sourceHash && !!r.deposit;
  // Nothing polls a `local.` maybe-sent record: the viewer settles it after looking at the wallet (never a retry offer).
  const untracked = isUntrackedMaybeSent(r);

  // Who may claim: a connected wallet of the destination family that made the swap or receives it.
  const destFamily = toChain ? walletFamilyOf(toChain.family) : null;
  const conn = destFamily ? wallets[destFamily] : null;
  const same = (a: string, b: string) => (destFamily === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const owner = !!conn && (same(conn.address, payerOf(r.accountId)) || same(conn.address, r.recipient));

  async function refresh() {
    setBusy("refresh");
    await ports.activity.pollSwap(r!.id).catch(() => undefined);
    setBusy(null);
  }

  async function askClaim() {
    setError(null);
    setBusy("claim");
    try {
      // Read-only: what the claim will call, shown before the wallet is asked.
      const tx = await ports.execute.previewClaim(r!.trackId ?? r!.id);
      if (tx) setPreview(tx);
      else setError("The claim isn't ready yet — the attestation is still pending. Try again in a minute.");
    } catch (e) {
      setError(swapErrorText(e, toNative));
    } finally {
      setBusy(null);
    }
  }

  async function claim() {
    setError(null);
    setBusy("claim");
    try {
      const signer = await ports.wallets.getSigner(r!.toChain);
      await ports.execute.claimSwap(r!.trackId ?? r!.id, signer);
      setPreview(null);
    } catch (e) {
      setError(swapErrorText(e, toNative));
    } finally {
      setBusy(null);
    }
  }

  // The review's compact rows (D34): one line each, the network and the floor dim beside the amounts. A side imported by
  // its address (D39) carries an amber "Imported" tag and its contract under the amount, as the review showed it.
  const imported = (contract: string | undefined): Pick<ReviewRow, "badge" | "sub"> =>
    contract ? {badge: <Tag tone="amber">Imported</Tag>, sub: `Contract ${shortAddress(contract, 8, 6)}`} : {};
  const rows: ReviewRow[] = [
    {k: "Paid", v: `${formatAmount(r.amountIn, r.fromDecimals)} ${r.fromSymbol}`, note: `on ${fromName}`, testId: "swap-status-paid", ...imported(r.fromImportedContract)},
    {
      k: "Receive",
      v: `≈ ${formatAmount(r.expectedOut, r.toDecimals)} ${r.toSymbol}`,
      note: `≥ ${formatAmount(r.minOut, r.toDecimals)} on ${toName}`,
      testId: "swap-status-receive",
      ...imported(r.toImportedContract),
    },
    {k: "Route", v: routeName(r.provider, r.routeId), icon: <ProviderLogo provider={r.provider} size={18} />},
    {k: "To", v: shortAddress(r.recipient, 8, 6)},
    ...(r.sourceHash ? [{k: "Source tx", v: shortAddress(r.sourceHash, 8, 6), color: "var(--accent)"}] : []),
    ...(destHash ? [{k: destLabel, v: shortAddress(destHash, 8, 6), color: "var(--accent)"}] : []),
  ];
  const links = (srcUrl ? 1 : 0) + (destUrl ? 1 : 0);
  const refreshButton =
    !isFinal(r.status) && !submitting && !isLocalId(r.id) ? (
      <Button
        block
        kind="secondary"
        height={48}
        icon="refresh"
        iconPosition="left"
        title={busy === "refresh" ? "Refreshing…" : "Refresh status"}
        loading={busy === "refresh"}
        onClick={() => void refresh()}
        data-testid="swap-refresh-status"
      />
    ) : null;

  return (
    <div className={s.status} data-testid="swap-status-view">
      <SheetHeader title={`${r.fromSymbol} → ${r.toSymbol}`} sub={`${fromName} → ${toName}`} onBack={onBack} onClose={submitting ? undefined : onClose} />
      <Text variant="small" weight={600} color={TONE_COLOR[view.tone]} data-testid="swap-status" aria-live="polite">
        {view.label}
      </Text>
      <SwapSteps compact steps={steps} activeDetail={activeDetail(r)} />
      <Text as="p" variant="meta" color="var(--muted)" className={s.detail} data-testid="swap-status-detail">
        {view.detail}
      </Text>
      {waitingDeposit && r.deposit ? (
        <DepositDetails
          address={r.deposit.address}
          memo={r.deposit.memo}
          amount={BigInt(r.deposit.amount)}
          decimals={r.fromDecimals}
          symbol={r.fromSymbol}
          chainName={fromName}
          family={fromChain?.family}
          validUntilMs={r.deposit.validUntilMs}
        />
      ) : null}
      <TxReviewCard compact rows={rows} />
      {error ? (
        <Text as="p" variant="meta" color="var(--red)" selectable data-testid="swap-error">
          {error}
        </Text>
      ) : null}
      {preview && toChain ? (
        <div className={s.confirm} role="group" aria-label="Confirm the claim" data-testid="swap-claim-confirm">
          <Text variant="bodyStrong">{`Claim ${r.toSymbol} on ${toChain.name}`}</Text>
          <Text as="p" variant="small" color="var(--ink2)" selectable>
            {`Calls ${shortAddress(preview.to, 8, 6)} on ${toChain.name} to mint your ${r.toSymbol} to ${shortAddress(r.recipient, 8, 6)}. You pay the network fee in ${toNative}.`}
          </Text>
          <div className={s.confirmButtons}>
            <Button kind="secondary" title="Cancel" onClick={() => setPreview(null)} disabled={busy === "claim"} />
            <Button title="Claim" loading={busy === "claim"} onClick={() => void claim()} data-testid="swap-claim-confirm-button" />
          </div>
        </div>
      ) : null}
      <div className={s.actions}>
        {submitting ? <Button block title="Continue in background" onClick={onClose} data-testid="swap-background" /> : null}
        {stopped && r.fromKey && r.toKey ? <Button block title="Try again" onClick={() => onTryAgain(r)} data-testid="swap-try-again" /> : null}
        {r.status === "action-required" && owner && !preview ? (
          <Button block title={`Claim on ${toName}`} loading={busy === "claim"} onClick={() => void askClaim()} data-testid="swap-claim" />
        ) : null}
        {r.status === "action-required" && !owner ? (
          <>
            <Text as="p" variant="meta" color="var(--amber)">
              Connect the wallet that made this swap to claim it.
            </Text>
            {destFamily ? <Button block kind="secondary" title="Connect wallet" icon="wallet" iconPosition="left" onClick={() => onConnect(destFamily)} /> : null}
          </>
        ) : null}
        {untracked ? (
          <>
            <Text as="p" variant="meta" color="var(--muted)">
              {r.sourceHash
                ? "Only if the explorer shows the source transaction failed or was dropped:"
                : "Only if your wallet's activity shows no swap transaction:"}
            </Text>
            <Button block kind="secondary" height={48} title="Mark as not sent" onClick={() => ports.activity.markNotSent(r.id)} data-testid="swap-mark-not-sent" />
          </>
        ) : null}
        {/* The rest two to a row, so the view fits (D34): Refresh beside the one explorer link (a real link in the
            button's look), else beside Done; two links share a row; an odd one out — Done, mostly — spans it. */}
        {refreshButton || srcUrl || destUrl || !submitting ? (
          <div className={s.secondary}>
            {links < 2 ? refreshButton : null}
            {srcUrl ? <LinkButton block title="Source tx" href={srcUrl} aria-label="Source tx on the explorer" data-testid="swap-explorer-source" /> : null}
            {destUrl ? <LinkButton block title={destLabel} href={destUrl} aria-label={`${destLabel} on the explorer`} data-testid="swap-explorer-dest" /> : null}
            {links === 2 ? refreshButton : null}
            {!submitting ? <Button block kind="secondary" height={48} title={stopped ? "Close" : "Done"} onClick={onClose} data-testid="swap-done" /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
