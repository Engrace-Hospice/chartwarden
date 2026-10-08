import { Button, CenteredCardLayout, InlineAlert, t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — Signed in (`/signed-in`). The landing for the sign-in link / password flow: the browser is now
// AUTHENTICATED but its session is not yet a portal session. This screen asks the server which family portal accounts
// the signed-in user holds (their OWN, no PHI — a tenant name and a relationship), binds the session to the right one,
// and moves on to the patient picker. One eligible account binds automatically; several ask the person to choose; a
// blocked account says why in plain words (invitation not accepted yet, suspended, email not verified, no access).
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "../auth-http";
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

/** Plain-language copy for each typed refusal (the server names the real reason; the page never shows the code). */
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
  const started = useRef(false);

  async function establish(portalAccountId?: string): Promise<void> {
    setBusyId(portalAccountId ?? "auto");
    const res = await client.POST("/api/v1/portal/sign-in/establish", {
      body: portalAccountId ? { portalAccountId } : {},
    });
    setBusyId(null);
    if (res.error) {
      const code = (res.error as { error?: { code?: string } } | undefined)?.error?.code ?? null;
      if (res.response?.status === 429) {
        setPhase({
          kind: "failed",
          message: "Too many attempts. Please wait a few minutes and try again.",
        });
      } else if (res.response?.status === 401) {
        navigate("/");
      } else {
        setPhase({ kind: "blocked", message: blockedMessage(code) });
      }
      return;
    }
    navigate("/patient-picker");
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per mount; `establish` is stable enough here
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const res = await client.GET("/api/v1/portal/sign-in/accounts", {});
      if (res.error) {
        if (res.response?.status === 401) navigate("/");
        else
          setPhase({
            kind: "failed",
            message: "We couldn't check your account. Please try again.",
          });
        return;
      }
      const items = (res.data?.items ?? []) as AccountChoice[];
      if (items.length === 0) {
        setPhase({ kind: "blocked", message: blockedMessage(null) });
        return;
      }
      const eligible = items.filter((a) => a.blockedReason === null);
      if (eligible.length === 0) {
        setPhase({ kind: "blocked", message: blockedMessage(items[0]?.blockedReason ?? null) });
      } else if (eligible.length === 1) {
        await establish();
      } else {
        setPhase({ kind: "choose", choices: eligible });
      }
    })();
  }, [client, navigate]);

  async function leave(): Promise<void> {
    await signOut();
    navigate("/");
  }

  return (
    <CenteredCardLayout
      brand={
        <div style={{ fontFamily: t.fontDisplay, fontSize: "1.5rem", fontWeight: 600 }}>
          WardenX Family Portal
        </div>
      }
    >
      {phase.kind === "working" ? (
        <output style={{ margin: 0 }}>Opening your account…</output>
      ) : phase.kind === "choose" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: t.space3 }}>
          <h1 style={{ margin: 0, fontSize: "1.15rem" }}>Which account would you like to open?</h1>
          {phase.choices.map((choice) => (
            <Button
              key={choice.portalAccountId}
              tone="secondary"
              loading={busyId === choice.portalAccountId}
              onClick={() => void establish(choice.portalAccountId)}
            >
              {choice.organizationName} · {humanize(choice.relationship)}
            </Button>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: t.space3 }}>
          <h1 style={{ margin: 0, fontSize: "1.15rem" }}>We couldn't open the portal</h1>
          <InlineAlert tone="error">{phase.message}</InlineAlert>
          <Button tone="secondary" onClick={() => void leave()}>
            Back to sign in
          </Button>
        </div>
      )}
    </CenteredCardLayout>
  );
}
