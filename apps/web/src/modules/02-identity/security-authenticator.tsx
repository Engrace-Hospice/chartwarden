// apps/web/src/modules/02-identity — authenticator-app setup (M2 Auth, ADR-0034 follow-up). Spec:
// docs/design/screens/core/CHARTWARDEN_UI_AUTH.md "authenticator setup". A signed-in user turns on a second factor that works
// for sign-in AND for step-up (the step-up route already accepts a verified TOTP row; nothing created one for staff until now):
//   1. they re-enter their password            authClient.twoFactor.enable({ password })  -> secret + backup codes, UNVERIFIED
//   2. they add the account in their app        by QR code, or by setup key / link when it cannot scan (qr-code.tsx draws the QR in the browser)
//   3. they type a code from the app            authClient.twoFactor.verifyTotp({ code }) -> the factor is now on
// The secret and the backup codes are shown once and live only in this component's state: no URL, storage, log or request but the
// two calls above. A secret the user never confirmed is not a factor (the server counts only `two_factor.verified`), so leaving
// half way costs nothing. Turning the factor off or replacing it is deliberately not here (it is a recovery flow with its own risks).
import {
  Button,
  ConfirmDialog,
  InlineAlert,
  LoadingSpinner,
  Panel,
  StatusPill,
  TextField,
  safeReturnTo,
} from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { type BlockerFunction, Link, useBlocker, useSearchParams } from "react-router-dom";
import { authClient } from "./auth-client";
import {
  CONFIRM_FAILED_COPY,
  ENROL_FAILURE_COPY,
  type EnrolFailure,
  TOTP_CODE_LENGTH,
  type TotpSetup,
  enrolFailure,
  groupSetupKey,
  isCompleteCode,
  normaliseCode,
  parseTotpUri,
} from "./authenticator-setup";
import { QrCode } from "./qr-code";

type Phase =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "on" }
  | { readonly kind: "off" }
  | { readonly kind: "confirm"; readonly setup: TotpSetup; readonly backupCodes: readonly string[] }
  | { readonly kind: "done"; readonly backupCodes: readonly string[] };

/** The shell navigates here on its own (session expiry, maintenance, sign-in): unsaved codes never hold the user on a dead session. */
const SHELL_EXIT_PATHS = new Set(["/expired", "/error", "/maintenance", "/tenant-unavailable"]);
const isShellExit = (pathname: string): boolean =>
  SHELL_EXIT_PATHS.has(pathname) || pathname === "/login" || pathname.startsWith("/login/");

const PARAGRAPH_STYLE = { margin: "0.75rem 0" } as const;

const KEY_STYLE = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "1.0625rem",
  letterSpacing: "0.08em",
  wordBreak: "break-all",
} as const;

/** Better Auth's client rejects on a network failure instead of returning `{ error }`: a rejected call is a failed call (null). */
async function attempt<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch {
    return null;
  }
}

type CopyState = "idle" | "copied" | "failed";

/** Copies text the user can already see. A browser that refuses (no clipboard in an insecure context) says so; the text stays selectable. */
function CopyButton({
  text,
  label,
}: { readonly text: string; readonly label: string }): JSX.Element {
  const [state, setState] = useState<CopyState>("idle");
  async function copy(): Promise<void> {
    setState(
      (await attempt(() => navigator.clipboard.writeText(text))) === null ? "failed" : "copied",
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: "0.75rem", alignItems: "center" }}>
      <Button type="button" tone="secondary" onClick={() => void copy()}>
        {label}
      </Button>
      <output>
        {state === "copied" ? "Copied." : null}
        {state === "failed" ? "Could not copy. Select the text and copy it by hand." : null}
      </output>
    </span>
  );
}

export function SecurityAuthenticator(): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<EnrolFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const alive = useRef(true);
  const headingRef = useRef<HTMLSpanElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [params] = useSearchParams();
  const rawReturnTo = params.get("returnTo");
  const returnTo = rawReturnTo === null ? null : safeReturnTo(rawReturnTo);

  useEffect(() => {
    alive.current = true;
    void attempt(() => authClient.getSession()).then((result) => {
      if (!alive.current) return;
      if (!result || result.error || !result.data?.user) return setPhase({ kind: "unavailable" });
      setPhase({ kind: result.data.user.twoFactorEnabled === true ? "on" : "off" });
    });
    return () => {
      alive.current = false;
    };
  }, []);

  // A new step is a new screenful: tell a screen-reader user where they are, as the other settings screens do.
  const phaseKind = phase.kind;
  useEffect(() => {
    if (phaseKind !== "loading") headingRef.current?.focus();
  }, [phaseKind]);

  // Until the user says the backup codes are saved, leaving would lose them for good: closing or reloading the page asks (beforeunload),
  // and so does leaving in-app (one useBlocker: a router supports one blocker at a time).
  const holdingCodes = phaseKind === "done" && !saved;
  useEffect(() => {
    if (!holdingCodes) return;
    const hold = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [holdingCodes]);
  const shouldBlock = useCallback<BlockerFunction>(
    ({ nextLocation }) => holdingCodes && !isShellExit(nextLocation.pathname),
    [holdingCodes],
  );
  const blocker = useBlocker(shouldBlock);

  // A refused submit leaves a read-only field that a keyboard user just left (the submit button is disabled while it works): put them back.
  useEffect(() => {
    if (failure !== null) formRef.current?.querySelector("input")?.focus();
  }, [failure]);

  async function start(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || password === "") return;
    setBusy(true);
    setFailure(null);
    const result = await attempt(() => authClient.twoFactor.enable({ password }));
    if (!alive.current) return;
    setBusy(false);
    setPassword("");
    const data = result?.data;
    const setup = result?.error || !data ? null : parseTotpUri(data.totpURI);
    // The client is typed by a cast, not by the server: codes that are not a list of strings would throw while the codes are shown,
    // after the factor is already on. Treat them as a failed start instead.
    const backupCodes =
      data &&
      Array.isArray(data.backupCodes) &&
      data.backupCodes.every((c) => typeof c === "string")
        ? data.backupCodes
        : null;
    if (!result || result.error || !data || !setup || !backupCodes) {
      const reason = enrolFailure(result?.error);
      return reason === "already-on" ? setPhase({ kind: "on" }) : setFailure(reason);
    }
    setPhase({ kind: "confirm", setup, backupCodes });
  }

  async function confirm(event: FormEvent, backupCodes: readonly string[]): Promise<void> {
    event.preventDefault();
    if (busy || !isCompleteCode(code)) return;
    setBusy(true);
    setFailure(null);
    const result = await attempt(() =>
      authClient.twoFactor.verifyTotp({ code: normaliseCode(code) }),
    );
    if (!alive.current) return;
    setBusy(false);
    if (!result || result.error) return setFailure(enrolFailure(result?.error));
    setCode("");
    setPhase({ kind: "done", backupCodes });
  }

  // Shown on the field that was just submitted (the field carries aria-invalid and the alert), so a screen reader hears it with the field.
  const failureText =
    failure === null
      ? undefined
      : failure === "failed" && phase.kind === "confirm"
        ? CONFIRM_FAILED_COPY
        : ENROL_FAILURE_COPY[failure];

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Authenticator app</h1>
            <p>
              A 6-digit code from an app on your phone. It confirms it is you when you sign in with
              your password and before sensitive actions such as signing a visit note. A role that
              requires a passkey, such as an organisation administrator, still needs one.
            </p>
          </div>
        </header>

        {phase.kind === "loading" ? (
          <div className="wx-list-state">
            <LoadingSpinner />
          </div>
        ) : null}

        {phase.kind === "unavailable" ? (
          <Panel
            title={
              <span ref={headingRef} tabIndex={-1}>
                Could not load your settings
              </span>
            }
            icon="shield"
          >
            <InlineAlert tone="error">
              Your authenticator settings could not be read. Reload the page to try again.
            </InlineAlert>
          </Panel>
        ) : null}

        {phase.kind === "on" ? (
          <Panel
            title={
              <span ref={headingRef} tabIndex={-1}>
                Authenticator app
              </span>
            }
            icon="shield"
          >
            <dl className="wx-kv">
              <dt>Status</dt>
              <dd>
                <StatusPill label="On" tone="success" />
              </dd>
            </dl>
            <p style={PARAGRAPH_STYLE}>
              Your account asks for a code from your authenticator app when you sign in with your
              password and when an action needs a fresh check.
            </p>
            {returnTo ? <Link to={returnTo}>Continue where you left off</Link> : null}
          </Panel>
        ) : null}

        {phase.kind === "off" ? (
          <Panel
            title={
              <span ref={headingRef} tabIndex={-1}>
                Turn on the authenticator app
              </span>
            }
            icon="shield"
            description="Step 1 of 3: confirm your password."
          >
            <form
              ref={formRef}
              onSubmit={(event) => void start(event)}
              style={{ display: "grid", gap: "1rem", maxWidth: "26rem" }}
            >
              <TextField
                label="Your password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                readOnly={busy}
                error={failureText}
                required
              />
              <div>
                <Button type="submit" tone="primary" loading={busy} disabled={password === ""}>
                  Continue
                </Button>
              </div>
            </form>
          </Panel>
        ) : null}

        {phase.kind === "confirm" ? (
          <Panel
            title={
              <span ref={headingRef} tabIndex={-1}>
                Add ChartWarden to your app
              </span>
            }
            icon="shield"
            description="Steps 2 and 3 of 3: add the account in your app, then enter the code it shows."
          >
            <div
              style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "flex-start" }}
            >
              <QrCode
                text={phase.setup.otpauthUri}
                label="QR code for adding ChartWarden to your authenticator app"
              />
              <ol
                style={{
                  flex: "1 1 18rem",
                  margin: 0,
                  paddingLeft: "1.25rem",
                  display: "grid",
                  gap: "0.75rem",
                  listStyle: "decimal",
                }}
              >
                <li>
                  Open an authenticator app (for example Google Authenticator, Microsoft
                  Authenticator or 1Password) and scan the QR code.
                </li>
                <li>
                  Cannot scan it? Choose to add an account with a <strong>setup key</strong> and
                  enter this key. Spaces do not matter.
                  <div style={{ margin: "0.5rem 0" }}>
                    <code style={KEY_STYLE}>{groupSetupKey(phase.setup.setupKey)}</code>
                  </div>
                  <CopyButton text={phase.setup.setupKey} label="Copy setup key" />
                  On the phone that has the app,{" "}
                  <a href={phase.setup.otpauthUri}>open the setup link</a> instead.
                </li>
              </ol>
            </div>
            <form
              ref={formRef}
              onSubmit={(event) => void confirm(event, phase.backupCodes)}
              style={{ display: "grid", gap: "1rem", maxWidth: "20rem", marginTop: "1rem" }}
            >
              <TextField
                label={`${TOTP_CODE_LENGTH}-digit code from the app`}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={TOTP_CODE_LENGTH + 2}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                readOnly={busy}
                error={failureText}
                required
              />
              <div>
                <Button
                  type="submit"
                  tone="primary"
                  loading={busy}
                  disabled={!isCompleteCode(code)}
                >
                  Turn on
                </Button>
              </div>
            </form>
          </Panel>
        ) : null}

        {phase.kind === "done" ? (
          <Panel
            title={
              <span ref={headingRef} tabIndex={-1}>
                The authenticator app is on
              </span>
            }
            icon="shield"
          >
            <InlineAlert tone="success">
              You will be asked for a code from your app when you sign in with your password and for
              sensitive actions.
            </InlineAlert>
            <p style={PARAGRAPH_STYLE}>
              <strong>Save these backup codes now.</strong> Each works once if you lose your phone.
              They are not shown again.
            </p>
            <ul
              aria-label="Backup codes"
              style={{
                ...KEY_STYLE,
                listStyle: "none",
                padding: 0,
                display: "grid",
                gap: "0.25rem",
              }}
            >
              {phase.backupCodes.map((backupCode) => (
                <li key={backupCode}>{backupCode}</li>
              ))}
            </ul>
            <CopyButton text={phase.backupCodes.join("\n")} label="Copy backup codes" />
            <label
              style={{ display: "flex", gap: "0.5rem", alignItems: "center", margin: "0.75rem 0" }}
            >
              <input
                type="checkbox"
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
              />
              <span>I have saved these codes somewhere safe.</span>
            </label>
            {returnTo && saved ? <Link to={returnTo}>Continue where you left off</Link> : null}
          </Panel>
        ) : null}

        <ConfirmDialog
          open={blocker.state === "blocked"}
          title="Leave without saving your backup codes?"
          description="The backup codes are not shown again. Without them, and without your phone, you cannot sign in."
          confirmLabel="Leave anyway"
          cancelLabel="Stay on this page"
          tone="danger"
          onConfirm={() => blocker.state === "blocked" && blocker.proceed()}
          onCancel={() => blocker.state === "blocked" && blocker.reset()}
        />
      </div>
    </div>
  );
}
