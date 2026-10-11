import { Button, Modal, ReverifyLink, useApiClient, useToast } from "@wardenx/ui";
import { useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import type { MemberView } from "./user-management-api";
import { resetUserPassword } from "./user-management-api";

export function ResetUserPasswordDialog({
  open,
  organizationId,
  member,
  onClose,
  onReset,
}: {
  open: boolean;
  organizationId: string;
  member: MemberView | null;
  onClose: () => void;
  onReset: () => void;
}): JSX.Element {
  const client = useApiClient();
  const toast = useToast();
  const [serverGenerated, setServerGenerated] = useState(true);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUpRequired, setStepUpRequired] = useState(false);
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setServerGenerated(true);
    setPassword("");
    setConfirmPassword("");
    setVisible(false);
    setConfirmed(false);
    setError(null);
    setStepUpRequired(false);
    setGeneratedPassword(null);
  }, [open]);

  function close(): void {
    setPassword("");
    setConfirmPassword("");
    setGeneratedPassword(null);
    onClose();
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!member) return;
    setError(null);
    setStepUpRequired(false);
    if (!confirmed) return setError("Confirm that you understand the session and password impact.");
    if (!serverGenerated && password.length < 12)
      return setError("The temporary password must be at least 12 characters.");
    if (!serverGenerated && password !== confirmPassword)
      return setError("The temporary passwords do not match.");
    setBusy(true);
    const result = await resetUserPassword(
      client,
      organizationId,
      member.userId,
      serverGenerated ? { generateTemporaryPassword: true } : { temporaryPassword: password },
    );
    setBusy(false);
    if (!result.ok) {
      const code = result.failure.code;
      setStepUpRequired(code === "STEP_UP_REQUIRED");
      setError(
        code === "SHARED_IDENTITY_RESET_RESTRICTED"
          ? "This identity is shared across organizations. An authorized platform administrator must reset it."
          : code === "USER_INACTIVE"
            ? "An inactive account cannot be reset. Reactivate the account first if appropriate."
            : code === "STEP_UP_REQUIRED"
              ? "Re-verify your identity before resetting this password. The reset was not performed."
              : result.failure.message,
      );
      return;
    }
    setPassword("");
    setConfirmPassword("");
    setGeneratedPassword(result.value.temporaryPassword ?? null);
    onReset();
    toast.show("Password reset. Existing sessions were revoked.", { tone: "success" });
    if (!result.value.temporaryPassword) close();
  }

  const label = member?.displayName ?? member?.username ?? member?.email ?? "this user";

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : close}
      ariaLabel="Reset User Password"
      role="alertdialog"
      width="36rem"
      accent="var(--color-warning)"
    >
      <form onSubmit={submit} style={bodyStyle}>
        <div>
          <p style={eyebrowStyle}>Security-sensitive action</p>
          <h2 style={titleStyle}>Reset User Password</h2>
          <p style={descriptionStyle}>
            {generatedPassword
              ? `The password for ${label} was reset and active sessions were revoked.`
              : `Replace the password for ${label}. Active sessions will be revoked, and the user must change the temporary password after their next password-based sign-in.`}
          </p>
        </div>

        {generatedPassword ? (
          <div style={secretStyle}>
            <strong>Temporary password — shown once</strong>
            <code style={{ overflowWrap: "anywhere" }}>{generatedPassword}</code>
            <Button
              type="button"
              size="sm"
              tone="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(generatedPassword);
                toast.show("Temporary password copied.", { tone: "success" });
              }}
            >
              Copy password
            </Button>
          </div>
        ) : (
          <>
            <div style={modeStyle}>
              <button
                type="button"
                className={serverGenerated ? "wx-btn-primary" : "wx-btn-secondary"}
                onClick={() => setServerGenerated(true)}
              >
                Generate Secure Password
              </button>
              <button
                type="button"
                className={!serverGenerated ? "wx-btn-primary" : "wx-btn-secondary"}
                onClick={() => setServerGenerated(false)}
              >
                Set Password
              </button>
            </div>
            {!serverGenerated ? (
              <div style={passwordGridStyle}>
                <label style={fieldStyle}>
                  Temporary Password
                  <input
                    type={visible ? "text" : "password"}
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={256}
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    style={inputStyle}
                  />
                </label>
                <label style={fieldStyle}>
                  Confirm Password
                  <input
                    type={visible ? "text" : "password"}
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={256}
                    required
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    style={inputStyle}
                  />
                </label>
                <label style={checkStyle}>
                  <input
                    type="checkbox"
                    checked={visible}
                    onChange={(event) => setVisible(event.target.checked)}
                  />{" "}
                  Show passwords
                </label>
              </div>
            ) : (
              <p style={descriptionStyle}>
                WardenX will generate a secure temporary password and display it once.
              </p>
            )}
            <label style={confirmationStyle}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                I understand this replaces the current password and revokes active sessions.
              </span>
            </label>
          </>
        )}

        {error ? (
          <div role="alert" style={errorStyle}>
            {error}
            {stepUpRequired ? (
              <div style={{ marginTop: "0.6rem" }}>
                <ReverifyLink>Re-verify now</ReverifyLink>
              </div>
            ) : null}
          </div>
        ) : null}
        <div style={footerStyle}>
          <Button type="button" tone="tertiary" onClick={close} disabled={busy}>
            {generatedPassword ? "Done" : "Cancel"}
          </Button>
          {!generatedPassword ? (
            <Button type="submit" tone="danger" disabled={busy || !confirmed}>
              {busy ? "Resetting…" : "Reset Password"}
            </Button>
          ) : null}
        </div>
      </form>
    </Modal>
  );
}

const bodyStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "1.1rem",
  padding: "1.5rem",
};
const eyebrowStyle = {
  margin: 0,
  color: "var(--color-warning)",
  fontSize: "0.72rem",
  fontWeight: 700,
  letterSpacing: "0.08em",
};
const titleStyle = { margin: "0.2rem 0 0", fontSize: "1.3rem" };
const descriptionStyle = {
  margin: "0.35rem 0 0",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.83rem",
  lineHeight: 1.5,
};
const modeStyle = { display: "flex", flexWrap: "wrap" as const, gap: "0.5rem" };
const passwordGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))",
  gap: "0.75rem",
};
const fieldStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.35rem",
  fontSize: "0.8rem",
  fontWeight: 650,
};
const inputStyle = {
  padding: "0.6rem 0.7rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-md)",
};
const checkStyle = { display: "flex", gap: "0.45rem", alignItems: "center", fontSize: "0.78rem" };
const confirmationStyle = {
  display: "flex",
  gap: "0.55rem",
  alignItems: "flex-start",
  padding: "0.8rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  fontSize: "0.82rem",
  lineHeight: 1.4,
};
const errorStyle = {
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  color: "var(--color-error)",
  background: "color-mix(in srgb, var(--color-error) 9%, transparent)",
  fontSize: "0.82rem",
};
const footerStyle = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
  paddingTop: "0.75rem",
  borderTop: "1px solid var(--color-outline-variant)",
};
const secretStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.65rem",
  padding: "1rem",
  border: "1px solid color-mix(in srgb, var(--color-warning) 45%, transparent)",
  borderRadius: "var(--radius-lg)",
  background: "color-mix(in srgb, var(--color-warning) 8%, transparent)",
};
