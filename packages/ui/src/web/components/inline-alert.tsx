// @wardenx/ui — InlineAlert (2026-09-25 redesign). A flat, token-only message line for a form or panel:
// an error refusal (role="alert", announced at once) or a success/info notice (<output>, a polite live
// region). No card, no border — a tinted strip, so it sits inside flat sections. Presentational only.
import type { JSX, ReactNode } from "react";
import { t, tint } from "../theme/tokens";

export interface InlineAlertProps {
  /** `error` is announced assertively; `success` and `info` are polite status text. */
  tone?: "error" | "success" | "info";
  children: ReactNode;
}

const COLOR = { error: t.errorPillFg, success: t.successPillFg, info: t.onSurfaceVariant } as const;
const BACKGROUND = {
  error: tint(t.error),
  success: tint(t.success),
  info: t.surfaceContainer,
} as const;

export function InlineAlert({ tone = "error", children }: InlineAlertProps): JSX.Element {
  const style = {
    display: "block",
    margin: 0,
    padding: "0.5rem 0.75rem",
    borderRadius: t.radiusMd,
    background: BACKGROUND[tone],
    color: COLOR[tone],
    fontSize: "0.8125rem",
  } as const;
  return tone === "error" ? (
    <p role="alert" style={style}>
      {children}
    </p>
  ) : (
    <output style={style}>{children}</output>
  );
}
