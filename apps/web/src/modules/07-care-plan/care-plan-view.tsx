import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  Modal,
  PatientWorkspaceLayout,
  StatusPill,
  cardSurface,
  ghostBorder,
  t,
  useApiClient,
} from "@wardenx/ui";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChartModuleRail, PatientChartBail } from "../../shell/chart-module-rail";
import {
  ChartBanner,
  ChartPatientBanner,
  PatientSummaryPanel,
  useChartIdentity,
} from "../../shell/patient-context";
import { useSession } from "../../shell/session";
import {
  type CarePlan,
  type ClinicalSnapshot,
  type Goal,
  type Intervention,
  type PatientSummary,
  type Problem,
  type ProposedChanges,
  type Readiness,
  type ReviewStatus,
  type SignerSlot,
  type Version,
  bootstrapCarePlan,
  errorMessage,
  getCarePlanWorkspace,
  getProposedChanges,
  loadPatientAdmissions,
  writeHeaders,
} from "./care-plan-api";
import {
  CarePlanRail,
  GoalsList,
  InterventionsList,
  PlanHeader,
  PlanStats,
  disciplineLabel,
} from "./care-plan-overview";
import { cap, toneFor } from "./care-plan-status";

type Tab = "goals" | "interventions" | "problems" | "revision" | "history";
type ModalState =
  | { kind: "problem"; problem?: Problem }
  | { kind: "resolve_problem"; problem: Problem }
  | { kind: "goal"; goal?: Goal; problemId?: string }
  | { kind: "intervention"; intervention?: Intervention; problemId?: string }
  | { kind: "discontinue_intervention"; intervention: Intervention }
  | { kind: "sign"; version: Version }
  | { kind: "return_to_draft"; version: Version }
  | null;

const KIND_ORDER: Record<string, number> = {
  terminal: 0,
  related: 1,
  unrelated: 2,
};
const PROBLEM_KINDS = ["terminal", "related", "unrelated"] as const;
const PROBLEM_SOURCES = ["clinical", "assessment", "idg", "patient_family"] as const;
const GOAL_SOURCES = ["clinical", "patient_stated", "family_stated", "agent_stated"] as const;
const GOAL_STATUSES = [
  "not_started",
  "in_progress",
  "met",
  "not_met",
  "revised",
  "discontinued",
] as const;
const DISCIPLINES = [
  "rn",
  "lpn",
  "chha",
  "msw",
  "chaplain",
  "volunteer",
  "bereavement",
  "md_np",
  "pt",
  "ot",
  "st",
  "music_therapy",
  "dietitian",
] as const;

interface TerminologyConcept {
  code: string;
  display?: string;
}

function hasPerm(perms: string[] | undefined, key: string): boolean {
  return perms?.includes(key) ?? false;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Not set";
  // Date-only values are calendar dates: parse locally so they don't shift a day west of UTC.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = ymd ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])) : new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

function blockerLabel(code: string, message?: string): string {
  if (message) return message;
  if (code === "TERMINAL_PROBLEM_REQUIRED") return "Active terminal problem required";
  if (code === "OPEN_VERSION_REQUIRED") return "Open draft or review version required";
  return cap(code);
}

function snapshotOf(version: Version | null): ClinicalSnapshot | null {
  if (!version?.stateSnapshot || typeof version.stateSnapshot !== "object") return null;
  return version.stateSnapshot as ClinicalSnapshot;
}

function uniqueBlockers(readiness: Readiness | null, activeTerminal?: Problem): string[] {
  const labels = new Set<string>();
  if (!activeTerminal) labels.add("Active terminal problem required");
  for (const blocker of readiness?.blockers ?? []) {
    labels.add(blockerLabel(blocker.code, blocker.message).replace(/[.]$/, ""));
  }
  return [...labels];
}

/** A successful signature response is authoritative even if the following workspace read is stale. */
function signedVersionFromMutation(response: unknown): Version | null {
  const data = (response as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object") return null;
  const version = data as Partial<Version>;
  return version.status === "signed" && typeof version.id === "string"
    ? (version as Version)
    : null;
}

export function CarePlanView(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const session = useSession();
  const { patientId } = useParams<{ patientId: string }>();
  const identity = useChartIdentity(patientId);
  const [plan, setPlan] = useState<CarePlan | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [review, setReview] = useState<ReviewStatus | null>(null);
  const [proposed, setProposed] = useState<ProposedChanges | null>(null);
  const [tab, setTab] = useState<Tab>("goals");
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // F-066 (#161) — the open admission `POST /patients/:id/care-plan` is keyed by, resolved only when no
  // plan exists. Automatic bootstrap on activation is the normal path; this is the recovery control when
  // it did not happen. `null` while unresolved or when the patient has no OPEN admission (a patient with
  // only discharged admissions is not under care, and bootstrapping a plan into one would be wrong).
  const [openAdmissionId, setOpenAdmissionId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const canAuthor = hasPerm(session?.permissions, "care_plan.author");
  const canFinalize = hasPerm(session?.permissions, "care_plan.finalize");
  const canSign = hasPerm(session?.permissions, "care_plan.sign");

  const openVersion = useMemo(
    () => plan?.versions.find((v) => v.status === "draft" || v.status === "in_review") ?? null,
    [plan],
  );
  const activeVersion = useMemo(
    () => plan?.versions.find((v) => v.id === plan.activeVersionId) ?? null,
    [plan],
  );
  const selectedVersion =
    plan?.versions.find((v) => v.id === selectedVersionId) ?? activeVersion ?? openVersion ?? null;

  async function reload(message?: string): Promise<void> {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const res = await getCarePlanWorkspace(client, patientId);
    if (res.error) setError(errorMessage(res.error, "Could not load the Care Plan workspace."));
    setPlan(res.plan);
    setPatient(res.patient);
    if (!res.plan && !res.error) {
      // No plan yet — resolve the admission a bootstrap would hang off, so the empty state can offer
      // the create rather than assert that admission activation already did it (#161).
      const admissions = await loadPatientAdmissions(client, patientId);
      setOpenAdmissionId(admissions.find((a) => a.dischargedAt == null)?.id ?? null);
    }
    setReadiness(res.readiness);
    setReview(res.review);
    const open = res.plan?.versions.find((v) => v.status === "draft" || v.status === "in_review");
    setSelectedVersionId((current) => current ?? res.plan?.activeVersionId ?? open?.id ?? null);
    if (open?.kind === "idg_review") {
      const proposedRes = await getProposedChanges(client, res.plan!.id, open.id);
      setProposed(proposedRes.proposed);
    } else {
      setProposed(null);
    }
    setNotice(message ?? null);
    setLoading(false);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: route patientId is the reload boundary.
  useEffect(() => {
    void reload();
  }, [patientId]);

  // A dialog shows the error of ITS action; opening or closing one starts from a clean slate so an
  // earlier refusal is not replayed inside an unrelated dialog.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dialog identity is the boundary.
  useEffect(() => {
    setModalError(null);
  }, [modal]);

  async function mutate(
    action: () => Promise<{ data?: unknown; error?: unknown }>,
    success: string,
  ): Promise<void> {
    setBusy(true);
    if (modal) setModalError(null);
    else setError(null);

    const res = await action();
    setBusy(false);

    if (res.error) {
      const response = (res as { response?: Response }).response;

      const payload = res.error as {
        code?: string;
        message?: string;
        error?: {
          code?: string;
          message?: string;
        };
      };

      const code = payload.error?.code ?? payload.code;
      const message = payload.error?.message ?? payload.message ?? "";

      const requiresStepUp =
        response?.status === 403 &&
        (code === "STEP_UP_REQUIRED" || message.includes("step_up_recent"));

      if (requiresStepUp) {
        const returnTo = `${window.location.pathname}${window.location.search}`;

        navigate(`/step-up?returnTo=${encodeURIComponent(returnTo)}`);

        return;
      }

      const userMessage = carePlanErrorMessage(
        res.error,
        "The Care Plan action could not be completed. Please try again.",
      );
      if (modal) setModalError(userMessage);
      else setError(userMessage);

      return;
    }

    const signedVersion = signedVersionFromMutation(res);
    setModal(null);
    await reload(success);
    if (signedVersion) {
      setPlan((current) =>
        current
          ? {
              ...current,
              status: "active",
              activeVersionId: signedVersion.id,
              versions: current.versions.map((version) =>
                version.id === signedVersion.id ? signedVersion : version,
              ),
            }
          : current,
      );
      setReadiness({
        planId: signedVersion.planId,
        openVersionId: null,
        canFinalize: false,
        canSign: false,
        blockers: [],
        signatures: { required: [], collected: [], missing: [] },
      });
      setSelectedVersionId(signedVersion.id);
    }
  }

  async function startVersion(kind: "interim_revision" | "idg_review"): Promise<void> {
    if (!plan) return;
    await mutate(
      async () =>
        client.POST("/api/v1/care-plans/{planId}/versions", {
          params: { path: { planId: plan.id } },
          body: { kind },
        } as never),
      kind === "idg_review" ? "Review draft opened." : "Condition-change revision opened.",
    );
    setTab("revision");
  }

  async function finalize(version: Version): Promise<void> {
    if (!plan) return;
    await mutate(
      async () =>
        client.POST("/api/v1/care-plans/{planId}/versions/{versionId}/finalize", {
          params: { path: { planId: plan.id, versionId: version.id } },
          body: { ifVersion: version.version },
        } as never),
      "Version sent for signatures.",
    );
    setTab("revision");
  }

  const bailBanner = <ChartPatientBanner patientId={patientId} />;

  if (loading) {
    return (
      <PatientChartBail banner={bailBanner} patientId={patientId} current="care-plan">
        <LoadingSpinner />
      </PatientChartBail>
    );
  }

  if (error && !plan) {
    return (
      <PatientChartBail banner={bailBanner} patientId={patientId} current="care-plan">
        <EmptyState title="Care Plan unavailable" description={error} />
      </PatientChartBail>
    );
  }

  if (!plan) {
    return (
      <PatientChartBail banner={bailBanner} patientId={patientId} current="care-plan">
        <EmptyState
          title="No care plan yet"
          description={
            openAdmissionId
              ? "Start the individualised plan of care for this admission (42 CFR 418.56(b)). Problems, goals, and interventions are added to it here."
              : "This patient has no open admission, so there is no admission to hang a plan of care on. Admit the patient first."
          }
          action={
            openAdmissionId ? (
              <Button
                onClick={() => {
                  if (!patientId || !openAdmissionId || starting) return;
                  setStarting(true);
                  setStartError(null);
                  void bootstrapCarePlan(client, patientId, openAdmissionId).then((res) => {
                    setStarting(false);
                    if (!res.ok) {
                      setStartError("Could not start the care plan.");
                      return;
                    }
                    void reload("Care plan started.");
                  });
                }}
                disabled={starting}
              >
                {starting ? "Starting…" : "Start the care plan"}
              </Button>
            ) : undefined
          }
        />
        {startError ? (
          <p role="alert" aria-live="assertive" style={{ color: t.error }}>
            {startError}
          </p>
        ) : null}
      </PatientChartBail>
    );
  }

  const activeTerminal = plan.problems.find((p) => p.kind === "terminal" && p.status === "active");
  const blockers = uniqueBlockers(readiness, activeTerminal);
  const editable =
    canAuthor &&
    plan.status !== "discharged" &&
    Boolean(openVersion) &&
    openVersion?.status !== "in_review";
  const addGoal = (): void =>
    setModal({
      kind: "goal",
      problemId: activeTerminal?.id ?? plan.problems[0]?.id,
    });

  return (
    <PatientWorkspaceLayout
      banner={
        identity ? (
          <ChartBanner
            identity={identity}
            actions={
              <>
                {plan.redacted ? (
                  <span style={restricted}>
                    <Glyph name="lock" size={12} /> restricted content omitted
                  </span>
                ) : null}
                <Link to={`/patients/${patientId}/idg-history`} className="wx-btn-primary">
                  IDG History
                </Link>
              </>
            }
          />
        ) : (
          bailBanner
        )
      }
      rail={
        <CarePlanRail
          plan={plan}
          patientId={patientId ?? ""}
          summary={<PatientSummaryPanel identity={identity} />}
          canAddGoal={editable && plan.problems.length > 0}
          onAddGoal={addGoal}
        />
      }
    >
      <div style={workspace}>
        <ChartModuleRail patientId={patientId ?? ""} current="care-plan" />
        <main style={mainPane}>
          <PlanHeader
            plan={plan}
            activeVersion={activeVersion}
            openVersion={openVersion}
            actions={
              <button
                type="button"
                className="wx-btn-secondary"
                onClick={() => navigate(`/care-plans/${plan.id}/versions`)}
              >
                Version history
              </button>
            }
          />

          <PlanStats plan={plan} review={review} />

          {/* While a dialog is open its own copy of the error is shown inside it (the page one would sit
              behind the modal scrim, unseen and outside the aria-modal tree). */}
          {error && !modal ? <Notice tone="error">{error}</Notice> : null}
          {notice ? <Notice tone="success">{notice}</Notice> : null}

          <WorkflowGuide
            plan={plan}
            openVersion={openVersion}
            activeVersion={activeVersion}
            readiness={readiness}
            review={review}
            proposed={proposed}
            blockers={blockers}
            canAuthor={canAuthor}
            canFinalize={canFinalize}
            canSign={canSign}
            busy={busy}
            onAddTerminal={() => setModal({ kind: "problem" })}
            onContinue={() => setTab(openVersion?.status === "in_review" ? "revision" : "problems")}
            onOpenRevision={() => setTab("revision")}
            onStartRevision={() => void startVersion("interim_revision")}
            onStartReview={() => void startVersion("idg_review")}
            onFinalize={() => {
              if (openVersion) void finalize(openVersion);
            }}
            onSign={() => {
              if (openVersion) setModal({ kind: "sign", version: openVersion });
            }}
          />

          <div className="wx-subtabs" role="tablist" aria-label="Care Plan workspace views">
            <TabButton active={tab === "goals"} onClick={() => setTab("goals")}>
              Goals
              <span className="wx-seg-count wx-nums">{plan.goals.length}</span>
            </TabButton>
            <TabButton active={tab === "interventions"} onClick={() => setTab("interventions")}>
              Interventions
            </TabButton>
            <TabButton active={tab === "problems"} onClick={() => setTab("problems")}>
              Problems
            </TabButton>
            <TabButton active={tab === "revision"} onClick={() => setTab("revision")}>
              Review & Sign
              {openVersion ? <span className="wx-seg-count wx-nums">1</span> : null}
            </TabButton>
            <TabButton active={tab === "history"} onClick={() => setTab("history")}>
              Revisions
            </TabButton>
          </div>

          {tab === "goals" ? (
            <GoalsList
              plan={plan}
              editable={editable && plan.problems.length > 0}
              onEdit={(goal) => setModal({ kind: "goal", goal, problemId: goal.problemId })}
              onAdd={addGoal}
            />
          ) : null}

          {tab === "interventions" ? (
            <InterventionsList
              plan={plan}
              editable={editable && plan.problems.length > 0}
              onEdit={(intervention) =>
                setModal({
                  kind: "intervention",
                  intervention,
                  problemId: intervention.problemId,
                })
              }
              onDiscontinue={(intervention) =>
                setModal({ kind: "discontinue_intervention", intervention })
              }
              onAdd={() =>
                setModal({
                  kind: "intervention",
                  problemId: activeTerminal?.id ?? plan.problems[0]?.id,
                })
              }
            />
          ) : null}

          {tab === "problems" ? (
            <ClinicalContent
              title="Problems"
              readonly={
                plan.status === "discharged" || !openVersion || openVersion.status === "in_review"
              }
              plan={plan}
              problems={plan.problems}
              goals={plan.goals}
              interventions={plan.interventions}
              canAuthor={editable}
              onProblem={(problem) => setModal({ kind: "problem", problem })}
              onGoal={(goal, problemId) => setModal({ kind: "goal", goal, problemId })}
              onIntervention={(intervention, problemId) =>
                setModal({ kind: "intervention", intervention, problemId })
              }
              onResolveProblem={(problem) => setModal({ kind: "resolve_problem", problem })}
              onDiscontinueIntervention={(intervention) =>
                setModal({ kind: "discontinue_intervention", intervention })
              }
            />
          ) : null}

          {tab === "revision" ? (
            <RevisionPanel
              plan={plan}
              version={openVersion}
              readiness={readiness}
              proposed={proposed}
              review={review}
              canAuthor={canAuthor}
              canFinalize={canFinalize}
              canSign={canSign}
              busy={busy}
              onFinalize={finalize}
              onSign={(version) => setModal({ kind: "sign", version })}
              onReturn={(version) => setModal({ kind: "return_to_draft", version })}
              onStartRevision={() => void startVersion("interim_revision")}
              onStartReview={() => void startVersion("idg_review")}
              onProblem={(problem) => setModal({ kind: "problem", problem })}
              onGoal={(goal, problemId) => setModal({ kind: "goal", goal, problemId })}
              onIntervention={(intervention, problemId) =>
                setModal({ kind: "intervention", intervention, problemId })
              }
              onResolveProblem={(problem) => setModal({ kind: "resolve_problem", problem })}
              onDiscontinueIntervention={(intervention) =>
                setModal({ kind: "discontinue_intervention", intervention })
              }
            />
          ) : null}

          {tab === "history" ? (
            <HistoryPanel
              plan={plan}
              selectedVersion={selectedVersion}
              onSelect={(id) => setSelectedVersionId(id)}
            />
          ) : null}
        </main>
      </div>

      {modal ? (
        <CarePlanModal
          state={modal}
          plan={plan}
          goals={plan.goals}
          problems={plan.problems}
          busy={busy}
          error={modalError}
          onClose={() => setModal(null)}
          onSubmit={mutate}
        />
      ) : null}
    </PatientWorkspaceLayout>
  );
}

function WorkflowGuide({
  plan,
  openVersion,
  activeVersion,
  readiness,
  review,
  proposed,
  blockers,
  canAuthor,
  canFinalize,
  canSign,
  busy,
  onAddTerminal,
  onContinue,
  onOpenRevision,
  onStartRevision,
  onStartReview,
  onFinalize,
  onSign,
}: {
  plan: CarePlan;
  openVersion: Version | null;
  activeVersion: Version | null;
  readiness: Readiness | null;
  review: ReviewStatus | null;
  proposed: ProposedChanges | null;
  blockers: string[];
  canAuthor: boolean;
  canFinalize: boolean;
  canSign: boolean;
  busy: boolean;
  onAddTerminal: () => void;
  onContinue: () => void;
  onOpenRevision: () => void;
  onStartRevision: () => void;
  onStartReview: () => void;
  onFinalize: () => void;
  onSign: () => void;
}): JSX.Element {
  const inReview = openVersion?.status === "in_review";
  const hasOpenDraft = openVersion?.status === "draft";
  const isDischarged = plan.status === "discharged";
  const reviewDue = review?.status === "due" || review?.status === "overdue";
  const missingSignatures = readiness?.signatures.missing.length ?? 0;

  let heading = "Complete the Care Plan";
  let description =
    blockers[0] ??
    "Build the clinical plan, review it, then send the governed version for required signatures.";
  let action: ReactNode = null;
  let state: "neutral" | "attention" | "success" = blockers.length ? "attention" : "neutral";

  if (isDischarged) {
    heading = "Care Plan is read-only";
    description = "This admission is discharged. Historical Care Plan content remains available.";
  } else if (inReview) {
    heading =
      missingSignatures > 0 ? "Hospice physician review pending" : "Review version in progress";
    description =
      missingSignatures > 0
        ? `${missingSignatures} required signer slot${missingSignatures === 1 ? "" : "s"} remain before this version can become the active Care Plan.`
        : "The candidate version is frozen while it is in review.";
    state = missingSignatures > 0 ? "attention" : "neutral";
    action =
      canSign && readiness?.canSign ? (
        <button type="button" style={primaryBtn} disabled={busy} onClick={onSign}>
          Review & sign
        </button>
      ) : (
        <button type="button" style={primaryBtn} onClick={onOpenRevision}>
          View signature status
        </button>
      );
  } else if (hasOpenDraft && blockers.length > 0) {
    heading =
      openVersion?.kind === "idg_review"
        ? "Complete the scheduled review"
        : "Care Plan needs attention";
    description = blockers[0] as string;
    state = "attention";
    const terminalMissing = blockers.some((b) => b.toLowerCase().includes("terminal problem"));
    action =
      terminalMissing && canAuthor ? (
        <button type="button" style={primaryBtn} onClick={onAddTerminal}>
          Add terminal problem
        </button>
      ) : (
        <button type="button" style={primaryBtn} onClick={onContinue}>
          Continue Care Plan
        </button>
      );
  } else if (hasOpenDraft && readiness?.canFinalize) {
    heading = "Ready for physician review";
    description =
      "The clinical plan is complete. Sending it freezes this version for hospice physician review and signature.";
    state = "success";
    action = canFinalize ? (
      <button type="button" style={primaryBtn} disabled={busy} onClick={onFinalize}>
        Send for physician review
      </button>
    ) : (
      <button type="button" style={primaryBtn} onClick={onOpenRevision}>
        Review version
      </button>
    );
  } else if (!openVersion && reviewDue && canAuthor && review?.canStartReview) {
    heading =
      review?.status === "overdue" ? "Scheduled review is overdue" : "Scheduled review is due";
    description =
      review?.status === "overdue"
        ? `The review is overdue by ${review.overdueByDays} day${review.overdueByDays === 1 ? "" : "s"}.`
        : "Review the active plan and document any clinically meaningful changes.";
    state = "attention";
    action = (
      <button type="button" style={primaryBtn} onClick={onStartReview}>
        Start review
      </button>
    );
  } else if (!openVersion && activeVersion) {
    // An active plan can still carry readiness blockers (e.g. no active terminal problem); never
    // report "no action required" over them.
    heading = blockers.length ? "Care Plan needs attention" : "Care Plan is active";
    description = blockers.length
      ? (blockers[0] as string)
      : review?.nextReviewDueAt
        ? `No action is required now. Next review: ${formatDate(review.nextReviewDueAt)}.`
        : "No action is required now. Open a revision when the patient's condition or plan changes.";
    state = blockers.length ? "attention" : "success";
    action = canAuthor ? (
      <button type="button" style={ghostBtn} onClick={onStartRevision}>
        Document condition change
      </button>
    ) : null;
  } else if (!openVersion && canAuthor) {
    heading = "Start the Care Plan";
    description = "Open the initial draft to begin documenting problems, goals, and interventions.";
    action = (
      <button type="button" style={primaryBtn} onClick={onStartRevision}>
        Start initial draft
      </button>
    );
  }

  const stateColor =
    state === "attention" ? t.warning : state === "success" ? t.success : t.primary;
  // The details list repeats every blocker; it is only redundant when the description already is the
  // single blocker.
  const listedBlockers =
    blockers.length > 1 || (blockers.length === 1 && description !== blockers[0]);

  return (
    <section style={workflowCard} aria-label="Care Plan next step">
      <div style={workflowTop}>
        <div style={workflowLead}>
          <span style={workflowIcon(stateColor)} aria-hidden="true">
            <Glyph
              name={
                state === "success" ? "check-circle" : state === "attention" ? "clock" : "activity"
              }
              size={22}
              strokeWidth={1.6}
            />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={eyebrow}>Next action</div>
            <h2 style={workflowTitle}>{heading}</h2>
            <p style={workflowDescription}>{description}</p>
          </div>
        </div>
        {action}
      </div>

      {listedBlockers || proposed?.changes.length || (reviewDue && openVersion) ? (
        <div style={workflowDetails}>
          {listedBlockers ? (
            <details open={description !== blockers[0]}>
              <summary style={detailsSummary}>
                {blockers.length} item{blockers.length === 1 ? "" : "s"} need
                {blockers.length === 1 ? "s" : ""} attention
              </summary>
              <ul style={compactList}>
                {blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </details>
          ) : null}

          {proposed?.changes.length ? (
            <button type="button" style={textAction} onClick={onOpenRevision}>
              {proposed.changes.length} IDG proposed change
              {proposed.changes.length === 1 ? "" : "s"} to review
            </button>
          ) : null}

          {reviewDue && openVersion ? (
            <span style={warningText}>
              {review?.status === "overdue"
                ? `Scheduled review overdue by ${review.overdueByDays} day${review.overdueByDays === 1 ? "" : "s"}`
                : "Scheduled review is due"}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function WorkflowSteps({ current }: { current: 0 | 1 | 2 | 3 }): JSX.Element {
  const steps = ["Build plan", "Manager review", "Physician signature", "Active"] as const;
  return (
    <ol style={stepper} aria-label="Care Plan workflow">
      {steps.map((label, index) => {
        const complete = index < current || current === 3;
        const active = index === current && current !== 3;
        return (
          <li key={label} style={stepItem}>
            <span style={complete ? stepDotComplete : active ? stepDotActive : stepDot}>
              {complete ? "✓" : index + 1}
            </span>
            <span style={active ? stepLabelActive : stepLabel}>{label}</span>
            {index < steps.length - 1 ? <span style={stepLine} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function ClinicalContent({
  title: heading,
  plan,
  problems,
  goals,
  interventions,
  readonly,
  canAuthor,
  onProblem,
  onGoal,
  onIntervention,
  onResolveProblem,
  onDiscontinueIntervention,
}: {
  title: string;
  plan: CarePlan;
  problems: Problem[];
  goals: Goal[];
  interventions: Intervention[];
  readonly: boolean;
  canAuthor: boolean;
  onProblem: (problem?: Problem) => void;
  onGoal: (goal?: Goal, problemId?: string) => void;
  onIntervention: (intervention?: Intervention, problemId?: string) => void;
  onResolveProblem: (problem: Problem) => void;
  onDiscontinueIntervention: (intervention: Intervention) => void;
}): JSX.Element {
  const sorted = [...problems].sort(
    (a, b) =>
      (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
      a.description.localeCompare(b.description),
  );

  const problemCount = problems.length;
  const goalCount = goals.length;
  const interventionCount = interventions.length;

  return (
    <section style={clinicalPanel}>
      <div style={clinicalHeader}>
        <div>
          <div style={eyebrow}>Clinical plan</div>
          <h2 style={clinicalTitle}>{heading}</h2>
          <p style={clinicalIntro}>
            Problems define what is being treated. Goals define the intended outcome, and
            interventions describe how the team will get there.
          </p>
        </div>

        {canAuthor ? (
          <button type="button" style={primaryBtn} onClick={() => onProblem()}>
            + Add problem
          </button>
        ) : null}
      </div>

      <div style={summaryStrip} aria-label="Care Plan summary">
        <SummaryFact label="Problems" value={problemCount} />
        <SummaryFact label="Goals" value={goalCount} />
        <SummaryFact label="Interventions" value={interventionCount} />
      </div>

      {readonly ? (
        <Notice tone="info">
          This version is read-only. Open a revision when the patient's condition, goals, or
          interventions need to change.
        </Notice>
      ) : null}

      {sorted.length === 0 ? (
        <EmptyState
          title="No problems recorded"
          description="Start with the clinical problem that anchors the patient's goals and interventions."
        />
      ) : (
        <div style={problemStack}>
          {sorted.map((problem) => {
            const problemGoals = goals.filter((g) => g.problemId === problem.id);
            const problemInterventions = interventions.filter((i) => i.problemId === problem.id);

            return (
              <article key={problem.id} style={problemCard}>
                <div style={problemHeader}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={problemBadges}>
                      <StatusPill
                        label={cap(problem.kind)}
                        tone={problem.kind === "terminal" ? "warning" : "neutral"}
                      />
                      <StatusPill label={cap(problem.status)} tone={toneFor(problem.status)} />
                      {problem.sudRelated ? (
                        <span style={restricted}>
                          <Glyph name="lock" size={12} /> SUD
                        </span>
                      ) : null}
                    </div>

                    <h3 style={problemTitle}>{problem.description}</h3>
                    <p style={problemPrimaryMeta}>
                      {problem.icd10Code ? `ICD-10 ${problem.icd10Code}` : cap(problem.source)}
                      {problem.onsetAt ? ` · Onset ${formatDate(problem.onsetAt)}` : ""}
                    </p>
                  </div>

                  {canAuthor && !readonly ? (
                    <details style={menuWrap}>
                      <summary style={menuButton} aria-label={`Actions for ${problem.description}`}>
                        <span aria-hidden="true">⋯</span>
                      </summary>
                      <div style={menuPopover}>
                        <button type="button" style={menuItem} onClick={() => onProblem(problem)}>
                          Edit problem
                        </button>
                        {problem.status === "active" ? (
                          <button
                            type="button"
                            style={menuItem}
                            onClick={() => onResolveProblem(problem)}
                          >
                            Resolve problem
                          </button>
                        ) : null}
                      </div>
                    </details>
                  ) : null}
                </div>

                {problem.snomedCode ||
                problem.resolvedAt ||
                problem.resolutionNote ||
                problem.source ? (
                  <details style={clinicalDetails}>
                    <summary style={clinicalDetailsSummary}>Clinical details</summary>
                    <div style={clinicalDetailsGrid}>
                      <DetailFact label="Source" value={cap(problem.source)} />
                      {problem.snomedCode ? (
                        <DetailFact label="SNOMED" value={problem.snomedCode} mono />
                      ) : null}
                      {problem.resolvedAt ? (
                        <DetailFact label="Resolved" value={formatDate(problem.resolvedAt)} />
                      ) : null}
                      {problem.resolutionNote ? (
                        <DetailFact label="Resolution note" value={problem.resolutionNote} wide />
                      ) : null}
                    </div>
                  </details>
                ) : null}

                <div style={careColumns}>
                  <div style={careColumn}>
                    <div style={subsectionHeader}>
                      <div>
                        <h4 style={careColumnTitle}>Goals</h4>
                        <span style={careColumnCount}>{problemGoals.length}</span>
                      </div>
                      {canAuthor && !readonly ? (
                        <button
                          type="button"
                          style={smallActionBtn}
                          onClick={() => onGoal(undefined, problem.id)}
                        >
                          + Add goal
                        </button>
                      ) : null}
                    </div>

                    {problemGoals.length ? (
                      problemGoals.map((goal) => (
                        <GoalRow
                          key={goal.id}
                          goal={goal}
                          editable={canAuthor && !readonly}
                          onEdit={() => onGoal(goal, problem.id)}
                        />
                      ))
                    ) : (
                      <p style={emptyInline}>No goals recorded for this problem.</p>
                    )}
                  </div>

                  <div style={careColumn}>
                    <div style={subsectionHeader}>
                      <div>
                        <h4 style={careColumnTitle}>Interventions</h4>
                        <span style={careColumnCount}>{problemInterventions.length}</span>
                      </div>
                      {canAuthor && !readonly ? (
                        <button
                          type="button"
                          style={smallActionBtn}
                          onClick={() => onIntervention(undefined, problem.id)}
                        >
                          + Add intervention
                        </button>
                      ) : null}
                    </div>

                    {problemInterventions.length ? (
                      problemInterventions.map((iv) => (
                        <InterventionRow
                          key={iv.id}
                          intervention={iv}
                          goals={plan.goals}
                          editable={canAuthor && !readonly}
                          onEdit={() => onIntervention(iv, problem.id)}
                          onDiscontinue={() => onDiscontinueIntervention(iv)}
                        />
                      ))
                    ) : (
                      <p style={emptyInline}>No interventions recorded for this problem.</p>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SummaryFact({
  label,
  value,
}: {
  label: string;
  value: number;
}): JSX.Element {
  return (
    <div style={summaryFact}>
      <strong style={summaryFactValue}>{value}</strong>
      <span style={summaryFactLabel}>{label}</span>
    </div>
  );
}

function DetailFact({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}): JSX.Element {
  return (
    <div style={{ ...detailFact, ...(wide ? { gridColumn: "1 / -1" } : {}) }}>
      <span style={fieldLabel}>{label}</span>
      <span
        style={{
          ...detailFactValue,
          ...(mono ? { fontFamily: t.fontMono } : {}),
        }}
      >
        {value}
      </span>
    </div>
  );
}

function RevisionPanel({
  plan,
  version,
  readiness,
  proposed,
  review,
  canAuthor,
  canFinalize,
  canSign,
  busy,
  onFinalize,
  onSign,
  onReturn,
  onStartRevision,
  onStartReview,
  onProblem,
  onGoal,
  onIntervention,
  onResolveProblem,
  onDiscontinueIntervention,
}: {
  plan: CarePlan;
  version: Version | null;
  readiness: Readiness | null;
  proposed: ProposedChanges | null;
  review: ReviewStatus | null;
  canAuthor: boolean;
  canFinalize: boolean;
  canSign: boolean;
  busy: boolean;
  onFinalize: (version: Version) => Promise<void>;
  onSign: (version: Version) => void;
  onReturn: (version: Version) => void;
  onStartRevision: () => void;
  onStartReview: () => void;
  onProblem: (problem?: Problem) => void;
  onGoal: (goal?: Goal, problemId?: string) => void;
  onIntervention: (intervention?: Intervention, problemId?: string) => void;
  onResolveProblem: (problem: Problem) => void;
  onDiscontinueIntervention: (intervention: Intervention) => void;
}): JSX.Element {
  if (!version) {
    return (
      <section style={panel}>
        <div style={emptyRevision}>
          <div>
            <h2 style={sectionTitle}>Review & Sign</h2>
            <p style={muted}>
              There is no open draft or review version. Open a revision when the patient's
              condition, goals, interventions, frequency, or discipline needs to change.
            </p>
          </div>
          <div style={actionsRow}>
            {canAuthor ? (
              <button type="button" style={ghostBtn} onClick={onStartRevision}>
                Document condition change
              </button>
            ) : null}
            {canAuthor && review?.canStartReview ? (
              <button type="button" style={primaryBtn} onClick={onStartReview}>
                Start scheduled review
              </button>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  const candidate = snapshotOf(version);
  const readonly = version.status === "in_review";
  const idgProposalRequired = version.kind === "idg_review" && !proposed?.changes.length;
  const blockers = uniqueBlockers(
    readiness,
    plan.problems.find((p) => p.kind === "terminal" && p.status === "active"),
  );

  return (
    <section style={panel}>
      <div style={revisionHeader}>
        <div>
          <div style={eyebrow}>{version.kind === "idg_review" ? "IDG review" : "Revision"}</div>
          <h2 style={sectionTitle}>Version v{version.sequence}</h2>
          <p style={muted}>
            {cap(version.status)} ·{" "}
            {version.idgMeetingId
              ? `Meeting ${version.idgMeetingId.slice(0, 8)}`
              : "Scheduled/manual review"}
          </p>
        </div>

        <StatusPill label={cap(version.status)} tone={toneFor(version.status)} />
      </div>

      <div style={revisionProgress}>
        <WorkflowSteps
          current={version.status === "in_review" ? 2 : readiness?.canFinalize ? 1 : 0}
        />
      </div>

      {version.status === "draft" ? (
        <section style={subPanel}>
          <div style={sectionHeader}>
            <div>
              <h3 style={smallTitle}>
                {idgProposalRequired
                  ? "Record IDG proposed changes"
                  : readiness?.canFinalize
                    ? "Ready for physician review"
                    : "Before you can send this version"}
              </h3>
              <p style={muted}>
                {idgProposalRequired
                  ? "An IDG review must contain at least one proposed Care Plan change. Record the IDG decision first, then send this version for signature."
                  : readiness?.canFinalize
                    ? "The current draft passes readiness checks. Sending it freezes the candidate version for hospice physician review and signature."
                    : "Resolve the remaining requirements, then review the candidate version."}
              </p>
            </div>

            {canFinalize ? (
              <button
                type="button"
                style={readiness?.canFinalize && !idgProposalRequired ? primaryBtn : disabledBtn}
                disabled={!readiness?.canFinalize || idgProposalRequired || busy}
                onClick={() => void onFinalize(version)}
              >
                Send to hospice physician
              </button>
            ) : null}
          </div>

          {blockers.length ? (
            <ul style={requirementList}>
              {blockers.map((blocker) => (
                <li key={blocker} style={requirementItem}>
                  <span style={requirementDot} />
                  <span>{blocker}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div style={readyLine}>
              <Glyph name="check-circle" size={16} />
              Ready to continue
            </div>
          )}

          <SignaturePanel readiness={readiness} version={version} />
        </section>
      ) : null}

      {version.status === "in_review" ? (
        <section style={subPanel}>
          <div style={sectionHeader}>
            <div>
              <h3 style={smallTitle}>Hospice physician review & signature</h3>
              <p style={muted}>
                Candidate content is frozen after care-plan manager review. Return to draft only
                when clinical edits are required before physician signature.
              </p>
            </div>
            <div style={actionsRow}>
              {canAuthor ? (
                <button type="button" style={ghostBtn} onClick={() => onReturn(version)}>
                  Return to draft
                </button>
              ) : null}
              {canSign && readiness?.canSign ? (
                <button type="button" style={primaryBtn} onClick={() => onSign(version)}>
                  Review & sign
                </button>
              ) : null}
            </div>
          </div>
          <SignaturePanel readiness={readiness} version={version} />
        </section>
      ) : null}

      {proposed?.changes.length ? <IdgProposal proposed={proposed} /> : null}

      {version.status === "in_review" && candidate ? (
        <SnapshotContent snapshot={candidate} />
      ) : (
        <ClinicalContent
          title="Draft clinical content"
          plan={plan}
          problems={plan.problems}
          goals={plan.goals}
          interventions={plan.interventions}
          readonly={readonly}
          canAuthor={canAuthor && !readonly}
          onProblem={onProblem}
          onGoal={onGoal}
          onIntervention={onIntervention}
          onResolveProblem={onResolveProblem}
          onDiscontinueIntervention={onDiscontinueIntervention}
        />
      )}
    </section>
  );
}

function IdgProposal({ proposed }: { proposed: ProposedChanges }): JSX.Element {
  return (
    <section style={subPanel}>
      <div>
        <h3 style={smallTitle}>IDG proposed changes</h3>
        <p style={muted}>
          These changes remain proposed until the governed review version is signed and published.
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
        {proposed.changes.map((change) => (
          <div key={change.id} style={diffRow}>
            <div>
              <strong>{cap(change.operation)}</strong>
              <p style={muted}>
                {cap(change.entityType)} · {cap(change.status)}
              </p>
            </div>
            <Diff before={change.before} proposed={change.proposed} />
          </div>
        ))}
      </div>
    </section>
  );
}

function HistoryPanel({
  plan,
  selectedVersion,
  onSelect,
}: {
  plan: CarePlan;
  selectedVersion: Version | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <section style={panel}>
      <div>
        <h2 style={sectionTitle}>Version history</h2>
        <p style={muted}>
          Inspect each signed, superseded, draft, and review version without changing the active
          plan. Signed versions preserve the clinical snapshot that was reviewed and signed.
        </p>
      </div>
      <div style={historyGrid}>
        <div style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
          {[...plan.versions]
            .sort((a, b) => b.sequence - a.sequence)
            .map((v) => (
              <button
                key={v.id}
                type="button"
                style={selectedVersion?.id === v.id ? selectedVersionBtn : versionBtn}
                onClick={() => onSelect(v.id)}
              >
                <span>
                  v{v.sequence} · {cap(v.kind)}
                </span>
                <StatusPill label={cap(v.status)} tone={toneFor(v.status)} />
                <span style={muted}>
                  {v.signedAt
                    ? `Signed ${formatDate(v.signedAt)}`
                    : `Drafted ${formatDate(v.draftedAt)}`}
                </span>
              </button>
            ))}
        </div>
        <VersionSnapshot version={selectedVersion} />
      </div>
    </section>
  );
}

function SnapshotContent({
  snapshot,
}: {
  snapshot: ClinicalSnapshot;
}): JSX.Element {
  return (
    <section style={subPanel}>
      <h3 style={smallTitle}>Candidate snapshot</h3>
      <SnapshotLists snapshot={snapshot} />
    </section>
  );
}

function VersionSnapshot({
  version,
}: {
  version: Version | null;
}): JSX.Element {
  if (!version)
    return <EmptyState title="No version selected" description="Choose a version to inspect." />;
  const snapshot = snapshotOf(version);
  return (
    <article style={subPanel}>
      <div style={sectionHeader}>
        <div>
          <h3 style={smallTitle}>
            v{version.sequence} · {cap(version.kind)}
          </h3>
          <p style={muted}>
            {cap(version.status)} · drafted {formatDate(version.draftedAt)}
            {version.signedAt ? ` · signed ${formatDate(version.signedAt)}` : ""}
            {version.supersededAt ? ` · superseded ${formatDate(version.supersededAt)}` : ""}
          </p>
        </div>
        <StatusPill label={cap(version.status)} tone={toneFor(version.status)} />
      </div>
      <SignatureList slots={version.requiredSignerSet} signatures={version.signatures} />
      {snapshot ? (
        <SnapshotLists snapshot={snapshot} />
      ) : (
        <Notice tone="warning">
          Detailed historical snapshot unavailable for this legacy version.
        </Notice>
      )}
    </article>
  );
}

function SnapshotLists({
  snapshot,
}: {
  snapshot: ClinicalSnapshot;
}): JSX.Element {
  const problems = snapshot.problems ?? [];
  const goals = snapshot.goals ?? [];
  const interventions = snapshot.interventions ?? [];
  return (
    <div style={{ display: "grid", gap: t.space3 }}>
      <SnapshotGroup
        title="Problems"
        items={problems.map((p) => `${p.description} · ${cap(p.kind)} · ${cap(p.status)}`)}
      />
      <SnapshotGroup
        title="Goals"
        items={goals.map((g) => `${g.revisedText ?? g.originalText} · ${cap(g.status)}`)}
      />
      <SnapshotGroup
        title="Interventions"
        items={interventions.map(
          (i) => `${i.scopeText} · ${cap(i.discipline)} · ${i.frequencyText} · ${cap(i.status)}`,
        )}
      />
    </div>
  );
}

function SignaturePanel({
  readiness,
  version,
}: {
  readiness: Readiness | null;
  version: Version;
}): JSX.Element {
  const slots = readiness?.signatures.required.length
    ? readiness.signatures.required
    : version.requiredSignerSet;
  const signatures = readiness?.signatures.collected.length
    ? readiness.signatures.collected
    : version.signatures;
  return (
    <div style={signaturePanelInner}>
      <SignatureList slots={slots} signatures={signatures} />
      {readiness?.signatures.missing.length ? (
        <p style={muted}>
          Missing:{" "}
          {readiness.signatures.missing.map((s) => `${roleLabel(s.role)} (${s.count})`).join(", ")}
        </p>
      ) : (
        <p style={muted}>No missing signatures reported by the backend.</p>
      )}
    </div>
  );
}

function roleSatisfiesSlot(slotRole: string, signerRole: string): boolean {
  return slotRole.split("|").includes(signerRole);
}

function roleLabel(role: string): string {
  return role.split("|").map(cap).join(" or ");
}

function preferredSigningRole(slotRole: string): string {
  return (
    slotRole.split("|").find((role) => role === "hospice_physician") ?? slotRole.split("|")[0] ?? ""
  );
}

function signingRoleOptions(slots: SignerSlot[]): { value: string; label: string }[] {
  const roles = new Set<string>();
  for (const slot of slots) {
    for (const role of slot.role.split("|")) roles.add(role);
  }
  return [...roles].map((role) => ({ value: role, label: roleLabel(role) }));
}

function SignatureList({
  slots,
  signatures,
}: {
  slots: SignerSlot[];
  signatures: { signerRole: string; signedAt: string | null }[];
}): JSX.Element {
  return (
    <div style={lineWrap}>
      {slots.map((slot) => {
        const count = signatures.filter((s) => roleSatisfiesSlot(slot.role, s.signerRole)).length;
        return (
          <span key={slot.role} style={signatureChip}>
            <Glyph name={count >= slot.count ? "check-circle" : "clock"} size={14} />
            {roleLabel(slot.role)} · {count} of {slot.count}
          </span>
        );
      })}
    </div>
  );
}

function GoalRow({
  goal,
  editable,
  onEdit,
}: {
  goal: Goal;
  editable: boolean;
  onEdit: () => void;
}): JSX.Element {
  return (
    <div style={row}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={rowTitle}>{goal.revisedText ?? goal.originalText}</p>
        <p style={muted}>
          {goal.measurableOutcome ?? "No measurable outcome"} · target {formatDate(goal.targetAt)}
          {goal.statusNote ? ` · ${goal.statusNote}` : ""}
        </p>
      </div>
      <StatusPill label={cap(goal.status)} tone={toneFor(goal.status)} />
      {editable ? (
        <button type="button" style={iconTextBtn} onClick={onEdit}>
          Edit
        </button>
      ) : null}
    </div>
  );
}

function InterventionRow({
  intervention,
  goals,
  editable,
  onEdit,
  onDiscontinue,
}: {
  intervention: Intervention;
  goals: Goal[];
  editable: boolean;
  onEdit: () => void;
  onDiscontinue: () => void;
}): JSX.Element {
  const linkedGoals = goals.filter((g) => intervention.goalRefs.includes(g.id));
  return (
    <div style={row}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={rowTitle}>{intervention.scopeText}</p>
        <p style={muted}>
          {disciplineLabel(intervention.discipline)} · {intervention.frequencyText} ·{" "}
          {intervention.frequencyValue}
          {linkedGoals.length
            ? ` · linked to ${linkedGoals.map((g) => g.revisedText ?? g.originalText).join(", ")}`
            : ""}
          {intervention.linkedOrderId ? " · linked order present" : ""}
        </p>
        {intervention.discontinueReason ? (
          <p style={muted}>{intervention.discontinueReason}</p>
        ) : null}
      </div>
      <StatusPill label={cap(intervention.status)} tone={toneFor(intervention.status)} />
      {editable ? (
        <details style={menuWrap}>
          <summary style={rowMenuButton} aria-label="Intervention actions">
            <span aria-hidden="true">⋯</span>
          </summary>
          <div style={menuPopover}>
            <button type="button" style={menuItem} onClick={onEdit}>
              Edit intervention
            </button>
            {intervention.status === "active" ? (
              <button type="button" style={menuItem} onClick={onDiscontinue}>
                Discontinue
              </button>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function CarePlanModal({
  state,
  plan,
  goals,
  problems,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  state: NonNullable<ModalState>;
  plan: CarePlan;
  goals: Goal[];
  problems: Problem[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (action: () => Promise<{ error?: unknown }>, success: string) => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const title =
    state.kind === "problem"
      ? state.problem
        ? "Edit problem"
        : "Add problem"
      : state.kind === "resolve_problem"
        ? "Resolve problem"
        : state.kind === "goal"
          ? state.goal
            ? "Edit goal"
            : "Add goal"
          : state.kind === "intervention"
            ? state.intervention
              ? "Edit intervention"
              : "Add intervention"
            : state.kind === "discontinue_intervention"
              ? "Discontinue intervention"
              : state.kind === "sign"
                ? "Sign Care Plan version"
                : "Return to draft";
  return (
    <Modal open onClose={onClose} ariaLabel={title} width="40rem">
      <div style={modalBody}>
        <h2 style={sectionTitle}>{title}</h2>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {state.kind === "problem" ? (
          <ProblemForm state={state} plan={plan} busy={busy} error={error} onSubmit={onSubmit} />
        ) : null}
        {state.kind === "resolve_problem" ? (
          <NoteForm
            label="Resolution note"
            busy={busy}
            submitLabel="Resolve"
            onSubmit={(note) =>
              onSubmit(
                async () =>
                  client.POST("/api/v1/care-plans/{planId}/problems/{elementId}/resolve", {
                    params: {
                      path: { planId: plan.id, elementId: state.problem.id },
                    },
                    body: {
                      ifVersion: state.problem.version,
                      resolutionNote: note,
                    },
                  } as never),
                "Problem resolved.",
              )
            }
          />
        ) : null}
        {state.kind === "goal" ? (
          <GoalForm
            state={state}
            plan={plan}
            problems={problems}
            busy={busy}
            error={error}
            onSubmit={onSubmit}
          />
        ) : null}
        {state.kind === "intervention" ? (
          <InterventionForm
            state={state}
            plan={plan}
            problems={problems}
            goals={goals}
            busy={busy}
            error={error}
            onSubmit={onSubmit}
          />
        ) : null}
        {state.kind === "discontinue_intervention" ? (
          <NoteForm
            label="Discontinuation reason"
            busy={busy}
            submitLabel="Discontinue"
            onSubmit={(reason) =>
              onSubmit(
                async () =>
                  client.POST("/api/v1/care-plans/{planId}/interventions/{elementId}/discontinue", {
                    params: {
                      path: {
                        planId: plan.id,
                        elementId: state.intervention.id,
                      },
                    },
                    body: { ifVersion: state.intervention.version, reason },
                  } as never),
                "Intervention discontinued.",
              )
            }
          />
        ) : null}
        {state.kind === "sign" ? (
          <SignForm state={state} plan={plan} busy={busy} error={error} onSubmit={onSubmit} />
        ) : null}
        {state.kind === "return_to_draft" ? (
          <ConfirmPanel
            busy={busy}
            text="Returning this version to draft invalidates existing signatures. Active signed Care Plan content is not changed."
            label="Return to draft"
            onConfirm={() =>
              onSubmit(
                async () =>
                  client.POST("/api/v1/care-plans/{planId}/versions/{versionId}/return-to-draft", {
                    params: {
                      path: { planId: plan.id, versionId: state.version.id },
                    },
                    body: { ifVersion: state.version.version },
                  } as never),
                "Version returned to draft.",
              )
            }
          />
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" style={ghostBtn} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ProblemForm({
  state,
  plan,
  busy,
  error,
  onSubmit,
}: {
  state: Extract<NonNullable<ModalState>, { kind: "problem" }>;
  plan: CarePlan;
  busy: boolean;
  error: string | null;
  onSubmit: (action: () => Promise<{ error?: unknown }>, success: string) => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const [description, setDescription] = useState(state.problem?.description ?? "");
  const [kind, setKind] = useState(state.problem?.kind ?? "related");
  const [source, setSource] = useState(state.problem?.source ?? "clinical");
  const [icd10Code, setIcd10Code] = useState(state.problem?.icd10Code ?? "");
  const [snomedCode, setSnomedCode] = useState(state.problem?.snomedCode ?? "");
  const [snomedSuggestions, setSnomedSuggestions] = useState<TerminologyConcept[]>([]);
  const [terminologyStatus, setTerminologyStatus] = useState<
    "idle" | "loading" | "empty" | "error"
  >("idle");
  const [sudRelated, setSudRelated] = useState(state.problem?.sudRelated ?? false);

  useEffect(() => {
    const code = icd10Code.trim().toUpperCase();
    if (code.length < 3) {
      setSnomedSuggestions([]);
      setTerminologyStatus("idle");
      return;
    }

    let cancelled = false;
    setTerminologyStatus("loading");

    async function loadSnomedSuggestions(): Promise<void> {
      try {
        const lookup = await client.GET("/api/v1/terminology/{system}/{code}", {
          params: {
            path: {
              system: "icd10cm",
              code,
            },
          },
        } as never);

        const concept = lookup.data as TerminologyConcept | undefined;
        const query = concept?.display?.trim() || description.trim() || code;
        const search = await client.GET("/api/v1/terminology/{system}/search", {
          params: {
            path: {
              system: "snomed",
            },
            query: {
              q: query,
              mode: "fuzzy",
              limit: 5,
            },
          },
        } as never);

        if (cancelled) return;
        if (search.error) {
          setSnomedSuggestions([]);
          setTerminologyStatus("error");
          return;
        }

        const results = (
          (search.data as { results?: TerminologyConcept[] } | undefined)?.results ?? []
        ).filter((item) => item.code);
        setSnomedSuggestions(results);
        setTerminologyStatus(results.length ? "idle" : "empty");
      } catch {
        if (!cancelled) {
          setSnomedSuggestions([]);
          setTerminologyStatus("error");
        }
      }
    }

    const timer = window.setTimeout(() => void loadSnomedSuggestions(), 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, description, icd10Code]);

  return (
    <form
      style={form}
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(
          async () =>
            state.problem
              ? client.PATCH("/api/v1/care-plans/{planId}/problems/{elementId}", {
                  params: {
                    path: { planId: plan.id, elementId: state.problem.id },
                    header: writeHeaders(state.problem.version),
                  },
                  body: {
                    description,
                    kind,
                    icd10Code: icd10Code || undefined,
                    snomedCode: snomedCode || undefined,
                  },
                } as never)
              : client.POST("/api/v1/care-plans/{planId}/problems", {
                  params: { path: { planId: plan.id } },
                  body: {
                    description,
                    kind,
                    source,
                    icd10Code: icd10Code || undefined,
                    snomedCode: snomedCode || undefined,
                    sudRelated,
                  },
                } as never),
          state.problem ? "Problem updated." : "Problem added.",
        );
      }}
    >
      <FormSection
        title="Clinical problem"
        description="Describe the condition or need that this part of the Care Plan will address."
      >
        <TextField
          label="Problem description"
          value={description}
          onChange={setDescription}
          placeholder="e.g. End-stage heart failure with dyspnea"
          required
          error={fieldError(error, "description")}
        />
        <div style={fieldGrid2}>
          <Select
            label="Problem type"
            value={kind}
            onChange={setKind}
            options={PROBLEM_KINDS}
            hint="Terminal problems anchor the hospice plan of care."
            error={fieldError(error, "kind")}
          />
          {!state.problem ? (
            <Select
              label="Source"
              value={source}
              onChange={setSource}
              options={PROBLEM_SOURCES}
              error={fieldError(error, "source")}
            />
          ) : null}
        </div>
      </FormSection>

      <FormSection
        title="Clinical coding"
        description="Add coding when available. SNOMED suggestions are based on the ICD-10 code."
      >
        <div style={fieldGrid2}>
          <TextField
            label="ICD-10 code"
            value={icd10Code}
            onChange={(value) => setIcd10Code(value.toUpperCase())}
            placeholder="e.g. I50.84"
            error={fieldError(error, "icd10Code")}
          />
          <TextField
            label="SNOMED code"
            value={snomedCode}
            onChange={setSnomedCode}
            placeholder="Optional"
            error={fieldError(error, "snomedCode")}
          />
        </div>
        <SnomedSuggestionList
          status={terminologyStatus}
          suggestions={snomedSuggestions}
          onSelect={(code) => setSnomedCode(code)}
        />
      </FormSection>

      {!state.problem ? (
        <FormSection title="Sensitive-content flag">
          <label
            style={checkCard}
            title="Substance Use Disorder-related: marks care-plan content connected to alcohol or drug use disorder history, assessment, treatment, or disclosure-sensitive services."
          >
            <input
              type="checkbox"
              checked={sudRelated}
              onChange={(e) => setSudRelated(e.target.checked)}
              aria-describedby="sud-related-definition"
            />
            <span>
              <strong style={checkTitle}>SUD-related</strong>
              <span id="sud-related-definition" style={checkHint}>
                Mark this only when the problem contains substance-use-disorder-related information.
              </span>
            </span>
          </label>
        </FormSection>
      ) : null}

      <div style={formActions}>
        <button type="submit" style={primaryBtn} disabled={busy || !description.trim()}>
          {busy ? "Saving..." : "Save problem"}
        </button>
      </div>
    </form>
  );
}

function SnomedSuggestionList({
  status,
  suggestions,
  onSelect,
}: {
  status: "idle" | "loading" | "empty" | "error";
  suggestions: TerminologyConcept[];
  onSelect: (code: string) => void;
}): JSX.Element | null {
  if (status === "idle" && suggestions.length === 0) return null;

  if (status === "loading") {
    return <p style={muted}>Looking for SNOMED suggestions...</p>;
  }

  if (status === "error") {
    return (
      <p style={muted}>
        SNOMED suggestions are unavailable. You can enter the SNOMED code manually.
      </p>
    );
  }

  if (status === "empty") {
    return (
      <p style={muted}>
        No SNOMED match was found for this ICD-10 code. You can enter the SNOMED code manually.
      </p>
    );
  }

  return (
    <div style={suggestionPanel}>
      <span style={fieldLabel}>SNOMED suggestions</span>
      <div style={lineWrap}>
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.code}
            type="button"
            style={suggestionBtn}
            onClick={() => onSelect(suggestion.code)}
            title={suggestion.display}
          >
            <span>{suggestion.code}</span>
            {suggestion.display ? <small style={suggestionText}>{suggestion.display}</small> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function GoalForm({
  state,
  plan,
  problems,
  busy,
  error,
  onSubmit,
}: {
  state: Extract<NonNullable<ModalState>, { kind: "goal" }>;
  plan: CarePlan;
  problems: Problem[];
  busy: boolean;
  error: string | null;
  onSubmit: (action: () => Promise<{ error?: unknown }>, success: string) => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const [problemId, setProblemId] = useState(
    state.goal?.problemId ?? state.problemId ?? problems[0]?.id ?? "",
  );
  const [text, setText] = useState(state.goal?.revisedText ?? state.goal?.originalText ?? "");
  const [source, setSource] = useState(state.goal?.source ?? "clinical");
  const [outcome, setOutcome] = useState(state.goal?.measurableOutcome ?? "");
  const [targetAt, setTargetAt] = useState(state.goal?.targetAt?.slice(0, 10) ?? "");
  const [status, setStatus] = useState(state.goal?.status ?? "not_started");
  return (
    <form
      style={form}
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(
          async () =>
            state.goal
              ? client.PATCH("/api/v1/care-plans/{planId}/goals/{elementId}", {
                  params: {
                    path: { planId: plan.id, elementId: state.goal.id },
                    header: writeHeaders(state.goal.version),
                  },
                  body: {
                    revisedText: text,
                    measurableOutcome: outcome || undefined,
                    status,
                    targetAt: targetAt ? new Date(targetAt).toISOString() : undefined,
                  },
                } as never)
              : client.POST("/api/v1/care-plans/{planId}/goals", {
                  params: { path: { planId: plan.id } },
                  body: {
                    problemId,
                    originalText: text,
                    source,
                    measurableOutcome: outcome || undefined,
                    targetAt: targetAt ? new Date(targetAt).toISOString() : undefined,
                  },
                } as never),
          state.goal ? "Goal updated." : "Goal added.",
        );
      }}
    >
      <FormSection
        title="Goal"
        description="Describe the patient-centered result the team is working toward."
      >
        {!state.goal ? (
          <Select
            label="Linked problem"
            value={problemId}
            onChange={setProblemId}
            options={problems.map((p) => ({
              value: p.id,
              label: p.description,
            }))}
          />
        ) : null}
        <TextArea
          label="Goal statement"
          value={text}
          onChange={setText}
          placeholder="e.g. Patient will report dyspnea is manageable at rest"
          required
          error={fieldError(error, "originalText") ?? fieldError(error, "revisedText")}
        />
      </FormSection>

      <FormSection title="Outcome & timing">
        <TextField
          label="Measurable outcome"
          value={outcome}
          onChange={setOutcome}
          placeholder="e.g. Dyspnea rated 3/10 or less at rest"
          error={fieldError(error, "measurableOutcome")}
        />
        <div style={fieldGrid2}>
          <TextField label="Target date" value={targetAt} onChange={setTargetAt} type="date" />
          {state.goal ? (
            <Select label="Status" value={status} onChange={setStatus} options={GOAL_STATUSES} />
          ) : !state.goal ? (
            <Select label="Source" value={source} onChange={setSource} options={GOAL_SOURCES} />
          ) : null}
        </div>
      </FormSection>

      <div style={formActions}>
        <button type="submit" style={primaryBtn} disabled={busy || !text.trim() || !problemId}>
          {busy ? "Saving..." : "Save goal"}
        </button>
      </div>
    </form>
  );
}

function InterventionForm({
  state,
  plan,
  problems,
  goals,
  busy,
  error,
  onSubmit,
}: {
  state: Extract<NonNullable<ModalState>, { kind: "intervention" }>;
  plan: CarePlan;
  problems: Problem[];
  goals: Goal[];
  busy: boolean;
  error: string | null;
  onSubmit: (action: () => Promise<{ error?: unknown }>, success: string) => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const [problemId, setProblemId] = useState(
    state.intervention?.problemId ?? state.problemId ?? problems[0]?.id ?? "",
  );
  const [scopeText, setScopeText] = useState(state.intervention?.scopeText ?? "");
  const [frequencyText, setFrequencyText] = useState(state.intervention?.frequencyText ?? "");
  const [frequencyValue, setFrequencyValue] = useState(state.intervention?.frequencyValue ?? "");
  const [discipline, setDiscipline] = useState(state.intervention?.discipline ?? "rn");
  const [responsibleRole, setResponsibleRole] = useState(state.intervention?.responsibleRole ?? "");
  const [goalRef, setGoalRef] = useState(state.intervention?.goalRefs[0] ?? "");
  const goalOptions = goals
    .filter((g) => g.problemId === problemId)
    .map((g) => ({ value: g.id, label: g.revisedText ?? g.originalText }));
  return (
    <form
      style={form}
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(
          async () =>
            state.intervention
              ? client.PATCH("/api/v1/care-plans/{planId}/interventions/{elementId}", {
                  params: {
                    path: {
                      planId: plan.id,
                      elementId: state.intervention.id,
                    },
                    header: writeHeaders(state.intervention.version),
                  },
                  body: {
                    scopeText,
                    frequencyText,
                    frequencyValue,
                    responsibleRole: responsibleRole || undefined,
                  },
                } as never)
              : client.POST("/api/v1/care-plans/{planId}/interventions", {
                  params: { path: { planId: plan.id } },
                  body: {
                    problemId,
                    goalRefs: goalRef ? [goalRef] : [],
                    scopeText,
                    frequencyText,
                    frequencyValue,
                    discipline,
                    responsibleRole: responsibleRole || undefined,
                  },
                } as never),
          state.intervention ? "Intervention updated." : "Intervention added.",
        );
      }}
    >
      <FormSection
        title="Intervention"
        description="Describe what the care team should do for this problem."
      >
        {!state.intervention ? (
          <Select
            label="Linked problem"
            value={problemId}
            onChange={setProblemId}
            options={problems.map((p) => ({
              value: p.id,
              label: p.description,
            }))}
          />
        ) : null}
        <TextArea
          label="Intervention / scope"
          value={scopeText}
          onChange={setScopeText}
          placeholder="e.g. Assess respiratory status and reinforce comfort measures"
          required
          error={fieldError(error, "scopeText")}
        />
      </FormSection>

      <FormSection
        title="Schedule"
        description="Keep the frequency wording and its structured value together."
      >
        <div style={fieldGrid2}>
          <TextField
            label="Frequency"
            value={frequencyText}
            onChange={setFrequencyText}
            placeholder="e.g. Twice weekly"
            required
            error={fieldError(error, "frequencyText")}
          />
          <TextField
            label="Frequency value"
            value={frequencyValue}
            onChange={setFrequencyValue}
            placeholder="e.g. 2"
            required
            error={fieldError(error, "frequencyValue")}
          />
        </div>
      </FormSection>

      <FormSection title="Assignment & relationship">
        <div style={fieldGrid2}>
          {!state.intervention ? (
            <Select
              label="Discipline"
              value={discipline}
              onChange={setDiscipline}
              options={DISCIPLINES}
            />
          ) : null}
          <TextField
            label="Responsible role"
            value={responsibleRole}
            onChange={setResponsibleRole}
            placeholder="e.g. Primary RN"
          />
        </div>
        {!state.intervention ? (
          <Select
            label="Linked goal"
            value={goalRef}
            onChange={setGoalRef}
            options={[{ value: "", label: "No linked goal" }, ...goalOptions]}
            hint="Optional. Link the intervention to the goal it supports."
          />
        ) : null}
      </FormSection>

      <div style={formActions}>
        <button
          type="submit"
          style={primaryBtn}
          disabled={busy || !scopeText.trim() || !frequencyText.trim() || !frequencyValue.trim()}
        >
          {busy ? "Saving..." : "Save intervention"}
        </button>
      </div>
    </form>
  );
}

function SignForm({
  state,
  plan,
  busy,
  error,
  onSubmit,
}: {
  state: Extract<NonNullable<ModalState>, { kind: "sign" }>;
  plan: CarePlan;
  busy: boolean;
  error: string | null;
  onSubmit: (action: () => Promise<{ error?: unknown }>, success: string) => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const openSlot = state.version.requiredSignerSet.find(
    (slot) =>
      state.version.signatures.filter((s) => roleSatisfiesSlot(slot.role, s.signerRole)).length <
      slot.count,
  );
  const [role, setRole] = useState(
    preferredSigningRole(openSlot?.role ?? state.version.requiredSignerSet[0]?.role ?? ""),
  );
  const [understanding, setUnderstanding] = useState("");
  return (
    <form
      style={form}
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(
          async () =>
            client.POST("/api/v1/care-plans/{planId}/versions/{versionId}/signatures", {
              params: {
                path: { planId: plan.id, versionId: state.version.id },
              },
              body: {
                ifVersion: state.version.version,
                signerRole: role,
                patientUnderstandingText: understanding || undefined,
              },
            } as never),
          "Signature recorded.",
        );
      }}
    >
      <SignatureList
        slots={state.version.requiredSignerSet}
        signatures={state.version.signatures}
      />
      <Select
        label="Signing role"
        value={role}
        onChange={setRole}
        options={signingRoleOptions(state.version.requiredSignerSet)}
      />
      <TextArea
        label="Patient/family understanding note"
        value={understanding}
        onChange={setUnderstanding}
        error={fieldError(error, "patientUnderstandingText")}
      />
      <Notice tone="info">
        The backend validates permission, signer role, caseload, authenticated membership, and
        step-up freshness.
      </Notice>
      <button type="submit" style={primaryBtn} disabled={busy || !role}>
        {busy ? "Signing..." : "Sign care plan"}
      </button>
    </form>
  );
}

function NoteForm({
  label,
  submitLabel,
  busy,
  onSubmit,
}: {
  label: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (note: string) => Promise<void>;
}): JSX.Element {
  const [note, setNote] = useState("");
  return (
    <form
      style={form}
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(note);
      }}
    >
      <TextArea label={label} value={note} onChange={setNote} required />
      <button type="submit" style={primaryBtn} disabled={busy || !note.trim()}>
        {busy ? "Saving..." : submitLabel}
      </button>
    </form>
  );
}

function ConfirmPanel({
  text,
  label,
  busy,
  onConfirm,
}: {
  text: string;
  label: string;
  busy: boolean;
  onConfirm: () => Promise<void>;
}): JSX.Element {
  return (
    <div style={form}>
      <Notice tone="warning">{text}</Notice>
      <button type="button" style={primaryBtn} disabled={busy} onClick={() => void onConfirm()}>
        {busy ? "Working..." : label}
      </button>
    </div>
  );
}

function FormSection({
  title: heading,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section style={formSection}>
      <div>
        <h3 style={formSectionTitle}>{heading}</h3>
        {description ? <p style={formSectionDescription}>{description}</p> : null}
      </div>
      <div style={formSectionBody}>{children}</div>
    </section>
  );
}

/** Turn structured backend validation into actionable copy while retaining its exact reason. */
function carePlanErrorMessage(error: unknown, fallback: string): string {
  const payload = error as {
    message?: string;
    error?: { message?: string; details?: Array<{ field?: string; message?: string }> };
    details?: Array<{ field?: string; message?: string }>;
  };
  const details = payload.error?.details ?? payload.details ?? [];
  if (!details.length) return errorMessage(error, fallback);
  const labels: Record<string, string> = {
    source: "Source",
    kind: "Problem type",
    description: "Problem description",
  };
  return `Please review the highlighted field${details.length > 1 ? "s" : ""}. ${details
    .map((detail) => {
      const field = detail.field ?? "form";
      const reason = detail.message ?? "The value is not accepted.";
      const guidance = field === "source" ? "Choose one of the available source options." : reason;
      return `${labels[field] ?? field}: ${guidance}${guidance === reason ? "" : ` (${reason})`}`;
    })
    .join(" ")}`;
}

/** Fastify schema errors name the rejected body property; keep that feedback by its input. */
function fieldError(message: string | null, property: string): string | null {
  if (!message) return null;
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:body[/.]|\\b)${escaped}\\b`, "i").test(message) ? message : null;
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  placeholder,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  error?: string | null;
}): JSX.Element {
  return (
    <label style={field}>
      <span style={fieldLabel}>
        {label}
        {required ? <span style={requiredMark}> *</span> : null}
      </span>
      <input
        aria-label={label}
        value={value}
        type={type}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={input}
      />
      {error ? <span style={fieldErrorText}>{error}</span> : null}
      {hint ? <span style={fieldHint}>{hint}</span> : null}
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  required = false,
  placeholder,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  error?: string | null;
}): JSX.Element {
  return (
    <label style={field}>
      <span style={fieldLabel}>
        {label}
        {required ? <span style={requiredMark}> *</span> : null}
      </span>
      <textarea
        aria-label={label}
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        style={textarea}
      />
      {error ? <span style={fieldErrorText}>{error}</span> : null}
      {hint ? <span style={fieldHint}>{hint}</span> : null}
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly (string | { value: string; label: string })[];
  hint?: string;
  error?: string | null;
}): JSX.Element {
  return (
    <label style={field}>
      <span style={fieldLabel}>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={input}
      >
        {options.map((o) => {
          const item = typeof o === "string" ? { value: o, label: cap(o) } : o;
          return (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          );
        })}
      </select>
      {error ? <span style={fieldErrorText}>{error}</span> : null}
      {hint ? <span style={fieldHint}>{hint}</span> : null}
    </label>
  );
}

function SnapshotGroup({
  title: heading,
  items,
}: {
  title: string;
  items: string[];
}): JSX.Element {
  return (
    <div>
      <h4 style={miniTitle}>{heading}</h4>
      {items.length ? (
        <ul style={plainList}>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p style={muted}>None recorded.</p>
      )}
    </div>
  );
}

function Diff({
  before,
  proposed,
}: {
  before: unknown;
  proposed: unknown;
}): JSX.Element {
  return (
    <div style={diffGrid}>
      <DiffValue label="Current" value={before} />
      <DiffValue label="Proposed" value={proposed} />
    </div>
  );
}

function DiffValue({
  label,
  value,
}: {
  label: string;
  value: unknown;
}): JSX.Element {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const text =
    record?.description ??
    record?.originalText ??
    record?.revisedText ??
    record?.scopeText ??
    record?.status ??
    (value == null ? "New item" : String(value));
  return (
    <div>
      <span style={fieldLabel}>{label}</span>
      <p style={muted}>{String(text)}</p>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      style={active ? activeTab : tabBtn}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning" | "error" | "success";
  children: ReactNode;
}): JSX.Element {
  const color =
    tone === "error"
      ? t.error
      : tone === "warning"
        ? t.warning
        : tone === "success"
          ? t.successPillFg // F-077 (#190) — `t.success` as text on white is 4.33:1, fails WCAG AA
          : t.primary;
  return (
    <div role={tone === "error" ? "alert" : "status"} style={{ ...noticeStyle, color }}>
      {children}
    </div>
  );
}

const workspace: CSSProperties = {
  display: "flex",
  height: "100%",
  minHeight: 0,
};
const mainPane: CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "1.125rem 1.5rem 1.5rem",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: t.space4,
};
const sectionTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.08rem",
  color: t.onSurface,
};
const smallTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 600,
  fontSize: "0.96rem",
  color: t.onSurface,
};
const miniTitle: CSSProperties = {
  margin: 0,
  fontSize: "0.73rem",
  fontWeight: 800,
  color: t.onSurfaceVariant,
};
const muted: CSSProperties = {
  margin: 0,
  color: t.onSurfaceVariant,
  fontSize: "0.82rem",
};
const actionsRow: CSSProperties = {
  display: "flex",
  gap: t.space2,
  flexWrap: "wrap",
  alignItems: "center",
};
const primaryBtn: CSSProperties = {
  border: "none",
  borderRadius: t.radiusMd,
  background: t.primary,
  color: t.onPrimary,
  cursor: "pointer",
  fontWeight: 700,
  padding: "0.52rem 0.82rem",
  fontSize: "0.82rem",
};
const ghostBtn: CSSProperties = {
  border: ghostBorder,
  borderRadius: t.radiusMd,
  background: t.surfaceContainer,
  color: t.onSurface,
  cursor: "pointer",
  fontWeight: 700,
  padding: "0.48rem 0.8rem",
  fontSize: "0.82rem",
  textDecoration: "none",
};
const disabledBtn: CSSProperties = {
  ...ghostBtn,
  cursor: "not-allowed",
  opacity: 0.55,
};
const iconTextBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  color: t.primary,
  cursor: "pointer",
  fontWeight: 700,
  fontSize: "0.76rem",
  padding: "0.15rem 0.2rem",
};
const textAction: CSSProperties = {
  ...iconTextBtn,
  padding: 0,
};
const panel: CSSProperties = {
  ...cardSurface,
  display: "flex",
  flexDirection: "column",
  gap: t.space4,
  padding: t.space5,
};
const clinicalPanel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space4,
  padding: `${t.space2} 0 ${t.space5}`,
};
const clinicalHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: t.space4,
  flexWrap: "wrap",
};
const clinicalTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontSans,
  fontWeight: 700,
  fontSize: "1.125rem",
  color: t.onSurface,
};
const clinicalIntro: CSSProperties = {
  ...muted,
  marginTop: "0.35rem",
  maxWidth: "48rem",
  lineHeight: 1.5,
};
const summaryStrip: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: t.space2,
  flexWrap: "wrap",
  padding: "0.7rem 0",
  borderTop: ghostBorder,
  borderBottom: ghostBorder,
};
const summaryFact: CSSProperties = {
  display: "inline-flex",
  alignItems: "baseline",
  gap: "0.35rem",
  paddingRight: t.space4,
};
const summaryFactValue: CSSProperties = {
  fontSize: "1rem",
  color: t.onSurface,
  fontWeight: 750,
};
const summaryFactLabel: CSSProperties = {
  fontSize: "0.76rem",
  color: t.onSurfaceVariant,
};

const subPanel: CSSProperties = {
  border: ghostBorder,
  borderRadius: t.radiusMd,
  padding: t.space4,
  display: "flex",
  flexDirection: "column",
  gap: t.space3,
  background: t.surfaceLow,
};
// Same card language as the stat cards: even hairline border, the state carried by the tinted icon.
const workflowCard: CSSProperties = {
  border: `1px solid ${t.cardBorder}`,
  borderRadius: t.radiusLg,
  background: t.surfaceLowest,
  padding: "1rem 1.125rem",
  display: "flex",
  flexDirection: "column",
  gap: t.space3,
};
const workflowLead: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: t.space3,
  minWidth: 0,
};
const workflowIcon = (color: string): CSSProperties => ({
  width: "2.75rem",
  height: "2.75rem",
  borderRadius: t.radiusMd,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: `color-mix(in srgb, ${color} 12%, ${t.surfaceLowest})`,
  color,
  flexShrink: 0,
});
const workflowTop: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: t.space4,
  flexWrap: "wrap",
};
const eyebrow: CSSProperties = {
  color: t.muted,
  fontSize: "0.8125rem",
  marginBottom: "0.2rem",
};
const workflowTitle: CSSProperties = {
  ...sectionTitle,
  fontSize: "1.12rem",
};
const workflowDescription: CSSProperties = {
  ...muted,
  marginTop: "0.35rem",
  maxWidth: "48rem",
  lineHeight: 1.5,
};
const stepper: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 0,
  listStyle: "none",
  padding: 0,
  margin: 0,
};
const stepItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  minWidth: 0,
};
const stepDot: CSSProperties = {
  width: "1.55rem",
  height: "1.55rem",
  borderRadius: "999px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: ghostBorder,
  color: t.onSurfaceVariant,
  fontSize: "0.72rem",
  fontWeight: 800,
  flexShrink: 0,
};
const stepDotActive: CSSProperties = {
  ...stepDot,
  background: t.primary,
  color: t.onPrimary,
  border: "none",
};
const stepDotComplete: CSSProperties = {
  ...stepDot,
  color: t.successPillFg, // F-077 (#190) — WCAG AA text contrast
};
const stepLabel: CSSProperties = {
  marginLeft: "0.45rem",
  color: t.onSurfaceVariant,
  fontSize: "0.76rem",
  whiteSpace: "nowrap",
};
const stepLabelActive: CSSProperties = {
  ...stepLabel,
  color: t.onSurface,
  fontWeight: 800,
};
const stepLine: CSSProperties = {
  height: "1px",
  background: t.surfaceContainer,
  flex: 1,
  margin: "0 0.55rem",
  minWidth: "0.5rem",
};
// Indented to the text column (icon 2.75rem + gap), so the details line up under the description.
const workflowDetails: CSSProperties = {
  paddingLeft: `calc(2.75rem + ${t.space3})`,
  display: "flex",
  alignItems: "center",
  gap: t.space3,
  flexWrap: "wrap",
  color: t.onSurfaceVariant,
  fontSize: "0.78rem",
};
const detailsSummary: CSSProperties = {
  cursor: "pointer",
  color: t.warning,
  fontWeight: 700,
};
const compactList: CSSProperties = {
  margin: "0.5rem 0 0",
  paddingLeft: "1.2rem",
  display: "grid",
  gap: "0.3rem",
};
const warningText: CSSProperties = { color: t.warning, fontWeight: 700 };
const noticeStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: t.space3,
  border: ghostBorder,
  borderRadius: t.radiusMd,
  padding: "0.65rem 0.8rem",
  background: t.surfaceLow,
  fontSize: "0.84rem",
};
const tabBtn: CSSProperties = {
  border: "none",
  borderBottom: "2px solid transparent",
  background: "transparent",
  color: t.onSurfaceVariant,
  cursor: "pointer",
  fontWeight: 700,
  padding: "0.65rem 0.8rem",
  fontSize: "0.82rem",
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
};
const activeTab: CSSProperties = {
  ...tabBtn,
  color: t.onSurface,
  borderBottom: `2px solid ${t.primary}`,
};
const sectionHeader: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: t.space3,
  flexWrap: "wrap",
};
const problemStack: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space4,
};
const problemCard: CSSProperties = {
  border: `1px solid ${t.cardBorder}`,
  borderRadius: t.radiusLg,
  padding: "1rem 1.125rem",
  display: "flex",
  flexDirection: "column",
  gap: t.space3,
  background: t.surfaceLowest,
};
const problemHeader: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: t.space3,
};
const problemBadges: CSSProperties = {
  display: "flex",
  gap: t.space2,
  flexWrap: "wrap",
  alignItems: "center",
  marginBottom: "0.45rem",
};
const problemTitle: CSSProperties = {
  margin: 0,
  fontSize: "0.98rem",
  fontWeight: 650,
  color: t.onSurface,
};
const subsection: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space2,
};
const row: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: t.space2,
  padding: "0.5rem 0",
  borderBottom: `1px solid ${t.surfaceContainer}`,
};
const rowTitle: CSSProperties = {
  margin: 0,
  color: t.onSurface,
  fontSize: "0.86rem",
  fontWeight: 550,
};
const lineWrap: CSSProperties = {
  display: "flex",
  gap: t.space2,
  flexWrap: "wrap",
  alignItems: "center",
};
const problemPrimaryMeta: CSSProperties = {
  ...muted,
  marginTop: "0.3rem",
  fontSize: "0.76rem",
};
const clinicalDetails: CSSProperties = {
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
  padding: "0.5rem 0.65rem",
};
const clinicalDetailsSummary: CSSProperties = {
  cursor: "pointer",
  color: t.onSurfaceVariant,
  fontSize: "0.74rem",
  fontWeight: 700,
};
const clinicalDetailsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
  gap: t.space3,
  paddingTop: t.space3,
};
const detailFact: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
};
const detailFactValue: CSSProperties = {
  color: t.onSurface,
  fontSize: "0.8rem",
  lineHeight: 1.4,
};
const careColumns: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(19rem, 1fr))",
  gap: t.space5,
  paddingTop: t.space2,
};
const careColumn: CSSProperties = { minWidth: 0 };
const subsectionHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: t.space2,
  marginBottom: t.space2,
};
const careColumnTitle: CSSProperties = {
  display: "inline",
  margin: 0,
  color: t.onSurface,
  fontSize: "0.86rem",
  fontWeight: 750,
};
const careColumnCount: CSSProperties = {
  marginLeft: "0.4rem",
  color: t.onSurfaceVariant,
  fontSize: "0.72rem",
};
const smallActionBtn: CSSProperties = {
  ...iconTextBtn,
  fontSize: "0.72rem",
};
const emptyInline: CSSProperties = {
  margin: 0,
  padding: "0.6rem 0",
  color: t.onSurfaceVariant,
  fontSize: "0.78rem",
};
const suggestionPanel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space2,
  padding: t.space3,
  border: ghostBorder,
  borderRadius: t.radiusMd,
  background: t.surfaceContainer,
};
const suggestionBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: t.space2,
  maxWidth: "100%",
  padding: "0.42rem 0.65rem",
  border: ghostBorder,
  borderRadius: t.radiusSm,
  background: t.surface,
  color: t.onSurface,
  cursor: "pointer",
  fontWeight: 650,
  fontSize: "0.78rem",
};
const suggestionText: CSSProperties = {
  color: t.onSurfaceVariant,
  fontWeight: 500,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const menuWrap: CSSProperties = { position: "relative" };
const menuButton: CSSProperties = {
  listStyle: "none",
  cursor: "pointer",
  width: "2rem",
  height: "2rem",
  borderRadius: t.radiusMd,
  border: ghostBorder,
  background: t.surfaceContainer,
  color: t.onSurface,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};
const rowMenuButton: CSSProperties = {
  ...menuButton,
  width: "1.8rem",
  height: "1.8rem",
};
const menuPopover: CSSProperties = {
  position: "absolute",
  right: 0,
  top: "calc(100% + 0.3rem)",
  zIndex: 20,
  minWidth: "10rem",
  ...cardSurface,
  border: ghostBorder,
  padding: "0.3rem",
  display: "grid",
  gap: "0.15rem",
};
const menuItem: CSSProperties = {
  border: "none",
  background: "transparent",
  color: t.onSurface,
  textAlign: "left",
  cursor: "pointer",
  borderRadius: t.radiusMd,
  padding: "0.48rem 0.55rem",
  fontSize: "0.8rem",
  fontWeight: 650,
};
const restricted: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.25rem",
  color: t.warning,
  fontSize: "0.75rem",
  fontWeight: 700,
};
const revisionHeader: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: t.space3,
};
const revisionProgress: CSSProperties = {
  borderTop: ghostBorder,
  borderBottom: ghostBorder,
  padding: `${t.space3} 0`,
};
const requirementList: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: t.space2,
};
const requirementItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: t.space2,
  color: t.onSurface,
  fontSize: "0.82rem",
};
const requirementDot: CSSProperties = {
  width: "0.45rem",
  height: "0.45rem",
  borderRadius: "999px",
  background: t.warning,
  flexShrink: 0,
};
const readyLine: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: t.space2,
  color: t.successPillFg, // F-077 (#190) — WCAG AA text contrast
  fontSize: "0.82rem",
  fontWeight: 700,
};
const emptyRevision: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: t.space4,
  flexWrap: "wrap",
};
const signaturePanelInner: CSSProperties = {
  display: "grid",
  gap: t.space2,
};
const historyGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(14rem, 18rem) minmax(0, 1fr)",
  gap: t.space4,
};
const versionBtn: CSSProperties = {
  ...ghostBtn,
  display: "flex",
  alignItems: "flex-start",
  flexDirection: "column",
  textAlign: "left",
  gap: t.space2,
};
const selectedVersionBtn: CSSProperties = {
  ...versionBtn,
  outline: `2px solid ${t.primary}`,
};
const signatureChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
  background: t.surfaceContainer,
  borderRadius: t.radiusMd,
  padding: "0.3rem 0.5rem",
  fontSize: "0.78rem",
  color: t.onSurface,
};
const diffRow: CSSProperties = {
  borderTop: `1px solid ${t.surfaceContainer}`,
  paddingTop: t.space2,
  display: "grid",
  gap: t.space2,
};
const diffGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  gap: t.space3,
};
const modalBody: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space4,
  padding: t.space5,
};
const form: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space4,
};
const formSection: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space3,
  paddingBottom: t.space4,
  borderBottom: ghostBorder,
};
const formSectionTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 650,
  fontSize: "0.94rem",
  color: t.onSurface,
};
const formSectionDescription: CSSProperties = {
  ...muted,
  marginTop: "0.25rem",
  lineHeight: 1.45,
};
const formSectionBody: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space3,
};
const fieldGrid2: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))",
  gap: t.space3,
  alignItems: "start",
};
const formActions: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  paddingTop: t.space1,
};
const field: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
  minWidth: 0,
};
const fieldLabel: CSSProperties = {
  fontSize: "0.72rem",
  color: t.onSurfaceVariant,
  fontWeight: 700,
};
const input: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  minHeight: "2.5rem",
  border: ghostBorder,
  borderRadius: t.radiusMd,
  background: t.surface,
  color: t.onSurface,
  padding: "0.55rem 0.65rem",
  fontSize: "0.86rem",
};
const fieldHint: CSSProperties = {
  color: t.onSurfaceVariant,
  fontSize: "0.69rem",
  lineHeight: 1.35,
};
const fieldErrorText: CSSProperties = {
  color: t.error,
  fontSize: "0.75rem",
  lineHeight: 1.35,
};
const requiredMark: CSSProperties = { color: t.error };
const checkCard: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: t.space2,
  padding: "0.7rem 0.8rem",
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
  color: t.onSurface,
};
const checkTitle: CSSProperties = { display: "block", fontSize: "0.82rem" };
const checkHint: CSSProperties = {
  display: "block",
  marginTop: "0.15rem",
  color: t.onSurfaceVariant,
  fontSize: "0.72rem",
  lineHeight: 1.4,
};
const textarea: CSSProperties = {
  ...input,
  fontFamily: "inherit",
  resize: "vertical",
};
const plainList: CSSProperties = {
  margin: 0,
  paddingLeft: "1rem",
  color: t.onSurface,
  fontSize: "0.84rem",
};
