import {
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  cardSurface,
  isoToLocalInput,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { WORKFLOW_TONE, rfaLabel, stateLabel } from "./hope-status";

type FixedKind = "01_admission" | "02_huv1" | "03_huv2" | "05_discharge";
type Discipline = "RN" | "NP" | "MD";
type DischargeReason = "death" | "revocation" | "transfer_to_hospice" | "live_discharge";

interface WorkflowTimepoint {
  kind: FixedKind;
  status: string;
  windowStart: string | null;
  windowEnd: string | null;
  lateDeadline: string | null;
  assessmentId: string | null;
}
interface WorkflowSfv {
  id: string;
  status: string;
  triggeringAssessmentId: string;
  triggeringRfaKind: string | null;
  dueAt: string;
  completingAssessmentId: string | null;
}
interface WorkflowState {
  admissionId: string;
  patientId: string | null;
  admissionStatus: string | null;
  admissionAt: string | null;
  admissionAssessment: WorkflowTimepoint;
  huv1: WorkflowTimepoint;
  huv2: WorkflowTimepoint;
  sfvs: WorkflowSfv[];
  dischargeAssessment: WorkflowTimepoint;
}

const TIMEPOINT_PARAM_TO_KIND: Record<string, FixedKind> = {
  "01_admission": "01_admission",
  "02_huv1": "02_huv1",
  "03_huv2": "03_huv2",
  "05_discharge": "05_discharge",
};
const LATE_REASONS = [
  { value: "hospitalization", label: "Patient hospitalization" },
  { value: "pto", label: "Staff time off" },
  { value: "family_meeting_deferral", label: "Family meeting deferral" },
  { value: "refused", label: "Patient or family refused" },
  { value: "missed", label: "Missed visit" },
  { value: "pandemic_cohort", label: "Pandemic cohorting" },
  { value: "other", label: "Other" },
] as const;

export function HopeTimepointCapture(): JSX.Element {
  const { admissionId, kind: rawKind } = useParams<{ admissionId: string; kind: string }>();
  const kind = rawKind ? TIMEPOINT_PARAM_TO_KIND[rawKind] : undefined;
  return <HopeCaptureWorkspace admissionId={admissionId} kind={kind} sfvId={undefined} />;
}

export function HopeSfvCapture(): JSX.Element {
  const { admissionId, sfvId } = useParams<{ admissionId: string; sfvId: string }>();
  return <HopeCaptureWorkspace admissionId={admissionId} kind={undefined} sfvId={sfvId} />;
}

function HopeCaptureWorkspace({
  admissionId,
  kind,
  sfvId,
}: {
  admissionId?: string;
  kind?: FixedKind;
  sfvId?: string;
}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [state, setState] = useState<WorkflowState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [targetDate, setTargetDate] = useState(isoToLocalInput(new Date().toISOString()));
  const [discipline, setDiscipline] = useState<Discipline>("RN");
  const [lateReason, setLateReason] = useState("");
  const [dischargeReason, setDischargeReason] = useState<DischargeReason>("live_discharge");

  const load = useCallback(async () => {
    if (!admissionId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/admissions/{admissionId}/hope", {
      params: { path: { admissionId } },
    });
    if (err || !data) {
      setError("Unable to load HOPE workflow.");
      setLoading(false);
      return;
    }
    setState(data as WorkflowState);
    setLoading(false);
  }, [admissionId, client]);

  useEffect(() => {
    void load();
  }, [load]);

  const item = useMemo(() => {
    if (!state || !kind) return null;
    if (kind === "01_admission") return state.admissionAssessment;
    if (kind === "02_huv1") return state.huv1;
    if (kind === "03_huv2") return state.huv2;
    return state.dischargeAssessment;
  }, [kind, state]);
  const sfv = useMemo(() => state?.sfvs.find((s) => s.id === sfvId) ?? null, [sfvId, state]);
  const title = sfv ? "Symptom Follow-Up" : item ? `${rfaLabel(item.kind)} Assessment` : "HOPE";

  const submitTimepoint = useCallback(async () => {
    if (!admissionId || !item) return;
    setBusy(true);
    setActionError(null);
    const { data, error: err } = await client.POST(
      "/api/v1/admissions/{admissionId}/hope/timepoints",
      {
        params: { path: { admissionId } },
        body: {
          rfaKind: item.kind,
          targetDate: fromDatetimeLocal(targetDate),
          authorDiscipline: discipline,
          data: { J: { J2051: { entries: [] } } },
          lateCompletionReasonCode: lateReason.trim() || undefined,
          dischargeReason: item.kind === "05_discharge" ? dischargeReason : undefined,
        },
      },
    );
    setBusy(false);
    if (err || !data) {
      setActionError(messageForBackendError(err, item));
      return;
    }
    navigate(`/hope/assessments/${data.id}`);
  }, [admissionId, client, discipline, dischargeReason, item, lateReason, navigate, targetDate]);

  const submitSfv = useCallback(async () => {
    if (!admissionId || !sfv) return;
    setBusy(true);
    setActionError(null);
    const { data, error: err } = await client.POST("/api/v1/admissions/{admissionId}/hope/sfv", {
      params: { path: { admissionId } },
      body: {
        triggeringAssessmentId: sfv.triggeringAssessmentId,
        targetDate: fromDatetimeLocal(targetDate),
        authorDiscipline: discipline === "MD" ? "RN" : discipline,
        data: { J: { J2051: { entries: [] } } },
      },
    });
    setBusy(false);
    if (err || !data) {
      setActionError(messageForBackendError(err, null));
      return;
    }
    navigate(`/admissions/${admissionId}/hope`);
  }, [admissionId, client, discipline, navigate, sfv, targetDate]);

  if (loading) return <LoadingSpinner />;
  if (error || !state)
    return (
      <EmptyState title="Unable to load HOPE workflow" description={error ?? "Not available."} />
    );
  if (!sfv && !item)
    return (
      <EmptyState title="HOPE item not found" description="This workflow item is not available." />
    );

  const status = sfv?.status ?? item?.status ?? "not_applicable";
  const canSubmit = sfv
    ? sfv.status === "open" || sfv.status === "overdue"
    : item?.status === "open" || item?.status === "late";

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={title}
          actions={
            <button
              type="button"
              onClick={() => navigate(`/admissions/${state.admissionId}/hope`)}
              style={ghostBtn}
            >
              HOPE Overview
            </button>
          }
        >
          <span style={metaLine}>
            Patient <span className="wx-data-md">{state.patientId ?? "unresolved"}</span>
            {state.admissionAt ? ` · Admission ${fmtDate(state.admissionAt)}` : ""}
          </span>
        </PageHeader>
      }
    >
      <section style={cardStyle}>
        <div style={headerRow}>
          <div>
            <h2 style={sectionTitle}>
              {sfv ? "Symptom follow-up completion" : "HOPE assessment capture"}
            </h2>
            <p style={bodyText}>
              {sfv
                ? `Triggered by ${sfv.triggeringRfaKind ? rfaLabel(sfv.triggeringRfaKind) : "a moderate/severe symptom assessment"}.`
                : guidanceFor(item)}
            </p>
          </div>
          <StatusPill label={workflowLabel(status)} tone={WORKFLOW_TONE[status] ?? "neutral"} />
        </div>

        {item ? (
          <div style={factsGrid}>
            <Fact label="Window" value={formatWindow(item.windowStart, item.windowEnd)} />
            <Fact label="Late deadline" value={fmtDate(item.lateDeadline)} />
          </div>
        ) : null}
        {sfv ? (
          <div style={factsGrid}>
            <Fact label="Due" value={fmtDate(sfv.dueAt)} />
            <Fact label="Trigger" value={sfv.triggeringAssessmentId} mono />
          </div>
        ) : null}

        {item?.assessmentId ? (
          <button
            type="button"
            onClick={() => navigate(`/hope/assessments/${item.assessmentId}`)}
            style={primaryBtn}
          >
            <Glyph name="file-text" size={14} />{" "}
            {item.status === "completed" ? "View completed assessment" : "Continue draft"}
          </button>
        ) : !canSubmit ? (
          <output style={noticeBox}>
            <Glyph
              name={
                status === "workflow_not_initialized" || status === "expired" ? "block" : "info"
              }
              size={16}
            />
            <span>{unavailableMessage(status, item)}</span>
          </output>
        ) : (
          <form
            style={formGrid}
            onSubmit={(ev) => {
              ev.preventDefault();
              void (sfv ? submitSfv() : submitTimepoint());
            }}
          >
            <label style={labelStyle} htmlFor="hope-target-date">
              Target date/time
            </label>
            <input
              id="hope-target-date"
              type="datetime-local"
              value={targetDate}
              onChange={(ev) => setTargetDate(ev.target.value)}
              style={inputStyle}
            />
            <label style={labelStyle} htmlFor="hope-discipline">
              Author discipline
            </label>
            <select
              id="hope-discipline"
              value={discipline}
              onChange={(ev) => setDiscipline(ev.target.value as Discipline)}
              style={inputStyle}
            >
              <option value="RN">RN</option>
              <option value="NP">NP</option>
              {!sfv ? <option value="MD">MD</option> : null}
            </select>
            {item?.status === "late" ? (
              <>
                <label style={labelStyle} htmlFor="late-reason">
                  Late completion reason
                </label>
                <select
                  id="late-reason"
                  value={lateReason}
                  onChange={(ev) => setLateReason(ev.target.value)}
                  style={inputStyle}
                >
                  <option value="">Select a reason</option>
                  {LATE_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
            {item?.kind === "05_discharge" ? (
              <>
                <label style={labelStyle} htmlFor="discharge-reason">
                  Discharge reason
                </label>
                <select
                  id="discharge-reason"
                  value={dischargeReason}
                  onChange={(ev) => setDischargeReason(ev.target.value as DischargeReason)}
                  style={inputStyle}
                >
                  <option value="live_discharge">Live discharge</option>
                  <option value="death">Death</option>
                  <option value="revocation">Revocation</option>
                  <option value="transfer_to_hospice">Transfer to hospice</option>
                </select>
              </>
            ) : null}
            {actionError ? (
              <p role="alert" aria-live="assertive" style={errorText}>
                {actionError}
              </p>
            ) : null}
            <button type="submit" disabled={busy} style={busy ? disabledBtn : primaryBtn}>
              <Glyph name="clipboard-check" size={14} />{" "}
              {busy ? "Recording..." : "Create HOPE draft"}
            </button>
          </form>
        )}
      </section>
    </DetailPageLayout>
  );
}

function Fact({
  label,
  value,
  mono = false,
}: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div style={factStyle}>
      <span style={labelStyle}>{label}</span>
      <strong className={mono ? "wx-data-md" : undefined} style={factValue}>
        {value}
      </strong>
    </div>
  );
}

