import {
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  cardSurface,
  t,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ATTENTION_TONE, WORKFLOW_TONE, attentionLabel, rfaLabel, stateLabel } from "./hope-status";

type FixedKind = "01_admission" | "02_huv1" | "03_huv2" | "05_discharge";

interface PatientSummary {
  id: string;
  firstName: string;
  lastName: string;
  mrn?: string;
}

interface WorkflowTimepoint {
  kind: FixedKind;
  status: string;
  scheduleId: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  lateDeadline: string | null;
  completedAt: string | null;
  assessmentId: string | null;
  attention?: HopeAttention;
}
interface WorkflowSfv {
  id: string;
  status: string;
  triggeringAssessmentId: string;
  triggeringRfaKind: string | null;
  dueAt: string;
  triggeredAt: string;
  completedAt: string | null;
  completingAssessmentId: string | null;
  attention?: HopeAttention;
}
interface HopeAttention {
  state: string;
  severity: string;
  action: string;
  message: string | null;
  deadline: string | null;
}
interface WorkflowState {
  admissionId: string;
  patientId: string | null;
  admissionStatus: string | null;
  admissionAt: string | null;
  activatedAt: string | null;
  dischargedAt: string | null;
  admissionAssessment: WorkflowTimepoint;
  huv1: WorkflowTimepoint;
  huv2: WorkflowTimepoint;
  sfvs: WorkflowSfv[];
  dischargeAssessment: WorkflowTimepoint;
  summary: {
    actionableCount: number;
    overdueCount: number;
    completedCount: number;
    nextDeadline: string | null;
    highestSeverity?: string;
    dueSoonCount?: number;
    workflowIssueCount?: number;
  };
}

const FIXED_LABELS: Record<FixedKind, { title: string; subtitle: string; action: string }> = {
  "01_admission": {
    title: "HOPE Admission Assessment",
    subtitle: "Admission RFA",
    action: "Complete Admission RFA",
  },
  "02_huv1": {
    title: "HUV1",
    subtitle: "Hospice Update Visit 1",
    action: "Complete HUV1",
  },
  "03_huv2": {
    title: "HUV2",
    subtitle: "Hospice Update Visit 2",
    action: "Complete HUV2",
  },
  "05_discharge": {
    title: "Discharge Assessment",
    subtitle: "Discharge RFA",
    action: "Complete Discharge Assessment",
  },
};
const SKELETON_KEYS = ["admission", "huv1", "huv2", "sfv", "discharge"];

