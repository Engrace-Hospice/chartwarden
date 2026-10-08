// apps/web/src/modules/02-identity — Auditor access link (M2 Auth, Track A).
// Spec: docs/design/screens/core/WARDENX_UI_AUTH.md "Auditor access link" (/auditor/redeem).
// The page an emailed auditor link opens: `/auditor/redeem?org=<organizationId>#token=<token>`. The one-time
// token rides the URL FRAGMENT (never sent to a server, so absent from access logs and `Referer`); this page
// reads it, scrubs it from the address bar, and only redeems when the auditor presses the button — a mail
// scanner that merely follows the link therefore cannot burn the single-use token. Redemption starts a
// read-only, engagement-scoped session (the session cookie is set by the response).
import { CenteredCardLayout, useApiClient } from "@wardenx/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

type Phase = "ready" | "redeeming" | "started" | "failed" | "invalid";

const TOKEN_FROM_HASH = /^#token=([A-Za-z0-9_-]{43})$/;

/** The error codes the redeem route answers with, mapped to what the auditor can act on. */
const FAILURE_COPY: Readonly<Record<string, string>> = {
  LINK_ALREADY_USED:
    "This link has already been used. Ask the organization to send you a new auditor link.",
  LINK_EXPIRED: "This link has expired. Ask the organization to send you a new auditor link.",
  LINK_INVALID: "This link is not valid. Ask the organization to send you a new auditor link.",
  ENGAGEMENT_NOT_OPEN: "Your access window has not opened yet. Try again when it begins.",
  ENGAGEMENT_NOT_ACTIVE: "This engagement is no longer active.",
  AUDITOR_IDENTITY_IS_MEMBER:
    "This email address already belongs to a member of the organization, so it cannot be used for auditor access.",
  MEMBERSHIP_NOT_ACTIVE: "Your account in this organization is not active.",
  AUDITOR_ROLE_MISCONFIGURED:
    "The organization’s auditor access needs attention from an administrator before you can continue.",
  USER_INACTIVE: "This account is not active.",
  RATE_LIMITED: "Too many attempts. Wait a few minutes and try again.",
};
const GENERIC_FAILURE = "We couldn’t start your auditor session. Please try again.";

function failureMessage(error: unknown): string {
  const code = (error as { error?: { code?: string } } | undefined)?.error?.code;
  return (code && FAILURE_COPY[code]) || GENERIC_FAILURE;
}

export function AuditorRedeem(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const organizationId = params.get("org");
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  // Take the token out of the fragment ONCE and remove it from the address bar / history entry.
  useEffect(() => {
    const match = TOKEN_FROM_HASH.exec(window.location.hash);
    if (!match || !organizationId) {
      setPhase("invalid");
      return;
    }
    setToken(match[1] ?? null);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }, [organizationId]);

  async function startSession(): Promise<void> {
    if (!token || !organizationId) return;
    setPhase("redeeming");
    setError(null);
    const { data, error: err } = await client.POST("/api/v1/auditors/redeem", {
      body: { organizationId, token },
    });
    if (err || !data) {
      setPhase("failed");
      setError(failureMessage(err));
      return;
    }
    setExpiresAt(data.expiresAt);
    setPhase("started");
  }

  if (phase === "invalid") {
    return (
      <CenteredCardLayout brand={<strong>WardenX</strong>}>
        <h1 style={{ marginTop: 0, fontSize: "1.1rem" }}>Auditor access</h1>
        <p style={{ color: "var(--color-error)" }}>
          This auditor link is incomplete. Open the link from your email again, or ask the
          organization to send you a new one.
        </p>
      </CenteredCardLayout>
    );
  }

  if (phase === "started") {
    return (
      <CenteredCardLayout brand={<strong>WardenX</strong>}>
        <h1 style={{ marginTop: 0, fontSize: "1.1rem" }}>Auditor access</h1>
        <output
          style={{ display: "block", color: "var(--color-on-surface-variant)", margin: "1em 0" }}
        >
          Your read-only auditor session is active
          {expiresAt ? <> until {new Date(expiresAt).toLocaleString()}</> : null}. It ends
          automatically when the engagement window closes, and after 10 minutes of inactivity.
        </output>
        <button type="button" onClick={() => navigate("/")} style={primaryBtn}>
          Continue
        </button>
      </CenteredCardLayout>
    );
  }

  return (
    <CenteredCardLayout brand={<strong>WardenX</strong>}>
      <h1 style={{ marginTop: 0, fontSize: "1.1rem" }}>Auditor access</h1>
      <p style={{ color: "var(--color-on-surface-variant)" }}>
        You have been granted time-limited, read-only access for an audit engagement. The link can
        be used once.
      </p>
      {error ? (
        <p role="alert" style={{ color: "var(--color-error)" }}>
          {error}
        </p>
      ) : null}
      <button
        type="button"
        onClick={startSession}
        disabled={phase === "redeeming" || !token || phase === "failed"}
        style={primaryBtn}
      >
        {phase === "redeeming" ? "Starting session…" : "Start auditor session"}
      </button>
    </CenteredCardLayout>
  );
}

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
