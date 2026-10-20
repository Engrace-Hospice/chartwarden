import { CenteredCardLayout, useApiClient } from "@wardenx/ui";
import { useEffect, useState } from "react";
import type { CSSProperties, FormEvent, JSX } from "react";
import { useNavigate } from "react-router-dom";
import {
  clearPendingNotificationLink,
  takePendingNotificationLink,
} from "../../shell/pending-deep-link";
import { authClient } from "./auth-client";
import { BrandLockup } from "./brand-lockup";

export function RequiredPasswordChange(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void client.GET("/api/v1/auth/credential-status").then(({ data, error: loadError }) => {
      if (!active) return;
      if (loadError || !data) {
        navigate("/login", { replace: true });
        return;
      }
      if (!data.passwordChangeRequired) {
        void authClient.getSession().then(({ data: sessionData }) => {
          // WP 4.8: a notification link opened before sign-in finishes here too (the stash is read once, so it cannot linger).
          navigate(
            sessionData?.session?.activeOrganizationId
              ? (takePendingNotificationLink() ?? "/")
              : "/login/organization",
            { replace: true },
          );
        });
        return;
      }
      setChecking(false);
    });
    return () => {
      active = false;
    };
  }, [client, navigate]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (newPassword.length < 12) {
      setError("Your new password must be at least 12 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("The new passwords do not match.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("Choose a new password that is different from the temporary password.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: changeError } = await client.POST(
      "/api/v1/auth/password/complete-required-change",
      { body: { currentPassword, newPassword } },
    );
    setBusy(false);
    if (changeError) {
      const code = changeError.error?.code;
      setError(
        code === "INVALID_CURRENT_PASSWORD"
          ? "The temporary password is incorrect."
          : code === "PASSWORD_COMPROMISED"
            ? "Choose a password that has not appeared in a known breach."
            : code === "CREDENTIAL_STATE_CHANGED"
              ? "Your credential changed in another session. Sign in again to continue."
              : "Your password could not be changed. Check the requirements and try again.",
      );
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    await authClient.signOut().catch(() => undefined);
    navigate("/login?passwordChanged=1", { replace: true });
  }

  async function signOut(): Promise<void> {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    await authClient.signOut().catch(() => undefined);
    clearPendingNotificationLink();
    navigate("/login", { replace: true });
  }

  return (
    <CenteredCardLayout>
      <div style={stackStyle}>
        <BrandLockup />
        <div style={{ textAlign: "center" }}>
          <h1 style={{ margin: 0, fontSize: "1.3rem" }}>Change Your Password</h1>
          <p style={descriptionStyle}>
            For security reasons, you need to set a new password before accessing WardenX.
          </p>
        </div>
        {checking ? (
          <output style={descriptionStyle}>Checking your account…</output>
        ) : (
          <form onSubmit={submit} style={stackStyle}>
            <PasswordField
              label="Temporary Password"
              value={currentPassword}
              onChange={setCurrentPassword}
              visible={showPasswords}
              autoComplete="current-password"
            />
            <PasswordField
              label="New Password"
              value={newPassword}
              onChange={setNewPassword}
              visible={showPasswords}
              autoComplete="new-password"
            />
            <PasswordField
              label="Confirm New Password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              visible={showPasswords}
              autoComplete="new-password"
            />
            <p style={hintStyle}>Use at least 12 characters. Avoid reused or breached passwords.</p>
            <label style={checkStyle}>
              <input
                type="checkbox"
                checked={showPasswords}
                onChange={(event) => setShowPasswords(event.target.checked)}
              />
              Show passwords
            </label>
            {error ? (
              <p role="alert" style={errorStyle}>
                {error}
              </p>
            ) : null}
            <button type="submit" disabled={busy} style={primaryStyle}>
              {busy ? "Changing password…" : "Change Password"}
            </button>
            <button type="button" onClick={() => void signOut()} disabled={busy} style={linkStyle}>
              Sign Out
            </button>
          </form>
        )}
      </div>
    </CenteredCardLayout>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  visible,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  autoComplete: string;
}): JSX.Element {
  return (
    <label style={fieldWrapStyle}>
      <span>{label}</span>
      <input
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        required
        maxLength={256}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={inputStyle}
      />
    </label>
  );
}

const stackStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.9rem" };
const descriptionStyle: CSSProperties = {
  margin: "0.35rem 0 0",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.86rem",
};
const fieldWrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
  fontSize: "0.82rem",
  fontWeight: 600,
};
const inputStyle: CSSProperties = {
  padding: "0.65rem 0.75rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
};
const hintStyle: CSSProperties = {
  margin: "-0.35rem 0 0",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.76rem",
};
const checkStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
  fontSize: "0.8rem",
};
const errorStyle: CSSProperties = { color: "var(--color-error)", margin: 0, fontSize: "0.84rem" };
const primaryStyle: CSSProperties = {
  padding: "0.7rem 1rem",
  border: 0,
  borderRadius: "999px",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontWeight: 650,
  cursor: "pointer",
};
const linkStyle: CSSProperties = {
  border: 0,
  background: "transparent",
  color: "var(--color-primary)",
  cursor: "pointer",
};
