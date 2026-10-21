// apps/web/src/modules/02-identity — Auditor enrolment (M2 §7.7, Track A).
// Spec: docs/design/screens/core/CHARTWARDEN_UI_AUTH.md "Auditor enrolment" (/auditor/enrol).
// Where an external auditor lands after redeeming the emailed link: the session can reach nothing else until
// they (1) read and accept the BAA / engagement terms and (2) prove a second factor — set up an authenticator
// the first time (and keep ten single-use recovery codes), present the code or a recovery code afterwards.
// The server owns every decision (stage, lockout, replay); this screen only walks the two steps and explains
// refusals in plain language. SMS is never offered.
import { Button, CenteredCardLayout, InlineAlert, TextField, t, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate } from "react-router-dom";
import { BrandLockup } from "./brand-lockup";

interface EnrolmentView {
  readonly stage: "enrolment" | "active";
  readonly terms: {
    readonly version: string;
    readonly title: string;
    readonly text: string;
    readonly sha256: string;
  };
  readonly baaAccepted: boolean;
  readonly secondFactor: "enrol" | "challenge" | "verified";
  readonly totpPending: boolean;
  readonly lockedUntil: string | null;
  readonly expiresAt: string;
}

interface TotpSetup {
  readonly otpauthUri: string;
  readonly manualEntryKey: string;
}

const MIN_NAME_LENGTH = 2;
const CODE_LENGTH = 6;

const FAILURE_COPY: Readonly<Record<string, string>> = {
  AUDITOR_2FA_INVALID: "That code is not valid. Check your authenticator and try again.",
  AUDITOR_2FA_LOCKED: "Too many incorrect codes. Wait a few minutes before trying again.",
  AUDITOR_2FA_ALREADY_ENROLLED: "An authenticator is already set up. Enter a code from it.",
  AUDITOR_2FA_NOT_STARTED: "Start authenticator setup first.",
  AUDITOR_2FA_NOT_ENROLLED: "Set up an authenticator first.",
  AUDITOR_TERMS_STALE: "The terms changed while you were reading. Reload the page to review them.",
  ENGAGEMENT_NOT_ACTIVE: "This engagement is no longer active.",
  ENGAGEMENT_NOT_OPEN: "Your access window has not opened yet.",
  SESSION_INVALID: "Your session has ended. Open the link from your email again.",
  UNAUTHORIZED: "Your session has ended. Open the link from your email again.",
  RATE_LIMITED: "Too many attempts. Wait a few minutes and try again.",
};
const GENERIC_FAILURE = "Something went wrong. Please try again.";

function failureMessage(error: unknown): string {
  const code = (error as { error?: { code?: string } } | undefined)?.error?.code;
  return (code && FAILURE_COPY[code]) || GENERIC_FAILURE;
}

