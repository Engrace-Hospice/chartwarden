// apps/web/src/modules/20-field-safety — GAP-032: the emergency-terminus panel on the SOS detail screen.
//
// An alert that reaches `emergency_terminus` has gone unanswered past every tier. This panel is what a
// supervisor sees then, and it is built around one rule: THE 911 INSTRUCTION IS STATIC. It is shown whether or
// not any lookup succeeded, because the lookups (the PSAP catalog, the ops page, the contact call) can all
// fail and the instruction to call emergency services must not depend on them. The PSAP administrative line
// below it is supplementary, labelled with who verified it and when, and is only ever a number a human reads
// and dials - the platform never dials a PSAP.
import { t, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  type SosPsapView,
  type SosTerminusView,
  errorMessage,
  getSosPsap,
  getSosTerminus,
} from "./safety-api";
import { dateTime } from "./safety-status";
import { Card, Notice, linkStyle, mutedStyle } from "./safety-ui";
import { describeTerminus } from "./terminus-status";

/** The ledger moves every 15 s while the alert is unanswered; refresh at the same cadence. */
const REFRESH_MS = 15_000;
const STATIC_EMERGENCY_LINE = "Call 911 (or your local emergency number) now.";

export function TerminusPanel({ sosAlertId }: { sosAlertId: string }): JSX.Element {
  const client = useApiClient();
  const [psap, setPsap] = useState<SosPsapView | null>(null);
  const [terminus, setTerminus] = useState<SosTerminusView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, tm] = await Promise.all([
      getSosPsap(client, sosAlertId),
      getSosTerminus(client, sosAlertId),
    ]);
    setPsap(p.psap);
    setTerminus(tm.terminus);
    const failure = p.error ?? tm.error;
    setError(
      failure ? errorMessage(failure, "The terminus status could not be read right now.") : null,
    );
  }, [client, sosAlertId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const lines = describeTerminus(terminus?.actions ?? []);

  return (
    <Card title="Emergency terminus">
      <Notice tone="error" assertive>
        <strong>{psap?.emergencyLine ?? STATIC_EMERGENCY_LINE}</strong> This alert has gone
        unanswered through every escalation tier. The lines below are supplementary; they do not
        replace calling emergency services.
      </Notice>

      <div style={{ marginTop: t.space3 }}>
        {psap?.psap ? (
          <p style={{ margin: 0 }}>
            <strong>{psap.psap.psapName}</strong> — administrative line{" "}
            <a href={`tel:${psap.psap.phone}`} style={linkStyle}>
              {psap.psap.phone}
            </a>
            {psap.psap.secondaryPhone ? (
              <>
                {" "}
                · alternate{" "}
                <a href={`tel:${psap.psap.secondaryPhone}`} style={linkStyle}>
                  {psap.psap.secondaryPhone}
                </a>
              </>
            ) : null}
            <span style={mutedStyle}>
              {" "}
              · last verified {dateTime(psap.psap.verifiedAt)}
              {psap.psap.stale ? " (OVERDUE for re-verification: confirm by voice)" : ""}
            </span>
          </p>
        ) : (
          <p style={{ margin: 0, ...mutedStyle }}>
            {psap?.reason === "pending"
              ? "Looking up the PSAP line for this location…"
              : psap?.reason === "none"
                ? "No PSAP administrative line is on file for this location. Call 911."
                : "The PSAP line could not be read. Call 911."}
          </p>
        )}
      </div>

      <ul style={{ margin: `${t.space3} 0 0`, paddingLeft: t.space4 }}>
        {lines.map((line) => (
          <li key={line.effect}>
            <strong>{line.label}:</strong> {line.text}
          </li>
        ))}
      </ul>

      {error ? (
        <div style={{ marginTop: t.space3 }}>
          <Notice tone="warning" live>
            {error}
          </Notice>
        </div>
      ) : null}
    </Card>
  );
}
