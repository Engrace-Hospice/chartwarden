// apps/web/src/modules/02-identity — Step-up Re-authentication (M2 Auth, AUTH polish).
// Spec: docs/ui/screens/core/WARDENX_UI_AUTH.md "step-up" (/step-up). A sensitive action requires a
// fresh second-factor proof; this re-verifies the CURRENT session (no new sign-in) and the server
// paired-writes lastStepUpAt/lastStepUpFactor (§4.4, D8), which M3's `step_up_recent` predicate gates on.
//
// Goes through the generated REST client (ADR-0032) — /api/v1/sessions/step-up{/initiate} — NOT the
// Better Auth client. SMS never qualifies (D9). BOTH qualifying factors are wired here:
//   • WebAuthn — a browser ceremony (navigator.credentials.get) bound to the SESSION-scoped challenge
//     the initiate route mints; the assertion is posted back for server verification. This re-verifies
//     the live session — it is NOT signIn.passkey() (that would mint a new sign-in). Browser-only, so
//     build-/e2e-verified, not CI-unit (FB-T13).
//   • TOTP — the 6-digit authenticator code.
// On success we return to `?returnTo` (the action that demanded step-up).
import { useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CenteredCardLayout, useApiClient } from "@wardenx/ui";

/** True when this browser can run a WebAuthn assertion ceremony. */
function webauthnAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    navigator.credentials != null
  );
}

/** Encode an ArrayBuffer as base64url (the JSON-safe wire form for WebAuthn byte fields). */
function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Treat the server's opaque challenge string as raw bytes for the navigator API. */
function challengeBytes(challenge: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(challenge);
  const buf = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buf).set(encoded);
  return buf;
}

/** Serialize a WebAuthn assertion into a JSON-safe object the server can verify. */
function serializeAssertion(cred: PublicKeyCredential): unknown {
  const response = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: toBase64Url(cred.rawId),
    type: cred.type,
    response: {
      authenticatorData: toBase64Url(response.authenticatorData),
      clientDataJSON: toBase64Url(response.clientDataJSON),
      signature: toBase64Url(response.signature),
      userHandle: response.userHandle ? toBase64Url(response.userHandle) : null,
    },
  };
}

export function StepUp(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnTo = params.get("returnTo") ?? "/";

  const hasPasskey = webauthnAvailable();
  // Prefer the passkey ceremony when the browser supports it; the TOTP code is always available.
  const [mode, setMode] = useState<"webauthn" | "totp">(hasPasskey ? "webauthn" : "totp");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
    setCode("");
  }, [mode]);

  /** 423 means the session was terminated after too many failures (lockout) → back to sign-in. */
  function handledLockout(status: number | undefined): boolean {
    if (status === 423) {
      navigate("/login");
      return true;
    }
    return false;
  }

  async function verifyTotp(e: FormEvent): Promise<void> {
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
      if (handledLockout(verified.response?.status)) return;
      setError("That code didn’t verify. Check your authenticator app and try again.");
      setCode("");
      return;
    }
    navigate(returnTo); // freshness recorded — resume the action that required step-up
  }

  async function verifyPasskey(): Promise<void> {
    setBusy(true);
    setError(null);

    // 1) Begin a WebAuthn challenge bound to the current session.
    const initiated = await client.POST("/api/v1/sessions/step-up/initiate", { body: { factor: "webauthn" } });
    if (initiated.error || !initiated.data?.webauthnChallenge) {
      setBusy(false);
      setError("Couldn’t start passkey verification. You may not have a passkey registered on this account.");
      return;
    }

    // 2) Run the browser assertion ceremony against the session-scoped challenge.
    const { challenge, rpId } = initiated.data.webauthnChallenge;
    let assertion: unknown;
    try {
      const credential = (await navigator.credentials.get({
        publicKey: {
          challenge: challengeBytes(challenge),
          rpId,
          userVerification: "required",
          timeout: 60_000,
        },
      })) as PublicKeyCredential | null;
      if (!credential) throw new Error("no_credential");
      assertion = serializeAssertion(credential);
    } catch {
      setBusy(false);
      setError("Passkey verification was cancelled or failed. Try again, or use an authenticator code.");
      return;
    }

    // 3) Submit the assertion for server verification + the paired-write.
    const verified = await client.POST("/api/v1/sessions/step-up", {
      body: { factor: "webauthn", challengeId: initiated.data.challengeId, assertion },
    });
    setBusy(false);

    if (verified.error) {
      if (handledLockout(verified.response?.status)) return;
      setError("That passkey didn’t verify. Try again, or use an authenticator code.");
      return;
    }
    navigate(returnTo); // freshness recorded — resume the action that required step-up
  }

  return (
    <CenteredCardLayout brand={<strong>WardenX</strong>} footer={<a href="/login">Sign in as someone else</a>}>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.1rem" }}>Confirm it’s you</h1>
        <p style={{ margin: 0, color: "#6b7280", fontSize: "0.85rem" }}>
          {mode === "webauthn"
            ? "This action needs a fresh verification. Use your passkey — your device’s biometrics or security key."
            : "This action needs a fresh verification. Enter the 6-digit code from your authenticator app."}
        </p>

        {mode === "webauthn" ? (
          <>
            <button type="button" onClick={verifyPasskey} disabled={busy} style={primaryBtn}>
              {busy ? "Waiting for passkey…" : "Verify with a passkey"}
            </button>
            {error ? <p style={{ color: "#b91c1c", margin: 0, fontSize: "0.85rem" }}>{error}</p> : null}
            <button type="button" onClick={() => setMode("totp")} disabled={busy} style={linkBtn}>
              Use an authenticator code instead
            </button>
          </>
        ) : (
          <form onSubmit={verifyTotp} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
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
            {hasPasskey ? (
              <button type="button" onClick={() => setMode("webauthn")} disabled={busy} style={linkBtn}>
                Use a passkey instead
              </button>
            ) : null}
          </form>
        )}
      </div>
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
const linkBtn = {
  padding: 0,
  border: "none",
  background: "none",
  color: "#1d4ed8",
  cursor: "pointer",
  fontSize: "0.8rem",
  textAlign: "center" as const,
} as const;
