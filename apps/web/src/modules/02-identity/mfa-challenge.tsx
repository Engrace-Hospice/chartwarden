import { CenteredCardLayout, t, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/02-identity — MFA Challenge (M2 Auth, ADR-0034 task 4).
// Spec: docs/design/screens/core/WARDENX_UI_AUTH.md "MFA challenge" (/login/2fa). Matched to the P0
// Pencil frame (wardenx-P0-foundation.pen `a1dbhD`, "Card Two-factor verification"): branded card,
// Fraunces title + subtitle, a segmented 6-digit code input, a full-width pill Verify button, and a
// footer link. Reached when sign-in returns twoFactorRedirect (a 2FA-enrolled user). TOTP 6-digit or a
// backup code, via Better Auth's client (twoFactor.verifyTotp / verifyBackupCode). On success the
// session completes → org-select. NB: our 2FA is authenticator-based (TOTP), so the frame's "Resend
// code" link — which implies SMS/email OTP — is replaced by the functional backup-code toggle.
import { useRef, useState } from "react";
import type { CSSProperties, FormEvent, JSX } from "react";
import { useNavigate } from "react-router-dom";
import { authClient } from "./auth-client";
import { authenticationContinuation, continuationPath } from "./auth-continuation";
import { BrandLockup } from "./brand-lockup";

const OTP_LEN = 6;

export function MfaChallenge(): JSX.Element {
  const client = useApiClient();
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
    if (err) {
      setBusy(false);
      setError(
        useBackup
          ? "Invalid backup code."
          : "Invalid code. Check your authenticator and try again.",
      );
      return;
    }
    const continuation = await authenticationContinuation(client);
    setBusy(false);
    const path = continuationPath(continuation);
    if (path) navigate(path);
    else
      setError(
        continuation.kind === "error" ? continuation.message : "Verification could not continue.",
      );
  }

  return (
    <CenteredCardLayout>
      <div style={{ display: "flex", flexDirection: "column", gap: "1.125rem" }}>
        <BrandLockup />
        <div style={{ textAlign: "center" }}>
          <h1 style={titleStyle}>Two-factor verification</h1>
          <p style={subStyle}>
            {useBackup
              ? "Enter one of your backup codes."
              : "Enter the 6-digit code from your authenticator."}
          </p>
        </div>

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {useBackup ? (
            <input
              inputMode="text"
              autoComplete="one-time-code"
              required
              placeholder="Backup code"
              value={code}
              onChange={(ev) => setCode(ev.target.value.trim())}
              style={backupInput}
            />
          ) : (
            <OtpInput value={code} onChange={setCode} />
          )}
          {error ? (
            <p role="alert" style={errorStyle}>
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy || (useBackup ? !code : code.length < OTP_LEN)}
            style={primaryBtn}
          >
            {busy ? "Verifying…" : "Verify"}
          </button>
        </form>

        <div style={{ textAlign: "center" }}>
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
        </div>
      </div>
    </CenteredCardLayout>
  );
}

// Segmented 6-digit OTP entry (frame: six mono cells). One numeric box per digit, auto-advancing on
// entry and back-stepping on Backspace; a paste fills all six. The combined value is the `code`.
function OtpInput({
  value,
  onChange,
}: { value: string; onChange: (v: string) => void }): JSX.Element {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: OTP_LEN }, (_, i) => value[i] ?? "");

  function setAt(i: number, d: string): void {
    const next = (value.slice(0, i) + d + value.slice(i + 1)).replace(/\D/g, "").slice(0, OTP_LEN);
    onChange(next);
    if (d && i < OTP_LEN - 1) refs.current[i + 1]?.focus();
  }

  return (
    <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center" }}>
      {digits.map((d, i) => (
        <input
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length positional OTP cells.
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1}`}
          maxLength={1}
          value={d}
          onChange={(e) => setAt(i, e.target.value.replace(/\D/g, "").slice(-1))}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !d && i > 0) refs.current[i - 1]?.focus();
          }}
          onPaste={(e) => {
            e.preventDefault();
            const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, OTP_LEN);
            if (pasted) {
              onChange(pasted);
              refs.current[Math.min(pasted.length, OTP_LEN - 1)]?.focus();
            }
          }}
          style={otpBox}
        />
      ))}
    </div>
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
const otpBox: CSSProperties = {
  width: "2.75rem",
  height: "3.25rem",
  textAlign: "center",
  fontFamily: t.fontMono,
  fontSize: "1.375rem",
  fontWeight: 600,
  border: "none",
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
  color: t.onSurface,
  outline: "none",
};
const backupInput: CSSProperties = {
  padding: "0.65rem 0.75rem",
  border: "none",
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
  outline: "none",
  fontSize: "0.95rem",
  letterSpacing: "0.1em",
  color: t.onSurface,
  textAlign: "center",
};
const errorStyle: CSSProperties = {
  color: t.error,
  margin: 0,
  fontSize: "0.85rem",
  textAlign: "center",
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
const linkBtn: CSSProperties = {
  background: "none",
  border: "none",
  color: t.primary,
  cursor: "pointer",
  fontSize: "0.85rem",
};
