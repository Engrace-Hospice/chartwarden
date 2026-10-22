import {
  Button,
  Glyph,
  InlineAlert,
  StatusPill,
  TextField,
  useApiClient,
  useTheme,
} from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { Link } from "react-router-dom";
import { PORTAL_BASE_PATH } from "../base-path";
import { humanize, readError, statusTone } from "./portal-format";
import { PortalLoadState, PortalPage } from "./portal-page";

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
  const [stepState, setStepState] = useState<{
    tone: "ok" | "err";
    msg: string;
  } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const inFlightStep = useRef(false);
  const inFlightLogout = useRef(false);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    void loadAttempt;
    let current = true;
    setLoading(true);
    setError(null);
    setCtx(null);
    void (async () => {
      try {
        const res = await client.GET("/api/v1/portal/sessions/current", {});
        if (!current) return;
        if ("error" in res) setError(readError(res.response?.status));
        else setCtx((res.data as SessionContext) ?? null);
      } catch {
        if (current) setError(readError(undefined));
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [client, loadAttempt]);

  async function stepUp(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (inFlightStep.current || !/^\d{6,8}$/.test(totp.trim())) return;
    inFlightStep.current = true;
    setStepState(null);
    setVerifying(true);
    try {
      const res = await client.POST("/api/v1/portal/sessions/step-up", {
        body: { totpCode: totp.trim() },
      });
      if (!active.current) return;
      if ("error" in res) {
        setStepState({ tone: "err", msg: readError(res.response?.status) });
      } else {
        setStepState({
          tone: "ok",
          msg: "Identity verified for the current security step. Additional account changes still require an available, authorized workflow.",
        });
      }
    } catch {
      if (active.current)
        setStepState({
          tone: "err",
          msg: "We couldn't verify this code right now. Please try again.",
        });
    } finally {
      inFlightStep.current = false;
      if (active.current) {
        setTotp("");
        setVerifying(false);
      }
    }
  }

  async function logout(): Promise<void> {
    if (inFlightLogout.current) return;
    inFlightLogout.current = true;
    setSigningOut(true);
    setSignOutError(null);
    try {
      const res = await client.POST("/api/v1/portal/sessions/logout", {});
      if ("error" in res) {
        if (active.current) setSignOutError("We couldn't confirm sign-out. Please try again.");
        return;
      }
      // Full navigation ensures no patient-scoped React state survives a successful sign-out.
      window.location.assign(`${PORTAL_BASE_PATH}/`);
    } catch {
      if (active.current) setSignOutError("We couldn't confirm sign-out. Please try again.");
    } finally {
      inFlightLogout.current = false;
      if (active.current) setSigningOut(false);
    }
  }

  const patientPath = ctx?.activePatientId ? `/p/${encodeURIComponent(ctx.activePatientId)}` : null;
  const prefsPath = patientPath ? `${patientPath}/preferences` : null;

  return (
    <PortalPage
      title="Account & security"
      subtitle="Manage your portal access, security, and preferences."
      width="standard"
      className="wx-portal-account-page"
      actions={
        patientPath ? (
          <Link className="wx-portal-account-back" to={patientPath}>
            ← Back to patient home
          </Link>
        ) : undefined
      }
    >
      <PortalLoadState
        loading={loading}
        error={error}
        empty={!ctx}
        emptyTitle="Account unavailable"
        emptyDescription="We couldn't load your account. Please sign in again."
        onRetry={() => setLoadAttempt((value) => value + 1)}
      >
        <div className="wx-portal-account-surface">
          <section className="wx-portal-account-section" aria-labelledby="portal-access-heading">
            <div className="wx-portal-account-section__heading">
              <span aria-hidden="true">
                <Glyph name="users" size={18} />
              </span>
              <div>
                <h2 id="portal-access-heading">Portal access</h2>
                <p>Your current Family Portal access.</p>
              </div>
            </div>
            <div className="wx-portal-access-summary">
              <dl className="wx-portal-settings-details">
                <div>
                  <dt>Relationship</dt>
                  <dd>{ctx ? humanize(ctx.relationship) : "—"}</dd>
                </div>
                <div>
                  <dt>Access status</dt>
                  <dd>
                    {ctx ? (
                      <StatusPill tone={statusTone(ctx.status)} label={humanize(ctx.status)} />
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
              </dl>
              {patientPath ? (
                <Link to="/patient-picker" className="wx-portal-account-link">
                  Switch patient <Glyph name="arrow-right" size={15} />
                </Link>
              ) : (
                <Link to="/patient-picker" className="wx-portal-account-link">
                  Choose a patient <Glyph name="arrow-right" size={15} />
                </Link>
              )}
            </div>
          </section>

          <section className="wx-portal-account-section" aria-labelledby="portal-verify-heading">
            <div className="wx-portal-account-section__heading">
              <span aria-hidden="true">
                <Glyph name="shield-check" size={18} />
              </span>
              <div>
                <h2 id="portal-verify-heading">Verify your identity</h2>
                <p>Use an authenticator code when an additional security check is required.</p>
              </div>
            </div>
            <form className="wx-portal-settings-verify" onSubmit={(e) => void stepUp(e)}>
              <TextField
                label="One-time code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                required
                maxLength={8}
                value={totp}
                onChange={(e) => {
                  setTotp(e.target.value);
                  setStepState(null);
                }}
              />
              <Button
                type="submit"
                loading={verifying}
                disabled={verifying || !/^\d{6,8}$/.test(totp.trim())}
              >
                Verify code
              </Button>
            </form>
            {stepState ? (
              <output className="wx-portal-settings-feedback">
                <InlineAlert tone={stepState.tone === "err" ? "error" : "success"}>
                  {stepState.msg}
                </InlineAlert>
              </output>
            ) : null}
            <p className="wx-portal-settings-hint">
              Verification applies only to the current security step. It does not change account
              permissions.
            </p>
          </section>

          <section
            className="wx-portal-account-section"
            aria-labelledby="portal-preferences-heading"
          >
            <div className="wx-portal-account-section__heading">
              <span aria-hidden="true">
                <Glyph name="settings" size={18} />
              </span>
              <div>
                <h2 id="portal-preferences-heading">Preferences</h2>
                <p>Display and notification options.</p>
              </div>
            </div>
            <div className="wx-portal-setting-row">
              <div>
                <strong>Appearance</strong>
                <small>Saved on this device.</small>
              </div>
              <fieldset className="wx-portal-theme-options" aria-label="Color theme">
                <button
                  type="button"
                  className={mode === "light" ? "is-active" : ""}
                  aria-pressed={mode === "light"}
                  onClick={() => {
                    if (mode !== "light") toggle();
                  }}
                >
                  <Glyph name="sun" size={15} /> Light
                </button>
                <button
                  type="button"
                  className={mode === "dark" ? "is-active" : ""}
                  aria-pressed={mode === "dark"}
                  onClick={() => {
                    if (mode !== "dark") toggle();
                  }}
                >
                  <Glyph name="moon" size={15} /> Dark
                </button>
              </fieldset>
            </div>
            <div className="wx-portal-setting-row">
              <div>
                <strong>Notifications</strong>
                <small>Review the channels available for the selected patient.</small>
              </div>
              {prefsPath ? (
                <Link className="wx-portal-account-link" to={prefsPath}>
                  View notification preferences <Glyph name="chevron-right" size={15} />
                </Link>
              ) : (
                <span className="wx-portal-settings-hint">Choose a patient first.</span>
              )}
            </div>
          </section>

          <section
            className="wx-portal-account-section wx-portal-session-row"
            aria-labelledby="portal-signout-heading"
          >
            <div>
              <h2 id="portal-signout-heading">Session</h2>
              <p>Sign out when using a shared device.</p>
            </div>
            <div>
              {signOutError ? <InlineAlert tone="error">{signOutError}</InlineAlert> : null}
              <Button
                tone="secondary"
                loading={signingOut}
                disabled={signingOut}
                onClick={() => void logout()}
              >
                Sign out
              </Button>
            </div>
          </section>
        </div>
      </PortalLoadState>
    </PortalPage>
  );
}
