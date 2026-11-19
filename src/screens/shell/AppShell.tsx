/**
 * The page frame (ui-port.md §5.1-5.2): the header — the cp0x logo and "Swap",
 * a DEMO tag in demo mode, the connected wallets (one dropdown, D33),
 * activity and settings — the main area, and a footer that says what this is:
 * open source, no cp0x fee, where prices come from.
 */
import type {ReactNode} from "react";
import type {ActivityItem, ActivityState} from "../../contracts/activity";
import type {WalletsApi} from "../../contracts/wallets";
import {Icon, IconButton, Tag} from "../../ui";
import {plural} from "../labels";
import {WalletsDropdown} from "./WalletsDropdown";
import s from "./Shell.module.css";

/** Where the source and the IPFS mirror live; empty until published (the footer then says "soon"). */
export const SOURCE_URL = "https://github.com/ultratestbro/pi-swap-interface";
export const IPFS_URL = "";

export interface AppShellProps {
  wallets: WalletsApi;
  activity: ActivityState;
  demo: boolean;
  onWallets(): void;
  onActivity(): void;
  onSettings(): void;
  /** The screen shown: its link in the header reads as the current one. Default "swap". */
  section?: "swap" | "approvals";
  children: ReactNode;
}

export function AppShell({wallets, activity, demo, onWallets, onActivity, onSettings, section = "swap", children}: AppShellProps) {
  return (
    <div className={section === "swap" ? `${s.shell} ${s.withRevoke}` : s.shell}>
      <header className={s.header}>
        <a className={s.brand} href="#/" aria-label="cp0x Swap, home">
          <img className={s.logo} src="logos/cp0x@2x.png" srcSet="logos/cp0x.png 1x, logos/cp0x@2x.png 2x, logos/cp0x@3x.png 3x" alt="cp0x" width={61} height={22} />
          <span className={s.product}>Swap</span>
        </a>
        {demo ? (
          <Tag tone="amber" title="Demo mode: made-up data, no wallets, no network">
            Demo
          </Tag>
        ) : null}
        <span className={s.spacer} />
        <div className={s.tools}>
          <WalletsDropdown wallets={wallets} onWallets={onWallets} />
          <ActivityButton badge={activity.badge} count={activity.visibleCount} onOpen={onActivity} />
          <IconButton icon="gear" aria-label="Settings" className={s.gear} onClick={onSettings} data-testid="swap-settings-open" />
        </div>
      </header>
      <main className={s.main}>{children}</main>
      {/* The Revoke section's button (D46, owner 2026-11-20): bottom right on every screen but its own, the header
          controls' look, its "0" the cp0x logo's. A phone: the page's bottom-right corner, under the CTA. */}
      {section === "swap" ? (
        <a className={s.revokeButton} href="#/revoke" aria-label="Revoke token approvals" data-testid="nav-approvals">
          Rev<span className={s.revokeZero}>0</span>ke
        </a>
      ) : null}
      <footer className={s.footer}>
        <FooterLine onSettings={onSettings} />
      </footer>
    </div>
  );
}

function FooterLine({onSettings}: {onSettings(): void}) {
  const version = import.meta.env.VITE_APP_VERSION;
  const sep = <span className={s.sep} aria-hidden="true">·</span>;
  return (
    <>
      <span>{SOURCE_URL ? <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">Open source</a> : "Open source"}</span>
      {sep}
      <span>No cp0x fee</span>
      {sep}
      <span>{IPFS_URL ? <a href={IPFS_URL} target="_blank" rel="noopener noreferrer">IPFS mirror</a> : "IPFS mirror soon"}</span>
      {sep}
      <span>Prices: DefiLlama · CoinGecko</span>
      {sep}
      <button type="button" className={s.footerButton} onClick={onSettings}>
        Settings
      </button>
      {sep}
      {/* dist/ carries the notices on every host (vite.config.ts licences()); relative, so it works under a sub-path */}
      <a href="THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener noreferrer">
        Licences
      </a>
      {version ? (
        <>
          {sep}
          <span>{`v${version}`}</span>
        </>
      ) : null}
    </>
  );
}

/** Ring geometry of the 40 px button: stroke 2.5, r = (40 − 2.5) / 2 − 2. */
const R = (40 - 2.5) / 2 - 2;
const C = 2 * Math.PI * R;
const RING: Record<ActivityItem["urgency"], {color: string; className?: string; dash?: string}> = {
  pending: {color: "var(--accent)", className: s.ringSpin, dash: `${C * 0.28} ${C}`},
  action: {color: "var(--amber)", className: s.ringPulse},
  done: {color: "var(--green)"},
  failed: {color: "var(--red)"},
};

/** The header's activity button: the most urgent swap's ring; how many are running or recent is in its label only (no count badge). */
export function ActivityButton({badge, count, onOpen}: {badge: ActivityItem | null; count: number; onOpen(): void}) {
  const ring = badge ? RING[badge.urgency] : null;
  const label = count ? `Activity, ${plural(count, "swap")} running or recent${badge ? `: ${badge.view.label}` : ""}` : "Activity";
  return (
    <button type="button" className={s.activity} onClick={onOpen} aria-label={label} data-testid="swap-activity-open" data-urgency={badge?.urgency}>
      {ring ? (
        <svg className={s.ring} viewBox="0 0 40 40" aria-hidden="true">
          <circle cx="20" cy="20" r={R} fill="none" stroke="var(--ring-track)" strokeWidth={2.5} />
          <circle
            cx="20"
            cy="20"
            r={R}
            fill="none"
            stroke={ring.color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={ring.dash}
            className={ring.className}
            transform={ring.dash ? undefined : "rotate(-90 20 20)"}
          />
        </svg>
      ) : null}
      <Icon name={badge ? "swap" : "activity"} size={18} />
    </button>
  );
}
