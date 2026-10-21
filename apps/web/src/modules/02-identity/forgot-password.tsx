import { CenteredCardLayout } from "@chartwarden/ui";
// apps/web/src/modules/02-identity — Forgot Password (M2 Auth, AUTH polish).
// Spec: docs/design/screens/core/WARDENX_UI_AUTH.md "password reset" (step 1, /forgot). Enter the account
// email; Better Auth mints a single-use reset token and (via M36, a follow-up) emails the link, which
// lands on /reset-password?token=…. We always show the same neutral confirmation whether or not the
// email exists — no account-enumeration leak (M2 §3.1 / §7.5 no-leak).
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { authClient } from "./auth-client";
import { BrandLockup } from "./brand-lockup";

export function ForgotPassword(): JSX.Element {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    // The reset link returns the user to /reset-password with the token in the query.
    const redirectTo = `${window.location.origin}/reset-password`;
    await authClient.requestPasswordReset({ email, redirectTo });
    setBusy(false);
    // Neutral confirmation regardless of outcome — never reveal whether the email is registered.
    setSent(true);
  }

  return (
    <CenteredCardLayout
      brand={<BrandLockup />}
      footer={<a href="/login">Back to sign in</a>}
    >
      {sent ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <h1 style={{ margin: 0, fontSize: "1.1rem" }}>Check your email</h1>
          <p style={{ margin: 0, color: "var(--color-on-surface-variant)", fontSize: "0.9rem" }}>
            If an account exists for <strong>{email}</strong>, we’ve sent a link to reset your
            password. The link expires shortly for your security.
          </p>
        </div>
      ) : (
        <form
          onSubmit={submit}
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <h1 style={{ margin: 0, fontSize: "1.1rem" }}>Reset your password</h1>
          <p style={{ margin: 0, color: "var(--color-on-surface-variant)", fontSize: "0.85rem" }}>
            Enter your email and we’ll send you a link to set a new password.
          </p>
          <p style={{ margin: 0, color: "var(--color-on-surface-variant)", fontSize: "0.78rem" }}>
            If your account does not have an email address, contact your organization administrator
            for assistance.
          </p>
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.25rem",
              fontSize: "0.85rem",
            }}
          >
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              style={field}
            />
          </label>
          <button type="submit" disabled={busy || !email} style={primaryBtn}>
            {busy ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}
    </CenteredCardLayout>
  );
}

const field = {
  padding: "0.5rem 0.625rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "0.5rem",
} as const;
const primaryBtn = {
  padding: "0.625rem 1rem",
  border: "none",
  borderRadius: "0.5rem",
  background: "var(--color-primary)",
  color: "var(--color-surface-lowest)",
  cursor: "pointer",
  fontWeight: 600,
} as const;
