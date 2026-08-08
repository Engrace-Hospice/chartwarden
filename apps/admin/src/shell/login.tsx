import { CenteredCardLayout, t } from "@wardenx/ui";
// apps/admin/src/shell — Sign in (M1/M34, ADR-0030). Adapted from
// apps/web/src/modules/02-identity/sign-in.tsx: email + password through Better Auth's own client
// (@wardenx/auth/client, NOT the generated REST client); on success the session cookie is set and we
// hand off to organization-select. Deliberately simplified vs. the tenant web app's version — no
// 2FA/passkey/forgot-password flows, since this console has no self-service account recovery surface
// and platform-ops accounts are provisioned by hand, not self-registered.
import { useState } from "react";
import type { CSSProperties, FormEvent, JSX } from "react";
import { useNavigate } from "react-router-dom";
import { authClient } from "./auth-client";
import { BrandLockup } from "./brand-lockup";

export function Login(): JSX.Element {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (err) {
      setError("Sign-in failed. Check your email and password.");
      return;
    }
    navigate("/login/organization"); // bind the org for this session
  }

  return (
    <CenteredCardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: "1.125rem" }}>
        <BrandLockup />
        <div style={{ textAlign: "center" }}>
          <h1 style={titleStyle}>Sign in</h1>
          <p style={subStyle}>Platform-ops console. Sign in to continue.</p>
        </div>

        <form
          onSubmit={submit}
          style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}
        >
          <label style={fieldWrap}>
            <span style={labelStyle}>Email</span>
            <input
              type="email"
              autoComplete="username"
              placeholder="you@wardenx.app"
              required
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
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
          {error ? <p style={errorStyle}>{error}</p> : null}
          <button type="submit" disabled={busy || !email || !password} style={primaryBtn}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
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
const primaryBtn: CSSProperties = {
  padding: "0.7rem 1rem",
  border: "none",
  borderRadius: "9999px",
  background: t.primary,
  color: t.onPrimary,
  cursor: "pointer",
  fontWeight: 600,
};