function messageForBackendError(err: unknown, item: WorkflowTimepoint | null): string {
  const code = (err as { error?: { code?: string } } | null)?.error?.code;
  if (code === "M10_LATE_REASON_REQUIRED")
    return "This assessment is after the normal window. Select a late completion reason.";
  if (code === "M10_LATE_REASON_INVALID")
    return "That late completion reason is not accepted. Select a different reason.";
  if (code === "M10_DISCIPLINE_NOT_PERMITTED")
    return "Only an RN, NP or MD can author this HOPE assessment.";
  if (code === "M10_TIMEPOINT_NOT_OPEN")
    return `${item ? rfaLabel(item.kind) : "This assessment"} is not open yet.`;
  if (code === "M10_TIMEPOINT_EXPIRED")
    return "The allowed capture period has expired. An authorized override is required.";
  if (code === "M10_SFV_PAST_DUE")
    return "This follow-up is past due and needs an authorized override.";
  return "Could not record the HOPE work. Review the values and try again.";
}

function unavailableMessage(status: string, item: WorkflowTimepoint | null): string {
  if (status === "upcoming")
    return `${item ? rfaLabel(item.kind) : "This item"} opens ${fmtDate(item?.windowStart)}.`;
  if (status === "expired") return "The allowed capture period has expired.";
  if (status === "not_applicable") return "This item is not applicable for the current admission.";
  if (status === "workflow_not_initialized")
    return "This admission is missing its HOPE schedule. Use the existing admin repair path before recording.";
  if (status === "missed") return "The follow-up deadline passed without completion.";
  return "This workflow item is not available for capture.";
}

