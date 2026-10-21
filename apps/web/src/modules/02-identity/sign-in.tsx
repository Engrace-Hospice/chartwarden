import { CenteredCardLayout, t, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/02-identity — Sign In (M2 Auth, AUTH-T07, ADR-0033 §4).
// Spec: docs/design/screens/core/WARDENX_UI_AUTH.md "Sign in" (/login). Matched to the P0 Pencil frame
// (wardenx-P0-foundation.pen `a1dbhD`, "Card Sign in"): a single centered card — gold hearth mark +
// Fraunces "WardenX" lockup, "Sign in" title + subtitle, filled fields, a full-width pill button, and a
// "Forgot password? · Use a passkey" links row. Email + password go through Better Auth's own client
// (@chartwarden/auth/client — NOT the generated REST client); on success the session cookie is set and we
// hand off to organization-select. Imports its own M2 package (codePath) + leaves only.
import { useState } from "react";
import type { CSSProperties, FormEvent, JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "./auth-client";
import { authenticationContinuation, continuationPath } from "./auth-continuation";
import { BrandLockup } from "./brand-lockup";

export function SignIn(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const value = identifier.trim();
    const { data, error: err } = value.includes("@")
      ? await authClient.signIn.email({ email: value, password })
      : await authClient.signIn.username({ username: value, password });
    if (err) {
      setBusy(false);
      setError("Invalid username/email or password.");
      return;
    }
    if (data?.twoFactorRedirect) {
      setBusy(false);
      navigate("/login/2fa"); // a second factor is required before the session is fully established
      return;
    }
    const continuation = await authenticationContinuation(client);
    setBusy(false);
    const path = continuationPath(continuation);
    if (path) navigate(path);
    else
      setError(
        continuation.kind === "error" ? continuation.message : "Sign-in could not continue.",
      );
  }

  async function signInWithPasskey(): Promise<void> {
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.signIn.passkey();
    if (err) {
      setBusy(false);
      setError("Passkey sign-in failed or was cancelled.");
      return;
    }
    const continuation = await authenticationContinuation(client);
    setBusy(false);
    const path = continuationPath(continuation);
    if (path) navigate(path);
    else
      setError(
        continuation.kind === "error" ? continuation.message : "Sign-in could not continue.",
      );
  }

  return (
    <CenteredCardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: "1.125rem" }}>
        <BrandLockup />
        <div style={{ textAlign: "center" }}>
          <h1 style={titleStyle}>Sign in</h1>
          <p style={subStyle}>Welcome back. Sign in to continue.</p>
        </div>

        {searchParams.get("passwordChanged") === "1" ? (
          <output style={successStyle}>
            Your password was changed. Sign in with your new password to continue.
          </output>
        ) : null}

        <form
          onSubmit={submit}
          style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}
        >
          <label style={fieldWrap}>
            <span style={labelStyle}>Username or Email</span>
            <input
              type="text"
              autoComplete="username"
              placeholder="Enter your username or email"
              required
              value={identifier}
              onChange={(ev) => setIdentifier(ev.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={fieldWrap}>
            <span style={labelStyle}>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              placeholder="••••••••••"
              required
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              style={inputStyle}
            />
          </label>
          {error ? (
            <p role="alert" style={errorStyle}>
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy || !identifier.trim() || !password}
            style={primaryBtn}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div style={linksRow}>
          <a href="/forgot" style={linkStyle}>
            Forgot password?
          </a>
          <button type="button" onClick={signInWithPasskey} disabled={busy} style={linkBtn}>
            Use a passkey
          </button>
        </div>
      </div>
    </CenteredCardLayout>
  );
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.25rem",
  color: t.onSurface,
};
const subStyle: CSSProperties = {
  margin: "0.25rem 0 0",
  color: t.onSurfaceVariant,
  fontSize: "0.85rem",
};
const fieldWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.35rem" };
const labelStyle: CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 500,
  color: t.onSurfaceVariant,
};
const inputStyle: CSSProperties = {
  padding: "0.65rem 0.75rem",
  border: "none",
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
  outline: "none",
  fontSize: "0.9rem",
  color: t.onSurface,
};
const errorStyle: CSSProperties = { color: t.error, margin: 0, fontSize: "0.85rem" };
const successStyle: CSSProperties = {
  color: "var(--color-success)",
  background: "color-mix(in srgb, var(--color-success) 10%, transparent)",
  borderRadius: t.radiusMd,
  padding: "0.65rem 0.75rem",
  margin: 0,
  fontSize: "0.82rem",
};
const primaryBtn: CSSProperties = {
  padding: "0.7rem 1rem",
  border: "none",
  borderRadius: "9999px",
  background: t.primary,
  color: t.onPrimary,
  cursor: "pointer",
  fontWeight: 600,
};
const linksRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};
const linkStyle: CSSProperties = { color: t.primary, fontSize: "0.85rem", textDecoration: "none" };
const linkBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  color: t.primary,
  fontSize: "0.85rem",
  cursor: "pointer",
  padding: 0,
};
