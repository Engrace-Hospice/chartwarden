import { Button, CenteredCardLayout, Glyph, InlineAlert, useApiClient } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "../auth-http";
import { patientIdOf, validateNext } from "../session-guard";
import {
  PortalOnboardingBrand,
  PortalOnboardingHeading,
  PortalOnboardingHelp,
} from "./onboarding-ui";
import { humanize } from "./portal-format";

interface AccountChoice {
  portalAccountId: string;
  organizationName: string;
  relationship: string;
  blockedReason: string | null;
}

type Phase =
  | { kind: "working" }
  | { kind: "choose"; choices: AccountChoice[] }
  | { kind: "blocked"; message: string }
  | { kind: "failed"; message: string };

export function blockedMessage(reason: string | null): string {
  switch (reason) {
    case "SIGN_IN_ACCOUNT_NOT_ACTIVATED":
      return "Your invitation hasn't been accepted yet. Open the link in your invitation email first, then sign in again.";
    case "SIGN_IN_ACCOUNT_NOT_ACTIVE":
      return "This portal account is on hold. Please contact your care team.";
    case "SIGN_IN_EMAIL_UNVERIFIED":
      return "Your email address isn't verified yet. Use the emailed sign-in link to verify it.";
    case "SIGN_IN_NO_ACTIVE_GRANT":
      return "This account doesn't have access to anyone's records right now. Your care team can help.";
    case "SIGN_IN_ORGANIZATION_NOT_ACTIVE":
      return "This care team's portal isn't available right now. Please try again later.";
    case "SIGN_IN_USER_INACTIVE":
      return "This sign-in is not currently active. Please contact your care team.";
    default:
      return "We couldn't open a family portal account for this sign-in. Use the link in your invitation, or ask your care team for help.";
  }
}

