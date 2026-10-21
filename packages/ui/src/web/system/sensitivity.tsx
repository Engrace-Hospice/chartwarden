// @chartwarden/ui web — Sensitivity & Consent Layer (R0.3, DESIGN.md §8 — WardenX-defining).
// "You may not see this, or not yet" gets one consistent treatment: masked identifiers reveal only
// under step-up; SUD/Part-2 content reads as a sealed block, never a blank; an active break-glass
// session paints a persistent alert banner. Token-driven + No-Line; maps 1:1 to D2-sensitivity.
import { useState } from "react";
import type { JSX, ReactNode } from "react";
import { ghostBorder, t, tint } from "../theme/tokens";
import { Glyph } from "./glyphs";

// ────────────────────────────────────────────────────────────────────────────
// §8 PHI masking — SSN / state ID / MBI render `xxx-xx-####` in mono. Full reveal is a step-up-
// gated, audited action (phi.read_ssn), shown as a reveal affordance — never auto-revealed.
// ────────────────────────────────────────────────────────────────────────────
/** Mask all but the last `keep` characters, preserving separators (digits/letters → •). */
export function maskTail(value: string, keep = 4): string {
  let shown = 0;
  const out: string[] = [];
  for (let i = value.length - 1; i >= 0; i--) {
    const ch = value[i] ?? "";
    if (/[0-9A-Za-z]/.test(ch) && shown < keep) {
      out.push(ch);
      shown++;
    } else if (/[0-9A-Za-z]/.test(ch)) {
      out.push("•");
    } else {
      out.push(ch);
    }
  }
  return out.reverse().join("");
}

export interface MaskedIdentifierProps {
  /** The full identifier (only sent over the reveal path; mask is shown by default). */
  value: string;
  /** Precomputed masked form; if omitted, derived as `••••-1234`. */
  masked?: string;
  /** Digits/letters to keep visible when deriving the mask. Default 4. */
  keep?: number;
  /**
   * Reveal handler — MUST perform the step-up + audit (phi.read_ssn) and resolve the full value.
   * Without it the control shows no reveal affordance (read-only mask).
   */
  onReveal?: () => Promise<string> | string | undefined;
  /** Accessible name, e.g. "Social Security Number". */
  label?: string;
}
export function MaskedIdentifier({
  value,
  masked,
  keep = 4,
  onReveal,
  label,
}: MaskedIdentifierProps): JSX.Element {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = revealed ?? masked ?? maskTail(value, keep);

  async function handleReveal(): Promise<void> {
    if (!onReveal || busy) return;
    setBusy(true);
    try {
      const full = await onReveal();
      setRevealed(typeof full === "string" ? full : value);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
      <span
        className="wx-masked-id"
        aria-label={label ? `${label}${revealed ? "" : ", masked"}` : undefined}
        style={{
          fontFamily: t.fontMono,
          fontSize: "0.8125rem",
          color: t.onSurface,
          letterSpacing: "0.02em",
        }}
      >
        {shown}
      </span>
      {onReveal && revealed === null ? (
        <button
          type="button"
          onClick={handleReveal}
          disabled={busy}
          aria-label={`Reveal ${label ?? "value"} (requires re-authentication)`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            border: "none",
            background: "transparent",
            color: t.primary,
            cursor: busy ? "wait" : "pointer",
            padding: "0.1rem",
          }}
        >
          <Glyph name="eye" size={16} />
        </button>
      ) : null}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// §8 SUD / 42 CFR Part 2 redaction — a sealed block, never a blank. Redaction is visible AS
// redaction so clinicians know something exists; unsealing is consent-checked (M39) + audited.
// ────────────────────────────────────────────────────────────────────────────
export interface SealedBlockProps {
  /** Placeholder message. Default: "Protected — Part 2 consent required". */
  message?: ReactNode;
  /** Unseal handler — MUST run the consent check (M39 ConsentEvaluator) + audit. */
  onUnseal?: () => void;
  unsealLabel?: string;
  /** The protected content; rendered only when `unsealed`. */
  unsealed?: boolean;
  children?: ReactNode;
}
export function SealedBlock({
  message = "Protected — Part 2 consent required",
  onUnseal,
  unsealLabel = "Request access",
  unsealed = false,
  children,
}: SealedBlockProps): JSX.Element {
  if (unsealed) return <>{children}</>;
  return (
    <div
      className="wx-sealed-block"
      role="note"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        padding: "1rem 1.25rem",
        borderRadius: t.radiusLg,
        background: t.surfaceContainer,
        border: ghostBorder,
        color: t.onSurfaceVariant,
      }}
    >
      <Glyph name="lock" size={18} label="Protected" />
      <span style={{ flex: 1, fontSize: "0.875rem" }}>{message}</span>
      {onUnseal ? (
        <button
          type="button"
          onClick={onUnseal}
          style={{
            border: "none",
            background: "transparent",
            color: t.primary,
            fontWeight: 600,
            fontSize: "0.8125rem",
            cursor: "pointer",
          }}
        >
          {unsealLabel}
        </button>
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// §8 Break-glass — a persistent ambient `alert` banner for the whole emergency session. The one
// place `alert` is ambient. Shows the grant reason + a one-tap end-session.
// ────────────────────────────────────────────────────────────────────────────
export interface BreakGlassBannerProps {
  /** Why emergency access was granted. */
  reason?: ReactNode;
  /** Who the session is for / acting as. */
  grantedTo?: ReactNode;
  onEndSession: () => void;
  endLabel?: string;
}
export function BreakGlassBanner({
  reason,
  grantedTo,
  onEndSession,
  endLabel = "End emergency access",
}: BreakGlassBannerProps): JSX.Element {
  return (
    <div
      className="wx-break-glass"
      role="alert"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        padding: "0.6rem 1.25rem",
        background: t.alert,
        color: t.onEmphasis,
        fontFamily: t.fontSans,
        fontSize: "0.875rem",
      }}
    >
      <Glyph name="alert" size={18} label="Emergency access" />
      <strong>Emergency access active</strong>
      <span style={{ opacity: 0.95 }}>— all actions audited</span>
      {grantedTo ? <span style={{ opacity: 0.9 }}>· {grantedTo}</span> : null}
      {reason ? <span style={{ opacity: 0.9 }}>· {reason}</span> : null}
      <button
        type="button"
        onClick={onEndSession}
        style={{
          marginLeft: "auto",
          border: `1px solid color-mix(in srgb, ${t.onEmphasis} 60%, transparent)`,
          background: "transparent",
          color: t.onEmphasis,
          fontWeight: 600,
          borderRadius: "9999px",
          padding: "0.25rem 0.75rem",
          cursor: "pointer",
        }}
      >
        {endLabel}
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// §8 Consent-gated badge — privacy flag on the Patient Banner. neutral/primary-tint, shield glyph;
// hover explains the gate + its authority.
// ────────────────────────────────────────────────────────────────────────────
export interface ConsentBadgeProps {
  label: ReactNode;
  /** Hover title — the gate and its authority, e.g. "42 CFR Part 2 · consent on file". */
  authority?: string;
}
export function ConsentBadge({ label, authority }: ConsentBadgeProps): JSX.Element {
  return (
    <span
      className="wx-consent-badge"
      title={authority}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
        padding: "0.15rem 0.55rem",
        borderRadius: "9999px",
        background: tint(t.primary, 14),
        color: t.primary,
        fontFamily: t.fontSans,
        fontSize: "0.75rem",
        fontWeight: 600,
      }}
    >
      <Glyph name="shield" size={13} />
      {label}
    </span>
  );
}
