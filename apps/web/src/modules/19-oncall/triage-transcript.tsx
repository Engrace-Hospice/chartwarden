// apps/web/src/modules/19-oncall — THE TRANSCRIPT DECRYPT (`/triage/calls/:triageCallId/transcript`,
// §4.1 row 14, Track B / ADR-0030).
//
// A SCREEN §5.1 DOES NOT LIST, and it is here for the same reason M21's DEA perpetual log was: §4.6 gives
// the transcript decrypt its OWN permission key (`triage.read_transcript`, disjoint from `triage.read`),
// and nav visibility is per-screen. Folding it into the panel would have made `triage.read` the effective
// gate on the caller's own words — strictly wider than §4.6 says — and a clinician who may work a call
// must not thereby acquire the encrypted transcript of every call they can see.
//
// THREE GATES, ALL DISTINCT, ALL THE SERVER'S: the separate permission, an M2 step-up, and a per-access M4
// audit row (§8.7.2's `triage.transcript_decrypted`). This screen does NOT pre-flight any of them — it
// asks, and reports what the server said. A client-side "you probably can't" would be a fourth opinion
// about authority, and the only one not written down.
//
// THE READ IS DELIBERATE, NOT AUTOMATIC. Loading the screen does not decrypt: the button below does. A
// screen that decrypted on mount would write an access row every time somebody mis-clicked a link, and an
// audit trail of accidents is one nobody can read for intent.
import { EmptyState, PageHeader, useApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { type TriageTranscriptView, errorMessage, getTranscript } from "./oncall-api";
import { dateTime, shortId } from "./oncall-status";
import {
  Card,
  Field,
  Notice,
  SummaryGrid,
  alertStyle,
  columnStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
} from "./oncall-ui";

/** The verbatim block. A caller's own words are rendered as pre-wrapped text, never parsed or linkified:
 *  what was said is a record, not markup. */
const verbatimStyle = {
  margin: 0,
  whiteSpace: "pre-wrap" as const,
  fontSize: "0.85rem",
  lineHeight: 1.6,
};

export function TriageTranscriptScreen(): JSX.Element {
  const client = useApiClient();
  const { triageCallId = "" } = useParams<{ triageCallId: string }>();
  const [transcript, setTranscript] = useState<TriageTranscriptView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decrypt(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await getTranscript(client, triageCallId);
    setBusy(false);
    if (res.error || !res.transcript) {
      setError(
        errorMessage(
          res.error,
          "The transcript could not be decrypted. A refusal here is one of three things — you do not hold `triage.read_transcript`, your session has no recent step-up, or this call is outside your reach — and the server does not say which.",
        ),
      );
      return;
    }
    setTranscript(res.transcript);
  }

  if (!client) return <EmptyState title="Unavailable" description="No API client is configured." />;

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Transcript {shortId(triageCallId)}</span>}
        actions={
          <Link to={`/triage/calls/${triageCallId}`} style={ghostButtonStyle}>
            Back to the panel
          </Link>
        }
      />

      <Notice tone="warning">
        <strong>This read is recorded and it names you.</strong> Decrypting the transcript writes a
        per-access audit row on top of the ordinary read trail, needs a permission separate from the
        one that let you open the call, and needs a recent step-up. Open it because you need it, not
        to see whether you can.
      </Notice>

      {!transcript ? (
        <Card title="Decrypt">
          <span style={mutedStyle}>
            The caller's own words and the call transcript are stored encrypted under the per-tenant
            key envelope. Nothing is decrypted until you ask.
          </span>
          <div>
            <button
              type="button"
              style={busy ? disabledButtonStyle : primaryButtonStyle}
              disabled={busy}
              onClick={() => void decrypt()}
            >
              {busy ? "Decrypting…" : "Decrypt the transcript"}
            </button>
          </div>
          {error ? <p style={alertStyle}>{error}</p> : null}
        </Card>
      ) : (
        <>
          <Card title="Decrypted">
            <SummaryGrid>
              <Field label="Call" value={shortId(transcript.triageCallId)} mono />
              <Field label="Decrypted at" value={dateTime(transcript.decryptedAt)} />
            </SummaryGrid>
          </Card>

          <Card title="Caller's own words">
            {transcript.callerQuote ? (
              <p style={verbatimStyle}>{transcript.callerQuote}</p>
            ) : (
              <span style={mutedStyle}>
                No caller quote was captured on this call. That is an absence of a recording, not a
                redaction — this route returns the plaintext or nothing.
              </span>
            )}
          </Card>

          <Card title="Transcript">
            {transcript.transcript ? (
              <p style={verbatimStyle}>{transcript.transcript}</p>
            ) : (
              <span style={mutedStyle}>
                This call carries no transcript. Phase 1 captures no call AUDIO at all (D14) — there
                is no storage and no transcription pipeline anywhere in M19 — so a transcript exists
                only where one was typed.
              </span>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
