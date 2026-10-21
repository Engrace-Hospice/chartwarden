// apps/web/src/modules/02-identity — Auditor access link (M2 Auth, Track A).
// Spec: docs/design/screens/core/WARDENX_UI_AUTH.md "Auditor access link" (/auditor/redeem).
// The page an emailed auditor link opens: `/auditor/redeem?org=<organizationId>#token=<token>`. The one-time
// token rides the URL FRAGMENT (never sent to a server, so absent from access logs and `Referer`); this page
// reads it, scrubs it from the address bar, and only redeems when the auditor presses the button — a mail
// scanner that merely follows the link therefore cannot burn the single-use token. Redemption starts an
// ENROLMENT-stage session (the session cookie is set by the response) and hands over to /auditor/enrol, where
// the auditor accepts the BAA terms and proves a second factor before anything can be read (M2 §7.7).
import { Button, CenteredCardLayout, InlineAlert, t, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { BrandLockup } from "./brand-lockup";

type Phase = "ready" | "redeeming" | "failed" | "invalid";

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
    navigate("/auditor/enrol", { replace: true });
  }

  if (phase === "invalid") {
    return (
      <CenteredCardLayout brand={<BrandLockup />}>
        <h1 style={titleStyle}>Auditor access</h1>
        <InlineAlert tone="error">
          This auditor link is incomplete. Open the link from your email again, or ask the
          organization to send you a new one.
        </InlineAlert>
      </CenteredCardLayout>
    );
  }

  return (
    <CenteredCardLayout brand={<BrandLockup />}>
      <div style={{ display: "flex", flexDirection: "column", gap: t.space4 }}>
        <div>
          <h1 style={titleStyle}>Auditor access</h1>
          <p style={mutedStyle}>
            You have been granted time-limited, read-only access for an audit engagement. The link
            can be used once. Next you will accept the engagement terms and set up a second factor.
          </p>
        </div>
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <Button
          size="lg"
          style={{ width: "100%" }}
          loading={phase === "redeeming"}
          disabled={!token || phase === "failed"}
          onClick={startSession}
        >
          {phase === "redeeming" ? "Starting session…" : "Start auditor session"}
        </Button>
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
const mutedStyle: CSSProperties = {
  margin: `${t.space2} 0 0`,
  color: t.onSurfaceVariant,
  fontSize: "0.85rem",
};