export function AdmissionHopeOverview(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { admissionId } = useParams<{ admissionId: string }>();
  const [state, setState] = useState<WorkflowState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);

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

  useEffect(() => {
    if (!state?.patientId) return;
    (async () => {
      const { data: patientData, error: patientError } = await client.GET("/api/v1/patients/{id}", {
        params: {
          path: {
            id: state.patientId as string,
          },
        },
      });

      if (!patientError && patientData) {
        setPatient(patientData as PatientSummary);
      }
    })();
  }, [state, client]);

  const orderedItems = useMemo(() => {
    if (!state) return [];
    return [state.admissionAssessment, state.huv1, state.huv2, state.dischargeAssessment].sort(
      (a, b) => priority(a.status) - priority(b.status),
    );
  }, [state]);

  if (loading) {
    return (
      <DetailPageLayout header={<PageHeader title="HOPE" breadcrumb="Admissions / HOPE" />}>
        <div style={skeletonGrid} aria-label="Loading HOPE workflow">
          {SKELETON_KEYS.map((key) => (
            <div key={key} style={skeletonCard} />
          ))}
        </div>
      </DetailPageLayout>
    );
  }

  if (error || !state) {
    return (
      <DetailPageLayout header={<PageHeader title="HOPE" breadcrumb="Admissions / HOPE" />}>
        <EmptyState
          title="Unable to load HOPE workflow"
          description={error ?? "The workflow summary was not available."}
        />
        <button type="button" onClick={() => void load()} style={primaryBtn}>
          <Glyph name="clock" size={14} /> Retry
        </button>
      </DetailPageLayout>
    );
  }

  const needsAttention = summaryNeedsAttention(state.summary);

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="HOPE"
          breadcrumb={`Admissions / ${patient ? `${patient.firstName} ${patient.lastName}` : "Admission"} / HOPE`}
          actions={
            <button
              type="button"
              onClick={() => navigate(`/admissions/${state.admissionId}`)}
              style={ghostBtn}
            >
              Admission
            </button>
          }
        >
          <span style={metaLine}>
            <span>
              Patient{" "}
              <Link
                to={`/patients/${state.patientId}`}
                style={{
                  color: "var(--color-primary)",
                  fontWeight: 600,
                  textDecoration: "none",
                }}
              >
                {patient ? `${patient.firstName} ${patient.lastName}` : "Loading patient..."}
              </Link>
            </span>
            {state.admissionAt ? ` · Admission ${fmtDate(state.admissionAt)}` : ""}
            {state.admissionStatus ? ` · ${stateLabel(state.admissionStatus)}` : ""}
          </span>
        </PageHeader>
      }
      aside={
        <aside style={summaryPanel} aria-label="HOPE status summary">
          <h2 style={sideTitle}>HOPE status</h2>
          <Metric label="Action required" value={state.summary.actionableCount} />
          <Metric label="Completed" value={state.summary.completedCount} />
          <Metric label="Overdue/missed" value={state.summary.overdueCount} />
          <Metric label="Due soon" value={state.summary.dueSoonCount ?? 0} />
          <Metric label="Workflow issues" value={state.summary.workflowIssueCount ?? 0} />
          <div style={{ marginTop: "0.75rem" }}>
            <span style={smallLabel}>Next deadline</span>
            <strong style={deadlineText}>{fmtDate(state.summary.nextDeadline)}</strong>
          </div>
        </aside>
      }
    >
      <div style={pageStack}>
        <section style={overviewBand}>
          <div>
            <h2 style={sectionTitle}>Workflow overview</h2>
            <p style={bodyText}>
              {needsAttention
                ? "Review HOPE items that need attention for this admission."
                : "HOPE is up to date. No HOPE action is currently required."}
            </p>
          </div>
          <StatusPill
            label={summaryLabel(state)}
            tone={
              needsAttention
                ? (state.summary.highestSeverity ?? "none") === "none"
                  ? "warning"
                  : (ATTENTION_TONE[severityToAttention(state.summary.highestSeverity ?? "none")] ??
                    "warning")
                : "success"
            }
            glyph={needsAttention ? "alert" : "check-circle"}
          />
        </section>

        <section aria-label="HOPE fixed timepoints" style={cardGrid}>
          {orderedItems.map((item) => (
            <HopeTimepointCard
              key={item.kind}
              item={item}
              onAction={() => {
                if (item.assessmentId) navigate(`/hope/assessments/${item.assessmentId}`);
                else navigate(`/admissions/${state.admissionId}/hope/timepoints/${item.kind}`);
              }}
            />
          ))}
        </section>

        <section style={sfvSection} aria-labelledby="sfv-heading">
          <div style={sectionHeader}>
            <div>
              <h2 id="sfv-heading" style={sectionTitle}>
                Symptom Follow-Up Visits
              </h2>
              <p style={bodyText}>Triggered follow-ups stay separate from fixed RFA timepoints.</p>
            </div>
            <StatusPill
              label={`${state.sfvs.filter((s) => s.status === "open" || s.status === "overdue").length} open`}
              tone={state.sfvs.some((s) => s.status === "overdue") ? "warning" : "progress"}
            />
          </div>
          {state.sfvs.length === 0 ? (
            <p style={emptyText}>
              No symptom follow-up visits are currently linked to this admission.
            </p>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              {state.sfvs.map((sfv) => (
                <SfvRow
                  key={sfv.id}
                  sfv={sfv}
                  onAction={() => navigate(`/admissions/${state.admissionId}/hope/sfv/${sfv.id}`)}
                  onView={() =>
                    sfv.completingAssessmentId
                      ? navigate(`/hope/assessments/${sfv.completingAssessmentId}`)
                      : navigate(`/admissions/${state.admissionId}/hope/sfv/${sfv.id}`)
                  }
                />
              ))}
            </div>
          )}
        </section>

        <section style={clinicalSection}>
          <div>
            <h2 style={sectionTitle}>Clinical Admission Assessment</h2>
            <p style={bodyText}>
              M9 clinical admission assessment remains separate from the M10 HOPE Admission RFA.
            </p>
          </div>
          {state.patientId ? (
            <button
              type="button"
              onClick={() => navigate(`/patients/${state.patientId}/assessments`)}
              style={ghostBtn}
            >
              <Glyph name="clipboard-check" size={14} /> Open M9 Assessments
            </button>
          ) : null}
        </section>
      </div>
    </DetailPageLayout>
  );
}

