import { Button, localInputToIso, nowLocalInput, t, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/15-discipline-care-plans — the "Record supervisory visit" modal (§5.1 #5, route 15).
//
// A PHONE-only supervision (no source encounter) is recorded for survey discoverability but does NOT re-arm the
// 14-day clock (§2.2.4 D3) — the modal says so at the point of capture, not after the fact. Only the plan's NAMED
// supervising RN (or a covering Clinical Supervisor / DON) may attest — that is the `aide_supervisor_eligible`
// ABAC on routes 15/16, and a refusal is surfaced verbatim.
//
// The aide and the supervising RN are PICKED from the plan's staff roster (`./aide-roster`), never typed: a native
// dropdown of real people, prefilled from the plan's own binding. When the roster cannot be loaded the modal says
// so and refuses to submit rather than falling back to free-text membership ids.
import { useState } from "react";
import type { JSX } from "react";
import type { AideRoster, AideRosterMember } from "./aide-roster";
import { type PlanDetail, errorMessage, writeHeaders } from "./discipline-api";
import { shortId } from "./discipline-status";
import { Modal, Notice, SelectField, TextAreaField, TextField } from "./discipline-ui";

const MODE_OPTIONS = [
  { value: "aide_present", label: "Aide present" },
  { value: "observation_of_work", label: "Observation of the aide's work" },
];

/** The §4.2 narrative floor the server enforces (`minLength: 40`) — surfaced before the round trip. */
const NARRATIVE_MIN = 40;

/**
 * The dropdown choices: the roster, plus the member the plan already binds when the roster does not list them
 * (the server only accepts the plan's own aide / RN, so a bound member must stay selectable).
 */
function pickerOptions(
  placeholder: string,
  members: readonly AideRosterMember[],
  boundId: string | null,
  rosterReady: boolean,
): { value: string; label: string }[] {
  const listed = boundId !== null && members.some((m) => m.membershipId === boundId);
  return [
    { value: "", label: placeholder },
    ...members.map((m) => ({ value: m.membershipId, label: m.displayName })),
    ...(rosterReady && boundId !== null && !listed
      ? [{ value: boundId, label: shortId(boundId) }]
      : []),
  ];
}

export function SupervisoryVisitModal({
  plan,
  roster,
  onClose,
  onRecorded,
}: {
  plan: PlanDetail;
  roster: AideRoster;
  onClose: () => void;
  onRecorded: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [aideMembershipId, setAide] = useState(plan.aideMembershipId ?? "");
  const [supervisingRnMembershipId, setRn] = useState(plan.supervisingRnMembershipId ?? "");
  const [sourceEncounterId, setEncounter] = useState("");
  const [supervisoryAt, setAt] = useState(nowLocalInput);
  const [attestationMode, setMode] = useState("aide_present");
  const [satisfactory, setSatisfactory] = useState(true);
  const [correctiveActions, setCorrective] = useState("");
  const [narrative, setNarrative] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rosterReady = !roster.loading && roster.error === null;
  const phoneOnly = sourceEncounterId.trim().length === 0;
  const canSubmit =
    rosterReady &&
    aideMembershipId.length > 0 &&
    supervisingRnMembershipId.length > 0 &&
    narrative.trim().length >= NARRATIVE_MIN &&
    (satisfactory || correctiveActions.trim().length > 0) &&
    !busy;

  async function submit(): Promise<void> {
    const supervisoryAtIso = localInputToIso(supervisoryAt);
    if (!supervisoryAtIso) {
      setError("Enter the date and time of the supervisory visit.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await client.POST("/api/v1/discipline-plans/{planId}/aide-supervisory-visits", {
      params: { path: { planId: plan.planId }, header: writeHeaders() },
      body: {
        aideMembershipId,
        supervisingRnMembershipId,
        sourceEncounterId: phoneOnly ? null : sourceEncounterId,
        supervisoryAt: supervisoryAtIso,
        attestationMode,
        aidePerformanceSatisfactory: satisfactory,
        correctiveActions: correctiveActions.trim() === "" ? null : correctiveActions,
        supervisoryNarrative: narrative,
      },
    } as never);
    setBusy(false);
    if (res.error) {
      setError(
        errorMessage(
          res.error,
          "The supervisory attestation was not recorded. Only this plan's supervising RN (or a covering supervisor) may attest.",
        ),
      );
      return;
    }
    onRecorded();
  }

  return (
    <Modal
      title="Record supervisory visit"
      onClose={onClose}
      footer={
        <Button tone="primary" type="button" onClick={() => void submit()} disabled={!canSubmit}>
          {busy ? "Recording…" : "Record attestation"}
        </Button>
      }
    >
      {roster.error ? (
        <p role="alert" className="wx-text-error">
          {roster.error} The aide and supervising RN cannot be chosen until it loads — close this
          window and try again.
        </p>
      ) : null}
      <SelectField
        label="Aide"
        value={aideMembershipId}
        options={pickerOptions("Select an aide", roster.aides, plan.aideMembershipId, rosterReady)}
        onChange={setAide}
        disabled={!rosterReady}
      />
      {rosterReady && roster.aides.length === 0 && !plan.aideMembershipId ? (
        <span className="wx-text-muted">No active aide is sited at this plan's location.</span>
      ) : null}
      <SelectField
        label="Supervising RN"
        value={supervisingRnMembershipId}
        options={pickerOptions(
          "Select a supervising RN",
          roster.supervisors,
          plan.supervisingRnMembershipId,
          rosterReady,
        )}
        onChange={setRn}
        disabled={!rosterReady}
      />
      {rosterReady && roster.supervisors.length === 0 && !plan.supervisingRnMembershipId ? (
        <span className="wx-text-muted">No active RN is sited at this plan's location.</span>
      ) : null}
      <TextField
        label="Source encounter id (leave blank for a phone-only contact)"
        value={sourceEncounterId}
        onChange={setEncounter}
      />
      <TextField
        label="Supervisory date and time"
        type="datetime-local"
        value={supervisoryAt}
        onChange={setAt}
      />
      <SelectField
        label="Attestation mode"
        value={attestationMode}
        options={MODE_OPTIONS}
        onChange={setMode}
      />
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: t.space2,
          fontSize: "0.82rem",
          color: t.onSurface,
        }}
      >
        <input
          type="checkbox"
          checked={satisfactory}
          onChange={(e) => setSatisfactory(e.target.checked)}
        />
        Aide performance satisfactory
      </label>
      {!satisfactory ? (
        <TextAreaField
          label="Corrective actions"
          value={correctiveActions}
          onChange={setCorrective}
          rows={3}
          hint="Required when performance is not satisfactory."
        />
      ) : null}
      <TextAreaField
        label="Supervisory narrative"
        value={narrative}
        onChange={setNarrative}
        rows={5}
        hint={`At least ${NARRATIVE_MIN} characters — the survey-facing record of what was supervised.`}
      />
      {phoneOnly ? (
        <Notice tone="warning">
          A supervision with no source encounter is recorded for survey discoverability but does NOT
          re-arm the 14-day clock.
        </Notice>
      ) : null}
      {error ? <p className="wx-text-error">{error}</p> : null}
    </Modal>
  );
}