export function PortalSignedIn(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ kind: "working" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const pendingBind = useRef(false);
  const bindRef = useRef<((id: string) => void) | null>(null);

  useEffect(() => {
    void attempt;
    const version = ++generation.current;
    const current = () => version === generation.current;
    setPhase({ kind: "working" });
    setBusyId(null);
    pendingBind.current = false;

    // A `/p/:patientId/...` return path is honoured only when the bound account is granted that patient; the
    // session is then bound to it (select-patient), exactly as the picker would. Any miss falls back to the picker.
    async function canReturnTo(returnTo: string): Promise<boolean> {
      const patientId = patientIdOf(returnTo);
      if (!patientId) return true;
      try {
        const list = await client.GET("/api/v1/portal/sessions/patients", {});
        if ("error" in list) return false;
        const items = (list.data?.items ?? []) as { patientId: string }[];
        if (!items.some((item) => item.patientId === patientId)) return false;
        if (!current()) return false;
        const picked = await client.POST("/api/v1/portal/sessions/select-patient", {
          body: { patientId },
        });
        return !("error" in picked);
      } catch {
        return false;
      }
    }

    async function bind(portalAccountId: string): Promise<void> {
      if (!current() || pendingBind.current) return;
      pendingBind.current = true;
      setBusyId(portalAccountId);
      try {
        const res = await client.POST("/api/v1/portal/sign-in/establish", {
          body: { portalAccountId },
        });
        if (!current()) return;
        if ("error" in res) {
          const code =
            (res.error as { error?: { code?: string } } | undefined)?.error?.code ?? null;
          if (res.response?.status === 401) navigate("/", { replace: true });
          else if (res.response?.status === 429)
            setPhase({
              kind: "failed",
              message: "Too many attempts. Please wait a few minutes and try again.",
            });
          else if (res.response?.status === 403 || res.response?.status === 404)
            setPhase({ kind: "blocked", message: blockedMessage(code) });
          else
            setPhase({
              kind: "failed",
              message: "We couldn't open your account. Please try again.",
            });
        } else {
          const returnTo = validateNext(new URLSearchParams(window.location.search).get("next"));
          const reachable = returnTo ? await canReturnTo(returnTo) : false;
          if (!current()) return;
          if (returnTo && reachable) navigate(returnTo, { replace: true });
          else
            navigate("/patient-picker", {
              replace: true,
              state: { openOnlyPatient: true },
            });
        }
      } catch {
        if (current())
          setPhase({
            kind: "failed",
            message: "We couldn't connect securely. Please try again.",
          });
      } finally {
        if (current()) {
          pendingBind.current = false;
          setBusyId(null);
        }
      }
    }

    // A single eligible account must be bound explicitly: the response may also include blocked accounts.
    async function load(): Promise<void> {
      try {
        const res = await client.GET("/api/v1/portal/sign-in/accounts", {});
        if (!current()) return;
        if ("error" in res) {
          if (res.response?.status === 401) navigate("/", { replace: true });
          else
            setPhase({
              kind: "failed",
              message: "We couldn't check your account. Please try again.",
            });
          return;
        }
        const items = (res.data?.items ?? []) as AccountChoice[];
        const eligible = items.filter((item) => item.blockedReason === null);
        if (!items.length) setPhase({ kind: "blocked", message: blockedMessage(null) });
        else if (!eligible.length)
          setPhase({
            kind: "blocked",
            message: blockedMessage(items[0]?.blockedReason ?? null),
          });
        else if (eligible.length === 1) await bind(eligible[0]!.portalAccountId);
        else setPhase({ kind: "choose", choices: eligible });
      } catch {
        if (current())
          setPhase({
            kind: "failed",
            message: "We couldn't connect securely. Please try again.",
          });
      }
    }
    void load();

    // The account selection handler uses this effect-scoped closure, never a stale account list.
    bindRef.current = (id: string) => void bind(id);
    return () => {
      generation.current++;
      bindRef.current = null;
    };
  }, [client, navigate, attempt]);

  async function leave(): Promise<void> {
    generation.current++;
    await signOut();
    navigate("/", { replace: true });
  }

  return (
    <CenteredCardLayout brand={<PortalOnboardingBrand />} footer={<PortalOnboardingHelp />}>
      <div className="wx-portal-onboarding wx-portal-onboarding--accounts">
        {phase.kind === "working" ? (
          // biome-ignore lint/a11y/useSemanticElements: <output> allows phrasing content only; this status holds flow content.
          <div role="status" className="wx-portal-onboarding__busy">
            <span className="wx-portal-onboarding__busy-icon" aria-hidden="true">
              <Glyph name="shield-check" size={26} />
            </span>
            <PortalOnboardingHeading
              eyebrow="Secure access"
              title="Opening your account"
              description="Checking which care information you are allowed to view."
            />
          </div>
        ) : phase.kind === "choose" ? (
          <div className="wx-portal-auth-form">
            <PortalOnboardingHeading
              eyebrow="Your organizations"
              title="Choose your care team"
              description="Select the hospice organization whose portal you'd like to open."
            />
            <div className="wx-portal-account-choices" aria-label="Available portal accounts">
              {phase.choices.map((choice) => (
                <button
                  key={choice.portalAccountId}
                  type="button"
                  className="wx-portal-account-choice"
                  disabled={busyId !== null}
                  onClick={() => bindRef.current?.(choice.portalAccountId)}
                >
                  <span className="wx-portal-account-choice__icon" aria-hidden="true">
                    <Glyph name="heart" size={22} />
                  </span>
                  <span className="wx-portal-account-choice__content">
                    <strong>{choice.organizationName || "Your hospice team"}</strong>
                    <small>Access as {humanize(choice.relationship)}</small>
                  </span>
                  <span aria-hidden="true">
                    {busyId === choice.portalAccountId ? "Opening…" : "→"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="wx-portal-auth-form">
            <PortalOnboardingHeading
              eyebrow="Account access"
              title="We couldn't open the portal"
              description="Your hospice care team can help if your access has changed."
            />
            <InlineAlert tone="error">{phase.message}</InlineAlert>
            {phase.kind === "failed" ? (
              <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
            ) : null}
            <Button tone="secondary" onClick={() => void leave()}>
              Back to sign in
            </Button>
          </div>
        )}
      </div>
    </CenteredCardLayout>
  );
}
