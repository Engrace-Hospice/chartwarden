import type { ButtonHTMLAttributes, JSX, ReactNode } from "react";
import { t, tint } from "../theme/tokens";
import { LoadingSpinner } from "./loading-spinner";

export type ButtonTone = "primary" | "secondary" | "tertiary" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  size?: ButtonSize;
  loading?: boolean;
  children: ReactNode;
}

const sizeStyle: Record<ButtonSize, { minHeight: string; padding: string; fontSize: string }> = {
  sm: { minHeight: "2rem", padding: "0.35rem 0.7rem", fontSize: "0.75rem" },
  md: { minHeight: "2.5rem", padding: "0.5rem 1rem", fontSize: "0.8125rem" },
  lg: { minHeight: "2.875rem", padding: "0.625rem 1.25rem", fontSize: "0.875rem" },
};

const toneStyle: Record<ButtonTone, { background: string; color: string; border: string }> = {
  primary: { background: t.primary, color: t.onPrimary, border: `1px solid ${t.primary}` },
  // Secondary is the mockups' outlined white button ("Actions ▾", "Save draft").
  secondary: {
    background: t.surfaceLowest,
    color: t.onSurface,
    border: `1px solid ${t.cardBorder}`,
  },
  tertiary: { background: "transparent", color: t.primary, border: "1px solid transparent" },
  danger: { background: t.error, color: t.onEmphasis, border: `1px solid ${t.error}` },
};

/**
 * Shared action button. A native button remains the primitive so forms, disabled state and keyboard
 * behaviour work without reimplementation. Use a router link for navigation; do not fake it with a
 * button. Every variant consumes Lantern tokens, therefore follows light/dark automatically.
 */
export function Button({
  tone = "primary",
  size = "md",
  loading = false,
  disabled,
  children,
  style,
  type = "button",
  ...props
}: ButtonProps): JSX.Element {
  const unavailable = disabled || loading;
  const visual = toneStyle[tone];
  return (
    <button
      {...props}
      type={type}
      disabled={unavailable}
      aria-busy={loading || undefined}
      className={`wx-button wx-button-${tone}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: t.space2,
        border: unavailable ? `1px solid ${t.cardBorder}` : visual.border,
        borderRadius: t.radiusMd,
        minHeight: sizeStyle[size].minHeight,
        padding: sizeStyle[size].padding,
        background: unavailable ? t.surfaceContainer : visual.background,
        color: unavailable ? t.onSurfaceVariant : visual.color,
        fontFamily: t.fontSans,
        fontSize: sizeStyle[size].fontSize,
        fontWeight: 600,
        lineHeight: 1.2,
        cursor: unavailable ? "not-allowed" : "pointer",
        opacity: unavailable ? 0.72 : 1,
        ...style,
      }}
    >
      {loading ? <LoadingSpinner label="Working" size={14} /> : null}
      {children}
    </button>
  );
}

/** A compact button intended for an icon-only action; `aria-label` is required. */
export interface IconButtonProps extends Omit<ButtonProps, "children"> {
  "aria-label": string;
  children: ReactNode;
}

export function IconButton({ size = "md", style, ...props }: IconButtonProps): JSX.Element {
  const dimension = size === "sm" ? "2rem" : size === "lg" ? "2.875rem" : "2.5rem";
  return (
    <Button
      {...props}
      size={size}
      style={{ width: dimension, minWidth: dimension, padding: 0, ...style }}
    />
  );
}

/** A soft status-aware fill for controls that need a non-destructive warning treatment. */
export const softDangerBackground = tint(t.error);
