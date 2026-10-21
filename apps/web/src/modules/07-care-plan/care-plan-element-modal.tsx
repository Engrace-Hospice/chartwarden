import {
  Button,
  CodeSearchInput,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/07-care-plan — the §2 problem / goal / intervention authoring ceremonies (#91).
//
// The IPOC is a document made of three element kinds, and the module could display all three and author
// none. This modal is the authoring; one component because the six operations (create + edit for each
// kind) share every control but the fields, and because a goal created from the plan view and one
// edited from it must commit to the same route with the same concurrency dialect.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES (ADR-0030):
//   • §7.7 optimistic concurrency. An edit quotes the row `version` the caller READ, in `If-Match`;
//     a 412 means the row moved and is surfaced as that, not retried behind the user's back.
//   • §7.6 SUD redaction. A problem the caller may not see is omitted SERVER-side and the response
//     says `redacted: true` — this modal never hides anything itself.
//   • Whether the plan is in a state that accepts an edit at all (409).
//
// `originalText` on a goal is create-only, and deliberately: a patient-stated goal is recorded in the
// patient's own words, and a revision is APPENDED as `revisedText` rather than overwriting it. The edit
// form therefore shows the original read-only beside the field that actually changes.
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  type CreateGoalBody,
  type CreateInterventionBody,
  type CreateProblemBody,
  type GoalSource,
  type GoalStatus,
  type InterventionDiscipline,
  type ProblemKind,
  type ProblemSource,
  type WriteResult,
  createGoal,
  createIntervention,
  createProblem,
  discontinueIntervention,
  patchGoal,
  patchIntervention,
  patchProblem,
  resolveProblem,
} from "./care-plan-api";

const PROBLEM_KINDS: readonly ProblemKind[] = ["terminal", "related", "unrelated"];
const PROBLEM_SOURCES: readonly ProblemSource[] = [
  "clinical",
  "patient_reported",
  "family_reported",
  "history",
  "intake_extraction",
];
const GOAL_SOURCES: readonly GoalSource[] = [
  "clinical",
  "patient_stated",
  "family_stated",
  "agent_stated",
];
const GOAL_STATUSES: readonly GoalStatus[] = [
  "not_started",
  "in_progress",
  "met",
  "not_met",
  "revised",
  "discontinued",
];
const DISCIPLINES: readonly InterventionDiscipline[] = [
  "rn",
  "lpn",
  "chha",
  "msw",
  "chaplain",
  "md_np",
  "pt",
  "ot",
  "st",
  "volunteer",
  "music_therapy",
  "dietitian",
  "bereavement",
];

const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const LABEL: Record<string, string> = {
  rn: "RN",
  lpn: "LPN",
  chha: "Home health aide",
  msw: "Social work",
  md_np: "Physician / NP",
  pt: "Physical therapy",
  ot: "Occupational therapy",
  st: "Speech therapy",
};
const label = (k: string): string => LABEL[k] ?? humanize(k);

/** The six operations this modal performs. */
export type ElementAction =
  | "create-problem"
  | "edit-problem"
  | "resolve-problem"
  | "create-goal"
  | "edit-goal"
  | "create-intervention"
  | "edit-intervention"
  | "discontinue-intervention";

/** The element being edited, as the plan read returns it. */
export interface ElementSubject {
  readonly id: string;
  readonly version: number;
  readonly description?: string;
  readonly kind?: string;
  readonly originalText?: string;
  readonly revisedText?: string | null;
  readonly measurableOutcome?: string | null;
  readonly status?: string;
  readonly scopeText?: string;
  readonly frequencyText?: string;
  readonly frequencyValue?: string;
  readonly responsibleRole?: string | null;
}

const TITLE: Record<ElementAction, string> = {
  "create-problem": "Add problem",
  "edit-problem": "Edit problem",
  "resolve-problem": "Resolve problem",
  "create-goal": "Add goal",
  "edit-goal": "Revise goal",
  "create-intervention": "Add intervention",
  "edit-intervention": "Edit intervention",
  "discontinue-intervention": "Discontinue intervention",
};

export interface CarePlanElementModalProps {
  readonly open: boolean;
  readonly action: ElementAction;
  readonly planId: string;
  /** The problem a goal or intervention hangs off. Required for both create paths. */
  readonly problemId?: string | null;
  /** The row being edited / resolved / discontinued. */
  readonly subject?: ElementSubject | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

export function CarePlanElementModal({
  open,
  action,
  planId,
  problemId = null,
  subject = null,
  onClose,
  onDone,
}: CarePlanElementModalProps): JSX.Element | null {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [description, setDescription] = useState("");
  const [problemKind, setProblemKind] = useState<ProblemKind>("related");
  const [problemSource, setProblemSource] = useState<ProblemSource>("clinical");
  const [icd10Code, setIcd10Code] = useState("");
  const [sudRelated, setSudRelated] = useState(false);
  const [goalText, setGoalText] = useState("");
  const [goalSource, setGoalSource] = useState<GoalSource>("patient_stated");
  const [goalStatus, setGoalStatus] = useState<GoalStatus>("in_progress");
  const [measurableOutcome, setMeasurableOutcome] = useState("");
  const [scopeText, setScopeText] = useState("");
  const [frequencyText, setFrequencyText] = useState("");
  const [frequencyValue, setFrequencyValue] = useState("");
  const [discipline, setDiscipline] = useState<InterventionDiscipline>("rn");
  const [responsibleRole, setResponsibleRole] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setNote("");
    setDescription(subject?.description ?? "");
    setProblemKind((subject?.kind as ProblemKind) ?? "related");
    setProblemSource("clinical");
    setIcd10Code("");
    setSudRelated(false);
    // A revision starts from what is currently in force, which is the revised text if there is one.
    setGoalText(subject?.revisedText ?? "");
    setGoalSource("patient_stated");
    setGoalStatus((subject?.status as GoalStatus) ?? "in_progress");
    setMeasurableOutcome(subject?.measurableOutcome ?? "");
    setScopeText(subject?.scopeText ?? "");
    setFrequencyText(subject?.frequencyText ?? "");
    setFrequencyValue(subject?.frequencyValue ?? "");
    setDiscipline("rn");
    setResponsibleRole(subject?.responsibleRole ?? "");
  }, [open, subject]);

  if (!open) return null;

  const blocked =
    (action === "create-problem" && description.trim() === "") ||
    (action === "edit-problem" && description.trim() === "") ||
    (action === "resolve-problem" && note.trim() === "") ||
    (action === "create-goal" && goalText.trim() === "") ||
    (action === "create-intervention" &&
      (scopeText.trim() === "" || frequencyText.trim() === "" || frequencyValue.trim() === "")) ||
    (action === "discontinue-intervention" && note.trim() === "");

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    let res: WriteResult<unknown>;
    switch (action) {
      case "create-problem":
        res = await createProblem(client, planId, {
          description: description.trim(),
          kind: problemKind,
          source: problemSource,
          ...(icd10Code.trim() !== "" ? { icd10Code: icd10Code.trim().toUpperCase() } : {}),
          ...(sudRelated ? { sudRelated: true } : {}),
        } as CreateProblemBody);
        break;
      case "edit-problem":
        res = await patchProblem(client, planId, subject?.id ?? "", subject?.version ?? 0, {
          description: description.trim(),
          kind: problemKind,
        });
        break;
      case "resolve-problem":
        res = await resolveProblem(
          client,
          planId,
          subject?.id ?? "",
          subject?.version ?? 0,
          note.trim(),
        );
        break;
      case "create-goal":
        res = await createGoal(client, planId, {
          problemId: problemId ?? "",
          originalText: goalText.trim(),
          source: goalSource,
          ...(measurableOutcome.trim() !== ""
            ? { measurableOutcome: measurableOutcome.trim() }
            : {}),
        } as CreateGoalBody);
        break;
      case "edit-goal":
        res = await patchGoal(client, planId, subject?.id ?? "", subject?.version ?? 0, {
          ...(goalText.trim() !== "" ? { revisedText: goalText.trim() } : {}),
          ...(measurableOutcome.trim() !== ""
            ? { measurableOutcome: measurableOutcome.trim() }
            : {}),
          status: goalStatus,
        });
        break;
      case "create-intervention":
        res = await createIntervention(client, planId, {
          problemId: problemId ?? "",
          scopeText: scopeText.trim(),
          frequencyText: frequencyText.trim(),
          frequencyValue: frequencyValue.trim(),
          discipline,
          ...(responsibleRole.trim() !== "" ? { responsibleRole: responsibleRole.trim() } : {}),
        } as CreateInterventionBody);
        break;
      case "edit-intervention":
        res = await patchIntervention(client, planId, subject?.id ?? "", subject?.version ?? 0, {
          scopeText: scopeText.trim(),
          frequencyText: frequencyText.trim(),
          frequencyValue: frequencyValue.trim(),
          ...(responsibleRole.trim() !== "" ? { responsibleRole: responsibleRole.trim() } : {}),
        });
        break;
      case "discontinue-intervention":
        res = await discontinueIntervention(
          client,
          planId,
          subject?.id ?? "",
          subject?.version ?? 0,
          note.trim(),
        );
        break;
    }
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onDone();
    onClose();
  }

  const isProblem = action.endsWith("problem");
  const isGoal = action.endsWith("goal");
  const isIntervention = action.endsWith("intervention");

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel={TITLE[action]}
      width="32rem"
      accent={
        action.startsWith("resolve") || action.startsWith("discontinue") ? t.alert : t.primary
      }
    >
      <div style={body}>
        <h2 style={heading}>{TITLE[action]}</h2>

        {isProblem && action !== "resolve-problem" ? (
          <>
            <TextAreaField
              label="Problem"
              value={description}
              disabled={busy}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
            />
            <SelectField
              label="Relationship to terminal prognosis"
              value={problemKind}
              disabled={busy}
              onChange={(e) => setProblemKind(e.target.value as ProblemKind)}
              options={PROBLEM_KINDS.map((k) => ({ value: k, label: label(k) }))}
            />
            <p style={meta}>
              Terminal / related problems are covered by the hospice benefit; an unrelated problem
              is not, and the distinction drives billing as well as the plan.
            </p>
            {action === "create-problem" ? (
              <>
                <SelectField
                  label="Source"
                  value={problemSource}
                  disabled={busy}
                  onChange={(e) => setProblemSource(e.target.value as ProblemSource)}
                  options={PROBLEM_SOURCES.map((k) => ({ value: k, label: label(k) }))}
                />
                <CodeSearchInput
                  label="ICD-10 code (optional)"
                  system="icd10cm"
                  value={icd10Code}
                  disabled={busy}
                  onChange={(code) => setIcd10Code(code)}
                />
                <label style={checkRow}>
                  <input
                    type="checkbox"
                    checked={sudRelated}
                    disabled={busy}
                    onChange={(e) => setSudRelated(e.target.checked)}
                  />
                  <span>Substance-use related (42 CFR Part 2)</span>
                </label>
                <p style={meta}>
                  A Part 2 problem is withheld from readers without consent, server-side — marking
                  it here restricts who can see it, and cannot be undone by unmarking it later.
                </p>
              </>
            ) : null}
          </>
        ) : null}

        {action === "resolve-problem" ? (
          <>
            <p style={meta}>{subject?.description}</p>
            <TextAreaField
              label="Resolution note"
              value={note}
              disabled={busy}
              rows={3}
              onChange={(e) => setNote(e.target.value)}
            />
          </>
        ) : null}

        {isGoal ? (
          <>
            {action === "edit-goal" && subject?.originalText ? (
              <>
                <p style={meta}>Originally stated</p>
                <blockquote style={quote}>{subject.originalText}</blockquote>
                <p style={meta}>
                  The original wording is kept as recorded; a revision is added beside it rather
                  than replacing it.
                </p>
              </>
            ) : null}
            <TextAreaField
              label={action === "edit-goal" ? "Revised goal" : "Goal, in the patient's words"}
              value={goalText}
              disabled={busy}
              rows={3}
              onChange={(e) => setGoalText(e.target.value)}
            />
            {action === "create-goal" ? (
              <SelectField
                label="Stated by"
                value={goalSource}
                disabled={busy}
                onChange={(e) => setGoalSource(e.target.value as GoalSource)}
                options={GOAL_SOURCES.map((k) => ({ value: k, label: label(k) }))}
              />
            ) : (
              <SelectField
                label="Status"
                value={goalStatus}
                disabled={busy}
                onChange={(e) => setGoalStatus(e.target.value as GoalStatus)}
                options={GOAL_STATUSES.map((k) => ({ value: k, label: label(k) }))}
              />
            )}
            <TextField
              label="Measurable outcome (optional)"
              value={measurableOutcome}
              disabled={busy}
              onChange={(e) => setMeasurableOutcome(e.target.value)}
            />
          </>
        ) : null}

        {isIntervention && action !== "discontinue-intervention" ? (
          <>
            <TextAreaField
              label="Intervention"
              value={scopeText}
              disabled={busy}
              rows={3}
              onChange={(e) => setScopeText(e.target.value)}
            />
            {action === "create-intervention" ? (
              <SelectField
                label="Discipline"
                value={discipline}
                disabled={busy}
                onChange={(e) => setDiscipline(e.target.value as InterventionDiscipline)}
                options={DISCIPLINES.map((k) => ({ value: k, label: label(k) }))}
              />
            ) : null}
            <TextField
              label="Frequency, as written on the plan"
              value={frequencyText}
              disabled={busy}
              onChange={(e) => setFrequencyText(e.target.value)}
              placeholder="RN visit 2x weekly"
            />
            <TextField
              label="Frequency, machine-readable"
              value={frequencyValue}
              disabled={busy}
              onChange={(e) => setFrequencyValue(e.target.value)}
              placeholder="2/week"
            />
            <p style={meta}>
              Both are recorded: the written frequency is what the plan says and what a surveyor
              reads; the machine-readable one is what scheduling and missed-visit detection run on.
            </p>
            <TextField
              label="Responsible role (optional)"
              value={responsibleRole}
              disabled={busy}
              onChange={(e) => setResponsibleRole(e.target.value)}
            />
          </>
        ) : null}

        {action === "discontinue-intervention" ? (
          <>
            <p style={meta}>{subject?.scopeText}</p>
            <TextAreaField
              label="Reason for discontinuing"
              value={note}
              disabled={busy}
              rows={3}
              onChange={(e) => setNote(e.target.value)}
            />
          </>
        ) : null}

        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone={
              action.startsWith("resolve") || action.startsWith("discontinue")
                ? "danger"
                : "primary"
            }
            onClick={submit}
            disabled={busy || blocked}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const body: CSSProperties = {
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  maxHeight: "80vh",
  overflowY: "auto",
};
const heading: CSSProperties = { margin: 0, fontSize: "1.05rem", fontWeight: 600 };
const meta: CSSProperties = {
  margin: 0,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
const quote: CSSProperties = {
  margin: 0,
  padding: "0.5rem 0.75rem",
  borderLeft: "3px solid var(--color-outline-variant)",
  fontSize: "0.85rem",
  fontStyle: "italic",
};
const checkRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.85rem",
};
const errorText: CSSProperties = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };
