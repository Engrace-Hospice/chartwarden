import {
  Button,
  CodeSearchInput,
  EmptyState,
  Glyph,
  LoadingSpinner,
  Modal,
  PatientWorkspaceLayout,
  StatusPill,
  cardSurface,
  ghostBorder,
  stepUpPath,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX, KeyboardEvent, ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ChartModuleRail, PatientChartBail } from "../../shell/chart-module-rail";
import {
  ChartBanner,
  ChartPatientBanner,
  PatientSummaryPanel,
  useChartIdentity,
} from "../../shell/patient-context";
import { useSession } from "../../shell/session";
import {
  clearStepUpDraft,
  findStepUpDraftResourceId,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
  stepUpRedirectFor,
} from "../../shell/step-up-redirect";
import { useStepUpOwner, useStepUpReturn } from "../../shell/use-step-up-return";
import {
  type CarePlan,
  type ClinicalSnapshot,
  type Goal,
  type GoalSource,
  type GoalStatus,
  type Intervention,
  type InterventionDiscipline,
  type PatientSummary,
  type Problem,
  type ProblemKind,
  type ProblemSource,
  type ProposedChanges,
  type Readiness,
  type ReviewStatus,
  type SignerRole,
  type SignerSlot,
  type Version,
  type WriteResult,
  bootstrapCarePlan,
  createGoal,
  createIntervention,
  createProblem,
  createVersion,
  discontinueIntervention,
  errorMessage,
  fieldErrorsOf,
  finalizeVersion,
  getCarePlanWorkspace,
  getProposedChanges,
  isKeyStuck,
  isStaleVersion,
  loadPatientAdmissions,
  patchGoal,
  patchIntervention,
  patchProblem,
  resolveProblem,
  returnToDraft,
  signVersion,
} from "./care-plan-api";
import {
  CarePlanRail,
  GoalsList,
  InterventionsList,
  PlanHeader,
  PlanStats,
  RestrictedContentNote,
  disciplineLabel,
} from "./care-plan-overview";
import { cap, isGoalEditable, isInterventionEditable, toneFor } from "./care-plan-status";

type Tab = "goals" | "interventions" | "problems" | "revision" | "history";
type ModalState =
  | { kind: "problem"; problem?: Problem; defaultKind?: "terminal" }
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
// Every vocabulary below is typed against the published contract (care-plan-api.ts derives each union from
// the request body), so a value the server no longer accepts is a compile error here, not a 400 at runtime.
const PROBLEM_KINDS: readonly ProblemKind[] = ["terminal", "related", "unrelated"];
/** Exhaustive over the contract's `source` union: adding or dropping a server value breaks this literal. */
const PROBLEM_SOURCE_LABELS: Record<ProblemSource, string> = {
  clinical: "Clinical assessment",
  patient_reported: "Patient reported",
  family_reported: "Family reported",
  history: "Chart history",
  intake_extraction: "Intake extraction",
};
export const PROBLEM_SOURCE_OPTIONS: readonly { value: ProblemSource; label: string }[] = (
  Object.keys(PROBLEM_SOURCE_LABELS) as ProblemSource[]
).map((value) => ({ value, label: PROBLEM_SOURCE_LABELS[value] }));
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
// The goal lifecycle graph (lifecycle/elements.ts GOAL_GRAPH): a goal may only move along these edges;
// met / not_met / discontinued are terminal. The server answers 409 ILLEGAL_TRANSITION for any other
// move, so the edit form offers the current status plus its legal targets and nothing else.
const GOAL_NEXT_STATUSES: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  not_started: ["in_progress"],
  in_progress: ["met", "not_met", "revised", "discontinued"],
  revised: ["in_progress"],
  met: [],
  not_met: [],
  discontinued: [],
};
const goalStatusOptions = (current: GoalStatus): readonly GoalStatus[] => [
  current,
  ...GOAL_NEXT_STATUSES[current],
];
const DISCIPLINES: readonly InterventionDiscipline[] = [
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
];

/** The option `value` when it is one of `options`, else `fallback` (a state value read off the wire is a bare string). */
function pick<T extends string>(
  options: readonly T[],
  value: string | null | undefined,
  fallback: T,
): T {
  return options.find((option) => option === value) ?? fallback;
}

/** Shown when a request got no answer at all. The client keeps the idempotency key, so retrying is safe. */
const NO_RESPONSE_MESSAGE = "No response — your change may not have saved. Retry.";
const LOAD_NO_RESPONSE_MESSAGE =
  "No response — the Care Plan workspace could not be loaded. Try again.";
/** The write succeeded but the re-read did not: say so, or the stale screen invites a repeat that 409s. */
const SAVED_REFRESH_NO_RESPONSE_MESSAGE =
  "Your change was saved, but the workspace could not be refreshed (no response). Reload the page before making another change.";
const SAVED_REFRESH_FAILED_MESSAGE =
  "Your change was saved, but the workspace could not be refreshed. Reload the page before making another change.";
const STALE_MESSAGE =
  "This record changed while you were working. The latest version is loaded; check your entry and save again.";
const STALE_RELOAD_FAILED_MESSAGE =
  "This record changed while you were working, and the latest version could not be loaded. Try saving again.";
const SIGN_ACTION = "care-plan-sign";
const STEP_UP_ACTIONS: readonly string[] = [SIGN_ACTION];

type WriteAction = () => Promise<WriteResult<unknown>>;
/** What to keep through a step-up round trip: typed text survives, in memory only (see step-up-redirect.ts). */
interface StepUpDraft {
  readonly key: string | null;
  readonly value: unknown;
}
/** Resolves true when the write was accepted. */
type SubmitWrite = (action: WriteAction, success: string, draft?: StepUpDraft) => Promise<boolean>;
type FieldErrors = Readonly<Record<string, string>>;

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

/**
 * A goal's `targetAt` is a calendar day carried as a UTC date-time ("2026-12-01T00:00:00.000Z"): it is read
 * in UTC, because local fields would show a US clinician's Dec 1 as Nov 30.
 */
function formatCalendarDate(value: string | null | undefined): string {
  if (!value) return "Not set";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
}

function blockerLabel(code: string, message?: string): string {
  if (message) return message.charAt(0).toUpperCase() + message.slice(1);
  if (code === "TERMINAL_PROBLEM_REQUIRED") return "Active terminal problem required";
  if (code === "OPEN_VERSION_REQUIRED") return "Open draft or review version required";
  return cap(code);
}

const TERMINAL_BLOCKER = "TERMINAL_PROBLEM_REQUIRED";
const IDG_PROPOSAL_BLOCKER = "IDG_PROPOSAL_REQUIRED";
const OPEN_VERSION_BLOCKER = "OPEN_VERSION_REQUIRED";
const PROPOSAL_CONFLICT_LABEL =
  "A proposed IDG change conflicts with newer Care Plan content. Resolve it before sending";

function hasBlocker(readiness: Readiness | null, code: string): boolean {
  return readiness?.blockers.some((blocker) => blocker.code === code) ?? false;
}

/** An applied IDG proposal the plan has moved out from under: the server marks it `conflict` with a reason. */
function conflictedProposals(proposed: ProposedChanges | null): ProposedChanges["proposals"] {
  return (proposed?.proposals ?? []).filter((p) => p.status === "conflict" || p.conflictReason);
}

const CONFLICT_REASONS: Record<string, string> = {
  baseline_changed: "the Care Plan changed after the IDG decision was recorded",
};
const conflictReasonText = (reason: string | null): string =>
  reason ? (CONFLICT_REASONS[reason] ?? cap(reason)) : "the Care Plan changed";

function snapshotOf(version: Version | null): ClinicalSnapshot | null {
  if (!version?.stateSnapshot || typeof version.stateSnapshot !== "object") return null;
  return version.stateSnapshot as ClinicalSnapshot;
}

