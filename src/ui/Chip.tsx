/**
 * The swap form's small controls: the accent chips (MAX, Paste) and the token
 * chip that opens the picker (mobile TokenButton). Each is a real button with
 * the wallet's hit slop (+8 px around the small chips).
 */
import type {ButtonHTMLAttributes} from "react";
import {cx} from "./cx";
import {Icon} from "./Icon";
import {TokenIcon} from "./LogoIcons";
import {Text} from "./Text";
import s from "./Chip.module.css";

/** Props of an accent chip; "sm" = the MAX look, "md" = the 36 px Paste look. */
export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: string;
  size?: "sm" | "md";
}

export function Chip({label, size = "md", className, type = "button", ...rest}: ChipProps) {
  return (
    <button {...rest} type={type} className={cx(s.chip, s[size], className)}>
      {label}
    </button>
  );
}

/** The token a TokenChip shows: what TokenIcon needs plus the chain's display name. */
export interface TokenChipToken {
  symbol: string;
  caip2: string;
  contract: string | null;
  chain: string;
  chainName: string;
  /** Imported by its address (D39): its logo found by contract or a monogram, never one found by its symbol, and "(imported)" in its label. */
  imported?: boolean;
  /** An imported token's logo (`data:image/` URL found by its contract). */
  logo?: string;
}

/** Props of the token chip; `token: null` shows the empty "Select" state. */
export interface TokenChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  token: TokenChipToken | null;
}

/**
 * 44 px chip: TokenIcon 28 with its network, symbol (600) over the chain name (10.5 px dim), chevron. An imported
 * token's label says so: a copy named USDC never reads as "USDC on Base" to a screen reader.
 */
export function TokenChip({token, className, type = "button", ...rest}: TokenChipProps) {
  return (
    <button
      aria-label={token ? `${token.symbol}${token.imported ? " (imported)" : ""} on ${token.chainName}, change token` : "Select a token"}
      {...rest}
      type={type}
      className={cx(s.token, className)}
    >
      {token ? <TokenIcon token={token} size={28} /> : <span className={s.empty} aria-hidden="true" />}
      <span className={s.tokenText}>
        <Text variant="bodyStrong" weight={600} lines={1}>
          {token ? token.symbol : "Select"}
        </Text>
        {token ? (
          <Text variant="meta" color="var(--dim)" lines={1} className={s.tokenChain}>
            {token.chainName}
          </Text>
        ) : null}
      </span>
      <Icon name="chevronDown" size={11} className={s.chevron} />
    </button>
  );
}