function HopeTimepointCard({
  item,
  onAction,
}: {
  item: WorkflowTimepoint;
  onAction: () => void;
}): JSX.Element {
  const labels = FIXED_LABELS[item.kind];
  const attention = attentionOf(item.attention);
  const actionAllowed =
    item.status === "open" ||
    item.status === "late" ||
    item.status === "completed" ||
    !!item.assessmentId;
  const hasDraft = !!item.assessmentId && item.status !== "completed";
  const actionLabel =
    item.status === "completed" ? "View Assessment" : hasDraft ? "Continue draft" : labels.action;
  return (
    <article style={workflowCard}>
      <div style={sectionHeader}>
        <div>
          <h3 style={cardTitle}>{labels.title}</h3>
          <p style={cardSubtitle}>{labels.subtitle}</p>
        </div>
        <StatusPill
          label={
            attention.state === "none"
              ? workflowLabel(item.status)
              : attentionLabel(attention.state)
          }
          tone={
            attention.state === "none"
              ? (WORKFLOW_TONE[item.status] ?? "neutral")
              : (ATTENTION_TONE[attention.state] ?? "neutral")
          }
          glyph={glyphFor(attention.state === "none" ? item.status : attention.state)}
        />
      </div>
      <dl style={definitionList}>
        <Field label="Window" value={formatWindow(item.windowStart, item.windowEnd)} />
        <Field label="Late deadline" value={fmtDate(item.lateDeadline)} />
        <Field
          label="Status"
          value={
            attention.message
              ? attentionGuidance(item)
              : item.completedAt
                ? `Completed ${fmtDate(item.completedAt)}`
                : hasDraft
                  ? "Draft in progress"
                  : guidanceFor(item)
          }
        />
      </dl>
      <button
        type="button"
        onClick={onAction}
        style={actionAllowed ? primaryBtn : disabledBtn}
        disabled={!actionAllowed}
      >
        {actionLabel}
      </button>
    </article>
  );
}

function SfvRow({
  sfv,
  onAction,
  onView,
}: {
  sfv: WorkflowSfv;
  onAction: () => void;
  onView: () => void;
}): JSX.Element {
  const canComplete = sfv.status === "open" || sfv.status === "overdue";
  const attention = attentionOf(sfv.attention);
  return (
    <article style={sfvRowStyle}>
      <div>
        <h3 style={cardTitle}>Symptom Follow-Up</h3>
        <p style={cardSubtitle}>
          Triggered by{" "}
          {sfv.triggeringRfaKind
            ? rfaLabel(sfv.triggeringRfaKind)
            : "a moderate/severe symptom assessment"}
        </p>
      </div>
      <div style={sfvFacts}>
        <StatusPill
          label={
            attention.state === "none" ? stateLabel(sfv.status) : attentionLabel(attention.state)
          }
          tone={
            attention.state === "none"
              ? (WORKFLOW_TONE[sfv.status] ?? "neutral")
              : (ATTENTION_TONE[attention.state] ?? "neutral")
          }
        />
        <span style={bodyText}>
          {attention.message
            ? `${attention.message}${
                attention.deadline ? ` Deadline ${fmtDate(attention.deadline)}` : ""
              }`
            : sfv.status === "completed" && sfv.completedAt
              ? `Completed ${fmtDate(sfv.completedAt)}`
              : sfv.status === "missed"
                ? `Missed deadline ${fmtDate(sfv.dueAt)}`
                : `Due ${fmtDate(sfv.dueAt)}`}
        </span>
      </div>
      <button
        type="button"
        onClick={canComplete ? onAction : onView}
        style={canComplete ? primaryBtn : ghostBtn}
      >
        {canComplete ? "Complete Follow-Up" : "View Follow-Up"}
      </button>
    </article>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: number;
}): JSX.Element {
  return (
    <div style={metricRow}>
      <span>{label}</span>
      <strong className="tabular-nums">{value}</strong>
    </div>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}): JSX.Element {
  return (
    <>
      <dt style={smallLabel}>{label}</dt>
      <dd style={fieldValue}>{value}</dd>
    </>
  );
}