/**
 * What needs attention, from the server's verdict alone (`readiness.blockers`) plus an IDG proposal in
 * conflict. The server owns which blockers apply to which version kind (a terminal problem is only demanded of
 * the initial version), so the client adds none of its own. `OPEN_VERSION_REQUIRED` is the server stating
 * "no draft is open": on a healthy active plan that is the normal resting state, not something to fix.
 */
function attentionBlockers(
  readiness: Readiness | null,
  proposed: ProposedChanges | null,
  planHasActiveVersion: boolean,
): string[] {
  const labels = new Set<string>();
  for (const blocker of readiness?.blockers ?? []) {
    if (blocker.code === OPEN_VERSION_BLOCKER && planHasActiveVersion) continue;
    labels.add(blockerLabel(blocker.code, blocker.message).replace(/[.]$/, ""));
  }
  if (conflictedProposals(proposed).length) labels.add(PROPOSAL_CONFLICT_LABEL);
  return [...labels];
}

/** The signature roles a version asks for: the server's readiness set when it sent one, else the version's own. */
function requiredSlots(version: Version | null, readiness: Readiness | null): SignerSlot[] {
  return readiness?.signatures.required.length
    ? readiness.signatures.required
    : (version?.requiredSignerSet ?? []);
}

const TEAM_ROLES = ["msw", "chaplain"];
const PHYSICIAN_ROLES = ["hospice_physician", "medical_director"];

/**
 * An IDG review is signed by the whole team (RN + MSW + chaplain + MD/DO), so it is not a "hospice physician"
 * step; the wording follows the version's kind and required signer set rather than asserting one signer.
 */
function isTeamReview(version: Version | null, readiness: Readiness | null): boolean {
  if (version?.kind === "idg_review") return true;
  return requiredSlots(version, readiness).some((slot) =>
    slot.role.split("|").some((role) => TEAM_ROLES.includes(role)),
  );
}

/** True when everything still outstanding can only be signed by a physician. */
function onlyPhysicianOutstanding(readiness: Readiness | null): boolean {
  const missing = readiness?.signatures.missing ?? [];
  return (
    missing.length > 0 &&
    missing.every((slot) => slot.role.split("|").some((role) => PHYSICIAN_ROLES.includes(role)))
  );
}

interface ReviewWording {
  readonly readyHeading: string;
  readonly readyDescription: string;
  readonly sendFromGuide: string;
  readonly sendFromPanel: string;
  readonly frozenHeading: string;
  readonly frozenDescription: string;
  readonly sendDescription: string;
  readonly pendingHeading: string;
  /** The stepper label for the signature step. */
  signatureStep: string;
}
const PHYSICIAN_WORDING: ReviewWording = {
  readyHeading: "Ready for physician review",
  readyDescription:
    "The clinical plan is complete. Sending it freezes this version for hospice physician review and signature.",
  sendFromGuide: "Send for physician review",
  sendFromPanel: "Send to hospice physician",
  frozenHeading: "Hospice physician review & signature",
  frozenDescription:
    "Candidate content is frozen while the hospice physician reviews it. Return to draft only when clinical edits are required before physician signature.",
  sendDescription:
    "The current draft passes readiness checks. Sending it freezes the candidate version for hospice physician review and signature.",
  pendingHeading: "Hospice physician review pending",
  signatureStep: "Physician signature",
};
const TEAM_WORDING: ReviewWording = {
  readyHeading: "Ready for team signatures",
  readyDescription:
    "The clinical plan is complete. Sending it freezes this version for the IDG team's review and signatures.",
  sendFromGuide: "Send for team signatures",
  sendFromPanel: "Send to IDG team",
  frozenHeading: "Team review & signatures",
  frozenDescription:
    "Candidate content is frozen while the IDG team signs it. Return to draft only when clinical edits are required before signature.",
  sendDescription:
    "The current draft passes readiness checks. Sending it freezes the candidate version for the IDG team's review and signatures.",
  pendingHeading: "Team signatures pending",
  signatureStep: "Team signatures",
};
const reviewWording = (team: boolean): ReviewWording => (team ? TEAM_WORDING : PHYSICIAN_WORDING);

/** The version the response says was signed, if it says so (used only to select it in the history view). */
function signedVersionOf(value: unknown): Version | null {
  if (!value || typeof value !== "object") return null;
  const version = value as Partial<Version>;
  return version.status === "signed" && typeof version.id === "string"
    ? (version as Version)
    : null;
}

/** The re-read row for the thing a dialog is editing, so a retry after a stale refusal quotes the current version. */
function reseeded(state: NonNullable<ModalState>, plan: CarePlan): NonNullable<ModalState> {
  switch (state.kind) {
    case "problem": {
      const fresh = state.problem && plan.problems.find((p) => p.id === state.problem?.id);
      return fresh ? { ...state, problem: fresh } : state;
    }
    case "resolve_problem": {
      const fresh = plan.problems.find((p) => p.id === state.problem.id);
      return fresh ? { ...state, problem: fresh } : state;
    }
    case "goal": {
      const fresh = state.goal && plan.goals.find((g) => g.id === state.goal?.id);
      return fresh ? { ...state, goal: fresh } : state;
    }
    case "intervention": {
      const fresh =
        state.intervention && plan.interventions.find((i) => i.id === state.intervention?.id);
      return fresh ? { ...state, intervention: fresh } : state;
    }
    case "discontinue_intervention": {
      const fresh = plan.interventions.find((i) => i.id === state.intervention.id);
      return fresh ? { ...state, intervention: fresh } : state;
    }
    case "sign":
    case "return_to_draft": {
      const fresh = plan.versions.find((v) => v.id === state.version.id);
      return fresh ? { ...state, version: fresh } : state;
    }
  }
}

/** What identifies a dialog (not its row version): a re-seed keeps it, opening another one changes it. */
function modalIdentity(state: ModalState): string {
  if (!state) return "";
  const subject =
    state.kind === "problem" || state.kind === "resolve_problem"
      ? state.problem?.id
      : state.kind === "goal"
        ? state.goal?.id
        : state.kind === "intervention" || state.kind === "discontinue_intervention"
          ? state.intervention?.id
          : state.version.id;
  return `${state.kind}:${subject ?? "new"}`;
}

/**
 * Keyed by patient: moving to another chart remounts the workspace, so a write, dialog, notice or plan from the
 * previous patient can never land under the next patient's URL.
 */
export function CarePlanView(): JSX.Element {
  const { patientId } = useParams<{ patientId: string }>();
  return <CarePlanWorkspace key={patientId} />;
}

function CarePlanWorkspace(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const { patientId } = useParams<{ patientId: string }>();
  const identity = useChartIdentity(patientId);
  const stepUpOwner = useStepUpOwner();
  const returningFromStepUp = useStepUpReturn(stepUpOwner, STEP_UP_ACTIONS);
  const [plan, setPlan] = useState<CarePlan | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [review, setReview] = useState<ReviewStatus | null>(null);
  const [proposed, setProposed] = useState<ProposedChanges | null>(null);
  // The proposed-changes read can fail on its own: that is shown, never read as "there are none".
  const [proposedError, setProposedError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("goals");
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  // `loading` is the FIRST read only (full-page spinner). Every later read refreshes in place: unmounting
  // the workspace on each write would drop focus to <body>, reset scroll and remount the status notice.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /**
   * A write committed but the re-read after it failed, so what is on screen is stale. Authoring, finalize and
   * sign stay off until a re-read succeeds: re-entering a row that did save would create it a second time under
   * a new Idempotency-Key.
   */
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  // F-066 (#161) — the open admission `POST /patients/:id/care-plan` is keyed by, resolved only when no
  // plan exists. Automatic bootstrap on activation is the normal path; this is the recovery control when
  // it did not happen. `null` while unresolved or when the patient has no OPEN admission (a patient with
  // only discharged admissions is not under care, and bootstrapping a plan into one would be wrong).
  const [openAdmissionId, setOpenAdmissionId] = useState<string | null>(null);
  const [admissionsError, setAdmissionsError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const hasLoaded = useRef(false);
  const reloadSeq = useRef(0);
  const modalRef = useRef<ModalState>(null);
  /** Identity of the dialog open when the current write started ("" for a page-level write). */
  const writeOrigin = useRef("");
  const resumedSign = useRef(false);

  const canAuthor = hasPerm(session?.permissions, "care_plan.author");
  const canFinalize = hasPerm(session?.permissions, "care_plan.finalize");
  const canSign = hasPerm(session?.permissions, "care_plan.sign");
  const canBootstrap = hasPerm(session?.permissions, "care_plan.bootstrap");
  const pending = busy || refreshing || needsRefresh;

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

  /** Re-read the workspace. Never rejects: a read that got no answer becomes the page error, not a stuck spinner. */
  async function reload(message?: string): Promise<CarePlan | null> {
    if (!patientId) return null;
    const seq = ++reloadSeq.current;
    const first = !hasLoaded.current;
    if (first) setLoading(true);
    else setRefreshing(true);
    setError(null);
    // `message` reports a write that already succeeded: say so before the re-read, so a refresh that fails
    // cannot leave the screen silent about it (and the old state inviting a repeat that 409s).
    if (message) setNotice(message);
    try {
      const res = await getCarePlanWorkspace(client, patientId);
      if (seq !== reloadSeq.current) return null;
      const loadError = res.error
        ? errorMessage(res.error, "Could not load the Care Plan workspace.")
        : null;
      if (loadError) setError(message ? SAVED_REFRESH_FAILED_MESSAGE : loadError);
      // Stale only after a write that committed; a failed ordinary read does not make the screen newly stale.
      if (!loadError) setNeedsRefresh(false);
      else if (message) setNeedsRefresh(true);
      // A refresh that could not read the plan keeps the workspace on screen (with the error) rather than blanking it.
      if (loadError && !res.plan && !first) return null;
      setPlan(res.plan);
      setPatient(res.patient);
      setOpenAdmissionId(null);
      setAdmissionsError(null);
      if (!res.plan && !res.error) {
        // No plan yet — resolve the admission a bootstrap would hang off, so the empty state can offer
        // the create rather than assert that admission activation already did it (#161).
        const found = await loadPatientAdmissions(client, patientId);
        if (seq !== reloadSeq.current) return null;
        if (found.error) {
          setAdmissionsError(
            errorMessage(found.error, "Could not look up this patient's admissions."),
          );
        } else {
          setOpenAdmissionId(found.admissions.find((a) => a.dischargedAt == null)?.id ?? null);
        }
      }
      setReadiness(res.readiness);
      setReview(res.review);
      const open = res.plan?.versions.find((v) => v.status === "draft" || v.status === "in_review");
      setSelectedVersionId((current) => current ?? res.plan?.activeVersionId ?? open?.id ?? null);
      setProposed(null);
      setProposedError(null);
      if (res.plan && open?.kind === "idg_review") {
        const proposedRes = await getProposedChanges(client, res.plan.id, open.id);
        if (seq !== reloadSeq.current) return null;
        if (proposedRes.error) {
          setProposedError(
            errorMessage(proposedRes.error, "Could not load the IDG proposed changes."),
          );
        } else {
          setProposed(proposedRes.proposed);
        }
      }
      setNotice(message ?? null);
      hasLoaded.current = true;
      return res.plan;
    } catch {
      if (seq === reloadSeq.current) {
        setError(message ? SAVED_REFRESH_NO_RESPONSE_MESSAGE : LOAD_NO_RESPONSE_MESSAGE);
        if (message) setNeedsRefresh(true);
      }
      return null;
    } finally {
      if (seq === reloadSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: route patientId is the reload boundary.
  useEffect(() => {
    hasLoaded.current = false;
    setSelectedVersionId(null);
    void reload();
  }, [patientId]);

  useEffect(() => {
    modalRef.current = modal;
  }, [modal]);

  // A dialog shows the error of ITS action; opening or closing one starts from a clean slate so an
  // earlier refusal is not replayed inside an unrelated dialog. Keyed on WHICH dialog is open, not its row
  // version, so re-seeding a dialog with the re-read row keeps the refusal that explains the re-seed.
  const dialogIdentity = modalIdentity(modal);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dialog identity is the boundary.
  useEffect(() => {
    setModalError(null);
    setFieldErrors({});
  }, [dialogIdentity]);

  // Back from /step-up after a refused signature: reopen that version's sign dialog (its stashed role and
  // understanding note restore themselves). Only on a verified return: an abandoned draft is discarded.
  useEffect(() => {
    if (!returningFromStepUp || resumedSign.current || !plan) return;
    const versionId = findStepUpDraftResourceId(stepUpOwner, SIGN_ACTION);
    if (!versionId) return;
    const match = plan.versions.find((v) => v.id === versionId && v.status === "in_review");
    if (match) {
      resumedSign.current = true;
      setTab("revision");
      setModal({ kind: "sign", version: match });
    } else {
      clearStepUpDraft(stepUpDraftKey(stepUpOwner, SIGN_ACTION, versionId));
    }
  }, [returningFromStepUp, stepUpOwner, plan]);

  function closeModal(): void {
    if (modal?.kind === "sign") {
      clearStepUpDraft(stepUpDraftKey(stepUpOwner, SIGN_ACTION, modal.version.id));
    }
    setModal(null);
  }

  /** True while the dialog that started the in-flight write is still the open one (a page-level write has none). */
  function writeOriginStillOpen(): boolean {
    return modalIdentity(modalRef.current) === writeOrigin.current;
  }

  /**
   * A failure goes where the write came from: its own dialog, else the page. A dialog the user opened while a
   * page-level write was in flight (or after it moved on) is not that write's to report into.
   */
  function reportFailure(message: string, fields: FieldErrors = {}): void {
    if (modalRef.current && writeOriginStillOpen()) {
      setModalError(message);
      setFieldErrors(fields);
    } else {
      setError(message);
    }
  }

  async function refused(
    res: Extract<WriteResult<unknown>, { ok: false }>,
    draft?: StepUpDraft,
  ): Promise<false> {
    const returnTo = `${location.pathname}${location.search}`;
    const stepUp =
      stepUpRedirectFor(res.body, returnTo) ??
      (res.status === 403 && /step_up_recent/.test(res.message) ? stepUpPath(returnTo) : null);
    if (stepUp) {
      stashStepUpDraft(draft?.key ?? null, draft?.value);
      navigate(stepUp);
      return false;
    }
    if (isStaleVersion(res.body)) {
      // Someone else moved the plan. Re-read it and hand the open dialog the current rows, so the retry
      // quotes the current version while the text already typed stays where it is.
      const fresh = await reload();
      const current = modalRef.current;
      if (fresh && current && writeOriginStillOpen()) setModal(reseeded(current, fresh));
      // A re-read that failed (offline, superseded) left the dialog on the old version: do not claim the latest is loaded.
      reportFailure(fresh ? STALE_MESSAGE : STALE_RELOAD_FAILED_MESSAGE);
      return false;
    }
    if (isKeyStuck(res.body)) {
      // The first attempt may have committed after the key gave up, and the client renews the key now, so the
      // next click would be a NEW write. Show what the server holds before the user decides to repeat it.
      const fresh = await reload();
      const current = modalRef.current;
      if (fresh && current && writeOriginStillOpen()) setModal(reseeded(current, fresh));
    }
    reportFailure(
      carePlanErrorMessage(
        res.body,
        "The Care Plan action could not be completed. Please try again.",
      ),
      fieldErrorsOf(res.body),
    );
    return false;
  }

  const mutate: SubmitWrite = async (action, success, draft) => {
    writeOrigin.current = modalIdentity(modalRef.current);
    setBusy(true);
    if (modalRef.current) {
      setModalError(null);
      setFieldErrors({});
    } else {
      setError(null);
    }
    let res: WriteResult<unknown>;
    try {
      res = await action();
    } catch {
      // No answer at all (offline, a reset, an abort). The API client holds the idempotency key, so a
      // retry replays the same write instead of duplicating it.
      reportFailure(NO_RESPONSE_MESSAGE);
      return false;
    } finally {
      setBusy(false);
    }
    if (!res.ok) return refused(res, draft);

    clearStepUpDraft(draft?.key ?? null);
    // Close only the dialog that made this write; one the user opened meanwhile keeps what they typed.
    if (writeOriginStillOpen()) setModal(null);
    await reload(success);
    const signed = signedVersionOf(res.value);
    if (signed) setSelectedVersionId(signed.id);
    return true;
  };

  async function startVersion(kind: "interim_revision" | "idg_review"): Promise<void> {
    if (!plan) return;
    const accepted = await mutate(
      () => createVersion(client, plan.id, { kind }),
      kind === "idg_review" ? "Review draft opened." : "Condition-change revision opened.",
    );
    if (accepted) setTab("revision");
  }

  async function finalize(version: Version): Promise<void> {
    if (!plan) return;
    const accepted = await mutate(
      () => finalizeVersion(client, plan.id, version.id, { ifVersion: version.version }),
      "Version sent for signatures.",
    );
    if (accepted) setTab("revision");
  }

  async function startCarePlan(): Promise<void> {
    if (!patientId || !openAdmissionId || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const res = await bootstrapCarePlan(client, patientId, openAdmissionId);
      if (!res.ok) {
        setStartError(`Could not start the care plan. ${res.message}`);
        return;
      }
      await reload("Care plan started.");
    } catch {
      setStartError(`Could not start the care plan. ${NO_RESPONSE_MESSAGE}`);
    } finally {
      setStarting(false);
    }
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
        <EmptyState
          title="Plan of Care unavailable"
          description={error}
          action={<Button onClick={() => void reload()}>Try again</Button>}
        />
      </PatientChartBail>
    );
  }

  if (!plan) {
    const canStart = Boolean(openAdmissionId) && canBootstrap;
    return (
      <PatientChartBail banner={bailBanner} patientId={patientId} current="care-plan">
        <EmptyState
          title={admissionsError ? "Could not check admissions" : "No care plan yet"}
          description={
            admissionsError
              ? admissionsError
              : openAdmissionId
                ? canBootstrap
                  ? "Start the individualised plan of care for this admission (42 CFR 418.56(b)). Problems, goals, and interventions are added to it here."
                  : "No plan of care has been started for this admission, and your role cannot start one. Ask a user who can set up care plans."
                : "This patient has no open admission, so there is no admission to hang a plan of care on. Admit the patient first."
          }
          action={
            admissionsError ? (
              <Button onClick={() => void reload()}>Try again</Button>
            ) : canStart ? (
              <Button onClick={() => void startCarePlan()} disabled={starting}>
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
  const blockers = attentionBlockers(readiness, proposed, Boolean(activeVersion));
  const editable =
    canAuthor &&
    !needsRefresh &&
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
                {hasPerm(session?.permissions, "idg.read") ? (
                  <Link to={`/patients/${patientId}/idg-history`} className="wx-btn-primary">
                    IDG History
                  </Link>
                ) : null}
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
        <main style={mainPane} aria-busy={refreshing}>
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
          {error && !modal ? (
            <Notice tone="error">
              {error}
              {needsRefresh ? (
                <>
                  {" "}
                  <button
                    type="button"
                    className="wx-btn-secondary"
                    disabled={refreshing}
                    onClick={() => void reload()}
                  >
                    Refresh
                  </button>
                </>
              ) : null}
            </Notice>
          ) : null}
          {proposedError ? <Notice tone="error">{proposedError}</Notice> : null}
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
            busy={pending}
            onAddTerminal={() => setModal({ kind: "problem", defaultKind: "terminal" })}
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

          <div
            className="wx-subtabs"
            role="tablist"
            aria-label="Care Plan workspace views"
            onKeyDown={(e) => moveTab(e, tab, setTab)}
          >
            <TabButton id="goals" active={tab === "goals"} onSelect={setTab}>
              Goals
              <span className="wx-seg-count wx-nums">{plan.goals.length}</span>
            </TabButton>
            <TabButton id="interventions" active={tab === "interventions"} onSelect={setTab}>
              Interventions
            </TabButton>
            <TabButton id="problems" active={tab === "problems"} onSelect={setTab}>
              Problems
            </TabButton>
            <TabButton id="revision" active={tab === "revision"} onSelect={setTab}>
              Review & Sign
              {openVersion ? <span className="wx-seg-count wx-nums">1</span> : null}
            </TabButton>
            <TabButton id="history" active={tab === "history"} onSelect={setTab}>
              Revisions
            </TabButton>
          </div>

          <div
            role="tabpanel"
            id={tabPanelId(tab)}
            aria-labelledby={tabId(tab)}
            style={tabPanelStyle}
          >
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
                busy={pending}
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
          </div>
        </main>
      </div>

      {modal ? (
        <CarePlanModal
          state={modal}
          plan={plan}
          goals={plan.goals}
          problems={plan.problems}
          busy={pending}
          error={modalError}
          fieldErrors={fieldErrors}
          onClose={closeModal}
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
  const wording = reviewWording(isTeamReview(openVersion, readiness));

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
      missingSignatures === 0
        ? "Review version in progress"
        : onlyPhysicianOutstanding(readiness)
          ? PHYSICIAN_WORDING.pendingHeading
          : wording.pendingHeading;
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
        <button type="button" style={primaryBtn} disabled={busy} onClick={onOpenRevision}>
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
    action =
      hasBlocker(readiness, TERMINAL_BLOCKER) && canAuthor ? (
        <button type="button" style={primaryBtn} disabled={busy} onClick={onAddTerminal}>
          Add terminal problem
        </button>
      ) : (
        <button type="button" style={primaryBtn} disabled={busy} onClick={onContinue}>
          Continue Plan of Care
        </button>
      );
  } else if (hasOpenDraft && readiness?.canFinalize) {
    heading = wording.readyHeading;
    description = wording.readyDescription;
    state = "success";
    action = canFinalize ? (
      <button type="button" style={primaryBtn} disabled={busy} onClick={onFinalize}>
        {wording.sendFromGuide}
      </button>
    ) : (
      <button type="button" style={primaryBtn} disabled={busy} onClick={onOpenRevision}>
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
      <button type="button" style={primaryBtn} disabled={busy} onClick={onStartReview}>
        Start review
      </button>
    );
  } else if (!openVersion && activeVersion) {
    // An active plan can still carry readiness blockers (e.g. an IDG proposal in conflict); never
    // report "no action required" over them.
    heading = blockers.length ? "Care Plan needs attention" : "Care Plan is active";
    description = blockers.length
      ? (blockers[0] as string)
      : review?.nextReviewDueAt
        ? `No action is required now. Next review: ${formatDate(review.nextReviewDueAt)}.`
        : "No action is required now. Open a revision when the patient's condition or plan changes.";
    state = blockers.length ? "attention" : "success";
    action = canAuthor ? (
      <button type="button" style={ghostBtn} disabled={busy} onClick={onStartRevision}>
        Document condition change
      </button>
    ) : null;
  } else if (!openVersion && canAuthor) {
    heading = "Start the Care Plan";
    description = "Open the initial draft to begin documenting problems, goals, and interventions.";
    action = (
      <button type="button" style={primaryBtn} disabled={busy} onClick={onStartRevision}>
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

function WorkflowSteps({
  current,
  signatureStep,
}: {
  current: 0 | 1 | 2 | 3;
  signatureStep: string;
}): JSX.Element {
  const steps = ["Build plan", "Send for review", signatureStep, "Active"] as const;
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
                    <RowMenu label={`Actions for ${problem.description}`} buttonStyle={menuButton}>
                      {(done) => (
                        <>
                          <button
                            type="button"
                            style={menuItem}
                            onClick={() => {
                              done();
                              onProblem(problem);
                            }}
                          >
                            Edit problem
                          </button>
                          {problem.status === "active" ? (
                            <button
                              type="button"
                              style={menuItem}
                              onClick={() => {
                                done();
                                onResolveProblem(problem);
                              }}
                            >
                              Resolve problem
                            </button>
                          ) : null}
                        </>
                      )}
                    </RowMenu>
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
              <button type="button" style={ghostBtn} disabled={busy} onClick={onStartRevision}>
                Document condition change
              </button>
            ) : null}
            {canAuthor && review?.canStartReview ? (
              <button type="button" style={primaryBtn} disabled={busy} onClick={onStartReview}>
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
  // The server's verdict, not an inference from a read that may have failed: an absent `proposed` is "unknown".
  const idgProposalRequired = hasBlocker(readiness, IDG_PROPOSAL_BLOCKER);
  const proposalConflict = conflictedProposals(proposed).length > 0;
  const blockers = attentionBlockers(readiness, proposed, Boolean(plan.activeVersionId));
  const wording = reviewWording(isTeamReview(version, readiness));
  const sendReady = Boolean(readiness?.canFinalize) && !idgProposalRequired && !proposalConflict;

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
          signatureStep={wording.signatureStep}
        />
      </div>

      {version.status === "draft" ? (
        <section style={subPanel}>
          <div style={sectionHeader}>
            <div>
              <h3 style={smallTitle}>
                {idgProposalRequired
                  ? "Record IDG proposed changes"
                  : sendReady
                    ? wording.readyHeading
                    : "Before you can send this version"}
              </h3>
              <p style={muted}>
                {idgProposalRequired
                  ? "An IDG review must contain at least one proposed Care Plan change. Record the IDG decision first, then send this version for signature."
                  : sendReady
                    ? wording.sendDescription
                    : "Resolve the remaining requirements, then review the candidate version."}
              </p>
            </div>

            {canFinalize ? (
              <button
                type="button"
                style={sendReady ? primaryBtn : disabledBtn}
                disabled={!sendReady || busy}
                onClick={() => void onFinalize(version)}
              >
                {wording.sendFromPanel}
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
              <h3 style={smallTitle}>{wording.frozenHeading}</h3>
              <p style={muted}>{wording.frozenDescription}</p>
            </div>
            <div style={actionsRow}>
              {canAuthor ? (
                <button
                  type="button"
                  style={ghostBtn}
                  disabled={busy}
                  onClick={() => onReturn(version)}
                >
                  Return to draft
                </button>
              ) : null}
              {canSign && readiness?.canSign ? (
                <button
                  type="button"
                  style={primaryBtn}
                  disabled={busy}
                  onClick={() => onSign(version)}
                >
                  Review & sign
                </button>
              ) : null}
            </div>
          </div>
          <SignaturePanel readiness={readiness} version={version} />
        </section>
      ) : null}

      {proposed && (proposed.changes.length || proposalConflict) ? (
        <IdgProposal proposed={proposed} />
      ) : null}

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
      {conflictedProposals(proposed).map((proposal) => (
        <Notice key={proposal.id} tone="warning">
          {`This proposal conflicts with newer Care Plan content (${conflictReasonText(proposal.conflictReason)}). It cannot be sent for signature until it is resolved.`}
        </Notice>
      ))}
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
        <Notice tone="warning">No snapshot is available for this version.</Notice>
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
      {snapshot.redacted === true ? <RestrictedContentNote /> : null}
      <SnapshotGroup
        title="Problems"
        items={problems.map((p) => `${p.description} · ${cap(p.kind)} · ${cap(p.status)}`)}
        redacted={snapshot.redacted === true}
      />
      <SnapshotGroup
        title="Goals"
        items={goals.map((g) => `${g.revisedText ?? g.originalText} · ${cap(g.status)}`)}
        redacted={snapshot.redacted === true}
      />
      <SnapshotGroup
        title="Interventions"
        items={interventions.map(
          (i) => `${i.scopeText} · ${cap(i.discipline)} · ${i.frequencyText} · ${cap(i.status)}`,
        )}
        redacted={snapshot.redacted === true}
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

// Same wording as version-history.tsx: acronym roles keep their casing ("RN Case Manager", "MSW").
const ROLE_LABEL: Readonly<Record<string, string>> = {
  rn_case_manager: "RN Case Manager",
  msw: "MSW",
};
function roleLabel(role: string): string {
  return role
    .split("|")
    .map((r) => ROLE_LABEL[r] ?? cap(r))
    .join(" or ");
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

/**
 * The ⋯ actions menu of a row. A bare `<details>` stays open after an item is chosen and ignores Escape, so
 * this closes it on selection (`done`) and on Escape (returning focus to the toggle).
 */
function RowMenu({
  label,
  buttonStyle,
  children,
}: {
  label: string;
  buttonStyle: CSSProperties;
  /** Receives `done`: call it when an item is chosen so the menu folds away. */
  children: (done: () => void) => ReactNode;
}): JSX.Element {
  const menu = useRef<HTMLDetailsElement>(null);
  const close = (restoreFocus: boolean): void => {
    const el = menu.current;
    if (!el?.open) return;
    el.open = false;
    if (restoreFocus) el.querySelector("summary")?.focus();
  };
  return (
    <details
      ref={menu}
      style={menuWrap}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !menu.current?.open) return;
        e.stopPropagation();
        close(true);
      }}
    >
      <summary style={buttonStyle} aria-label={label}>
        <span aria-hidden="true">⋯</span>
      </summary>
      <div style={menuPopover}>{children(() => close(false))}</div>
    </details>
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
          {goal.measurableOutcome ?? "No measurable outcome"} · target{" "}
          {formatCalendarDate(goal.targetAt)}
          {goal.statusNote ? ` · ${goal.statusNote}` : ""}
        </p>
      </div>
      <StatusPill label={cap(goal.status)} tone={toneFor(goal.status)} />
      {editable && isGoalEditable(goal.status) ? (
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
      {editable && isInterventionEditable(intervention.status) ? (
        <RowMenu label="Intervention actions" buttonStyle={rowMenuButton}>
          {(done) => (
            <>
              <button
                type="button"
                style={menuItem}
                onClick={() => {
                  done();
                  onEdit();
                }}
              >
                Edit intervention
              </button>
              {intervention.status === "active" ? (
                <button
                  type="button"
                  style={menuItem}
                  onClick={() => {
                    done();
                    onDiscontinue();
                  }}
                >
                  Discontinue
                </button>
              ) : null}
            </>
          )}
        </RowMenu>
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
  fieldErrors,
  onClose,
  onSubmit,
}: {
  state: NonNullable<ModalState>;
  plan: CarePlan;
  goals: Goal[];
  problems: Problem[];
  busy: boolean;
  error: string | null;
  fieldErrors: FieldErrors;
  onClose: () => void;
  onSubmit: SubmitWrite;
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
    // The dialog holds typed clinical text, so a stray scrim click must not discard it; and while a write is in
    // flight neither Escape nor Close may abandon it (its answer would land in a dialog that is gone).
    <Modal
      open
      onClose={busy ? undefined : onClose}
      dismissOnScrim={false}
      ariaLabel={title}
      width="40rem"
    >
      <div style={modalBody}>
        <h2 style={sectionTitle}>{title}</h2>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {state.kind === "problem" ? (
          <ProblemForm
            state={state}
            plan={plan}
            busy={busy}
            fieldErrors={fieldErrors}
            onSubmit={onSubmit}
          />
        ) : null}
        {state.kind === "resolve_problem" ? (
          <NoteForm
            label="Resolution note"
            busy={busy}
            submitLabel="Resolve"
            onSubmit={(note) =>
              onSubmit(
                () =>
                  resolveProblem(client, plan.id, state.problem.id, state.problem.version, note),
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
            fieldErrors={fieldErrors}
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
            fieldErrors={fieldErrors}
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
                () =>
                  discontinueIntervention(
                    client,
                    plan.id,
                    state.intervention.id,
                    state.intervention.version,
                    reason,
                  ),
                "Intervention discontinued.",
              )
            }
          />
        ) : null}
        {state.kind === "sign" ? (
          <SignForm
            state={state}
            plan={plan}
            busy={busy}
            fieldErrors={fieldErrors}
            onSubmit={onSubmit}
          />
        ) : null}
        {state.kind === "return_to_draft" ? (
          <ConfirmPanel
            busy={busy}
            text="Returning this version to draft invalidates existing signatures. Active signed Care Plan content is not changed."
            label="Return to draft"
            onConfirm={() =>
              onSubmit(
                () => returnToDraft(client, plan.id, state.version.id, state.version.version),
                "Version returned to draft.",
              )
            }
          />
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" style={ghostBtn} disabled={busy} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The update contract carries no nulls, so a value that was recorded can be replaced but not blanked. */
const CANNOT_CLEAR = "A recorded value can be changed but not cleared. Enter a replacement.";
const wasCleared = (recorded: string | null | undefined, entered: string): boolean =>
  Boolean(recorded) && !entered.trim();

/**
 * A form field seeded from a row. Until the user touches it, it follows a re-read of the row, so a retry after
 * a stale-version refusal neither shows nor writes back text that someone else has since changed. `dirty` is
 * "differs from the row as last read": an update sends only the dirty fields, so it cannot revert a field the
 * user never edited.
 */
function useSeededField<T>(seed: T): readonly [T, (value: T) => void, boolean] {
  const [value, setValue] = useState<T>(seed);
  const previousSeed = useRef(seed);
  useEffect(() => {
    const previous = previousSeed.current;
    previousSeed.current = seed;
    if (Object.is(previous, seed)) return;
    setValue((current) => (Object.is(current, previous) ? seed : current));
  }, [seed]);
  return [value, setValue, !Object.is(value, seed)] as const;
}

function ProblemForm({
  state,
  plan,
  busy,
  fieldErrors,
  onSubmit,
}: {
  state: Extract<NonNullable<ModalState>, { kind: "problem" }>;
  plan: CarePlan;
  busy: boolean;
  fieldErrors: FieldErrors;
  onSubmit: SubmitWrite;
}): JSX.Element {
  const client = useApiClient();
  const editing = state.problem;
  const [description, setDescription, descriptionDirty] = useSeededField(
    editing?.description ?? "",
  );
  const [kind, setKind, kindDirty] = useSeededField<ProblemKind>(
    pick(PROBLEM_KINDS, editing?.kind ?? state.defaultKind, "related"),
  );
  const [source, setSource] = useState<ProblemSource>(
    pick(
      PROBLEM_SOURCE_OPTIONS.map((o) => o.value),
      editing?.source,
      "clinical",
    ),
  );
  const [icd10Code, setIcd10Code, icd10Dirty] = useSeededField(editing?.icd10Code ?? "");
  const [snomedCode, setSnomedCode, snomedDirty] = useSeededField(editing?.snomedCode ?? "");
  const [sudRelated, setSudRelated] = useState(editing?.sudRelated ?? false);
  const clearedIcd10 = wasCleared(editing?.icd10Code, icd10Code);
  const clearedSnomed = wasCleared(editing?.snomedCode, snomedCode);
  const unchanged =
    Boolean(editing) && !(descriptionDirty || kindDirty || icd10Dirty || snomedDirty);

  return (
    <form
      style={form}
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(
          () =>
            editing
              ? // Only what the user changed: a field they never touched must not overwrite a newer value.
                patchProblem(client, plan.id, editing.id, editing.version, {
                  ...(descriptionDirty ? { description } : {}),
                  ...(kindDirty ? { kind } : {}),
                  ...(icd10Dirty ? { icd10Code: icd10Code || undefined } : {}),
                  ...(snomedDirty ? { snomedCode: snomedCode || undefined } : {}),
                })
              : createProblem(client, plan.id, {
                  description,
                  kind,
                  source,
                  icd10Code: icd10Code || undefined,
                  snomedCode: snomedCode || undefined,
                  sudRelated,
                }),
          editing ? "Problem updated." : "Problem added.",
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
          error={fieldErrors.description}
        />
        <div style={fieldGrid2}>
          <Select
            label="Problem type"
            value={kind}
            onChange={(v) => setKind(pick(PROBLEM_KINDS, v, kind))}
            options={PROBLEM_KINDS}
            hint="Terminal problems anchor the hospice plan of care."
            error={fieldErrors.kind}
          />
          {!editing ? (
            <Select
              label="Source"
              value={source}
              onChange={(v) =>
                setSource(
                  pick(
                    PROBLEM_SOURCE_OPTIONS.map((o) => o.value),
                    v,
                    source,
                  ),
                )
              }
              options={PROBLEM_SOURCE_OPTIONS}
              error={fieldErrors.source}
            />
          ) : null}
        </div>
      </FormSection>

      <FormSection
        title="Clinical coding"
        description="Add coding when available. Search by code or description."
      >
        <div style={fieldGrid2}>
          <CodeSearchInput
            label="ICD-10 code"
            system="icd10cm"
            value={icd10Code}
            onChange={(code) => setIcd10Code(code)}
            placeholder="Search ICD-10-CM, e.g. I50.84 or heart failure"
            error={fieldErrors.icd10Code ?? (clearedIcd10 ? CANNOT_CLEAR : undefined)}
          />
          <CodeSearchInput
            label="SNOMED code"
            system="snomed"
            value={snomedCode}
            onChange={(code) => setSnomedCode(code)}
            placeholder="Optional. Search SNOMED CT by code or description"
            error={fieldErrors.snomedCode ?? (clearedSnomed ? CANNOT_CLEAR : undefined)}
          />
        </div>
      </FormSection>

      {!editing ? (
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
        <button
          type="submit"
          style={primaryBtn}
          disabled={busy || unchanged || !description.trim() || clearedIcd10 || clearedSnomed}
        >
          {busy ? "Saving..." : "Save problem"}
        </button>
      </div>
    </form>
  );
}

function GoalForm({
  state,
  plan,
  problems,
  busy,
  fieldErrors,
  onSubmit,
}: {
  state: Extract<NonNullable<ModalState>, { kind: "goal" }>;
  plan: CarePlan;
  problems: Problem[];
  busy: boolean;
  fieldErrors: FieldErrors;
  onSubmit: SubmitWrite;
}): JSX.Element {
  const client = useApiClient();
  const editing = state.goal;
  const [problemId, setProblemId] = useState(
    editing?.problemId ?? state.problemId ?? problems[0]?.id ?? "",
  );
  const [text, setText, textDirty] = useSeededField(
    editing?.revisedText ?? editing?.originalText ?? "",
  );
  const [source, setSource] = useState<GoalSource>(pick(GOAL_SOURCES, editing?.source, "clinical"));
  const [outcome, setOutcome, outcomeDirty] = useSeededField(editing?.measurableOutcome ?? "");
  const [targetAt, setTargetAt, targetDirty] = useSeededField(
    editing?.targetAt?.slice(0, 10) ?? "",
  );
  const statusSeed = pick(GOAL_STATUSES, editing?.status, "not_started");
  const [pickedStatus, setStatus] = useSeededField<GoalStatus>(statusSeed);
  const statusOptions = editing ? goalStatusOptions(statusSeed) : GOAL_STATUSES;
  // After a stale re-read the row may have moved on (e.g. to a terminal status), leaving the user's pick illegal:
  // fall back to the row's status rather than keep a value the select no longer offers.
  const status: GoalStatus = statusOptions.includes(pickedStatus) ? pickedStatus : statusSeed;
  const statusDirty = status !== statusSeed;
  const clearedOutcome = wasCleared(editing?.measurableOutcome, outcome);
  const clearedTarget = wasCleared(editing?.targetAt, targetAt);
  // A date input can hold a year `new Date` cannot read (a 5-digit year); say so instead of throwing on submit.
  const targetInvalid = Boolean(targetAt) && Number.isNaN(Date.parse(targetAt));
  const unchanged = Boolean(editing) && !(textDirty || outcomeDirty || targetDirty || statusDirty);
  return (
    <form
      style={form}
      onSubmit={(e) => {
        e.preventDefault();
        if (targetInvalid) return;
        // A date input yields a calendar day; the contract wants a date-time, sent as that day at UTC midnight.
        const targetIso = targetAt ? new Date(targetAt).toISOString() : undefined;
        void onSubmit(
          () =>
            editing
              ? // Only what the user changed: a field they never touched must not overwrite a newer value
                // (and an unedited statement must not be recorded as a revision of the patient's own words).
                patchGoal(client, plan.id, editing.id, editing.version, {
                  ...(textDirty ? { revisedText: text } : {}),
                  ...(outcomeDirty ? { measurableOutcome: outcome || undefined } : {}),
                  ...(statusDirty ? { status } : {}),
                  ...(targetDirty ? { targetAt: targetIso } : {}),
                })
              : createGoal(client, plan.id, {
                  problemId,
                  originalText: text,
                  source,
                  measurableOutcome: outcome || undefined,
                  targetAt: targetIso,
                }),
          editing ? "Goal updated." : "Goal added.",
        );
      }}
    >
      <FormSection
        title="Goal"
        description="Describe the patient-centered result the team is working toward."
      >
        {!editing ? (
          <Select
            label="Linked problem"
            value={problemId}
            onChange={setProblemId}
            options={problems.map((p) => ({
              value: p.id,
              label: p.description,
            }))}
            error={fieldErrors.problemId}
          />
        ) : null}
        <TextArea
          label="Goal statement"
          value={text}
          onChange={setText}
          placeholder="e.g. Patient will report dyspnea is manageable at rest"
          required
          error={fieldErrors.originalText ?? fieldErrors.revisedText}
        />
      </FormSection>

      <FormSection title="Outcome & timing">
        <TextField
          label="Measurable outcome"
          value={outcome}
          onChange={setOutcome}
          placeholder="e.g. Dyspnea rated 3/10 or less at rest"
          error={fieldErrors.measurableOutcome ?? (clearedOutcome ? CANNOT_CLEAR : undefined)}
        />
        <div style={fieldGrid2}>
          <TextField
            label="Target date"
            value={targetAt}
            onChange={setTargetAt}
            type="date"
            error={
              fieldErrors.targetAt ??
              (clearedTarget ? CANNOT_CLEAR : targetInvalid ? "Enter a valid date." : undefined)
            }
          />
          {editing ? (
            <Select
              label="Status"
              value={status}
              onChange={(v) => setStatus(pick(statusOptions, v, status))}
              options={statusOptions}
              error={fieldErrors.status}
            />
          ) : (
            <Select
              label="Source"
              value={source}
              onChange={(v) => setSource(pick(GOAL_SOURCES, v, source))}
              options={GOAL_SOURCES}
              error={fieldErrors.source}
            />
          )}
        </div>
      </FormSection>

      <div style={formActions}>
        <button
          type="submit"
          style={primaryBtn}
          disabled={
            busy ||
            unchanged ||
            !text.trim() ||
            !problemId ||
            clearedOutcome ||
            clearedTarget ||
            targetInvalid
          }
        >
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
  fieldErrors,
  onSubmit,
}: {
  state: Extract<NonNullable<ModalState>, { kind: "intervention" }>;
  plan: CarePlan;
  problems: Problem[];
  goals: Goal[];
  busy: boolean;
  fieldErrors: FieldErrors;
  onSubmit: SubmitWrite;
}): JSX.Element {
  const client = useApiClient();
  const editing = state.intervention;
  const [problemId, setProblemId] = useState(
    editing?.problemId ?? state.problemId ?? problems[0]?.id ?? "",
  );
  const [scopeText, setScopeText, scopeDirty] = useSeededField(editing?.scopeText ?? "");
  const [frequencyText, setFrequencyText, frequencyTextDirty] = useSeededField(
    editing?.frequencyText ?? "",
  );
  const [frequencyValue, setFrequencyValue, frequencyValueDirty] = useSeededField(
    editing?.frequencyValue ?? "",
  );
  const [discipline, setDiscipline] = useState<InterventionDiscipline>(
    pick(DISCIPLINES, editing?.discipline, "rn"),
  );
  const [responsibleRole, setResponsibleRole, roleDirty] = useSeededField(
    editing?.responsibleRole ?? "",
  );
  const [goalRef, setGoalRef] = useState(editing?.goalRefs[0] ?? "");
  const clearedRole = wasCleared(editing?.responsibleRole, responsibleRole);
  const unchanged =
    Boolean(editing) && !(scopeDirty || frequencyTextDirty || frequencyValueDirty || roleDirty);
  const goalOptions = goals
    .filter((g) => g.problemId === problemId)
    .map((g) => ({ value: g.id, label: g.revisedText ?? g.originalText }));
  return (
    <form
      style={form}
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(
          () =>
            editing
              ? // Only what the user changed: a field they never touched must not overwrite a newer value.
                patchIntervention(client, plan.id, editing.id, editing.version, {
                  ...(scopeDirty ? { scopeText } : {}),
                  ...(frequencyTextDirty ? { frequencyText } : {}),
                  ...(frequencyValueDirty ? { frequencyValue } : {}),
                  ...(roleDirty ? { responsibleRole: responsibleRole || undefined } : {}),
                })
              : createIntervention(client, plan.id, {
                  problemId,
                  goalRefs: goalRef ? [goalRef] : [],
                  scopeText,
                  frequencyText,
                  frequencyValue,
                  discipline,
                  responsibleRole: responsibleRole || undefined,
                }),
          editing ? "Intervention updated." : "Intervention added.",
        );
      }}
    >
      <FormSection
        title="Intervention"
        description="Describe what the care team should do for this problem."
      >
        {!editing ? (
          <Select
            label="Linked problem"
            value={problemId}
            onChange={(v) => {
              setProblemId(v);
              // The linked goal is chosen from THIS problem's goals; a goal of the previous problem is no longer offered.
              setGoalRef("");
            }}
            options={problems.map((p) => ({
              value: p.id,
              label: p.description,
            }))}
            error={fieldErrors.problemId}
          />
        ) : null}
        <TextArea
          label="Intervention / scope"
          value={scopeText}
          onChange={setScopeText}
          placeholder="e.g. Assess respiratory status and reinforce comfort measures"
          required
          error={fieldErrors.scopeText}
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
            error={fieldErrors.frequencyText}
          />
          <TextField
            label="Frequency value"
            value={frequencyValue}
            onChange={setFrequencyValue}
            placeholder="e.g. 2"
            required
            error={fieldErrors.frequencyValue}
          />
        </div>
      </FormSection>

      <FormSection title="Assignment & relationship">
        <div style={fieldGrid2}>
          {!editing ? (
            <Select
              label="Discipline"
              value={discipline}
              onChange={(v) => setDiscipline(pick(DISCIPLINES, v, discipline))}
              options={DISCIPLINES}
              error={fieldErrors.discipline}
            />
          ) : null}
          <TextField
            label="Responsible role"
            value={responsibleRole}
            onChange={setResponsibleRole}
            placeholder="e.g. Primary RN"
            error={fieldErrors.responsibleRole ?? (clearedRole ? CANNOT_CLEAR : undefined)}
          />
        </div>
        {!editing ? (
          <Select
            label="Linked goal"
            value={goalRef}
            onChange={setGoalRef}
            options={[{ value: "", label: "No linked goal" }, ...goalOptions]}
            hint="Optional. Link the intervention to the goal it supports."
            error={fieldErrors.goalRefs}
          />
        ) : null}
      </FormSection>

      <div style={formActions}>
        <button
          type="submit"
          style={primaryBtn}
          disabled={
            busy ||
            unchanged ||
            !scopeText.trim() ||
            !frequencyText.trim() ||
            !frequencyValue.trim() ||
            clearedRole
          }
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
  fieldErrors,
  onSubmit,
}: {
  state: Extract<NonNullable<ModalState>, { kind: "sign" }>;
  plan: CarePlan;
  busy: boolean;
  fieldErrors: FieldErrors;
  onSubmit: SubmitWrite;
}): JSX.Element {
  const client = useApiClient();
  const owner = useStepUpOwner();
  const draftKey = stepUpDraftKey(owner, SIGN_ACTION, state.version.id);
  // Back from a step-up round trip the chosen role and the typed note come back from memory (never Web Storage).
  const [restored] = useState(() =>
    peekStepUpDraft<{ role?: unknown; understanding?: unknown }>(draftKey),
  );
  const openSlot = state.version.requiredSignerSet.find(
    (slot) =>
      state.version.signatures.filter((s) => roleSatisfiesSlot(slot.role, s.signerRole)).length <
      slot.count,
  );
  const [role, setRole] = useState(
    typeof restored?.role === "string"
      ? restored.role
      : preferredSigningRole(openSlot?.role ?? state.version.requiredSignerSet[0]?.role ?? ""),
  );
  const [understanding, setUnderstanding] = useState(
    typeof restored?.understanding === "string" ? restored.understanding : "",
  );
  const snapshot = snapshotOf(state.version);
  return (
    <form
      style={form}
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(
          () =>
            signVersion(client, plan.id, state.version.id, {
              ifVersion: state.version.version,
              // Which slot the caller is filling; the server matches it against the caller's own grants.
              signerRole: role as SignerRole,
              patientUnderstandingText: understanding || undefined,
            }),
          "Signature recorded.",
          { key: draftKey, value: { role, understanding } },
        );
      }}
    >
      <section aria-label="Version being signed" style={subPanel}>
        <h3 style={smallTitle}>
          v{state.version.sequence} · {cap(state.version.kind)}
        </h3>
        {snapshot ? (
          <>
            <div style={summaryStrip}>
              <SummaryFact label="Problems" value={snapshot.problems?.length ?? 0} />
              <SummaryFact label="Goals" value={snapshot.goals?.length ?? 0} />
              <SummaryFact label="Interventions" value={snapshot.interventions?.length ?? 0} />
            </div>
            {snapshot.redacted === true ? <RestrictedContentNote /> : null}
          </>
        ) : (
          <p style={muted}>The frozen content counts are unavailable for this version.</p>
        )}
      </section>
      <SignatureList
        slots={state.version.requiredSignerSet}
        signatures={state.version.signatures}
      />
      <Select
        label="Signing role"
        value={role}
        onChange={setRole}
        options={signingRoleOptions(state.version.requiredSignerSet)}
        error={fieldErrors.signerRole}
      />
      <TextArea
        label="Patient/family understanding note"
        value={understanding}
        onChange={setUnderstanding}
        error={fieldErrors.patientUnderstandingText}
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
  onSubmit: (note: string) => Promise<unknown>;
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
  onConfirm: () => Promise<unknown>;
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

/** `aria-describedby` / `aria-invalid` wiring for a field's error and hint text. */
function useFieldDescription(
  error: string | null | undefined,
  hint: string | undefined,
): { errorId: string; hintId: string; describedBy: string | undefined; invalid: true | undefined } {
  const base = useId();
  const errorId = `${base}-error`;
  const hintId = `${base}-hint`;
  const ids = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ");
  return { errorId, hintId, describedBy: ids || undefined, invalid: error ? true : undefined };
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
  const described = useFieldDescription(error, hint);
  return (
    <label style={field}>
      <span style={fieldLabel}>
        {label}
        {required ? <span style={requiredMark}> *</span> : null}
      </span>
      <input
        aria-label={label}
        aria-invalid={described.invalid}
        aria-describedby={described.describedBy}
        value={value}
        type={type}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={input}
      />
      {error ? (
        <span id={described.errorId} style={fieldErrorText}>
          {error}
        </span>
      ) : null}
      {hint ? (
        <span id={described.hintId} style={fieldHint}>
          {hint}
        </span>
      ) : null}
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
  const described = useFieldDescription(error, hint);
  return (
    <label style={field}>
      <span style={fieldLabel}>
        {label}
        {required ? <span style={requiredMark}> *</span> : null}
      </span>
      <textarea
        aria-label={label}
        aria-invalid={described.invalid}
        aria-describedby={described.describedBy}
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        style={textarea}
      />
      {error ? (
        <span id={described.errorId} style={fieldErrorText}>
          {error}
        </span>
      ) : null}
      {hint ? (
        <span id={described.hintId} style={fieldHint}>
          {hint}
        </span>
      ) : null}
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
  const described = useFieldDescription(error, hint);
  return (
    <label style={field}>
      <span style={fieldLabel}>{label}</span>
      <select
        aria-label={label}
        aria-invalid={described.invalid}
        aria-describedby={described.describedBy}
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
      {error ? (
        <span id={described.errorId} style={fieldErrorText}>
          {error}
        </span>
      ) : null}
      {hint ? (
        <span id={described.hintId} style={fieldHint}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function SnapshotGroup({
  title: heading,
  items,
  redacted = false,
}: {
  title: string;
  items: string[];
  /** The server withheld content from this snapshot, so an empty list does not mean nothing was recorded. */
  redacted?: boolean;
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
        <p style={muted}>{redacted ? "None shown to your role." : "None recorded."}</p>
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

const TAB_ORDER: readonly Tab[] = ["goals", "interventions", "problems", "revision", "history"];
const tabId = (tab: Tab): string => `care-plan-tab-${tab}`;
const tabPanelId = (tab: Tab): string => `care-plan-tabpanel-${tab}`;

/** Arrow keys / Home / End move between tabs (the tablist is one tab stop; the active tab is it). */
function moveTab(e: KeyboardEvent, current: Tab, select: (tab: Tab) => void): void {
  const index = TAB_ORDER.indexOf(current);
  const next =
    e.key === "ArrowRight"
      ? TAB_ORDER[(index + 1) % TAB_ORDER.length]
      : e.key === "ArrowLeft"
        ? TAB_ORDER[(index - 1 + TAB_ORDER.length) % TAB_ORDER.length]
        : e.key === "Home"
          ? TAB_ORDER[0]
          : e.key === "End"
            ? TAB_ORDER[TAB_ORDER.length - 1]
            : undefined;
  if (!next) return;
  e.preventDefault();
  select(next);
  document.getElementById(tabId(next))?.focus();
}

function TabButton({
  id,
  active,
  onSelect,
  children,
}: {
  id: Tab;
  active: boolean;
  onSelect: (tab: Tab) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      id={tabId(id)}
      aria-selected={active}
      aria-controls={active ? tabPanelId(id) : undefined}
      tabIndex={active ? 0 : -1}
      style={active ? activeTab : tabBtn}
      onClick={() => onSelect(id)}
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
const tabPanelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space4,
  minWidth: 0,
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
