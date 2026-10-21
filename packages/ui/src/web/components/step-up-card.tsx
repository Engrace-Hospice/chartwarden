// @chartwarden/ui — StepUpCard: the step-up re-authentication ceremony, shared by the tenant web app
// (apps/web /step-up, M2 Auth polish) and the platform-ops console (apps/admin /step-up). Moved here from
// apps/web/src/modules/02-identity/step-up.tsx so both apps run ONE implementation; each app's route is a
// thin wrapper that supplies its own brand lockup and footer.
// Spec: docs/design/screens/core/WARDENX_UI_AUTH.md "step-up" (/step-up). A sensitive action requires a
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
// On success we return to `?returnTo` (the action that demanded step-up) — but only a same-origin,
// app-relative path (see `safeReturnTo`): the parameter is attacker-controllable via a crafted link, and
// navigating to it after a successful re-verification would otherwise be an open redirect.
import { useEffect, useState } from "react";
import type { FormEvent, JSX, ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useApiClient } from "../../core/api/provider";
import { CenteredCardLayout } from "../layouts/patterns";

/**
 * The `returnTo` to navigate to after a successful step-up, or "/" when the raw value is missing or not
 * an app-relative path. Only "/..." qualifies: "//host" and "/\\host" are protocol-relative URLs to
 * another origin in browsers, and anything with a scheme ("https:", "javascript:") is not a path at all.
 * Control characters are refused too: the URL parser strips tab and newline, so "/\t/host" would
 * otherwise reach the router as "//host".
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw?.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "/";
  return raw;
}

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

/**
 * Decode the server's base64url challenge into the raw bytes the navigator API signs over (F-081).
 *
 * This used to `TextEncoder().encode(challenge)` — signing over the ASCII of the encoded string rather
 * than the bytes it encodes. The authenticator then echoed `base64url(ascii)` back in `clientDataJSON`,
 * the server compared it to the string it had issued, and every assertion failed verification. The
 * challenge is base64url now (the shape Better Auth's own registration options already use), so
 * decoding here makes what is signed and what is expected the same value. Padded back to a multiple
 * of 4 before `atob` — a base64url challenge arrives with its `=` padding stripped, and some engines
 * throw on an unpadded length rather than tolerating it.
 */
