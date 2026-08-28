import {
  CeremonyModal,
  DetailPageLayout,
  EmptyState,
  type GateItem,
  GateStepper,
  GuardChip,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  type StatusTone,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/06-admission — Admission Detail (M6 §5.2.4 + §5.2.5 activation gate, Track B).
// Spec: docs/design/screens/clinical/WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE.md — "Use Detail Page."
// Reads the admission aggregate from GET /api/v1/admissions/:id (which carries the R-AC-01 activation
// gate — the SAME server-truth gate route 14 enforces, so the §5.2.5 checklist can never diverge),
// plus the election-periods and compliance-windows sub-lists. Reconciled to Lantern (R1): the §5.2.5
// activation gate renders as a Guardrail GateStepper (blockers-first, alert glyphs) under a GuardChip
// summary; states are §6.6 status pills. Reads + the Acknowledge-NOR and Activate ceremonies (TASK-031).
//
// State-graph fix: `transitionAdmission`'s legal-transition graph (state-machines/admission.ts) only
// accepts `activate` FROM `notice_of_rights_acknowledged`, not from `pending` — a fresh admission
// (`acceptReferral`/`createAdmission`) always starts `pending`. Gating Activate on `state === "pending"`
// (an earlier draft of this file did) made the button permanently unreachable: the one route that
// advances `pending → notice_of_rights_acknowledged` (`POST /admissions/:id/nor`) had no UI anywhere in
// M6, so no admission could ever legally reach the state Activate requires. Both gaps are fixed here:
// Activate is gated on the real prerequisite state, and the Acknowledge-NOR ceremony (`state ===
// "pending"`) is what gets an admission there. Activate itself is only ever enabled when the SAME
// `activationGate.ready` the server enforces is true (route 14 now calls the identical
// `computeActivationGate` before transitioning — see admission-route-service-db.ts), so the button can
// never promise something the server would then refuse.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ADMISSION_TONE, WINDOW_TONE, stateLabel } from "./admission-status";
import { authFailureRedirect } from "./write-workflow";

const NOR_METHODS = [
  { value: "electronic_witnessed", label: "Electronic (witnessed)" },
  { value: "wet_ink_scanned", label: "Wet ink (scanned)" },
  { value: "verbal_with_witness", label: "Verbal (with witness)" },
] as const;
type NorMethod = (typeof NOR_METHODS)[number]["value"];

interface SummaryRow {
  id: string;
  state: string;
  version: number;
}
interface AdmissionDetailView extends SummaryRow {
  patientId?: string;
  referralId?: string | null;
  admissionAt?: string | null;
  activatedAt?: string | null;
  activationGate: { ready: boolean; missing: string[] };
  readiness?: AdmissionReadiness;
}
interface ReadinessRequirement {
  code: string;
  label: string;
  status:
    | "complete"
    | "action_required"
    | "awaiting_signature"
    | "pending"
    | "blocked"
    | "overdue"
    | "not_applicable";
  blocking: boolean;
  message?: string;
  action?: string;
  satisfiedBy?: "normal" | "override";
}
interface AdmissionReadiness {
  admissionId: string;
  status: "blocked" | "action_required" | "ready";
  canActivate: boolean;
  completed: number;
  blockingRemaining: number;
  requirements: ReadinessRequirement[];
}
interface HopeSummary {
  admissionAssessment: { status: string; attention?: { state: string; severity: string } };
  huv1: { status: string; attention?: { state: string; severity: string } };
  huv2: { status: string; attention?: { state: string; severity: string } };
  dischargeAssessment: { status: string; attention?: { state: string; severity: string } };
  sfvs: Array<{ status: string; attention?: { state: string; severity: string } }>;
  summary: {
    actionableCount: number;
    overdueCount?: number;
    dueSoonCount?: number;
    workflowIssueCount?: number;
    highestSeverity?: string;
    nextDeadline: string | null;
  };
}

// §5.2.5 — the four activation preconditions, in checklist order; the server's `missing[]` codes drive
// which rows pulse red. Kept verbatim from computeActivationGate so the UI renders server truth.
const GATE_ROWS: { code: string; label: string }[] = [
  { code: "election_signed", label: "Election statement signed (period 1)" },
  { code: "nor_acknowledged", label: "Notice of Rights acknowledged" },
  { code: "cti_signed", label: "CTI signed by hospice medical director" },
  { code: "attending_signed", label: "CTI signed by attending physician (period 1)" },
];

export function AdmissionDetail(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [admission, setAdmission] = useState<AdmissionDetailView | null>(null);
  const [readiness, setReadiness] = useState<AdmissionReadiness | null>(null);
  const [periods, setPeriods] = useState<SummaryRow[]>([]);
  const [windows, setWindows] = useState<SummaryRow[]>([]);
  const [hope, setHope] = useState<HopeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ceremony, setCeremony] = useState<"activate" | "nor" | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [formVersionId, setFormVersionId] = useState("");
  const [deliveryMethod, setDeliveryMethod] = useState<NorMethod>("electronic_witnessed");
  const [acknowledgedByName, setAcknowledgedByName] = useState("");
  const [acknowledgedByRole, setAcknowledgedByRole] = useState<"patient" | "legal_representative">(
    "patient",
  );

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/admissions/{id}", {
      params: { path: { id } },
    });
    if (err || !data) {
      setError("Admission not found or not visible to you.");
      setLoading(false);
      return;
    }
    setAdmission(data as AdmissionDetailView);
    const [p, w, r, h] = await Promise.all([
      client.GET("/api/v1/admissions/{id}/election-periods", { params: { path: { id } } }),
      client.GET("/api/v1/admissions/{id}/compliance-windows", { params: { path: { id } } }),
      client.GET("/api/v1/admissions/{id}/readiness", { params: { path: { id } } }),
      client.GET("/api/v1/admissions/{admissionId}/hope", {
        params: { path: { admissionId: id } },
      }),
    ]);
    setPeriods(p.data?.items ?? []);
    setWindows(w.data?.items ?? []);
    setReadiness(r.data ?? (data as AdmissionDetailView).readiness ?? null);
    setHope(h.data ? (h.data as HopeSummary) : null);
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeCeremony = useCallback(() => {
    setCeremony(null);
    setActionError(null);
    setFormVersionId("");
    setAcknowledgedByName("");
  }, []);

  const branchError = useCallback(
    (status: number | undefined, code: string | undefined, fallback: string) => {
      const redirect = authFailureRedirect(status, code, window.location.pathname);
      if (redirect) {
        navigate(redirect);
        return true;
      }
      setBusy(false);
      if (status === 412) {
        setActionError("Admission requirements changed. Review the blockers and try again.");
        void load();
      } else if (status === 403) setActionError("You do not have permission for this action.");
      else if (status === 422) setActionError("Validation failed — check the values you entered.");
      else setActionError(fallback);
      return false;
    },
    [load, navigate],
  );

  const activate = useCallback(async () => {
    if (!id || !admission) return;
    setBusy(true);
    setActionError(null);
    const { error: err, response } = await client.POST("/api/v1/admissions/{id}/activate", {
      params: { path: { id } },
      body: { ifVersion: admission.version },
    });
    if (err) {
      branchError(response?.status, err?.error?.code, "Activation failed.");
      return;
    }
    setBusy(false);
    closeCeremony();
    void load();
  }, [id, admission, client, branchError, closeCeremony, load]);

  const acknowledgeNor = useCallback(async () => {
    if (!id) return;
    if (formVersionId.trim().length === 0 || acknowledgedByName.trim().length === 0) {
      setActionError("Provide the NOR form version id and the acknowledging person's name.");
      return;
    }
    setBusy(true);
    setActionError(null);
    const { error: err, response } = await client.POST("/api/v1/admissions/{id}/nor", {
      params: { path: { id } },
      body: {
        formVersionId: formVersionId.trim(),
        deliveryMethod,
        acknowledgedAt: new Date().toISOString(),
        acknowledgedByName: acknowledgedByName.trim(),
        acknowledgedByRole,
      },
    });
    if (err) {
      branchError(response?.status, err?.error?.code, "Could not record the acknowledgment.");
      return;
    }
    setBusy(false);
    closeCeremony();
    void load();
  }, [
    id,
    formVersionId,
    deliveryMethod,
    acknowledgedByName,
    acknowledgedByRole,
    client,
    branchError,
    closeCeremony,
    load,
  ]);

  if (loading) return <LoadingSpinner />;
  if (error || !admission)
    return <EmptyState title="Unavailable" description={error ?? "Not found."} />;

  const pendingWorkspace =
    admission.state === "pending" || admission.state === "notice_of_rights_acknowledged";
  const canAcknowledgeNor =
    pendingWorkspace &&
    !readiness?.requirements.some((r) => r.code === "notice_of_rights" && r.status === "complete");
  const canActivate =
    pendingWorkspace && (readiness?.canActivate ?? admission.activationGate.ready);

  if (pendingWorkspace) {
    return (
      <DetailPageLayout
        header={
          <PageHeader
            title="Admission Intake"
            breadcrumb="Admissions / Intake"
            actions={
              <div
                style={{ display: "flex", alignItems: "center", gap: "0.625rem", flexWrap: "wrap" }}
              >
                <StatusPill
                  label={stateLabel(admission.state)}
                  tone={ADMISSION_TONE[admission.state] ?? "neutral"}
                />
                <button
                  type="button"
                  onClick={() => setCeremony("activate")}
                  style={canActivate ? primaryBtn : disabledBtn}
                  disabled={!canActivate}
                >
                  Activate Admission
                </button>
              </div>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Patient <span className="wx-data-md">{admission.patientId ?? "unresolved"}</span>
              {admission.referralId ? (
                <>
                  {" "}
                  · Referral <span className="wx-data-md">{admission.referralId}</span>
                </>
              ) : null}
            </div>
          </PageHeader>
        }
        aside={
          <RightDetailPanel title="Admission readiness">
            {readiness ? (
              <ReadinessChecklist readiness={readiness} />
            ) : (
              <ActivationChecklist gate={admission.activationGate} />
            )}
          </RightDetailPanel>
        }
      >
        <div style={contentShellStyle}>
          <section style={summaryCardStyle}>
            <div style={summaryHeaderStyle}>
              <div>
                <h2 style={sectionTitleStyle}>Admission readiness</h2>
                <div style={summaryMetaStyle}>
                  {readiness
                    ? `${readiness.completed} of ${readiness.requirements.length} items complete`
                    : "Readiness is loading from the server."}
                </div>
              </div>
              <StatusPill
                label={readiness?.canActivate ? "Ready" : "Action required"}
                tone={readiness?.canActivate ? "success" : "warning"}
              />
            </div>
            {readiness && !readiness.canActivate ? (
              <div style={blockerBoxStyle}>
                <strong>Admission cannot be activated</strong>
                <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem" }}>
                  {readiness.requirements
                    .filter((r) => r.blocking && r.status !== "complete")
                    .map((r) => (
                      <li key={r.code}>{r.message ?? `${r.label} is incomplete.`}</li>
                    ))}
                </ul>
              </div>
            ) : readiness?.canActivate ? (
              <div style={readyBoxStyle}>
                <strong>Ready for Admission</strong>
                <span>All blocking admission requirements are complete.</span>
              </div>
            ) : null}
          </section>

          <nav aria-label="Intake sections" style={tabsStyle}>
            {[
              "Overview",
              "Admission Details",
              "Notice of Rights",
              "Election",
              "CTI",
              "Face-to-Face",
              "Documents",
              "Activity",
            ].map((tab) => (
              <a key={tab} href={`#${tab.toLowerCase().replaceAll(" ", "-")}`} style={tabStyle}>
                {tab}
              </a>
            ))}
          </nav>

          <Section title="Overview">
            <RequirementCards
              requirements={readiness?.requirements ?? []}
              onAction={(action) => {
                if (action === "ACKNOWLEDGE_NOR") setCeremony("nor");
              }}
            />
          </Section>
          <Section title="Admission Details">
            <div id="admission-details" style={fieldGridStyle}>
              <Field label="Admission ID" value={admission.id} mono />
              <Field label="Patient" value={admission.patientId ?? "Unresolved"} mono />
              <Field label="Referral" value={admission.referralId ?? "Direct admission"} mono />
              <Field label="Planned/SOC" value={fmtDate(admission.admissionAt)} />
            </div>
          </Section>
          <Section title="HOPE">
            <HopeEntry
              summary={hope}
              admissionId={admission.id}
              onOpen={() => navigate(`/admissions/${admission.id}/hope`)}
            />
          </Section>
          <Section title="Notice of Rights">
            <div id="notice-of-rights" style={sectionInnerStyle}>
              <RequirementLine
                requirement={readiness?.requirements.find((r) => r.code === "notice_of_rights")}
              />
              {canAcknowledgeNor ? (
                <button type="button" onClick={() => setCeremony("nor")} style={ghostBtn}>
                  Record acknowledgment
                </button>
              ) : null}
            </div>
          </Section>
          <Section title="Election">
            <RequirementLine
              requirement={readiness?.requirements.find((r) => r.code === "election_statement")}
            />
          </Section>
          <Section title="CTI">
            <RequirementLine requirement={readiness?.requirements.find((r) => r.code === "cti")} />
          </Section>
          <Section title="Face-to-Face">
            <RequirementLine requirement={readiness?.requirements.find((r) => r.code === "f2f")} />
          </Section>
          <Section title="Documents">
            <p id="documents" style={emptyTextStyle}>
              Admission-linked documents will appear here when available through the document APIs.
            </p>
          </Section>
          <Section title="Activity">
            <RowList
              rows={windows}
              empty="No intake activity timeline is available yet."
              toneFor={WINDOW_TONE}
            />
          </Section>
        </div>
        {renderCeremonies()}
      </DetailPageLayout>
    );
  }

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Admission"
          breadcrumb="Admissions / Detail"
          actions={
            <div style={{ display: "flex", alignItems: "center", gap: "0.625rem" }}>
              <StatusPill
                label={stateLabel(admission.state)}
                tone={ADMISSION_TONE[admission.state] ?? "neutral"}
              />
              {canAcknowledgeNor ? (
                <button type="button" onClick={() => setCeremony("nor")} style={ghostBtn}>
                  Acknowledge NOR
                </button>
              ) : null}
              {canActivate ? (
                <button type="button" onClick={() => setCeremony("activate")} style={primaryBtn}>
                  Activate
                </button>
              ) : null}
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Admission <span className="wx-data-md">{admission.id}</span> · version{" "}
            <span className="tabular-nums">{admission.version}</span>
          </div>
        </PageHeader>
      }
      aside={
        <RightDetailPanel title="Activation gate">
          <ActivationChecklist gate={admission.activationGate} />
        </RightDetailPanel>
      }
    >
      <div style={contentShellStyle}>
        <section style={summaryCardStyle}>
          <div style={summaryHeaderStyle}>
            <div>
              <h2 style={sectionTitleStyle}>Admission state</h2>
              <div style={summaryMetaStyle}>
                Server-truth lifecycle state and activation readiness.
              </div>
            </div>
            <StatusPill
              label={stateLabel(admission.state)}
              tone={ADMISSION_TONE[admission.state] ?? "neutral"}
            />
          </div>
          <div style={fieldGridStyle}>
            <Field label="Admission ID" value={admission.id} mono />
            <Field label="Version" value={String(admission.version)} mono />
            <Field
              label="Activation"
              value={admission.activationGate.ready ? "Ready" : "Blocked"}
            />
          </div>
        </section>

        <Section title="Election periods">
          <RowList rows={periods} empty="No election periods yet." />
        </Section>
        <Section title="HOPE">
          <HopeEntry
            summary={hope}
            admissionId={admission.id}
            onOpen={() => navigate(`/admissions/${admission.id}/hope`)}
          />
        </Section>
        <Section title="Compliance windows">
          <RowList rows={windows} empty="No open compliance windows." toneFor={WINDOW_TONE} />
        </Section>
      </div>

      {renderCeremonies()}
    </DetailPageLayout>
  );

  function renderCeremonies(): JSX.Element {
    return (
      <>
        <CeremonyModal
          open={ceremony === "nor"}
          title="Acknowledge Notice of Rights"
          attestation={
            <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              <span style={{ fontSize: "0.8125rem", color: "var(--color-on-surface-variant)" }}>
                Records that the patient (or their legal representative) received and acknowledged
                the Notice of Rights. Required before the admission can activate.
              </span>
              <label htmlFor="nor-form-version" style={fieldLabel}>
                NOR form version id
              </label>
              <input
                id="nor-form-version"
                value={formVersionId}
                onChange={(ev) => setFormVersionId(ev.target.value)}
                style={inputStyle}
              />
              <label htmlFor="nor-method" style={fieldLabel}>
                Delivery method
              </label>
              <select
                id="nor-method"
                value={deliveryMethod}
                onChange={(ev) => setDeliveryMethod(ev.target.value as NorMethod)}
              >
                {NOR_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <label htmlFor="nor-name" style={fieldLabel}>
                Acknowledged by (name)
              </label>
              <input
                id="nor-name"
                value={acknowledgedByName}
                onChange={(ev) => setAcknowledgedByName(ev.target.value)}
                style={inputStyle}
              />
              <label htmlFor="nor-role" style={fieldLabel}>
                Acknowledged by (role)
              </label>
              <select
                id="nor-role"
                value={acknowledgedByRole}
                onChange={(ev) =>
                  setAcknowledgedByRole(ev.target.value as "patient" | "legal_representative")
                }
              >
                <option value="patient">Patient</option>
                <option value="legal_representative">Legal representative</option>
              </select>
              {actionError ? (
                <p role="alert" aria-live="assertive" style={alertStyle}>
                  {actionError}
                </p>
              ) : null}
            </div>
          }
          signer={{ name: "Recording clinician", role: "This session" }}
          commitLabel={busy ? "Recording…" : "Record acknowledgment"}
          onCommit={() => void acknowledgeNor()}
          onCancel={closeCeremony}
        />

        <CeremonyModal
          open={ceremony === "activate"}
          title="Activate admission"
          attestation={
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <span style={{ fontSize: "0.8125rem", color: "var(--color-on-surface-variant)" }}>
                All four R-AC-01 preconditions are satisfied — activating opens active-period
                billing and compliance tracking for this admission.
              </span>
              {actionError ? (
                <p role="alert" aria-live="assertive" style={alertStyle}>
                  {actionError}
                </p>
              ) : null}
            </div>
          }
          legalText="I attest the admission is ready for activation."
          signer={{ name: "Activating clinician", role: "This session" }}
          commitLabel={busy ? "Activating…" : "Activate"}
          onCommit={() => void activate()}
          onCancel={closeCeremony}
        />
      </>
    );
  }
}

