import { HOPE_ATTESTATION_VERSION, normalizeSsn, ssnCmsProblem } from "@chartwarden/types";
import {
  Button,
  CountBadge,
  EmptyState,
  ErrorState,
  Glyph,
  type GlyphName,
  InfoRows,
  InlineAlert,
  Panel,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  ageYears,
  settleRead,
  t,
  useApiClient,
} from "@chartwarden/ui";
// Phase 4 Admission HOPE workspace. The backend owns CMS spec, applicability, validation, SFV,
// readiness, and signing; this screen renders that state and sends canonical set/clear answer patches.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AmendmentDialog } from "./hope-amendment-dialog";
import {
  ATTESTATION_STALE_CODE,
  ATTESTATION_STALE_MESSAGE,
  REFUSED_WITHOUT_REASON,
  type SignAssessmentBody,
  errorCodeOf,
  failedWriteMessage,
  isClientRefusal,
  isRefusalBody,
  isStaleVersionRefusal,
  localToday,
  readSucceeded,
  refusalWordsOf,
  serverFaultMessage,
  withRequestTimeout,
  writeOutcomeUnknown,
  writeSucceeded,
} from "./hope-api";
import { useStepUpRedirect } from "./hope-attestation";
import {
  type ChartNumber,
  type ChartPayer,
  ChartReconcileDialog,
  HopeAnswerNotSavedError,
  type ReconcileItem,
} from "./hope-chart-reconcile";
import { actionRow, inputStyle, muted, primaryButton, secondaryButton } from "./hope-dialog-styles";
import { formatDate, formatInstant, formatTargetDate } from "./hope-format";
import {
  NAV_MODE_KEY,
  type NavMode,
  readNavMode,
  readStorage,
  writeStorage,
} from "./hope-nav-storage";
import { LoadingRegion, useRetryFocus } from "./hope-retry-focus";
import { CONFLICT_FIELD_ERROR, type SaveStatus, withoutConflictErrors } from "./hope-save-status";
import { CompleteSfvDialog } from "./hope-sfv-complete-dialog";
import { useSfvFlow } from "./hope-sfv-flow";
import type { SfvLookup } from "./hope-sfv-lookup";
import { ReviewSfvDialog } from "./hope-sfv-review-dialog";
import { SfvWorkflowSection } from "./hope-sfv-section";
import { SignDialog } from "./hope-sign-dialog";
import { ASSESSMENT_TONE, rfaLabel, stateLabel } from "./hope-status";
import { SummaryRequestNotice } from "./hope-summary-notice";
import {
  CheckboxTiles,
  ClinicalSection,
  CmsCode,
  FieldShell,
  GroupSubNav,
  LockedValue,
  type NavSectionView,
  OptionRows,
  ProgressBar,
  RequiredChip,
  SectionNavigator,
} from "./hope-workspace-ui";
import { IqiesSubmissionPanel } from "./iqies-submission-panel";
import { useFocusOnNewError } from "./use-focus-on-new-error";
import { useHopeRecordActions } from "./use-hope-record-actions";
import { useWorkspaceScrolling } from "./use-hope-workspace-scrolling";

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
    timingState: "upcoming" | "within_window" | "due_soon" | "late" | "completed" | "unknown";
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
  id?: string;
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

/** Chart context for the banner + Patient Summary rail (M5 demographics / identifiers / addresses). */
interface PatientExtra {
  sex: string | null;
  mbiTail: string | null;
  /** The chart's Medicare number (MBI, else Medicare coverage subscriber ID) — compared to A0600B. */
  medicareOnChart: ChartNumber | null;
  /** The chart's Medicaid number (current Medicaid coverage subscriber ID) — compared to A0700. */
  medicaidOnChart: ChartNumber | null;
  /** The patient's coverage rows — the reconcile dialog re-files / ranks against them. */
  payers: ChartPayer[];
  address: string | null;
  /**
   * Whether the chart numbers above were READ: `loading` until the first read ends, `unavailable` when it failed (the numbers
   * are then unknown, not absent: the screen must not say a number is "not on the chart"), `known` once a read succeeded.
   */
  chartStatus: "loading" | "known" | "unavailable";
}

type ChartNumbers = Pick<PatientExtra, "medicareOnChart" | "medicaidOnChart" | "payers">;

/**
 * Reads the chart's identifiers + coverage and resolves the Medicare / Medicaid numbers; null when either read did not
 * succeed. A failed read (an empty 502, a 403) is not an empty chart: callers keep what they had, and never offer to add a
 * number to a chart whose coverage they could not read.
 */
async function fetchChartNumbers(
  api: HopeApiCompat,
  patientId: string,
  signal?: AbortSignal,
): Promise<ChartNumbers | null> {
  const [ids, pay] = await Promise.all([
    api.GET("/api/v1/patients/{id}/identifiers", { params: { path: { id: patientId } }, signal }),
    api.GET("/api/v1/patients/{id}/payers", { params: { path: { id: patientId } }, signal }),
  ]);
  if (!readSucceeded(ids) || !readSucceeded(pay)) return null;
  const identifiers =
    (
      ids.data as
        | { identifiers?: { kind: string; value: string | null; effectiveTo?: string | null }[] }
        | undefined
    )?.identifiers ?? [];
  const payers = (pay.data as { payers?: ChartPayer[] } | undefined)?.payers ?? [];
  return {
    // The clinician's own calendar day, not the UTC day a US evening has already rolled into (the "as of" for coverage in force).
    medicareOnChart: chartMedicareNumber(identifiers, payers, localToday()),
    medicaidOnChart: chartMedicaidNumber(payers),
    payers,
  };
}

/** What a chart read changes in `PatientExtra`: the numbers when it succeeded, otherwise nothing (unknown stays unknown). */
function chartNumbersPatch(
  chartNumbers: ChartNumbers | null,
  prev: PatientExtra,
): Partial<PatientExtra> {
  if (chartNumbers === null) return chartUnavailableUnlessKnown(prev);
  return {
    ...chartNumbers,
    mbiTail: chartNumbers.medicareOnChart?.value.slice(-4) ?? null,
    chartStatus: "known",
  };
}

/** A failed chart read never un-knows numbers an earlier read gave; it only ends "loading" as "unavailable". */
function chartUnavailableUnlessKnown(prev: PatientExtra): Partial<PatientExtra> {
  return prev.chartStatus === "known" ? {} : { chartStatus: "unavailable" };
}

/**
 * The patient's Medicare number as the chart holds it — the same rule HOPE's admission prefill uses
 * for A0600B: the active MBI identifier, else the subscriber ID of the best-ranked current Medicare
 * coverage (entered on the intake Coverage / Payers form).
 */
function chartMedicareNumber(
  identifiers: { kind: string; value: string | null; effectiveTo?: string | null }[],
  payers: ChartPayer[],
  today: string,
): ChartNumber | null {
  const mbi = identifiers.find(
    (i) => i.kind === "mbi" && i.value && (!i.effectiveTo || i.effectiveTo >= today),
  );
  if (mbi?.value) return { value: mbi.value, source: "identifier", coverage: null };
  const coverage = payers
    .filter(
      (p) =>
        p.current &&
        (p.coverageKind === "medicare_ffs" || p.coverageKind === "medicare_advantage") &&
        p.subscriberId?.trim(),
    )
    .sort((a, b) => a.rank - b.rank)[0];
  const value = coverage?.subscriberId?.trim();
  return coverage && value ? { value, source: "coverage", coverage } : null;
}

/** Medicaid IDs live only on coverage (M5 §2 "Payers"): the best-ranked current Medicaid coverage. */
function chartMedicaidNumber(payers: ChartPayer[]): ChartNumber | null {
  const coverage = payers
    .filter((p) => p.current && p.coverageKind === "medicaid" && p.subscriberId?.trim())
    .sort((a, b) => a.rank - b.rank)[0];
  const value = coverage?.subscriberId?.trim();
  return coverage && value ? { value, source: "coverage", coverage } : null;
}

/** Medicare / Medicaid numbers compare case- and separator-insensitively ("1EG4-TE5-MK73" = "1eg4te5mk73"). */
function sameMedicareNumber(a: string, b: string): boolean {
  const norm = (v: string) => v.replace(/[\s-]/g, "").toUpperCase();
  return norm(a) === norm(b);
}

interface TimepointRow {
  id: string;
  rfaKind: string;
  status: string;
  targetDate: string;
  correctsAssessmentId?: string | null;
}

const SECTION_ORDER: { id: SectionId; label: string; helper: string }[] = [
  {
    id: "A",
    label: "Administrative",
    helper: "Confirm chart-prefilled identity, admission, payer, language, and residence details.",
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
    helper: "Check completion, blockers, warnings, SFV state, and signature readiness.",
  },
];

const VISITED_KEY = "wx.hope.visitedGroups";

