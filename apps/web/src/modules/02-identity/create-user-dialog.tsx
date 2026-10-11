import { Button, Modal, ReverifyLink, useApiClient, useToast } from "@wardenx/ui";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent, JSX } from "react";
import type { LocationOption, ProvisionedUser, RoleOption } from "./user-management-api";
import { provisionUser } from "./user-management-api";

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CreateUserDialog({
  open,
  organizationId,
  roles,
  locations,
  onClose,
  onCreated,
}: {
  open: boolean;
  organizationId: string;
  roles: readonly RoleOption[];
  locations: readonly LocationOption[];
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const client = useApiClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [serverGenerated, setServerGenerated] = useState(true);
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUpRequired, setStepUpRequired] = useState(false);
  const [created, setCreated] = useState<ProvisionedUser | null>(null);

  const roleNames = useMemo(
    () => roles.filter((role) => roleIds.includes(role.roleId)).map((role) => role.name),
    [roleIds, roles],
  );

  useEffect(() => {
    if (open) return;
    setName("");
    setUsername("");
    setEmail("");
    setRoleIds([]);
    setLocationIds([]);
    setServerGenerated(true);
    setPassword("");
    setPasswordConfirm("");
    setPasswordVisible(false);
    setError(null);
    setStepUpRequired(false);
    setCreated(null);
  }, [open]);

  function close(): void {
    setPassword("");
    setPasswordConfirm("");
    setCreated(null);
    onClose();
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setStepUpRequired(false);
    if (!name.trim()) return setError("Full name is required.");
    if (!USERNAME_RE.test(username.trim()))
      return setError(
        "Username must be 3–32 characters using letters, numbers, periods, hyphens or underscores.",
      );
    if (email.trim() && !EMAIL_RE.test(email.trim()))
      return setError("Enter a valid email address or leave it blank.");
    if (roleIds.length === 0) return setError("Select at least one authorized role.");
    if (!serverGenerated && password.length < 12)
      return setError("The temporary password must be at least 12 characters.");
    if (!serverGenerated && password !== passwordConfirm)
      return setError("The temporary passwords do not match.");

    setBusy(true);
    const result = await provisionUser(client, organizationId, {
      name: name.trim(),
      username: username.trim(),
      ...(email.trim() ? { email: email.trim() } : {}),
      roleIds,
      ...(locationIds.length > 0 ? { defaultLocationIds: locationIds } : {}),
      ...(serverGenerated ? { generateTemporaryPassword: true } : { temporaryPassword: password }),
    });
    setBusy(false);
    if (!result.ok) {
      setStepUpRequired(result.failure.code === "STEP_UP_REQUIRED");
      setError(
        result.failure.code === "IDENTITY_CONFLICT"
          ? "That username or email is unavailable. Choose a different identifier."
          : result.failure.code === "STEP_UP_REQUIRED"
            ? "Re-verify your identity before creating this user. Your password has not been submitted."
            : result.failure.message,
      );
      return;
    }
    setPassword("");
    setPasswordConfirm("");
    setCreated(result.value);
    onCreated();
    toast.show(`Created ${result.value.name}.`, { tone: "success" });
  }

  return (
    <Modal open={open} onClose={busy ? undefined : close} ariaLabel="Create User" width="42rem">
      {created ? (
        <div style={dialogBodyStyle}>
          <div>
            <p style={eyebrowStyle}>Account created</p>
            <h2 style={titleStyle}>{created.name}</h2>
            <p style={descriptionStyle}>The account is ready for first-time sign-in.</p>
          </div>
          <dl style={summaryStyle}>
            <Summary label="Username" value={created.username} />
            <Summary label="Email" value={created.email ?? "Not provided"} />
            <Summary label="Roles" value={roleNames.join(", ")} />
            <Summary label="Setup status" value="Password change required" />
          </dl>
          {created.temporaryPassword ? (
            <div style={secretStyle}>
              <strong>Temporary password — shown once</strong>
              <code style={{ overflowWrap: "anywhere" }}>{created.temporaryPassword}</code>
              <Button
                size="sm"
                tone="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(created.temporaryPassword ?? "");
                  toast.show("Temporary password copied.", { tone: "success" });
                }}
              >
                Copy password
              </Button>
            </div>
          ) : (
            <p style={descriptionStyle}>
              Use the temporary password you entered. It cannot be retrieved later.
            </p>
          )}
          <div style={footerStyle}>
            <Button tone="primary" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} style={dialogBodyStyle}>
          <div>
            <p style={eyebrowStyle}>Direct provisioning</p>
            <h2 style={titleStyle}>Create User</h2>
            <p style={descriptionStyle}>
              Create an account in the active organization with a temporary password.
            </p>
          </div>

          <section style={sectionStyle} aria-labelledby="create-profile-title">
            <h3 id="create-profile-title" style={sectionTitleStyle}>
              Personal Information
            </h3>
            <div style={twoColumnStyle}>
              <Field label="Full Name" htmlFor="create-user-name" required>
                <input
                  id="create-user-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={200}
                  required
                  style={inputStyle}
                />
              </Field>
              <Field
                label="Username"
                htmlFor="create-user-username"
                required
                hint="3–32 letters, numbers, periods, hyphens or underscores."
              >
                <input
                  id="create-user-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="off"
                  minLength={3}
                  maxLength={32}
                  pattern="[A-Za-z0-9_.-]+"
                  required
                  style={inputStyle}
                />
              </Field>
            </div>
            <Field
              label="Email (optional)"
              htmlFor="create-user-email"
              hint="Users without an email can sign in with their username. Password recovery requires administrator assistance."
            >
              <input
                id="create-user-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="off"
                maxLength={320}
                style={inputStyle}
              />
            </Field>
          </section>

          <section style={sectionStyle} aria-labelledby="create-access-title">
            <h3 id="create-access-title" style={sectionTitleStyle}>
              Organization Access
            </h3>
            <fieldset style={fieldsetStyle}>
              <legend style={legendStyle}>
                Roles <span aria-hidden>*</span>
              </legend>
              {roles.length === 0 ? (
                <p style={descriptionStyle}>
                  No roles are available within your assignment ceiling.
                </p>
              ) : (
                <div style={choiceGridStyle}>
                  {roles.map((role) => (
                    <CheckChoice
                      key={role.roleId}
                      label={role.name}
                      checked={roleIds.includes(role.roleId)}
                      onChange={(checked) =>
                        setRoleIds((current) =>
                          checked
                            ? [...current, role.roleId]
                            : current.filter((id) => id !== role.roleId),
                        )
                      }
                    />
                  ))}
                </div>
              )}
            </fieldset>
            {locations.length > 0 ? (
              <fieldset style={fieldsetStyle}>
                <legend style={legendStyle}>
                  Locations <span style={{ fontWeight: 400 }}>(optional)</span>
                </legend>
                <div style={choiceGridStyle}>
                  {locations.map((location) => (
                    <CheckChoice
                      key={location.id}
                      label={location.name}
                      checked={locationIds.includes(location.id)}
                      onChange={(checked) =>
                        setLocationIds((current) =>
                          checked
                            ? [...current, location.id]
                            : current.filter((id) => id !== location.id),
                        )
                      }
                    />
                  ))}
                </div>
              </fieldset>
            ) : null}
          </section>

          <section style={sectionStyle} aria-labelledby="create-password-title">
            <h3 id="create-password-title" style={sectionTitleStyle}>
              Temporary Password
            </h3>
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
            {serverGenerated ? (
              <p style={descriptionStyle}>
                WardenX will generate a secure password and display it once after creation.
              </p>
            ) : (
              <>
                <div style={twoColumnStyle}>
                  <Field label="Temporary Password" htmlFor="create-user-password" required>
                    <input
                      id="create-user-password"
                      type={passwordVisible ? "text" : "password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={256}
                      required
                      style={inputStyle}
                    />
                  </Field>
                  <Field label="Confirm Password" htmlFor="create-user-password-confirm" required>
                    <input
                      id="create-user-password-confirm"
                      type={passwordVisible ? "text" : "password"}
                      value={passwordConfirm}
                      onChange={(event) => setPasswordConfirm(event.target.value)}
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={256}
                      required
                      style={inputStyle}
                    />
                  </Field>
                </div>
                <CheckChoice
                  label="Show passwords"
                  checked={passwordVisible}
                  onChange={setPasswordVisible}
                />
              </>
            )}
            <p style={descriptionStyle}>
              The user will be required to change this password on their first login.
            </p>
          </section>

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
              Cancel
            </Button>
            <Button type="submit" tone="primary" disabled={busy || roles.length === 0}>
              {busy ? "Creating…" : "Create User"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function Field({
  label,
  htmlFor,
  required = false,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  hint?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <label htmlFor={htmlFor} style={fieldStyle}>
      <span style={{ fontWeight: 650 }}>
        {label}
        {required ? <span aria-hidden> *</span> : null}
      </span>
      {children}
      {hint ? <span style={hintStyle}>{hint}</span> : null}
    </label>
  );
}
function CheckChoice({
  label,
  checked,
  onChange,
}: { label: string; checked: boolean; onChange: (checked: boolean) => void }): JSX.Element {
  return (
    <label style={choiceStyle}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
function Summary({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <dt style={hintStyle}>{label}</dt>
      <dd style={{ margin: "0.1rem 0 0", fontWeight: 600, overflowWrap: "anywhere" }}>{value}</dd>
    </div>
  );
}

const dialogBodyStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "1.25rem",
  padding: "1.5rem",
};
const eyebrowStyle = {
  margin: 0,
  color: "var(--color-primary)",
  fontSize: "0.72rem",
  fontWeight: 700,
  textTransform: "uppercase" as const,
  letterSpacing: "0.08em",
};
const titleStyle = { margin: "0.2rem 0 0", fontSize: "1.35rem" };
const descriptionStyle = {
  margin: "0.25rem 0 0",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.82rem",
  lineHeight: 1.5,
};
const sectionStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  paddingTop: "1rem",
  borderTop: "1px solid var(--color-outline-variant)",
};
const sectionTitleStyle = { margin: 0, fontSize: "0.9rem" };
const twoColumnStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
  gap: "0.75rem",
};
const fieldStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.35rem",
  fontSize: "0.8rem",
};
const hintStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.72rem",
  lineHeight: 1.4,
};
const inputStyle = {
  minWidth: 0,
  padding: "0.6rem 0.7rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
};
const fieldsetStyle = { margin: 0, padding: 0, border: 0 };
const legendStyle = { marginBottom: "0.45rem", fontSize: "0.8rem", fontWeight: 650 };
const choiceGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
  gap: "0.45rem",
};
const choiceStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
  padding: "0.55rem 0.65rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-md)",
  fontSize: "0.8rem",
  cursor: "pointer",
};
const modeStyle = { display: "flex", flexWrap: "wrap" as const, gap: "0.5rem" };
const footerStyle = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
  paddingTop: "0.75rem",
  borderTop: "1px solid var(--color-outline-variant)",
};
const errorStyle = {
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  color: "var(--color-error)",
  background: "color-mix(in srgb, var(--color-error) 9%, transparent)",
  fontSize: "0.82rem",
};
const summaryStyle = {
  margin: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  gap: "0.9rem",
  padding: "1rem",
  background: "var(--color-surface-low)",
  borderRadius: "var(--radius-lg)",
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
