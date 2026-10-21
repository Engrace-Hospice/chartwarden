import { CenteredCardLayout, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/02-identity — Accept tenant invitation (M34 first admin, /tenant-invite/:token).
// The provisioning job emails the first admin a link built from M34_INVITATION_ACCEPT_URL. That token lives in
// `tenant_invitation`, which the M2 page (`/invite/:token`, `organization_invitation`) cannot see — so this page
// redeems it at POST /api/v1/public/tenant-invitations/:token/accept (creates the user + first org_admin
// membership, no credential), then sends the standard password-reset email: possession of the invited inbox is
// what lets the admin set a password, and no password travels through this page.
import { useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useParams } from "react-router-dom";
import { authClient } from "./auth-client";

type Phase = "ready" | "accepting" | "invalid" | "accepted";

const INVALID_MESSAGE =
  "This invitation is invalid or has expired. Request a new one from your platform administrator.";

export function AcceptTenantInvitation(): JSX.Element {
  const client = useApiClient();
  const { token } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>("ready");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const inFlight = useRef(false);

  async function accept(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!token || inFlight.current) return;
    inFlight.current = true;
    setRetryError(false);
    setPhase("accepting");
    const displayName = name.trim();
    const result = await client
      .POST("/api/v1/public/tenant-invitations/{tokenHash}/accept", {
        params: { path: { tokenHash: token } },
        body: displayName ? { displayName } : {},
      })
      .catch(() => null);
    if (!result) {
      // Network failure: the token was not consumed, so let the admin retry rather than report it invalid.
      inFlight.current = false;
      setRetryError(true);
      setPhase("ready");
      return;
    }
    const { data, error, response } = result;
    if (error || !data) {
      inFlight.current = false;
      // 5xx / 429 say nothing about the token; only a 4xx refusal means invalid or expired.
      if (response && (response.status >= 500 || response.status === 429)) {
        setRetryError(true);
        setPhase("ready");
      } else {
        setPhase("invalid");
      }
      return;
    }
    setEmail(data.email);
    // The invitation is already consumed here, so a throwing reset request (network drop) must still land on the
    // "accepted" page with the forgot-password fallback — never leave the admin stuck on "Accepting…".
    const sent = await authClient
      .requestPasswordReset({
        email: data.email,
        redirectTo: `${window.location.origin}/reset-password`,
      })
      .then((reset) => !reset.error)
      .catch(() => false);
    setResetSent(sent);
    setPhase("accepted");
  }

  if (!token || phase === "invalid") {
    return (
      <CenteredCardLayout brand={<strong>ChartWarden</strong>}>
        <h1 style={{ marginTop: 0, fontSize: "1.1rem" }}>Accept invitation</h1>
        <p role="alert" style={{ color: "var(--color-error)" }}>
          {INVALID_MESSAGE}
        </p>
      </CenteredCardLayout>
    );
  }

  if (phase === "accepted") {
    return (
      <CenteredCardLayout
        brand={<strong>ChartWarden</strong>}
        footer={<a href="/login">Back to sign in</a>}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <h1 style={{ margin: 0, fontSize: "1.1rem" }}>
            {resetSent ? "Check your email" : "Invitation accepted"}
          </h1>
          {resetSent ? (
            <p style={{ margin: 0, color: "var(--color-on-surface-variant)", fontSize: "0.9rem" }}>
              Your invitation is accepted. We’ve sent a link to <strong>{email}</strong> to set your
              password; once it’s set you can sign in.
            </p>
          ) : (
            <p style={{ margin: 0, color: "var(--color-on-surface-variant)", fontSize: "0.9rem" }}>
              Your invitation is accepted, but we couldn’t send the password email to{" "}
              <strong>{email}</strong>. Use <a href="/forgot">forgot password</a> to set one.
            </p>
          )}
        </div>
      </CenteredCardLayout>
    );
  }

  return (
    <CenteredCardLayout brand={<strong>ChartWarden</strong>}>
      <form onSubmit={accept} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.1rem" }}>Accept your invitation</h1>
        <p style={{ margin: 0, color: "var(--color-on-surface-variant)", fontSize: "0.85rem" }}>
          You’ve been invited to administer a new ChartWarden organization. Accept to activate your
          account; we’ll then email you a link to set your password.
        </p>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}
        >
          Full name
          <input
            type="text"
            autoComplete="name"
            value={name}
            onChange={(ev) => setName(ev.target.value)}
            style={field}
          />
        </label>
        {retryError && (
          <p role="alert" style={{ margin: 0, color: "var(--color-error)", fontSize: "0.85rem" }}>
            We couldn’t reach the server. Try again.
          </p>
        )}
        <button type="submit" disabled={phase === "accepting"} style={primaryBtn}>
          {phase === "accepting" ? "Accepting…" : "Accept invitation"}
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
  width: "100%",
  padding: "0.625rem 1rem",
  border: "none",
  borderRadius: "0.5rem",
  background: "var(--color-primary)",
  color: "var(--color-surface-lowest)",
  cursor: "pointer",
  fontWeight: 600,
} as const;
