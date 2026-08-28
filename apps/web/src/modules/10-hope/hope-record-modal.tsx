import {
  Button,
  Modal,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/10-hope — the §5.2 HOPE recording modal (#91), all five RFAs.
//
// The `screens.ts` header this replaces deferred "the recording modal (§5.2, all five RFAs), the
// late-completion confirmation dialog, and the schedule-admin write surfaces". The recording modal IS
// the capture path for the one CMS-mandated quality instrument every Medicare-certified hospice must
// submit; without it the whole module was a read-only view of timepoints nobody could record.
//
// WHAT THIS CAPTURES, AND WHAT IT HONESTLY CANNOT.
//
// The CMS HOPE instrument has 17 sections. FOUR of them have item definitions anywhere in this
// codebase — Section I's primary diagnosis, Section J's J2030 / J2050 / J2051 items, and Section N's
// opioid-and-bowel-regimen triple — because those are the ones the CMS pre-submission rule set reads
// (F-057) and the ones the route boundary types. The other thirteen have NO item shapes: the spec's
// `packages/hope/src/sections/J/schema.ts` and its siblings were never written, and
// `packages/hope/src/sections/` contains exactly one file, the required-items matrix.
//
// So this modal captures the four that are defined and offers NOTHING for the thirteen that are not.
// Inventing tabs for "Section C — Cognitive Patterns" would mean minting ~200 CMS item shapes with no
// server counterpart, no validation, and no submission mapping — a form that looks like the instrument
// and produces a payload nothing can check. The F-007 rule (no enabled control wired to nothing) points
// exactly at that.
//
// The gap is not hidden: every recorded assessment now carries one blocking `REQUIRED_SECTION_MISSING`
// finding per undefined section, the assessment detail rail lists them by letter, and the banner below
// says so before the clinician commits. That is the difference this change makes — the instrument is
// still incomplete, but it is incomplete VISIBLY and measurably rather than in a header comment.
//
// The SERVER decides everything that matters. §4.4's capture gate runs against the STORED window, so the
// late-completion branch here reads the schedule's own dates only to know what to ASK for; a client
// clock is not an authority and `M10_LATE_REASON_REQUIRED` / `M10_TIMEPOINT_EXPIRED` are the answers.
// §4.7's author floor (RN/NP/MD; RN/NP for an SFV) is resolved from the caller's M3 role grants, never
// from the `authorDiscipline` sent here — that field is CMS attribution, which is why it is offered
// from the caller's OWN roles rather than as a free choice (the `discipline-derivation.test.ts` rule:
// M3's role keys are the platform's one authority-derivation input).
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useSession } from "../../shell/session";
import {
  type AssessmentView,
  type AuthorDiscipline,
  type DischargeReason,
  type HopeData,
  type LateReasonCode,
  type RfaKind,
  authorDisciplineLabel,
  authorDisciplinesForRoles,
  recordSfv,
  recordTimepoint,
} from "./hope-api";
import { rfaLabel } from "./hope-status";

/** The §2.1 CMS J2051 symptom roster + severities, both derived from the wire contract. */
type J2051Entry = NonNullable<NonNullable<HopeData["J"]>["J2051"]>["entries"][number];
type SymptomCode = J2051Entry["symptomCode"];
type Severity = J2051Entry["severity"];

const SYMPTOMS: readonly SymptomCode[] = [
  "pain",
  "shortness_of_breath",
  "anxiety",
  "agitation",
  "nausea_vomiting",
  "constipation",
  "restlessness",
  "other",
];
const SEVERITIES: readonly Severity[] = ["none", "mild", "moderate", "severe"];
/** D4 — moderate or severe on ANY symptom creates the 2-calendar-day SFV obligation. */
const TRIGGER_SEVERITIES: ReadonlySet<string> = new Set(["moderate", "severe"]);

// The §4.7 author vocabulary lives in `hope-api.ts` (`authorDisciplinesForRoles`) — it is the WIRE
// vocabulary (RN/NP/MD), not the M3 role keys, and this modal used to conflate the two. See F-067 there.

const RFA_KINDS: readonly RfaKind[] = [
  "01_admission",
  "02_huv1",
  "03_huv2",
  "04_sfv",
  "05_discharge",
];
const DISCHARGE_REASONS: readonly DischargeReason[] = [
  "death",
  "revocation",
  "transfer_to_hospice",
  "live_discharge",
];
/** The closed D12 codelist (`LATE_COMPLETION_REASON_CODES`). */
const LATE_REASONS: readonly LateReasonCode[] = [
  "pto",
  "hospitalization",
  "family_meeting_deferral",
  "refused",
  "missed",
  "pandemic_cohort",
  "admin_override",
  "other",
];

const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** The window a schedule row publishes; supplied when the capture completes a known timepoint. */
export interface RecordWindow {
  readonly id: string;
  readonly rfaKind: string;
  readonly windowOpensAt: string;
  readonly windowClosesAt: string;
  readonly lateDeadlineAt: string;
}

/** Where the target date falls against the window — used ONLY to decide what to ask for. */
type CaptureSpan = "before_open" | "in_window" | "late" | "expired" | "unscheduled";

function spanOf(targetIso: string, window: RecordWindow | null): CaptureSpan {
  if (window === null) return "unscheduled";
  const at = Date.parse(targetIso);
  if (Number.isNaN(at)) return "unscheduled";
  if (at < Date.parse(window.windowOpensAt)) return "before_open";
  if (at <= Date.parse(window.windowClosesAt)) return "in_window";
  if (at <= Date.parse(window.lateDeadlineAt)) return "late";
  return "expired";
}

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in LOCAL time; the wire wants a UTC instant. */
const toLocalInput = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export interface HopeRecordModalProps {
  readonly open: boolean;
  readonly admissionId: string;
  /** The schedule this capture completes, when there is one. Null for an ad-hoc / unscheduled capture. */
  readonly window?: RecordWindow | null;
  /** Pre-selects the RFA when no window pins it. */
  readonly defaultRfaKind?: RfaKind;
  /**
   * For an SFV capture: the assessment whose J2051 trigger created the obligation. Present ⇒ the modal
   * commits through `POST …/hope/sfv`, which matches an OPEN follow-up row, rather than the timepoint
   * route. The two are different endpoints with different author floors, not one endpoint with a flag.
   */
  readonly triggeringAssessmentId?: string | null;
  readonly onClose: () => void;
  readonly onDone: (assessment: AssessmentView) => void;
}

export function HopeRecordModal({
  open,
  admissionId,
  window: scheduleWindow = null,
  defaultRfaKind,
  triggeringAssessmentId = null,
  onClose,
  onDone,
}: HopeRecordModalProps): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSfv = triggeringAssessmentId !== null;
  const pinnedRfa = (scheduleWindow?.rfaKind as RfaKind | undefined) ?? undefined;

  const [rfaKind, setRfaKind] = useState<RfaKind>("01_admission");
  const [targetLocal, setTargetLocal] = useState("");
  const [authorDiscipline, setAuthorDiscipline] = useState<AuthorDiscipline | "">("");
  const [dischargeReason, setDischargeReason] = useState<DischargeReason>("live_discharge");
  const [lateReason, setLateReason] = useState<LateReasonCode>("pto");
  const [adminOverride, setAdminOverride] = useState(false);
  const [primaryDiagnosisIcd10, setPrimaryDiagnosisIcd10] = useState("");
  const [painScreened, setPainScreened] = useState(false);
  const [painCharacteristics, setPainCharacteristics] = useState("");
  const [dyspneaScreened, setDyspneaScreened] = useState(false);
  const [dyspneaCharacteristics, setDyspneaCharacteristics] = useState("");
  const [severities, setSeverities] = useState<Record<string, Severity>>({});
  const [otherSymptomLabel, setOtherSymptomLabel] = useState("");
  const [opioidPrescribed, setOpioidPrescribed] = useState(false);
  const [scheduledBowelRegimen, setScheduledBowelRegimen] = useState(false);
  const [bowelRegimenContraindication, setBowelRegimenContraindication] = useState("");

  // The caller's OWN roles, resolved to the CMS discipline codes they may be attributed as. NOT a check
  // that they may record — §4.7 is the server's, and this is which discipline the capture is filed under.
  const authorRoles = useMemo(
    () => authorDisciplinesForRoles(session?.roles ?? [], { sfv: isSfv }),
    [session, isSfv],
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setRfaKind(isSfv ? "04_sfv" : (pinnedRfa ?? defaultRfaKind ?? "01_admission"));
    setTargetLocal(toLocalInput(new Date().toISOString()));
    setAuthorDiscipline(authorRoles.length === 1 ? (authorRoles[0] as AuthorDiscipline) : "");
    setAdminOverride(false);
    setPrimaryDiagnosisIcd10("");
    setPainScreened(false);
    setPainCharacteristics("");
    setDyspneaScreened(false);
    setDyspneaCharacteristics("");
    setSeverities({});
    setOtherSymptomLabel("");
    setOpioidPrescribed(false);
    setScheduledBowelRegimen(false);
    setBowelRegimenContraindication("");
  }, [open, isSfv, pinnedRfa, defaultRfaKind, authorRoles]);

  if (!open) return null;

  const targetIso = targetLocal === "" ? "" : new Date(targetLocal).toISOString();
  const span = spanOf(targetIso, scheduleWindow);
  const triggering = SYMPTOMS.filter((s) => TRIGGER_SEVERITIES.has(severities[s] ?? "none"));
  const needsQ = rfaKind === "05_discharge" && dischargeReason !== "death";
  const forbidsQ = rfaKind === "05_discharge" && dischargeReason === "death";

  const blocked = targetIso === "" || authorDiscipline === "";

  /** The §2.1 payload for the four sections this codebase defines items for. */
  function buildData(): HopeData {
    const entries = SYMPTOMS.filter((s) => severities[s] !== undefined).map((symptomCode) => ({
      symptomCode,
      severity: severities[symptomCode] as Severity,
      ...(symptomCode === "other" && otherSymptomLabel.trim() !== ""
        ? { otherSymptomLabel: otherSymptomLabel.trim() }
        : {}),
    }));
    const data: Record<string, unknown> = {
      J: {
        J2030: {
          screened: painScreened ? ("yes" as const) : ("no" as const),
          ...(painCharacteristics.trim() !== ""
            ? { characteristics: painCharacteristics.trim() }
            : {}),
        },
        J2050: {
          screened: dyspneaScreened ? ("yes" as const) : ("no" as const),
          ...(dyspneaCharacteristics.trim() !== ""
            ? { characteristics: dyspneaCharacteristics.trim() }
            : {}),
        },
        ...(entries.length > 0 ? { J2051: { entries } } : {}),
      },
      N: {
        opioidPrescribed,
        scheduledBowelRegimen,
        ...(bowelRegimenContraindication.trim() !== ""
          ? { bowelRegimenContraindication: bowelRegimenContraindication.trim() }
          : {}),
      },
    };
    if (primaryDiagnosisIcd10.trim() !== "") {
      data.I = { primaryDiagnosisIcd10: primaryDiagnosisIcd10.trim().toUpperCase() };
    }
    // D9 — the record-time gate refuses a live discharge with NO Section Q key at all. The section has
    // no item definitions here, so the only truthful thing to write is the discharge participation
    // fact itself; the CMS rule then reports it as documented, which it is.
    if (needsQ) data.Q = { participation: "documented_at_discharge" };
    return data as HopeData;
  }

  async function submit(): Promise<void> {
    // Narrowing, not a re-check: `blocked` already disables the control. Returning here rather than
    // casting is what lets the two calls below pass a real `AuthorDiscipline` — the `as` that used to
    // stand in for this is precisely what let a role key reach the wire (F-067).
    if (authorDiscipline === "") return;
    setBusy(true);
    setError(null);
    const data = buildData();
    const res = isSfv
      ? await recordSfv(client, admissionId, {
          triggeringAssessmentId: triggeringAssessmentId as string,
          targetDate: targetIso,
          authorDiscipline,
          data,
          ...(adminOverride ? { adminOverride: true } : {}),
        })
      : await recordTimepoint(client, admissionId, {
          rfaKind,
          targetDate: targetIso,
          authorDiscipline,
          data,
          ...(scheduleWindow ? { scheduleId: scheduleWindow.id } : {}),
          ...(rfaKind === "05_discharge" ? { dischargeReason } : {}),
          ...(span === "late" ? { lateCompletionReasonCode: lateReason } : {}),
          ...(adminOverride ? { adminOverride: true } : {}),
        });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onDone(res.value);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel={isSfv ? "Record symptom follow-up visit" : "Record HOPE timepoint"}
      width="36rem"
      accent={t.primary}
    >
      <div style={body}>
        <h2 style={title}>
          {isSfv ? "Record symptom follow-up visit" : `Record ${rfaLabel(rfaKind)}`}
        </h2>

        {/* The instrument gap, stated before the clinician commits rather than discovered after. */}
        <p style={banner}>
          Four HOPE sections have item definitions in this system — I (diagnosis), J (J2030 / J2050
          / J2051) and N (medications). The remaining sections will be reported as missing by the
          CMS pre-submission check until their items are built.
        </p>

        {!isSfv ? (
          <SelectField
            label="Reason for assessment"
            value={rfaKind}
            disabled={pinnedRfa !== undefined}
            onChange={(e) => setRfaKind(e.target.value as RfaKind)}
            options={RFA_KINDS.map((k) => ({ value: k, label: rfaLabel(k) }))}
          />
        ) : null}
        {pinnedRfa !== undefined ? (
          <p style={meta}>
            Pinned by the scheduled window — a payload whose RFA does not match the schedule is
            refused (M10_RFA_KIND_MISMATCH).
          </p>
        ) : null}

        <TextField
          label="Visit date &amp; time"
          type="datetime-local"
          value={targetLocal}
          onChange={(e) => setTargetLocal(e.target.value)}
        />

        {authorRoles.length === 0 ? (
          // Not a permission verdict — the server still owns §4.7. This says the capture cannot be
          // ATTRIBUTED, because none of the caller's roles is in the author vocabulary at all.
          <p style={meta}>
            None of your roles can be recorded as a HOPE author discipline, so this capture cannot
            be attributed. Ask an administrator to review your role grants.
          </p>
        ) : (
          <SelectField
            label="Recording as"
            value={authorDiscipline}
            onChange={(e) => setAuthorDiscipline(e.target.value as AuthorDiscipline | "")}
            options={[
              ...(authorRoles.length > 1 ? [{ value: "", label: "Select a discipline…" }] : []),
              ...authorRoles.map((d) => ({ value: d, label: authorDisciplineLabel(d) })),
            ]}
          />
        )}

        {rfaKind === "05_discharge" && !isSfv ? (
          <>
            <SelectField
              label="Discharge reason"
              value={dischargeReason}
              onChange={(e) => setDischargeReason(e.target.value as DischargeReason)}
              options={DISCHARGE_REASONS.map((r) => ({ value: r, label: humanize(r) }))}
            />
            <p style={meta}>
              {forbidsQ
                ? "Section Q (Participation) is forbidden on a death discharge (D9) and will not be sent."
                : "Section Q (Participation) is required on this discharge (D9) and will be recorded."}
            </p>
          </>
        ) : null}

        {/* The §4.4 / D12 late-completion confirmation. Shown from the STORED window; the server decides. */}
        {span === "late" ? (
          <div style={lateBox}>
            <StatusPill label="Late completion" tone="warning" />
            <p style={meta}>
              This visit date falls after the window closed and before the late deadline. CMS
              requires a reason code, and each late completion counts against the HQRP compliance
              rate (D12).
            </p>
            <SelectField
              label="Late completion reason"
              value={lateReason}
              onChange={(e) => setLateReason(e.target.value as LateReasonCode)}
              options={LATE_REASONS.map((r) => ({ value: r, label: humanize(r) }))}
            />
          </div>
        ) : null}
        {span === "expired" ? (
          <div style={lateBox}>
            <StatusPill label="Past the late deadline" tone="error" />
            <p style={meta}>
              The window's late deadline has passed. Recording now requires an administrative
              override, which the server records on the row.
            </p>
            <label style={checkRow}>
              <input
                type="checkbox"
                checked={adminOverride}
                onChange={(e) => setAdminOverride(e.target.checked)}
              />
              <span>Record with administrative override</span>
            </label>
          </div>
        ) : null}
        {span === "before_open" ? (
          <p style={meta}>
            This visit date is before the window opens; the server will refuse it
            (M10_TIMEPOINT_NOT_OPEN).
          </p>
        ) : null}

        <h3 style={sectionTitle}>Section I — Active diagnoses</h3>
        <TextField
          label="Primary terminal diagnosis (ICD-10-CM)"
          value={primaryDiagnosisIcd10}
          onChange={(e) => setPrimaryDiagnosisIcd10(e.target.value)}
          placeholder="C34.90"
        />

        <h3 style={sectionTitle}>Section J — Health conditions</h3>
        <label style={checkRow}>
          <input
            type="checkbox"
            checked={painScreened}
            onChange={(e) => setPainScreened(e.target.checked)}
          />
          <span>J2030 — screened for pain</span>
        </label>
        {painScreened ? (
          <TextAreaField
            label="Pain characteristics"
            value={painCharacteristics}
            onChange={(e) => setPainCharacteristics(e.target.value)}
            rows={2}
          />
        ) : null}
        <label style={checkRow}>
          <input
            type="checkbox"
            checked={dyspneaScreened}
            onChange={(e) => setDyspneaScreened(e.target.checked)}
          />
          <span>J2050 — screened for shortness of breath</span>
        </label>
        {dyspneaScreened ? (
          <TextAreaField
            label="Dyspnea characteristics"
            value={dyspneaCharacteristics}
            onChange={(e) => setDyspneaCharacteristics(e.target.value)}
            rows={2}
          />
        ) : null}

        <p style={meta}>J2051 — symptom impact at this visit</p>
        <div style={symptomGrid}>
          {SYMPTOMS.map((symptom) => (
            <SelectField
              key={symptom}
              label={humanize(symptom)}
              value={severities[symptom] ?? ""}
              onChange={(e) =>
                setSeverities((prev) => {
                  const next = { ...prev };
                  if (e.target.value === "") delete next[symptom];
                  else next[symptom] = e.target.value as Severity;
                  return next;
                })
              }
              options={[
                { value: "", label: "Not screened" },
                ...SEVERITIES.map((s) => ({ value: s, label: humanize(s) })),
              ]}
            />
          ))}
        </div>
        {severities.other !== undefined ? (
          <TextField
            label="Other symptom — label"
            value={otherSymptomLabel}
            onChange={(e) => setOtherSymptomLabel(e.target.value)}
          />
        ) : null}
        {triggering.length > 0 ? (
          // Informational, never blocking — the clinician records what is clinically true and the SFV
          // is the consequence. The SERVER evaluates the trigger from the stored payload at sign (D4);
          // this is a preview of a decision it makes, not the decision.
          <output style={triggerBox}>
            <StatusPill label="Follow-up will be required" tone="warning" />
            <p style={meta}>
              {triggering.map(humanize).join(", ")} at moderate or severe will create a Symptom
              Follow-Up Visit obligation due within 2 calendar days once this timepoint is signed.
            </p>
          </output>
        ) : null}

        <h3 style={sectionTitle}>Section N — Medications</h3>
        <label style={checkRow}>
          <input
            type="checkbox"
            checked={opioidPrescribed}
            onChange={(e) => setOpioidPrescribed(e.target.checked)}
          />
          <span>Opioid prescribed for pain</span>
        </label>
        {opioidPrescribed ? (
          <>
            <label style={checkRow}>
              <input
                type="checkbox"
                checked={scheduledBowelRegimen}
                onChange={(e) => setScheduledBowelRegimen(e.target.checked)}
              />
              <span>Scheduled bowel regimen in place</span>
            </label>
            {!scheduledBowelRegimen ? (
              <TextField
                label="Bowel regimen contraindication"
                value={bowelRegimenContraindication}
                onChange={(e) => setBowelRegimenContraindication(e.target.value)}
              />
            ) : null}
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
          <Button onClick={submit} disabled={busy || blocked}>
            {busy ? "Recording…" : isSfv ? "Record follow-up" : "Record draft"}
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
const title: CSSProperties = { margin: 0, fontSize: "1.05rem", fontWeight: 600 };
const sectionTitle: CSSProperties = {
  margin: "0.5rem 0 0",
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};
const meta: CSSProperties = {
  margin: 0,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
const banner: CSSProperties = {
  ...meta,
  padding: "0.5rem 0.625rem",
  borderRadius: "0.375rem",
  background: "var(--color-surface-variant)",
};
const lateBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.375rem",
  padding: "0.625rem",
  borderRadius: "0.375rem",
  border: "1px solid var(--color-outline-variant)",
};
const triggerBox: CSSProperties = { ...lateBox };
const checkRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.85rem",
};
const symptomGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
  gap: "0.5rem",
};
const errorText: CSSProperties = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };
