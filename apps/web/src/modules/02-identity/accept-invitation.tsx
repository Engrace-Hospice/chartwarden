import { CenteredCardLayout, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/02-identity — Accept Invitation (M2 Auth, Track A).
// Spec: docs/design/screens/core/CHARTWARDEN_UI_AUTH.md "Accept invitation" (/invite/:token).
// TASK-030: the original cut deferred "set password" because there was no way to know the invitee's
// email before consuming the (one-time) accept token, and no sign-up screen existed to create their
// Better Auth account. Both are fixed here — a pre-auth GET /api/v1/invitations/:token PEEKS the
// token's target (email + org) WITHOUT consuming it, so an unauthenticated invitee can be shown a
// "create your account" form (email fixed, name + password chosen) before the one-time accept call.
// An invitee who is ALREADY signed in (e.g. invited to a second org) skips straight to the accept step.
import { useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { authClient } from "./auth-client";

const MIN_PASSWORD_LENGTH = 12; // mirrors emailAndPassword.minPasswordLength (server is authoritative)

type Phase =
  | "checking" // peeking the token + the current session
  | "invalid" // token missing/expired/used
  | "needs-account" // unauthenticated — show the create-account form
  | "ready-to-accept" // already authenticated as the invited address — one button
  | "wrong-account" // authenticated as someone else: the server would refuse (403), so say so up front
  | "creating" // signUp + accept in flight
  | "accepted";

/** Invitation addresses are matched case-insensitively and trimmed, exactly as the server does. */
function sameEmail(a: string, b: string | undefined): boolean {
  return a.trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

export function AcceptInvitation(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>("checking");
  const [invite, setInvite] = useState<{ email: string; organizationName: string } | null>(null);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!token) {
        setPhase("invalid");
        setError("This invitation link is missing its token.");
        return;
      }
      const [peekRes, sessionRes] = await Promise.all([
        client.GET("/api/v1/invitations/{token}", { params: { path: { token } } }),
        authClient.getSession(),
      ]);
      if (!active) return;
      if (peekRes.error) {
        setPhase("invalid");
        setError(
          "This invitation is invalid or has expired. Request a new one from your administrator.",
        );
        return;
      }
      setInvite({
        email: peekRes.data?.email ?? "",
        organizationName: peekRes.data?.organizationName ?? "your organization",
      });
      const signedInAs = sessionRes.data?.user?.email ?? null;
      setSessionEmail(signedInAs);
      if (!signedInAs) setPhase("needs-account");
      else
        setPhase(sameEmail(signedInAs, peekRes.data?.email) ? "ready-to-accept" : "wrong-account");
    })();
    return () => {
      active = false;
    };
  }, [client, token]);

  async function acceptInto(): Promise<void> {
    if (!token) return;
    const { error: err } = await client.POST("/api/v1/invitations/accept", { body: { token } });
    // GAP-009: the server binds the token to the invited address. The invitation is still valid (the
    // refusal does not burn it) — the fix is the right account, not "request a new one".
    if (
      (err as { error?: { code?: string } } | undefined)?.error?.code ===
      "INVITATION_EMAIL_MISMATCH"
    ) {
      setPhase("wrong-account");
      return;
    }
    if (err) {
      setPhase("invalid");
      setError(
        "This invitation is invalid or has expired. Request a new one from your administrator.",
      );
      return;
    }
    setPhase("accepted");
  }

  async function signOutAndReload(): Promise<void> {
    await authClient.signOut();
    window.location.reload();
  }

  async function acceptAlreadySignedIn(): Promise<void> {
    setPhase("creating");
    await acceptInto();
  }

  async function createAccountAndAccept(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!invite) return;
    if (password !== confirm) {
      setError("Passwords don’t match.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    setError(null);
    setPhase("creating");
    // GAP-009 — registration is invite-gated server-side: the invitation token proves this sign-up is
    // for the address that was invited.
    const { error: signUpErr } = await authClient.signUp.email({
      email: invite.email,
      password,
      name: name.trim(),
      fetchOptions: { headers: { "x-invite-token": token ?? "" } },
    });
    if (signUpErr) {
      setPhase("needs-account");
      setError(
        signUpErr.message ??
          "Couldn’t create your account. Choose a less common password, or sign in if you already have one.",
      );
      return;
    }
    await acceptInto();
  }

  if (phase === "checking") {
    return (
      <CenteredCardLayout brand={<strong>ChartWarden</strong>}>
        <p>Checking your invitation…</p>
      </CenteredCardLayout>
    );
  }

  if (phase === "invalid") {
    return (
      <CenteredCardLayout brand={<strong>ChartWarden</strong>}>
        <h1 style={{ marginTop: 0, fontSize: "1.1rem" }}>Accept invitation</h1>
        <p style={{ color: "var(--color-error)" }}>{error}</p>
      </CenteredCardLayout>
    );
  }

  if (phase === "accepted") {
    return (
      <CenteredCardLayout brand={<strong>ChartWarden</strong>}>
        <h1 style={{ marginTop: 0, fontSize: "1.1rem" }}>Accept invitation</h1>
        <p>Your membership is active. Continue to select your organization.</p>
        <button type="button" onClick={() => navigate("/login/organization")} style={primaryBtn}>
          Continue
        </button>
      </CenteredCardLayout>
    );
  }

  if (phase === "wrong-account") {
    return (
      <CenteredCardLayout brand={<strong>ChartWarden</strong>}>
        <h1 style={{ marginTop: 0, fontSize: "1.1rem" }}>Accept invitation</h1>
        <p style={{ color: "var(--color-on-surface-variant)" }}>
          This invitation to <strong>{invite?.organizationName}</strong> was sent to{" "}
          <strong>{invite?.email}</strong>
          {sessionEmail ? (
            <>
              , but you’re signed in as <strong>{sessionEmail}</strong>
            </>
          ) : null}
          . Sign out, then open the link again to continue as the invited address.
        </p>
        <button type="button" onClick={signOutAndReload} style={primaryBtn}>
          Sign out
        </button>
      </CenteredCardLayout>
    );
  }

  if (phase === "ready-to-accept") {
    return (
      <CenteredCardLayout brand={<strong>ChartWarden</strong>}>
        <h1 style={{ marginTop: 0, fontSize: "1.1rem" }}>Accept invitation</h1>
        <p style={{ color: "var(--color-on-surface-variant)" }}>
          Accept your invitation to <strong>{invite?.organizationName}</strong> with your current
          account ({sessionEmail ?? invite?.email}).
        </p>
        {error ? <p style={{ color: "var(--color-error)" }}>{error}</p> : null}
        <button type="button" onClick={acceptAlreadySignedIn} style={primaryBtn}>
          Accept invitation
        </button>
      </CenteredCardLayout>
    );
  }

  // "needs-account" | "creating" — the invitee has no session yet: create their account first.
  return (
    <CenteredCardLayout brand={<strong>ChartWarden</strong>}>
      <form
        onSubmit={createAccountAndAccept}
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
      >
        <h1 style={{ margin: 0, fontSize: "1.1rem" }}>Create your account</h1>
        <p style={{ margin: 0, color: "var(--color-on-surface-variant)", fontSize: "0.85rem" }}>
          You’ve been invited to join <strong>{invite?.organizationName}</strong> on ChartWarden as{" "}
          <strong>{invite?.email}</strong>.
        </p>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}
        >
          Full name
          <input
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(ev) => setName(ev.target.value)}
            style={field}
          />
        </label>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}
        >
          Password
          <input
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            style={field}
          />
        </label>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}
        >
          Confirm password
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(ev) => setConfirm(ev.target.value)}
            style={field}
          />
        </label>
        {error ? (
          <p style={{ color: "var(--color-error)", margin: 0, fontSize: "0.85rem" }}>{error}</p>
        ) : null}
        <button
          type="submit"
          disabled={phase === "creating" || !name.trim() || !password || !confirm}
          style={primaryBtn}
        >
          {phase === "creating" ? "Creating account…" : "Create account & accept invitation"}
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
