import type { JSX, ReactNode } from "react";
import { cardSurface, t, tint } from "../theme/tokens";

export type MetricTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface MetricCardProps {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  trend?: ReactNode;
  tone?: MetricTone;
  selected?: boolean;
  onSelect?: () => void;
}

const toneColor: Record<MetricTone, string | undefined> = {
  neutral: undefined,
  info: t.primary,
  success: t.success,
  warning: t.warning,
  danger: t.error,
};

/** A KPI card with optional semantic treatment. It is a button only when it changes the view. */
export function MetricCard({
  label,
  value,
  detail,
  trend,
  tone = "neutral",
  selected = false,
  onSelect,
}: MetricCardProps): JSX.Element {
  const accent = toneColor[tone];
  const content = (
    <>
      <span
        style={{
          color: t.onSurfaceVariant,
          fontFamily: t.fontDisplay,
          fontSize: "0.6875rem",
          fontWeight: 650,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span
        className="tabular-nums"
        style={{
          color: accent ?? t.onSurface,
          fontFamily: t.fontSans,
          fontSize: "1.75rem",
          fontWeight: 650,
        }}
      >
        {value}
      </span>
      {detail || trend ? (
        <span
          style={{ display: "flex", gap: t.space2, color: t.onSurfaceVariant, fontSize: "0.75rem" }}
        >
          {detail}
          {trend ? (
            <span style={{ color: accent ?? t.onSurfaceVariant, fontWeight: 650 }}>{trend}</span>
          ) : null}
        </span>
      ) : null}
    </>
  );
  const style = {
    ...cardSurface,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "flex-start",
    gap: t.space2,
    minWidth: "10rem",
    padding: `${t.space4} ${t.space5}`,
    border: selected ? `2px solid ${t.primary}` : "2px solid transparent",
    background: selected && accent ? tint(accent, 8) : t.surfaceLowest,
    textAlign: "left" as const,
  };
  return onSelect ? (
    <button
      type="button"
      className="wx-metric-card"
      aria-pressed={selected}
      onClick={onSelect}
      style={{ ...style, cursor: "pointer" }}
    >
      {content}
    </button>
  ) : (
    <div className="wx-metric-card" style={style}>
      {content}
    </div>
  );
}
