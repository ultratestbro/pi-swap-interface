/**
 * Props of the shared primitives in src/ui (ui-port.md §1.4, §2.5-2.10, §5).
 * The screens build against these while ui-kit builds them, so the names and
 * prop shapes are fixed here; visuals (numbers, colours) live in the spec.
 */
import type {ButtonHTMLAttributes, CSSProperties, HTMLAttributes, InputHTMLAttributes, ReactNode} from "react";
import type {StepState, SwapStep} from "./activity";
import type {VenueTrust} from "./routes";

/** The wallet's type scale (theme/tokens.ts `type`). */
export type TextVariant =
  | "balance"
  | "balanceCents"
  | "hero"
  | "title"
  | "amount"
  | "listTitle"
  | "body"
  | "bodyStrong"
  | "small"
  | "meta"
  | "caps"
  | "tag";

export type FontWeight = 400 | 500 | 600 | 700;

/** Viewport classes of layout "version B": phone < 640 ≤ tablet < 1024 ≤ desktop. */
export type Breakpoint = "phone" | "tablet" | "desktop";

export interface TextProps extends HTMLAttributes<HTMLElement> {
  variant?: TextVariant;
  /** A CSS colour, normally a token: "var(--muted)". */
  color?: string;
  weight?: FontWeight;
  tabular?: boolean;
  /** 1 = one line with ellipsis; 2 = clamp to two lines. */
  lines?: 1 | 2;
  /** Addresses, review values, error texts stay selectable (mobile `selectable`). */
  selectable?: boolean;
  as?: "span" | "p" | "div" | "h1" | "h2" | "h3" | "label" | "strong";
}

/** Icon names of mobile components/Icon.tsx (same paths), plus the web's `info` and `power` (disconnect). */
export type IconName =
  | "arrowRight"
  | "back"
  | "chevronDown"
  | "chevronRight"
  | "close"
  | "check"
  | "search"
  | "scan"
  | "scanLine"
  | "gear"
  | "send"
  | "receive"
  | "swap"
  | "flip"
  | "plus"
  | "external"
  | "refresh"
  | "copy"
  | "share"
  | "import"
  | "lock"
  | "cloud"
  | "eye"
  | "wallet"
  | "deals"
  | "hubs"
  | "explore"
  | "profile"
  | "activity"
  | "info"
  | "power"
  | "allChains";

export interface IconProps {
  name: IconName;
  /** px, default 24. Stroke 2.6, or 3.0 at size ≤ 12. */
  size?: number;
  color?: string;
  className?: string;
}

export type ButtonKind = "primary" | "secondary" | "ghost";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  title: string;
  kind?: ButtonKind;
  /** 54 = main CTA, 48, 40. Default 48. */
  height?: 54 | 48 | 40;
  icon?: IconName;
  /** Keeps the title, spinner replaces the icon, opacity .85. */
  loading?: boolean;
  /** Stretch to the container width. */
  block?: boolean;
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconName;
  /** Required: icon-only buttons need a name. */
  "aria-label": string;
  /** Default 36. */
  size?: number;
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** CSS padding, default 14. */
  padding?: number | string;
}

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: string;
  error?: string | null;
  /** Rendered inside the field on the right (Paste chip, clear button). */
  trailing?: ReactNode;
  /** 1.5 px frame: red invalid, accentBorder valid, transparent otherwise. */
  tone?: "neutral" | "valid" | "invalid";
}

export interface SwitchProps {
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  "aria-label": string;
}

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number;
  style?: CSSProperties;
}

export interface ReviewSkeletonProps {
  rows?: number;
  label: string;
}

export interface SpinnerProps {
  size?: number;
  color?: string;
}

export interface TagProps {
  children: ReactNode;
  tone: "accent" | "green" | "muted" | "amber" | "red";
  title?: string;
}

export interface VenueBadgeProps {
  trust: VenueTrust;
  /** For the tooltip: "Quoted by {provider}'s API — checked in your browser before you sign". */
  providerName: string;
  chainName: string;
}

