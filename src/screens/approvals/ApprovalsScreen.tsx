/**
 * The Revoke section (D46, `#/revoke`, `#/revoke?address=0x…`; `#/approvals` too): what an EVM address lets others
 * spend, on every network the page lists, as a table (owner 2026-11-20: like revoke.cash) — the asset and what the
 * owner holds of it, the kind, the approved amount, the value at risk, the spender, when it was last set — newest
 * first, searchable by spender, and revoked from the connected wallet one at a time (no batch yet: no selection).
 * Any address can be checked without a wallet (read-only); only the wallet that gave an approval can revoke it.
 *
 * The page frame is the swap screen's (AppShell with the wallets, activity and settings sheets); the scan is
 * approvalsPort's, the revoke execute's — this screen holds neither a network client nor a wallet.
 */
import {useMemo, useState} from "react";
import type {ApprovalRow, ChainScan} from "../../contracts/approvals";
import type {WalletFamily} from "../../contracts/wallets";
import {evmOwner, scannedOn, sortedRows, usdAtRisk, valueAtRisk, type ApprovalsSort} from "../../approvals";
import {addressUrl, chainByCaip2Web, formatAmount, formatUsd, shortAddress, txUrl} from "../../catalog";
import {isDemo, setHashQuery, useHashRoute, usePorts} from "../../config";
import {swapErrorText} from "../../execute";
import {Button, ChainLogo, CopyButton, Spinner, Tag, TokenIcon, showToast} from "../../ui";
import {ActivityDrawer} from "../activity/ActivityDrawer";
import {NetworkPicker} from "../settings/NetworkPicker";
import {SettingsSheet} from "../settings/SettingsSheet";
import {AppShell} from "../shell/AppShell";
import {ConnectSheet} from "../wallets/ConnectSheet";
import s from "./Approvals.module.css";

const fungible = (r: ApprovalRow): boolean => r.approval.standard === "erc20" || r.approval.standard === "permit2";
const chainSlug = (r: ApprovalRow) => r.token?.chain ?? chainByCaip2Web(r.caip2)?.slug ?? "";

/** The asset's name: the token's symbol, the collection's name (else its address), or the account for a delegation. */
function assetName(r: ApprovalRow): string {
  const a = r.approval;
  if (a.standard === "eip7702") return "Your account";
  if (fungible(r)) return r.token?.symbol ?? shortAddress(a.token);
  return `${r.collection ?? shortAddress(a.token)}${a.standard === "erc721-token" && a.tokenId !== undefined ? ` #${a.tokenId}` : ""}`;
}

/** What the owner holds of it: "0 WBTC ($0.00)", "3 NFTs"; null when unread. */
function holdingText(r: ApprovalRow, prices: Readonly<Record<string, number>>): string | null {
  if (fungible(r)) {
    if (r.balance === null || !r.token) return null;
    const price = prices[r.token.key];
    const units = r.balance === 0n ? "0" : formatAmount(r.balance.toString(), r.token.decimals);
    const usd = price !== undefined ? ` (${formatUsd((Number(r.balance) / 10 ** r.token.decimals) * price)})` : "";
    return `${units} ${r.token.symbol}${usd}`;
  }
  if (r.nftCount === null || r.nftCount === undefined) return null;
  return `${r.nftCount.toString()} NFT${r.nftCount === 1n ? "" : "s"}`;
}

const TYPE_LABEL: Readonly<Record<string, string>> = {erc20: "Token", permit2: "Permit2", erc721: "NFT", "erc721-token": "NFT", erc1155: "NFT", eip7702: "Delegation"};

/** How much it allows: "Unlimited", "< 0.001 WETH", "1 NFT" (one token's approval). */
function approvedText(r: ApprovalRow): string {
  const a = r.approval;
  if (a.standard === "eip7702") return "Everything";
  if (a.standard === "erc721-token") return "1 NFT";
  if (a.unlimited || a.amount === null) return "Unlimited";
  return r.token ? `${formatAmount(a.amount.toString(), r.token.decimals).replace(/^</, "< ")} ${r.token.symbol}` : `${a.amount.toString()} units`;
}

/** "$4.38", "< $0.01", "$0.00", "Unknown" (an NFT collection the owner holds some of), or "—". */
function riskText(r: ApprovalRow, prices: Readonly<Record<string, number>>): string {
  const v = valueAtRisk(r, prices);
  if (v === "unknown") return "Unknown";
  if (v === null) return "—";
  return v === 0 ? "$0.00" : formatUsd(v).replace(/^</, "< ");
}

/** "11/18/2026" over "01:41 PM" (the viewer's time zone). */
function When({ms}: {ms: number}) {
  const d = new Date(ms);
  return (
    <>
      <span>{d.toLocaleDateString("en-US", {year: "numeric", month: "2-digit", day: "2-digit"})}</span>
      <span className={s.time}>{d.toLocaleTimeString("en-US", {hour: "2-digit", minute: "2-digit"})}</span>
    </>
  );
}

