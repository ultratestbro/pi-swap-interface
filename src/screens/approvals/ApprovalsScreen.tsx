/**
 * The Revoke section (D46, `#/revoke`, `#/revoke?address=0x…`; `#/approvals` too): what an EVM address lets others spend, on
 * every network the page lists, most at risk first, and a revoke from the connected wallet. Any address can be
 * checked without a wallet (read-only); only the wallet that gave an approval can revoke it.
 *
 * The page frame is the swap screen's (AppShell with the wallets, activity and settings sheets); the scan is
 * approvalsPort's, the revoke execute's — this screen holds neither a network client nor a wallet.
 */
import {useMemo, useState} from "react";
import type {ApprovalRow, ChainScan} from "../../contracts/approvals";
import type {WalletFamily} from "../../contracts/wallets";
import {atRiskUnits, evmOwner, scannedOn, sortRows, usdAtRisk} from "../../approvals";
import {addressUrl, chainByCaip2Web, formatAmount, formatUsd, shortAddress} from "../../catalog";
import {isDemo, setHashQuery, useHashRoute, usePorts} from "../../config";
import {swapErrorText} from "../../execute";
import {Button, ChainLogo, CopyButton, Spinner, Tag, TokenIcon, showToast} from "../../ui";
import {ActivityDrawer} from "../activity/ActivityDrawer";
import {SettingsSheet} from "../settings/SettingsSheet";
import {AppShell} from "../shell/AppShell";
import {ConnectSheet} from "../wallets/ConnectSheet";
import s from "./Approvals.module.css";

const NFT_LABEL: Readonly<Record<string, string>> = {erc721: "Every NFT of", "erc721-token": "One NFT of", erc1155: "Every token of"};

/** What the approval is on: the token, an NFT collection (its name, else its address), or the account itself. */
function subjectText(r: ApprovalRow): string {
  const a = r.approval;
  if (a.standard === "eip7702") return "Account delegation";
  const nft = NFT_LABEL[a.standard];
  if (nft) return `${nft} ${r.collection ?? shortAddress(a.token)}${a.tokenId !== undefined && a.standard === "erc721-token" ? ` #${a.tokenId}` : ""}`;
  return r.token?.symbol ?? shortAddress(a.token);
}

/** How much of it, for a capped ERC-20 / Permit2 allowance ("up to 0.5 WETH"); null otherwise (the tag says Unlimited). */
function capText(r: ApprovalRow): string | null {
  const a = r.approval;
  if (a.unlimited || a.amount === null || a.standard === "eip7702" || NFT_LABEL[a.standard]) return null;
  return r.token ? `up to ${formatAmount(a.amount.toString(), r.token.decimals)} ${r.token.symbol}` : `up to ${a.amount.toString()} units`;
}

const chainSlug = (r: ApprovalRow) => r.token?.chain ?? chainByCaip2Web(r.caip2)?.slug ?? "";

export function ApprovalsScreen() {
  const ports = usePorts();
  const demo = isDemo();
  const wallets = ports.wallets.useWallets();
  const activity = ports.activity.useActivity();
  const hash = useHashRoute();

  // The address field: empty = the connected EVM wallet; anything else is checked as given (read-only).
  const [text, setText] = useState(() => hash.query.get("address") ?? "");
  const connected = wallets.evm?.address ?? null;
  const typed = evmOwner(text);
  const owner = text.trim() ? typed : connected;
  const badText = !!text.trim() && !typed;
  const scan = ports.approvals.useApprovals(owner);
  const canRevoke = !!owner && !!connected && owner.toLowerCase() === connected.toLowerCase();

  const rows = useMemo(() => sortRows(scan.rows, scan.prices), [scan.rows, scan.prices]);
  const total = useMemo(() => rows.reduce((sum, r) => sum + (usdAtRisk(r, scan.prices) ?? 0), 0), [rows, scan.prices]);
  const done = scan.chains.filter((c) => c.status === "done").length;
  const checking = scan.chains.filter((c) => c.status === "queued" || c.status === "scanning").length;
  const notChecked = scan.chains.filter((c) => c.status === "unsupported" || c.status === "failed");

  const [busy, setBusy] = useState<string | null>(null);
  const [connect, setConnect] = useState<{open: boolean; focus: WalletFamily | null}>({open: false, focus: null});
  const [activityOpen, setActivityOpen] = useState(false);
  const [statusId, setStatusId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  function setAddress(v: string) {
    setText(v);
    setHashQuery({address: v.trim() || null}, {replace: true});
  }

  async function revoke(r: ApprovalRow) {
    if (!owner || busy) return;
    setBusy(r.approval.id);
    try {
      const signer = await ports.wallets.getSigner(r.caip2);
      await ports.execute.revoke({owner, approval: r.approval, scanned: scannedOn(scan.rows, r.caip2)}, signer);
      showToast(`Revoked on ${r.chainName}`, {tone: "green"});
      scan.rescanChain(r.caip2);
    } catch (e) {
      showToast(swapErrorText(e, "ETH").replace(/to swap\.$/, "to revoke."), {tone: "red", ms: 5000});
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell
      wallets={wallets}
      activity={activity}
      demo={demo}
      section="approvals"
      onWallets={() => setConnect({open: true, focus: null})}
      onActivity={() => setActivityOpen(true)}
      onSettings={() => setSettingsOpen(true)}
    >
      <div className={s.page} data-testid="approvals">
        <header className={s.intro}>
          <h1 className={s.title}>Token approvals</h1>
          <p className={s.lead}>Apps you swapped or bridged through may still be allowed to spend your tokens. Check what&apos;s left and revoke what you no longer use.</p>
        </header>

        <div className={s.addressRow}>
          <input
            className={s.address}
            value={text}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={connected ? `${shortAddress(connected)} · or paste an address` : "Paste an EVM address"}
            spellCheck={false}
            autoComplete="off"
            aria-label="Address to check"
            aria-invalid={badText || undefined}
            data-testid="approvals-address"
          />
          {text.trim() && connected ? <Button title="My wallet" kind="secondary" height={48} onClick={() => setAddress("")} /> : null}
          {!connected && !text.trim() ? <Button title="Connect wallet" kind="primary" height={48} onClick={() => setConnect({open: true, focus: "evm"})} /> : null}
        </div>
        {badText ? <p className={s.error}>That isn&apos;t an EVM address.</p> : null}

        {owner ? (
          <>
            <div className={s.summary} data-testid="approvals-summary">
              <div className={s.summaryMain}>
                <span className={s.big}>{rows.length}</span>
                <span className={s.summaryText}>
                  {rows.length === 1 ? "approval" : "approvals"} found{total > 0 ? <> · <b className={s.atRisk}>{formatUsd(total)}</b> could be spent</> : null}
                </span>
              </div>
              <div className={s.summarySide}>
                {checking ? (
                  <span className={s.progress}>
                    <Spinner size={14} /> Checking {done} of {done + checking} networks…
                  </span>
                ) : (
                  <Button title="Scan again" kind="ghost" height={40} onClick={() => scan.rescan(false)} />
                )}
              </div>
            </div>
            {!canRevoke && rows.length ? (
              <p className={s.note}>
                Read-only: to revoke, connect the wallet {shortAddress(owner)}.
                {!connected ? null : ` The connected one is ${shortAddress(connected)}.`}
              </p>
            ) : null}

            <ul className={s.list} data-testid="approvals-list">
              {rows.map((r) => (
                <ApprovalItem key={r.approval.id} row={r} prices={scan.prices} logos={scan.logos} canRevoke={canRevoke} busy={busy} onRevoke={() => void revoke(r)} />
              ))}
            </ul>
            {!checking && !rows.length ? <p className={s.empty}>No approvals left on the networks checked. Nothing to revoke.</p> : null}
            {notChecked.length ? <NotChecked chains={notChecked} /> : null}
          </>
        ) : null}
      </div>

      <ActivityDrawer
        open={activityOpen || !!statusId}
        statusId={statusId}
        wallets={wallets}
        onOpenStatus={setStatusId}
        onBack={() => setStatusId(null)}
        onClose={() => {
          setActivityOpen(false);
          setStatusId(null);
        }}
        onTryAgain={() => {
          location.hash = "#/";
        }}
        onConnect={(family) => setConnect({open: true, focus: family})}
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

function ApprovalItem({
  row,
  prices,
  logos,
  canRevoke,
  busy,
  onRevoke,
}: {
  row: ApprovalRow;
  prices: Readonly<Record<string, number>>;
  logos: Readonly<Record<string, string>>;
  canRevoke: boolean;
  busy: string | null;
  onRevoke(): void;
}) {
  const a = row.approval;
  const eoa = a.risks.includes("eoa-spender");
  const spenderUrl = addressUrl(row.caip2, a.spender);
  const token = row.token ? {...row.token, ...(logos[row.token.key] ? {logo: logos[row.token.key]} : {})} : null;
  return (
    <li className={s.item} data-testid="approval-row">
      <div className={s.asset}>
        {token ? <TokenIcon token={token} size={40} /> : <ChainLogo slug={chainSlug(row)} size={40} label={row.chainName} />}
      </div>
      <div className={s.body}>
        <div className={s.line}>
          <span className={s.what}>{subjectText(row)}</span>
          {a.unlimited && a.standard !== "eip7702" ? <Tag tone="amber">Unlimited</Tag> : null}
          {capText(row) ? <span className={s.cap}>{capText(row)}</span> : null}
        </div>
        <div className={s.sub}>
          <span className={s.chain}>{row.chainName}</span>
          <span aria-hidden="true">·</span>
          <span className={s.spender}>
            to{" "}
            {spenderUrl ? (
              <a href={spenderUrl} target="_blank" rel="noreferrer noopener">
                {row.spenderName ?? shortAddress(a.spender)}
              </a>
            ) : (
              (row.spenderName ?? shortAddress(a.spender))
            )}
          </span>
          <CopyButton value={a.spender} aria-label="Copy the spender's address" size={26} />
          {row.verified ? <Tag tone="green" title="A contract cp0x Swap itself checks and uses">Verified by cp0x</Tag> : null}
          {eoa ? <Tag tone="red" title="The spender is a plain address, not a contract: an approval to one is rarely intended">Wallet address</Tag> : null}
        </div>
      </div>
      <div className={s.side}>
        <AtRisk row={row} prices={prices} />
        {a.standard === "eip7702" ? (
          <span className={s.hint}>Remove it in your wallet&apos;s settings</span>
        ) : canRevoke ? (
          <Button title="Revoke" kind="secondary" height={40} loading={busy === a.id} disabled={!!busy && busy !== a.id} onClick={onRevoke} data-testid="approval-revoke" />
        ) : null}
      </div>
    </li>
  );
}

/**
 * What the spender could take now: in USD at the token's price, else in the token; "None in wallet" when the owner
 * holds none of it (the allowance stays: anything received later is spendable). Nothing for NFTs, a delegation or a
 * balance that couldn't be read.
 */
function AtRisk({row, prices}: {row: ApprovalRow; prices: Readonly<Record<string, number>>}) {
  if (!row.token || row.balance === null) return null;
  if (row.balance === 0n)
    return (
      <span className={s.usdNone} title="You hold none of it now — but the approval still lets the spender take any you receive later.">
        None in wallet
      </span>
    );
  const usd = usdAtRisk(row, prices);
  if (usd !== null && usd > 0) return <span className={s.usd}>{formatUsd(usd)}</span>;
  const units = atRiskUnits(row);
  return units ? <span className={s.usd}>{`${formatAmount(units.toString(), row.token.decimals)} ${row.token.symbol}`}</span> : null;
}

const STANDARD_ONLY = "Checked in Standard mode only";

function NotChecked({chains}: {chains: readonly ChainScan[]}) {
  const names = (list: readonly ChainScan[]) => list.map((c) => c.name).join(", ");
  const limited = chains.filter((c) => c.status === "failed" && c.note?.startsWith("Etherscan's free limit"));
  const failed = chains.filter((c) => c.status === "failed" && !limited.includes(c));
  const standardOnly = chains.filter((c) => c.status === "unsupported" && c.note === STANDARD_ONLY);
  const none = chains.filter((c) => c.status === "unsupported" && c.note !== STANDARD_ONLY);
  return (
    <div className={s.notChecked} data-testid="approvals-not-checked">
      {failed.length ? <p>Couldn&apos;t read {names(failed)} — scan again in a moment.</p> : null}
      {limited.length ? <p>Etherscan&apos;s free limit is spent for today on {names(limited)} — it resets at 00:00 UTC.</p> : null}
      {standardOnly.length ? <p>Checked in Standard mode only: {names(standardOnly)}.</p> : null}
      {none.length ? <p>Not checked yet (no free history source): {names(none)}.</p> : null}
    </div>
  );
}