function readVisited(assessmentId: string | undefined): Set<string> {
  if (!assessmentId) return new Set();
  try {
    const parsed: unknown = JSON.parse(
      readStorage(`${VISITED_KEY}.${assessmentId}`, "session") ?? "[]",
    );
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

const PROTECTED_ITEMS = new Set([
  "A0100A", // Facility NPI — from selected Hospice Provider
  "A0100B", // Facility CCN — from selected Hospice Provider
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
      ["A0205", "A0210", "A0215", "A0220", "A0250", "A0270"].some((p) => i.itemCode.startsWith(p)),
  },
  {
    label: "Patient Identity",
    match: (i) =>
      ["A0500", "A0600", "A0700", "A0800", "A0900"].some((p) => i.itemCode.startsWith(p)),
  },
  {
    label: "Demographics",
    match: (i) => ["A1005", "A1010", "A1110", "A1250"].some((p) => i.itemCode.startsWith(p)),
  },
  { label: "Payer / Coverage", match: (i) => i.itemCode.startsWith("A1400") },
  {
    label: "Living Situation",
    match: (i) => ["A1805", "A1905", "A1910"].some((p) => i.itemCode.startsWith(p)),
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

const payerSource: CSSProperties = {
  display: "block",
  marginTop: 2,
  color: t.muted,
  fontSize: "0.75rem",
};

const SIGN_UNCONFIRMED =
  "Could not confirm that the assessment was signed. Reload the record before trying again.";
const SIGN_DEGRADED =
  "The record could not be signed because a service it needs is temporarily unavailable. Try again in a moment.";
const SIGN_REFRESH_FAILED =
  "The record was signed, but this page could not refresh. Reload to see it.";
/** hope.scope answers a record outside the caller's caseload with 404 (deny-as-not-found), a plain refusal with 403: Try again changes neither. */
const RECORD_NOT_AVAILABLE = "This HOPE assessment was not found, or is not available to you.";
const WORKSPACE_UNAVAILABLE = "The CMS item workspace could not be loaded for this assessment.";
/** The answer save got no usable reply (offline, a reset, a timeout, an empty 5xx): it may or may not have been applied. */
const ANSWER_UNCONFIRMED =
  "Could not confirm that this answer was saved. Reload to check it before entering it again.";
/** Thrown to the reconcile dialog when its HOPE answer save got no usable answer (it may or may not have landed): the dialog words it. */
const HOPE_ANSWER_UNCONFIRMED = "The HOPE answer save could not be confirmed.";
/** An answer save that was never sent: the record is not an editable draft, the item is controlled by the workflow, or there is no such item. */
const ANSWER_NOT_SENT = "This answer cannot be changed here, so nothing was sent.";

/** What one answer save came to: saved, or why not and whether it may still have been applied (no usable answer). */
type AnswerSaveOutcome =
  | { readonly saved: true }
  | { readonly saved: false; readonly outcomeUnknown: boolean; readonly message: string };
const NOT_SENT: AnswerSaveOutcome = {
  saved: false,
  outcomeUnknown: false,
  message: ANSWER_NOT_SENT,
};

/** The screen is rebuilt for each record, so nothing one record left behind (a notice, a focus request) reaches the next. */
export function HopeAssessmentDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  return <HopeAssessmentWorkspace key={id} />;
}

function HopeAssessmentWorkspace(): JSX.Element {
  const client = useApiClient();
  const api = useMemo(() => client as unknown as HopeApiCompat, [client]);
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [assessment, setAssessment] = useState<AssessmentDetail | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [review, setReview] = useState<ReviewModel | null>(null);
  const [timeline, setTimeline] = useState<TimepointRow[]>([]);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [patientExtra, setPatientExtra] = useState<PatientExtra>({
    sex: null,
    mbiTail: null,
    medicareOnChart: null,
    medicaidOnChart: null,
    payers: [],
    address: null,
    chartStatus: "loading",
  });
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>("A");
  // Set when the record was signed but the page could not re-read itself afterwards.
  const [signRefreshNotice, setSignRefreshNotice] = useState<string | null>(null);
  const [sfvReviewOpen, setSfvReviewOpen] = useState(false);
  const [saving, setSaving] = useState<SaveStatus>("idle");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // False when the load failed for a refusal: it is final, so no Try again is offered for it.
  const [retryable, setRetryable] = useState(true);
  // The record read but its workspace did not: a failure too, so a retry keeps focus like the load error's does.
  const workspaceFailed = !error && assessment !== null && workspace === null;
  const retry = useRetryFocus(loading, error ?? (workspaceFailed ? WORKSPACE_UNAVAILABLE : null));
  const [signOpen, setSignOpen] = useState(false);
  const [inactivationOpen, setInactivationOpen] = useState(false);
  const latestVersionRef = useRef<number | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [pendingItemFocus, setPendingItemFocus] = useState<string | null>(null);
  // Navigation: "guided" = one question group at a time (default); "all" = every section on one page.
  const [navMode, setNavModeState] = useState<NavMode>(readNavMode);
  const setNavMode = useCallback((mode: NavMode) => {
    setNavModeState(mode);
    writeStorage(NAV_MODE_KEY, mode);
  }, []);
  // Guided mode: the open group per section ("A" → "patient-identity").
  const [groupBySection, setGroupBySection] = useState<Record<string, string>>({});
  // Groups the user has moved past: only these may show "required" errors in red.
  const [visited, setVisited] = useState<Set<string>>(() => readVisited(id));
  const markVisited = useCallback(
    (keys: string[]) => {
      setVisited((prev) => {
        if (keys.every((key) => prev.has(key))) return prev;
        const next = new Set([...prev, ...keys]);
        writeStorage(`${VISITED_KEY}.${id}`, JSON.stringify([...next]), "session");
        return next;
      });
    },
    [id],
  );
  const workspaceRef = useRef<HTMLDivElement>(null);
  // Show-all mode: the group currently at the top of the viewport (scroll-spy).
  const [spy, setSpy] = useState<{ section: string; group: string } | null>(null);
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);

  useEffect(() => {
    if (workspace) latestVersionRef.current = workspace.assessment.version;
  }, [workspace]);
  useWorkspaceScrolling({
    workspace,
    workspaceRef,
    activeSection,
    groupBySection,
    navMode,
    pendingItemFocus,
    setPendingItemFocus,
    pendingScroll,
    setPendingScroll,
    setSpy,
  });

  // Guided: an issue link to an item opens the group that holds it.
  useEffect(() => {
    if (!pendingItemFocus || !workspace || navMode !== "guided" || activeSection === "Review")
      return;
    const section = workspace.sections.find((sec) => sec.code === activeSection);
    if (!section) return;
    const group = sectionGroups(activeSection, section).find((g) =>
      g.items.some(
        (item) => item.itemCode === pendingItemFocus || item.itemCode.startsWith(pendingItemFocus),
      ),
    );
    if (group) setGroupBySection((prev) => ({ ...prev, [activeSection]: group.key }));
  }, [activeSection, navMode, pendingItemFocus, workspace]);

  const [signing, setSigning] = useState(false);
  // A refused sign is shown in the dialog, never swallowed.
  const [signError, setSignError] = useState<string | null>(null);
  // The attestation wording this page shows is out of date (the server refused a signature or an SFV for it): nothing
  // can be signed from this page until it is reloaded, however many times a dialog is closed and reopened.
  const [wordingChanged, setWordingChanged] = useState(false);
  const redirectToStepUp = useStepUpRedirect();

  /**
   * Reads the record and what the screen shows around it; may throw. False when the record itself could not be read.
   * "denied" when the record read was refused (403, or 404 as hope.scope's deny-as-not-found): retrying cannot change it.
   * `onRecordShown` is told whether the workspace and the review were readable too (the best-effort banner reads after them
   * do not count). One that was not is not an empty one: it never replaces what is already on screen, so a re-read after a
   * signature that answers with a gateway error leaves the record up instead of turning it into "Workspace unavailable".
   */
  const readRecord = useCallback(
    async (onRecordShown: (complete: boolean) => void): Promise<boolean | "denied"> => {
      if (!id) return true;
      // Each phase is bounded (`withRequestTimeout`): a read nobody answers rejects, which `load` reports (with Try again) and
      // `refreshWorkspaceOnly` turns into false, instead of a spinner, or a save queue behind a re-read, that never moves.
      const [a, w, r] = await withRequestTimeout((signal) =>
        Promise.all([
          api.GET("/api/v1/hope/assessments/{id}", { params: { path: { id } }, signal }),
          api.GET("/api/v1/hope/assessments/{id}/workspace", { params: { path: { id } }, signal }),
          api.GET("/api/v1/hope/assessments/{id}/review", { params: { path: { id } }, signal }),
        ]),
      );
      if (a.error || !a.data) {
        const { status } = await settleRead(Promise.resolve(a), "denied");
        return status === "denied" ? "denied" : false;
      }
      const nextAssessment = a.data as unknown as AssessmentDetail;
      setAssessment(nextAssessment);
      const workspaceRead = readSucceeded(w);
      const reviewRead = readSucceeded(r);
      if (workspaceRead) setWorkspace(w.data as unknown as Workspace);
      if (reviewRead) setReview(r.data as unknown as ReviewModel);
      const [tl, pat] = await withRequestTimeout((signal) =>
        Promise.all([
          api.GET("/api/v1/patients/{patientId}/hope/assessments", {
            params: { path: { patientId: nextAssessment.patientId } },
            signal,
          }),
          api.GET("/api/v1/patients/{id}", {
            params: { path: { id: nextAssessment.patientId } },
            signal,
          }),
        ]),
      );
      // An unreadable answer is not an empty timeline: it must not empty the rows already on screen (they decide between
      // "Create correction" and "Open correction draft").
      if (readSucceeded(tl))
        setTimeline((tl.data as { assessments?: TimepointRow[] }).assessments ?? []);
      if (pat.data) setPatient(pat.data as unknown as PatientSummary);
      onRecordShown(workspaceRead && reviewRead);
      // Banner + Patient Summary context — best-effort; a failure only blanks those fields.
      const pid = nextAssessment.patientId;
      try {
        const [demo, addrs, chartNumbers] = await withRequestTimeout((signal) =>
          Promise.all([
            api.GET("/api/v1/patients/{id}/demographics", {
              params: { path: { id: pid } },
              signal,
            }),
            api.GET("/api/v1/patients/{id}/addresses", { params: { path: { id: pid } }, signal }),
            fetchChartNumbers(api, pid, signal),
          ]),
        );
        const addresses =
          (
            addrs.data as
              | {
                  addresses?: {
                    line1: string;
                    city: string;
                    state: string | null;
                    postalCode: string;
                    current: boolean;
                    isPrimary: boolean;
                  }[];
                }
              | undefined
          )?.addresses ?? [];
        const home =
          addresses.find((a) => a.current && a.isPrimary) ?? addresses.find((a) => a.current);
        setPatientExtra((prev) => ({
          ...prev,
          sex:
            (demo.data as { sexAssignedAtBirth?: string } | undefined)?.sexAssignedAtBirth ?? null,
          address: home
            ? `${home.line1}, ${home.city}${home.state ? `, ${home.state}` : ""} ${home.postalCode}`
            : null,
          ...chartNumbersPatch(chartNumbers, prev),
        }));
      } catch {
        // Nothing here is the record: a rejected or unanswered banner read leaves the chart numbers unknown, not absent.
        setPatientExtra((prev) => ({ ...prev, ...chartUnavailableUnlessKnown(prev) }));
      }
      return true;
    },
    [api, id],
  );

  /**
   * Loads the record. Never rejects: a failure to read the record itself is the screen's error state (with Try again),
   * unless `quiet` (a re-read of a record already on screen), which leaves the screen as it is and only reports whether
   * the record, its workspace and its review were all read. A best-effort read that fails after the record was shown is
   * not fatal.
   */
  const load = useCallback(
    async (quiet = false): Promise<boolean> => {
      if (!id) return true;
      if (!quiet) {
        setLoading(true);
        setError(null);
        setRetryable(true);
      }
      let shown = false;
      let complete = false;
      let denied = false;
      try {
        denied =
          (await readRecord((allRead) => {
            shown = true;
            complete = allRead;
            if (!quiet) setLoading(false);
          })) === "denied";
      } catch {
        // Handled below: what matters is whether the record was shown.
      }
      if (!quiet) {
        if (!shown) {
          setRetryable(!denied);
          setError(denied ? RECORD_NOT_AVAILABLE : "Could not load this HOPE assessment.");
        }
        setLoading(false);
      }
      if (shown && complete) {
        // The page is the latest version now (the clinician pressed "Reload assessment", or the record was signed): nothing
        // is left to reload, so neither the banner nor an item's "reload" message may keep saying so.
        setSaving((state) => (state === "conflict" || state === "reloaded" ? "idle" : state));
        setFieldErrors(withoutConflictErrors);
      }
      return quiet ? shown && complete : shown;
    },
    [id, readRecord],
  );

  // After a reconcile writes to the chart: re-read just the chart numbers (no page reload).
  const refreshChartNumbers = useCallback(async () => {
    if (!assessment) return;
    // Bounded: the reconcile dialog waits on this. A rejection, a timeout, and a read that did not succeed are what it reports as
    // a stale re-read; none of them replaces the chart numbers already on screen with an empty chart.
    const chartNumbers = await withRequestTimeout((signal) =>
      fetchChartNumbers(api, assessment.patientId, signal),
    );
    if (chartNumbers === null) throw new Error("The chart numbers could not be re-read.");
    setPatientExtra((prev) => ({ ...prev, ...chartNumbersPatch(chartNumbers, prev) }));
  }, [api, assessment]);
  const [reconcile, setReconcile] = useState<{ itemCode: ReconcileItem; value: string } | null>(
    null,
  );

  const goToIssue = useCallback((section: SectionId, itemCode?: string | null) => {
    setActiveSection(section);

    if (itemCode) {
      setPendingItemFocus(itemCode);
    }
  }, []);

  /** Re-reads the workspace, review and assessment; false when any of them could not be read. Never rejects. */
  const refreshWorkspaceOnly = useCallback(async (): Promise<boolean> => {
    if (!id) return true;
    try {
      const [w, r, a] = await withRequestTimeout((signal) =>
        Promise.all([
          api.GET("/api/v1/hope/assessments/{id}/workspace", { params: { path: { id } }, signal }),
          api.GET("/api/v1/hope/assessments/{id}/review", { params: { path: { id } }, signal }),
          api.GET("/api/v1/hope/assessments/{id}", { params: { path: { id } }, signal }),
        ]),
      );
      if (w.data) setWorkspace(w.data as unknown as Workspace);
      if (r.data) setReview(r.data as unknown as ReviewModel);
      if (a.data) setAssessment(a.data as unknown as AssessmentDetail);
      const complete = Boolean(w.data && r.data && a.data);
      if (complete) {
        // The page re-read itself after a refused save, so "reload the latest version" is no longer an instruction: say what
        // happened instead (the refused change was not applied) rather than dropping the notice and hiding that.
        setSaving((state) => (state === "conflict" ? "reloaded" : state));
        setFieldErrors(withoutConflictErrors);
      }
      return complete;
    } catch {
      return false;
    }
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  // The follow-up card is in section J; in guided mode only the current group renders. Whatever opens or reports a
  // visit first brings J and the card's group on screen (not goToIssue: its item-focus timer would pull focus out of
  // the dialog).
  const revealSfvCard = useCallback(() => {
    const section = workspace?.sections.find((candidate) => candidate.code === "J");
    const group = section ? sectionGroups("J", section).find((g) => g.kind === "sfv") : undefined;
    setActiveSection("J");
    if (group) setGroupBySection((previous) => ({ ...previous, J: group.key }));
  }, [workspace]);
  const sfv = useSfvFlow({
    routeId: id,
    assessment,
    workspace,
    refresh: refreshWorkspaceOnly,
    revealCard: revealSfvCard,
  });

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
      map.set(finding.itemCode, [...(map.get(finding.itemCode) ?? []), finding]);
    }
    return map;
  }, [review]);

  const saveAnswerOutcome = useCallback(
    async (
      item: WorkspaceItem | readonly WorkspaceItem[],
      value: AnswerValue | null | ReadonlyMap<string, AnswerValue>,
    ): Promise<AnswerSaveOutcome> => {
      const items = Array.isArray(item) ? item : [item];
      const primary = items[0];
      if (
        !id ||
        !workspace ||
        assessment?.status !== "draft" ||
        !primary ||
        items.some((candidate) => PROTECTED_ITEMS.has(candidate.itemCode))
      )
        return NOT_SENT;
      // Show A1400 conflicts at selection time; the server remains authoritative.
      if (items.some((candidate) => candidate.itemCode.startsWith("A1400"))) {
        setWorkspace((previous) =>
          previous
            ? {
                ...previous,
                sections: previous.sections.map((section) => ({
                  ...section,
                  items: section.items.map((candidate) =>
                    items.some((changed) => changed.itemCode === candidate.itemCode)
                      ? {
                          ...candidate,
                          value:
                            value instanceof Map
                              ? (value.get(candidate.itemCode) ?? candidate.value)
                              : value,
                        }
                      : candidate,
                  ),
                })),
              }
            : previous,
        );
      }
      const run = async (): Promise<AnswerSaveOutcome> => {
        setSaving("saving");
        setFieldErrors((prev) => {
          return Object.fromEntries(
            Object.entries(prev).filter(
              ([key]) => !items.some((candidate) => candidate.itemCode === key),
            ),
          );
        });
        const changes = items.map((candidate) => {
          const nextValue = value instanceof Map ? value.get(candidate.itemCode) : value;
          return nextValue === null || nextValue === ""
            ? { itemCode: candidate.itemCode, action: "clear" as const }
            : {
                itemCode: candidate.itemCode,
                action: "set" as const,
                value: nextValue,
              };
        });
        // A rejected request is a failed save like any other: shown as "Save failed", never an unhandled rejection. Bounded, so
        // a save nobody answers ends the same way instead of holding "Saving..." (and every save queued behind it) for good.
        const res = await withRequestTimeout((signal) =>
          api.PATCH("/api/v1/hope/assessments/{id}/answers", {
            params: { path: { id } },
            body: {
              ifVersion: latestVersionRef.current ?? workspace.assessment.version,
              changes,
            },
            signal,
          }),
        ).catch((): Awaited<HopeApiResult> => ({}));
        if (!writeSucceeded(res)) {
          // A stale version is decided by the contract (a 409 that is not M10_RECORD_BUSY), never by the wording of the
          // server's message: the real M10_SPEC_NOT_IN_FORCE text contains "version" and is not a conflict. A busy record
          // is a 409 too, but the step was NOT applied and the page is not stale: sending the request again is right, a
          // reload is not.
          const conflict = isStaleVersionRefusal(res);
          const outcomeUnknown = writeOutcomeUnknown(res);
          setSaving(conflict ? "conflict" : outcomeUnknown ? "unconfirmed" : "failed");
          // No usable answer (a rejection, a timeout, an empty 5xx) is "could not confirm", never "not saved": the
          // write may have committed. A refusal is worded by the server's own message.
          const message = conflict
            ? CONFLICT_FIELD_ERROR
            : failedWriteMessage(
                res,
                ANSWER_UNCONFIRMED,
                "This answer was not saved. Check the value and try again.",
              );
          setFieldErrors((prev) => ({ ...prev, [primary.itemCode]: message }));
          if (items.some((candidate) => candidate.itemCode.startsWith("A1400")))
            await refreshWorkspaceOnly();
          return { saved: false, outcomeUnknown, message };
        }
        latestVersionRef.current =
          (res.data as { version?: number }).version ?? latestVersionRef.current;
        setSaving("saved");
        setLastSavedAt(Date.now());
        await refreshWorkspaceOnly();
        return { saved: true };
      };
      const next = saveQueueRef.current.then(run, run);
      saveQueueRef.current = next.then(
        () => undefined,
        () => undefined,
      );
      return await next;
    },
    [api, assessment?.status, id, refreshWorkspaceOnly, workspace],
  );
  const saveAnswer = useCallback(
    async (...args: Parameters<typeof saveAnswerOutcome>): Promise<boolean> =>
      (await saveAnswerOutcome(...args)).saved,
    [saveAnswerOutcome],
  );

  const sign = useCallback(async () => {
    if (!id || !workspace) return;
    setSigning(true);
    setSignError(null);
    let res: Awaited<HopeApiResult>;
    // `attestationConfirmed` is only ever sent from the dialog, whose Sign button needs the box ticked; the version
    // names the wording the signer was shown, so the server can refuse a signature on wording that has since changed.
    const body: SignAssessmentBody = {
      ifVersion: workspace.assessment.version,
      attestationConfirmed: true,
      attestationVersion: HOPE_ATTESTATION_VERSION,
    };
    try {
      // Bounded: the dialog is shut while this is out, and a request nobody answers must end as "could not confirm".
      res = await withRequestTimeout((signal) =>
        api.POST("/api/v1/hope/assessments/{id}/sign", { params: { path: { id } }, body, signal }),
      );
    } catch {
      setSigning(false);
      // No answer at all: the signature may have committed, so the signer is told to reload, not to simply retry.
      setSignError(SIGN_UNCONFIRMED);
      return;
    }
    setSigning(false);
    if (!writeSucceeded(res)) {
      // Not a success and no refusal body to read (an empty or gateway reply): whether it landed is unknown.
      if (!isRefusalBody(res.error)) {
        setSignError(
          isClientRefusal(res.response?.status) ? REFUSED_WITHOUT_REASON : SIGN_UNCONFIRMED,
        );
        return;
      }
      // A stale session is recoverable: re-verify, then come back to this record and sign again.
      if (redirectToStepUp(res.error)) return;
      if (errorCodeOf(res.error) === ATTESTATION_STALE_CODE) {
        // A definite refusal, nothing written. This page cannot send the new version, so it must be reloaded.
        setWordingChanged(true);
        return;
      }
      setSignError(
        serverFaultMessage(res.error, res.response?.status, SIGN_DEGRADED) ??
          refusalWordsOf(res.error) ??
          "The record could not be signed. Review it and try again.",
      );
      // The version or readiness the dialog acted on may be stale (409, new blocker): re-read before a retry.
      await refreshWorkspaceOnly();
      return;
    }
    setSignOpen(false);
    // Signed. A failed re-read must not hide that behind a spinner or an error page: say it, and keep what is shown.
    const reloaded = await load(true);
    setSignRefreshNotice(reloaded ? null : SIGN_REFRESH_FAILED);
    setActiveSection("Review");
  }, [api, id, load, redirectToStepUp, refreshWorkspaceOnly, workspace]);

  const {
    summaryState,
    summaryNotice,
    summaryNoticeRef,
    requestSummary,
    amendmentDisciplines,
    correctionOpen,
    correcting,
    correctionError,
    openCorrectionId,
    beginCorrection,
    closeCorrection,
    createCorrection,
    inactivating,
    inactivationError,
    clearInactivationError,
    createInactivation,
    completionDateSaving,
    completionDateError,
    setHuvCompletionDate,
  } = useHopeRecordActions({
    api,
    client,
    id,
    assessment,
    workspaceVersion: workspace?.assessment.version,
    timeline,
    setTimeline,
    refresh: refreshWorkspaceOnly,
    setSaving,
    closeInactivation: () => setInactivationOpen(false),
    navigate,
  });

  if (error)
    return (
      <div ref={retry.errorRef} tabIndex={-1} style={{ padding: "1.5rem" }}>
        <InlineAlert tone="error">
          {error}{" "}
          {retryable ? (
            <Button
              size="sm"
              tone="secondary"
              onClick={() => {
                retry.retried();
                void load();
              }}
            >
              Try again
            </Button>
          ) : null}
        </InlineAlert>
      </div>
    );
  if (loading || !assessment)
    return <LoadingRegion label="Loading HOPE workspace..." regionRef={retry.loadingRef} />;
  const workspaceRfa =
    assessment.rfaKind === "01_admission" ||
    assessment.rfaKind === "02_huv1" ||
    assessment.rfaKind === "03_huv2" ||
    assessment.rfaKind === "05_discharge";
  if (!workspaceRfa) {
    return <LegacyTimepointView assessment={assessment} patient={patient} timeline={timeline} />;
  }
  if (!workspace)
    return (
      <div ref={retry.errorRef} tabIndex={-1}>
        <ErrorState
          title="Workspace unavailable"
          description={WORKSPACE_UNAVAILABLE}
          retryLabel="Try again"
          onRetry={() => {
            retry.retried();
            void load();
          }}
        />
      </div>
    );

  const completed = assessment.status === "signed";
  const sections = sectionsFromWorkspace(workspace);
  const visibleSections = visibleSectionOrder(workspace);
  const status = derivedStatus(assessment, review, workspace);
  const recordLabel = rfaLabel(assessment.rfaKind);
  const canInactivate =
    completed && !assessment.supersededByAssessmentId && workspace.assessment.isc !== "XX";
  const age = patient ? ageYears(patient.dob) : null;
  const sex = sexLabel(patientExtra.sex);
  const medicare = patientExtra.mbiTail;
  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={
        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "0.5rem" }}>
          {[
            `DOB ${formatDate(patient.dob)}${age != null ? ` (${age}y)` : ""}`,
            sex,
            `MRN: ...${patient.mrn.slice(-4)}`,
            medicare ? `Medicare: ...${medicare}` : null,
          ]
            .filter(Boolean)
            .map((m, i) => (
              <span key={m as string} style={{ display: "inline-flex", gap: "0.5rem" }}>
                {i > 0 ? <span aria-hidden>•</span> : null}
                {m}
              </span>
            ))}
        </span>
      }
      chips={
        <StatusPill
          label={stateLabel(patient.status)}
          tone={ASSESSMENT_TONE[patient.status] ?? "neutral"}
        />
      }
      actions={
        <span className="wx-target-date">
          <span style={{ color: t.onSurfaceVariant }}>Target date</span>
          <span className="wx-target-date-box">
            <Glyph name="calendar" size={16} strokeWidth={1.75} />
            {formatTargetDate(assessment.targetDate)}
          </span>
        </span>
      }
    />
  ) : (
    <PatientBanner name={recordLabel} meta={`Target ${formatTargetDate(assessment.targetDate)}`} />
  );

  const activeIndex = visibleSections.findIndex((s) => s.id === activeSection);
  const config = visibleSections[activeIndex] ?? visibleSections[0]!;
  const showAll = navMode === "all" && activeSection !== "Review";
  const clinicalSections = visibleSections.filter(
    (s): s is { id: Exclude<SectionId, "Review">; label: string; helper: string } =>
      s.id !== "Review",
  );
  // Every section's groups — the shared unit of guided steps, the show-all index and the to-do list.
  const groupsBySection = new Map(
    clinicalSections.map((s) => {
      const sec = sections.get(s.id);
      return [s.id, sec ? sectionGroups(s.id, sec) : []] as const;
    }),
  );
  // One count everywhere: the rail, the sub-steps and the To-do list all use openRequiredItems.
  const openBySection = new Map(
    clinicalSections.map((s) => [
      s.id as string,
      (groupsBySection.get(s.id) ?? []).reduce((n, g) => n + openRequiredItems(g.items).length, 0),
    ]),
  );
  const navViews: NavSectionView[] = visibleSections.map((section) => {
    const view = navView(section, review, workspace, completed);
    const open = openBySection.get(section.id);
    if (open === undefined || completed) return view;
    if (open === 0)
      return view.state === "attention"
        ? { ...view, statusLine: "Answered — see corrections" }
        : { ...view, state: "complete", statusLine: "Complete" };
    return { ...view, state: "attention", statusLine: `${open} to answer` };
  });
  const currentGroups =
    activeSection === "Review" ? [] : (groupsBySection.get(activeSection) ?? []);
  const currentGroup =
    currentGroups.find((g) => g.key === groupBySection[activeSection]) ?? currentGroups[0] ?? null;
  const visitKey = (section: string, key: string) => `${section}:${key}`;
  // Guided order: every group of every clinical section, then Review.
  const steps: { section: SectionId; group: GroupView | null }[] = [
    ...clinicalSections.flatMap((s) =>
      (groupsBySection.get(s.id) ?? []).map((group) => ({ section: s.id as SectionId, group })),
    ),
    ...(visibleSections.some((s) => s.id === "Review")
      ? [{ section: "Review" as SectionId, group: null }]
      : []),
  ];
  const stepIndex = steps.findIndex(
    (step) =>
      step.section === activeSection &&
      (step.group === null || step.group.key === currentGroup?.key),
  );
  const prevStep = stepIndex > 0 ? steps[stepIndex - 1] : undefined;
  const nextStep = stepIndex >= 0 ? steps[stepIndex + 1] : undefined;
  const stepLabel = (step: (typeof steps)[number]): string =>
    step.section === "Review"
      ? completed
        ? "Completed record"
        : "Review & sign"
      : step.section !== activeSection
        ? `${step.section}. ${visibleSections.find((v) => v.id === step.section)?.label ?? ""}`
        : (step.group?.label ?? "");

  const leaveCurrent = () => {
    if (activeSection !== "Review" && currentGroup)
      markVisited([visitKey(activeSection, currentGroup.key)]);
  };
  const goToStep = (section: SectionId, groupKey?: string) => {
    leaveCurrent();
    setActiveSection(section);
    if (section !== "Review" && groupKey)
      setGroupBySection((prev) => ({ ...prev, [section]: groupKey }));
  };
  const selectSection = (section: SectionId) => {
    if (section !== "Review" && navMode === "all") {
      setActiveSection(section);
      setPendingScroll(`hope-section-${section}`);
      return;
    }
    goToStep(section, section === "Review" ? undefined : groupsBySection.get(section)?.[0]?.key);
  };
  const selectGroup = (section: Exclude<SectionId, "Review">, key: string) => {
    if (navMode === "all") {
      setActiveSection(section);
      setPendingScroll(`hope-group-${section}-${key}`);
      return;
    }
    goToStep(section, key);
  };
  const switchMode = (mode: NavMode) => {
    leaveCurrent();
    setNavMode(mode);
    if (mode === "all" && activeSection !== "Review" && currentGroup)
      setPendingScroll(`hope-group-${activeSection}-${currentGroup.key}`);
    if (mode === "guided" && spy && spy.section !== "Review") {
      setActiveSection(spy.section as SectionId);
      setGroupBySection((prev) => ({ ...prev, [spy.section]: spy.group }));
    }
  };

  const groupFindings = (section: string, group: GroupView): Findings =>
    visited.has(visitKey(section, group.key))
      ? findingsByItem
      : withoutMissingRequired(findingsByItem, group.items);
  const subNavFor = (sectionId: string) => {
    if (sectionId === "Review") return null;
    const sid = sectionId as Exclude<SectionId, "Review">;
    const expanded = navMode === "all" ? true : sid === activeSection;
    if (!expanded) return null;
    const groups = groupsBySection.get(sid) ?? [];
    if (groups.length < 2) return null;
    const active =
      navMode === "all"
        ? spy?.section === sid
          ? spy.group
          : null
        : activeSection === sid
          ? (currentGroup?.key ?? null)
          : null;
    return (
      <GroupSubNav
        label={`${sid} groups`}
        active={active}
        onSelect={(key) => selectGroup(sid, key)}
        groups={groups.map((g) => {
          const nav = groupNavState(g, visited.has(visitKey(sid, g.key)));
          return {
            key: g.key,
            label: g.label,
            state: nav.state,
            statusLine: nav.open ? `${nav.open} to answer` : "Done",
          };
        })}
      />
    );
  };
  const todo = clinicalSections
    .map((s) => ({
      section: s.id,
      label: `${s.id}. ${s.label}`,
      open: (groupsBySection.get(s.id) ?? []).flatMap((g) =>
        openRequiredItems(g.items).map((item) => ({ item, group: g.key })),
      ),
    }))
    .filter((row) => row.open.length > 0);
  const goToTodo = (section: Exclude<SectionId, "Review">, group: string, itemCode: string) => {
    leaveCurrent();
    setActiveSection(section);
    if (navMode === "guided") setGroupBySection((prev) => ({ ...prev, [section]: group }));
    setPendingItemFocus(itemCode);
  };
  const progressDone = workspace.progress.answered + workspace.progress.skipped;
  const sectionCounts = (sid: string) => {
    const sec = review?.sections.find((r) => r.code === sid);
    if (sec) return { done: sec.answered + sec.skipped, total: sec.active };
    const raw = sections.get(sid as Exclude<SectionId, "Review">)?.items ?? [];
    return {
      done: raw.filter((i) => i.state !== "unanswered").length,
      total: raw.length,
    };
  };
  // A0600B / A0700 vs the chart: a number typed here that the chart lacks (or contradicts) is flagged so
  // it reaches the patient record — iQIES expects the submitted MBI to match the patient's (spec §5).
  const itemNotes: Record<string, ReactNode> = {};
  const chartNote = (itemCode: ReconcileItem, chart: ChartNumber | null) => {
    const item = sections.get("A")?.items.find((i) => i.itemCode === itemCode);
    // Any staff-entered value — typed here or copied into a correction — not the chart prefill itself.
    const typed =
      item &&
      (item.source === "user" || item.source === "correction_copy") &&
      typeof item.value === "string"
        ? item.value.trim()
        : "";
    // CMS special values ("^" blank, "+" pending, "N" not a recipient) are not numbers to compare.
    if (!typed || ["^", "-", "+", "N"].includes(typed)) return;
    // A chart that could not be read is unknown, not empty: never say "not on the chart", and offer no Reconcile (its
    // "add it to the chart" would file a coverage row the dialog cannot see the existing ones of).
    if (patientExtra.chartStatus === "loading") return;
    if (patientExtra.chartStatus === "unavailable") {
      itemNotes[itemCode] = (
        <span className="wx-chart-note">
          Could not check this against the patient's chart. Reload the page to try again.
        </span>
      );
      return;
    }
    if (chart && sameMedicareNumber(chart.value, typed)) return;
    itemNotes[itemCode] = (
      <span className={chart ? "wx-chart-note wx-chart-note-warning" : "wx-chart-note"}>
        {chart
          ? `Differs from the chart (…${chart.value.slice(-4)}).`
          : "Not on the patient's chart."}{" "}
        <button
          type="button"
          className="wx-chart-note-action"
          onClick={() => setReconcile({ itemCode, value: typed })}
        >
          Reconcile…
        </button>
      </span>
    );
  };
  chartNote("A0600B", patientExtra.medicareOnChart);
  chartNote("A0700", patientExtra.medicaidOnChart);
  const admissionDateAnswer = sections.get("A")?.items.find((i) => i.itemCode === "A0220")?.value;
  const renderGroup = (sid: Exclude<SectionId, "Review">, group: GroupView) => (
    <GroupCard
      key={`${sid}:${group.key}`}
      sectionId={sid}
      group={group}
      readonly={completed}
      findingsByItem={groupFindings(sid, group)}
      fieldErrors={fieldErrors}
      onSave={saveAnswer}
      notes={itemNotes}
      sfvLocked={sfv.locked}
      sfvLookup={sfv.lookup}
      onRetrySfvLookup={sfv.retryLookup}
      sfvFocusKey={sfv.focusKey}
      sfvReturnFocusKey={sfv.returnFocusKey}
      onCompleteSfv={sfv.show}
      onReviewSfv={() => setSfvReviewOpen(true)}
    />
  );

  return (
    <PatientWorkspaceLayout
      banner={banner}
      rail={
        <HopeRail
          patient={patient}
          patientExtra={patientExtra}
          patientId={assessment.patientId}
          review={review}
          todo={todo}
          completed={completed}
          onGoToTodo={goToTodo}
          onGoTo={goToIssue}
        />
      }
    >
      <div className="wx-hope-workspace" ref={workspaceRef}>
        <aside className="wx-hope-admission-rail">
          <select
            className="wx-hope-admission-section-select"
            aria-label="HOPE section"
            value={activeSection}
            onChange={(event) => selectSection(event.target.value as SectionId)}
            style={mobileSectionSelect}
          >
            {visibleSections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.label}
              </option>
            ))}
          </select>
          <div className="wx-hope-admission-section-nav">
            <SectionNavigator
              sections={navViews}
              active={showAll && spy ? spy.section : activeSection}
              onSelect={(sid) => selectSection(sid as SectionId)}
              ariaLabel={`${recordLabel} sections`}
              renderSub={subNavFor}
            />
          </div>
        </aside>

        <main className="wx-hope-main">
          <header className="wx-hope-head">
            <div style={{ minWidth: 0 }}>
              <h1 className="wx-hope-eyebrow">
                {completed ? `Completed ${recordLabel}` : `${recordLabel} Workspace`}
              </h1>
              <h2 className="wx-hope-title">
                {activeSection === "Review"
                  ? completed
                    ? "Completed Record"
                    : "Review & Sign"
                  : showAll
                    ? "All sections"
                    : `${config.id}. ${config.label}`}
              </h2>
              {!showAll && activeSection !== "Review" && currentGroup ? (
                <p className="wx-hope-step-line">
                  <strong>{currentGroup.label}</strong>
                  <span>
                    Step {currentGroups.indexOf(currentGroup) + 1} of {currentGroups.length}
                  </span>
                </p>
              ) : null}
              <p className="wx-hope-helper">
                {activeSection === "Review"
                  ? `Use backend readiness to decide whether this ${recordLabel} can be completed.`
                  : showAll
                    ? "Every section on one page. Jump with the bar or the index; open items are listed on the right."
                    : config.helper}
              </p>
              <div className="wx-hope-meta">
                <span>CMS {workspace.assessment.specVersion}</span>
                <span>ISC {workspace.assessment.isc}</span>
                {assessment.correctsAssessmentId ? (
                  <span>
                    {workspace.assessment.isc === "XX" ? "Inactivation draft" : "Correction draft"}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="wx-hope-head-side">
              <div className="wx-hope-head-actions">
                <label className="wx-hope-mode-toggle">
                  {/* A native checkbox exposes its own checked state, so `aria-checked` would only repeat it; role="switch" stays
                      for the semantics (and the e2e selector). Biome's rule wants the attribute on every switch. */}
                  <input
                    type="checkbox"
                    // biome-ignore lint/a11y/useAriaPropsForRole: native checked state; aria-checked would duplicate it
                    role="switch"
                    checked={navMode === "all"}
                    onChange={(event) => switchMode(event.currentTarget.checked ? "all" : "guided")}
                  />
                  <span className="wx-hope-mode-track" aria-hidden />
                  Show all
                </label>
                <span className={`wx-status-dot-chip wx-status-${status.tone}`}>
                  <span className="wx-dot" aria-hidden />
                  {status.label}
                </span>
                <SaveState state={saving} lastSavedAt={lastSavedAt} />
                {completed ? (
                  <>
                    <Button
                      tone="secondary"
                      onClick={() => setInactivationOpen(true)}
                      disabled={!canInactivate}
                    >
                      Inactivate
                    </Button>
                    <Button
                      tone="secondary"
                      onClick={() => void requestSummary()}
                      disabled={summaryState === "requesting" || summaryState === "requested"}
                    >
                      {summaryState === "requested"
                        ? "Summary requested"
                        : summaryState === "failed"
                          ? "Retry summary request"
                          : "Request summary"}
                    </Button>
                    <Button onClick={() => void beginCorrection()}>
                      {openCorrectionId ? "Open correction draft" : "Create correction"}
                    </Button>
                  </>
                ) : review?.readiness.readyToSign ? (
                  <Button onClick={() => setSignOpen(true)}>Sign &amp; complete</Button>
                ) : null}
              </div>
              <div className="wx-hope-progress">
                <span>
                  {progressDone} of {workspace.progress.active} answered
                </span>
                <ProgressBar value={progressDone} max={workspace.progress.active} />
              </div>
            </div>
          </header>

          {showAll ? (
            <nav className="wx-hope-jumpbar" aria-label="Jump to section">
              {visibleSections.map((section) => {
                const counts = section.id === "Review" ? null : sectionCounts(section.id);
                const isActive = (spy?.section ?? activeSection) === section.id;
                return (
                  <button
                    key={section.id}
                    type="button"
                    className={isActive ? "active" : undefined}
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => selectSection(section.id)}
                  >
                    <strong>{section.id === "Review" ? "Review" : section.id}</strong>
                    {counts ? (
                      <span>
                        {counts.done}/{counts.total}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </nav>
          ) : null}

          {completed ? (
            <CompletedSummary assessment={assessment} review={review} api={api} />
          ) : null}
          {completed ? <IqiesSubmissionPanel assessmentId={assessment.id} /> : null}
          {workspace.huv ? <HuvTimingBanner workspace={workspace} review={review} /> : null}
          {saving === "conflict" || saving === "reloaded" ? (
            <ConflictBanner reloaded={saving === "reloaded"} onReload={() => void load()} />
          ) : null}
          {(sfv.notice ?? signRefreshNotice) ? (
            <p role="alert" className="wx-hope-action-error">
              {sfv.notice ?? signRefreshNotice}
            </p>
          ) : null}
          <SummaryRequestNotice notice={summaryNotice} noticeRef={summaryNoticeRef} />

          {activeSection === "Review" ? (
            <ReviewPanel
              assessment={assessment}
              review={review}
              workspace={workspace}
              onGoTo={goToIssue}
              visibleSections={visibleSections}
              onSetCompletionDate={(value) => void setHuvCompletionDate(value)}
              completionDateSaving={completionDateSaving}
              completionDateError={completionDateError}
              onSign={() => setSignOpen(true)}
              onCorrection={() => void beginCorrection()}
              correctionLabel={openCorrectionId ? "Open correction draft" : "Create correction"}
            />
          ) : showAll ? (
            <div className="wx-hope-stack">
              {clinicalSections.map((section) => (
                <section
                  key={section.id}
                  id={`hope-section-${section.id}`}
                  className="wx-hope-all-section"
                  aria-label={`${section.id}. ${section.label}`}
                >
                  <h3 className="wx-hope-all-section-title">
                    {section.id}. {section.label}
                  </h3>
                  <div className="wx-hope-stack">
                    {(groupsBySection.get(section.id) ?? []).map((group) =>
                      renderGroup(section.id, group),
                    )}
                  </div>
                </section>
              ))}
            </div>
          ) : currentGroup ? (
            renderGroup(activeSection as Exclude<SectionId, "Review">, currentGroup)
          ) : (
            <EmptyState
              title="No active section items"
              description="The imported CMS specification did not return active assessment items for this section."
            />
          )}

          {!showAll ? (
            <footer className="wx-hope-footer">
              <Button
                tone="secondary"
                disabled={!prevStep}
                onClick={() => prevStep && goToStep(prevStep.section, prevStep.group?.key)}
              >
                <Glyph name="arrow-right" size={16} style={{ transform: "rotate(180deg)" }} />
                {prevStep ? `Back: ${stepLabel(prevStep)}` : "Back"}
              </Button>
              <span className="wx-hope-footer-note">Answers save automatically.</span>
              {nextStep ? (
                <Button onClick={() => goToStep(nextStep.section, nextStep.group?.key)}>
                  Next: {stepLabel(nextStep)}
                  <Glyph name="arrow-right" size={16} />
                </Button>
              ) : (
                <span />
              )}
            </footer>
          ) : null}
        </main>
      </div>
      {reconcile ? (
        <ChartReconcileDialog
          itemCode={reconcile.itemCode}
          hopeValue={reconcile.value}
          chart={
            reconcile.itemCode === "A0600B"
              ? patientExtra.medicareOnChart
              : patientExtra.medicaidOnChart
          }
          patientId={assessment.patientId}
          payers={patientExtra.payers}
          admissionDate={
            typeof admissionDateAnswer === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(admissionDateAnswer)
              ? admissionDateAnswer
              : null
          }
          canEditHope={!completed}
          correction={
            completed && !assessment.supersededByAssessmentId
              ? {
                  label: openCorrectionId ? "Open correction draft" : "Create correction",
                  onOpen: () => {
                    setReconcile(null);
                    void beginCorrection();
                  },
                }
              : null
          }
          onUseChart={async (value) => {
            const item = sections.get("A")?.items.find((i) => i.itemCode === reconcile.itemCode);
            // The dialog reads a resolved call as "HOPE now has it": a save that was refused, skipped (not a draft, no such
            // item) or never answered must reject. A refusal (nothing was applied) rejects with its own words, which the dialog
            // shows; only a save with no usable answer is left for the dialog to word as "could not confirm".
            if (!item) throw new HopeAnswerNotSavedError(ANSWER_NOT_SENT);
            const outcome = await saveAnswerOutcome(item, value);
            if (outcome.saved) return;
            throw outcome.outcomeUnknown
              ? new Error(HOPE_ANSWER_UNCONFIRMED)
              : new HopeAnswerNotSavedError(outcome.message);
          }}
          onChartUpdated={refreshChartNumbers}
          onClose={() => setReconcile(null)}
        />
      ) : null}
      {signOpen ? (
        <SignDialog
          review={review}
          title={`Complete ${recordLabel}`}
          signing={signing}
          error={wordingChanged ? ATTESTATION_STALE_MESSAGE : signError}
          wordingChanged={wordingChanged}
          onCancel={() => {
            setSignOpen(false);
            setSignError(null);
          }}
          onSign={() => void sign()}
        />
      ) : null}
      {inactivationOpen ? (
        <AmendmentDialog
          kind="inactivation"
          busy={inactivating}
          error={inactivationError}
          recordLabel={recordLabel}
          disciplines={amendmentDisciplines}
          onCancel={() => {
            clearInactivationError();
            setInactivationOpen(false);
          }}
          onSubmit={(reason, discipline) => void createInactivation(reason, discipline)}
        />
      ) : null}
      {correctionOpen ? (
        <AmendmentDialog
          kind="correction"
          busy={correcting}
          error={correctionError}
          recordLabel={recordLabel}
          disciplines={amendmentDisciplines}
          onCancel={closeCorrection}
          onSubmit={(reason, discipline) => void createCorrection(reason, discipline)}
        />
      ) : null}
      {sfv.open ? (
        <CompleteSfvDialog
          assessment={assessment}
          api={api}
          wordingChanged={wordingChanged}
          onWordingChanged={() => setWordingChanged(true)}
          items={
            workspace.sections
              .find((section) => section.code === "J")
              ?.items.filter((item) => item.itemCode.startsWith("J2053")) ?? []
          }
          onCancel={sfv.close}
          onCompleted={sfv.complete}
        />
      ) : null}

      {sfvReviewOpen ? (
        <ReviewSfvDialog
          items={
            workspace.sections
              .find((section) => section.code === "J")
              ?.items.filter(
                (item) => item.itemCode.startsWith("J2052") || item.itemCode.startsWith("J2053"),
              ) ?? []
          }
          onClose={() => setSfvReviewOpen(false)}
        />
      ) : null}
    </PatientWorkspaceLayout>
  );
}

type SaveFn = (
  item: WorkspaceItem | readonly WorkspaceItem[],
  value: AnswerValue | null | ReadonlyMap<string, AnswerValue>,
) => Promise<boolean>;
type Findings = Map<string, ReviewModel["validation"]["findings"]>;

type PayerConsistencyFinding = {
  severity: "error" | "warning";
  message: string;
};

/** CMS HOPE A1400 consistency edits. Fatal edits are errors; the others are CMS warnings. */
function payerConsistencyFindings(items: WorkspaceItem[]): PayerConsistencyFinding[] {
  const selected = new Set(
    items.filter((item) => String(item.value ?? "") === "1").map((item) => item.itemCode),
  );
  const has = (...codes: string[]) => codes.every((code) => selected.has(code));
  const includesAny = (...codes: string[]) => codes.some((code) => selected.has(code));
  const findings: PayerConsistencyFinding[] = [];
  const error = (message: string) => findings.push({ severity: "error", message });
  const warning = (message: string) => findings.push({ severity: "warning", message });

  if (has("A1400A", "A1400B"))
    error("Medicare FFS and Medicare Advantage cannot both be selected.");
  if (has("A1400C", "A1400D"))
    error("Medicaid FFS and Medicaid managed care cannot both be selected.");
  if (selected.has("A1400K") && selected.size > 1)
    error("No payor source cannot be selected with any other payer source.");
  if (
    selected.has("A1400X") &&
    includesAny(
      "A1400A",
      "A1400B",
      "A1400C",
      "A1400D",
      "A1400G",
      "A1400H",
      "A1400I",
      "A1400J",
      "A1400K",
    )
  )
    warning("Unknown payer should not be selected when another payer source is known.");
  if (has("A1400X", "A1400Y")) warning("Unknown payer and Other should not both be selected.");
  if (has("A1400C", "A1400H"))
    warning("Medicaid FFS and private insurance/Medigap should not both be selected.");
  if (has("A1400C", "A1400I"))
    warning("Medicaid FFS and private managed care should not both be selected.");
  if (has("A1400D", "A1400H"))
    warning("Medicaid managed care and private insurance/Medigap should not both be selected.");
  if (has("A1400D", "A1400I"))
    warning("Medicaid managed care and private managed care should not both be selected.");
  if (has("A1400J", "A1400Y")) warning("Self-pay and Other should not both be selected.");
  return findings;
}

interface ItemRenderProps {
  readonly: boolean;
  findingsByItem: Findings;
  fieldErrors: Record<string, string>;
  onSave: SaveFn;
  /** Extra hint under one item's control, keyed by item code (e.g. A0600B vs the chart). */
  notes?: Record<string, ReactNode>;
}

const OPTIONAL_ITEMS = new Set(["A0500B", "A0500D"]);

// Section A groups → the mockup's section icon + one-line description.
const A_GROUP_META: Record<string, { icon: GlyphName; description: string }> = {
  "Provider Information": {
    icon: "building",
    description: "Provider identifiers associated with this admission.",
  },
  "Admission Information": {
    icon: "calendar",
    description: "Details about this hospice admission.",
  },
  "Patient Identity": {
    icon: "user",
    description: "Confirm the patient's identity information.",
  },
  Demographics: {
    icon: "users",
    description: "Ethnicity, race, and language information from the patient chart.",
  },
  "Payer / Coverage": {
    icon: "shield-check",
    description: "Payer sources in effect for this admission. Select all that apply.",
  },
  "Living Situation": {
    icon: "home",
    description: "Where and with whom the patient lives.",
  },
};

const GROUP_ICON: Record<string, GlyphName> = {
  CPR: "heart-pulse",
  "Other Life-Sustaining Treatments": "heart-pulse",
  Hospitalization: "bed",
  "Spiritual / Existential Concerns": "sparkle",
  "Current status": "activity",
  Pain: "zap",
  "Shortness of breath": "activity",
  "Symptom impact": "alert-circle",
  "Skin condition screening": "droplet",
  "Conditions identified": "clipboard-list",
  "Treatments / interventions": "clipboard-check",
  "Scheduled opioid": "pill",
  "PRN opioid": "pill",
  "Bowel regimen": "pill",
};

// CMS 0/1 items (Not checked / Checked) render as one checkbox-tile group per 5-char stem.
const TILE_GROUP_LABEL: Record<string, string> = {
  A1005: "Ethnicity (Select all that apply)",
  A1010: "Race (Select all that apply)",
  A1400: "Payer information (Select all that apply)",
  J0910: "Pain assessment included (Select all that apply)",
  M1195: "Skin conditions (Select all that apply)",
  M1200: "Skin treatments (Select all that apply)",
};

/**
 * CMS short labels repeat the group name on every box ("Pain asmt included: location", "Payer: Self-pay",
 * "Skin Condition - Rash(es)"). The group legend already says it, so each tile shows only its own part.
 */
function tileLabels(items: WorkspaceItem[]): Map<string, string> {
  const prefixOf = (label: string) => /^(.+?)(?::\s+|\s+-\s+)/.exec(label)?.[0] ?? null;
  const first = items[0] ? prefixOf(items[0].label) : null;
  const shared = first && items.every((item) => item.label.startsWith(first)) ? first : null;
  return new Map(
    items.map((item) => {
      const rest = shared ? item.label.slice(shared.length).trim() : item.label;
      return [item.itemCode, rest.charAt(0).toUpperCase() + rest.slice(1)];
    }),
  );
}

/**
 * CMS mutual-exclusivity inside a "select all that apply" group (mirrors the backend v1.00.1 rules
 * -3080/-3090/-3041/-3094/-3095 and the payer consistency errors). `solo` codes stand alone: picking
 * one greys out every other tile, and picking any other tile greys out the solo codes. `pairs`
 * are two codes that cannot both be checked.
 */
const TILE_EXCLUSIVITY: Record<string, { solo: string[]; pairs?: [string, string][] }> = {
  A1005: { solo: ["A1005A", "A1005X", "A1005Y"] },
  A1010: { solo: ["A1010X", "A1010Y", "A1010Z"] },
  A1400: {
    solo: ["A1400K", "A1400X"],
    pairs: [
      ["A1400A", "A1400B"],
      ["A1400C", "A1400D"],
    ],
  },
  J0910: { solo: ["J0910C9"] },
  M1195: { solo: ["M1195Z"] },
  M1200: { solo: ["M1200Z"] },
};

/** Why `code` cannot be checked given the currently checked codes, or undefined when it can. */
function tileBlockedReason(
  stem: string,
  code: string,
  checked: ReadonlySet<string>,
  labelOf: (code: string) => string,
): string | undefined {
  const rule = TILE_EXCLUSIVITY[stem];
  if (!rule || checked.has(code)) return undefined;
  const others = [...checked].filter((c) => c !== code);
  if (others.length === 0) return undefined;
  const soloOther = others.find((c) => rule.solo.includes(c));
  if (soloOther) return `Unavailable while "${labelOf(soloOther)}" is selected — uncheck it first.`;
  if (rule.solo.includes(code))
    return `"${labelOf(code)}" cannot be combined with other selections — uncheck them first.`;
  for (const [a, b] of rule.pairs ?? []) {
    const partner = code === a ? b : code === b ? a : null;
    if (partner && checked.has(partner))
      return `Cannot be combined with "${labelOf(partner)}" — uncheck it first.`;
  }
  return undefined;
}

function isCheckboxItem(item: WorkspaceItem): boolean {
  // Only CMS "check all that apply" items (0 = Not checked, 1 = Checked). Real yes/no questions that
  // happen to be coded 0/1 (F2000A "Yes, discussion occurred") stay single-choice rows. The CMS
  // "^ Blank (skip pattern)" value (J0910C*, M1195*, M1200*) is written by skip logic, never chosen,
  // so it does not stop an item from being a checkbox.
  const options = answerOptionsForControl(item);
  const codes = options.map((o) => o.valueCode).sort();
  return (
    item.applicability === "applicable" &&
    !PROTECTED_ITEMS.has(item.itemCode) &&
    codes.length === 2 &&
    codes[0] === "0" &&
    codes[1] === "1" &&
    options.every((o) => /check/i.test(o.label))
  );
}

function isRequired(item: WorkspaceItem): boolean {
  return (
    item.applicability === "applicable" &&
    !OPTIONAL_ITEMS.has(item.itemCode) &&
    !PROTECTED_ITEMS.has(item.itemCode)
  );
}

/** Split a group's items into checkbox-tile runs (same 5-char stem, ≥2 items) and single items. */
function partitionTiles(
  items: WorkspaceItem[],
): (
  | { kind: "tiles"; stem: string; items: WorkspaceItem[] }
  | { kind: "item"; item: WorkspaceItem }
)[] {
  const out: (
    | { kind: "tiles"; stem: string; items: WorkspaceItem[] }
    | { kind: "item"; item: WorkspaceItem }
  )[] = [];
  const byStem = new Map<string, WorkspaceItem[]>();
  for (const item of items) {
    if (!isCheckboxItem(item)) continue;
    const stem = item.itemCode.slice(0, 5);
    byStem.set(stem, [...(byStem.get(stem) ?? []), item]);
  }
  const emitted = new Set<string>();
  for (const item of items) {
    const stem = item.itemCode.slice(0, 5);
    const run = byStem.get(stem);
    if (isCheckboxItem(item) && run && run.length >= 2) {
      if (!emitted.has(stem)) {
        emitted.add(stem);
        out.push({ kind: "tiles", stem, items: run });
      }
      continue;
    }
    out.push({ kind: "item", item });
  }
  return out;
}

/** One navigable unit of a section: a single clinical card (Option 1 shows one at a time). */
interface GroupView {
  /** Stable within its section, e.g. "patient-identity". */
  key: string;
  label: string;
  icon: GlyphName;
  description?: string;
  /** Extra DOM id existing issue links target (e.g. "hope-item-A1400"). */
  anchorId?: string;
  /** `fields` = Section A grid; `questions` = stacked block questions; `sfv` = SFV workflow card. */
  kind: "fields" | "questions" | "sfv";
  items: WorkspaceItem[];
}

function groupKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Splits a section into the cards it renders as — the shared unit of both navigation modes. */
function sectionGroups(
  sectionId: Exclude<SectionId, "Review">,
  section: WorkspaceSection,
): GroupView[] {
  const items = section.items;
  const view = (
    label: string,
    kind: GroupView["kind"],
    rows: WorkspaceItem[],
    extra: Partial<GroupView> = {},
  ): GroupView => ({
    key: groupKey(label),
    label,
    icon: GROUP_ICON[label] ?? "clipboard-list",
    kind,
    items: rows,
    ...extra,
  });
  if (sectionId === "A") {
    return groupSectionA(items).map((group) =>
      view(group.label, "fields", group.items, {
        icon: A_GROUP_META[group.label]?.icon ?? "file-text",
        description: A_GROUP_META[group.label]?.description,
        anchorId:
          group.label === "Demographics"
            ? "hope-group-demographics"
            : group.label === "Payer / Coverage"
              ? "hope-item-A1400"
              : undefined,
      }),
    );
  }
  if (sectionId === "F")
    return groupByCodes(items, F_GROUPS).map((g) => view(g.label, "questions", g.items));
  if (sectionId === "I") {
    const principal = items.filter((i) => i.itemCode === "I0010");
    const others = items.filter((i) => i.itemCode !== "I0010");
    return [
      ...(principal.length
        ? [
            view("Principal Diagnosis Category", "questions", principal, {
              icon: "stethoscope",
              description:
                "Use the chart diagnosis as context only. The HOPE category remains a clinician-selected answer.",
            }),
          ]
        : []),
      ...(others.length ? [view("Other Conditions", "fields", others)] : []),
    ];
  }
  if (sectionId === "J") {
    const isSfv = (item: WorkspaceItem) =>
      item.itemCode.startsWith("J2052") || item.itemCode.startsWith("J2053");
    const sfvItems = items.filter(isSfv);
    const regular = items.filter((item) => !isSfv(item));
    const groups = J_GROUPS.filter((label) => label !== "Symptom Follow-Up Visit")
      .map((label) => ({
        label,
        items: regular.filter((item) => (item.group ?? groupJItem(item.itemCode)) === label),
      }))
      .filter((group) => group.items.length > 0);
    const grouped = new Set(groups.flatMap((group) => group.items.map((item) => item.itemCode)));
    const leftover = regular.filter((item) => !grouped.has(item.itemCode));
    if (leftover.length) groups.push({ label: "Other Health Conditions", items: leftover });
    return [
      ...groups.map((g) => view(g.label, "questions", g.items)),
      ...(sfvItems.length
        ? [view("Symptom Follow-Up Visit", "sfv", sfvItems, { icon: "calendar-check" })]
        : []),
    ];
  }
  return groupGeneric(
    items,
    sectionId === "M"
      ? ["Skin condition screening", "Conditions identified", "Treatments / interventions"]
      : ["Scheduled opioid", "PRN opioid", "Bowel regimen"],
  ).map((g) => view(g.label, "questions", g.items));
}

/**
 * Required, applicable, still-unanswered questions — what "to do" means everywhere on this screen.
 * A "select all that apply" group is one question (one tick answers every box), so it counts once.
 */
function openRequiredItems(items: WorkspaceItem[]): WorkspaceItem[] {
  const seenStems = new Set<string>();
  return items.filter((item) => {
    if (!isRequired(item) || item.state !== "unanswered") return false;
    if (!isCheckboxItem(item)) return true;
    const stem = item.itemCode.slice(0, 5);
    if (seenStems.has(stem)) return false;
    seenStems.add(stem);
    return true;
  });
}

function groupNavState(
  group: GroupView,
  visited: boolean,
): { state: "complete" | "progress" | "attention" | "empty"; open: number } {
  const open = openRequiredItems(group.items).length;
  if (open === 0) return { state: "complete", open };
  if (visited) return { state: "attention", open };
  const touched = group.items.some((item) => item.state !== "unanswered");
  return { state: touched ? "progress" : "empty", open };
}

/** Drop "required" findings for a group the user has not reached yet — no red before first visit. */
function withoutMissingRequired(findings: Findings, items: WorkspaceItem[]): Findings {
  const codes = new Set(items.map((item) => item.itemCode));
  const out: Findings = new Map();
  for (const [code, list] of findings) {
    const kept = codes.has(code) ? list.filter((f) => !isMissingRequiredFinding(f)) : list;
    if (kept.length) out.set(code, kept);
  }
  return out;
}

function isMissingRequiredFinding(finding: { ruleId: string; message: string }): boolean {
  return /is required for final HOPE validation|is active and applicable but unanswered/i.test(
    finding.message,
  );
}

function GroupCard(
  props: ItemRenderProps & {
    group: GroupView;
    sectionId: Exclude<SectionId, "Review">;
    /** The record is read-only for the follow-up card: signed, or superseded by a correction. */
    sfvLocked: boolean;
    sfvLookup: SfvLookup;
    onRetrySfvLookup: () => void;
    sfvFocusKey: number;
    sfvReturnFocusKey: number;
    onCompleteSfv?: () => void;
    onReviewSfv?: () => void;
  },
): JSX.Element {
  const { group } = props;
  const domId = `hope-group-${props.sectionId}-${group.key}`;
  if (group.kind === "sfv") {
    return (
      <div id={domId}>
        <SfvWorkflowSection
          items={group.items}
          signed={props.sfvLocked}
          lookup={props.sfvLookup}
          onRetryLookup={props.onRetrySfvLookup}
          focusKey={props.sfvFocusKey}
          returnFocusKey={props.sfvReturnFocusKey}
          onComplete={() => props.onCompleteSfv?.()}
          onReview={() => props.onReviewSfv?.()}
        />
      </div>
    );
  }
  const common: ItemRenderProps = {
    readonly: props.readonly,
    findingsByItem: props.findingsByItem,
    fieldErrors: props.fieldErrors,
    onSave: props.onSave,
    notes: props.notes,
  };
  return (
    <div id={domId} data-hope-group={`${props.sectionId}:${group.key}`}>
      <ClinicalSection
        id={group.anchorId}
        icon={group.icon}
        title={group.label}
        description={group.description}
      >
        {group.kind === "fields" ? (
          <FieldGridItems items={group.items} {...common} />
        ) : (
          <div className="wx-question-stack">
            {partitionTiles(group.items).map((part) =>
              part.kind === "tiles" ? (
                <TileGroup key={part.stem} stem={part.stem} items={part.items} {...common} />
              ) : (
                <QuestionRenderer
                  key={part.item.itemCode}
                  item={part.item}
                  layout="block"
                  readonly={props.readonly}
                  findings={props.findingsByItem.get(part.item.itemCode) ?? []}
                  fieldError={props.fieldErrors[part.item.itemCode]}
                  note={props.notes?.[part.item.itemCode]}
                  onSave={props.onSave}
                />
              ),
            )}
          </div>
        )}
      </ClinicalSection>
    </div>
  );
}

/** Section A layout: fields flow in a responsive grid; 0/1 runs become one tile group spanning the row. */
function FieldGridItems(props: ItemRenderProps & { items: WorkspaceItem[] }): JSX.Element {
  return (
    <div className="wx-field-grid">
      {partitionTiles(props.items).map((part) =>
        part.kind === "tiles" ? (
          <div key={part.stem} className="wx-field-grid-full">
            <TileGroup {...props} stem={part.stem} items={part.items} />
          </div>
        ) : (
          <QuestionRenderer
            key={part.item.itemCode}
            item={part.item}
            layout="field"
            readonly={props.readonly}
            findings={props.findingsByItem.get(part.item.itemCode) ?? []}
            fieldError={props.fieldErrors[part.item.itemCode]}
            note={props.notes?.[part.item.itemCode]}
            onSave={props.onSave}
          />
        ),
      )}
    </div>
  );
}

function TileGroup(props: ItemRenderProps & { stem: string; items: WorkspaceItem[] }): JSX.Element {
  const messages = props.items.flatMap((i) => [
    ...(props.findingsByItem.get(i.itemCode) ?? []).map((f) => f.message),
    ...(props.fieldErrors[i.itemCode] ? [props.fieldErrors[i.itemCode]!] : []),
  ]);
  const payerFindings = props.stem === "A1400" ? payerConsistencyFindings(props.items) : [];
  const sourced = props.items.find((i) => i.source && i.source !== "user");
  const labels = tileLabels(props.items);
  const tileLabel = (item: WorkspaceItem) =>
    props.stem === "A1010"
      ? item.label.replace(/^Race\s*:\s*/i, "")
      : (labels.get(item.itemCode) ?? item.label);
  const checkedCodes = new Set(
    props.items.filter((i) => String(i.value ?? "") === "1").map((i) => i.itemCode),
  );
  const labelOf = (code: string) => {
    const item = props.items.find((i) => i.itemCode === code);
    return item ? tileLabel(item) : code;
  };
  return (
    <div id={`hope-item-${props.stem}`} tabIndex={-1}>
      <CheckboxTiles
        legend={TILE_GROUP_LABEL[props.stem] ?? "Select all that apply"}
        code={props.stem}
        required={props.items.some(isRequired)}
        disabled={props.readonly}
        columns={3}
        options={props.items.map((item) => ({
          key: item.itemCode,
          label: tileLabel(item),
          code: item.itemCode,
          checked: checkedCodes.has(item.itemCode),
          blockedReason: tileBlockedReason(props.stem, item.itemCode, checkedCodes, labelOf),
        }))}
        onToggle={(code, checked) => {
          const values = new Map(
            props.items
              .filter((item) => item.applicability === "applicable")
              .map((item) => [
                item.itemCode,
                item.itemCode === code
                  ? checked
                    ? "1"
                    : "0"
                  : String(item.value) === "1"
                    ? "1"
                    : "0",
              ]),
          );
          void props.onSave(
            [...props.items.filter((item) => item.applicability === "applicable")],
            values,
          );
        }}
      />
      {sourced ? (
        <div className="wx-hope-field-hint">
          <SourceBadge source={sourced.source} />
        </div>
      ) : null}
      {messages.length ? (
        <div className="wx-hope-field-msg wx-hope-field-msg-error">
          {[...new Set(messages)].map((m) => (
            <div key={m}>{m}</div>
          ))}
        </div>
      ) : null}
      {payerFindings.map((finding) => (
        <div
          key={finding.message}
          className={`wx-hope-field-msg wx-hope-field-msg-${finding.severity}`}
          role={finding.severity === "error" ? "alert" : undefined}
        >
          <strong>{finding.severity === "error" ? "Error: " : "Warning: "}</strong>
          {finding.message}
        </div>
      ))}
    </div>
  );
}

function QuestionRenderer(props: {
  item: WorkspaceItem;
  /** `field` = compact grid field (Section A); `block` = full-width question with option rows. */
  layout: "field" | "block";
  readonly: boolean;
  findings: ReviewModel["validation"]["findings"];
  fieldError?: string;
  onSave: SaveFn;
  note?: ReactNode;
}): JSX.Element {
  const { item } = props;
  const optional = OPTIONAL_ITEMS.has(item.itemCode);
  if (item.applicability === "not_applicable") {
    return (
      <div id={`hope-item-${item.itemCode}`} tabIndex={-1} className="wx-hope-skipped">
        <span>
          {item.label}{" "}
          {optional ? (
            <span className="wx-optional-mark" aria-hidden>
              Optional
            </span>
          ) : null}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <CmsCode code={item.itemCode} />
          <StatusPill label="Skipped" tone="neutral" />
        </span>
      </div>
    );
  }
  if (item.applicability === "pending") {
    return (
      <div id={`hope-item-${item.itemCode}`} tabIndex={-1} className="wx-hope-pending">
        <strong>
          {item.label} <CmsCode code={item.itemCode} />
        </strong>
        <span>{pendingApplicabilityMessage(item)}</span>
        <small>{pendingApplicabilityDetail(item)}</small>
      </div>
    );
  }

  const workflowControlled = PROTECTED_ITEMS.has(item.itemCode);
  const readonly = props.readonly || workflowControlled;
  const inputId = `hope-${item.itemCode}`;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const messages = [
    ...props.findings.map((f) => f.message),
    ...(props.fieldError ? [props.fieldError] : []),
  ];
  const messageTone =
    props.findings.some((f) => f.severity === "warning") && !props.fieldError ? "warning" : "error";
  const describedBy = `${hintId}${messages.length ? ` ${errorId}` : ""}`;
  const hintParts: ReactNode[] = [];
  // A locked value says where it came from: its prefill source when it has one ("From admission"),
  // else the workflow that owns it ("From Hospice Provider (Organization settings)").
  const prefilled = item.source && item.source !== "user" && item.source !== "derived";
  if (workflowControlled && !prefilled) hintParts.push(workflowControlledMessage(item));
  else if (item.source && item.source !== "user")
    hintParts.push(<SourceBadge key="src" source={item.source} />);
  const coverageHint = coverageNumberHint(item);
  if (coverageHint) hintParts.push(coverageHint);
  if (props.readonly && !workflowControlled)
    hintParts.push("Read-only — this record is completed.");
  if (props.note) hintParts.push(props.note);
  const hint = hintParts.length ? (
    <>
      {hintParts.map((h, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static hint fragments.
        <span key={i}>{h}</span>
      ))}
    </>
  ) : null;

  const control = workflowControlled ? (
    <LockedValue id={inputId} value={controlledValueLabel(item)} describedBy={describedBy} />
  ) : (
    <AnswerControl
      item={item}
      inputId={inputId}
      readonly={readonly}
      describedBy={describedBy}
      onSave={props.onSave}
      layout={props.layout}
    />
  );

  if (props.layout === "field") {
    return (
      <FieldShell
        id={`hope-item-${item.itemCode}`}
        htmlFor={inputId}
        label={item.label}
        code={item.itemCode}
        required={isRequired(item)}
        optional={optional}
        hint={hint}
        hintId={hintId}
        errorId={errorId}
        messages={messages}
        messageTone={messageTone}
      >
        {control}
      </FieldShell>
    );
  }

  // Block question (mockup J0200): bold title + Required chip, CMS code tag right, then rows.
  const unanswered = item.state === "unanswered";
  return (
    <div id={`hope-item-${item.itemCode}`} tabIndex={-1} className="wx-question-block">
      <div className="wx-question-head">
        <label htmlFor={inputId} className="wx-question-title">
          <span>{item.label}</span>
          {optional ? (
            <span className="wx-optional-mark" aria-hidden>
              Optional
            </span>
          ) : null}
        </label>
        {isRequired(item) && unanswered && !props.readonly ? <RequiredChip /> : null}
        <CmsCode code={item.itemCode} />
      </div>
      {hint ? (
        <div id={hintId} className="wx-hope-field-hint">
          {hint}
        </div>
      ) : (
        <span id={hintId} hidden />
      )}
      {control}
      {messages.length ? (
        <div id={errorId} className={`wx-hope-field-msg wx-hope-field-msg-${messageTone}`}>
          {messages.map((message) => (
            <div key={message}>{message}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The display value of a workflow-controlled item (option label when coded). */
function controlledValueLabel(item: WorkspaceItem): string {
  const current = String(item.value ?? "");
  const option = item.options.find((candidate) => candidate.valueCode === current);
  return option?.label || current || "Not available";
}

const PREFERRED_LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "zh", label: "Chinese" },
  { value: "vi", label: "Vietnamese" },
  { value: "tl", label: "Tagalog" },
  { value: "ar", label: "Arabic" },
  { value: "ko", label: "Korean" },
  { value: "ru", label: "Russian" },
  { value: "pt", label: "Portuguese" },
  { value: "de", label: "German" },
  { value: "hi", label: "Hindi" },
  { value: "ja", label: "Japanese" },
  { value: "ot", label: "Other" },
] as const;

function PreferredLanguageControl({
  item,
  inputId,
  readonly,
  describedBy,
  onSave,
}: {
  item: WorkspaceItem;
  inputId: string;
  readonly: boolean;
  describedBy: string;
  onSave: SaveFn;
}): JSX.Element {
  const value = item.value == null ? "" : String(item.value);

  const knownLanguage = PREFERRED_LANGUAGE_OPTIONS.some((option) => option.value === value);

  const [otherSelected, setOtherSelected] = useState(Boolean(value && !knownLanguage));

  const customLanguage = value && !knownLanguage ? value : "";

  const selectedValue = otherSelected ? "ot" : value;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <select
        id={inputId}
        value={selectedValue}
        disabled={readonly}
        aria-describedby={describedBy}
        style={inputStyle}
        onChange={(event) => {
          const nextValue = event.target.value;

          if (nextValue === "ot") {
            setOtherSelected(true);
            return;
          }

          setOtherSelected(false);
          void onSave(item, nextValue || null);
        }}
      >
        <option value="">Select preferred language...</option>

        {PREFERRED_LANGUAGE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {otherSelected ? (
        <input
          type="text"
          defaultValue={customLanguage}
          placeholder="Enter preferred language"
          readOnly={readonly}
          aria-label="Other preferred language"
          aria-describedby={describedBy}
          style={inputStyle}
          onBlur={(event) => {
            const language = event.currentTarget.value.trim();

            if (language && language !== customLanguage) {
              void onSave(item, language);
            }
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Free-text item with CMS special values (Blank "^", "+", "N"). The typed value and a special value
 * are mutually exclusive: choosing a special value clears and greys out the text box; typing greys
 * out the special values. Clicking the selected special value again clears it.
 */
function TextWithSpecialValues(props: {
  item: WorkspaceItem;
  value: string;
  specialOptions: { valueCode: string; label: string }[];
  inputId: string;
  readonly: boolean;
  describedBy: string;
  onSave: SaveFn;
}): JSX.Element {
  const special = props.specialOptions.some((o) => o.valueCode === props.value) ? props.value : "";
  const [draft, setDraft] = useState(special ? "" : props.value);
  useEffect(() => {
    setDraft(special ? "" : props.value);
  }, [props.value, special]);
  const typed = draft.trim() !== "";
  // A0600A SSN: CMS fatal edits -3015/-3001/-3002/-3003, shown as you type (iQIES would reject it).
  const isSsn = props.item.itemCode === "A0600A";
  // Only for an unsaved edit: once saved, the server's finding for the same edit takes over.
  const ssnProblem =
    isSsn && typed && normalizeSsn(draft) !== props.value ? ssnCmsProblem(draft) : null;
  const ssnErrorId = `${props.inputId}-ssn`;
  return (
    <div style={{ display: "grid", gap: ".75rem" }}>
      <input
        id={props.inputId}
        type="text"
        value={draft}
        maxLength={props.item.maxLength ?? undefined}
        placeholder={special ? `Special value "${special}" selected` : textPlaceholder(props.item)}
        readOnly={props.readonly}
        disabled={Boolean(special) && !props.readonly}
        aria-describedby={ssnProblem ? `${props.describedBy} ${ssnErrorId}` : props.describedBy}
        aria-invalid={ssnProblem ? true : undefined}
        inputMode={isSsn ? "numeric" : undefined}
        style={special ? { ...inputStyle, opacity: 0.55, cursor: "not-allowed" } : inputStyle}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={(event) => {
          // CMS submits the SSN as 9 bare digits: "123-45-6789" is saved as "123456789".
          const next = isSsn ? normalizeSsn(event.currentTarget.value) : event.currentTarget.value;
          if (isSsn && next !== event.currentTarget.value) setDraft(next);
          if (next !== props.value) void props.onSave(props.item, next || null);
        }}
      />
      {ssnProblem ? (
        <span id={ssnErrorId} className="wx-hope-field-msg wx-hope-field-msg-error">
          {ssnProblem.message} (CMS edit {ssnProblem.ruleId})
        </span>
      ) : null}
      {props.specialOptions.length ? (
        <OptionRows
          name={`${props.item.itemCode}-special`}
          legend="Or select a CMS special value"
          options={props.specialOptions}
          value={special}
          disabled={props.readonly}
          describedBy={props.describedBy}
          blockedReason={typed ? "Clear the typed value to choose this instead." : undefined}
          onChange={(code) => void props.onSave(props.item, code)}
          onClear={() => void props.onSave(props.item, null)}
        />
      ) : null}
    </div>
  );
}

function AnswerControl(props: {
  item: WorkspaceItem;
  inputId: string;
  readonly: boolean;
  describedBy: string;
  onSave: SaveFn;
  layout: "field" | "block";
}): JSX.Element {
  const value = props.item.value == null ? "" : String(props.item.value);
  const dateLike = /date|dt|dte/i.test(props.item.cmsItemTypeCode ?? props.item.label);
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

  if (props.item.itemCode === "A1110A") {
    return (
      <PreferredLanguageControl
        item={props.item}
        inputId={props.inputId}
        readonly={props.readonly}
        describedBy={props.describedBy}
        onSave={props.onSave}
      />
    );
  }

  if (isSectionIOtherConditionYesNo(props.item)) {
    return (
      <fieldset
        aria-label={`${props.item.label}: select Yes or No`}
        aria-describedby={props.describedBy}
        style={{
          // A `<fieldset>` is the native `group` (biome a11y/useSemanticElements); its default border,
          // padding and min-inline-size are reset so it renders exactly like the `<div>` it replaces.
          border: 0,
          margin: 0,
          padding: 0,
          minInlineSize: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: ".875rem",
          minHeight: "2.25rem",
        }}
      >
        {(
          [
            ["1", "Yes"],
            ["0", "No"],
          ] as const
        ).map(([code, label]) => (
          <label
            key={code}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: ".4rem",
              cursor: props.readonly ? "default" : "pointer",
              fontSize: ".875rem",
            }}
          >
            <input
              id={code === "1" ? props.inputId : undefined}
              type="checkbox"
              checked={value === code}
              disabled={props.readonly}
              style={{
                width: "1rem",
                height: "1rem",
                margin: 0,
                accentColor: "var(--color-primary)",
              }}
              onChange={(event) => {
                if (event.currentTarget.checked) void props.onSave(props.item, code);
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>
    );
  }

  if (isTextItem(props.item)) {
    return (
      <TextWithSpecialValues
        item={props.item}
        value={value}
        specialOptions={displayOptions}
        inputId={props.inputId}
        readonly={props.readonly}
        describedBy={props.describedBy}
        onSave={props.onSave}
      />
    );
  }
  // Block questions show their choices as full-width option rows (mockup); grid fields use a select.
  if (props.layout === "block" && displayOptions.length > 0 && displayOptions.length <= 8) {
    return (
      <OptionRows
        name={props.item.itemCode}
        legend={props.item.label}
        options={displayOptions}
        value={value}
        disabled={props.readonly}
        describedBy={props.describedBy}
        onChange={(code) => void props.onSave(props.item, code)}
      />
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
        onChange={(event) => void props.onSave(props.item, event.target.value || null)}
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

function isSectionIOtherConditionYesNo(item: WorkspaceItem): boolean {
  if (item.section !== "I" || item.itemCode === "I0010") return false;
  const codes = item.options.map((option) => option.valueCode).sort();
  return codes.length === 2 && codes[0] === "0" && codes[1] === "1";
}

function isTextItem(item: WorkspaceItem): boolean {
  return (
    /text/i.test(item.cmsItemTypeCode ?? "") ||
    item.options.some((option) => option.valueCode === "Text")
  );
}

/** Drop a leading copy of the option's OWN CMS value code ("1 - Yes" → "Yes"). The previous pattern matched
 *  any leading word case-insensitively, so "Not at all - symptom does not affect…" lost its "Not" and
 *  "Not applicable (…)" rendered as "applicable (…)". */
function stripOwnValueCode(label: string, valueCode: string): string {
  const escaped = valueCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return label.replace(new RegExp(`^${escaped}(?:\\s*[-.:=)]\\s*|\\s+)`), "");
}

function answerOptionsForControl(item: WorkspaceItem): WorkspaceItem["options"] {
  return item.options
    .filter(
      (option) =>
        option.valueCode !== "Text" &&
        !/^YYYY(MM(DD)?)?$/.test(option.valueCode) &&
        !(option.valueCode === "^" && /skip\s*pattern/i.test(option.label)),
    )
    .map((option) => ({
      ...option,
      label: stripOwnValueCode(option.label, option.valueCode),
    }));
}

function textPlaceholder(item: WorkspaceItem): string | undefined {
  if (item.itemCode === "A0500B") return "Middle initial";
  if (item.itemCode === "A0500D") return "Suffix";
  return item.maxLength ? `Up to ${item.maxLength} characters` : undefined;
}

function coverageNumberHint(item: WorkspaceItem): string | null {
  if (item.itemCode === "A0600B") {
    return "Required only when the patient has Medicare coverage.";
  }

  if (item.itemCode === "A0700") {
    return "Required only when the patient has Medicaid coverage.";
  }

  return null;
}

function PayerCoverageReview({
  workspace,
  onGoTo,
}: {
  workspace: Workspace;
  onGoTo: (section: SectionId) => void;
}): JSX.Element | null {
  const sectionA = workspace.sections.find((section) => section.code === "A");

  if (!sectionA) {
    return null;
  }

  const payerItems = sectionA.items.filter((item) => item.itemCode.startsWith("A1400"));

  const selectedPayers = payerItems.filter((item) => String(item.value ?? "") === "1");
  const consistencyFindings = payerConsistencyFindings(payerItems);

  const medicareNumber = sectionA.items.find((item) => item.itemCode === "A0600B");

  const medicaidNumber = sectionA.items.find((item) => item.itemCode === "A0700");

  const hasMedicare = payerItems.some(
    (item) =>
      (item.itemCode === "A1400A" || item.itemCode === "A1400B") &&
      String(item.value ?? "") === "1",
  );

  const hasMedicaid = payerItems.some(
    (item) =>
      (item.itemCode === "A1400C" || item.itemCode === "A1400D") &&
      String(item.value ?? "") === "1",
  );

  return (
    <section style={questionGroup}>
      <div style={reviewSubsectionHeader}>
        <div>
          <h3 style={groupTitle}>Payer / Coverage</h3>
          <p style={muted}>Review the payer sources recorded for this HOPE assessment.</p>
        </div>

        <button type="button" style={secondaryButton} onClick={() => onGoTo("A")}>
          View Section A
        </button>
      </div>

      {selectedPayers.length > 0 ? (
        <div style={payerReviewList}>
          {selectedPayers.map((item) => (
            <div key={item.itemCode} style={payerReviewRow}>
              <div style={payerReviewIdentity}>
                <span style={payerReviewCheck} aria-hidden="true">
                  ✓
                </span>

                <div>
                  <strong style={payerReviewLabel}>{item.label}</strong>

                  {item.source ? (
                    <small style={payerSource}>
                      {item.source === "patient_prefill"
                        ? "From patient coverage"
                        : item.source === "admission_prefill"
                          ? "From admission"
                          : item.source === "user"
                            ? "Confirmed in HOPE"
                            : "Prefilled"}
                    </small>
                  ) : null}
                </div>
              </div>

              <span style={codePill}>{item.itemCode}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={payerReviewEmpty}>
          No payer source is selected. Select at least one payer source before signing.
        </div>
      )}

      {consistencyFindings.length ? (
        <div style={payerReviewEmpty}>
          <strong>A1400 coverage issues</strong>
          {consistencyFindings.map((finding) => (
            <div
              key={finding.message}
              className={`wx-hope-field-msg wx-hope-field-msg-${finding.severity}`}
              role={finding.severity === "error" ? "alert" : undefined}
            >
              <strong>{finding.severity === "error" ? "Error: " : "Warning: "}</strong>
              {finding.message}
            </div>
          ))}
        </div>
      ) : null}

      {hasMedicare || hasMedicaid ? (
        <div style={payerIdentifierGrid}>
          {hasMedicare ? (
            <div style={payerIdentifierCard}>
              <span style={payerIdentifierLabel}>Medicare number</span>

              <strong style={payerIdentifierValue}>
                {medicareNumber?.value
                  ? maskCoverageIdentifier(String(medicareNumber.value))
                  : "Not recorded"}
              </strong>

              <span style={codePill}>A0600B</span>
            </div>
          ) : null}

          {hasMedicaid ? (
            <div style={payerIdentifierCard}>
              <span style={payerIdentifierLabel}>Medicaid number</span>

              <strong style={payerIdentifierValue}>
                {medicaidNumber?.value
                  ? maskCoverageIdentifier(String(medicaidNumber.value))
                  : "Not recorded"}
              </strong>

              <span style={codePill}>A0700</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ReviewPanel(props: {
  assessment: AssessmentDetail;
  review: ReviewModel | null;
  workspace: Workspace;
  visibleSections: { id: SectionId; label: string; helper: string }[];
  onGoTo: (section: SectionId) => void;
  onSetCompletionDate: (z0350: string) => void;
  completionDateSaving: boolean;
  completionDateError: string | null;
  onSign: () => void;
  onCorrection: () => void;
  correctionLabel: string;
}): JSX.Element {
  const completed = props.assessment.status === "signed";
  const isHuv = props.workspace.assessment.isc === "HUV";
  return (
    <section className="wx-hope-stack">
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
                ((props.workspace.progress.answered + props.workspace.progress.skipped) /
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
          error={props.completionDateError}
          onSave={props.onSetCompletionDate}
        />
      ) : null}
      <div style={reviewGrid}>
        {props.visibleSections
          .filter((s) => s.id !== "Review")
          .map((section) => {
            const state = sectionState(section.id, props.review, props.workspace);
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
      <PayerCoverageReview workspace={props.workspace} onGoTo={props.onGoTo} />

      <IssueList review={props.review} onGoTo={props.onGoTo} />
      {props.workspace.assessment.isc === "HA" || props.workspace.assessment.isc === "HUV" ? (
        <SfvSummary review={props.review} />
      ) : null}
      <div style={actionRow}>
        {completed ? (
          <button type="button" style={primaryButton} onClick={props.onCorrection}>
            {props.correctionLabel}
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
    const key = [row.ruleId, row.section, row.itemCode ?? "", row.message].join(":");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });

  if (!rows.length) {
    return <div style={successBox}>No blocking issues from the backend review.</div>;
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

            <span>{row.severity === "warning" ? "Warning" : "Go to question"}</span>
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
          tone={sfv?.status === "overdue" ? "critical" : sfv?.required ? "warning" : "neutral"}
        />
        {sfv?.dueAt ? <span>Due {formatInstant(sfv.dueAt)}</span> : null}
        {sfv?.completedAt ? <span>Completed {formatInstant(sfv.completedAt)}</span> : null}
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
  const stateLabelByCode: Record<NonNullable<Workspace["huv"]>["timingState"], string> = {
    upcoming: "Upcoming",
    within_window: "Within window",
    due_soon: "Due soon",
    late: "Late",
    completed: "Completed",
    unknown: "Schedule pending",
  };
  const warning = review?.validation.findings.find((finding) => finding.ruleId === "-3110");
  return (
    <section style={timingBanner}>
      <div>
        <strong>{stateLabelByCode[workspace.huv.timingState]}</strong>
        <span style={muted}>
          Recommended completion window {formatInstant(workspace.huv.windowStart)} -{" "}
          {formatInstant(workspace.huv.windowEnd)}
        </span>
      </div>
      <div style={timingBannerMeta}>
        <StatusPill
          label={
            workspace.huv.scheduleStatus ? stateLabel(workspace.huv.scheduleStatus) : "No schedule"
          }
          tone={workspace.huv.timingState === "late" ? "warning" : "neutral"}
        />
        {workspace.huv.z0350 ? <span>Z0350 {formatDate(workspace.huv.z0350)}</span> : null}
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
  error: string | null;
  onSave: (z0350: string) => void;
}): JSX.Element {
  const value = props.review?.z0350 ?? props.workspace.huv?.z0350 ?? "";
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  // The confirm button is disabled while the write is out, which drops focus to the page: a failure takes it back.
  const alertRef = useFocusOnNewError<HTMLParagraphElement>(props.error);
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
            disabled={props.readonly || props.saving || !draft || draft === value}
            onClick={() => props.onSave(draft)}
          >
            {props.saving ? "Saving..." : "Confirm date"}
          </button>
        </div>
        {props.error ? (
          <p ref={alertRef} tabIndex={-1} role="alert" style={completionDateErrorText}>
            {props.error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function CompletedSummary({
  assessment,
  review,
  api,
}: {
  assessment: AssessmentDetail;
  review: ReviewModel | null;
  api: HopeApiCompat;
}): JSX.Element {
  const signerId = assessment.signedBy ?? review?.signedByMembershipId ?? null;
  const [signerName, setSignerName] = useState<string | null>(null);

  useEffect(() => {
    setSignerName(null);
    if (!signerId || !assessment.patientId) return;
    let active = true;
    void (async () => {
      try {
        const patient = await withRequestTimeout((signal) =>
          api.GET("/api/v1/patients/{id}", {
            params: { path: { id: assessment.patientId } },
            signal,
          }),
        );
        const organizationId = (patient.data as { organizationId?: string } | undefined)
          ?.organizationId;
        if (!organizationId) return;
        const members = await withRequestTimeout((signal) =>
          api.GET("/api/v1/orgs/{id}/members", {
            params: { path: { id: organizationId }, query: { q: signerId } },
            signal,
          }),
        );
        const member = (
          members.data as
            | {
                members?: Array<{
                  membershipId: string;
                  displayName?: string | null;
                  email?: string | null;
                }>;
              }
            | undefined
        )?.members?.find((candidate) => candidate.membershipId === signerId);
        if (active && member) setSignerName(member.displayName ?? member.email ?? null);
      } catch {
        // The signer's name is a convenience beside the signature: without it the summary shows what it already shows.
      }
    })();
    return () => {
      active = false;
    };
  }, [api, assessment.patientId, signerId]);

  return (
    <div style={completedBox}>
      <span aria-hidden="true">✓</span>
      <span>
        Completed {formatInstant(assessment.signedAt)} · Signed by {signerName ?? "the MD"} · Z0500B{" "}
        {review?.z0500b ? formatDate(review.z0500b) : formatInstant(assessment.signedAt)}
      </span>
    </div>
  );
}

const SEX_LABEL: Record<string, string> = {
  M: "Male",
  F: "Female",
  male: "Male",
  female: "Female",
};
function sexLabel(code: string | null): string | null {
  if (!code) return null;
  return SEX_LABEL[code] ?? code.charAt(0).toUpperCase() + code.slice(1);
}

/** Section nav entry with an actionable status line ("2 required fields", not "Needs attention"). */
function navView(
  section: { id: SectionId; label: string },
  review: ReviewModel | null,
  workspace: Workspace,
  assessmentCompleted = false,
): NavSectionView {
  const title = section.id === "Review" ? "Review" : `${section.id}. ${section.label}`;
  const accessibleName = section.id === "Review" ? "Review" : `${section.id} ${section.label}`;
  if (section.id === "Review") {
    if (assessmentCompleted || review?.status === "signed") {
      return {
        id: section.id,
        title,
        accessibleName,
        state: "complete",
        statusLine: "Completed",
      };
    }
    const blockers = review?.readiness.blockers.length ?? 0;
    return {
      id: section.id,
      title,
      accessibleName,
      state: review?.readiness.readyToSign ? "complete" : blockers ? "attention" : "empty",
      statusLine: review?.readiness.readyToSign
        ? "Ready to sign"
        : blockers
          ? `${blockers} blocker${blockers === 1 ? "" : "s"}`
          : "Not started",
    };
  }
  const sec = review?.sections.find((s) => s.code === section.id);
  if (sec) {
    const done = sec.answered + sec.skipped;
    if (sec.state === "complete")
      return {
        id: section.id,
        title,
        accessibleName,
        state: "complete",
        statusLine: "Complete",
      };
    if (sec.errors > 0 || (done > 0 && sec.unanswered > 0 && sec.state === "needs_attention")) {
      const n = sec.unanswered || sec.errors;
      const what = sec.unanswered ? "required field" : "issue";
      return {
        id: section.id,
        title,
        accessibleName,
        state: "attention",
        statusLine: `${n} ${what}${n === 1 ? "" : "s"}`,
      };
    }
    if (done === 0)
      return {
        id: section.id,
        title,
        accessibleName,
        state: "empty",
        statusLine: "Not started",
      };
    return {
      id: section.id,
      title,
      accessibleName,
      state: "progress",
      statusLine: `${done} of ${sec.active} complete`,
    };
  }
  const state = sectionState(section.id, review, workspace);
  return {
    id: section.id,
    title,
    accessibleName,
    state: state.kind,
    statusLine: state.kind === "progress" ? state.detail : state.label,
  };
}

/** Right context rail: patient summary, the to-do list, items needing correction, quick links. */
function HopeRail({
  patient,
  patientExtra,
  patientId,
  review,
  todo,
  completed,
  onGoToTodo,
  onGoTo,
}: {
  patient: PatientSummary | null;
  patientExtra: PatientExtra;
  patientId: string;
  review: ReviewModel | null;
  todo: {
    section: Exclude<SectionId, "Review">;
    label: string;
    open: { item: WorkspaceItem; group: string }[];
  }[];
  completed: boolean;
  onGoToTodo: (section: Exclude<SectionId, "Review">, group: string, itemCode: string) => void;
  onGoTo: (section: SectionId, itemCode?: string | null) => void;
}): JSX.Element {
  const age = patient ? ageYears(patient.dob) : null;
  const openCount = todo.reduce((n, row) => n + row.open.length, 0);
  const firstOpen = todo[0]?.open[0];
  // "Needs correction": answered-but-wrong findings. Plain "unanswered" findings live in To do.
  const corrections = (review?.validation.findings ?? [])
    .filter((f) => !isMissingRequiredFinding(f))
    .filter(
      (f, i, all) => all.findIndex((o) => o.ruleId === f.ruleId && o.itemCode === f.itemCode) === i,
    );
  const links: { label: string; icon: GlyphName; to: string }[] = [
    { label: "View patient chart", icon: "user", to: `/patients/${patientId}` },
    {
      label: "Previous assessments",
      icon: "clipboard-check",
      to: `/patients/${patientId}/hope`,
    },
    {
      label: "Election & certification",
      icon: "file-check",
      to: `/patients/${patientId}/election-certification`,
    },
    {
      label: "Documents",
      icon: "file-text",
      to: `/patients/${patientId}/documents`,
    },
    {
      label: "Care plan",
      icon: "clipboard-list",
      to: `/patients/${patientId}/care-plan`,
    },
  ];
  return (
    <>
      <Panel
        title="Patient Summary"
        icon="users"
        action={<Link to={`/patients/${patientId}?view=demographics`}>Edit</Link>}
      >
        {patient ? (
          <InfoRows
            labelWidth="5.5rem"
            rows={[
              {
                label: "Name",
                value: `${patient.firstName} ${patient.lastName}`,
              },
              {
                label: "DOB",
                value: `${formatDate(patient.dob)}${age != null ? ` (${age}y)` : ""}`,
              },
              { label: "Sex", value: sexLabel(patientExtra.sex) ?? "—" },
              { label: "MRN", value: `...${patient.mrn.slice(-4)}` },
              {
                label: "Medicare",
                value: patientExtra.mbiTail ? `...${patientExtra.mbiTail}` : "—",
              },
              ...(patientExtra.medicaidOnChart
                ? [
                    {
                      label: "Medicaid",
                      value: `...${patientExtra.medicaidOnChart.value.slice(-4)}`,
                    },
                  ]
                : []),
              { label: "Address", value: patientExtra.address ?? "—" },
            ]}
          />
        ) : (
          <p style={muted}>Patient details unavailable.</p>
        )}
      </Panel>
      {completed ? null : (
        <Panel
          title={
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
              To do {openCount ? <CountBadge count={openCount} /> : null}
            </span>
          }
          icon="clipboard-check"
          flush
        >
          {openCount === 0 ? (
            <p style={{ ...muted, padding: "0 1.125rem 0.875rem" }}>
              Every required answer is in. Continue to Review &amp; sign.
            </p>
          ) : (
            <>
              {firstOpen && todo[0] ? (
                <div style={{ padding: "0 1.125rem 0.75rem" }}>
                  <Button
                    onClick={() =>
                      onGoToTodo(todo[0]!.section, firstOpen.group, firstOpen.item.itemCode)
                    }
                  >
                    Next missing answer
                    <Glyph name="arrow-right" size={16} />
                  </Button>
                </div>
              ) : null}
              <ul className="wx-rail-list">
                {todo.map((row) => (
                  <li key={row.section}>
                    <button
                      type="button"
                      className="wx-rail-alert wx-rail-todo"
                      onClick={() =>
                        onGoToTodo(row.section, row.open[0]!.group, row.open[0]!.item.itemCode)
                      }
                    >
                      <span style={{ flex: 1, minWidth: 0, fontSize: "0.8125rem" }}>
                        <strong>{row.label}</strong>
                      </span>
                      <span className="wx-rail-todo-count">{row.open.length} left</span>
                      <Glyph name="chevron-right" size={16} strokeWidth={1.75} />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      )}
      {corrections.length ? (
        <Panel
          title={
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
              Needs correction <CountBadge count={corrections.length} />
            </span>
          }
          icon="alert-circle"
          tone={corrections.some((c) => c.severity === "error") ? "danger" : "default"}
          flush
        >
          <ul className="wx-rail-list">
            {corrections.slice(0, 5).map((issue) => (
              <li key={`${issue.ruleId}:${issue.itemCode ?? ""}`}>
                <button
                  type="button"
                  className="wx-rail-alert wx-rail-todo"
                  onClick={() => onGoTo(asSection(issue.section), issue.itemCode)}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 9999,
                      flexShrink: 0,
                      background: issue.severity === "warning" ? t.warning : t.error,
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0, fontSize: "0.8125rem" }}>
                    {issue.itemCode ? <strong>{issue.itemCode} — </strong> : null}
                    {issue.message}
                  </span>
                  <Glyph name="chevron-right" size={16} strokeWidth={1.75} />
                </button>
              </li>
            ))}
            {corrections.length > 5 ? (
              <li>
                <button
                  type="button"
                  className="wx-rail-alert wx-rail-todo"
                  style={{ color: t.primary }}
                  onClick={() => onGoTo("Review")}
                >
                  View all {corrections.length} in Review
                </button>
              </li>
            ) : null}
          </ul>
        </Panel>
      ) : null}
      <Panel title="Quick Links" icon="link" flush>
        <ul className="wx-rail-links">
          {links.map((l) => (
            <li key={l.label}>
              <Link to={l.to}>
                <span style={{ color: t.primary }}>
                  <Glyph name={l.icon} size={17} strokeWidth={1.75} />
                </span>
                <span style={{ flex: 1 }}>{l.label}</span>
                <Glyph name="chevron-right" size={16} strokeWidth={1.75} />
              </Link>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

// Only an SFV record (RFA-04) lands here, and it is created already signed, so there is nothing to sign: the
// view is read-only and has no sign dialog (the one `signOpen` opens belongs to the workspace view).
function LegacyTimepointView({
  assessment,
  patient,
  timeline,
}: {
  assessment: AssessmentDetail;
  patient: PatientSummary | null;
  timeline: TimepointRow[];
}): JSX.Element {
  return (
    <PatientWorkspaceLayout
      banner={
        <PatientBanner
          name={patient ? `${patient.firstName} ${patient.lastName}` : "HOPE Assessment"}
        />
      }
    >
      <div style={shell}>
        <header style={topBar}>
          <div>
            <div style={eyebrow}>HOPE Timepoint</div>
            <h1 style={title}>{rfaLabel(assessment.rfaKind)}</h1>
            <p style={muted}>
              HUV and Discharge capture keep their existing workflow until their UI phase.
            </p>
          </div>
          <StatusPill label={stateLabel(assessment.status)} tone="neutral" />
        </header>
        <div style={questionGroup}>
          <h3 style={groupTitle}>Timeline</h3>
          {timeline.map((tp) => (
            <Link key={tp.id} to={`/hope/assessments/${tp.id}`} style={legacyLink}>
              {rfaLabel(tp.rfaKind)} · {formatTargetDate(tp.targetDate)}
            </Link>
          ))}
        </div>
      </div>
    </PatientWorkspaceLayout>
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
  return <span>{label[source]}</span>;
}

function workflowControlledMessage(item: WorkspaceItem): string {
  if (item.itemCode === "A0100A" || item.itemCode === "A0100B") {
    return "From Hospice Provider (Organization settings)";
  }
  if (item.itemCode === "A0050") {
    return "From record type (new, correction, or inactivation)";
  }
  if (item.itemCode === "A0220") {
    return "From assessment target date";
  }
  if (item.itemCode === "A0250") {
    return "From selected HOPE timepoint";
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
  lastSavedAt,
}: {
  state: SaveStatus;
  lastSavedAt: number | null;
}): JSX.Element {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const ago = (): string => {
    if (!lastSavedAt) return "just now";
    const min = Math.floor((Date.now() - lastSavedAt) / 60_000);
    return min < 1 ? "just now" : `${min} min ago`;
  };
  const label =
    state === "saving"
      ? "Saving..."
      : state === "saved"
        ? `Auto-saved ${ago()}`
        : state === "failed"
          ? "Save failed"
          : state === "unconfirmed"
            ? "Save not confirmed"
            : state === "conflict"
              ? "Reload needed"
              : state === "reloaded"
                ? "Reloaded"
                : "Auto-save on";
  return (
    <span style={saveState(state)} aria-live="polite">
      {label}
    </span>
  );
}

function ConflictBanner({
  reloaded,
  onReload,
}: {
  reloaded: boolean;
  onReload: () => void;
}): JSX.Element {
  if (reloaded)
    return (
      <div style={conflictBanner}>
        <span>
          This assessment changed elsewhere and has been reloaded with the latest version. Review
          it, then repeat your change.
        </span>
      </div>
    );
  return (
    <div style={conflictBanner}>
      <span>{CONFLICT_FIELD_ERROR}</span>
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
  const activeCodes = new Set(workspace.sections.map((section) => section.code));
  const visible = SECTION_ORDER.filter(
    (section) => section.id === "Review" || activeCodes.has(section.id),
  );
  return visible.length ? visible : SECTION_ORDER.filter((section) => section.id === "Review");
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
  const answered = raw?.items.filter((i) => i.state !== "unanswered").length ?? 0;
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
  if (assessment.status === "signed") return { label: "Completed", tone: "success" };
  if (review?.readiness.readyToSign) return { label: "Ready to sign", tone: "success" };
  if ((review?.validation.errorCount ?? 0) > 0 || (review?.readiness.blockers.length ?? 0) > 0)
    return { label: "Needs attention", tone: "critical" };
  if (workspace.progress.answered > 0 || workspace.progress.skipped > 0)
    return { label: "In progress", tone: "progress" };
  return { label: "Not started", tone: "neutral" };
}

function groupSectionA(items: WorkspaceItem[]): { label: string; items: WorkspaceItem[] }[] {
  const used = new Set<string>();
  const groups = SECTION_A_GROUPS.map((group) => {
    const rows = items.filter((item) => group.match(item));
    for (const item of rows) used.add(item.itemCode);
    return { label: group.label, items: rows };
  }).filter((group) => group.items.length > 0);
  const other = items.filter((item) => !used.has(item.itemCode));
  if (other.length) groups.push({ label: "Other Administrative Items", items: other });
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
  if (itemCode.startsWith("J203") || itemCode.startsWith("J204")) return "Shortness of breath";
  if (itemCode.startsWith("J2050") || itemCode.startsWith("J2051")) return "Symptom impact";
  if (itemCode.startsWith("J2052") || itemCode.startsWith("J2053"))
    return "Symptom Follow-Up Visit";
  return "Other Health Conditions";
}

function asSection(value: string): SectionId {
  return SECTION_ORDER.some((section) => section.id === value) ? (value as SectionId) : "Review";
}

function maskCoverageIdentifier(value: string | null | undefined): string {
  if (!value) {
    return "Not recorded";
  }

  const normalized = value.trim();

  if (normalized === "^" || normalized === "+" || normalized === "N") {
    return normalized;
  }

  if (normalized.length <= 4) {
    return normalized;
  }

  return `••••${normalized.slice(-4)}`;
}

function saveState(state: string): CSSProperties {
  return {
    color:
      state === "failed" || state === "unconfirmed" || state === "conflict"
        ? t.error
        : state === "saving"
          ? t.primary
          : t.muted,
    fontSize: "0.8rem",
    fontWeight: 600,
  };
}

function issueRow(severity: "error" | "warning"): CSSProperties {
  const tone = severity === "warning" ? t.warning : t.error;
  return {
    ...reviewRow,
    border: `1px solid ${tone}`,
    background: `color-mix(in srgb, ${tone} 12%, ${t.surfaceLowest})`,
    color: t.onSurface,
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
  fontWeight: 500,
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
const questionCard: CSSProperties = {
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 8,
  padding: "0.9rem",
  background: t.surfaceLow,
};
const reviewSubsectionHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
  marginBottom: "0.9rem",
};

const payerReviewList: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.55rem",
};

const payerReviewRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.75rem",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 8,
  background: t.surfaceLow,
  color: t.onSurface,
};

const payerReviewIdentity: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.65rem",
  minWidth: 0,
};

const payerReviewCheck: CSSProperties = {
  display: "grid",
  flex: "0 0 auto",
  placeItems: "center",
  width: 26,
  height: 26,
  borderRadius: 999,
  background: `color-mix(in srgb, ${t.success} 12%, ${t.surface})`,
  color: t.success,
  fontSize: "0.78rem",
  fontWeight: 800,
};

const payerReviewLabel: CSSProperties = {
  color: t.onSurface,
  fontSize: "0.88rem",
  lineHeight: 1.35,
};

const payerReviewEmpty: CSSProperties = {
  padding: "0.8rem",
  border: `1px dashed ${t.outline}`,
  borderRadius: 8,
  background: t.surfaceLow,
  color: t.muted,
  fontSize: "0.85rem",
};

const payerIdentifierGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "0.65rem",
  marginTop: "0.8rem",
};

const payerIdentifierCard: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  gap: "0.25rem 0.75rem",
  padding: "0.75rem",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 8,
  background: t.surface,
  color: t.onSurface,
};

const payerIdentifierLabel: CSSProperties = {
  gridColumn: "1 / -1",
  color: t.muted,
  fontSize: "0.75rem",
  fontWeight: 650,
};

const payerIdentifierValue: CSSProperties = {
  color: t.onSurface,
  fontSize: "0.9rem",
  fontWeight: 700,
};

const codePill: CSSProperties = {
  fontSize: "0.72rem",
  color: t.muted,
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 6,
  padding: "0.1rem 0.3rem",
  whiteSpace: "nowrap",
};
const completedBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  padding: "0.75rem 1.25rem",
  borderBottom: `1px solid ${t.outlineVariant}`,
  color: t.success,
  background: "color-mix(in srgb, var(--color-success) 10%, var(--color-surface-lowest))",
};
const conflictBanner: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1rem",
  padding: "0.75rem 1.25rem",
  borderBottom: `1px solid ${t.warning}`,
  color: t.onSurface,
  background: "color-mix(in srgb, var(--color-warning) 10%, var(--color-surface-lowest))",
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
const inlineEditor: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
};
const legacyLink: CSSProperties = {
  display: "block",
  padding: "0.5rem 0",
  color: t.primary,
};
const mobileSectionSelect: CSSProperties = {
  display: "none",
  width: "100%",
  marginBottom: "0.75rem",
  ...inputStyle,
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
const reviewGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: "0.6rem",
  marginBottom: "1rem",
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
  background: "color-mix(in srgb, var(--color-success) 10%, var(--color-surface-lowest))",
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
const warningText: CSSProperties = {
  marginTop: "0.45rem",
  color: t.warning,
  fontSize: "0.82rem",
  lineHeight: 1.35,
};
const completionDateErrorText: CSSProperties = {
  margin: "0.45rem 0 0",
  color: t.error,
  fontSize: "0.82rem",
  lineHeight: 1.35,
};
