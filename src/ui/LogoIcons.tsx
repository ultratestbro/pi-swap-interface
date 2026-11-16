/**
 * Token, network and venue logos from the bundled static files only
 * (logos.ts, D13) — and an imported token's from the `data:` URL the catalog
 * found by its contract (D39). Anything without a file — or a file that fails to load —
 * falls back to the wallet's monogram tile, so a missing logo never shows a
 * broken image. Logos are decorative unless `label` is given: the row next to
 * them names the token or venue.
 */
import {useState} from "react";
import type {AssetIconProps, ProviderLogoProps, TokenIconProps} from "../contracts/ui";
import {cx} from "./cx";
import {monogram, networkLogo, providerLogo, tokenLogo, type LogoSource} from "./logos";
import s from "./LogoIcons.module.css";

/** Accessible name for a logo that stands alone (otherwise decorative). */
interface Labelled {
  label?: string;
}

const a11y = (label: string | undefined) => (label ? {role: "img", "aria-label": label} : {"aria-hidden": true as const});

/** An <img> that reports a failed load, so the caller can fall back. */
function LogoImg({source, size, onFail}: {source: LogoSource; size: number; onFail: () => void}) {
  return (
    <img
      className={s.img}
      src={source.src}
      srcSet={source.srcSet}
      sizes={source.srcSet ? `${size}px` : undefined}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={onFail}
    />
  );
}

/** Remembers which URL failed (not a flag), so a new token/network gets a fresh try. */
function useFailed(src: string | undefined): [boolean, () => void] {
  const [failed, setFailed] = useState<string | null>(null);
  return [src !== undefined && failed === src, () => setFailed(src ?? null)];
}

/** An imported token's logo: a `data:image/` URL only — nothing that would load from a host. */
const importedLogo = (logo: string | undefined): LogoSource | null => (logo?.startsWith("data:image/") ? {src: logo} : null);

/** Round logo on a surface3 disc: `network` by catalog slug, else `token` by symbol; monogram fallback. */
export function AssetIcon({token, network, size = 38, label}: AssetIconProps & Labelled) {
  // An imported token (D39) never gets the logo its symbol names (that is whatever its deployer wrote): only the one found
  // by its contract, inline, else its monogram.
  const source = network !== undefined ? networkLogo(network) : token?.imported ? importedLogo(token.logo) : token ? tokenLogo(token.symbol) : null;
  const [failed, fail] = useFailed(source?.src);
  const text = monogram(network ?? token?.symbol ?? "?");
  return (
    <span className={s.disc} style={{width: size, height: size}} {...a11y(label)}>
      {source && !failed ? (
        <LogoImg source={source} size={size} onFail={fail} />
      ) : (
        <span className={s.monogram} style={{fontSize: Math.max(7, size * 0.26)}}>
          {text}
        </span>
      )}
    </span>
  );
}

/** Token logo with its network in the corner (pickers, rows); `badge={false}` drops the corner. */
export function TokenIcon({token, size = 38, badge = true, label}: TokenIconProps & Labelled) {
  const b = Math.round(size * 0.42);
  return (
    <span className={s.tokenIcon} style={{width: size, height: size}} {...a11y(label)}>
      <AssetIcon token={token} size={size} />
      {badge ? (
        <span className={s.badge}>
          <AssetIcon network={token.chain} size={b} />
        </span>
      ) : null}
    </span>
  );
}

/** Props of the chain logo. */
export interface ChainLogoProps extends Labelled {
  /** Catalog slug ("ethereum", "elysium"). */
  slug: string;
  size?: number;
}

/** A network's round logo (rail items, headers): AssetIcon by slug. */
export function ChainLogo({slug, size = 30, label}: ChainLogoProps) {
  return <AssetIcon network={slug} size={size} label={label} />;
}

/** ProviderLogo props plus the display name (for the initial tile and `label`). */
export interface ProviderLogoExtraProps extends ProviderLogoProps, Labelled {
  /** The venue's display name; default the id. */
  name?: string;
}

/** A venue's square tile, radius round(size × .28); pending = dimmed, refused = grey and dimmed. */
export function ProviderLogo({provider, size = 28, state = "normal", name, label}: ProviderLogoExtraProps) {
  const source = providerLogo(provider);
  const [failed, fail] = useFailed(source?.src);
  return (
    <span
      className={cx(s.provider, state === "pending" && s.pending, state === "refused" && s.refused)}
      style={{width: size, height: size, borderRadius: Math.round(size * 0.28)}}
      data-state={state}
      {...a11y(label)}
    >
      {source && !failed ? (
        <LogoImg source={source} size={size} onFail={fail} />
      ) : (
        <span className={s.initial} style={{fontSize: Math.round(size * 0.45)}}>
          {(name ?? provider).slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
}

/** Props of the symbol-only token logo. */
export interface TokenLogoProps extends Labelled {
  symbol: string;
  size?: number;
}

/** A token's round logo when only the symbol is at hand (review headline, activity rows). */
export function TokenLogo({symbol, size = 38, label}: TokenLogoProps) {
  return <AssetIcon token={{symbol, caip2: "", contract: null}} size={size} label={label} />;
}
