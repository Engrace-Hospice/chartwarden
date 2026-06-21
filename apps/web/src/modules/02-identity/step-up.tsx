// apps/web/src/modules/02-identity — Step-up Re-authentication (M2 Auth, AUTH polish).
// Spec: docs/ui/screens/core/WARDENX_UI_AUTH.md "step-up" (/step-up). A sensitive action requires a
// fresh second-factor proof; this re-verifies the CURRENT session (no new sign-in) and the server
// paired-writes lastStepUpAt/lastStepUpFactor (§4.4, D8), which M3's `step_up_recent` predicate gates on.
//
// Goes through the generated REST client (ADR-0032) — /api/v1/sessions/step-up{/initiate} — NOT the
// Better Auth client. SMS never qualifies (D9). TOTP is wired here; the WebAuthn step-up path is a
// browser ceremony (navigator.credentials) and is a follow-up, like passkey enrollment — see
// docs/ui/DEFERRED_SCREENS.md. On success we return to `?returnTo` (the action that demanded step-up).
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CenteredCardLayout, useApiClient } from "@wardenx/ui";

export function StepUp(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnTo = params.get("returnTo") ?? "/";

  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);

    // 1) Begin a TOTP challenge for the current session.
    const initiated = await client.POST("/api/v1/sessions/step-up/initiate", { body: { factor: "totp" } });
    if (initiated.error || !initiated.data) {
      setBusy(false);
      setError("Couldn’t start verification. Make sure an authenticator app is set up on your account.");
      return;
    }

    // 2) Verify the code against that challenge.
    const verified = await client.POST("/api/v1/sessions/step-up", {
      body: { factor: "totp", challengeId: initiated.data.challengeId, totpCode: code },
    });
    setBusy(false);

    if (verified.error) {
      // 423 means the session was terminated after too many failures (lockout) → back to sign-in.
      if (verified.response?.status === 423) {
        navigate("/login");
        return;
      }
      setError("That code didn’t verify. Check your authenticator app and try again.");
      setCode("");
      return;
    }
    navigate(returnTo); // freshness recorded — resume the action that required step-up
  }

  return (
    <CenteredCardLayout brand={<strong>WardenX</strong>} footer={<a href="/login">Sign in as someone else</a>}>
      <form onSubmit={verify} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.1rem" }}>Confirm it’s you</h1>
        <p style={{ margin: 0, color: "#6b7280", fontSize: "0.85rem" }}>
          This action needs a fresh verification. Enter the 6-digit code from your authenticator app.
        </p>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
          Authentication code
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={code}
            onChange={(ev) => setCode(ev.target.value.replace(/\D/g, ""))}
            style={field}
          />
        </label>
        {error ? <p style={{ color: "#b91c1c", margin: 0, fontSize: "0.85rem" }}>{error}</p> : null}
        <button type="submit" disabled={busy || code.length !== 6} style={primaryBtn}>
          {busy ? "Verifying…" : "Verify"}
        </button>
      </form>
    </CenteredCardLayout>
  );
}

const field = {
  padding: "0.5rem 0.625rem",
  border: "1px solid #e5e7eb",
  borderRadius: "0.5rem",
  letterSpacing: "0.3em",
  fontSize: "1.1rem",
  textAlign: "center" as const,
} as const;
const primaryBtn = {
  padding: "0.625rem 1rem",
  border: "none",
  borderRadius: "0.5rem",
  background: "#1d4ed8",
  color: "#fff",
  cursor: "pointer",
  fontWeight: 600,
} as const;