function challengeBytes(challenge: string): ArrayBuffer {
  const padded = challenge
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(challenge.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return bytes.buffer;
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

export interface StepUpCardProps {
  /** The app's brand lockup, shown above the card. */
  brand?: ReactNode;
  /** Shown below the card (e.g. a "Sign in as someone else" link). */
  footer?: ReactNode;
  /** Where a lockout (423 — the session was terminated after too many failures) sends the user. */
  signInPath?: string;
  /**
   * Where this app lets a signed-in user register a passkey. When set and the account has no qualifying factor
   * (the initiate call answers `*_NOT_ENROLLED`), the card links there with a `returnTo` back to this step-up.
   */
  enrolPasskeyPath?: string;
  /** Called with the `returnTo` path once freshness is recorded, just before the card navigates there. */
  onVerified?: (returnTo: string) => void;
}

/** The `{ error: { code } }` envelope's code, or null. */
function apiErrorCode(error: unknown): string | null {
  const code = (error as { error?: { code?: unknown } } | null | undefined)?.error?.code;
  return typeof code === "string" ? code : null;
}

const NOT_ENROLLED = new Set(["WEBAUTHN_NOT_ENROLLED", "TOTP_NOT_ENROLLED"]);

export function StepUpCard({
  brand,
  footer,
  signInPath = "/login",
  enrolPasskeyPath,
  onVerified,
}: StepUpCardProps): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get("returnTo"));

  const hasPasskey = webauthnAvailable();
  // Prefer the passkey ceremony when the browser supports it; the TOTP code is always available.
  const [mode, setMode] = useState<"webauthn" | "totp">(hasPasskey ? "webauthn" : "totp");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Which factor the server said this account has not enrolled — a dead end the card must explain, not retry.
  const [notEnrolled, setNotEnrolled] = useState<"webauthn" | "totp" | null>(null);
  const [busy, setBusy] = useState(false);
  const enrolHref =
    enrolPasskeyPath === undefined
      ? null
      : `${enrolPasskeyPath}?returnTo=${encodeURIComponent(location.pathname + location.search)}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-runs only on mode change to reset the form.
  useEffect(() => {
    setError(null);
    setNotEnrolled(null);
    setCode("");
  }, [mode]);

  /** 423 means the session was terminated after too many failures (lockout) → back to sign-in. */
  function handledLockout(status: number | undefined): boolean {
    if (status === 423) {
      navigate(signInPath);
      return true;
    }
    return false;
  }

  async function verifyTotp(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);

    // 1) Begin a TOTP challenge for the current session.
    const initiated = await client.POST("/api/v1/sessions/step-up/initiate", {
      body: { factor: "totp" },
    });
    if (initiated.error || !initiated.data) {
      setBusy(false);
      if (NOT_ENROLLED.has(apiErrorCode(initiated.error) ?? "")) {
        setNotEnrolled("totp");
        return;
      }
      setError(
        "Couldn’t start verification. Make sure an authenticator app is set up on your account.",
      );
      return;
    }

    // 2) Verify the code against that challenge.
    const verified = await client.POST("/api/v1/sessions/step-up", {
      body: {
        factor: "totp",
        challengeId: initiated.data.challengeId,
        totpCode: code,
      },
    });
    setBusy(false);

    if (verified.error) {
      if (handledLockout(verified.response?.status)) return;
      setError("That code didn’t verify. Check your authenticator app and try again.");
      setCode("");
      return;
    }
    onVerified?.(returnTo);
    navigate(returnTo); // freshness recorded — resume the action that required step-up
  }

  async function verifyPasskey(): Promise<void> {
    setBusy(true);
    setError(null);

    // 1) Begin a WebAuthn challenge bound to the current session.
    const initiated = await client.POST("/api/v1/sessions/step-up/initiate", {
      body: { factor: "webauthn" },
    });
    // The initiate response is a discriminated union on `factor`; only the webauthn branch carries a
    // `webauthnChallenge`. Narrow on the field's presence before reading it.
    const webauthnChallenge =
      initiated.data && "webauthnChallenge" in initiated.data
        ? initiated.data.webauthnChallenge
        : undefined;
    if (initiated.error || !webauthnChallenge) {
      setBusy(false);
      if (NOT_ENROLLED.has(apiErrorCode(initiated.error) ?? "")) {
        setNotEnrolled("webauthn");
        return;
      }
      setError(
        "Couldn’t start passkey verification. You may not have a passkey registered on this account.",
      );
      return;
    }

    // 2) Run the browser assertion ceremony against the session-scoped challenge.
    const { challenge, rpId } = webauthnChallenge;
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
      setError(
        "Passkey verification was cancelled or failed. Try again, or use an authenticator code.",
      );
      return;
    }

    // 3) Submit the assertion for server verification + the paired-write.
    const verified = await client.POST("/api/v1/sessions/step-up", {
      body: {
        factor: "webauthn",
        challengeId: initiated.data.challengeId,
        assertion,
      },
    });
    setBusy(false);

    if (verified.error) {
      if (handledLockout(verified.response?.status)) return;
      setError("That passkey didn’t verify. Try again, or use an authenticator code.");
      return;
    }
    onVerified?.(returnTo);
    navigate(returnTo); // freshness recorded — resume the action that required step-up
  }

  return (
    <CenteredCardLayout brand={brand} footer={footer}>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.1rem" }}>Confirm it’s you</h1>
        <p
          style={{
            margin: 0,
            color: "var(--color-on-surface-variant)",
            fontSize: "0.85rem",
          }}
        >
          {mode === "webauthn"
            ? "This action needs a fresh verification. Use your passkey — your device’s biometrics or security key."
            : "This action needs a fresh verification. Enter the 6-digit code from your authenticator app."}
        </p>

        {notEnrolled ? (
          <div role="alert" style={{ margin: 0, fontSize: "0.85rem", color: "var(--color-error)" }}>
            {notEnrolled === "webauthn"
              ? "There’s no passkey on this account yet."
              : "No authenticator app is set up on this account."}{" "}
            {enrolHref ? (
              <>
                <Link to={enrolHref}>Set up a passkey</Link>, then come back here to continue.
              </>
            ) : (
              "Set up a passkey in the clinical app, then come back here to continue."
            )}
          </div>
        ) : null}

        {mode === "webauthn" ? (
          <>
            <button type="button" onClick={verifyPasskey} disabled={busy} style={primaryBtn}>
              {busy ? "Waiting for passkey…" : "Verify with a passkey"}
            </button>
            {error ? (
              <p
                style={{
                  color: "var(--color-error)",
                  margin: 0,
                  fontSize: "0.85rem",
                }}
              >
                {error}
              </p>
            ) : null}
            <button type="button" onClick={() => setMode("totp")} disabled={busy} style={linkBtn}>
              Use an authenticator code instead
            </button>
          </>
        ) : (
          <form
            onSubmit={verifyTotp}
            style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
          >
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.25rem",
                fontSize: "0.85rem",
              }}
            >
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
            {error ? (
              <p
                style={{
                  color: "var(--color-error)",
                  margin: 0,
                  fontSize: "0.85rem",
                }}
              >
                {error}
              </p>
            ) : null}
            <button type="submit" disabled={busy || code.length !== 6} style={primaryBtn}>
              {busy ? "Verifying…" : "Verify"}
            </button>
            {hasPasskey ? (
              <button
                type="button"
                onClick={() => setMode("webauthn")}
                disabled={busy}
                style={linkBtn}
              >
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
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "0.5rem",
  letterSpacing: "0.3em",
  fontSize: "1.1rem",
  textAlign: "center" as const,
} as const;
const primaryBtn = {
  padding: "0.625rem 1rem",
  border: "none",
  borderRadius: "0.5rem",
  background: "var(--color-primary)",
  color: "var(--color-surface-lowest)",
  cursor: "pointer",
  fontWeight: 600,
} as const;
const linkBtn = {
  padding: 0,
  border: "none",
  background: "none",
  color: "var(--color-primary)",
  cursor: "pointer",
  fontSize: "0.8rem",
  textAlign: "center" as const,
} as const;
