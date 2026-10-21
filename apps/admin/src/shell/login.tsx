import { Button, CenteredCardLayout, InlineAlert, TextField } from "@chartwarden/ui";
// apps/admin/src/shell — Sign in (M1/M34, ADR-0030). Adapted from
// apps/web/src/modules/02-identity/sign-in.tsx: email + password through Better Auth's own client
// (@chartwarden/auth/client, NOT the generated REST client); on success the session cookie is set and we
// hand off to organization-select. Deliberately simplified vs. the tenant web app's version — no
// 2FA/passkey/forgot-password flows, since this console has no self-service account recovery surface
// and platform-ops accounts are provisioned by hand, not self-registered. Whether the signed-in account
// may use the console (platform_ops only) is decided after org selection by RequireChrome, not here.
// Laid out like the console's step-up page (the shared StepUpCard): brand lockup above the card, kit fields.
import { useState } from "react";
import type { FormEvent, JSX } from "react";
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
    <CenteredCardLayout brand={<BrandLockup />}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-lg font-semibold">Sign in</h1>
          <p className="m-0 text-sm text-[var(--color-muted)]">
            Platform-ops console. Sign in to continue.
          </p>
        </div>
        <TextField
          label="Email"
          type="email"
          autoComplete="username"
          placeholder="you@chartwarden.com"
          required
          value={email}
          onChange={(ev) => setEmail(ev.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••••"
          required
          value={password}
          onChange={(ev) => setPassword(ev.target.value)}
        />
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <Button type="submit" size="lg" loading={busy} disabled={!email || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </CenteredCardLayout>
  );
}
