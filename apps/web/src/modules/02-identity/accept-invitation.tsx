import { CenteredCardLayout, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/02-identity — Accept Invitation (M2 Auth, Track A).
// Spec: docs/ui/screens/core/WARDENX_UI_AUTH.md "Accept invitation" (/invite/:token).
// This builds the token-consume step (POST /api/v1/invitations/accept → membership). The remaining
// spec steps (set password, verify email, enroll mandatory MFA) depend on the identity credential
// backend (better-auth), which is NOT yet mounted — deferred, see docs/ui/DEFERRED_SCREENS.md.
import { useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";

export function AcceptInvitation(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<"idle" | "working" | "accepted" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  async function accept(): Promise<void> {
    if (!token) {
      setStatus("error");
      setMessage("This invitation link is missing its token.");
      return;
    }
    setStatus("working");
    const { error } = await client.POST("/api/v1/invitations/accept", { body: { token } });
    if (error) {
      setStatus("error");
      setMessage(
        "This invitation is invalid or has expired. Request a new one from your administrator.",
      );
      return;
    }
    setStatus("accepted");
  }

  return (
    <CenteredCardLayout brand={<strong>WardenX</strong>}>
      <h1 style={{ marginTop: 0, fontSize: "1.1rem" }}>Accept invitation</h1>
      {status === "accepted" ? (
        <>
          <p>Your membership is active. Continue to select your organization.</p>
          <button type="button" onClick={() => navigate("/login/organization")} style={primaryBtn}>
            Continue
          </button>
        </>
      ) : (
        <>
          <p style={{ color: "#6b7280" }}>
            Accept this invitation to activate your membership. You will then set a password and
            enroll multi-factor authentication.
          </p>
          {status === "error" ? <p style={{ color: "#b91c1c" }}>{message}</p> : null}
          <button type="button" onClick={accept} disabled={status === "working"} style={primaryBtn}>
            {status === "working" ? "Accepting…" : "Accept invitation"}
          </button>
        </>
      )}
    </CenteredCardLayout>
  );
}

const primaryBtn = {
  width: "100%",
  padding: "0.625rem 1rem",
  border: "none",
  borderRadius: "0.5rem",
  background: "#1d4ed8",
  color: "#fff",
  cursor: "pointer",
  fontWeight: 600,
} as const;