export function AuditorEnrolment(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [view, setView] = useState<EnrolmentView | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | null>(null);
  const [savedCodes, setSavedCodes] = useState(false);

  const load = useCallback(async () => {
    const { data, error: err } = await client.GET("/api/v1/auditors/enrolment/state");
    if (err || !data) {
      setFatal(failureMessage(err));
      return;
    }
    setView(data as EnrolmentView);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run one enrolment call; a refusal becomes plain text, success hands the new state to `onOk`. */
  async function act<T>(
    call: () => Promise<{ data?: T; error?: unknown }>,
    onOk: (data: T) => void,
  ) {
    setBusy(true);
    setError(null);
    const { data, error: err } = await call();
    setBusy(false);
    if (err || !data) {
      setError(failureMessage(err));
      void load(); // the lockout clock or the step may have moved
      return;
    }
    onOk(data);
  }

  if (fatal) {
    return (
      <CenteredCardLayout brand={<BrandLockup />}>
        <h1 style={titleStyle}>Auditor access</h1>
        <InlineAlert tone="error">{fatal}</InlineAlert>
      </CenteredCardLayout>
    );
  }
  if (!view) {
    return (
      <CenteredCardLayout brand={<BrandLockup />}>
        <p style={mutedStyle}>Loading…</p>
      </CenteredCardLayout>
    );
  }

  const holdingCodes = recoveryCodes !== null && !savedCodes;
  if (view.stage === "active" && !holdingCodes) {
    return (
      <CenteredCardLayout brand={<BrandLockup />}>
        <h1 style={titleStyle}>You’re set</h1>
        <InlineAlert tone="success">
          Your read-only auditor session is active until {new Date(view.expiresAt).toLocaleString()}
          . It ends automatically when the engagement window closes, and after 10 minutes of
          inactivity.
        </InlineAlert>
        <div style={{ marginTop: t.space4 }}>
          <Button size="lg" style={{ width: "100%" }} onClick={() => navigate("/")}>
            Continue
          </Button>
        </div>
      </CenteredCardLayout>
    );
  }

  return (
    <CenteredCardLayout brand={<BrandLockup />}>
      <div style={{ display: "flex", flexDirection: "column", gap: t.space4 }}>
        <div>
          <h1 style={titleStyle}>Before you start</h1>
          <p style={mutedStyle}>
            Two quick steps protect the records you are about to review. Your access stays closed
            until both are done.
          </p>
        </div>
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        {holdingCodes ? (
          <RecoveryCodesPanel codes={recoveryCodes} onDone={() => setSavedCodes(true)} />
        ) : (
          <>
            <TermsStep
              view={view}
              busy={busy}
              onAccept={(acceptedName) =>
                void act(
                  () =>
                    client.POST("/api/v1/auditors/enrolment/baa", {
                      body: {
                        termsVersion: view.terms.version,
                        termsSha256: view.terms.sha256,
                        acceptedName,
                      },
                    }),
                  (next) => setView(next as EnrolmentView),
                )
              }
            />
            <FactorStep
              view={view}
              busy={busy}
              setup={setup}
              onBegin={() =>
                void act(
                  () => client.POST("/api/v1/auditors/enrolment/totp/begin"),
                  (next) => setSetup(next as TotpSetup),
                )
              }
              onConfirm={(code) =>
                void act(
                  () => client.POST("/api/v1/auditors/enrolment/totp/confirm", { body: { code } }),
                  (next) => {
                    const done = next as { recoveryCodes: string[]; state: EnrolmentView };
                    setSetup(null);
                    setRecoveryCodes(done.recoveryCodes);
                    setView(done.state);
                  },
                )
              }
              onVerify={(body) =>
                void act(
                  () => client.POST("/api/v1/auditors/enrolment/verify", { body }),
                  (next) => setView(next as EnrolmentView),
                )
              }
            />
          </>
        )}
      </div>
    </CenteredCardLayout>
  );
}

function TermsStep(props: {
  view: EnrolmentView;
  busy: boolean;
  onAccept: (acceptedName: string) => void;
}): JSX.Element {
  const { view, busy, onAccept } = props;
  const [name, setName] = useState("");
  const [agreed, setAgreed] = useState(false);
  if (view.baaAccepted) {
    return (
      <section aria-labelledby="terms-heading" style={sectionStyle}>
        <h2 id="terms-heading" style={headingStyle}>
          1. Terms
        </h2>
        <InlineAlert tone="success">Terms accepted.</InlineAlert>
      </section>
    );
  }
  const ready = agreed && name.trim().length >= MIN_NAME_LENGTH;
  return (
    <section aria-labelledby="terms-heading" style={sectionStyle}>
      <h2 id="terms-heading" style={headingStyle}>
        1. Review and accept the terms
      </h2>
      {/* A read-only textarea scrolls, takes focus for keyboard users and is announced with its title. */}
      <textarea
        readOnly
        aria-label={view.terms.title}
        value={view.terms.text}
        rows={8}
        style={termsBoxStyle}
      />
      <TextField
        label="Your full name"
        autoComplete="name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <label style={checkLabelStyle}>
        <input
          type="checkbox"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
        />
        <span>I have read and accept these terms.</span>
      </label>
      <Button loading={busy} disabled={!ready} onClick={() => onAccept(name.trim())}>
        Accept terms
      </Button>
    </section>
  );
}

function FactorStep(props: {
  view: EnrolmentView;
  busy: boolean;
  setup: TotpSetup | null;
  onBegin: () => void;
  onConfirm: (code: string) => void;
  onVerify: (body: { totpCode: string } | { recoveryCode: string }) => void;
}): JSX.Element {
  const { view, busy, setup, onBegin, onConfirm, onVerify } = props;
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const locked = view.lockedUntil !== null && new Date(view.lockedUntil).getTime() > Date.now();

  if (view.secondFactor === "verified") {
    return (
      <section aria-labelledby="factor-heading" style={sectionStyle}>
        <h2 id="factor-heading" style={headingStyle}>
          2. Verify it’s you
        </h2>
        <InlineAlert tone="success">Authenticator verified.</InlineAlert>
      </section>
    );
  }

  if (view.secondFactor === "challenge") {
    return (
      <section aria-labelledby="factor-heading" style={sectionStyle}>
        <h2 id="factor-heading" style={headingStyle}>
          2. Verify it’s you
        </h2>
        <p style={mutedStyle}>
          {useRecovery
            ? "Enter one of your recovery codes. Each works once."
            : "Enter the 6-digit code from your authenticator app."}
        </p>
        {locked ? (
          <InlineAlert tone="warning">
            Too many incorrect codes. Try again after{" "}
            {new Date(view.lockedUntil as string).toLocaleTimeString()}.
          </InlineAlert>
        ) : null}
        <TextField
          label={useRecovery ? "Recovery code" : "Authenticator code"}
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          maxLength={useRecovery ? 32 : CODE_LENGTH}
          value={code}
          onChange={(event) => setCode(event.target.value.trim())}
        />
        <Button
          loading={busy}
          disabled={locked || (useRecovery ? code.length < 16 : code.length < CODE_LENGTH)}
          onClick={() => onVerify(useRecovery ? { recoveryCode: code } : { totpCode: code })}
        >
          Verify
        </Button>
        <Button
          tone="tertiary"
          onClick={() => {
            setUseRecovery((previous) => !previous);
            setCode("");
          }}
        >
          {useRecovery ? "Use authenticator code" : "Use a recovery code"}
        </Button>
      </section>
    );
  }

  return (
    <section aria-labelledby="factor-heading" style={sectionStyle}>
      <h2 id="factor-heading" style={headingStyle}>
        2. Set up an authenticator
      </h2>
      {setup ? (
        <>
          <p style={mutedStyle}>
            Add ChartWarden to your authenticator app with this key, then enter the 6-digit code it
            shows.
          </p>
          <code style={keyStyle} aria-label="Authenticator setup key">
            {setup.manualEntryKey}
          </code>
          <a href={setup.otpauthUri} style={linkStyle}>
            Open in an authenticator app
          </a>
          <TextField
            label="Authenticator code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={CODE_LENGTH}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
          />
          {locked ? (
            <InlineAlert tone="warning">Too many incorrect codes. Wait a few minutes.</InlineAlert>
          ) : null}
          <Button
            loading={busy}
            disabled={locked || code.length < CODE_LENGTH}
            onClick={() => onConfirm(code)}
          >
            Confirm code
          </Button>
        </>
      ) : (
        <>
          <p style={mutedStyle}>
            You’ll use an authenticator app to confirm it’s you each time you start an audit
            session.
          </p>
          <Button loading={busy} onClick={onBegin}>
            {view.totpPending ? "Start setup again" : "Set up authenticator"}
          </Button>
        </>
      )}
    </section>
  );
}

function RecoveryCodesPanel(props: {
  codes: readonly string[];
  onDone: () => void;
}): JSX.Element {
  const { codes, onDone } = props;
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <section aria-labelledby="recovery-heading" style={sectionStyle}>
      <h2 id="recovery-heading" style={headingStyle}>
        Save your recovery codes
      </h2>
      <InlineAlert tone="warning">
        These codes are shown only once. Each one works a single time if you lose your
        authenticator.
      </InlineAlert>
      <ul aria-label="Recovery codes" style={codesStyle}>
        {codes.map((code) => (
          <li key={code} style={{ fontFamily: t.fontMono }}>
            {code}
          </li>
        ))}
      </ul>
      <label style={checkLabelStyle}>
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>I have saved these codes somewhere safe.</span>
      </label>
      <Button disabled={!acknowledged} onClick={onDone}>
        Continue
      </Button>
    </section>
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
const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.95rem",
  fontWeight: 650,
  color: t.onSurface,
};
const sectionStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: t.space3 };
const checkLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: t.space2,
  fontSize: "0.85rem",
  color: t.onSurface,
};
const termsBoxStyle: CSSProperties = {
  width: "100%",
  resize: "none",
  border: "none",
  fontFamily: t.fontSans,
  padding: t.space3,
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
  color: t.onSurface,
  fontSize: "0.8rem",
  lineHeight: 1.45,
};
const keyStyle: CSSProperties = {
  display: "block",
  padding: t.space3,
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
  color: t.onSurface,
  fontFamily: t.fontMono,
  fontSize: "0.85rem",
  overflowWrap: "anywhere",
};
const linkStyle: CSSProperties = { color: t.primary, fontSize: "0.85rem" };
const codesStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: t.space3,
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: t.space2,
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
  color: t.onSurface,
  fontSize: "0.8rem",
};
