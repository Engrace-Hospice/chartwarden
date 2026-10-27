import { Button, CenteredCardLayout, Glyph, useApiClient } from "@chartwarden/ui";
// Restricted funeral-home access: the server binds the session to one decedent. This screen
// must not request or present any chart, contact details or additional clinical information.
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { signOut } from "../auth-http";
import { PortalOnboardingBrand } from "./onboarding-ui";

type FuneralCase = { decedentName: string; dateOfDeath: string };
type CaseState = "loading" | "ready" | "ended";

function deathDate(value: string): string {
  // M31 supplies a calendar date, not a local-time instant: avoid timezone rollover.
  // Accept a date-only string or an ISO timestamp while preserving the encoded calendar date.
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return "Date unavailable";
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d)
    return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

export function PortalFuneralCase(): JSX.Element {
  const client = useApiClient();
  const [status, setStatus] = useState<CaseState>("loading");
  const [caseInfo, setCaseInfo] = useState<FuneralCase | null>(null);
  const [finishing, setFinishing] = useState(false);
  const mounted = useRef(true);
  const finishInFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    void (async () => {
      try {
        const response = await client.GET("/api/v1/funeral/case", {});
        if (!active) return;
        const data = response.data;
        if (
          "error" in response ||
          !data ||
          typeof data.decedentName !== "string" ||
          typeof data.dateOfDeath !== "string"
        ) {
          setStatus("ended");
        } else {
          setCaseInfo({
            decedentName: data.decedentName,
            dateOfDeath: data.dateOfDeath,
          });
          setStatus("ready");
        }
      } catch {
        if (active) setStatus("ended");
      }
    })();
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [client]);

  async function finish(): Promise<void> {
    if (finishInFlight.current) return;
    finishInFlight.current = true;
    setFinishing(true);
    try {
      await signOut();
      if (mounted.current) {
        setCaseInfo(null);
        setStatus("ended");
      }
    } finally {
      finishInFlight.current = false;
      if (mounted.current) setFinishing(false);
    }
  }

  return (
    <CenteredCardLayout brand={<PortalOnboardingBrand />}>
      <div className="wx-funeral-case">
        <span className="wx-funeral-case__icon" aria-hidden="true">
          <Glyph name="shield-check" size={26} />
        </span>
        <h1>Funeral home access</h1>
        {status === "loading" ? (
          <p role="status">Checking your secure access…</p>
        ) : status === "ready" && caseInfo ? (
          <>
            <p>Use the limited details below to confirm that you have the correct case.</p>
            <dl className="wx-funeral-case__details">
              <div>
                <dt>Full legal name</dt>
                <dd>{caseInfo.decedentName}</dd>
              </div>
              <div>
                <dt>Date of death</dt>
                <dd>{deathDate(caseInfo.dateOfDeath)}</dd>
              </div>
            </dl>
            <p className="wx-funeral-case__notice">
              <Glyph name="lock" size={18} aria-hidden="true" />
              Only these details are provided through this restricted link. No other medical record
              information is available here.
            </p>
            <Button loading={finishing} disabled={finishing} onClick={() => void finish()}>
              Finish and close access
            </Button>
          </>
        ) : (
          <div role="status" className="wx-funeral-case__ended">
            <strong>This access is no longer available.</strong>
            <p>If you still need access, ask the hospice care team for a new secure link.</p>
          </div>
        )}
      </div>
    </CenteredCardLayout>
  );
}
