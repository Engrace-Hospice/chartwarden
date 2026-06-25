import { CenteredCardLayout } from "@wardenx/ui";
// apps/web/src/modules/02-identity — Sign In (M2 Auth, AUTH-T07, ADR-0033 §4).
// Spec: docs/design/screens/core/WARDENX_UI_AUTH.md "Sign in" (/login). Email + password via Better Auth's
// own client (@wardenx/auth/client — NOT the generated REST client). On success the session cookie is
// set and we hand off to organization-select. Passkey + MFA-challenge are follow-ups (need the passkey
// enrollment + 2FA Option-C work). Imports its own M2 package (codePath) + leaves only.
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { useNavigate } from "react-router-dom";
import { authClient } from "./auth-client";

export function SignIn(): JSX.Element {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: err } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (err) {
      setError("Sign-in failed. Check your email and password.");
      return;
    }
    if (data?.twoFactorRedirect) {
      navigate("/login/2fa"); // a second factor is required before the session is fully established
      return;
    }
    navigate("/login/organization"); // bind the org for this session
  }

  async function signInWithPasskey(): Promise<void> {
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.signIn.passkey();
    setBusy(false);
    if (err) {
      setError("Passkey sign-in failed or was cancelled.");
      return;
    }
    navigate("/login/organization");
  }

  return (
    <CenteredCardLayout
      brand={<strong>WardenX</strong>}
      footer={<a href="/forgot">Forgot password?</a>}
    >
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.1rem" }}>Sign in</h1>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}
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
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}
        >
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            style={field}
          />
        </label>
        {error ? (
          <p style={{ color: "var(--color-error)", margin: 0, fontSize: "0.85rem" }}>{error}</p>
        ) : null}
        <button type="submit" disabled={busy || !email || !password} style={primaryBtn}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          margin: "0.5rem 0",
          color: "var(--color-on-surface-variant)",
          fontSize: "0.75rem",
        }}
      >
        <hr style={{ flex: 1, border: 0, borderTop: "1px solid var(--color-outline-variant)" }} />{" "}
        or{" "}
        <hr style={{ flex: 1, border: 0, borderTop: "1px solid var(--color-outline-variant)" }} />
      </div>
      <button type="button" onClick={signInWithPasskey} disabled={busy} style={secondaryBtn}>
        Sign in with a passkey
      </button>
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
const secondaryBtn = {
  padding: "0.625rem 1rem",
  border: "1px solid var(--color-primary)",
  borderRadius: "0.5rem",
  background: "var(--color-surface-lowest)",
  color: "var(--color-primary)",
  cursor: "pointer",
  fontWeight: 600,
} as const;
