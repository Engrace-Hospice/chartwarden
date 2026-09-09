import {
  EmptyState,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  ageYears,
  t,
  useApiClient,
} from "@wardenx/ui";
// Phase 4 Admission HOPE workspace. The backend owns CMS spec, applicability, validation, SFV,
// readiness, and signing; this screen renders that state and sends canonical set/clear answer patches.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ASSESSMENT_TONE, rfaLabel, stateLabel } from "./hope-status";

type AnswerValue = string | number | boolean;
type AnswerSource =
  | "user"
  | "patient_prefill"
  | "admission_prefill"
  | "derived"
  | "imported"
  | "correction_copy";
type Applicability = "applicable" | "not_applicable" | "pending";
type ItemState = "unanswered" | "answered" | "skipped";
type SectionId = "A" | "F" | "I" | "J" | "M" | "N" | "Review";
type HopeApiResult<T = unknown> = Promise<{
  data?: T;
  error?: unknown;
  response?: Response;
}>;
interface HopeApiCompat {
  GET(path: string, init?: unknown): HopeApiResult;
  PATCH(path: string, init?: unknown): HopeApiResult;
  POST(path: string, init?: unknown): HopeApiResult;
}

interface AssessmentDetail {
  id: string;
  admissionId?: string;
  patientId: string;
  rfaKind: string;
  status: "draft" | "signed" | "superseded";
  targetDate: string;
  authorDiscipline: string;
  j2051MaxSeverity: string | null;
  j2051TriggerFired: boolean;
  wasLate: boolean;
  signedAt: string | null;
  signedBy: string | null;
  correctsAssessmentId: string | null;
  supersededByAssessmentId: string | null;
  snapshot: Record<string, number | null> | null;
  regulatory?: {
    specVersionId: string | null;
    isc: "HA" | "HUV" | "HD" | "XX" | null;
  };
  version: number;
}

interface WorkspaceItem {
  itemCode: string;
  label: string;
  section: string;
  group: string | null;
  kind: "assessment";
  cmsItemTypeCode?: string;
  maxLength?: number | null;
  active: boolean;
  state: ItemState;
  value: AnswerValue | null;
  source: AnswerSource | null;
  answeredAt: string | null;
  answeredByMembershipId: string | null;
  applicability: Applicability;
  skipReason: {
    ruleId: string;
    cmsRuleId?: string;
    dependsOn: string[];
  } | null;
  options: { valueCode: string; label: string; sortOrder: number }[];
}

interface WorkspaceSection {
  code: string;
  label: string;
  items: WorkspaceItem[];
}

interface Workspace {
  assessment: {
    id: string;
    status: AssessmentDetail["status"];
    rfaKind: string;
    targetDate: string;
    isc: "HA" | "HUV" | "HD" | "XX";
    specVersionId: string;
    specVersion: string;
    version: number;
  };
  sections: WorkspaceSection[];
  progress: {
    active: number;
    applicable: number;
    notApplicable: number;
    pending: number;
    answered: number;
    skipped: number;
    unanswered: number;
  };
  huv: {
    scheduleId: string | null;
    scheduleStatus: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    lateDeadline: string | null;
    timingState:
      | "upcoming"
      | "within_window"
      | "due_soon"
      | "late"
      | "completed"
      | "unknown";
    z0350: string | null;
  } | null;
}

interface ReviewModel {
  assessmentId: string;
  version: number;
  specVersion: string;
  isc: "HA" | "HUV" | "HD" | "XX";
  status: AssessmentDetail["status"];
  signedAt: string | null;
  signedByMembershipId: string | null;
  z0350: string | null;
  z0500b: string | null;
  sections: {
    code: string;
    active: number;
    applicable: number;
    answered: number;
    skipped: number;
    pending: number;
    unanswered: number;
    errors: number;
    warnings: number;
    state: "complete" | "needs_attention" | "blocked";
  }[];
  progress: {
    active: number;
    applicable: number;
    answered: number;
    skipped: number;
    pending: number;
    unanswered: number;
  };
  validation: {
    errorCount: number;
    warningCount: number;
    hasBlockingErrors: boolean;
    findings: {
      ruleId: string;
      severity: "error" | "warning";
      section: string;
      itemCode: string | null;
      message: string;
    }[];
  };
  sfv: {
    required: boolean | null;
    status?: string;
    dueAt?: string;
    completedAt?: string | null;
  };
  readiness: {
    readyToSign: boolean;
    blockers: {
      code: string;
      section?: string;
      itemCode?: string;
      ruleId?: string;
      message: string;
    }[];
  };
}

interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

interface TimepointRow {
  id: string;
  rfaKind: string;
  status: string;
  targetDate: string;
}

const SECTION_ORDER: { id: SectionId; label: string; helper: string }[] = [
  {
    id: "A",
    label: "Administrative",
    helper:
      "Confirm chart-prefilled identity, admission, payer, language, and residence details.",
  },
  {
    id: "F",
    label: "Preferences & Goals",
    helper:
      "Document focused conversations about CPR, treatment, hospitalization, and spiritual concerns.",
  },
  {
    id: "I",
    label: "Diagnoses",
    helper:
      "Select the HOPE diagnosis category and condition indicators from the official item set.",
  },
  {
    id: "J",
    label: "Health Conditions",
    helper:
      "Work through current status, pain, breathing, symptom impact, and any SFV follow-up state.",
  },
  {
    id: "M",
    label: "Skin Conditions",
    helper: "Record skin screening results and related interventions.",
  },
  {
    id: "N",
    label: "Medications",
    helper: "Document scheduled opioid, PRN opioid, and bowel regimen items.",
  },
  {
    id: "Review",
    label: "Review",
    helper:
      "Check completion, blockers, warnings, SFV state, and signature readiness.",
  },
];

const PROTECTED_ITEMS = new Set([
  "A0050",
  "A0220",
  "A0250",
  "A0270",
  "J2052A",
  "J2052B",
  "J2052C",
  "J2053A",
  "J2053B",
  "J2053C",
  "J2053D",
  "J2053E",
  "J2053F",
  "J2053G",
  "J2053H",
  "Z0350",
  "Z0500B",
]);

const SECTION_A_GROUPS: {
  label: string;
  match: (item: WorkspaceItem) => boolean;
}[] = [
  {
    label: "Provider Information",
    match: (i) => i.itemCode.startsWith("A0100"),
  },
  {
    label: "Admission Information",
    match: (i) =>
      ["A0205", "A0210", "A0215", "A0220", "A0250", "A0270"].some((p) =>
        i.itemCode.startsWith(p),
      ),
  },
  {
    label: "Patient Identity",
    match: (i) =>
      ["A0500", "A0600", "A0700", "A0800", "A0900"].some((p) =>
        i.itemCode.startsWith(p),
      ),
  },
  {
    label: "Demographics",
    match: (i) =>
      ["A1005", "A1010", "A1110", "A1250"].some((p) =>
        i.itemCode.startsWith(p),
      ),
  },
  { label: "Payer / Coverage", match: (i) => i.itemCode.startsWith("A1400") },
  {
    label: "Living Situation",
    match: (i) =>
      ["A1805", "A1905", "A1910"].some((p) => i.itemCode.startsWith(p)),
  },
];

const F_GROUPS = [
  { label: "CPR", codes: ["F2000A", "F2000B"] },
  { label: "Other Life-Sustaining Treatments", codes: ["F2100A", "F2100B"] },
  { label: "Hospitalization", codes: ["F2200A", "F2200B"] },
  { label: "Spiritual / Existential Concerns", codes: ["F3000A", "F3000B"] },
];

const J_GROUPS = [
  "Current status",
  "Pain",
  "Shortness of breath",
  "Symptom impact",
  "Symptom Follow-Up Visit",
];

const payerGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: "0.65rem",
};

const payerChoice: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr) auto",
  alignItems: "center",
  gap: "0.65rem",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 8,
  padding: "0.75rem",
  background: t.surface,
  cursor: "pointer",
};

const payerChoiceSelected: CSSProperties = {
  border: `1px solid ${t.primary}`,
  background: "#eef6ff",
};

const payerSource: CSSProperties = {
  display: "block",
  marginTop: 2,
  color: t.muted,
  fontSize: "0.75rem",
};

const controlledValue: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "0.75rem",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 8,
  padding: "0.65rem 0.75rem",
  background: t.surface,
  color: t.onSurface,
};

export function HopeAssessmentDetail(): JSX.Element {
  const client = useApiClient();
  const api = useMemo(() => client as unknown as HopeApiCompat, [client]);
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [assessment, setAssessment] = useState<AssessmentDetail | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [review, setReview] = useState<ReviewModel | null>(null);
  const [timeline, setTimeline] = useState<TimepointRow[]>([]);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>("A");
  const [sfvOpen, setSfvOpen] = useState(false);
  const [saving, setSaving] = useState<
    "idle" | "saving" | "saved" | "failed" | "conflict"
  >("idle");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signOpen, setSignOpen] = useState(false);
  const [inactivationOpen, setInactivationOpen] = useState(false);
  const [inactivating, setInactivating] = useState(false);
  const latestVersionRef = useRef<number | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [pendingItemFocus, setPendingItemFocus] = useState<string | null>(null);

  useEffect(() => {
    if (workspace) latestVersionRef.current = workspace.assessment.version;
  }, [workspace]);

  useEffect(() => {
    if (!pendingItemFocus) {
      return;
    }

    const timeout = window.setTimeout(() => {
      const element = document.getElementById(`hope-item-${pendingItemFocus}`);

      if (!element) {
        return;
      }

      element.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });

      if (element instanceof HTMLElement) {
        element.focus({
          preventScroll: true,
        });
      }

      setPendingItemFocus(null);
    }, 50);

    return () => window.clearTimeout(timeout);
  }, [activeSection, pendingItemFocus]);
  const [signing, setSigning] = useState(false);
  const [completionDateSaving, setCompletionDateSaving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const [a, w, r] = await Promise.all([
      api.GET("/api/v1/hope/assessments/{id}", { params: { path: { id } } }),
      api.GET("/api/v1/hope/assessments/{id}/workspace", {
        params: { path: { id } },
      }),
      api.GET("/api/v1/hope/assessments/{id}/review", {
        params: { path: { id } },
      }),
    ]);
    if (a.error || !a.data) {
      setError("Could not load this HOPE assessment.");
      setLoading(false);
      return;
    }
    const nextAssessment = a.data as unknown as AssessmentDetail;
    setAssessment(nextAssessment);
    setWorkspace(w.error || !w.data ? null : (w.data as unknown as Workspace));
    setReview(r.error || !r.data ? null : (r.data as unknown as ReviewModel));
    const [tl, pat] = await Promise.all([
      api.GET("/api/v1/patients/{patientId}/hope/assessments", {
        params: { path: { patientId: nextAssessment.patientId } },
      }),
      api.GET("/api/v1/patients/{id}", {
        params: { path: { id: nextAssessment.patientId } },
      }),
    ]);
    setTimeline(
      (tl.data as { assessments?: TimepointRow[] } | undefined)?.assessments ??
        [],
    );
    if (pat.data) setPatient(pat.data as unknown as PatientSummary);
    setLoading(false);
  }, [api, id]);

  const goToIssue = useCallback(
    (section: SectionId, itemCode?: string | null) => {
      setActiveSection(section);

      if (itemCode) {
        setPendingItemFocus(itemCode);
      }
    },
    [],
  );

  const refreshWorkspaceOnly = useCallback(async () => {
    if (!id) return;
    const [w, r, a] = await Promise.all([
      api.GET("/api/v1/hope/assessments/{id}/workspace", {
        params: { path: { id } },
      }),
      api.GET("/api/v1/hope/assessments/{id}/review", {
        params: { path: { id } },
      }),
      api.GET("/api/v1/hope/assessments/{id}", { params: { path: { id } } }),
    ]);
    if (w.data) setWorkspace(w.data as unknown as Workspace);
    if (r.data) setReview(r.data as unknown as ReviewModel);
    if (a.data) setAssessment(a.data as unknown as AssessmentDetail);
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!workspace) return;
    const visible = visibleSectionOrder(workspace);
    if (!visible.some((section) => section.id === activeSection)) {
      setActiveSection(visible[0]?.id ?? "Review");
    }
  }, [activeSection, workspace]);

  const findingsByItem = useMemo(() => {
    const map = new Map<string, ReviewModel["validation"]["findings"]>();
    for (const finding of review?.validation.findings ?? []) {
      if (!finding.itemCode) continue;
      map.set(finding.itemCode, [
        ...(map.get(finding.itemCode) ?? []),
        finding,
      ]);
    }
    return map;
  }, [review]);

  const saveAnswer = useCallback(
    async (item: WorkspaceItem, value: AnswerValue | null) => {
      if (
        !id ||
        !workspace ||
        assessment?.status !== "draft" ||
        PROTECTED_ITEMS.has(item.itemCode)
      )
        return;
      const run = async () => {
        setSaving("saving");
        setFieldErrors((prev) => {
          const { [item.itemCode]: _old, ...rest } = prev;
          return rest;
        });
        const change =
          value === null || value === "" || value === "^"
            ? { itemCode: item.itemCode, action: "clear" as const }
            : { itemCode: item.itemCode, action: "set" as const, value };
        const res = await api.PATCH("/api/v1/hope/assessments/{id}/answers", {
          params: { path: { id } },
          body: {
            ifVersion: latestVersionRef.current ?? workspace.assessment.version,
            changes: [change],
          },
        });
        if (res.error || !res.data) {
          const message = String(
            (res.error as { message?: unknown })?.message ?? "",
          );
          const conflict = /version|conflict|stale/i.test(message);
          setSaving(conflict ? "conflict" : "failed");
          setFieldErrors((prev) => ({
            ...prev,
            [item.itemCode]: conflict
              ? "This assessment changed elsewhere. Reload the latest version before continuing."
              : "This answer was not saved. Check the value and try again.",
          }));
          return;
        }
        latestVersionRef.current =
          (res.data as { version?: number }).version ??
          latestVersionRef.current;
        setSaving("saved");
        await refreshWorkspaceOnly();
      };
      const next = saveQueueRef.current.then(run, run);
      saveQueueRef.current = next.catch(() => undefined);
      await next;
    },
    [api, assessment?.status, id, refreshWorkspaceOnly, workspace],
  );

  const sign = useCallback(async () => {
    if (!id || !workspace) return;
    setSigning(true);
    const res = await api.POST("/api/v1/hope/assessments/{id}/sign", {
      params: { path: { id } },
      body: { ifVersion: workspace.assessment.version },
    });
    setSigning(false);
    if (res.error) {
      setSignOpen(false);
      await refreshWorkspaceOnly();
      setActiveSection("Review");
      return;
    }
    setSignOpen(false);
    await load();
    setActiveSection("Review");
  }, [api, id, load, refreshWorkspaceOnly, workspace]);

  const setHuvCompletionDate = useCallback(
    async (z0350: string) => {
      if (!id || !workspace || assessment?.status !== "draft") return;
      setCompletionDateSaving(true);
      const res = await api.PATCH(
        "/api/v1/hope/assessments/{id}/huv/completion-date",
        {
          params: { path: { id } },
          body: { ifVersion: workspace.assessment.version, z0350 },
        },
      );
      setCompletionDateSaving(false);
      if (res.error) {
        setSaving("failed");
        return;
      }
      setSaving("saved");
      await refreshWorkspaceOnly();
    },
    [api, assessment?.status, id, refreshWorkspaceOnly, workspace],
  );

  const createCorrection = useCallback(async () => {
    if (!id || !assessment) return;
    const reason = window.prompt(
      "Briefly describe why this completed HOPE record needs a correction.",
    );
    if (!reason?.trim()) return;
    const res = await api.POST("/api/v1/hope/assessments/{id}/correct", {
      params: { path: { id } },
      body: {
        correctionReason: reason.trim(),
        ifVersion: assessment.version,
        targetDate: assessment.targetDate,
        authorDiscipline: disciplineForCorrection(assessment.authorDiscipline),
        data: {},
      },
    });
    const correctionId = (res.data as { id?: string } | undefined)?.id;
    if (correctionId) navigate(`/hope/assessments/${correctionId}`);
  }, [api, assessment, id, navigate]);

  const createInactivation = useCallback(
    async (reason: string) => {
      if (!id || !assessment) return;
      setInactivating(true);
      const res = await api.POST(
        "/api/v1/hope/assessments/{id}/inactivations",
        {
          params: { path: { id } },
          body: { reason: reason.trim(), ifVersion: assessment.version },
        },
      );
      setInactivating(false);
      if (res.error || !res.data) {
        setSaving("failed");
        return;
      }
      setInactivationOpen(false);
      const inactivationId = (res.data as { id?: string } | undefined)?.id;
      if (inactivationId) navigate(`/hope/assessments/${inactivationId}`);
    },
    [api, assessment, id, navigate],
  );

  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading || !assessment)
    return <LoadingSpinner label="Loading HOPE workspace..." />;
  const workspaceRfa =
    assessment.rfaKind === "01_admission" ||
    assessment.rfaKind === "02_huv1" ||
    assessment.rfaKind === "03_huv2" ||
    assessment.rfaKind === "05_discharge";
  if (!workspaceRfa) {
    return (
      <LegacyTimepointView
        assessment={assessment}
        patient={patient}
        timeline={timeline}
        onSign={() => setSignOpen(true)}
      />
    );
  }
  if (!workspace)
    return (
      <EmptyState
        title="Workspace unavailable"
        description="The CMS item workspace could not be loaded for this assessment."
      />
    );

  const completed = assessment.status === "signed";
  const sections = sectionsFromWorkspace(workspace);
  const visibleSections = visibleSectionOrder(workspace);
  const current =
    activeSection === "Review" ? null : (sections.get(activeSection) ?? null);
  const status = derivedStatus(assessment, review, workspace);
  const recordLabel = rfaLabel(assessment.rfaKind);
  const canInactivate =
    completed &&
    !assessment.supersededByAssessmentId &&
    workspace.assessment.isc !== "XX";
  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${formatDate(patient.dob)}${ageYears(patient.dob) != null ? ` · ${ageYears(patient.dob)}y` : ""} · Target ${formatDate(assessment.targetDate)}`}
      chips={
        <>
          <MonoChip>{maskIdentifier(patient.mrn)}</MonoChip>
          <StatusPill
            label={stateLabel(patient.status)}
            tone={ASSESSMENT_TONE[patient.status] ?? "neutral"}
          />
        </>
      }
    />
  ) : (
    <PatientBanner
      name={recordLabel}
      meta={`Target ${formatDate(assessment.targetDate)}`}
    />
  );

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={shell}>
        <header style={topBar}>
          <div>
            <div style={eyebrow}>Admission HOPE</div>
            <h1 style={title}>
              {completed
                ? `Completed ${recordLabel}`
                : `${recordLabel} Workspace`}
            </h1>
            <div style={metaLine}>
              <span>CMS {workspace.assessment.specVersion}</span>
              <span>ISC {workspace.assessment.isc}</span>
              <span>Target {formatDate(assessment.targetDate)}</span>
              {assessment.correctsAssessmentId ? (
                <span>
                  {workspace.assessment.isc === "XX"
                    ? "Inactivation draft"
                    : "Correction draft"}
                </span>
              ) : null}
            </div>
          </div>
          <div style={topActions}>
            <StatusPill label={status.label} tone={status.tone} />
            <SaveState state={saving} />
            <button
              type="button"
              style={secondaryButton}
              onClick={() => setActiveSection("Review")}
            >
              Review
            </button>
            {completed ? (
              <>
                <button
                  type="button"
                  style={secondaryButton}
                  onClick={() => setInactivationOpen(true)}
                  disabled={!canInactivate}
                >
                  Inactivate
                </button>
                <button
                  type="button"
                  style={primaryButton}
                  onClick={() => void createCorrection()}
                >
                  Create correction
                </button>
              </>
            ) : review?.readiness.readyToSign ? (
              <button
                type="button"
                style={primaryButton}
                onClick={() => setSignOpen(true)}
              >
                Sign & complete
              </button>
            ) : (
              <button
                type="button"
                style={primaryButton}
                onClick={() => setActiveSection("Review")}
              >
                Review issues
              </button>
            )}
          </div>
        </header>

        {completed ? (
          <CompletedSummary assessment={assessment} review={review} />
        ) : null}
        {workspace.huv ? (
          <HuvTimingBanner workspace={workspace} review={review} />
        ) : null}
        {saving === "conflict" ? (
          <ConflictBanner onReload={() => void load()} />
        ) : null}

        <div className="wx-hope-admission-grid" style={workspaceGrid}>
          <aside
            className="wx-hope-admission-rail"
            style={rail}
            aria-label={`${recordLabel} sections`}
          >
            <select
              className="wx-hope-admission-section-select"
              aria-label="HOPE section"
              value={activeSection}
              onChange={(event) =>
                setActiveSection(event.target.value as SectionId)
              }
              style={mobileSectionSelect}
            >
              {visibleSections.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.label}
                </option>
              ))}
            </select>
            <nav className="wx-hope-admission-section-nav" style={sectionNav}>
              {visibleSections.map((section) => {
                const state = sectionState(section.id, review, workspace);
                const active = activeSection === section.id;
                return (
                  <button
                    key={section.id}
                    type="button"
                    style={{
                      ...sectionButton,
                      ...(active ? sectionButtonActive : null),
                    }}
                    onClick={() => setActiveSection(section.id)}
                    title={state.detail}
                  >
                    <span style={stateDot(state.kind)} aria-hidden="true" />
                    <span>
                      <strong>
                        {section.id === "Review"
                          ? "Review"
                          : `${section.id} ${section.label}`}
                      </strong>
                      <small style={sectionMeta}>{state.label}</small>
                    </span>
                  </button>
                );
              })}
            </nav>
          </aside>

          <main style={mainPanel}>
            {activeSection === "Review" ? (
              <ReviewPanel
                assessment={assessment}
                review={review}
                workspace={workspace}
                onGoTo={goToIssue}
                visibleSections={visibleSections}
                onSetCompletionDate={(value) =>
                  void setHuvCompletionDate(value)
                }
                completionDateSaving={completionDateSaving}
                onSign={() => setSignOpen(true)}
                onCorrection={() => void createCorrection()}
              />
            ) : current ? (
              <SectionPanel
                sectionId={activeSection}
                section={current}
                readonly={completed}
                findingsByItem={findingsByItem}
                fieldErrors={fieldErrors}
                onSave={saveAnswer}
                onCompleteSfv={() => setSfvOpen(true)}
              />
            ) : (
              <EmptyState
                title="No active section items"
                description="The imported CMS specification did not return active assessment items for this section."
              />
            )}
            <BottomNav
              active={activeSection}
              sections={visibleSections}
              onChange={setActiveSection}
            />
          </main>
        </div>
      </div>
      {signOpen ? (
        <SignDialog
          review={review}
          title={`Complete ${recordLabel}`}
          signing={signing}
          onCancel={() => setSignOpen(false)}
          onSign={() => void sign()}
        />
      ) : null}
      {inactivationOpen ? (
        <InactivationDialog
          busy={inactivating}
          recordLabel={recordLabel}
          onCancel={() => setInactivationOpen(false)}
          onSubmit={(reason) => void createInactivation(reason)}
        />
      ) : null}
      {sfvOpen ? (
        <CompleteSfvDialog
          assessment={assessment}
          api={api}
          onCancel={() => setSfvOpen(false)}
          onCompleted={async () => {
            setSfvOpen(false);

            await refreshWorkspaceOnly();
          }}
        />
      ) : null}
    </PatientWorkspaceLayout>
  );
}

function CompleteSfvDialog({
  assessment,
  api,
  onCancel,
  onCompleted,
}: {
  assessment: AssessmentDetail;
  api: HopeApiCompat;
  onCancel: () => void;
  onCompleted: () => Promise<void>;
}): JSX.Element {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  const [discipline, setDiscipline] = useState<"RN" | "NP">("RN");

  const [answers, setAnswers] = useState<Record<string, string>>({});

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const codes = [
    "J2053A",
    "J2053B",
    "J2053C",
    "J2053D",
    "J2053E",
    "J2053F",
    "J2053G",
    "J2053H",
  ];

  const completedCount = codes.filter((code) => Boolean(answers[code])).length;

  const canSubmit =
    Boolean(assessment.admissionId) &&
    date !== "" &&
    completedCount === codes.length;

  async function submit() {
    if (!assessment.admissionId || !canSubmit || saving) {
      return;
    }

    setSaving(true);
    setError(null);

    const res = await api.POST("/api/v1/admissions/{admissionId}/hope/sfv", {
      params: {
        path: {
          admissionId: assessment.admissionId,
        },
      },
      body: {
        triggeringAssessmentId: assessment.id,
        targetDate: `${date}T12:00:00.000Z`,
        authorDiscipline: discipline,
        data: {
          J: {
            J2053: answers,
          },
        },
      },
    });

    setSaving(false);

    if (res.error) {
      setError(
        "The SFV could not be completed. Review the information and try again.",
      );
      return;
    }

    await onCompleted();
  }

  return (
    <div
      style={sfvModalBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <dialog
        open
        style={sfvModal}
        aria-modal="true"
        aria-labelledby="sfv-dialog-title"
      >
        <header style={sfvModalHeader}>
          <div style={sfvModalHeaderText}>
            <div style={sfvModalEyebrow}>Symptom Follow-Up Visit</div>

            <h2 id="sfv-dialog-title" style={sfvModalTitle}>
              Complete SFV
            </h2>

            <p style={sfvModalDescription}>
              Record the visit details and complete the symptom impact
              reassessment.
            </p>
          </div>

          <button
            type="button"
            aria-label="Close"
            style={sfvCloseButton}
            disabled={saving}
            onClick={onCancel}
          >
            ×
          </button>
        </header>

        <div style={sfvModalBody}>
          <section style={sfvSection}>
            <div style={sfvSectionHeader}>
              <div>
                <h3 style={sfvSectionTitle}>Visit details</h3>

                <p style={sfvSectionDescription}>
                  Confirm when the SFV was completed and by which discipline.
                </p>
              </div>
            </div>

            <div style={sfvDetailsGrid}>
              <label style={sfvField}>
                <span style={sfvFieldLabel}>SFV date</span>

                <input
                  type="date"
                  value={date}
                  style={sfvInput}
                  disabled={saving}
                  onChange={(event) => setDate(event.target.value)}
                />
              </label>

              <label style={sfvField}>
                <span style={sfvFieldLabel}>Author discipline</span>

                <select
                  value={discipline}
                  style={sfvInput}
                  disabled={saving}
                  onChange={(event) =>
                    setDiscipline(event.target.value as "RN" | "NP")
                  }
                >
                  <option value="RN">Registered Nurse (RN)</option>

                  <option value="NP">Nurse Practitioner (NP)</option>
                </select>
              </label>
            </div>
          </section>

          <section style={sfvSection}>
            <div style={sfvSectionHeader}>
              <div>
                <h3 style={sfvSectionTitle}>Symptom impact reassessment</h3>

                <p style={sfvSectionDescription}>
                  Complete each required J2053 item based on the follow-up
                  visit.
                </p>
              </div>

              <span style={sfvProgressBadge}>
                {completedCount}/{codes.length} completed
              </span>
            </div>

            <div style={sfvProgressTrack}>
              <div
                style={{
                  ...sfvProgressValue,
                  width: `${(completedCount / codes.length) * 100}%`,
                }}
              />
            </div>

            <div style={sfvAnswersGrid}>
              {codes.map((code, index) => {
                const value = answers[code] ?? "";

                return (
                  <label
                    key={code}
                    style={{
                      ...sfvAnswerCard,
                      ...(value ? sfvAnswerCardComplete : null),
                    }}
                  >
                    <div style={sfvAnswerCardHeader}>
                      <span style={sfvAnswerNumber}>{index + 1}</span>

                      <div>
                        <strong style={sfvAnswerTitle}>{code}</strong>

                        <span style={sfvAnswerHint}>Symptom impact</span>
                      </div>
                    </div>

                    <select
                      value={value}
                      style={sfvInput}
                      disabled={saving}
                      onChange={(event) =>
                        setAnswers((previous) => ({
                          ...previous,
                          [code]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Select severity...</option>

                      <option value="0">None</option>

                      <option value="1">Mild</option>

                      <option value="2">Moderate</option>

                      <option value="3">Severe</option>
                    </select>
                  </label>
                );
              })}
            </div>
          </section>

          {error ? (
            <div style={sfvErrorBox} role="alert">
              <strong>Unable to complete SFV</strong>

              <span>{error}</span>
            </div>
          ) : null}
        </div>

        <footer style={sfvModalFooter}>
          <div style={sfvFooterStatus}>
            {completedCount === codes.length ? (
              <span style={sfvReadyText}>✓ Reassessment complete</span>
            ) : (
              <span style={sfvPendingText}>
                Complete all {codes.length - completedCount} remaining item
                {codes.length - completedCount === 1 ? "" : "s"}.
              </span>
            )}
          </div>

          <div style={sfvFooterActions}>
            <button
              type="button"
              style={secondaryButton}
              disabled={saving}
              onClick={onCancel}
            >
              Cancel
            </button>

            <button
              type="button"
              style={{
                ...primaryButton,
                ...(!canSubmit ? sfvDisabledButton : null),
              }}
              disabled={saving || !canSubmit}
              onClick={() => void submit()}
            >
              {saving ? "Completing..." : "Complete SFV"}
            </button>
          </div>
        </footer>
      </dialog>
    </div>
  );
}

function SectionPanel(props: {
  sectionId: Exclude<SectionId, "Review">;
  section: WorkspaceSection;
  readonly: boolean;
  findingsByItem: Map<string, ReviewModel["validation"]["findings"]>;
  fieldErrors: Record<string, string>;
  onSave: (item: WorkspaceItem, value: AnswerValue | null) => Promise<void>;
  onCompleteSfv?: () => void;
}): JSX.Element {
  const config = SECTION_ORDER.find((s) => s.id === props.sectionId)!;
  return (
    <section>
      <SectionHeader
        code={props.sectionId}
        title={config.label}
        helper={config.helper}
      />
      {props.sectionId === "A" ? (
        <GroupedItems groups={groupSectionA(props.section.items)} {...props} />
      ) : props.sectionId === "F" ? (
        <GroupedItems
          groups={groupByCodes(props.section.items, F_GROUPS)}
          conversational
          {...props}
        />
      ) : props.sectionId === "I" ? (
        <DiagnosisSection {...props} />
      ) : props.sectionId === "J" ? (
        <SectionJ {...props} />
      ) : props.sectionId === "M" ? (
        <GroupedItems
          groups={groupGeneric(props.section.items, [
            "Skin condition screening",
            "Conditions identified",
            "Treatments / interventions",
          ])}
          {...props}
        />
      ) : (
        <GroupedItems
          groups={groupGeneric(props.section.items, [
            "Scheduled opioid",
            "PRN opioid",
            "Bowel regimen",
          ])}
          {...props}
        />
      )}
    </section>
  );
}

function PayerCoverageGroup(props: {
  items: WorkspaceItem[];
  readonly: boolean;
  findingsByItem: Map<string, ReviewModel["validation"]["findings"]>;
  fieldErrors: Record<string, string>;
  onSave: (item: WorkspaceItem, value: AnswerValue | null) => Promise<void>;
}): JSX.Element {
  return (
    <div id="hope-item-A1400" tabIndex={-1} style={payerGrid}>
      {props.items.map((item) => {
        const selected = String(item.value ?? "") === "1";

        return (
          <label
            key={item.itemCode}
            style={{
              ...payerChoice,
              ...(selected ? payerChoiceSelected : null),
            }}
          >
            <input
              type="checkbox"
              checked={selected}
              disabled={props.readonly}
              onChange={(event) => {
                void props.onSave(
                  item,
                  event.currentTarget.checked ? "1" : "0",
                );
              }}
            />

            <span>
              <strong>{item.label}</strong>

              {item.source && item.source !== "user" ? (
                <small style={payerSource}>
                  {item.source === "patient_prefill"
                    ? "From patient coverage"
                    : item.source === "admission_prefill"
                      ? "From admission"
                      : "Prefilled"}
                </small>
              ) : null}
            </span>

            <span style={codePill}>{item.itemCode}</span>
          </label>
        );
      })}
    </div>
  );
}

function DemographicsGroup(props: {
  items: WorkspaceItem[];
  readonly: boolean;
  findingsByItem: Map<string, ReviewModel["validation"]["findings"]>;
  fieldErrors: Record<string, string>;
  onSave: (item: WorkspaceItem, value: AnswerValue | null) => Promise<void>;
}): JSX.Element {
  const ethnicity = props.items.filter((item) =>
    item.itemCode.startsWith("A1005"),
  );

  const race = props.items.filter((item) => item.itemCode.startsWith("A1010"));

  const other = props.items.filter(
    (item) =>
      !item.itemCode.startsWith("A1005") && !item.itemCode.startsWith("A1010"),
  );

  return (
    <div style={questionList}>
      {ethnicity.length > 0 ? (
        <section id="hope-item-A1005" tabIndex={-1} style={questionGroup}>
          <h4 style={groupTitle}>Ethnicity</h4>

          <div style={questionList}>
            {ethnicity.map((item) => (
              <QuestionRenderer
                key={item.itemCode}
                item={item}
                readonly={props.readonly}
                findings={props.findingsByItem.get(item.itemCode) ?? []}
                fieldError={props.fieldErrors[item.itemCode]}
                onSave={props.onSave}
              />
            ))}
          </div>
        </section>
      ) : null}

      {race.length > 0 ? (
        <section id="hope-item-A1010" tabIndex={-1} style={questionGroup}>
          <h4 style={groupTitle}>Race</h4>

          <div style={questionList}>
            {race.map((item) => (
              <QuestionRenderer
                key={item.itemCode}
                item={item}
                readonly={props.readonly}
                findings={props.findingsByItem.get(item.itemCode) ?? []}
                fieldError={props.fieldErrors[item.itemCode]}
                onSave={props.onSave}
              />
            ))}
          </div>
        </section>
      ) : null}

      {other.map((item) => (
        <QuestionRenderer
          key={item.itemCode}
          item={item}
          readonly={props.readonly}
          findings={props.findingsByItem.get(item.itemCode) ?? []}
          fieldError={props.fieldErrors[item.itemCode]}
          onSave={props.onSave}
        />
      ))}
    </div>
  );
}

function GroupedItems(props: {
  groups: {
    label: string;
    items: WorkspaceItem[];
  }[];
  readonly: boolean;
  findingsByItem: Map<string, ReviewModel["validation"]["findings"]>;
  fieldErrors: Record<string, string>;
  onSave: (item: WorkspaceItem, value: AnswerValue | null) => Promise<void>;
  conversational?: boolean;
}): JSX.Element {
  return (
    <div style={groupStack}>
      {props.groups.map((group) => (
        <section
          key={group.label}
          id={
            group.label === "Demographics"
              ? "hope-group-demographics"
              : group.label === "Payer / Coverage"
                ? "hope-item-A1400"
                : undefined
          }
          tabIndex={-1}
          style={questionGroup}
        >
          <h3 style={groupTitle}>{group.label}</h3>

          {group.label === "Payer / Coverage" ? (
            <PayerCoverageGroup
              items={group.items}
              readonly={props.readonly}
              findingsByItem={props.findingsByItem}
              fieldErrors={props.fieldErrors}
              onSave={props.onSave}
            />
          ) : group.label === "Demographics" ? (
            <DemographicsGroup
              items={group.items}
              readonly={props.readonly}
              findingsByItem={props.findingsByItem}
              fieldErrors={props.fieldErrors}
              onSave={props.onSave}
            />
          ) : (
            <div style={props.conversational ? cardGrid : questionList}>
              {group.items.map((item) => (
                <QuestionRenderer
                  key={item.itemCode}
                  item={item}
                  readonly={props.readonly}
                  findings={props.findingsByItem.get(item.itemCode) ?? []}
                  fieldError={props.fieldErrors[item.itemCode]}
                  onSave={props.onSave}
                />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function DiagnosisSection(
  props: Parameters<typeof SectionPanel>[0],
): JSX.Element {
  const principal = props.section.items.filter((i) => i.itemCode === "I0010");
  const others = props.section.items.filter((i) => i.itemCode !== "I0010");
  return (
    <div style={groupStack}>
      <section style={questionGroup}>
        <h3 style={groupTitle}>Principal Diagnosis Category</h3>
        <p style={muted}>
          Use the chart diagnosis as context only. The HOPE category remains a
          clinician-selected answer.
        </p>
        {principal.map((item) => (
          <QuestionRenderer
            key={item.itemCode}
            item={item}
            readonly={props.readonly}
            findings={props.findingsByItem.get(item.itemCode) ?? []}
            fieldError={props.fieldErrors[item.itemCode]}
            onSave={props.onSave}
          />
        ))}
      </section>
      <section style={questionGroup}>
        <h3 style={groupTitle}>Other Conditions</h3>
        <div style={twoColumn}>
          {others.map((item) => (
            <QuestionRenderer
              key={item.itemCode}
              item={item}
              readonly={props.readonly}
              findings={props.findingsByItem.get(item.itemCode) ?? []}
              fieldError={props.fieldErrors[item.itemCode]}
              onSave={props.onSave}
              compact
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function SfvWorkflowSection({
  items,
  readonly,
  onComplete,
}: {
  items: WorkspaceItem[];
  readonly: boolean;
  onComplete?: () => void;
}): JSX.Element {
  const j2052a = items.find((item) => item.itemCode === "J2052A");

  const completed = String(j2052a?.value ?? "") === "1";

  const required = j2052a?.applicability === "applicable";

  return (
    <section id="hope-item-J2052A" tabIndex={-1} style={questionGroup}>
      <h3 style={groupTitle}>Symptom Follow-Up Visit</h3>

      <div style={questionCard}>
        <div style={questionHead}>
          <div>
            <strong>
              {completed
                ? "SFV completed"
                : required
                  ? "SFV required"
                  : "SFV status"}
            </strong>

            <p style={muted}>
              {completed
                ? "The follow-up visit has been recorded by the SFV workflow."
                : required
                  ? "A moderate or severe symptom impact requires a follow-up visit."
                  : "The need for a follow-up visit is determined from the symptom impact assessment."}
            </p>
          </div>

          <StatusPill
            label={completed ? "Completed" : required ? "Required" : "Pending"}
            tone={completed ? "success" : required ? "warning" : "neutral"}
          />
        </div>

        {!readonly && required && !completed ? (
          <div style={actionRow}>
            <button type="button" style={primaryButton} onClick={onComplete}>
              Complete SFV
            </button>
          </div>
        ) : null}
      </div>

      {completed ? (
        <div
          style={{
            ...muted,
            marginTop: "0.75rem",
          }}
        >
          J2052 and J2053 are workflow-controlled and were populated from the
          completed SFV.
        </div>
      ) : null}
    </section>
  );
}

function SectionJ(props: Parameters<typeof SectionPanel>[0]): JSX.Element {
  const sfvItems = props.section.items.filter(
    (item) =>
      item.itemCode.startsWith("J2052") || item.itemCode.startsWith("J2053"),
  );

  const regularItems = props.section.items.filter(
    (item) =>
      !item.itemCode.startsWith("J2052") && !item.itemCode.startsWith("J2053"),
  );

  const groups = J_GROUPS.filter((label) => label !== "Symptom Follow-Up Visit")
    .map((label) => ({
      label,
      items: regularItems.filter(
        (item) => (item.group ?? groupJItem(item.itemCode)) === label,
      ),
    }))
    .filter((group) => group.items.length > 0);

  const grouped = new Set(
    groups.flatMap((group) => group.items.map((item) => item.itemCode)),
  );

  const leftover = regularItems.filter((item) => !grouped.has(item.itemCode));

  if (leftover.length) {
    groups.push({
      label: "Other Health Conditions",
      items: leftover,
    });
  }

  return (
    <div style={groupStack}>
      <GroupedItems
        groups={groups}
        readonly={props.readonly}
        findingsByItem={props.findingsByItem}
        fieldErrors={props.fieldErrors}
        onSave={props.onSave}
      />

      {sfvItems.length > 0 ? (
        <SfvWorkflowSection
          items={sfvItems}
          readonly={props.readonly}
          onComplete={props.onCompleteSfv}
        />
      ) : null}
    </div>
  );
}

function QuestionRenderer(props: {
  item: WorkspaceItem;
  readonly: boolean;
  findings: ReviewModel["validation"]["findings"];
  fieldError?: string;
  onSave: (item: WorkspaceItem, value: AnswerValue | null) => Promise<void>;
  compact?: boolean;
}): JSX.Element {
  const { item } = props;
  if (item.applicability === "not_applicable") {
    return (
      <div id={`hope-item-${item.itemCode}`} tabIndex={-1} style={skippedRow}>
        <span>{item.label}</span>
        <StatusPill label="Skipped" tone="neutral" />
      </div>
    );
  }
  if (item.applicability === "pending") {
    return (
      <div id={`hope-item-${item.itemCode}`} tabIndex={-1} style={pendingRow}>
        <strong>{item.label}</strong>
        <span>{pendingApplicabilityMessage(item)}</span>
        <small style={pendingMeta}>{pendingApplicabilityDetail(item)}</small>
      </div>
    );
  }

  const workflowControlled = PROTECTED_ITEMS.has(item.itemCode);

  const readonly = props.readonly || workflowControlled;

  // const readonly = props.readonly || PROTECTED_ITEMS.has(item.itemCode);
  const inputId = `hope-${item.itemCode}`;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const messages = [
    ...props.findings.map((f) => f.message),
    ...(props.fieldError ? [props.fieldError] : []),
  ];
  return (
    <div
      id={`hope-item-${item.itemCode}`}
      tabIndex={-1}
      style={props.compact ? compactQuestion : questionCard}
    >
      <div style={questionHead}>
        <label htmlFor={inputId} style={questionLabel}>
          {item.label}
        </label>
        <span style={codePill}>{item.itemCode}</span>
      </div>
      <div id={hintId} style={hintLine}>
        <SourceBadge source={item.source} />
        {readonly ? <span>{workflowControlledMessage(item)}</span> : null}
      </div>
      {workflowControlled ? (
        <WorkflowControlledValue item={item} />
      ) : (
        <AnswerControl
          item={item}
          inputId={inputId}
          readonly={readonly}
          describedBy={`${hintId}${messages.length ? ` ${errorId}` : ""}`}
          onSave={props.onSave}
        />
      )}
      {messages.length ? (
        <div
          id={errorId}
          style={
            props.findings.some((f) => f.severity === "warning")
              ? warningText
              : errorText
          }
        >
          {messages.map((message) => (
            <div key={message}>{message}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowControlledValue({
  item,
}: {
  item: WorkspaceItem;
}): JSX.Element {
  const current = String(item.value ?? "");

  const option = item.options.find(
    (candidate) => candidate.valueCode === current,
  );

  return (
    <div style={controlledValue}>
      <span>{option?.label || current || "Not available"}</span>

      <span style={sourceBadge}>Workflow controlled</span>
    </div>
  );
}

function AnswerControl(props: {
  item: WorkspaceItem;
  inputId: string;
  readonly: boolean;
  describedBy: string;
  onSave: (item: WorkspaceItem, value: AnswerValue | null) => Promise<void>;
}): JSX.Element {
  const value = props.item.value == null ? "" : String(props.item.value);
  const dateLike = /date|dt|dte/i.test(
    props.item.cmsItemTypeCode ?? props.item.label,
  );
  if (dateLike) {
    return (
      <input
        id={props.inputId}
        type="date"
        defaultValue={/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ""}
        readOnly={props.readonly}
        aria-describedby={props.describedBy}
        style={inputStyle}
        onBlur={(event) => {
          if (event.currentTarget.value !== value)
            void props.onSave(props.item, event.currentTarget.value || null);
        }}
      />
    );
  }
  const displayOptions = answerOptionsForControl(props.item);
  if (isTextItem(props.item)) {
    return (
      <input
        id={props.inputId}
        type="text"
        defaultValue={value === "Text" ? "" : value}
        maxLength={props.item.maxLength ?? undefined}
        placeholder={textPlaceholder(props.item)}
        readOnly={props.readonly}
        aria-describedby={props.describedBy}
        style={inputStyle}
        onBlur={(event) => {
          if (event.currentTarget.value !== value)
            void props.onSave(props.item, event.currentTarget.value || null);
        }}
      />
    );
  }
  if (displayOptions.length > 0 && displayOptions.length <= 6) {
    return (
      <fieldset
        style={radioSet}
        aria-describedby={props.describedBy}
        disabled={props.readonly}
      >
        <legend style={srOnly}>{props.item.label}</legend>
        {displayOptions.map((option) => (
          <label
            key={option.valueCode}
            style={{
              ...radioChoice,
              ...(value === option.valueCode ? radioChoiceSelected : null),
            }}
          >
            <input
              type="radio"
              name={props.item.itemCode}
              value={option.valueCode}
              checked={value === option.valueCode}
              onChange={() => void props.onSave(props.item, option.valueCode)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
    );
  }
  if (displayOptions.length > 0) {
    return (
      <select
        id={props.inputId}
        value={value}
        disabled={props.readonly}
        aria-describedby={props.describedBy}
        style={inputStyle}
        onChange={(event) =>
          void props.onSave(props.item, event.target.value || null)
        }
      >
        <option value="">Select...</option>
        {displayOptions.map((option) => (
          <option key={option.valueCode} value={option.valueCode}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      id={props.inputId}
      type="text"
      defaultValue={value}
      readOnly={props.readonly}
      aria-describedby={props.describedBy}
      style={inputStyle}
      onBlur={(event) => {
        if (event.currentTarget.value !== value)
          void props.onSave(props.item, event.currentTarget.value || null);
      }}
    />
  );
}

function isTextItem(item: WorkspaceItem): boolean {
  return (
    /text/i.test(item.cmsItemTypeCode ?? "") ||
    item.options.some((option) => option.valueCode === "Text")
  );
}

function answerOptionsForControl(
  item: WorkspaceItem,
): WorkspaceItem["options"] {
  return item.options.filter(
    (option) =>
      option.valueCode !== "Text" && !/^YYYY(MM(DD)?)?$/.test(option.valueCode),
  );
}

function textPlaceholder(item: WorkspaceItem): string | undefined {
  if (item.itemCode === "A0500B") return "Middle initial";
  if (item.itemCode === "A0500D") return "Suffix";
  return item.maxLength ? `Up to ${item.maxLength} characters` : undefined;
}

function ReviewPanel(props: {
  assessment: AssessmentDetail;
  review: ReviewModel | null;
  workspace: Workspace;
  visibleSections: { id: SectionId; label: string; helper: string }[];
  onGoTo: (section: SectionId) => void;
  onSetCompletionDate: (z0350: string) => void;
  completionDateSaving: boolean;
  onSign: () => void;
  onCorrection: () => void;
}): JSX.Element {
  const completed = props.assessment.status === "signed";
  const isHuv = props.workspace.assessment.isc === "HUV";
  return (
    <section>
      <SectionHeader
        code="Review"
        title={completed ? "Completed Record" : "Review & Sign"}
        helper={`Use backend readiness to decide whether this ${rfaLabel(props.assessment.rfaKind)} can be completed.`}
      />
      <div style={reviewHero}>
        <div>
          <h3 style={groupTitle}>
            {props.review?.readiness.readyToSign
              ? "Ready to complete"
              : completed
                ? `${rfaLabel(props.assessment.rfaKind)} completed`
                : "Before signature"}
          </h3>
          <p style={muted}>
            {props.review?.readiness.readyToSign
              ? `All blocking checks passed. ${props.review.validation.warningCount} non-blocking warning${props.review.validation.warningCount === 1 ? "" : "s"} remain.`
              : completed
                ? "This assessment is read-only. Create a correction to make regulated changes."
                : "Resolve backend blockers, then return here to sign."}
          </p>
        </div>
        <div style={progressRing} aria-label="Completion progress">
          {props.workspace.progress.active
            ? Math.round(
                ((props.workspace.progress.answered +
                  props.workspace.progress.skipped) /
                  props.workspace.progress.active) *
                  100,
              )
            : 0}
          %
        </div>
      </div>
      {isHuv ? (
        <HuvCompletionDateControl
          review={props.review}
          workspace={props.workspace}
          readonly={completed}
          saving={props.completionDateSaving}
          onSave={props.onSetCompletionDate}
        />
      ) : null}
      <div style={reviewGrid}>
        {props.visibleSections
          .filter((s) => s.id !== "Review")
          .map((section) => {
            const state = sectionState(
              section.id,
              props.review,
              props.workspace,
            );
            return (
              <button
                key={section.id}
                type="button"
                style={reviewRow}
                onClick={() => props.onGoTo(section.id)}
              >
                <span>
                  {section.id} {section.label}
                </span>
                <span style={reviewStateText}>{state.detail}</span>
              </button>
            );
          })}
      </div>
      <IssueList review={props.review} onGoTo={props.onGoTo} />
      {props.workspace.assessment.isc === "HA" ||
      props.workspace.assessment.isc === "HUV" ? (
        <SfvSummary review={props.review} />
      ) : null}
      <div style={actionRow}>
        {completed ? (
          <button
            type="button"
            style={primaryButton}
            onClick={props.onCorrection}
          >
            Create correction
          </button>
        ) : (
          <button
            type="button"
            style={primaryButton}
            disabled={!props.review?.readiness.readyToSign}
            onClick={props.onSign}
          >
            Sign & complete
          </button>
        )}
      </div>
    </section>
  );
}

function IssueList({
  review,
  onGoTo,
}: {
  review: ReviewModel | null;
  onGoTo: (section: SectionId, itemCode?: string | null) => void;
}): JSX.Element {
  const candidates = [
    ...(review?.readiness.blockers ?? []).map((b) => ({
      section: b.section ?? "Review",
      itemCode: b.itemCode ?? null,
      severity: "error" as const,
      message: b.message,
      ruleId: b.ruleId ?? b.code,
    })),

    ...(review?.validation.findings ?? []).map((f) => ({
      section: f.section,
      itemCode: f.itemCode ?? null,
      severity: f.severity,
      message: f.message,
      ruleId: f.ruleId,
    })),
  ];

  const seen = new Set<string>();

  const rows = candidates.filter((row) => {
    const key = [row.ruleId, row.section, row.itemCode ?? "", row.message].join(
      ":",
    );

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });

  if (!rows.length) {
    return (
      <div style={successBox}>No blocking issues from the backend review.</div>
    );
  }

  return (
    <section style={questionGroup}>
      <h3 style={groupTitle}>Issues</h3>

      <div style={questionList}>
        {rows.map((row) => (
          <button
            key={[row.ruleId, row.itemCode, row.message].join(":")}
            type="button"
            style={issueRow(row.severity)}
            onClick={() => onGoTo(asSection(row.section), row.itemCode)}
          >
            <span>
              <strong>{row.itemCode ?? row.section}</strong>
              {" — "}
              {row.message}
            </span>

            <span>
              {row.severity === "warning" ? "Warning" : "Go to question"}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function SfvSummary({ review }: { review: ReviewModel | null }): JSX.Element {
  const sfv = review?.sfv;
  const label =
    sfv?.required == null
      ? "Pending determination"
      : !sfv.required
        ? "Not required"
        : sfv.status === "completed"
          ? "Completed"
          : sfv.status === "overdue"
            ? "Required - overdue"
            : sfv.status
              ? `Required - ${stateLabel(sfv.status)}`
              : "Required";
  return (
    <section style={questionGroup}>
      <h3 style={groupTitle}>Symptom Follow-Up Visit</h3>
      <div style={sfvBox}>
        <StatusPill
          label={label}
          tone={
            sfv?.status === "overdue"
              ? "critical"
              : sfv?.required
                ? "warning"
                : "neutral"
          }
        />
        {sfv?.dueAt ? <span>Due {formatDate(sfv.dueAt)}</span> : null}
        {sfv?.completedAt ? (
          <span>Completed {formatDate(sfv.completedAt)}</span>
        ) : null}
      </div>
    </section>
  );
}

function HuvTimingBanner({
  workspace,
  review,
}: {
  workspace: Workspace;
  review: ReviewModel | null;
}): JSX.Element | null {
  if (!workspace.huv) return null;
  const stateLabelByCode: Record<
    NonNullable<Workspace["huv"]>["timingState"],
    string
  > = {
    upcoming: "Upcoming",
    within_window: "Within window",
    due_soon: "Due soon",
    late: "Late",
    completed: "Completed",
    unknown: "Schedule pending",
  };
  const warning = review?.validation.findings.find(
    (finding) => finding.ruleId === "-3110",
  );
  return (
    <section style={timingBanner}>
      <div>
        <strong>{stateLabelByCode[workspace.huv.timingState]}</strong>
        <span style={muted}>
          Recommended completion window {formatDate(workspace.huv.windowStart)}{" "}
          - {formatDate(workspace.huv.windowEnd)}
        </span>
      </div>
      <div style={timingBannerMeta}>
        <StatusPill
          label={
            workspace.huv.scheduleStatus
              ? stateLabel(workspace.huv.scheduleStatus)
              : "No schedule"
          }
          tone={workspace.huv.timingState === "late" ? "warning" : "neutral"}
        />
        {workspace.huv.z0350 ? (
          <span>Z0350 {formatDate(workspace.huv.z0350)}</span>
        ) : null}
        {warning ? <span style={warningText}>CMS warning -3110</span> : null}
      </div>
    </section>
  );
}

function HuvCompletionDateControl(props: {
  review: ReviewModel | null;
  workspace: Workspace;
  readonly: boolean;
  saving: boolean;
  onSave: (z0350: string) => void;
}): JSX.Element {
  const value = props.review?.z0350 ?? props.workspace.huv?.z0350 ?? "";
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <section style={questionGroup}>
      <h3 style={groupTitle}>Assessment Completion Date</h3>
      <div style={questionCard}>
        <div style={questionHead}>
          <label htmlFor="hope-z0350-controlled" style={questionLabel}>
            Assessment completed on
          </label>
          <span style={codePill}>CMS Z0350</span>
        </div>
        <div style={hintLine}>
          <SourceBadge source="derived" />
          <span>Set by the HUV completion workflow.</span>
        </div>
        <div style={inlineEditor}>
          <input
            id="hope-z0350-controlled"
            type="date"
            value={draft}
            readOnly={props.readonly}
            style={inputStyle}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <button
            type="button"
            style={secondaryButton}
            disabled={
              props.readonly || props.saving || !draft || draft === value
            }
            onClick={() => props.onSave(draft)}
          >
            {props.saving ? "Saving..." : "Confirm date"}
          </button>
        </div>
      </div>
    </section>
  );
}

function SignDialog(props: {
  review: ReviewModel | null;
  title: string;
  signing: boolean;
  onCancel: () => void;
  onSign: () => void;
}): JSX.Element {
  return (
    <div style={modalBackdrop} role="presentation">
      <dialog
        style={modal}
        open
        aria-modal="true"
        aria-labelledby="hope-sign-title"
      >
        <h2 id="hope-sign-title" style={modalTitle}>
          {props.title}
        </h2>
        <p style={muted}>
          By signing, you confirm this HOPE record is complete. After signing,
          it becomes read-only.
        </p>
        <div style={modalStats}>
          <span>Warnings: {props.review?.validation.warningCount ?? 0}</span>
          <span>Errors: {props.review?.validation.errorCount ?? 0}</span>
        </div>
        <div style={actionRow}>
          <button
            type="button"
            style={secondaryButton}
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            style={primaryButton}
            disabled={props.signing || !props.review?.readiness.readyToSign}
            onClick={props.onSign}
          >
            {props.signing ? "Signing..." : "Sign & complete"}
          </button>
        </div>
      </dialog>
    </div>
  );
}

function InactivationDialog(props: {
  busy: boolean;
  recordLabel: string;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}): JSX.Element {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  return (
    <div style={modalBackdrop} role="presentation">
      <dialog
        style={modal}
        open
        aria-modal="true"
        aria-labelledby="hope-inactivation-title"
      >
        <h2 id="hope-inactivation-title" style={modalTitle}>
          Inactivate {props.recordLabel}
        </h2>
        <p style={muted}>
          This creates a CMS inactivation draft for the selected signed record.
          The original remains current until the inactivation draft is signed.
        </p>
        <label style={fieldLabel}>
          Reason
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={4}
            maxLength={2000}
            style={textareaField}
            autoFocus
          />
        </label>
        <div style={actionRow}>
          <button
            type="button"
            style={secondaryButton}
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            style={dangerButton}
            disabled={props.busy || trimmed.length === 0}
            onClick={() => props.onSubmit(trimmed)}
          >
            {props.busy ? "Creating..." : "Create inactivation"}
          </button>
        </div>
      </dialog>
    </div>
  );
}

function CompletedSummary({
  assessment,
  review,
}: {
  assessment: AssessmentDetail;
  review: ReviewModel | null;
}): JSX.Element {
  return (
    <div style={completedBox}>
      <span aria-hidden="true">✓</span>
      <span>
        Completed {formatDate(assessment.signedAt)} · Signed by{" "}
        {assessment.signedBy ??
          review?.signedByMembershipId ??
          "recorded signer"}{" "}
        · Z0500B {formatDate(review?.z0500b ?? assessment.signedAt)}
      </span>
    </div>
  );
}

function disciplineForCorrection(value: string): "RN" | "NP" | "MD" {
  return value === "NP" || value === "MD" ? value : "RN";
}

function BottomNav({
  active,
  sections,
  onChange,
}: {
  active: SectionId;
  sections: { id: SectionId; label: string; helper: string }[];
  onChange: (id: SectionId) => void;
}): JSX.Element {
  const index = sections.findIndex((section) => section.id === active);
  const previous = sections[Math.max(0, index - 1)] ?? sections[0]!;
  const next =
    sections[Math.min(sections.length - 1, index + 1)] ??
    sections[sections.length - 1]!;
  return (
    <div style={bottomNav}>
      <button
        type="button"
        style={secondaryButton}
        disabled={index <= 0}
        onClick={() => onChange(previous.id)}
      >
        Previous
      </button>
      <span style={muted}>Answers save automatically.</span>
      <button
        type="button"
        style={secondaryButton}
        disabled={index >= sections.length - 1}
        onClick={() => onChange(next.id)}
      >
        Next
      </button>
    </div>
  );
}

function LegacyTimepointView({
  assessment,
  patient,
  timeline,
  onSign,
}: {
  assessment: AssessmentDetail;
  patient: PatientSummary | null;
  timeline: TimepointRow[];
  onSign: () => void;
}): JSX.Element {
  return (
    <PatientWorkspaceLayout
      banner={
        <PatientBanner
          name={
            patient
              ? `${patient.firstName} ${patient.lastName}`
              : "HOPE Assessment"
          }
        />
      }
    >
      <div style={shell}>
        <header style={topBar}>
          <div>
            <div style={eyebrow}>HOPE Timepoint</div>
            <h1 style={title}>{rfaLabel(assessment.rfaKind)}</h1>
            <p style={muted}>
              HUV and Discharge capture keep their existing workflow until their
              UI phase.
            </p>
          </div>
          {assessment.status === "draft" ? (
            <button type="button" style={primaryButton} onClick={onSign}>
              Sign
            </button>
          ) : (
            <StatusPill label={stateLabel(assessment.status)} tone="neutral" />
          )}
        </header>
        <div style={questionGroup}>
          <h3 style={groupTitle}>Timeline</h3>
          {timeline.map((tp) => (
            <Link
              key={tp.id}
              to={`/hope/assessments/${tp.id}`}
              style={legacyLink}
            >
              {rfaLabel(tp.rfaKind)} · {formatDate(tp.targetDate)}
            </Link>
          ))}
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

function SectionHeader({
  code,
  title,
  helper,
}: {
  code: string;
  title: string;
  helper: string;
}): JSX.Element {
  return (
    <div style={sectionHeader}>
      <span style={sectionCode}>{code}</span>
      <div>
        <h2 style={sectionTitle}>{title}</h2>
        <p style={muted}>{helper}</p>
      </div>
    </div>
  );
}

function SourceBadge({
  source,
}: {
  source: AnswerSource | null;
}): JSX.Element | null {
  if (!source || source === "user") return null;
  const label: Record<Exclude<AnswerSource, "user">, string> = {
    patient_prefill: "From patient chart",
    admission_prefill: "From admission",
    derived: "Workflow controlled",
    imported: "Imported",
    correction_copy: "Copied from original",
  };
  return <span style={sourceBadge}>{label[source]}</span>;
}

function workflowControlledMessage(item: WorkspaceItem): string {
  if (item.itemCode === "A0050") {
    return "Set automatically from whether this is a new record, correction, or inactivation.";
  }
  if (item.itemCode === "A0220") {
    return "Set automatically from the assessment target date.";
  }
  if (item.itemCode === "A0250") {
    return "Set automatically from the selected HOPE timepoint.";
  }
  if (item.itemCode === "A0270") {
    return "Set automatically when this record corrects or inactivates a previous HOPE record.";
  }
  if (item.itemCode.startsWith("J2052") || item.itemCode.startsWith("J2053")) {
    return "Set by the Symptom Follow-Up Visit workflow.";
  }
  if (item.itemCode === "Z0500B") {
    return "Set automatically when the assessment is signed.";
  }
  return "Set by workflow.";
}

function pendingApplicabilityMessage(item: WorkspaceItem): string {
  const dependsOn = item.skipReason?.dependsOn ?? [];
  const dependency = dependsOn.length === 1 ? dependsOn[0] : null;
  if (dependency) {
    return `Answer ${dependency} first. This item opens only when that response makes it required.`;
  }
  if (dependsOn.length > 1) {
    return `Answer ${dependsOn.join(", ")} first. This item opens only when those responses make it required.`;
  }
  return "This item is conditionally required and will open when the related answer is saved.";
}

function pendingApplicabilityDetail(item: WorkspaceItem): string {
  if (item.skipReason?.cmsRuleId) {
    return `CMS rule ${item.skipReason.cmsRuleId}`;
  }
  if (item.skipReason?.ruleId) {
    return item.skipReason.ruleId;
  }
  return "Conditional HOPE item";
}

function SaveState({
  state,
}: {
  state: "idle" | "saving" | "saved" | "failed" | "conflict";
}): JSX.Element {
  const label =
    state === "saving"
      ? "Saving..."
      : state === "saved"
        ? "Saved"
        : state === "failed"
          ? "Save failed"
          : state === "conflict"
            ? "Reload needed"
            : "Auto-save";
  return <span style={saveState(state)}>{label}</span>;
}

function ConflictBanner({ onReload }: { onReload: () => void }): JSX.Element {
  return (
    <div style={conflictBanner}>
      <span>
        This assessment changed elsewhere. Reload the latest version before
        continuing.
      </span>
      <button type="button" style={secondaryButton} onClick={onReload}>
        Reload assessment
      </button>
    </div>
  );
}

function sectionsFromWorkspace(
  workspace: Workspace,
): Map<Exclude<SectionId, "Review">, WorkspaceSection> {
  const map = new Map<Exclude<SectionId, "Review">, WorkspaceSection>();
  for (const section of workspace.sections) {
    const id = asSection(section.code);
    if (id !== "Review") map.set(id, section);
  }
  return map;
}

function visibleSectionOrder(
  workspace: Workspace,
): { id: SectionId; label: string; helper: string }[] {
  const activeCodes = new Set(
    workspace.sections.map((section) => section.code),
  );
  const visible = SECTION_ORDER.filter(
    (section) => section.id === "Review" || activeCodes.has(section.id),
  );
  return visible.length
    ? visible
    : SECTION_ORDER.filter((section) => section.id === "Review");
}

function sectionState(
  section: SectionId,
  review: ReviewModel | null,
  workspace: Workspace,
): {
  kind: "complete" | "progress" | "attention" | "empty";
  label: string;
  detail: string;
} {
  if (section === "Review") {
    if (review?.readiness.readyToSign)
      return { kind: "complete", label: "Ready", detail: "Ready to sign" };
    if ((review?.readiness.blockers.length ?? 0) > 0)
      return {
        kind: "attention",
        label: "Needs attention",
        detail: `${review?.readiness.blockers.length ?? 0} blocker(s)`,
      };
    return { kind: "progress", label: "Review", detail: "Review readiness" };
  }
  const sec = review?.sections.find((s) => s.code === section);
  if (sec) {
    if (sec.state === "complete")
      return { kind: "complete", label: "Complete", detail: "Complete" };
    if (sec.errors || sec.pending || sec.unanswered)
      return {
        kind: "attention",
        label: "Needs attention",
        detail: `${sec.unanswered} unanswered · ${sec.errors} errors`,
      };
    if (sec.warnings)
      return {
        kind: "attention",
        label: "Warnings",
        detail: `${sec.warnings} warnings`,
      };
    return {
      kind: "progress",
      label: "In progress",
      detail: `${sec.answered}/${sec.active} answered`,
    };
  }
  const raw = workspace.sections.find((s) => s.code === section);
  const answered =
    raw?.items.filter((i) => i.state !== "unanswered").length ?? 0;
  if (!raw || raw.items.length === 0)
    return { kind: "empty", label: "Not started", detail: "No active items" };
  if (answered === 0)
    return {
      kind: "empty",
      label: "Not started",
      detail: `${raw.items.length} items`,
    };
  if (answered === raw.items.length)
    return { kind: "complete", label: "Complete", detail: "Complete" };
  return {
    kind: "progress",
    label: "In progress",
    detail: `${answered}/${raw.items.length} answered`,
  };
}

function derivedStatus(
  assessment: AssessmentDetail,
  review: ReviewModel | null,
  workspace: Workspace,
): {
  label: string;
  tone: "neutral" | "progress" | "warning" | "critical" | "success";
} {
  if (assessment.status === "signed")
    return { label: "Completed", tone: "success" };
  if (review?.readiness.readyToSign)
    return { label: "Ready to sign", tone: "success" };
  if (
    (review?.validation.errorCount ?? 0) > 0 ||
    (review?.readiness.blockers.length ?? 0) > 0
  )
    return { label: "Needs attention", tone: "critical" };
  if (workspace.progress.answered > 0 || workspace.progress.skipped > 0)
    return { label: "In progress", tone: "progress" };
  return { label: "Not started", tone: "neutral" };
}

function groupSectionA(
  items: WorkspaceItem[],
): { label: string; items: WorkspaceItem[] }[] {
  const used = new Set<string>();
  const groups = SECTION_A_GROUPS.map((group) => {
    const rows = items.filter((item) => group.match(item));
    for (const item of rows) used.add(item.itemCode);
    return { label: group.label, items: rows };
  }).filter((group) => group.items.length > 0);
  const other = items.filter((item) => !used.has(item.itemCode));
  if (other.length)
    groups.push({ label: "Other Administrative Items", items: other });
  return groups;
}

function groupByCodes(
  items: WorkspaceItem[],
  groups: { label: string; codes: string[] }[],
): { label: string; items: WorkspaceItem[] }[] {
  const used = new Set<string>();
  const out = groups
    .map((group) => {
      const rows = items.filter((item) => group.codes.includes(item.itemCode));
      for (const item of rows) used.add(item.itemCode);
      return { label: group.label, items: rows };
    })
    .filter((group) => group.items.length > 0);
  const other = items.filter((item) => !used.has(item.itemCode));
  if (other.length) out.push({ label: "Other", items: other });
  return out;
}

function groupGeneric(
  items: WorkspaceItem[],
  labels: string[],
): { label: string; items: WorkspaceItem[] }[] {
  const size = Math.max(1, Math.ceil(items.length / labels.length));
  return labels
    .map((label, index) => ({
      label,
      items: items.slice(index * size, (index + 1) * size),
    }))
    .filter((group) => group.items.length);
}

function groupJItem(itemCode: string): string {
  if (itemCode === "J0050") return "Current status";
  if (itemCode.startsWith("J09")) return "Pain";
  if (itemCode.startsWith("J203") || itemCode.startsWith("J204"))
    return "Shortness of breath";
  if (itemCode.startsWith("J2050") || itemCode.startsWith("J2051"))
    return "Symptom impact";
  if (itemCode.startsWith("J2052") || itemCode.startsWith("J2053"))
    return "Symptom Follow-Up Visit";
  return "Other Health Conditions";
}

function asSection(value: string): SectionId {
  return SECTION_ORDER.some((section) => section.id === value)
    ? (value as SectionId)
    : "Review";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = value.slice(0, 10);
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function maskIdentifier(value: string | null | undefined): string {
  if (!value) return "MRN not recorded";
  return value.length <= 4 ? value : `MRN ...${value.slice(-4)}`;
}

function stateDot(
  kind: "complete" | "progress" | "attention" | "empty",
): CSSProperties {
  const colors = {
    complete: t.success,
    progress: t.primary,
    attention: t.error,
    empty: t.outlineVariant,
  };
  return {
    width: 10,
    height: 10,
    borderRadius: 999,
    background: colors[kind],
    flex: "0 0 auto",
    marginTop: 4,
  };
}

function saveState(state: string): CSSProperties {
  return {
    color:
      state === "failed" || state === "conflict"
        ? t.error
        : state === "saving"
          ? t.primary
          : t.muted,
    fontSize: "0.8rem",
    fontWeight: 600,
  };
}

function issueRow(severity: "error" | "warning"): CSSProperties {
  return {
    ...reviewRow,
    border: `1px solid ${severity === "warning" ? t.warning : t.error}`,
    background: severity === "warning" ? "#fff8e5" : "#fff3f3",
  };
}

const shell: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  height: "100%",
  background: t.surface,
};
const topBar: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 2,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "1rem 1.25rem",
  borderBottom: `1px solid ${t.outlineVariant}`,
  background: t.surface,
};
const title: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontSize: "1.35rem",
  fontWeight: 600,
  color: t.onSurface,
};
const eyebrow: CSSProperties = {
  color: t.muted,
  fontSize: "0.75rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0,
};
const metaLine: CSSProperties = {
  display: "flex",
  gap: "0.75rem",
  flexWrap: "wrap",
  color: t.muted,
  fontSize: "0.85rem",
  marginTop: "0.25rem",
};
const topActions: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.65rem",
  flexWrap: "wrap",
  justifyContent: "flex-end",
};
const workspaceGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "240px minmax(0, 1fr)",
  minHeight: 0,
  flex: 1,
};
const rail: CSSProperties = {
  borderRight: `1px solid ${t.outlineVariant}`,
  padding: "1rem",
  overflow: "auto",
};
const sectionNav: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};
const sectionButton: CSSProperties = {
  display: "flex",
  gap: "0.75rem",
  alignItems: "flex-start",
  textAlign: "left",
  border: "1px solid transparent",
  borderRadius: 8,
  padding: "0.7rem",
  background: "transparent",
  color: t.onSurface,
  cursor: "pointer",
};
const sectionButtonActive: CSSProperties = {
  background: t.surfaceLow,
  border: `1px solid ${t.outlineVariant}`,
};
const sectionMeta: CSSProperties = {
  display: "block",
  color: t.muted,
  fontWeight: 500,
  marginTop: 2,
};
const mainPanel: CSSProperties = {
  overflow: "auto",
  padding: "1.5rem",
  minWidth: 0,
};
const sectionHeader: CSSProperties = {
  display: "flex",
  gap: "0.8rem",
  alignItems: "flex-start",
  marginBottom: "1rem",
};
const sectionCode: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 36,
  height: 36,
  borderRadius: 8,
  background: t.surfaceLow,
  color: t.onSurface,
  fontWeight: 800,
};
const sectionTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontSize: "1.25rem",
  fontWeight: 600,
};
const muted: CSSProperties = {
  margin: 0,
  color: t.muted,
  fontSize: "0.9rem",
  lineHeight: 1.45,
};
const groupStack: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};
const questionGroup: CSSProperties = {
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 8,
  padding: "1rem",
  background: t.surface,
};
const groupTitle: CSSProperties = {
  margin: "0 0 0.65rem",
  fontSize: "1rem",
  fontWeight: 700,
  color: t.onSurface,
};
const questionList: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};
const cardGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: "0.75rem",
};
const twoColumn: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
  gap: "0.75rem",
};
const questionCard: CSSProperties = {
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 8,
  padding: "0.9rem",
  background: t.surfaceLow,
};
const compactQuestion: CSSProperties = { ...questionCard, padding: "0.75rem" };
const questionHead: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "0.75rem",
  alignItems: "flex-start",
};
const questionLabel: CSSProperties = {
  fontWeight: 650,
  color: t.onSurface,
  lineHeight: 1.35,
};
const codePill: CSSProperties = {
  fontSize: "0.72rem",
  color: t.muted,
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 6,
  padding: "0.1rem 0.3rem",
  whiteSpace: "nowrap",
};
const hintLine: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "center",
  minHeight: 20,
  margin: "0.35rem 0",
  color: t.muted,
  fontSize: "0.78rem",
};
const sourceBadge: CSSProperties = {
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 999,
  padding: "0.1rem 0.45rem",
  background: t.surface,
  color: t.muted,
};
const inputStyle: CSSProperties = {
  width: "100%",
  border: `1px solid ${t.outline}`,
  borderRadius: 8,
  padding: "0.55rem 0.65rem",
  font: "inherit",
  background: t.surface,
};
const radioSet: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.45rem",
  padding: 0,
  margin: 0,
  border: 0,
};
const radioChoice: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 8,
  padding: "0.45rem 0.55rem",
  background: t.surface,
  cursor: "pointer",
};
const radioChoiceSelected: CSSProperties = {
  border: `1px solid ${t.primary}`,
  background: "#eef6ff",
};
const errorText: CSSProperties = {
  marginTop: "0.45rem",
  color: t.error,
  fontSize: "0.82rem",
  lineHeight: 1.35,
};
const warningText: CSSProperties = {
  marginTop: "0.45rem",
  color: t.warning,
  fontSize: "0.82rem",
  lineHeight: 1.35,
};
const skippedRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "1rem",
  alignItems: "center",
  padding: "0.65rem 0.75rem",
  borderRadius: 8,
  background: t.surfaceLow,
  color: t.muted,
};
const pendingRow: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
  padding: "0.65rem 0.75rem",
  borderRadius: 8,
  border: `1px dashed ${t.outline}`,
  color: t.muted,
};
const pendingMeta: CSSProperties = {
  color: t.muted,
  fontSize: "0.78rem",
  fontWeight: 600,
};
const reviewHero: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "1rem",
  alignItems: "center",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 8,
  padding: "1rem",
  marginBottom: "1rem",
  background: t.surfaceLow,
};
const progressRing: CSSProperties = {
  width: 76,
  height: 76,
  borderRadius: 999,
  display: "grid",
  placeItems: "center",
  border: `6px solid ${t.primary}`,
  fontWeight: 800,
  color: t.onSurface,
};
const reviewGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: "0.6rem",
  marginBottom: "1rem",
};
const timingBanner: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  border: `1px solid ${t.outlineVariant}`,
  background: t.surfaceLow,
  borderRadius: 8,
  padding: "0.85rem 1rem",
  marginBottom: "1rem",
};
const timingBannerMeta: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "0.75rem",
  flexWrap: "wrap",
};
const reviewRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "0.75rem",
  textAlign: "left",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 8,
  padding: "0.75rem",
  background: t.surface,
  color: t.onSurface,
  cursor: "pointer",
};
const reviewStateText: CSSProperties = { color: t.muted, fontSize: "0.82rem" };
const sfvBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
  color: t.muted,
};
const successBox: CSSProperties = {
  border: `1px solid ${t.success}`,
  borderRadius: 8,
  padding: "0.85rem",
  color: t.success,
  background: "#eefaf2",
  marginBottom: "1rem",
};
const completedBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  padding: "0.75rem 1.25rem",
  borderBottom: `1px solid ${t.outlineVariant}`,
  color: t.success,
  background: "#eefaf2",
};
const conflictBanner: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1rem",
  padding: "0.75rem 1.25rem",
  borderBottom: `1px solid ${t.warning}`,
  color: t.onSurface,
  background: "#fff8e5",
};
const bottomNav: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1rem",
  marginTop: "1.25rem",
  paddingTop: "1rem",
  borderTop: `1px solid ${t.outlineVariant}`,
};
const actionRow: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.75rem",
  marginTop: "1rem",
};
const inlineEditor: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
};
const primaryButton: CSSProperties = {
  border: 0,
  borderRadius: 8,
  padding: "0.6rem 0.85rem",
  background: t.primary,
  color: t.onPrimary,
  fontWeight: 700,
  cursor: "pointer",
};
const secondaryButton: CSSProperties = {
  border: `1px solid ${t.outline}`,
  borderRadius: 8,
  padding: "0.55rem 0.8rem",
  background: t.surface,
  color: t.onSurface,
  fontWeight: 650,
  cursor: "pointer",
};
const dangerButton: CSSProperties = {
  border: 0,
  borderRadius: 8,
  padding: "0.6rem 0.85rem",
  background: t.error,
  color: "#fff",
  fontWeight: 700,
  cursor: "pointer",
};
const fieldLabel: CSSProperties = {
  display: "grid",
  gap: "0.45rem",
  marginTop: "1rem",
  fontWeight: 700,
  color: t.onSurface,
};
const textareaField: CSSProperties = {
  ...inputStyle,
  minHeight: "7rem",
  resize: "vertical",
};
const modalBackdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.45)",
  display: "grid",
  placeItems: "center",
  zIndex: 20,
  padding: "1rem",
};
const modal: CSSProperties = {
  width: "min(440px, 100%)",
  borderRadius: 8,
  background: t.surface,
  padding: "1.25rem",
  boxShadow: "0 20px 60px rgba(15, 23, 42, 0.28)",
};
const modalTitle: CSSProperties = {
  margin: "0 0 0.5rem",
  fontFamily: t.fontDisplay,
  fontSize: "1.2rem",
};
const modalStats: CSSProperties = {
  display: "flex",
  gap: "0.75rem",
  color: t.muted,
  marginTop: "1rem",
};
const mobileSectionSelect: CSSProperties = {
  display: "none",
  width: "100%",
  marginBottom: "0.75rem",
  ...inputStyle,
};
const legacyLink: CSSProperties = {
  display: "block",
  padding: "0.5rem 0",
  color: t.primary,
};
const MonoChip = ({ children }: { children: ReactNode }): JSX.Element => (
  <span style={{ fontFamily: t.fontMono, fontSize: "0.8rem" }}>{children}</span>
);
const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

const sfvModalBackdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 50,
  display: "grid",
  placeItems: "center",
  padding: "1rem",
  background: "rgba(15, 23, 42, 0.52)",
  backdropFilter: "blur(2px)",
};

const sfvModal: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "min(760px, calc(100vw - 2rem))",
  maxWidth: "760px",
  maxHeight: "min(860px, calc(100vh - 2rem))",
  margin: 0,
  padding: 0,
  overflow: "hidden",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 12,
  background: t.surface,
  color: t.onSurface,
  boxShadow: "0 24px 70px rgba(15, 23, 42, 0.28)",
};

const sfvModalHeader: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "1.25rem 1.35rem 1rem",
  borderBottom: `1px solid ${t.outlineVariant}`,
  background: t.surface,
};

const sfvModalHeaderText: CSSProperties = {
  minWidth: 0,
};

const sfvModalEyebrow: CSSProperties = {
  marginBottom: "0.2rem",
  color: t.primary,
  fontSize: "0.72rem",
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const sfvModalTitle: CSSProperties = {
  margin: 0,
  color: t.onSurface,
  fontFamily: t.fontDisplay,
  fontSize: "1.3rem",
  fontWeight: 700,
};

const sfvModalDescription: CSSProperties = {
  margin: "0.3rem 0 0",
  color: t.muted,
  fontSize: "0.88rem",
  lineHeight: 1.45,
};

const sfvCloseButton: CSSProperties = {
  display: "grid",
  flex: "0 0 auto",
  width: 34,
  height: 34,
  placeItems: "center",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 8,
  background: t.surface,
  color: t.muted,
  fontSize: "1.35rem",
  lineHeight: 1,
  cursor: "pointer",
};

const sfvModalBody: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  overflowY: "auto",
  overscrollBehavior: "contain",
  padding: "1rem 1.35rem 1.25rem",
};

const sfvSection: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.9rem",
  padding: "1rem",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 10,
  background: t.surfaceLow,
  marginBottom: "1rem",
};

const sfvSectionHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
};

const sfvSectionTitle: CSSProperties = {
  margin: 0,
  color: t.onSurface,
  fontSize: "0.98rem",
  fontWeight: 750,
};

const sfvSectionDescription: CSSProperties = {
  margin: "0.2rem 0 0",
  color: t.muted,
  fontSize: "0.82rem",
  lineHeight: 1.4,
};

const sfvDetailsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "0.85rem",
};

const sfvField: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};

const sfvFieldLabel: CSSProperties = {
  color: t.onSurface,
  fontSize: "0.8rem",
  fontWeight: 700,
};

const sfvInput: CSSProperties = {
  width: "100%",
  minHeight: 42,
  boxSizing: "border-box",
  border: `1px solid ${t.outline}`,
  borderRadius: 8,
  padding: "0.55rem 0.65rem",
  background: t.surface,
  color: t.onSurface,
  font: "inherit",
};

const sfvProgressBadge: CSSProperties = {
  flex: "0 0 auto",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 999,
  padding: "0.2rem 0.55rem",
  background: t.surface,
  color: t.muted,
  fontSize: "0.75rem",
  fontWeight: 700,
  whiteSpace: "nowrap",
};

const sfvProgressTrack: CSSProperties = {
  width: "100%",
  height: 5,
  overflow: "hidden",
  borderRadius: 999,
  background: t.outlineVariant,
};

const sfvProgressValue: CSSProperties = {
  height: "100%",
  borderRadius: 999,
  background: t.primary,
  transition: "width 180ms ease",
};

const sfvAnswersGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: "0.7rem",
};

const sfvAnswerCard: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.65rem",
  padding: "0.75rem",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 9,
  background: t.surface,
};

const sfvAnswerCardComplete: CSSProperties = {
  border: `1px solid ${t.primary}`,
};

const sfvAnswerCardHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
};

const sfvAnswerNumber: CSSProperties = {
  display: "grid",
  flex: "0 0 auto",
  width: 28,
  height: 28,
  placeItems: "center",
  borderRadius: 7,
  background: t.surfaceLow,
  color: t.muted,
  fontSize: "0.75rem",
  fontWeight: 800,
};

const sfvAnswerTitle: CSSProperties = {
  display: "block",
  color: t.onSurface,
  fontSize: "0.83rem",
};

const sfvAnswerHint: CSSProperties = {
  display: "block",
  marginTop: 1,
  color: t.muted,
  fontSize: "0.72rem",
};

const sfvErrorBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
  padding: "0.75rem 0.85rem",
  border: `1px solid ${t.error}`,
  borderRadius: 8,
  background: "#fff3f3",
  color: t.error,
  fontSize: "0.82rem",
};

const sfvModalFooter: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.85rem 1.35rem",
  borderTop: `1px solid ${t.outlineVariant}`,
  background: t.surface,
};

const sfvFooterStatus: CSSProperties = {
  minWidth: 0,
  fontSize: "0.8rem",
};

const sfvReadyText: CSSProperties = {
  color: t.success,
  fontWeight: 700,
};

const sfvPendingText: CSSProperties = {
  color: t.muted,
};

const sfvFooterActions: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "0.65rem",
  flex: "0 0 auto",
};

const sfvDisabledButton: CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
};