function HopeEntry({
  summary,
  admissionId,
  onOpen,
}: {
  summary: HopeSummary | null;
  admissionId: string;
  onOpen: () => void;
}): JSX.Element {
  if (!summary) {
    return (
      <div style={hopeEntryStyle}>
        <div>
          <h3 style={miniTitleStyle}>HOPE workflow</h3>
          <p style={emptyTextStyle}>
            HOPE summary is unavailable or not visible for admission {admissionId}.
          </p>
        </div>
        <button type="button" onClick={onOpen} style={ghostBtn}>
          Open HOPE
        </button>
      </div>
    );
  }
  const openSfvs = summary.sfvs.filter((s) => s.status === "open" || s.status === "overdue").length;
  const workflowIssueCount = summary.summary.workflowIssueCount ?? 0;
  const overdueCount = summary.summary.overdueCount ?? 0;
  const dueSoonCount = summary.summary.dueSoonCount ?? 0;
  return (
    <div style={hopeEntryStyle}>
      <div style={hopeMiniGrid}>
        <HopeMini
          label="HOPE Admission Assessment"
          status={summary.admissionAssessment.status}
          attention={summary.admissionAssessment.attention?.state}
        />
        <HopeMini
          label="HUV1"
          status={summary.huv1.status}
          attention={summary.huv1.attention?.state}
        />
        <HopeMini
          label="HUV2"
          status={summary.huv2.status}
          attention={summary.huv2.attention?.state}
        />
        <HopeMini
          label="SFV"
          status={openSfvs > 0 ? `${openSfvs} open` : "none open"}
          attention={
            summary.sfvs.find((s) => s.attention?.state && s.attention.state !== "none")?.attention
              ?.state
          }
        />
        <HopeMini
          label="Discharge Assessment"
          status={summary.dischargeAssessment.status}
          attention={summary.dischargeAssessment.attention?.state}
        />
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          alignItems: "flex-start",
        }}
      >
        <StatusPill
          label={compactHopeLabel(
            summary.summary.actionableCount,
            workflowIssueCount,
            overdueCount,
            dueSoonCount,
          )}
          tone={
            (summary.summary.highestSeverity ?? "none") === "critical" || workflowIssueCount > 0
              ? "error"
              : summary.summary.actionableCount > 0 || dueSoonCount > 0
                ? "warning"
                : "success"
          }
        />
        {overdueCount > 0 ? (
          <span style={summaryMetaStyle}>{overdueCount} overdue or missed</span>
        ) : null}
        <span style={summaryMetaStyle}>Next deadline {fmtDate(summary.summary.nextDeadline)}</span>
        <button type="button" onClick={onOpen} style={primaryBtn}>
          Open HOPE
        </button>
      </div>
    </div>
  );
}

