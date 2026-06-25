import { CenteredCardLayout } from "@wardenx/ui";
// apps/web/src/modules/02-identity — Reset Password (M2 Auth, AUTH polish).
// Spec: docs/design/screens/core/WARDENX_UI_AUTH.md "password reset" (step 2, /reset-password). The reset
// link from /forgot lands here with `?token=…` (or `?error=…` if Better Auth rejected it before redirect).
// Set a new password (length floor mirrors the server's minPasswordLength=12; the server stays
// authoritative and also runs the HIBP breach check), then hand off to /login.
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "./auth-client";

const MIN_PASSWORD_LENGTH = 12; // mirrors emailAndPassword.minPasswordLength (server is authoritative)

export function ResetPassword(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token");
  const linkError = params.get("error");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // No usable token (link expired/invalid, or arrived with an error) — dead-end with a path back.
  if (!token || linkError) {
    return (
      <CenteredCardLayout
        brand={<strong>WardenX</strong>}
        footer={<a href="/forgot">Request a new link</a>}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <h1 style={{ margin: 0, fontSize: "1.1rem" }}>Reset link invalid</h1>
          <p style={{ margin: 0, color: "var(--color-on-surface-variant)", fontSize: "0.9rem" }}>
            This password-reset link is invalid or has expired. Request a new one to continue.
          </p>
        </div>
      </CenteredCardLayout>
    );
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords don’t match.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.resetPassword({
      newPassword: password,
      token: token as string,
    });
    setBusy(false);
    if (err) {
      // Server rejects breached (HIBP) or otherwise-invalid passwords, and stale tokens.
      setError(
        "Couldn’t reset your password. The link may have expired, or choose a less common password.",
      );
      return;
    }
    navigate("/login");
  }

  return (
    <CenteredCardLayout
      brand={<strong>WardenX</strong>}
      footer={<a href="/login">Back to sign in</a>}
    >
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.1rem" }}>Set a new password</h1>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}
        >
          New password
          <input
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            style={field}
          />
        </label>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}
        >
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(ev) => setConfirm(ev.target.value)}
            style={field}
          />
        </label>
        {error ? (
          <p style={{ color: "var(--color-error)", margin: 0, fontSize: "0.85rem" }}>{error}</p>
        ) : null}
        <button type="submit" disabled={busy || !password || !confirm} style={primaryBtn}>
          {busy ? "Saving…" : "Save new password"}
        </button>
      </form>
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
