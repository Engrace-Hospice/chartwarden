import {
  EmptyState,
  Glyph,
  LoadingSpinner,
  Modal,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  ageYears,
  cardSurface,
  ghostBorder,
  t,
  useApiClient,
} from "@wardenx/ui";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChartModuleRail, PatientChartBail } from "../../shell/chart-module-rail";
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
  errorMessage,
  getCarePlanWorkspace,
  getProposedChanges,
  writeHeaders,
} from "./care-plan-api";
import { cap, toneFor } from "./care-plan-status";

type Tab = "current" | "revision" | "history";
type ModalState =
  | { kind: "problem"; problem?: Problem }
  | { kind: "resolve_problem"; problem: Problem }
  | { kind: "goal"; goal?: Goal; problemId?: string }
  | { kind: "intervention"; intervention?: Intervention; problemId?: string }
  | { kind: "discontinue_intervention"; intervention: Intervention }
  | { kind: "sign"; version: Version }
  | { kind: "return_to_draft"; version: Version }
  | null;

const KIND_ORDER: Record<string, number> = { terminal: 0, related: 1, unrelated: 2 };
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

function hasPerm(perms: string[] | undefined, key: string): boolean {
  return perms?.includes(key) ?? false;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Not set";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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

export function CarePlanView(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const session = useSession();
  const { patientId } = useParams<{ patientId: string }>();
  const [plan, setPlan] = useState<CarePlan | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [review, setReview] = useState<ReviewStatus | null>(null);
  const [proposed, setProposed] = useState<ProposedChanges | null>(null);
  const [tab, setTab] = useState<Tab>("current");
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  async function mutate(
    action: () => Promise<{ error?: unknown }>,
    success: string,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await action();
    setBusy(false);
    if (res.error) {
      setError(errorMessage(res.error, "The Care Plan action could not be completed."));
      return;
    }
    setModal(null);
    await reload(success);
  }

  async function startVersion(kind: "interim_revision" | "idg_review"): Promise<void> {
    if (!plan) return;
    await mutate(
      async () =>
        client.POST("/api/v1/care-plans/{planId}/versions", {
          params: { path: { planId: plan.id } },
          body: { kind },
        } as never),
      kind === "idg_review" ? "Review draft opened." : "Revision draft opened.",
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

  const bailBanner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}`}
      chips={<MonoChip title="Medical record number">{patient.mrn}</MonoChip>}
    />
  ) : (
    <PatientBanner name="Care Plan" />
  );

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
          title="Care Plan unavailable"
          description="The Care Plan could not be loaded for this admission. Automatic bootstrap should have created it when the Admission became active."
        />
      </PatientChartBail>
    );
  }

  const age = patient ? ageYears(patient.dob) : null;
  const activeTerminal = plan.problems.find((p) => p.kind === "terminal" && p.status === "active");
  const reviewTone =
    review?.status === "overdue" ? "error" : review?.status === "due" ? "warning" : "neutral";

  return (
    <PatientWorkspaceLayout
      banner={
        <PatientBanner
          name={patient ? `${patient.firstName} ${patient.lastName}` : "Care Plan"}
          meta={patient ? `DOB ${patient.dob}${age != null ? ` · ${age}y` : ""}` : undefined}
          chips={
            <>
              {patient ? <MonoChip title="Medical record number">{patient.mrn}</MonoChip> : null}
              <StatusPill label={cap(plan.status)} tone={toneFor(plan.status)} />
              <MonoChip title="Admission">{`Admission ${plan.admissionId.slice(0, 8)}`}</MonoChip>
              {plan.redacted ? (
                <span style={restricted}>
                  <Glyph name="lock" size={12} /> restricted content omitted
                </span>
              ) : null}
            </>
          }
          actions={
            <Link to={`/patients/${patientId}`} style={ghostBtn}>
              Open chart
            </Link>
          }
        />
      }
    >
      <div style={workspace}>
        <ChartModuleRail patientId={patientId ?? ""} current="care-plan" />
        <main style={mainPane}>
          <header style={topRow}>
            <div>
              <h1 style={title}>Patient Care Plan</h1>
              <p style={muted}>
                {activeVersion
                  ? `Current v${activeVersion.sequence} · ${cap(activeVersion.kind)} · signed ${formatDate(activeVersion.signedAt)}`
                  : openVersion
                    ? `${cap(openVersion.status)} v${openVersion.sequence} · ${cap(openVersion.kind)}`
                    : "No signed version yet"}
              </p>
            </div>
            <div style={actionsRow}>
              {openVersion ? (
                <button type="button" style={ghostBtn} onClick={() => setTab("revision")}>
                  Continue {openVersion.kind === "idg_review" ? "review" : "revision"}
                </button>
              ) : (
                <>
                  {canAuthor && plan.status !== "discharged" ? (
                    <button
                      type="button"
                      style={ghostBtn}
                      onClick={() => void startVersion("interim_revision")}
                    >
                      Start revision
                    </button>
                  ) : null}
                  {canAuthor && review?.canStartReview ? (
                    <button
                      type="button"
                      style={primaryBtn}
                      onClick={() => void startVersion("idg_review")}
                    >
                      Start review
                    </button>
                  ) : null}
                </>
              )}
              <button
                type="button"
                style={ghostBtn}
                onClick={() => navigate(`/care-plans/${plan.id}/versions`)}
              >
                Version history
              </button>
            </div>
          </header>

          {error ? <Notice tone="error">{error}</Notice> : null}
          {notice ? <Notice tone="success">{notice}</Notice> : null}

          <section style={statusGrid} aria-label="Care Plan status">
            <StatusCard label="Status" value={cap(plan.status)} tone={toneFor(plan.status)} />
            <StatusCard
              label="Current version"
              value={
                activeVersion
                  ? `v${activeVersion.sequence} ${cap(activeVersion.kind)}`
                  : "Pending signatures"
              }
              tone={activeVersion ? "success" : "warning"}
            />
            <StatusCard
              label="Next review"
              value={
                review?.status === "overdue"
                  ? `Overdue by ${review.overdueByDays} day${review.overdueByDays === 1 ? "" : "s"}`
                  : review?.status === "review_in_progress"
                    ? "Review in progress"
                    : formatDate(review?.nextReviewDueAt)
              }
              tone={reviewTone}
            />
            <StatusCard
              label="Readiness"
              value={
                readiness?.canFinalize
                  ? "Ready to send"
                  : readiness?.canSign
                    ? "Ready for signatures"
                    : "Needs attention"
              }
              tone={readiness?.canFinalize || readiness?.canSign ? "success" : "warning"}
            />
          </section>

          <AttentionPanel
            readiness={readiness}
            review={review}
            openVersion={openVersion}
            proposed={proposed}
            activeTerminal={activeTerminal}
            onRevision={() => setTab("revision")}
            onStartReview={() => void startVersion("idg_review")}
            canAuthor={canAuthor}
          />

          <div style={tabs} role="tablist" aria-label="Care Plan workspace views">
            <TabButton active={tab === "current"} onClick={() => setTab("current")}>
              Current Plan
            </TabButton>
            <TabButton active={tab === "revision"} onClick={() => setTab("revision")}>
              Revision / Review
            </TabButton>
            <TabButton active={tab === "history"} onClick={() => setTab("history")}>
              History
            </TabButton>
          </div>

          {tab === "current" ? (
            <ClinicalContent
              title="Working clinical plan"
              readonly={
                plan.status === "discharged" || !openVersion || openVersion.status === "in_review"
              }
              plan={plan}
              problems={plan.problems}
              goals={plan.goals}
              interventions={plan.interventions}
              canAuthor={
                canAuthor &&
                plan.status !== "discharged" &&
                Boolean(openVersion) &&
                openVersion?.status !== "in_review"
              }
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
          onClose={() => setModal(null)}
          onSubmit={mutate}
        />
      ) : null}
    </PatientWorkspaceLayout>
  );
}

function AttentionPanel({
  readiness,
  review,
  openVersion,
  proposed,
  activeTerminal,
  canAuthor,
  onRevision,
  onStartReview,
}: {
  readiness: Readiness | null;
  review: ReviewStatus | null;
  openVersion: Version | null;
  proposed: ProposedChanges | null;
  activeTerminal?: Problem;
  canAuthor: boolean;
  onRevision: () => void;
  onStartReview: () => void;
}): JSX.Element {
  const items: {
    key: string;
    tone: "info" | "warning" | "error";
    text: string;
    action?: ReactNode;
  }[] = [];
  if (!activeTerminal)
    items.push({ key: "terminal", tone: "warning", text: "Active terminal problem required." });
  for (const blocker of readiness?.blockers ?? []) {
    items.push({
      key: blocker.code,
      tone: "warning",
      text: blockerLabel(blocker.code, blocker.message),
    });
  }
  if (readiness?.signatures.missing.length)
    items.push({
      key: "signatures",
      tone: "info",
      text: `${readiness.signatures.missing.map((s) => `${cap(s.role)} (${s.count})`).join(", ")} signature${readiness.signatures.missing.length === 1 ? "" : "s"} missing.`,
      action: (
        <button type="button" style={miniBtn} onClick={onRevision}>
          Review signatures
        </button>
      ),
    });
  if (review?.status === "due" || review?.status === "overdue")
    items.push({
      key: "review",
      tone: review.status === "overdue" ? "error" : "warning",
      text:
        review.status === "overdue"
          ? `Care Plan review overdue by ${review.overdueByDays} day${review.overdueByDays === 1 ? "" : "s"}.`
          : "Care Plan review is due.",
      action:
        canAuthor && review.canStartReview ? (
          <button type="button" style={miniBtn} onClick={onStartReview}>
            Start review
          </button>
        ) : undefined,
    });
  if (openVersion)
    items.push({
      key: "open",
      tone: "info",
      text: `${cap(openVersion.kind)} v${openVersion.sequence} is ${cap(openVersion.status)}.`,
      action: (
        <button type="button" style={miniBtn} onClick={onRevision}>
          Continue
        </button>
      ),
    });
  if (proposed?.changes.length)
    items.push({
      key: "idg",
      tone: "info",
      text: `${proposed.changes.length} IDG proposed change${proposed.changes.length === 1 ? "" : "s"} awaiting governed review.`,
      action: (
        <button type="button" style={miniBtn} onClick={onRevision}>
          Review IDG changes
        </button>
      ),
    });
  if (items.length === 0)
    return <Notice tone="success">No Care Plan blockers require attention.</Notice>;
  return (
    <section style={attentionWrap} aria-label="Care Plan attention">
      {items.map((item) => (
        <Notice key={item.key} tone={item.tone}>
          <span>{item.text}</span>
          {item.action}
        </Notice>
      ))}
    </section>
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
  return (
    <section style={panel}>
      <div style={sectionHeader}>
        <div>
          <h2 style={sectionTitle}>{heading}</h2>
          <p style={muted}>
            Interventions are Care Plan intent. Orders and scheduling remain explicit downstream
            workflows.
          </p>
        </div>
        {canAuthor ? (
          <button type="button" style={primaryBtn} onClick={() => onProblem()}>
            Add problem
          </button>
        ) : null}
      </div>
      {readonly ? (
        <Notice tone="info">
          This view is read-only while a version is in review or discharged.
        </Notice>
      ) : null}
      {sorted.length === 0 ? (
        <EmptyState
          title="No problems recorded"
          description="Add the first clinical problem to anchor goals and interventions."
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: t.space3 }}>
          {sorted.map((problem) => (
            <article key={problem.id} style={problemCard}>
              <div style={sectionHeader}>
                <div style={{ minWidth: 0 }}>
                  <div style={lineWrap}>
                    <h3 style={problemTitle}>{problem.description}</h3>
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
                  <p style={muted}>
                    Source {cap(problem.source)}
                    {problem.icd10Code ? ` · ICD-10 ${problem.icd10Code}` : ""}
                    {problem.snomedCode ? ` · SNOMED ${problem.snomedCode}` : ""}
                    {problem.onsetAt ? ` · onset ${formatDate(problem.onsetAt)}` : ""}
                    {problem.resolvedAt ? ` · resolved ${formatDate(problem.resolvedAt)}` : ""}
                  </p>
                  {problem.resolutionNote ? <p style={muted}>{problem.resolutionNote}</p> : null}
                </div>
                {canAuthor && !readonly ? (
                  <div style={actionsRow}>
                    <button type="button" style={ghostBtn} onClick={() => onProblem(problem)}>
                      Edit
                    </button>
                    {problem.status === "active" ? (
                      <button
                        type="button"
                        style={ghostBtn}
                        onClick={() => onResolveProblem(problem)}
                      >
                        Resolve
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <Subsection
                title="Goals"
                action={
                  canAuthor && !readonly ? (
                    <button
                      type="button"
                      style={miniBtn}
                      onClick={() => onGoal(undefined, problem.id)}
                    >
                      Add goal
                    </button>
                  ) : null
                }
              >
                {goals
                  .filter((g) => g.problemId === problem.id)
                  .map((goal) => (
                    <GoalRow
                      key={goal.id}
                      goal={goal}
                      editable={canAuthor && !readonly}
                      onEdit={() => onGoal(goal, problem.id)}
                    />
                  ))}
              </Subsection>
              <Subsection
                title="Interventions"
                action={
                  canAuthor && !readonly ? (
                    <button
                      type="button"
                      style={miniBtn}
                      onClick={() => onIntervention(undefined, problem.id)}
                    >
                      Add intervention
                    </button>
                  ) : null
                }
              >
                {interventions
                  .filter((i) => i.problemId === problem.id)
                  .map((iv) => (
                    <InterventionRow
                      key={iv.id}
                      intervention={iv}
                      goals={plan.goals}
                      editable={canAuthor && !readonly}
                      onEdit={() => onIntervention(iv, problem.id)}
                      onDiscontinue={() => onDiscontinueIntervention(iv)}
                    />
                  ))}
              </Subsection>
            </article>
          ))}
        </div>
      )}
    </section>
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
        <h2 style={sectionTitle}>Revision / Review</h2>
        <p style={muted}>No draft or in-review version is open.</p>
        <div style={actionsRow}>
          {canAuthor ? (
            <button type="button" style={ghostBtn} onClick={onStartRevision}>
              Start revision
            </button>
          ) : null}
          {canAuthor && review?.canStartReview ? (
            <button type="button" style={primaryBtn} onClick={onStartReview}>
              Start review
            </button>
          ) : null}
        </div>
      </section>
    );
  }
  const candidate = snapshotOf(version);
  const readonly = version.status === "in_review";
  return (
    <section style={panel}>
      <div style={sectionHeader}>
        <div>
          <h2 style={sectionTitle}>
            {version.kind === "idg_review" ? "IDG review" : "Care Plan revision"} v
            {version.sequence}
          </h2>
          <p style={muted}>
            {cap(version.status)} ·{" "}
            {version.idgMeetingId
              ? `Meeting ${version.idgMeetingId.slice(0, 8)}`
              : "Scheduled/manual review"}
          </p>
        </div>
        <div style={actionsRow}>
          {version.status === "draft" && canFinalize ? (
            <button
              type="button"
              style={readiness?.canFinalize ? primaryBtn : disabledBtn}
              disabled={!readiness?.canFinalize || busy}
              onClick={() => void onFinalize(version)}
            >
              Review & send for signatures
            </button>
          ) : null}
          {version.status === "in_review" && canAuthor ? (
            <button type="button" style={ghostBtn} onClick={() => onReturn(version)}>
              Return to draft
            </button>
          ) : null}
          {version.status === "in_review" && canSign && readiness?.canSign ? (
            <button type="button" style={primaryBtn} onClick={() => onSign(version)}>
              Sign
            </button>
          ) : null}
        </div>
      </div>
      {version.status === "draft" && readiness && !readiness.canFinalize ? (
        <Notice tone="warning">
          Cannot send for signatures:{" "}
          {readiness.blockers.map((b) => blockerLabel(b.code, b.message)).join("; ")}
        </Notice>
      ) : null}
      {version.status === "in_review" ? (
        <Notice tone="info">
          Candidate content is frozen. Return to draft if edits are needed; existing signatures will
          be invalidated.
        </Notice>
      ) : null}
      {proposed?.changes.length ? <IdgProposal proposed={proposed} /> : null}
      <SignaturePanel readiness={readiness} version={version} />
      {version.status === "in_review" && candidate ? (
        <SnapshotContent snapshot={candidate} />
      ) : (
        <ClinicalContent
          title="Draft working content"
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
      <h3 style={smallTitle}>IDG proposed changes</h3>
      <p style={muted}>
        These changes are proposed until the governed review version is signed and published.
      </p>
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
      <h2 style={sectionTitle}>Version history</h2>
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

function SnapshotContent({ snapshot }: { snapshot: ClinicalSnapshot }): JSX.Element {
  return (
    <section style={subPanel}>
      <h3 style={smallTitle}>Candidate snapshot</h3>
      <SnapshotLists snapshot={snapshot} />
    </section>
  );
}

function VersionSnapshot({ version }: { version: Version | null }): JSX.Element {
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

function SnapshotLists({ snapshot }: { snapshot: ClinicalSnapshot }): JSX.Element {
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
}: { readiness: Readiness | null; version: Version }): JSX.Element {
  const slots = readiness?.signatures.required.length
    ? readiness.signatures.required
    : version.requiredSignerSet;
  const signatures = readiness?.signatures.collected.length
    ? readiness.signatures.collected
    : version.signatures;
  return (
    <section style={subPanel}>
      <h3 style={smallTitle}>Required signatures</h3>
      <SignatureList slots={slots} signatures={signatures} />
      {readiness?.signatures.missing.length ? (
        <p style={muted}>
          Missing:{" "}
          {readiness.signatures.missing.map((s) => `${cap(s.role)} (${s.count})`).join(", ")}
        </p>
      ) : (
        <p style={muted}>No missing signatures reported by the backend.</p>
      )}
    </section>
  );
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
        const count = signatures.filter((s) => s.signerRole === slot.role).length;
        return (
          <span key={slot.role} style={signatureChip}>
            <Glyph name={count >= slot.count ? "check-circle" : "clock"} size={14} />
            {cap(slot.role)} · {count} of {slot.count}
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
}: { goal: Goal; editable: boolean; onEdit: () => void }): JSX.Element {
  return (
    <div style={row}>
      <div style={{ flex: 1 }}>
        <p style={rowTitle}>{goal.revisedText ?? goal.originalText}</p>
        <p style={muted}>
          {goal.measurableOutcome ?? "No measurable outcome"} · target {formatDate(goal.targetAt)}
          {goal.statusNote ? ` · ${goal.statusNote}` : ""}
        </p>
      </div>
      <StatusPill label={cap(goal.status)} tone={toneFor(goal.status)} />
      {editable ? (
        <button type="button" style={miniBtn} onClick={onEdit}>
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
      <div style={{ flex: 1 }}>
        <p style={rowTitle}>{intervention.scopeText}</p>
        <p style={muted}>
          {cap(intervention.discipline)} · {intervention.frequencyText} ·{" "}
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
        <button type="button" style={miniBtn} onClick={onEdit}>
          Edit
        </button>
      ) : null}
      {editable && intervention.status === "active" ? (
        <button type="button" style={miniBtn} onClick={onDiscontinue}>
          Discontinue
        </button>
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
  onClose,
  onSubmit,
}: {
  state: NonNullable<ModalState>;
  plan: CarePlan;
  goals: Goal[];
  problems: Problem[];
  busy: boolean;
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
        {state.kind === "problem" ? (
          <ProblemForm state={state} plan={plan} busy={busy} onSubmit={onSubmit} />
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
                    params: { path: { planId: plan.id, elementId: state.problem.id } },
                    body: { ifVersion: state.problem.version, resolutionNote: note },
                  } as never),
                "Problem resolved.",
              )
            }
          />
        ) : null}
        {state.kind === "goal" ? (
          <GoalForm state={state} plan={plan} problems={problems} busy={busy} onSubmit={onSubmit} />
        ) : null}
        {state.kind === "intervention" ? (
          <InterventionForm
            state={state}
            plan={plan}
            problems={problems}
            goals={goals}
            busy={busy}
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
                    params: { path: { planId: plan.id, elementId: state.intervention.id } },
                    body: { ifVersion: state.intervention.version, reason },
                  } as never),
                "Intervention discontinued.",
              )
            }
          />
        ) : null}
        {state.kind === "sign" ? (
          <SignForm state={state} plan={plan} busy={busy} onSubmit={onSubmit} />
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
                    params: { path: { planId: plan.id, versionId: state.version.id } },
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
  onSubmit,
}: {
  state: Extract<NonNullable<ModalState>, { kind: "problem" }>;
  plan: CarePlan;
  busy: boolean;
  onSubmit: (action: () => Promise<{ error?: unknown }>, success: string) => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const [description, setDescription] = useState(state.problem?.description ?? "");
  const [kind, setKind] = useState(state.problem?.kind ?? "related");
  const [source, setSource] = useState(state.problem?.source ?? "clinical");
  const [icd10Code, setIcd10Code] = useState(state.problem?.icd10Code ?? "");
  const [snomedCode, setSnomedCode] = useState(state.problem?.snomedCode ?? "");
  const [sudRelated, setSudRelated] = useState(state.problem?.sudRelated ?? false);
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
      <TextField label="Description" value={description} onChange={setDescription} required />
      <Select label="Kind" value={kind} onChange={setKind} options={PROBLEM_KINDS} />
      {!state.problem ? (
        <Select label="Source" value={source} onChange={setSource} options={PROBLEM_SOURCES} />
      ) : null}
      <TextField label="ICD-10 code" value={icd10Code} onChange={setIcd10Code} />
      <TextField label="SNOMED code" value={snomedCode} onChange={setSnomedCode} />
      {!state.problem ? (
        <label style={checkRow}>
          <input
            type="checkbox"
            checked={sudRelated}
            onChange={(e) => setSudRelated(e.target.checked)}
          />{" "}
          SUD-related
        </label>
      ) : null}
      <button type="submit" style={primaryBtn} disabled={busy || !description.trim()}>
        {busy ? "Saving..." : "Save problem"}
      </button>
    </form>
  );
}

function GoalForm({
  state,
  plan,
  problems,
  busy,
  onSubmit,
}: {
  state: Extract<NonNullable<ModalState>, { kind: "goal" }>;
  plan: CarePlan;
  problems: Problem[];
  busy: boolean;
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
      {!state.goal ? (
        <Select
          label="Linked problem"
          value={problemId}
          onChange={setProblemId}
          options={problems.map((p) => ({ value: p.id, label: p.description }))}
        />
      ) : null}
      <TextArea label="Goal text" value={text} onChange={setText} required />
      {!state.goal ? (
        <Select label="Source" value={source} onChange={setSource} options={GOAL_SOURCES} />
      ) : null}
      <TextField label="Measurable outcome" value={outcome} onChange={setOutcome} />
      <TextField label="Target date" value={targetAt} onChange={setTargetAt} type="date" />
      {state.goal ? (
        <Select label="Status" value={status} onChange={setStatus} options={GOAL_STATUSES} />
      ) : null}
      <button type="submit" style={primaryBtn} disabled={busy || !text.trim() || !problemId}>
        {busy ? "Saving..." : "Save goal"}
      </button>
    </form>
  );
}

function InterventionForm({
  state,
  plan,
  problems,
  goals,
  busy,
  onSubmit,
}: {
  state: Extract<NonNullable<ModalState>, { kind: "intervention" }>;
  plan: CarePlan;
  problems: Problem[];
  goals: Goal[];
  busy: boolean;
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
                    path: { planId: plan.id, elementId: state.intervention.id },
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
      {!state.intervention ? (
        <Select
          label="Linked problem"
          value={problemId}
          onChange={setProblemId}
          options={problems.map((p) => ({ value: p.id, label: p.description }))}
        />
      ) : null}
      <TextArea label="Intervention / scope" value={scopeText} onChange={setScopeText} required />
      <TextField
        label="Frequency text"
        value={frequencyText}
        onChange={setFrequencyText}
        required
      />
      <TextField
        label="Frequency value"
        value={frequencyValue}
        onChange={setFrequencyValue}
        required
      />
      {!state.intervention ? (
        <Select
          label="Discipline"
          value={discipline}
          onChange={setDiscipline}
          options={DISCIPLINES}
        />
      ) : null}
      {!state.intervention ? (
        <Select
          label="Linked goal"
          value={goalRef}
          onChange={setGoalRef}
          options={[{ value: "", label: "No linked goal" }, ...goalOptions]}
        />
      ) : null}
      <TextField label="Responsible role" value={responsibleRole} onChange={setResponsibleRole} />
      <button
        type="submit"
        style={primaryBtn}
        disabled={busy || !scopeText.trim() || !frequencyText.trim() || !frequencyValue.trim()}
      >
        {busy ? "Saving..." : "Save intervention"}
      </button>
    </form>
  );
}

function SignForm({
  state,
  plan,
  busy,
  onSubmit,
}: {
  state: Extract<NonNullable<ModalState>, { kind: "sign" }>;
  plan: CarePlan;
  busy: boolean;
  onSubmit: (action: () => Promise<{ error?: unknown }>, success: string) => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const openSlot = state.version.requiredSignerSet.find(
    (slot) =>
      state.version.signatures.filter((s) => s.signerRole === slot.role).length < slot.count,
  );
  const [role, setRole] = useState(
    openSlot?.role ?? state.version.requiredSignerSet[0]?.role ?? "",
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
              params: { path: { planId: plan.id, versionId: state.version.id } },
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
        options={state.version.requiredSignerSet.map((s) => s.role)}
      />
      <TextArea
        label="Patient/family understanding note"
        value={understanding}
        onChange={setUnderstanding}
      />
      <Notice tone="info">
        The backend validates permission, signer role, caseload, authenticated membership, and
        step-up freshness.
      </Notice>
      <button type="submit" style={primaryBtn} disabled={busy || !role}>
        {busy ? "Signing..." : "Sign version"}
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
}: { text: string; label: string; busy: boolean; onConfirm: () => Promise<void> }): JSX.Element {
  return (
    <div style={form}>
      <Notice tone="warning">{text}</Notice>
      <button type="button" style={primaryBtn} disabled={busy} onClick={() => void onConfirm()}>
        {busy ? "Working..." : label}
      </button>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  required = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
}): JSX.Element {
  return (
    <label style={field}>
      <span style={fieldLabel}>{label}</span>
      <input
        aria-label={label}
        value={value}
        type={type}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        style={input}
      />
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}): JSX.Element {
  return (
    <label style={field}>
      <span style={fieldLabel}>{label}</span>
      <textarea
        aria-label={label}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        style={textarea}
      />
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly (string | { value: string; label: string })[];
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
    </label>
  );
}

function Subsection({
  title: heading,
  action,
  children,
}: { title: string; action?: ReactNode; children: ReactNode }): JSX.Element {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div style={subsection}>
      <div style={sectionHeader}>
        <h4 style={miniTitle}>{heading}</h4>
        {action}
      </div>
      {hasChildren ? children : <p style={muted}>None recorded.</p>}
    </div>
  );
}

function SnapshotGroup({ title: heading, items }: { title: string; items: string[] }): JSX.Element {
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

function Diff({ before, proposed }: { before: unknown; proposed: unknown }): JSX.Element {
  return (
    <div style={diffGrid}>
      <DiffValue label="Current" value={before} />
      <DiffValue label="Proposed" value={proposed} />
    </div>
  );
}

function DiffValue({ label, value }: { label: string; value: unknown }): JSX.Element {
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

function StatusCard({
  label,
  value,
  tone,
}: { label: string; value: string; tone: Parameters<typeof StatusPill>[0]["tone"] }): JSX.Element {
  return (
    <div style={statusCard}>
      <span style={fieldLabel}>{label}</span>
      <StatusPill label={value} tone={tone} />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: { active: boolean; onClick: () => void; children: ReactNode }): JSX.Element {
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
}: { tone?: "info" | "warning" | "error" | "success"; children: ReactNode }): JSX.Element {
  const color =
    tone === "error"
      ? t.error
      : tone === "warning"
        ? t.warning
        : tone === "success"
          ? t.success
          : t.primary;
  return (
    <div role={tone === "error" ? "alert" : "status"} style={{ ...noticeStyle, color }}>
      {children}
    </div>
  );
}

function MonoChip({ children, title }: { children: ReactNode; title?: string }): JSX.Element {
  return (
    <span title={title} style={monoChip}>
      {children}
    </span>
  );
}

const workspace: CSSProperties = { display: "flex", height: "100%", minHeight: 0 };
const mainPane: CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: t.space5,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: t.space4,
};
const topRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: t.space4,
  flexWrap: "wrap",
};
const title: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.45rem",
  color: t.onSurface,
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
  fontWeight: 500,
  fontSize: "0.96rem",
  color: t.onSurface,
};
const miniTitle: CSSProperties = {
  margin: 0,
  fontSize: "0.78rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0,
  color: t.onSurfaceVariant,
};
const muted: CSSProperties = { margin: 0, color: t.onSurfaceVariant, fontSize: "0.82rem" };
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
  padding: "0.48rem 0.8rem",
  fontSize: "0.82rem",
};
const ghostBtn: CSSProperties = {
  border: "none",
  borderRadius: t.radiusMd,
  background: t.surfaceContainer,
  color: t.onSurface,
  cursor: "pointer",
  fontWeight: 700,
  padding: "0.48rem 0.8rem",
  fontSize: "0.82rem",
  textDecoration: "none",
};
const disabledBtn: CSSProperties = { ...ghostBtn, cursor: "not-allowed", opacity: 0.55 };
const miniBtn: CSSProperties = { ...ghostBtn, padding: "0.28rem 0.55rem", fontSize: "0.76rem" };
const panel: CSSProperties = {
  ...cardSurface,
  display: "flex",
  flexDirection: "column",
  gap: t.space4,
  padding: t.space5,
};
const subPanel: CSSProperties = {
  border: ghostBorder,
  borderRadius: t.radiusMd,
  padding: t.space4,
  display: "flex",
  flexDirection: "column",
  gap: t.space3,
};
const statusGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  gap: t.space3,
};
const statusCard: CSSProperties = {
  ...cardSurface,
  padding: t.space4,
  display: "flex",
  flexDirection: "column",
  gap: t.space2,
};
const attentionWrap: CSSProperties = { display: "grid", gap: t.space2 };
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
const tabs: CSSProperties = {
  display: "flex",
  gap: t.space2,
  borderBottom: ghostBorder,
  paddingBottom: t.space2,
  flexWrap: "wrap",
};
const tabBtn: CSSProperties = { ...ghostBtn, background: "transparent" };
const activeTab: CSSProperties = { ...ghostBtn, background: t.surfaceContainer };
const sectionHeader: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: t.space3,
  flexWrap: "wrap",
};
const problemCard: CSSProperties = {
  border: ghostBorder,
  borderRadius: t.radiusMd,
  padding: t.space4,
  display: "flex",
  flexDirection: "column",
  gap: t.space3,
};
const problemTitle: CSSProperties = { margin: 0, fontSize: "0.96rem", color: t.onSurface };
const subsection: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space2,
  paddingLeft: t.space2,
};
const row: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: t.space2,
  borderTop: `1px solid ${t.surfaceContainer}`,
  paddingTop: t.space2,
};
const rowTitle: CSSProperties = { margin: 0, color: t.onSurface, fontSize: "0.86rem" };
const lineWrap: CSSProperties = {
  display: "flex",
  gap: t.space2,
  flexWrap: "wrap",
  alignItems: "center",
};
const restricted: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.25rem",
  color: t.warning,
  fontSize: "0.75rem",
  fontWeight: 700,
};
const historyGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(14rem, 18rem) minmax(0, 1fr)",
  gap: t.space4,
};
const versionBtn: CSSProperties = {
  ...ghostBtn,
  alignItems: "flex-start",
  flexDirection: "column",
  textAlign: "left",
};
const selectedVersionBtn: CSSProperties = { ...versionBtn, outline: `2px solid ${t.primary}` };
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
const form: CSSProperties = { display: "flex", flexDirection: "column", gap: t.space3 };
const field: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.25rem" };
const fieldLabel: CSSProperties = {
  fontSize: "0.72rem",
  color: t.onSurfaceVariant,
  fontWeight: 700,
};
const input: CSSProperties = {
  border: "none",
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
  color: t.onSurface,
  padding: "0.5rem 0.6rem",
  fontSize: "0.86rem",
};
const textarea: CSSProperties = { ...input, fontFamily: "inherit", resize: "vertical" };
const checkRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: t.space2,
  color: t.onSurface,
  fontSize: "0.85rem",
};
const plainList: CSSProperties = {
  margin: 0,
  paddingLeft: "1rem",
  color: t.onSurface,
  fontSize: "0.84rem",
};
const monoChip: CSSProperties = {
  fontFamily: t.fontMono,
  fontSize: "0.78rem",
  color: t.onSurfaceVariant,
  background: t.surfaceContainer,
  borderRadius: t.radiusMd,
  padding: "0.15rem 0.55rem",
};
