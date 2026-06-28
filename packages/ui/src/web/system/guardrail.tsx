// @wardenx/ui web — The Guardrail System (R0.3, DESIGN.md §7 — WardenX-defining).
// "WardenX is the warden." Guards explain, gates checklist, blockers stop, ceremonies attest, and
// clocks count down — one consistent, legible visual language. Token-driven + No-Line; every
// colored signal carries a glyph partner (§10.10). These map 1:1 to the D1-ceremonies board.
import { useId, useState } from "react";
import type { JSX, ReactNode } from "react";
import { ghostBorder, t, tint } from "../theme/tokens";
import { Glyph, type GlyphName } from "./glyphs";
import { Modal } from "./modal";

type Tone = "neutral" | "warning" | "error" | "alert";

const TONE_FG: Record<Tone, string> = {
  neutral: t.onSurfaceVariant,
  warning: t.warning,
  error: t.error,
  alert: t.alert,
};

// ────────────────────────────────────────────────────────────────────────────
// §7.1 Guard Chip — the "why". A blocked control is paired with a terse reason + a fix deep-link.
// ────────────────────────────────────────────────────────────────────────────
export interface GuardChipProps {
  /** Terse reason the action is blocked, e.g. "2 unsigned notes block submission". */
  reason: ReactNode;
  /** warning (default) or error toned. */
  tone?: "warning" | "error";
  /** Deep-link to fix the blocker. Provide href OR onFix. */
  fixHref?: string;
  onFix?: () => void;
  /** Fix affordance label (visually the "→"); defaults to "Fix". */
  fixLabel?: string;
}
export function GuardChip({
  reason,
  tone = "warning",
  fixHref,
  onFix,
  fixLabel = "Fix",
}: GuardChipProps): JSX.Element {
  const fg = TONE_FG[tone];
  const fix =
    fixHref || onFix ? (
      <a
        href={fixHref ?? "#"}
        onClick={
          onFix
            ? (e) => {
                if (!fixHref) e.preventDefault();
                onFix();
              }
            : undefined
        }
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.2rem",
          color: fg,
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        {fixLabel}
        <Glyph name="arrow-right" size={14} />
      </a>
    ) : null;
  return (
    <span
      className="wx-guard-chip"
      role="note"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.25rem 0.6rem",
        borderRadius: "9999px",
        background: tint(fg),
        color: fg,
        fontFamily: t.fontSans,
        fontSize: "0.75rem",
        fontWeight: 500,
        lineHeight: 1.4,
      }}
    >
      <Glyph name="lock" size={14} />
      <span>{reason}</span>
      {fix}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// §7.5 Countdown Chip — regulatory clock. neutral → warning → alert as the deadline nears.
// ────────────────────────────────────────────────────────────────────────────
export interface CountdownChipProps {
  /** The deadline. */
  dueAt: Date | string;
  /** Hours-remaining at which the chip turns `warning`. Default 48. */
  warnWithinHours?: number;
  /** Hours-remaining at which the chip turns `alert`. Default 12. */
  alertWithinHours?: number;
  /** What the clock is for, e.g. "Recert". Rendered before the relative time. */
  label?: ReactNode;
  /** Injectable clock for tests; defaults to now. */
  now?: Date;
}
function relativeTime(deltaMs: number): string {
  const past = deltaMs < 0;
  const mins = Math.round(Math.abs(deltaMs) / 60000);
  const hrs = Math.round(mins / 60);
  const days = Math.round(hrs / 24);
  const body =
    mins < 60 ? `${mins}m` : hrs < 48 ? `${hrs}h` : `${days}d`;
  return past ? `${body} overdue` : `in ${body}`;
}
export function CountdownChip({
  dueAt,
  warnWithinHours = 48,
  alertWithinHours = 12,
  label,
  now = new Date(),
}: CountdownChipProps): JSX.Element {
  const due = typeof dueAt === "string" ? new Date(dueAt) : dueAt;
  const deltaMs = due.getTime() - now.getTime();
  const hoursLeft = deltaMs / 3_600_000;
  const tone: Tone =
    hoursLeft <= 0 ? "error" : hoursLeft <= alertWithinHours ? "alert" : hoursLeft <= warnWithinHours ? "warning" : "neutral";
  const fg = TONE_FG[tone];
  return (
    <span
      className="wx-countdown-chip"
      // The absolute due date is always available on hover, never just "in 3 days" (§7.5).
      title={due.toLocaleString()}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.35rem",
        padding: "0.2rem 0.55rem",
        borderRadius: "9999px",
        background: tone === "neutral" ? t.surfaceContainer : tint(fg),
        color: fg,
        fontFamily: t.fontSans,
        fontSize: "0.75rem",
        fontWeight: 500,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <Glyph name="clock" size={14} />
      {label ? <span style={{ fontWeight: 600 }}>{label}</span> : null}
      <span>{relativeTime(deltaMs)}</span>
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// §7.2 Gate Stepper — multi-condition gate as an actionable checklist; blockers surfaced first.
// ────────────────────────────────────────────────────────────────────────────
export type GateStatus = "not-started" | "in-progress" | "complete" | "blocked";

export interface GateItem {
  id: string;
  label: ReactNode;
  status: GateStatus;
  /** Optional secondary line (the precise unmet invariant). */
  detail?: ReactNode;
  /** Per-gate action to resolve it. */
  action?: { label: string; href?: string; onAction?: () => void };
}

const GATE_META: Record<GateStatus, { glyph: GlyphName; fg: string; rank: number }> = {
  blocked: { glyph: "alert", fg: t.error, rank: 0 },
  "in-progress": { glyph: "dot", fg: t.primary, rank: 1 },
  "not-started": { glyph: "dot", fg: t.onSurfaceVariant, rank: 2 },
  complete: { glyph: "check-circle", fg: t.success, rank: 3 },
};

export interface GateStepperProps {
  items: GateItem[];
  /** Sort blockers/in-progress to the top (§7.2). Default true. */
  surfaceBlockersFirst?: boolean;
  ariaLabel?: string;
}
export function GateStepper({
  items,
  surfaceBlockersFirst = true,
  ariaLabel = "Gate conditions",
}: GateStepperProps): JSX.Element {
  const ordered = surfaceBlockersFirst
    ? [...items].sort((a, b) => GATE_META[a.status].rank - GATE_META[b.status].rank)
    : items;
  return (
    <ul
      className="wx-gate-stepper"
      aria-label={ariaLabel}
      style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}
    >
      {ordered.map((item) => {
        const meta = GATE_META[item.status];
        return (
          <li
            key={item.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "0.6rem",
              padding: "0.6rem 0.75rem",
              borderRadius: t.radiusLg,
              background: item.status === "blocked" ? tint(t.error) : t.surfaceLow,
            }}
          >
            <span style={{ color: meta.fg, marginTop: "0.1rem" }}>
              <Glyph name={meta.glyph} size={18} label={item.status} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontFamily: t.fontSans,
                  fontSize: "0.875rem",
                  fontWeight: 500,
                  color: t.onSurface,
                  textDecoration: item.status === "complete" ? "line-through" : undefined,
                }}
              >
                {item.label}
              </div>
              {item.detail ? (
                <div style={{ fontSize: "0.8125rem", color: t.onSurfaceVariant, marginTop: "0.15rem" }}>
                  {item.detail}
                </div>
              ) : null}
            </div>
            {item.action && item.status !== "complete" ? (
              <a
                href={item.action.href ?? "#"}
                onClick={
                  item.action.onAction
                    ? (e) => {
                        if (!item.action?.href) e.preventDefault();
                        item.action?.onAction?.();
                      }
                    : undefined
                }
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.2rem",
                  color: t.primary,
                  fontWeight: 600,
                  fontSize: "0.8125rem",
                  whiteSpace: "nowrap",
                  textDecoration: "none",
                }}
              >
                {item.action.label}
                <Glyph name="arrow-right" size={14} />
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// Shared ceremony/dialog button styling (matches index.css .wx-page-actions buttons).
function PrimaryButton({
  children,
  onClick,
  disabled,
  tone = "primary",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "primary" | "error";
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "0.5rem 1rem",
        borderRadius: "9999px",
        border: "none",
        background: disabled ? t.surfaceContainer : tone === "error" ? t.error : t.primary,
        color: disabled ? t.muted : t.onEmphasis,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}
function GhostButton({ children, onClick }: { children: ReactNode; onClick?: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "0.5rem 1rem",
        borderRadius: t.radiusMd,
        border: "none",
        background: t.surfaceHigh,
        color: t.onSurface,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// §7.3 Blocking Dialog — one alert-dialog template for the six canonical invariant blockers.
// alert-toned header · precise unmet invariants checklist · exactly two paths (Fix / Override).
// ────────────────────────────────────────────────────────────────────────────
export interface BlockingDialogProps {
  open: boolean;
  title: ReactNode;
  /** The precise unmet invariants. Reuses the Gate Stepper checklist. */
  invariants: GateItem[];
  /** Override path — only render where policy permits; always captures a reason to audit. */
  overrideAllowed?: boolean;
  onOverride?: (reason: string) => void;
  overrideLabel?: string;
  /** Dismiss / acknowledge (returns to the form to fix). */
  onClose: () => void;
  closeLabel?: string;
}
export function BlockingDialog({
  open,
  title,
  invariants,
  overrideAllowed = false,
  onOverride,
  overrideLabel = "Override",
  onClose,
  closeLabel = "Go back & fix",
}: BlockingDialogProps): JSX.Element | null {
  const [reason, setReason] = useState("");
  const [overriding, setOverriding] = useState(false);
  const reasonId = useId();
  if (!open) return null;
  return (
    <Modal open={open} ariaLabel={typeof title === "string" ? title : "Action blocked"} role="alertdialog" accent={t.alert}>
      <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", color: t.alert }}>
          <Glyph name="alert" size={22} label="Blocked" />
          <h2 style={{ margin: 0, fontFamily: t.fontDisplay, fontSize: "1.375rem", fontWeight: 500, color: t.onSurface }}>
            {title}
          </h2>
        </div>
        <GateStepper items={invariants} ariaLabel="Unmet requirements" />
        {overriding ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            <label htmlFor={reasonId} style={{ fontSize: "0.75rem", fontWeight: 600, color: t.onSurfaceVariant }}>
              Override reason (captured to audit)
            </label>
            <textarea
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why are you overriding this blocker?"
              style={{ width: "100%", resize: "vertical" }}
            />
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", flexWrap: "wrap" }}>
          <GhostButton onClick={onClose}>{closeLabel}</GhostButton>
          {overrideAllowed ? (
            overriding ? (
              <PrimaryButton tone="error" disabled={reason.trim().length === 0} onClick={() => onOverride?.(reason.trim())}>
                Confirm override
              </PrimaryButton>
            ) : (
              <PrimaryButton tone="error" onClick={() => setOverriding(true)}>
                {overrideLabel}
              </PrimaryButton>
            )
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// §7.4 Signature Ceremony — modal attestation for irreversible transitions. Shows what is being
// attested, legal text, signer identity, an optional step-up challenge, and a single commit.
// ────────────────────────────────────────────────────────────────────────────
export interface CeremonyModalProps {
  open: boolean;
  title: ReactNode;
  /** What is being attested (the human-readable summary of the act). */
  attestation: ReactNode;
  /** Legal attestation text the signer affirms. */
  legalText?: ReactNode;
  signer: { name: ReactNode; role?: ReactNode };
  /**
   * Step-up challenge, where required (EPCS / SSN write / death / break-glass). When present, the
   * commit stays disabled until a credential is entered; its value is passed to onCommit.
   */
  stepUp?: { label?: string; type?: "password" | "text"; placeholder?: string };
  /** Marks this as an EPCS ceremony (controlled-substance) — uses alert accent, not gold (§2.2). */
  epcs?: boolean;
  commitLabel?: string;
  onCommit: (stepUpValue?: string) => void;
  onCancel: () => void;
}
export function CeremonyModal({
  open,
  title,
  attestation,
  legalText,
  signer,
  stepUp,
  epcs = false,
  commitLabel = "Sign & commit",
  onCommit,
  onCancel,
}: CeremonyModalProps): JSX.Element | null {
  const [credential, setCredential] = useState("");
  const [affirmed, setAffirmed] = useState(false);
  const stepUpId = useId();
  const affirmId = useId();
  if (!open) return null;
  const accent = epcs ? t.alert : t.primary;
  const needsStepUp = Boolean(stepUp);
  const commitReady = (!needsStepUp || credential.trim().length > 0) && (!legalText || affirmed);
  return (
    <Modal open={open} ariaLabel={typeof title === "string" ? title : "Signature ceremony"} accent={accent}>
      <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", color: accent }}>
          <Glyph name={epcs ? "lock" : "shield"} size={22} label={epcs ? "EPCS" : "Signature"} />
          <h2 style={{ margin: 0, fontFamily: t.fontDisplay, fontSize: "1.375rem", fontWeight: 500, color: t.onSurface }}>
            {title}
          </h2>
        </div>

        {/* What is being attested. */}
        <div style={{ background: t.surfaceLow, borderRadius: t.radiusLg, padding: "0.75rem 1rem", color: t.onSurface }}>
          {attestation}
        </div>

        {legalText ? (
          <label htmlFor={affirmId} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", cursor: "pointer" }}>
            <input id={affirmId} type="checkbox" checked={affirmed} onChange={(e) => setAffirmed(e.target.checked)} />
            <span style={{ fontSize: "0.8125rem", color: t.onSurfaceVariant, lineHeight: 1.5 }}>{legalText}</span>
          </label>
        ) : null}

        {/* Signer identity. */}
        <div style={{ fontSize: "0.8125rem", color: t.onSurfaceVariant }}>
          Signing as{" "}
          <strong style={{ color: t.onSurface }}>{signer.name}</strong>
          {signer.role ? <span> · {signer.role}</span> : null}
        </div>

        {needsStepUp ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", borderTop: ghostBorder, paddingTop: "1rem" }}>
            <label htmlFor={stepUpId} style={{ fontSize: "0.75rem", fontWeight: 600, color: t.onSurfaceVariant }}>
              {stepUp?.label ?? "Re-enter your credentials to continue"}
            </label>
            <input
              id={stepUpId}
              type={stepUp?.type ?? "password"}
              value={credential}
              placeholder={stepUp?.placeholder}
              onChange={(e) => setCredential(e.target.value)}
              autoComplete="off"
            />
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <GhostButton onClick={onCancel}>Cancel</GhostButton>
          <PrimaryButton
            tone={epcs ? "error" : "primary"}
            disabled={!commitReady}
            onClick={() => onCommit(needsStepUp ? credential.trim() : undefined)}
          >
            {commitLabel}
          </PrimaryButton>
        </div>
      </div>
    </Modal>
  );
}
