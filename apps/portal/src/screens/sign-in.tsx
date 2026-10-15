import {
  Button,
  CenteredCardLayout,
  InlineAlert,
  TextField,
} from "@wardenx/ui";
import { useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useNavigate } from "react-router-dom";
import {
  type SignInOutcome,
  requestMagicLink,
  signInWithPassword,
  verifyTotp,
} from "../auth-http";
import {
  PortalOnboardingBrand,
  PortalOnboardingHeading,
  PortalOnboardingHelp,
} from "./onboarding-ui";

type Step = "email" | "link_sent" | "password" | "code";

const FAILED = "We couldn't sign you in. Check your details and try again.";
const THROTTLED = "Too many attempts. Please wait a few minutes and try again.";

function messageFor(outcome: SignInOutcome | "sent"): string | null {
  if (outcome === "rate_limited") return THROTTLED;
  if (outcome === "failed") return FAILED;
  return null;
}

export function PortalSignIn(): JSX.Element {
  const navigate = useNavigate();
  const inFlight = useRef(false);
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const linkProblem =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("link");

  function changeStep(next: Step): void {
    if (inFlight.current) return;
    setStep(next);
    setError(null);
    setPassword("");
    setCode("");
  }

  async function submit(task: () => Promise<void>): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch {
      setError(
        "We couldn't connect securely. Please check your connection and try again.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function onLink(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    void submit(async () => {
      const outcome = await requestMagicLink(
        email.trim(),
        window.location.origin,
      );
      if (outcome === "sent") changeStepAfterSubmission("link_sent");
      else setError(messageFor(outcome));
    });
  }

  // The submit guard remains held until the handler finishes; this transition must not clear credentials
  // through the normal changeStep method, which intentionally blocks navigation while a request is active.
  function changeStepAfterSubmission(next: Step): void {
    setStep(next);
    setPassword("");
    setCode("");
  }

  function onPassword(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    void submit(async () => {
      const outcome = await signInWithPassword(email.trim(), password);
      setPassword("");
      if (outcome === "ok") navigate("/signed-in", { replace: true });
      else if (outcome === "two_factor") changeStepAfterSubmission("code");
      else setError(messageFor(outcome));
    });
  }

  function onCode(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    void submit(async () => {
      const outcome = await verifyTotp(code.trim());
      setCode("");
      if (outcome === "ok") navigate("/signed-in", { replace: true });
      else setError(messageFor(outcome));
    });
  }

  const isLink = step === "email" || step === "link_sent";
  return (
    <CenteredCardLayout
      brand={<PortalOnboardingBrand />}
      footer={<PortalOnboardingHelp />}
    >
      <div className="wx-portal-onboarding" data-auth-step={step}>
        <div
          className="wx-portal-onboarding__method"
          aria-label="Sign-in method"
        >
          <span className={isLink ? "is-current" : ""}>Email link</span>
          <span className={!isLink ? "is-current" : ""}>Password</span>
        </div>
        {step === "link_sent" ? (
          <div className="wx-portal-auth-form">
            <PortalOnboardingHeading
              eyebrow="Check your inbox"
              title="Check your email"
              description="If this address has portal access, we'll send a secure, single-use sign-in link."
            />
            <InlineAlert tone="success">
              If a portal account exists for that address, a sign-in email is on
              its way.
            </InlineAlert>
            <p className="wx-portal-auth-note">
              Not seeing an email? Check your spam folder, then contact your
              hospice care team if you still need help.
            </p>
            <Button tone="secondary" onClick={() => changeStep("email")}>
              Use a different address
            </Button>
          </div>
        ) : step === "code" ? (
          <form
            onSubmit={onCode}
            aria-label="Authenticator code"
            className="wx-portal-auth-form"
          >
            <PortalOnboardingHeading
              eyebrow="Identity verification"
              title="Enter your code"
              description="Enter the current code from your authenticator app to finish signing in."
            />
            <TextField
              label="Authenticator code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={8}
              value={code}
              onChange={(ev) => setCode(ev.target.value)}
            />
            {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
            <Button
              type="submit"
              loading={busy}
              disabled={busy || code.trim().length < 6}
            >
              Verify and continue
            </Button>
            <Button
              tone="tertiary"
              disabled={busy}
              onClick={() => changeStep("password")}
            >
              Back to password
            </Button>
          </form>
        ) : step === "password" ? (
          <form
            onSubmit={onPassword}
            aria-label="Sign in with a password"
            className="wx-portal-auth-form"
          >
            <PortalOnboardingHeading
              eyebrow="Welcome back"
              title="Sign in with your password"
              description="Use the email address linked to your family portal access."
            />
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
            <Button
              type="submit"
              loading={busy}
              disabled={busy || !email.trim() || !password}
            >
              Sign in
            </Button>
            <Button
              tone="tertiary"
              disabled={busy}
              onClick={() => changeStep("email")}
            >
              Email me a sign-in link instead
            </Button>
          </form>
        ) : (
          <form
            onSubmit={onLink}
            aria-label="Sign in"
            className="wx-portal-auth-form"
          >
            <PortalOnboardingHeading
              eyebrow="Private and secure"
              title="Sign in"
              description="Visit updates, care information, and secure messages shared by your hospice team."
            />
            {linkProblem ? (
              <InlineAlert tone="error">
                That sign-in link can't be used. Request a new one below.
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
            <Button
              type="submit"
              loading={busy}
              disabled={busy || !email.trim()}
            >
              Email me a sign-in link
            </Button>
            <Button
              tone="tertiary"
              disabled={busy}
              onClick={() => changeStep("password")}
            >
              Use a password instead
            </Button>
          </form>
        )}
      </div>
    </CenteredCardLayout>
  );
}
