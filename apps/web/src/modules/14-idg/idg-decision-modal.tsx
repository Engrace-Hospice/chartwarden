import {
  Button,
  CodeSearchInput,
  Glyph,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/14-idg — the §2.6 decision recorder (#91).
//
// This is the write the IDG exists to make. 42 CFR 418.56(b) puts the interdisciplinary group at the
// centre of establishing the plan of care and §418.56(d) requires it to review that plan every 15
// calendar days; the DECISION is the record of what the group concluded, and until this modal there
// was no way to enter one. The route, the §2.6 payload union, the quorum evidence and the adjournment
// emit burst were all already there.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES.
//
//   • QUORUM. `quorate_decision` (§4.7) counts the attendance roster server-side and returns 422 if the
//     group is not quorate or the patient is not on this meeting's agenda. The surface shows the roster
//     as information; this modal offers the ceremony and renders the refusal.
//   • The §2.6 payload union. The route boundary carries `payload` as a kind-bearing open object and
//     the DOMAIN validates the discriminated union, so a shape this form gets wrong comes back 422
//     rather than being silently stored.
//
// EIGHT OF THE NINE KINDS ARE OFFERED IN FULL. `care_plan_update` is offered only as `problem_add`:
// its other five mutation ops address M7 plan elements by uuid (`problemId` / `goalId` /
// `interventionId`), which needs the care-plan element picker that belongs with the M07 surface. A
// form asking a coordinator to paste a uuid is not a working control (the F-007 rule), so it is not
// offered and the modal says so rather than leaving the reader to wonder.
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { type DecisionView, recordDecision } from "./idg-api";

/** The §2.6 taxonomy, in the order a coordinator reaches for them. */
const DECISION_KINDS = [
  "team_note",
  "care_plan_update",
  "level_of_care_consideration",
  "recertification_consideration",
  "medication_recommendation",
  "order_request",
  "referral",
  "family_meeting_needed",
  "bereavement_risk_flag",
] as const;
type DecisionKind = (typeof DECISION_KINDS)[number];

const KIND_LABEL: Record<DecisionKind, string> = {
  team_note: "Team note (whole meeting, no patient)",
  care_plan_update: "Care-plan update — add a problem",
  level_of_care_consideration: "Level-of-care consideration",
  recertification_consideration: "Recertification consideration",
  medication_recommendation: "Medication recommendation",
  order_request: "Order request",
  referral: "Referral",
  family_meeting_needed: "Family meeting needed",
  bereavement_risk_flag: "Bereavement risk flag",
};

/** Kinds that carry no patient (the server's strict `recorded_open` payload needs one for the rest). */
const PATIENTLESS_KINDS: readonly DecisionKind[] = ["team_note"];

const LEVELS = ["routine", "continuous", "inpatient_respite", "general_inpatient"] as const;
const PROBLEM_KINDS = ["terminal", "related", "unrelated"] as const;
const RISK_LEVELS = ["low", "medium", "high"] as const;
const MED_KINDS = [
  "add",
  "discontinue",
  "change_dose",
  "change_route",
  "change_frequency",
] as const;
const ORDER_HINTS = [
  "idg_requested",
  "lab",
  "dme",
  "level_of_care_change",
  "recertification",
  "comfort_kit",
  "supply",
  "ancillary_service",
] as const;

const humanize = (k: string): string => k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export interface DecisionModalProps {
  readonly open: boolean;
  readonly meetingId: string;
  /** The patients on this meeting's agenda — the only ones a patient-scoped decision may name. */
  readonly patients: readonly { readonly id: string; readonly label: string }[];
  /** Preselect this patient (the worklist's current selection) when the modal opens. */
  readonly defaultPatientId?: string | null;
  /** The quorum READOUT shown as context — information only; the server decides (§4.7). */
  readonly quorum?: { readonly quorate: boolean; readonly missing: readonly string[] };
  readonly onClose: () => void;
  readonly onRecorded: (decision: DecisionView) => void;
}

export function DecisionModal({
  open,
  meetingId,
  patients,
  defaultPatientId,
  quorum,
  onClose,
  onRecorded,
}: DecisionModalProps): JSX.Element | null {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<DecisionKind>("team_note");
  const [patientId, setPatientId] = useState("");
  const [rationale, setRationale] = useState("");
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("routine");
  const [periodIndex, setPeriodIndex] = useState("1");
  const [problemKind, setProblemKind] = useState<(typeof PROBLEM_KINDS)[number]>("terminal");
  const [icd10, setIcd10] = useState("");
  const [riskLevel, setRiskLevel] = useState<(typeof RISK_LEVELS)[number]>("low");
  const [medKind, setMedKind] = useState<(typeof MED_KINDS)[number]>("add");
  const [drugLabel, setDrugLabel] = useState("");
  const [orderHint, setOrderHint] = useState<(typeof ORDER_HINTS)[number]>("idg_requested");
  const [referralKind, setReferralKind] = useState("");
  const [familyMembers, setFamilyMembers] = useState("");

  // The live surface re-renders on every poll; the form must reset only when the modal OPENS, never
  // because the patient list / default was recomputed underneath a half-typed decision.
  const seed = useRef({ patients, defaultPatientId });
  seed.current = { patients, defaultPatientId };
  useEffect(() => {
    if (!open) return;
    const { patients: ps, defaultPatientId: def } = seed.current;
    setBusy(false);
    setError(null);
    setKind("team_note");
    setPatientId(
      ps.length === 1 ? (ps[0]?.id ?? "") : def && ps.some((p) => p.id === def) ? def : "",
    );
    setRationale("");
    setIcd10("");
    setDrugLabel("");
    setReferralKind("");
    setFamilyMembers("");
    setPeriodIndex("1");
  }, [open]);

  if (!open) return null;

  const needsPatient = !PATIENTLESS_KINDS.includes(kind);
  const narrative = rationale.trim();
  const blocked =
    (needsPatient && patientId === "") ||
    narrative.length === 0 ||
    (kind === "medication_recommendation" && drugLabel.trim() === "") ||
    (kind === "referral" && referralKind.trim() === "") ||
    (kind === "recertification_consideration" && !(Number(periodIndex) >= 1));

  /** Build the §2.6 payload for the selected kind. The server validates the union; this shapes it. */
  function payloadFor(): Record<string, unknown> {
    switch (kind) {
      case "team_note":
        return { kind, noteText: narrative };
      case "care_plan_update":
        return {
          kind,
          mutations: [
            {
              op: "problem_add",
              icd10Code: icd10.trim() === "" ? null : icd10.trim(),
              snomedCode: null,
              description: narrative,
              problemKind,
            },
          ],
        };
      case "level_of_care_consideration":
        return { kind, consideredLevel: level, rationaleText: narrative };
      case "recertification_consideration":
        return { kind, periodIndex: Number(periodIndex), rationaleText: narrative };
      case "medication_recommendation":
        return {
          kind,
          recommendations: [
            {
              recommendationKind: medKind,
              drugLabel: drugLabel.trim(),
              proposedStrength: null,
              proposedRoute: null,
              proposedFrequency: null,
              triggeringProblemId: null,
              rationaleText: narrative,
            },
          ],
        };
      case "order_request":
        return {
          kind,
          requestedOrders: [
            {
              kindHint: orderHint,
              narrative,
              recommendedTimeframe: null,
              triggeringProblemId: null,
            },
          ],
        };
      case "referral":
        return {
          kind,
          referralKind: referralKind.trim(),
          referralTargetMdmId: null,
          rationaleText: narrative,
        };
      case "family_meeting_needed":
        return {
          kind,
          familyMembers: familyMembers
            .split(",")
            .map((m) => m.trim())
            .filter((m) => m.length > 0),
          preferredWindow: null,
          rationaleText: narrative,
        };
      case "bereavement_risk_flag":
        return { kind, riskLevel, rationaleText: narrative };
    }
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await recordDecision(client, meetingId, {
      patientId: needsPatient ? patientId : null,
      payload: payloadFor(),
    } as Parameters<typeof recordDecision>[2]);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onRecorded(res.value);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Record a decision"
      width="34rem"
    >
      <div style={shell}>
        <header style={{ display: "grid", gap: "0.25rem" }}>
          <h2 style={title}>Record a decision</h2>
          <p style={meta}>
            {quorum
              ? quorum.quorate
                ? "Quorate — Physician + RN + MSW + Chaplain present."
                : `Group is not quorate (missing ${quorum.missing.join(", ")}). The server refuses a binding decision without quorum.`
              : "The server checks quorum at the moment of recording."}
          </p>
        </header>
        <div style={body}>
          <SelectField
            label="Decision"
            value={kind}
            onChange={(e) => setKind(e.target.value as DecisionKind)}
            options={DECISION_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          />

          {!needsPatient ? (
            <p style={meta}>
              A team note belongs to the whole meeting, not to a patient. Pick another decision kind
              to attach it to a patient.
            </p>
          ) : null}

          {needsPatient ? (
            patients.length === 0 ? (
              <p style={meta}>
                No patients are on this meeting's agenda yet, so a patient-scoped decision cannot
                name one. Add an agenda item first, or record a team note.
              </p>
            ) : (
              <SelectField
                label="Patient"
                value={patientId}
                onChange={(e) => setPatientId(e.target.value)}
                options={[
                  ...(patients.length > 1 ? [{ value: "", label: "Select a patient…" }] : []),
                  ...patients.map((p) => ({ value: p.id, label: p.label })),
                ]}
              />
            )
          ) : null}

          {kind === "care_plan_update" ? (
            <>
              <SelectField
                label="Problem kind"
                value={problemKind}
                onChange={(e) => setProblemKind(e.target.value as (typeof PROBLEM_KINDS)[number])}
                options={PROBLEM_KINDS.map((k) => ({ value: k, label: humanize(k) }))}
              />
              <CodeSearchInput
                label="ICD-10 code (optional)"
                system="icd10cm"
                value={icd10}
                onChange={(code) => setIcd10(code)}
              />
              <p style={meta}>
                Adds a PROBLEM to the plan. Updating an existing problem, goal or intervention
                addresses it by id and needs the care-plan element picker on the M07 surface — not
                offered here rather than asking you to paste one.
              </p>
            </>
          ) : null}

          {kind === "level_of_care_consideration" ? (
            <SelectField
              label="Considered level"
              value={level}
              onChange={(e) => setLevel(e.target.value as (typeof LEVELS)[number])}
              options={LEVELS.map((l) => ({ value: l, label: humanize(l) }))}
            />
          ) : null}

          {kind === "recertification_consideration" ? (
            <TextField
              label="Benefit period"
              value={periodIndex}
              onChange={(e) => setPeriodIndex(e.target.value)}
            />
          ) : null}

          {kind === "medication_recommendation" ? (
            <>
              <SelectField
                label="Recommendation"
                value={medKind}
                onChange={(e) => setMedKind(e.target.value as (typeof MED_KINDS)[number])}
                options={MED_KINDS.map((k) => ({ value: k, label: humanize(k) }))}
              />
              <TextField
                label="Drug"
                value={drugLabel}
                onChange={(e) => setDrugLabel(e.target.value)}
              />
            </>
          ) : null}

          {kind === "order_request" ? (
            <SelectField
              label="Order kind"
              value={orderHint}
              onChange={(e) => setOrderHint(e.target.value as (typeof ORDER_HINTS)[number])}
              options={ORDER_HINTS.map((k) => ({ value: k, label: humanize(k) }))}
            />
          ) : null}

          {kind === "referral" ? (
            <TextField
              label="Referral to"
              value={referralKind}
              onChange={(e) => setReferralKind(e.target.value)}
            />
          ) : null}

          {kind === "family_meeting_needed" ? (
            <TextField
              label="Family members (comma-separated)"
              value={familyMembers}
              onChange={(e) => setFamilyMembers(e.target.value)}
            />
          ) : null}

          {kind === "bereavement_risk_flag" ? (
            <SelectField
              label="Risk level"
              value={riskLevel}
              onChange={(e) => setRiskLevel(e.target.value as (typeof RISK_LEVELS)[number])}
              options={RISK_LEVELS.map((l) => ({ value: l, label: humanize(l) }))}
            />
          ) : null}

          <TextAreaField
            label={
              kind === "team_note"
                ? "Note"
                : kind === "care_plan_update"
                  ? "Problem description"
                  : "Rationale"
            }
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            rows={4}
          />

          {error ? (
            <p role="alert" style={errorText}>
              <Glyph name="alert-circle" size={14} /> {error}
            </p>
          ) : null}
        </div>

        <footer style={footer}>
          <Button tone="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || blocked}>
            {busy ? "Recording…" : "Record decision"}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}

const shell = {
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.875rem",
} as const;
const body = { display: "flex", flexDirection: "column", gap: "0.875rem" } as const;
const title = { margin: 0, fontSize: "1.05rem", fontWeight: 600 } as const;
const footer = { display: "flex", gap: "0.5rem", justifyContent: "flex-end" } as const;
const meta = { margin: 0, fontSize: "0.75rem", color: "var(--color-on-surface-variant)" } as const;
const errorText = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" } as const;
