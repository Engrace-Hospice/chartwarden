import { Button, InlineAlert, StatusPill, TextField, useApiClient, useTheme } from "@wardenx/ui";
// @wardenx/portal — §5.1 Account settings (`/account`). Reads the current session (GET /portal/sessions/current)
// for the account's identity + status, offers the step-up flow (POST /portal/sessions/step-up with a TOTP code
// — required before sensitive changes, §4.1) and sign-out (POST /portal/sessions/logout). This surface holds no
// clinical PHI; it is the account's own security posture.
import { useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { humanize, readError, statusTone } from "./portal-format";
import { PortalCard, PortalLoadState, PortalPage } from "./portal-page";

interface SessionContext {
  portalAccountId: string;
  activePatientId: string | null;
  scopeSet: string[];
  relationship: string;
  status: string;
}

export function PortalAccount(): JSX.Element {
  const client = useApiClient();
  const { mode, toggle } = useTheme();
  const [ctx, setCtx] = useState<SessionContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totp, setTotp] = useState("");
  const [stepState, setStepState] = useState<{ tone: "ok" | "err"; msg: string } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    void loadAttempt;
    let active = true;
    void (async () => {
      setLoading(true);
      setError(null);
      const res = await client.GET("/api/v1/portal/sessions/current", {});
      if (!active) return;
      if (res.error) setError(readError(res.response?.status));
      else setCtx((res.data as SessionContext) ?? null);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, loadAttempt]);

  async function stepUp(e: FormEvent): Promise<void> {
    e.preventDefault();
    setStepState(null);
    setVerifying(true);
    const res = await client.POST("/api/v1/portal/sessions/step-up", { body: { totpCode: totp } });
    setVerifying(false);
    if (res.error) {
      setStepState({ tone: "err", msg: readError(res.response?.status) });
      return;
    }
    setStepState({ tone: "ok", msg: "Verified. You can now make sensitive changes." });
    setTotp("");
  }

  async function logout(): Promise<void> {
    setSigningOut(true);
    await client.POST("/api/v1/portal/sessions/logout");
    window.location.assign("/");
  }

  return (
    <PortalPage
      title="Account & security"
      subtitle="Your sign-in and access settings."
      width="reading"
    >
      <PortalLoadState
        loading={loading}
        error={error}
        empty={!ctx}
        emptyTitle="Account unavailable"
        emptyDescription="We couldn't load your account. Please sign in again."
        onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
      >
        <PortalCard heading="Your access">
          <div className="wx-portal-setting-row">
            <span>{ctx ? humanize(ctx.relationship) : ""}</span>
            {ctx ? <StatusPill tone={statusTone(ctx.status)} label={humanize(ctx.status)} /> : null}
          </div>
          <p className="wx-portal-supporting-copy">
            {ctx
              ? `${ctx.scopeSet.length} area${ctx.scopeSet.length === 1 ? "" : "s"} of access granted.`
              : ""}
          </p>
        </PortalCard>

        <PortalCard heading="Verify your identity">
          <p className="wx-portal-supporting-copy">
            Some changes need a one-time code from your authenticator app.
          </p>
          <form className="wx-portal-inline-form" onSubmit={(e) => void stepUp(e)}>
            <TextField
              label="One-time code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              placeholder="6-digit code"
              required
              maxLength={8}
            />
            <Button type="submit" loading={verifying} disabled={totp.trim().length < 6}>
              Verify
            </Button>
          </form>
          {stepState ? (
            <InlineAlert tone={stepState.tone === "err" ? "error" : "success"}>
              {stepState.msg}
            </InlineAlert>
          ) : null}
        </PortalCard>

        <PortalCard heading="Appearance">
          <div className="wx-portal-setting-row">
            <div>
              <strong>{mode === "dark" ? "Dark theme" : "Light theme"}</strong>
              <p className="wx-portal-supporting-copy">Your choice is saved on this device.</p>
            </div>
            <Button tone="secondary" onClick={toggle} aria-pressed={mode === "dark"}>
              Use {mode === "dark" ? "light" : "dark"} theme
            </Button>
          </div>
        </PortalCard>

        <PortalCard heading="Sign out">
          <Button tone="secondary" loading={signingOut} onClick={() => void logout()}>
            Sign out of this device
          </Button>
        </PortalCard>
      </PortalLoadState>
    </PortalPage>
  );
}
