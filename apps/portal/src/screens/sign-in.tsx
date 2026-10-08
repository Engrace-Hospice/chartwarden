import { Button, CenteredCardLayout, InlineAlert, TextField, t } from "@wardenx/ui";
// @wardenx/portal — §5.1 Landing / sign-in (`/`). The invitee authenticates through M2 (Better Auth); this screen
// holds NO PHI and issues no portal read. Two ways in, matching the spec (§7.1: the invitation's magic link sets the
// account up; later sign-ins are a link, or a password plus an authenticator code):
//   • "Email me a sign-in link" — the primary path; the same single-use link primitive the auditor / CAHPS links use.
//   • "Use a password instead" — an established account; a second factor prompt follows when the server demands it.
// A passkey sign-in is NOT offered here yet (the WebAuthn ceremony needs the auth client bundle; it is enrolled and
// used from the account page once built) — nothing on this screen pretends otherwise.
// Either way the browser ends up at `/signed-in`, where the portal account is bound to the new session.
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { useNavigate } from "react-router-dom";
import { type SignInOutcome, requestMagicLink, signInWithPassword, verifyTotp } from "../auth-http";

type Step = "email" | "link_sent" | "password" | "code";

const FAILED = "We couldn't sign you in. Check your details and try again.";
const THROTTLED = "Too many attempts. Please wait a few minutes and try again.";

function messageFor(outcome: SignInOutcome | "sent" | "rate_limited" | "failed"): string | null {
  if (outcome === "rate_limited") return THROTTLED;
  if (outcome === "failed") return FAILED;
  return null;
}

export function PortalSignIn(): JSX.Element {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const linkProblem =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("link");

  async function onLink(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const outcome = await requestMagicLink(email.trim(), window.location.origin);
    setBusy(false);
    // The same acknowledgement whether or not the address maps to an account (no account enumeration).
    if (outcome === "sent") setStep("link_sent");
    else setError(messageFor(outcome));
  }

  async function onPassword(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const outcome = await signInWithPassword(email.trim(), password);
    setBusy(false);
    setPassword("");
    if (outcome === "ok") navigate("/signed-in");
    else if (outcome === "two_factor") setStep("code");
    else setError(messageFor(outcome));
  }

  async function onCode(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const outcome = await verifyTotp(code.trim());
    setBusy(false);
    if (outcome === "ok") navigate("/signed-in");
    else setError(messageFor(outcome));
  }

  return (
    <CenteredCardLayout
      brand={
        <div>
          <div style={{ fontFamily: t.fontDisplay, fontSize: "1.5rem", fontWeight: 600 }}>
            WardenX Family Portal
          </div>
          <div style={{ color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
            Secure access to your loved one's care
          </div>
        </div>
      }
      footer={<a href="/help">Need help signing in?</a>}
    >
      {step === "link_sent" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: t.space3 }}>
          <h1 style={{ margin: 0, fontSize: "1.15rem" }}>Check your email</h1>
          <InlineAlert tone="success">
            If a family portal account exists for {email || "that address"}, a secure sign-in link
            is on its way. It can be used once and expires shortly.
          </InlineAlert>
          <Button tone="tertiary" onClick={() => setStep("email")}>
            Use a different address
          </Button>
        </div>
      ) : step === "code" ? (
        <form
          onSubmit={onCode}
          aria-label="Authenticator code"
          style={{ display: "flex", flexDirection: "column", gap: t.space3 }}
        >
          <h1 style={{ margin: 0, fontSize: "1.15rem" }}>Enter your code</h1>
          <TextField
            label="Authenticator code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(ev) => setCode(ev.target.value)}
          />
          {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
          <Button type="submit" loading={busy} disabled={code.trim().length < 6}>
            Continue
          </Button>
        </form>
      ) : step === "password" ? (
        <form
          onSubmit={onPassword}
          aria-label="Sign in with a password"
          style={{ display: "flex", flexDirection: "column", gap: t.space3 }}
        >
          <h1 style={{ margin: 0, fontSize: "1.15rem" }}>Sign in with your password</h1>
          <TextField
            label="Email address"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
          />
          {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
          <Button type="submit" loading={busy} disabled={!email || !password}>
            Sign in
          </Button>
          <Button tone="tertiary" onClick={() => setStep("email")}>
            Email me a sign-in link instead
          </Button>
        </form>
      ) : (
        <form
          onSubmit={onLink}
          aria-label="Sign in"
          style={{ display: "flex", flexDirection: "column", gap: t.space3 }}
        >
          <h1 style={{ margin: 0, fontSize: "1.15rem" }}>Sign in</h1>
          {linkProblem ? (
            <InlineAlert tone="error">
              That sign-in link can't be used. It may have expired or been used already. Request a
              new one below.
            </InlineAlert>
          ) : null}
          <TextField
            label="Email address"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
          />
          {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
          <Button type="submit" loading={busy} disabled={!email}>
            Email me a sign-in link
          </Button>
          <Button tone="tertiary" onClick={() => setStep("password")}>
            Use a password instead
          </Button>
        </form>
      )}
    </CenteredCardLayout>
  );
}
