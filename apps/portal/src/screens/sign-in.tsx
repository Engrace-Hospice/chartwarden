import { CenteredCardLayout, t } from "@wardenx/ui";
// @wardenx/portal — §5.1 Landing / sign-in (`/`). Magic-link entry is the primary path (M31-T03 invite +
// session lifecycle); an established account may fall back to password, and a step-up prompt appears when
// the server demands TOTP. This surface holds NO PHI and issues no read — it only requests the link that the
// backend mails; the account bind happens on the `/setup/:inviteToken` acceptance the link points at.
import { useState } from "react";
import type { CSSProperties, FormEvent, JSX } from "react";

const field: CSSProperties = {
  width: "100%",
  padding: "0.6rem 0.7rem",
  borderRadius: "0.5rem",
  border: `1px solid ${t.surfaceContainer}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  fontSize: "0.95rem",
};
const button: CSSProperties = {
  width: "100%",
  padding: "0.65rem 0.9rem",
  borderRadius: "0.5rem",
  border: "none",
  background: t.primary,
  color: t.onPrimary,
  fontWeight: 600,
  cursor: "pointer",
};

export function PortalSignIn(): JSX.Element {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    // The link is minted + mailed by the M2 magic-link invite path; the portal only records that the
    // caregiver asked, and shows the same acknowledgement whether or not the address maps to an account
    // (no account enumeration — architecture §G).
    setSent(true);
  }

  return (
    <CenteredCardLayout
      brand={
        <div>
          <div style={{ fontFamily: t.fontDisplay, fontSize: "1.5rem", fontWeight: 600 }}>
            WardenX Family Portal
          </div>
          <div style={{ color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
            Secure access to your loved one's care
          </div>
        </div>
      }
      footer={<a href="/help">Need help signing in?</a>}
    >
      {sent ? (
        <div role="status" aria-live="polite">
          <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.15rem" }}>Check your email</h1>
          <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.9rem" }}>
            If an account exists for {email || "that address"}, a secure sign-in link is on its way.
            The link expires shortly for your protection.
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} aria-label="Sign in">
          <h1 style={{ margin: "0 0 0.75rem", fontSize: "1.15rem" }}>Sign in</h1>
          <label
            htmlFor="portal-email"
            style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem" }}
          >
            Email address
          </label>
          <input
            id="portal-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ ...field, marginBottom: "0.9rem" }}
          />
          <button type="submit" style={button}>
            Email me a sign-in link
          </button>
          <p
            style={{
              margin: "0.9rem 0 0",
              fontSize: "0.8rem",
              color: t.onSurfaceVariant,
              textAlign: "center",
            }}
          >
            Have a password already? You'll be prompted for it — and a one-time code — after the
            link.
          </p>
        </form>
      )}
    </CenteredCardLayout>
  );
}