function HopeMini({
  label,
  status,
  attention,
}: {
  label: string;
  status: string;
  attention?: string;
}): JSX.Element {
  const display = attention && attention !== "none" ? attention : status;
  const tone: StatusTone =
    display.includes("open") || display === "late" || display === "due" || display === "due_soon"
      ? "warning"
      : display === "completed"
        ? "success"
        : display === "expired" ||
            display === "workflow_not_initialized" ||
            display === "workflow_issue" ||
            display === "window_expired" ||
            display === "overdue" ||
            display === "missed"
          ? "error"
          : "neutral";
  return (
    <div style={hopeMiniStyle}>
      <span style={fieldLabelStyle}>{label}</span>
      <StatusPill label={displayHopeStatus(display)} tone={tone} />
    </div>
  );
}

function displayHopeStatus(status: string): string {
  if (status === "open") return "Action required";
  if (status === "late") return "Late completion";
  if (status === "due_soon") return "Due soon";
  if (status === "window_expired") return "Capture window expired";
  if (status === "workflow_issue") return "Workflow issue";
  if (status === "workflow_not_initialized") return "Workflow not initialized";
  if (status === "not_applicable") return "Not applicable";
  if (status === "none open") return "None open";
  return stateLabel(status);
}

function compactHopeLabel(
  actionable: number,
  workflowIssues: number,
  overdue: number,
  dueSoon: number,
): string {
  if (workflowIssues > 0)
    return `${workflowIssues} workflow issue${workflowIssues === 1 ? "" : "s"}`;
  if (overdue > 0) return `${overdue} overdue or missed`;
  if (dueSoon > 0) return `${dueSoon} due soon`;
  if (actionable > 0) return `${actionable} action required`;
  return "HOPE up to date";
}

