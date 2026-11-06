// apps/web/src/modules/16-bereavement — completing an ASSESSMENT CHECKPOINT (ADR-0109 D3/D5), the form behind the risk
// view's checkpoint panel. A checkpoint (the d28 initial assessment, the d180 midpoint reassessment) is completed only by a
// HUMAN-appended score: this posts route 28 with the task id, the task's own contact and the eight tri-state factors the
// clinician states, plus an optional PG-13 total. Three things it is careful about:
//
//  1. THE CONTACT IS THE TASK'S. There is no scope picker: the assessment is about one survivor and the server refuses a
//     score aimed at another.
//  2. PROVENANCE. The INITIAL assessment starts from the pre-death draft an MSW / chaplain / counselor recorded (when one
//     is readable), says so, and every factor stays editable — the draft is evidence, not a verdict. A draft that cannot be
//     read (404: not on the care team, no such admission) leaves every factor `unknown` and claims nothing.
//  3. THE MIDPOINT ASKS ABOUT DELAYED GRIEF. The clinician must answer; "yes" makes the PG-13 total required, because a
//     delayed-grief concern is exactly what the screen substantiates (a total of 25+ promotes the tier to complicated).
import { useApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import {
  type AssessmentTaskRow,
  type BereavementRiskFactors,
  type PreDeathDraft,
  type TriState,
  errorMessage,
  recomputeRisk,
} from "./bereavement-api";
import {
  RISK_FACTOR_KEYS,
  assessmentTaskKindLabel,
  riskFactorLabel,
  shortDate,
} from "./bereavement-status";
import {
  ErrorText,
  Modal,
  Notice,
  SelectField,
  TextField,
  mutedStyle,
  primaryButtonStyle,
} from "./bereavement-ui";

const PG13_MAX = 52;
/** The server's promotion threshold (ADR-0109 / D8): a PG-13 total at or above it is a positive complicated-grief screen. */
const PG13_POSITIVE = 25;

const asTriState = (v: string): TriState => (v === "unknown" ? "unknown" : v === "true");
const triValue = (v: TriState): string => (v === "unknown" ? "unknown" : v ? "true" : "false");

/** The factors the form starts from: the pre-death draft for the INITIAL assessment (if one exists), else all unknown. */
function initialFactors(
  task: AssessmentTaskRow,
  draft: PreDeathDraft | null,
): { factors: Record<string, TriState>; fromDraft: boolean } {
  const blank = Object.fromEntries(RISK_FACTOR_KEYS.map((k) => [k, "unknown" as TriState]));
  if (task.taskKind !== "initial_assessment" || draft === null || !draft.exists) {
    return { factors: blank, fromDraft: false };
  }
  const stated = draft.factors as Record<string, TriState>;
  return {
    factors: Object.fromEntries(RISK_FACTOR_KEYS.map((k) => [k, stated[k] ?? "unknown"])),
    fromDraft: true,
  };
}

export function CompleteAssessmentModal({
  planId,
  task,
  contactName,
  draft,
  onClose,
  onDone,
}: {
  planId: string;
  task: AssessmentTaskRow;
  contactName: string;
  draft: PreDeathDraft | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const client = useApiClient();
  const start = initialFactors(task, draft);
  const midpoint = task.taskKind === "midpoint_reassessment";
  const [factors, setFactors] = useState<Record<string, TriState>>(start.factors);
  const [delayedGrief, setDelayedGrief] = useState("");
  const [pg13, setPg13] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pg13Required = midpoint && delayedGrief === "yes";
  const pg13Filled = pg13.trim() !== "";
  const pg13Number = Number(pg13);
  const pg13Valid =
    !pg13Filled || (Number.isInteger(pg13Number) && pg13Number >= 0 && pg13Number <= PG13_MAX);
  const promotes = pg13Filled && pg13Valid && pg13Number >= PG13_POSITIVE;
  const answered = !midpoint || delayedGrief !== "";
  const ready = answered && pg13Valid && (!pg13Required || pg13Filled);

  const submit = async () => {
    setBusy(true);
    setError(null);
    // `factors` carries exactly the eight D17 keys (+ the optional screen total) the route's TypeBox schema names.
    const body = {
      bereavedContactId: task.contactId,
      assessmentTaskId: task.taskId,
      factors: {
        ...factors,
        ...(pg13Filled ? { pg13_score: pg13Number } : {}),
      } as unknown as BereavementRiskFactors,
    };
    const { error: err } = await recomputeRisk(client, planId, body);
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The assessment could not be recorded."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title={midpoint ? "Complete midpoint reassessment" : "Complete initial assessment"}
      onClose={onClose}
      footer={
        <button type="button" style={primaryButtonStyle} disabled={busy || !ready} onClick={submit}>
          {busy ? "Recording…" : "Complete assessment"}
        </button>
      }
    >
      <span style={mutedStyle}>
        {assessmentTaskKindLabel(task.taskKind)} for {contactName}, due {shortDate(task.dueAt)}.
        This appends a risk score and completes the checkpoint; a stated factor can raise a derived
        one and never lowers it.
      </span>

      {start.fromDraft ? (
        <Notice tone="info">
          Factors below are from pre-death draft
          {draft?.lastEditedDiscipline ? ` (${draft.lastEditedDiscipline.replace(/_/g, " ")}` : ""}
          {draft?.lastEditedAt
            ? `, ${shortDate(draft.lastEditedAt)})`
            : draft?.lastEditedDiscipline
              ? ")"
              : ""}
          . Confirm or change each one.
        </Notice>
      ) : null}
      <Notice tone="info">
        `Unknown` is a real answer: the scorer adjusts to the knowable factors and lowers its
        confidence band — it never treats unknown as absent.
      </Notice>

      {RISK_FACTOR_KEYS.map((k) => (
        <SelectField
          key={k}
          label={riskFactorLabel(k)}
          value={triValue(factors[k] ?? "unknown")}
          options={[
            { value: "true", label: "Present" },
            { value: "false", label: "Absent" },
            { value: "unknown", label: "Unknown" },
          ]}
          onChange={(v) => setFactors({ ...factors, [k]: asTriState(v) })}
        />
      ))}

      {midpoint ? (
        <SelectField
          label="Any signs of delayed or prolonged grief?"
          value={delayedGrief}
          options={[
            { value: "", label: "answer required" },
            { value: "no", label: "No" },
            { value: "yes", label: "Yes" },
          ]}
          onChange={setDelayedGrief}
        />
      ) : null}
      {pg13Required ? (
        <Notice tone="warning">
          Delayed-grief signs reported: enter the PG-13 total so the screen substantiates it. A
          total of {PG13_POSITIVE} or more promotes the survivor's tier to complicated grief.
        </Notice>
      ) : null}
      <TextField
        label={`PG-13 total (${pg13Required ? "required" : "optional"}, 0–${PG13_MAX})`}
        type="number"
        value={pg13}
        onChange={setPg13}
      />
      {!pg13Valid ? (
        <ErrorText>The PG-13 total is a whole number from 0 to {PG13_MAX}.</ErrorText>
      ) : null}
      {promotes ? (
        <Notice tone="warning">
          A total of {PG13_POSITIVE} or more is a positive screen: recording it promotes the tier.
        </Notice>
      ) : null}

      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}