function priority(status: string): number {
  if (status === "expired" || status === "overdue" || status === "missed" || status === "late")
    return 0;
  if (status === "open") return 1;
  if (status === "upcoming") return 2;
  if (status === "completed") return 3;
  return 4;
}

function glyphFor(status: string): "clock" | "check-circle" | "block" | "dot" | "alert" {
  if (status === "completed") return "check-circle";
  if (
    status === "expired" ||
    status === "missed" ||
    status === "workflow_not_initialized" ||
    status === "window_expired" ||
    status === "workflow_issue"
  )
    return "block";
  if (status === "late" || status === "overdue" || status === "due" || status === "due_soon")
    return "alert";
  if (status === "upcoming") return "clock";
  return "dot";
}

function workflowLabel(status: string): string {
  if (status === "open") return "Action required";
  if (status === "late") return "Late completion";
  if (status === "workflow_not_initialized") return "Workflow not initialized";
  if (status === "not_applicable") return "Not applicable";
  return stateLabel(status);
}

function guidanceFor(item: WorkflowTimepoint): string {
  if (item.status === "upcoming") return `Opens ${fmtDate(item.windowStart)}`;
  if (item.status === "open") return "Ready to complete";
  if (item.status === "late")
    return `Normal window closed ${fmtDate(item.windowEnd)}; late reason required`;
  if (item.status === "expired") return "Allowed capture period has expired";
  if (item.status === "not_applicable") return "Not applicable for this admission";
  if (item.status === "workflow_not_initialized") return "Schedule is missing for this admission";
  return stateLabel(item.status);
}

function attentionGuidance(item: WorkflowTimepoint): string {
  const attention = attentionOf(item.attention);
  if (attention.state === "overdue" && item.status === "late")
    return `Normal window closed ${fmtDate(item.windowEnd)}; late completion is allowed until ${fmtDate(
      item.lateDeadline,
    )}.`;
  if (attention.state === "window_expired")
    return "Standard and late completion windows have closed. Authorized remediation may be required.";
  if (attention.state === "workflow_issue")
    return "The expected HOPE schedule was not initialized for this Admission.";
  if (attention.state === "due" || attention.state === "due_soon")
    return `Window closes ${fmtDate(attention.deadline ?? item.windowEnd)}.`;
  return attention.message ?? guidanceFor(item);
}

/** One signal for the sentence, the pill tone and the pill label, so they cannot disagree. */
function summaryNeedsAttention(summary: WorkflowState["summary"]): boolean {
  return (
    (summary.highestSeverity ?? "none") !== "none" ||
    summary.actionableCount > 0 ||
    summary.overdueCount > 0 ||
    (summary.dueSoonCount ?? 0) > 0 ||
    (summary.workflowIssueCount ?? 0) > 0
  );
}