export interface SheetProps {
  open: boolean;
  onClose(): void;
  /** Accessible name (also used when no visible title). */
  label: string;
  /** No Esc / backdrop / close while true (executing). */
  locked?: boolean;
  /** Desktop/tablet dialog width: token 480, review 440, routes 440, activity 380 (drawer, anchored right). */
  width?: number;
  /** "drawer" = anchored right, full height on ≥ 640 (Activity). Default "dialog". */
  placement?: "dialog" | "drawer";
  /** Phone bottom-sheet height preset. */
  phoneHeight?: "full" | "tall" | "half";
  children: ReactNode;
}

export interface SheetHeaderProps {
  title: string;
  sub?: string;
  /** 44 px leading visual (TokenIcon / ProviderLogo / Icon). */
  icon?: ReactNode;
  onClose?: () => void;
  onBack?: () => void;
}

export interface Tile {
  k: string;
  v: string;
  tone?: "green" | "amber" | "red";
  /** Optional trailing action (copy button). */
  action?: ReactNode;
}

export interface Fact {
  k: string;
  v: ReactNode;
}

/** One TxReviewCard row (mobile components/TxReviewCard.tsx ReviewRow, plus the web's compact review: D34). */
export interface ReviewRow {
  k: string;
  v: string;
  /** A second line under the value, dim. */
  sub?: string;
  /** Dim text on the value's own line ("$18.90", "~4 s"); it moves under the value only when the row is too narrow. */
  note?: string;
  /** An explanation behind an info mark beside the key (hover / focus): never a fact the row would otherwise lose. */
  tip?: string;
  /** A tag after the value (the venue's trust badge). */
  badge?: ReactNode;
  /** Value colour override (token var). */
  color?: string;
  testId?: string;
  icon?: ReactNode;
}

export interface TxReviewCardProps {
  rows: readonly ReviewRow[];
  /** Tighter rows (padding 8 × 14), for a sheet that must fit without scrolling: the review, the deposit panel, the status. */
  compact?: boolean;
}

export interface TilesProps {
  tiles: readonly Tile[];
}

export interface FactsProps {
  facts: readonly Fact[];
}

export interface GlassProps extends HTMLAttributes<HTMLDivElement> {
  /** rgba(22,22,31,.82) instead of the default glass fill. */
  dark?: boolean;
}

export interface SwapStepsProps {
  steps: readonly SwapStep[];
  /** Detail line under the active step (status.tsx activeDetail). */
  activeDetail?: string;
  /** Tighter steps (10 px apart), for the status view that must fit without scrolling. */
  compact?: boolean;
}

export interface StepDotProps {
  state: StepState;
}

export interface AssetIconProps {
  /**
   * Token by symbol + chain caip2/contract for the catalog-mirror lookup. `imported` (D39): a monogram only — a logo
   * found by an imported token's symbol would dress a copy up as the listed token.
   */
  token?: {symbol: string; caip2: string; contract: string | null; imported?: boolean};
  /** Network by slug. */
  network?: string;
  /** px, default 38. */
  size?: number;
}

export interface TokenIconProps {
  token: {symbol: string; caip2: string; contract: string | null; chain: string; imported?: boolean};
  size?: number;
  /** Network badge at bottom-right, round(size*.42). Default true. */
  badge?: boolean;
}

export interface ProviderLogoProps {
  provider: string;
  /** px, default 28. Corner radius round(size*.28). */
  size?: number;
  /** pending: opacity .5; refused: grayscale + .5. */
  state?: "normal" | "pending" | "refused";
}

export interface QrCodeProps {
  /** The payload (address, or BIP-21 / zcash: URI). */
  value: string;
  /** px, default 208. Dark modules #06131a on a #fff tile with a 12 px quiet zone. */
  size?: number;
  /** Expired: blurred and dimmed, not scannable. */
  expired?: boolean;
  "aria-label": string;
}