const primaryBtn = {
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
} as const;
const disabledBtn: CSSProperties = {
  ...primaryBtn,
  opacity: 0.5,
  cursor: "not-allowed",
};
const ghostBtn: CSSProperties = {
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
};
const fieldLabel: CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
};
const inputStyle: CSSProperties = {
  padding: "0.5rem 0.625rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-outline-variant)",
};
const alertStyle: CSSProperties = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };

const contentShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};

const summaryCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  padding: "1rem 1.25rem",
  borderRadius: "var(--radius-lg)",
  background: "var(--color-surface-lowest)",
  boxShadow: "var(--shadow-soft)",
};

const summaryHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
};

const summaryMetaStyle: CSSProperties = {
  marginTop: "0.25rem",
  fontSize: "0.82rem",
  color: "var(--color-on-surface-variant)",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.95rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const fieldGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  gap: "0.75rem 1rem",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
};

const fieldLabelStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const fieldValueStyle: CSSProperties = {
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
};

const sectionCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "1rem 1.25rem",
  borderRadius: "var(--radius-lg)",
  background: "var(--color-surface-lowest)",
  boxShadow: "var(--shadow-soft)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
};

const tdStyle: CSSProperties = {
  padding: "0.55rem 0.75rem",
  color: "var(--color-on-surface)",
};