function summaryLabel(state: WorkflowState): string {
  const workflowIssueCount = state.summary.workflowIssueCount ?? 0;
  const dueSoonCount = state.summary.dueSoonCount ?? 0;
  if (workflowIssueCount > 0)
    return `${workflowIssueCount} workflow issue${workflowIssueCount === 1 ? "" : "s"}`;
  if (state.summary.overdueCount > 0) return `${state.summary.overdueCount} overdue or missed`;
  if (dueSoonCount > 0) return `${dueSoonCount} due soon`;
  if (state.summary.actionableCount > 0) return `${state.summary.actionableCount} action required`;
  return "Up to date";
}

function severityToAttention(severity: string): string {
  if (severity === "critical") return "overdue";
  if (severity === "warn") return "due_soon";
  if (severity === "info") return "upcoming";
  return "none";
}

function attentionOf(attention: HopeAttention | undefined): HopeAttention {
  return (
    attention ?? {
      state: "none",
      severity: "none",
      action: "NONE",
      message: null,
      deadline: null,
    }
  );
}

function formatWindow(start: string | null, end: string | null): string {
  if (!start || !end) return "—";
  return `${fmtDate(start)} - ${fmtDate(end)}`;
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

const pageStack: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};
const cardGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(17rem, 1fr))",
  gap: "1rem",
};
const workflowCard: CSSProperties = {
  ...cardSurface,
  padding: "1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.85rem",
};
const overviewBand: CSSProperties = {
  ...cardSurface,
  padding: "1rem 1.25rem",
  display: "flex",
  justifyContent: "space-between",
  gap: "1rem",
  alignItems: "flex-start",
  flexWrap: "wrap",
};
const sfvSection: CSSProperties = {
  ...cardSurface,
  padding: "1rem 1.25rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.85rem",
};
const clinicalSection: CSSProperties = {
  ...cardSurface,
  padding: "1rem 1.25rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
};
const sectionHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "0.75rem",
};
const sectionTitle: CSSProperties = {
  margin: 0,
  color: t.onSurface,
  fontFamily: t.fontDisplay,
  fontSize: "1rem",
  fontWeight: 600,
};
const cardTitle: CSSProperties = {
  margin: 0,
  color: t.onSurface,
  fontSize: "0.95rem",
  fontWeight: 700,
};
const cardSubtitle: CSSProperties = {
  margin: "0.15rem 0 0",
  color: t.onSurfaceVariant,
  fontSize: "0.8rem",
};
const bodyText: CSSProperties = {
  margin: 0,
  color: t.onSurfaceVariant,
  fontSize: "0.82rem",
};
const emptyText: CSSProperties = {
  margin: 0,
  color: t.onSurfaceVariant,
  fontSize: "0.85rem",
};
const metaLine: CSSProperties = {
  color: t.onSurfaceVariant,
  fontSize: "0.85rem",
};
const definitionList: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "max-content minmax(0, 1fr)",
  gap: "0.35rem 0.75rem",
  margin: 0,
};
const smallLabel: CSSProperties = {
  color: t.muted,
  fontSize: "0.68rem",
  fontWeight: 700,
};
const fieldValue: CSSProperties = {
  margin: 0,
  color: t.onSurface,
  fontSize: "0.84rem",
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
const disabledBtn: CSSProperties = {
  ...ghostBtn,
  opacity: 0.55,
  cursor: "not-allowed",
};
const summaryPanel: CSSProperties = {
  ...cardSurface,
  padding: "1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.6rem",
};
const sideTitle: CSSProperties = {
  margin: 0,
  fontSize: "0.95rem",
  fontWeight: 700,
  color: t.onSurface,
};
const metricRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "1rem",
  color: t.onSurface,
  fontSize: "0.85rem",
};
const deadlineText: CSSProperties = {
  display: "block",
  marginTop: "0.15rem",
  color: t.onSurface,
};
const sfvRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(12rem, 1fr) auto auto",
  gap: "0.75rem",
  alignItems: "center",
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  background: t.surfaceLow,
};
const sfvFacts: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};
const skeletonGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(17rem, 1fr))",
  gap: "1rem",
};
const skeletonCard: CSSProperties = {
  minHeight: "8rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-surface-container) 70%, transparent)",
};
