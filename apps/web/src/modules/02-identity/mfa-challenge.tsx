import { CenteredCardLayout } from "@wardenx/ui";
// apps/web/src/modules/02-identity — MFA Challenge (M2 Auth, ADR-0034 task 4).
// Spec: docs/design/screens/core/WARDENX_UI_AUTH.md "MFA challenge" (/login/2fa). Reached when sign-in
// returns twoFactorRedirect (a 2FA-enrolled user). TOTP 6-digit or a backup code, via Better Auth's
// client (twoFactor.verifyTotp / verifyBackupCode). On success the session completes → org-select.
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { useNavigate } from "react-router-dom";
import { authClient } from "./auth-client";

export function MfaChallenge(): JSX.Element {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code })
      : await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (err) {
      setError(
        useBackup
          ? "Invalid backup code."
          : "Invalid code. Check your authenticator and try again.",
      );
      return;
    }
    navigate("/login/organization");
  }

  return (
    <CenteredCardLayout
      brand={<strong>WardenX</strong>}
      footer={
        <button
          type="button"
          onClick={() => {
            setUseBackup((b) => !b);
            setCode("");
            setError(null);
          }}
          style={linkBtn}
        >
          {useBackup ? "Use authenticator code" : "Use a backup code"}
        </button>
      }
    >
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.1rem" }}>Two-factor authentication</h1>
        <p style={{ margin: 0, color: "var(--color-on-surface-variant)", fontSize: "0.85rem" }}>
          {useBackup
            ? "Enter one of your backup codes."
            : "Enter the 6-digit code from your authenticator app."}
        </p>
        <input
          inputMode={useBackup ? "text" : "numeric"}
          autoComplete="one-time-code"
          required
          placeholder={useBackup ? "Backup code" : "123456"}
          value={code}
          onChange={(ev) => setCode(ev.target.value.trim())}
          style={field}
        />
        {error ? (
          <p style={{ color: "var(--color-error)", margin: 0, fontSize: "0.85rem" }}>{error}</p>
        ) : null}
        <button type="submit" disabled={busy || !code} style={primaryBtn}>
          {busy ? "Verifying…" : "Verify"}
        </button>
      </form>
    </CenteredCardLayout>
  );
}

const field = {
  padding: "0.5rem 0.625rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "0.5rem",
  letterSpacing: "0.1em",
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
const linkBtn = {
  background: "none",
  border: "none",
  color: "var(--color-primary)",
  cursor: "pointer",
  fontSize: "0.85rem",
} as const;
