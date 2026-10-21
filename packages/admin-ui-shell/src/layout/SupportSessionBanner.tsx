// @chartwarden/admin-ui-shell — persistent "support session active" banner (M34 §3.10 / §5.1 / D8/D21).
//
// A support session is a break-glass *variant*: WardenX-staff PHI access that ALSO carries a
// `support_consent_grant` reference — consent narrows, never replaces, dual control (M34-F01). While
// a session is open the platform-ops console paints this ambient banner at the very top of the shell,
// the same way M2 break-glass does, so the operator can never forget they are inside a consented,
// fully-audited window. Spec §5.1 `/support/sessions/:id` "Persistent banner; 'Elevate for PHI read'
// CTA; 'Close session' CTA"; §5.3 surfaces consequences before the privileged action.
//
// Lantern: this is the one place an `alert`/critical tone is ambient (DESIGN.md §8). Token-driven,
// No-Line; the optional PHI-elevation affordance is a Guardrail moment, not a casual button. We build
// on the shared @chartwarden/ui Sensitivity surface so the consented-support session reads as a sibling
// of break-glass rather than a bespoke bar.
import { CountdownChip, Glyph, t } from "@chartwarden/ui";
import type { JSX, ReactNode } from "react";

export interface SupportSessionBannerProps {
  /** The active support session id (mono identifier; shown for audit traceability). */
  sessionId: string;
  /** The tenant the session is scoped to (org slug or display name). */
  tenant: ReactNode;
  /** The `support_consent_grant` reference that authorizes this session (D8 — consent narrows). */
  grantRef?: ReactNode;
  /** Session hard-expiry; rendered as a live countdown so the operator sees the window closing. */
  expiresAt?: Date | string;
  /** Whether PHI read has already been elevated this session (gates the elevate affordance). */
  phiElevated?: boolean;
  /** Elevate-for-PHI-read handler — MUST run the §6 step-up + audit (support_session.elevate_phi_read). */
  onElevatePhiRead?: () => void;
  /** Close-session handler (support_session.close). Always offered. */
  onCloseSession: () => void;
}

/**
 * The ambient banner shown for the lifetime of an open support session. Pin it to the top of the
 * PlatformOpsShell (its `sessionBanner` slot) so it spans every tenant surface during the session.
 */
export function SupportSessionBanner({
  sessionId,
  tenant,
  grantRef,
  expiresAt,
  phiElevated = false,
  onElevatePhiRead,
  onCloseSession,
}: SupportSessionBannerProps): JSX.Element {
  return (
    <div
      className="wx-support-session-banner"
      role="alert"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "0.75rem",
        padding: "0.6rem 1.25rem",
        // §8 ambient alert surface — the controlled/consented-access window paints critical.
        background: t.alert,
        color: "#ffffff",
        fontFamily: t.fontSans,
        fontSize: "0.875rem",
      }}
    >
      <Glyph name="shield" size={18} label="Support session active" />
      <strong>Support session active</strong>
      <span style={{ opacity: 0.95 }}>— tenant-consented, all actions audited</span>
      <span style={{ opacity: 0.9 }}>
        · {tenant} ·{" "}
        <span className="wx-data-md" style={{ fontFamily: t.fontMono }}>
          {sessionId}
        </span>
      </span>
      {grantRef ? (
        <span style={{ opacity: 0.9 }}>
          · grant{" "}
          <span className="wx-data-md" style={{ fontFamily: t.fontMono }}>
            {grantRef}
          </span>
        </span>
      ) : null}
      {expiresAt ? <CountdownChip dueAt={expiresAt} label="Expires" /> : null}
      <div style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
        {onElevatePhiRead && !phiElevated ? (
          <button type="button" onClick={onElevatePhiRead} style={pillButton}>
            Elevate for PHI read
          </button>
        ) : null}
        {phiElevated ? (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", opacity: 0.95 }}
          >
            <Glyph name="eye" size={14} /> PHI read elevated
          </span>
        ) : null}
        <button type="button" onClick={onCloseSession} style={pillButton}>
          Close session
        </button>
      </div>
    </div>
  );
}

// Pill button over the ambient alert surface: a hairline white border, never an opaque fill.
const pillButton = {
  border: "1px solid color-mix(in srgb, #ffffff 60%, transparent)",
  background: "transparent",
  color: "#ffffff",
  fontWeight: 600,
  borderRadius: "9999px",
  padding: "0.25rem 0.75rem",
  cursor: "pointer",
} as const;