const rowStyle: CSSProperties = {
  borderTop: "1px solid var(--color-surface-container)",
};

const emptyTextStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.85rem",
  color: "var(--color-on-surface-variant)",
};

const tabsStyle: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  flexWrap: "wrap",
};

const tabStyle: CSSProperties = {
  minHeight: "2rem",
  padding: "0.45rem 0.7rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  textDecoration: "none",
  fontSize: "0.8rem",
  fontWeight: 600,
};

const blockerBoxStyle: CSSProperties = {
  border: "1px solid var(--color-error)",
  borderRadius: "var(--radius-md)",
  padding: "0.85rem",
  color: "var(--color-on-surface)",
  background: "var(--color-error-container)",
};

const readyBoxStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-md)",
  padding: "0.85rem",
  background: "var(--color-surface-container)",
};

const sectionInnerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
};

const hopeEntryStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: "1rem",
  alignItems: "start",
};
const hopeMiniGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))",
  gap: "0.75rem",
};
const hopeMiniStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};
const miniTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--color-on-surface)",
  fontSize: "0.95rem",
  fontWeight: 700,
};

const requirementGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
  gap: "0.75rem",
};

const requirementCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.55rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-md)",
  padding: "0.85rem",
};

const requirementHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
};

const requirementMessageStyle: CSSProperties = {
  margin: 0,
  color: "var(--color-on-surface-variant)",
  fontSize: "0.82rem",
};

const actionHintStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.78rem",
  fontWeight: 600,
};

const requirementLineStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.65rem",
  flexWrap: "wrap",
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
};

// §5.2.5 activation gate as a Guardrail treatment: a blocked GuardChip summary (or a success pill when
// ready) over a GateStepper whose rows render server-truth — each unmet precondition is `blocked`
// (alert glyph, error tint, surfaced first), each met one `complete` (check, struck through).
function ActivationChecklist({
  gate,
}: { gate: AdmissionDetailView["activationGate"] }): JSX.Element {
  const items: GateItem[] = GATE_ROWS.map((row) => ({
    id: row.code,
    label: row.label,
    status: gate.missing.includes(row.code) ? "blocked" : "complete",
  }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {gate.ready ? (
        <StatusPill tone="success" label="Ready to activate" />
      ) : (
        <GuardChip
          tone="error"
          reason={`${gate.missing.length} precondition${gate.missing.length === 1 ? "" : "s"} block activation`}
        />
      )}
      <GateStepper items={items} ariaLabel="Activation preconditions" />
    </div>
  );
}

function ReadinessChecklist({ readiness }: { readiness: AdmissionReadiness }): JSX.Element {
  const items: GateItem[] = readiness.requirements.map((r) => ({
    id: r.code,
    label: r.label,
    status:
      r.status === "complete" || r.status === "not_applicable"
        ? "complete"
        : r.status === "pending" || r.status === "awaiting_signature"
          ? "in-progress"
          : "blocked",
  }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <StatusPill
        tone={
          readiness.canActivate ? "success" : readiness.status === "blocked" ? "error" : "warning"
        }
        label={
          readiness.canActivate ? "Ready to activate" : `${readiness.blockingRemaining} blockers`
        }
      />
      <GateStepper items={items} ariaLabel="Admission readiness requirements" />
    </div>
  );
}

function RequirementCards({
  requirements,
  onAction,
}: {
  requirements: ReadinessRequirement[];
  onAction: (action: string) => void;
}): JSX.Element {
  if (requirements.length === 0) return <p style={emptyTextStyle}>Readiness is loading.</p>;
  return (
    <div style={requirementGridStyle}>
      {requirements.map((r) => (
        <div key={r.code} style={requirementCardStyle}>
          <div style={requirementHeaderStyle}>
            <strong>{r.label}</strong>
            <StatusPill label={stateLabel(r.status)} tone={requirementTone(r.status)} />
          </div>
          <p style={requirementMessageStyle}>
            {r.message ?? (r.status === "complete" ? "Complete" : "No action required.")}
          </p>
          {r.action === "ACKNOWLEDGE_NOR" ? (
            <button type="button" style={ghostBtn} onClick={() => onAction(r.action!)}>
              Record acknowledgment
            </button>
          ) : r.action ? (
            <span style={actionHintStyle}>{stateLabel(r.action)}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function RequirementLine({
  requirement,
}: {
  requirement: ReadinessRequirement | undefined;
}): JSX.Element {
  if (!requirement) return <p style={emptyTextStyle}>No readiness data available.</p>;
  return (
    <div style={requirementLineStyle}>
      <StatusPill
        label={stateLabel(requirement.status)}
        tone={requirementTone(requirement.status)}
      />
      <span>{requirement.message ?? requirement.label}</span>
    </div>
  );
}

function requirementTone(status: ReadinessRequirement["status"]): StatusTone {
  if (status === "complete" || status === "not_applicable") return "success";
  if (status === "pending" || status === "awaiting_signature") return "progress";
  if (status === "blocked" || status === "overdue") return "error";
  return "warning";
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function Field({
  label,
  value,
  mono,
}: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div style={fieldStyle}>
      <span style={fieldLabelStyle}>{label}</span>
      <span className={mono ? "wx-data-md" : undefined} style={fieldValueStyle}>
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <section style={sectionCardStyle}>
      <h3 style={sectionTitleStyle}>{title}</h3>
      {children}
    </section>
  );
}

function RowList({
  rows,
  empty,
  toneFor,
}: {
  rows: SummaryRow[];
  empty: string;
  toneFor?: Record<string, StatusTone>;
}): JSX.Element {
  if (rows.length === 0) return <p style={emptyTextStyle}>{empty}</p>;
  return (
    <table style={tableStyle}>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={rowStyle}>
            <td className="wx-data-md" style={tdStyle}>
              {r.id}
            </td>
            <td style={tdStyle}>
              <StatusPill label={stateLabel(r.state)} tone={toneFor?.[r.state] ?? "neutral"} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