function guidanceFor(item: WorkflowTimepoint | null): string {
  if (!item) return "";
  if (item.status === "late")
    return `The normal window closed ${fmtDate(item.windowEnd)}. A late reason is required.`;
  if (item.status === "open") return `${rfaLabel(item.kind)} is ready to complete.`;
  if (item.status === "upcoming")
    return `${rfaLabel(item.kind)} opens ${fmtDate(item.windowStart)}.`;
  return workflowLabel(item.status);
}

function workflowLabel(status: string): string {
  if (status === "open") return "Action required";
  if (status === "late") return "Late completion";
  if (status === "workflow_not_initialized") return "Workflow not initialized";
  return stateLabel(status);
}

function formatWindow(start: string | null, end: string | null): string {
  if (!start || !end) return "-";
  return `${fmtDate(start)} - ${fmtDate(end)}`;
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function fromDatetimeLocal(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

const cardStyle: CSSProperties = {
  ...cardSurface,
  padding: "1rem 1.25rem",
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};
const headerRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "1rem",
  flexWrap: "wrap",
};
const sectionTitle: CSSProperties = {
  margin: 0,
  color: t.onSurface,
  fontFamily: t.fontDisplay,
  fontSize: "1.05rem",
  fontWeight: 700,
};
const metaLine: CSSProperties = { color: t.onSurfaceVariant, fontSize: "0.85rem" };
const bodyText: CSSProperties = {
  margin: "0.2rem 0 0",
  color: t.onSurfaceVariant,
  fontSize: "0.85rem",
};
const factsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))",
  gap: "0.75rem",
};
const factStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.2rem" };
const labelStyle: CSSProperties = {
  color: t.muted,
  fontSize: "0.72rem",
  fontWeight: 700,
};
const factValue: CSSProperties = { color: t.onSurface, fontSize: "0.9rem" };
const formGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(12rem, 20rem)",
  gap: "0.55rem",
};
const inputStyle: CSSProperties = {
  minHeight: "2.25rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-outline-variant)",
  background: t.surfaceLowest,
  color: t.onSurface,
  padding: "0.45rem 0.6rem",
};
const primaryBtn: CSSProperties = {
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
  borderRadius: "var(--radius-md)",
  background: t.primary,
  color: t.onPrimary,
  border: "none",
  cursor: "pointer",
  fontSize: "0.82rem",
  fontWeight: 700,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.4rem",
};
const ghostBtn: CSSProperties = {
  ...primaryBtn,
  background: t.surfaceContainer,
  color: t.onSurface,
};
const disabledBtn: CSSProperties = { ...primaryBtn, opacity: 0.55, cursor: "not-allowed" };
const noticeBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  background: t.surfaceContainer,
  color: t.onSurface,
};
const errorText: CSSProperties = { margin: 0, color: t.error, fontSize: "0.85rem" };