/** The sort orders, in the app's own picker (the network picker's look; a native <select> opens the OS menu). */
const SORTS: readonly {value: ApprovalsSort; name: string}[] = [
  {value: "newest", name: "Last updated: newest first"},
  {value: "risk", name: "Value at risk: highest first"},
  {value: "amount", name: "Approved amount: largest first"},
];

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

  const [sort, setSort] = useState<ApprovalsSort>("newest");
  const [search, setSearch] = useState("");
  const all = useMemo(() => sortedRows(scan.rows, scan.prices, sort), [scan.rows, scan.prices, sort]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) => r.approval.spender.toLowerCase().includes(q) || (r.spenderName ?? "").toLowerCase().includes(q));
  }, [all, search]);
  const total = useMemo(() => all.reduce((sum, r) => sum + (usdAtRisk(r, scan.prices) ?? 0), 0), [all, scan.prices]);
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
                <span className={s.big}>{all.length}</span>
                <span className={s.summaryText}>
                  {all.length === 1 ? "approval" : "approvals"} found{total > 0 ? <> · <b className={s.atRisk}>{formatUsd(total)}</b> at risk</> : null}
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
            {!canRevoke && all.length ? (
              <p className={s.note}>
                Read-only: to revoke, connect the wallet {shortAddress(owner)}.
                {!connected ? null : ` The connected one is ${shortAddress(connected)}.`}
              </p>
            ) : null}

            {all.length ? (
              <div className={s.toolbar}>
                <input
                  className={s.search}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by spender"
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Search by spender"
                  data-testid="approvals-search"
                />
                <div className={s.sortBox}>
                  <NetworkPicker
                    networks={SORTS}
                    value={sort}
                    label="Sort approvals"
                    listLabel="Sort orders"
                    onChange={(v) => setSort(v as ApprovalsSort)}
                    searchable={false}
                    data-testid="approvals-sort"
                  />
                </div>
              </div>
            ) : null}

            {rows.length ? (
              <div className={s.table} role="table" aria-label="Token approvals" data-testid="approvals-list">
                <div className={`${s.row} ${s.head}`} role="row">
                  <span className={s.cAsset} role="columnheader">
                    Asset
                  </span>
                  <span className={s.cType} role="columnheader">
                    Type
                  </span>
                  <span className={s.cAmount} role="columnheader">
                    Approved amount
                  </span>
                  <span className={s.cRisk} role="columnheader">
                    Value at risk
                  </span>
                  <span className={s.cSpender} role="columnheader">
                    Approved spender
                  </span>
                  <span className={s.cWhen} role="columnheader">
                    Last updated
                  </span>
                  <span className={s.cAction} role="columnheader" />
                </div>
                {rows.map((r) => (
                  <ApprovalItem
                    key={r.approval.id}
                    row={r}
                    prices={scan.prices}
                    logos={scan.logos}
                    canRevoke={canRevoke}
                    busy={busy}
                    onRevoke={() => void revoke(r)}
                  />
                ))}
              </div>
            ) : null}
            {!checking && !all.length ? <p className={s.empty}>No approvals left on the networks checked. Nothing to revoke.</p> : null}
            {all.length && !rows.length ? <p className={s.empty}>No spender matches &ldquo;{search.trim()}&rdquo;.</p> : null}
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
  const holding = holdingText(row, prices);
  const risk = riskText(row, prices);
  const tx = a.grantedAt?.txHash ? txUrl(row.caip2, a.grantedAt.txHash) : undefined;
  return (
    <div className={s.row} role="row" data-testid="approval-row">
      <span className={s.cAsset} role="cell">
        <span className={s.assetIcon}>{token ? <TokenIcon token={token} size={36} /> : <ChainLogo slug={chainSlug(row)} size={36} label={row.chainName} />}</span>
        <span className={s.assetText}>
          <span className={s.assetName}>{assetName(row)}</span>
          {holding ? <span className={s.dimLine}>{holding}</span> : null}
        </span>
      </span>
      <span className={s.cType} role="cell">
        <span className={s.mLabel}>Type</span>
        <Tag tone="muted">{TYPE_LABEL[a.standard] ?? a.standard}</Tag>
        <span className={s.chainName}>{row.chainName}</span>
      </span>
      <span className={s.cAmount} role="cell">
        <span className={s.mLabel}>Approved</span>
        <span className={a.unlimited || a.standard === "eip7702" ? s.unlimited : s.amount}>{approvedText(row)}</span>
      </span>
      <span className={s.cRisk} role="cell">
        <span className={s.mLabel}>At risk</span>
        <span className={risk === "Unknown" || risk === "—" ? s.riskNone : s.risk}>{risk}</span>
      </span>
      <span className={s.cSpender} role="cell">
        <span className={s.spenderText}>
          <span className={s.spenderName}>
            {spenderUrl ? (
              <a href={spenderUrl} target="_blank" rel="noreferrer noopener">
                {row.spenderName ?? shortAddress(a.spender)}
              </a>
            ) : (
              (row.spenderName ?? shortAddress(a.spender))
            )}
            {row.verified ? <Tag tone="green" title="A contract cp0x Swap itself checks and uses">Verified</Tag> : null}
            {eoa ? <Tag tone="red" title="The spender is a plain address, not a contract: an approval to one is rarely intended">Wallet</Tag> : null}
          </span>
          {row.spenderName ? <span className={s.mono}>{shortAddress(a.spender)}</span> : null}
        </span>
        <CopyButton value={a.spender} aria-label="Copy the spender's address" size={26} />
      </span>
      <span className={s.cWhen} role="cell">
        <span className={s.mLabel}>Updated</span>
        {row.updatedAt ? (
          tx ? (
            <a className={s.when} href={tx} target="_blank" rel="noreferrer noopener" title="The transaction that set it">
              <When ms={row.updatedAt} />
            </a>
          ) : (
            <span className={s.when}>
              <When ms={row.updatedAt} />
            </span>
          )
        ) : (
          <span className={s.riskNone}>—</span>
        )}
      </span>
      <span className={s.cAction} role="cell">
        {a.standard === "eip7702" ? (
          <span className={s.hint}>Remove it in your wallet&apos;s settings</span>
        ) : canRevoke ? (
          <Button title="Revoke" kind="secondary" height={40} loading={busy === a.id} disabled={!!busy && busy !== a.id} onClick={onRevoke} data-testid="approval-revoke" />
        ) : null}
      </span>
    </div>
  );
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
