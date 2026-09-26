// @wardenx/ui — Panel (2026-09-25 redesign). The mockups' workhorse card: white surface, hairline
// edge, a header row of [blue outline icon · bold title · optional count] with a right-aligned
// action ("Edit", "View all →", "Manage"), then the body. `InfoRows` is the two-column label/value
// list those panels carry (Patient Information, Clinical Snapshot). Presentational only.
import type { CSSProperties, JSX, ReactNode } from "react";
import { Glyph, type GlyphName } from "../system/glyphs";
import { cardSurface, t } from "../theme/tokens";

export interface PanelProps {
  title: ReactNode;
  icon?: GlyphName;
  /** Right side of the header — usually a link ("View all →") or a small button. */
  action?: ReactNode;
  /** Optional line under the title. */
  description?: ReactNode;
  /** Body padding. Tables that run edge-to-edge pass `flush`. */
  flush?: boolean;
  /** Tints the header + border for safety panels (Alerts & Safety). */
  tone?: "default" | "danger";
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export function Panel({
  title,
  icon,
  action,
  description,
  flush = false,
  tone = "default",
  children,
  style,
  className,
}: PanelProps): JSX.Element {
  const danger = tone === "danger";
  return (
    <section
      className={className ? `wx-panel ${className}` : "wx-panel"}
      style={{
        ...cardSurface,
        ...(danger ? { borderColor: `color-mix(in srgb, ${t.error} 22%, ${t.cardBorder})` } : null),
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        overflow: "hidden",
        ...style,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "0.625rem",
          padding: "0.875rem 1.125rem",
          background: danger ? `color-mix(in srgb, ${t.error} 5%, ${t.surfaceLowest})` : undefined,
        }}
      >
        {icon ? (
          <span style={{ color: danger ? t.error : t.primary, marginTop: "0.0625rem" }}>
            <Glyph name={icon} size={20} strokeWidth={1.75} />
          </span>
        ) : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2
            style={{
              margin: 0,
              fontFamily: t.fontSans,
              fontSize: "1rem",
              fontWeight: 700,
              lineHeight: 1.35,
              color: t.onSurface,
            }}
          >
            {title}
          </h2>
          {description ? (
            <p style={{ margin: "0.125rem 0 0", fontSize: "0.8125rem", color: t.onSurfaceVariant }}>
              {description}
            </p>
          ) : null}
        </div>
        {action ? (
          <div
            className="wx-panel-action"
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8125rem" }}
          >
            {action}
          </div>
        ) : null}
      </header>
      <div style={{ padding: flush ? 0 : "0.25rem 1.125rem 1rem", flex: 1, minWidth: 0 }}>
        {children}
      </div>
    </section>
  );
}

/** Numeric badge after a panel title ("Alerts & Safety ③"). */
export function CountBadge({
  count,
  tone = "danger",
}: {
  count: number;
  tone?: "danger" | "primary";
}): JSX.Element {
  const bg = tone === "danger" ? t.error : t.primary;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: "1.25rem",
        height: "1.25rem",
        padding: "0 0.35rem",
        borderRadius: "9999px",
        background: bg,
        color: t.onEmphasis,
        fontSize: "0.6875rem",
        fontWeight: 700,
      }}
    >
      {count}
    </span>
  );
}

export interface InfoRow {
  label: ReactNode;
  value: ReactNode;
  /** Secondary line under the value (e.g. a diagnosis description under its code). */
  hint?: ReactNode;
}

/** Label/value rows — label muted on the left, value on the right column (mockup "Patient Information"). */
export function InfoRows({
  rows,
  labelWidth = "10rem",
}: {
  rows: InfoRow[];
  labelWidth?: string;
}): JSX.Element {
  return (
    <dl
      style={{
        display: "grid",
        gridTemplateColumns: `minmax(6rem, ${labelWidth}) 1fr`,
        columnGap: "1rem",
        rowGap: "0.625rem",
        margin: 0,
        fontSize: "0.875rem",
      }}
    >
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static presentational rows.
        <div key={i} style={{ display: "contents" }}>
          <dt style={{ color: t.onSurfaceVariant }}>{r.label}</dt>
          <dd style={{ margin: 0, color: t.onSurface, minWidth: 0 }}>
            {r.value}
            {r.hint ? (
              <div
                style={{ fontSize: "0.75rem", color: t.onSurfaceVariant, marginTop: "0.125rem" }}
              >
                {r.hint}
              </div>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Small tinted chip ("DNR", "Fall risk", "No known allergies"). */
export function FlagChip({
  label,
  tone = "neutral",
  icon,
}: {
  label: ReactNode;
  tone?: "danger" | "warning" | "neutral" | "info" | "success";
  icon?: GlyphName;
}): JSX.Element {
  const color =
    tone === "danger"
      ? t.error
      : tone === "warning"
        ? t.warning
        : tone === "info"
          ? t.primary
          : tone === "success"
            ? t.success
            : t.onSurfaceVariant;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
        padding: "0.2rem 0.55rem",
        borderRadius: t.radiusSm,
        background:
          tone === "neutral"
            ? t.surfaceContainer
            : `color-mix(in srgb, ${color} 12%, ${t.surfaceLowest})`,
        color: tone === "success" ? t.successPillFg : color,
        fontSize: "0.75rem",
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      {icon ? <Glyph name={icon} size={13} /> : null}
      {label}
    </span>
  );
}
