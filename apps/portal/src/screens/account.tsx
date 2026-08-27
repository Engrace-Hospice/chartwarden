import { StatusPill, t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Account settings (`/account`). Reads the current session (GET /portal/sessions/current)
// for the account's identity + status, offers the step-up flow (POST /portal/sessions/step-up with a TOTP code
// — required before sensitive changes, §4.1) and sign-out (POST /portal/sessions/logout). This surface holds no
// clinical PHI; it is the account's own security posture.
import { useEffect, useState } from "react";
import type { CSSProperties, FormEvent, JSX } from "react";
import { humanize, readError, statusTone } from "./portal-format";
import { PortalCard, PortalLoadState, PortalPage } from "./portal-page";

interface SessionContext {
  portalAccountId: string;
  activePatientId: string | null;
  scopeSet: string[];
  relationship: string;
  status: string;
}

const control: CSSProperties = {
  padding: "0.5rem 0.6rem",
  borderRadius: "0.45rem",
  border: `1px solid ${t.surfaceContainer}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  fontSize: "0.9rem",
};
const primaryBtn: CSSProperties = {
  padding: "0.55rem 0.9rem",
  borderRadius: "0.5rem",
  border: "none",
  background: t.primary,
  color: t.onPrimary,
  fontWeight: 600,
  cursor: "pointer",
};
const ghostBtn: CSSProperties = {
  ...primaryBtn,
  background: t.surfaceContainer,
  color: t.onSurface,
};

export function PortalAccount(): JSX.Element {
  const client = useApiClient();
  const [ctx, setCtx] = useState<SessionContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totp, setTotp] = useState("");
  const [stepState, setStepState] = useState<{ tone: "ok" | "err"; msg: string } | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      const res = await client.GET("/api/v1/portal/sessions/current", {});
      if (!active) return;
      if (res.error) setError(readError(res.response?.status));
      else setCtx((res.data as SessionContext) ?? null);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  async function stepUp(e: FormEvent): Promise<void> {
    e.preventDefault();
    setStepState(null);
    const res = await client.POST("/api/v1/portal/sessions/step-up", { body: { totpCode: totp } });
    if (res.error) {
      setStepState({ tone: "err", msg: readError(res.response?.status) });
      return;
    }
    setStepState({ tone: "ok", msg: "Verified. You can now make sensitive changes." });
    setTotp("");
  }

  async function logout(): Promise<void> {
    await client.POST("/api/v1/portal/sessions/logout");
    window.location.assign("/");
  }

  return (
    <PortalPage title="Account & security" subtitle="Your sign-in and access settings.">
      <PortalLoadState
        loading={loading}
        error={error}
        empty={!ctx}
        emptyTitle="Account unavailable"
        emptyDescription="We couldn't load your account. Please sign in again."
      >
        <PortalCard heading="Your access">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "0.92rem",
            }}
          >
            <span>{ctx ? humanize(ctx.relationship) : ""}</span>
            {ctx ? <StatusPill tone={statusTone(ctx.status)} label={humanize(ctx.status)} /> : null}
          </div>
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.82rem", color: t.onSurfaceVariant }}>
            {ctx
              ? `${ctx.scopeSet.length} area${ctx.scopeSet.length === 1 ? "" : "s"} of access granted.`
              : ""}
          </p>
        </PortalCard>

        <PortalCard heading="Verify your identity">
          <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: t.onSurfaceVariant }}>
            Some changes need a one-time code from your authenticator app.
          </p>
          <form
            onSubmit={(e) => void stepUp(e)}
            style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}
          >
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              placeholder="6-digit code"
              required
              style={{ ...control, width: "8rem" }}
              aria-label="One-time code"
            />
            <button type="submit" style={primaryBtn} disabled={totp.trim().length === 0}>
              Verify
            </button>
          </form>
          {stepState ? (
            <p
              role={stepState.tone === "err" ? "alert" : "status"}
              style={{
                margin: "0.6rem 0 0",
                fontSize: "0.85rem",
                color: stepState.tone === "err" ? t.error : t.success,
              }}
            >
              {stepState.msg}
            </p>
          ) : null}
        </PortalCard>

        <PortalCard heading="Sign out">
          <button type="button" style={ghostBtn} onClick={() => void logout()}>
            Sign out of this device
          </button>
        </PortalCard>
      </PortalLoadState>
    </PortalPage>
  );
}
