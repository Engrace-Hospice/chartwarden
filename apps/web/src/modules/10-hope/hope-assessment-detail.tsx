import { normalizeSsn, ssnCmsProblem } from "@wardenx/types";
import {
  Button,
  CountBadge,
  EmptyState,
  Glyph,
  type GlyphName,
  InfoRows,
  LoadingSpinner,
  Panel,
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
import {
  type ChartNumber,
  type ChartPayer,
  ChartReconcileDialog,
  type ReconcileItem,
} from "./hope-chart-reconcile";
import { ASSESSMENT_TONE, rfaLabel, stateLabel } from "./hope-status";
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
type SfvError = {
  type: "permission" | "validation" | "conflict" | "generic";
  title: string;
  message: string;
};

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
}

type ChartNumbers = Pick<PatientExtra, "medicareOnChart" | "medicaidOnChart" | "payers">;

/** Reads the chart's identifiers + coverage and resolves the Medicare / Medicaid numbers. */
async function fetchChartNumbers(api: HopeApiCompat, patientId: string): Promise<ChartNumbers> {
  const [ids, pay] = await Promise.all([
    api.GET("/api/v1/patients/{id}/identifiers", { params: { path: { id: patientId } } }),
    api.GET("/api/v1/patients/{id}/payers", { params: { path: { id: patientId } } }),
  ]);
  const identifiers =
    (
      ids.data as
        | { identifiers?: { kind: string; value: string | null; effectiveTo?: string | null }[] }
        | undefined
    )?.identifiers ?? [];
  const payers = (pay.data as { payers?: ChartPayer[] } | undefined)?.payers ?? [];
  return {
    medicareOnChart: chartMedicareNumber(
      identifiers,
      payers,
      new Date().toISOString().slice(0, 10),
    ),
    medicaidOnChart: chartMedicaidNumber(payers),
    payers,
  };
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

type NavMode = "guided" | "all";
const NAV_MODE_KEY = "wx.hope.navMode";
const VISITED_KEY = "wx.hope.visitedGroups";

/**
 * Scrolls the workspace pane — not the window — so the app shell (top bar, banner) never shifts.
 * `scrollIntoView` scrolls every scrollable ancestor, including the document.
 */
function scrollWithinWorkspace(element: HTMLElement, block: "start" | "center"): void {
  const pane = element.closest<HTMLElement>(".wx-patient-workspace-body");
  if (!pane) {
    element.scrollIntoView({ behavior: "smooth", block });
    return;
  }
  const paneRect = pane.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const offset =
    block === "start"
      ? rect.top - paneRect.top - 72 // clear the sticky jump bar
      : rect.top - paneRect.top - (paneRect.height - rect.height) / 2;
  pane.scrollTo({ top: pane.scrollTop + offset, behavior: "smooth" });
}

// GAP-191: the nav-mode preference is a harmless UI setting (localStorage). Anything keyed by a
// record id (the visited groups per assessment) lives in sessionStorage so it dies with the tab
// instead of outliving sign-out on a shared workstation.
type StorageKind = "local" | "session";

function storageFor(kind: StorageKind): Storage {
  return kind === "session" ? window.sessionStorage : window.localStorage;
}

function readStorage(key: string, kind: StorageKind = "local"): string | null {
  try {
    return storageFor(kind).getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string, kind: StorageKind = "local"): void {
  try {
    storageFor(kind).setItem(key, value);
  } catch {
    // Storage unavailable (private mode): the preference just doesn't persist.
  }
}

function readNavMode(): NavMode {
  return readStorage(NAV_MODE_KEY) === "all" ? "all" : "guided";
}

function readVisited(assessmentId: string | undefined): Set<string> {
  if (!assessmentId) return new Set();
  try {
    const parsed: unknown = JSON.parse(readStorage(`${VISITED_KEY}.${assessmentId}`, "session") ?? "[]");
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
  const [patientExtra, setPatientExtra] = useState<PatientExtra>({
    sex: null,
    mbiTail: null,
    medicareOnChart: null,
    medicaidOnChart: null,
    payers: [],
    address: null,
  });
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>("A");
  const [sfvOpen, setSfvOpen] = useState(false);
  const [sfvReviewOpen, setSfvReviewOpen] = useState(false);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "failed" | "conflict">("idle");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signOpen, setSignOpen] = useState(false);
  const [inactivationOpen, setInactivationOpen] = useState(false);
  const [inactivating, setInactivating] = useState(false);
  // #91 (restored) — the §5.2 "Request summary" action: emits `m10.hope.summary_requested`; M22 renders.
  const [summaryState, setSummaryState] = useState<"idle" | "requesting" | "requested" | "failed">(
    "idle",
  );
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
  // Show-all mode: the group currently at the top of the viewport (scroll-spy).
  const [spy, setSpy] = useState<{ section: string; group: string } | null>(null);
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);

  useEffect(() => {
    if (workspace) latestVersionRef.current = workspace.assessment.version;
  }, [workspace]);

  useEffect(() => {
    if (!pendingItemFocus) {
      return;
    }

    const timeout = window.setTimeout(() => {
      // Checkbox tiles are anchored by their 5-char stem ("hope-item-A1005"), not the item code.
      const element =
        document.getElementById(`hope-item-${pendingItemFocus}`) ??
        document.getElementById(`hope-item-${pendingItemFocus.slice(0, 5)}`);

      if (!element) {
        return;
      }

      scrollWithinWorkspace(element, "center");

      if (element instanceof HTMLElement) {
        element.focus({
          preventScroll: true,
        });
      }

      setPendingItemFocus(null);
    }, 50);

    return () => window.clearTimeout(timeout);
    // pendingItemFocus alone is the trigger: the issue-link handler sets it in the same batched
    // update as activeSection, so the target section is already committed when the timer fires.
  }, [pendingItemFocus]);
  // A new section starts at its top (unless an issue link is about to scroll to a specific item).
  const workspaceRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: section/group changes are the intentional trigger.
  useEffect(() => {
    if (pendingItemFocus || pendingScroll) return;
    if (navMode === "all" && activeSection !== "Review") return;
    workspaceRef.current?.closest(".wx-patient-workspace-body")?.scrollTo({ top: 0 });
  }, [activeSection, groupBySection, navMode]);

  // Show-all: jump to a section/group once it is rendered.
  useEffect(() => {
    if (!pendingScroll) return;
    const timeout = window.setTimeout(() => {
      const target = document.getElementById(pendingScroll);
      if (target) scrollWithinWorkspace(target, "start");
      setPendingScroll(null);
    }, 30);
    return () => window.clearTimeout(timeout);
  }, [pendingScroll]);

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

  // Show-all scroll-spy: track the topmost visible group; groups scrolled past count as visited.
  useEffect(() => {
    if (navMode !== "all" || activeSection === "Review" || !workspace) return;
    const root = workspaceRef.current?.closest(".wx-patient-workspace-body") ?? null;
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-hope-group]"));
    if (!nodes.length || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<HTMLElement>();
    let last: string | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          if (entry.isIntersecting) visible.add(el);
          else visible.delete(el);
        }
        const top = nodes.find((node) => visible.has(node));
        const value = top?.dataset.hopeGroup;
        // Passing a group while scrolling does not count as visiting it: marking it would insert
        // error text above the scroll target mid-scroll and push the target down.
        if (!value || value === last) return;
        last = value;
        const [section, group] = value.split(":");
        setSpy({ section: section ?? "", group: group ?? "" });
      },
      { root, rootMargin: "-120px 0px -55% 0px" },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [activeSection, navMode, workspace]);
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
    setTimeline((tl.data as { assessments?: TimepointRow[] } | undefined)?.assessments ?? []);
    if (pat.data) setPatient(pat.data as unknown as PatientSummary);
    setLoading(false);
    // Banner + Patient Summary context — best-effort; a failure only blanks those fields.
    const pid = nextAssessment.patientId;
    const [demo, addrs, chartNumbers] = await Promise.all([
      api.GET("/api/v1/patients/{id}/demographics", {
        params: { path: { id: pid } },
      }),
      api.GET("/api/v1/patients/{id}/addresses", {
        params: { path: { id: pid } },
      }),
      fetchChartNumbers(api, pid),
    ]);
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
    setPatientExtra({
      sex: (demo.data as { sexAssignedAtBirth?: string } | undefined)?.sexAssignedAtBirth ?? null,
      mbiTail: chartNumbers.medicareOnChart?.value.slice(-4) ?? null,
      ...chartNumbers,
      address: home
        ? `${home.line1}, ${home.city}${home.state ? `, ${home.state}` : ""} ${home.postalCode}`
        : null,
    });
  }, [api, id]);

  // After a reconcile writes to the chart: re-read just the chart numbers (no page reload).
  const refreshChartNumbers = useCallback(async () => {
    if (!assessment) return;
    const chartNumbers = await fetchChartNumbers(api, assessment.patientId);
    setPatientExtra((prev) => ({
      ...prev,
      ...chartNumbers,
      mbiTail: chartNumbers.medicareOnChart?.value.slice(-4) ?? null,
    }));
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
      map.set(finding.itemCode, [...(map.get(finding.itemCode) ?? []), finding]);
    }
    return map;
  }, [review]);

  const saveAnswer = useCallback(
    async (
      item: WorkspaceItem | readonly WorkspaceItem[],
      value: AnswerValue | null | ReadonlyMap<string, AnswerValue>,
    ) => {
      const items = Array.isArray(item) ? item : [item];
      const primary = items[0];
      if (
        !id ||
        !workspace ||
        assessment?.status !== "draft" ||
        !primary ||
        items.some((candidate) => PROTECTED_ITEMS.has(candidate.itemCode))
      )
        return;
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
      const run = async () => {
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
        const res = await api.PATCH("/api/v1/hope/assessments/{id}/answers", {
          params: { path: { id } },
          body: {
            ifVersion: latestVersionRef.current ?? workspace.assessment.version,
            changes,
          },
        });
        if (res.error || !res.data) {
          const message = String((res.error as { message?: unknown })?.message ?? "");
          const conflict = /version|conflict|stale/i.test(message);
          setSaving(conflict ? "conflict" : "failed");
          setFieldErrors((prev) => ({
            ...prev,
            [primary.itemCode]: conflict
              ? "This assessment changed elsewhere. Reload the latest version before continuing."
              : "This answer was not saved. Check the value and try again.",
          }));
          if (items.some((candidate) => candidate.itemCode.startsWith("A1400")))
            await refreshWorkspaceOnly();
          return;
        }
        latestVersionRef.current =
          (res.data as { version?: number }).version ?? latestVersionRef.current;
        setSaving("saved");
        setLastSavedAt(Date.now());
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
      const res = await api.PATCH("/api/v1/hope/assessments/{id}/huv/completion-date", {
        params: { path: { id } },
        body: { ifVersion: workspace.assessment.version, z0350 },
      });
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

  // A signed record with a correction already in progress: open that draft instead of a second one
  // (the server refuses a second pending correction with 409).
  const openCorrectionId =
    assessment?.status === "signed"
      ? (timeline.find((t) => t.correctsAssessmentId === id && t.status === "draft")?.id ?? null)
      : null;
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const createCorrection = useCallback(async () => {
    if (!id || !assessment) return;
    setCorrectionError(null);
    if (openCorrectionId) {
      navigate(`/hope/assessments/${openCorrectionId}`);
      return;
    }
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
    if (correctionId) {
      navigate(`/hope/assessments/${correctionId}`);
      return;
    }
    // Another session may have started one: look it up before reporting the failure.
    const tl = await api.GET("/api/v1/patients/{patientId}/hope/assessments", {
      params: { path: { patientId: assessment.patientId } },
    });
    const rows = (tl.data as { assessments?: TimepointRow[] } | undefined)?.assessments ?? [];
    setTimeline(rows);
    const existing = rows.find((t) => t.correctsAssessmentId === id && t.status === "draft");
    if (existing) navigate(`/hope/assessments/${existing.id}`);
    else
      setCorrectionError(
        (res.error as { error?: { message?: string } } | undefined)?.error?.message ??
          "The correction could not be created.",
      );
  }, [api, assessment, id, navigate, openCorrectionId]);

  const requestSummary = useCallback(async () => {
    if (!id) return;
    setSummaryState("requesting");
    const res = await api.POST("/api/v1/hope/assessments/{id}/summary-pdf", {
      params: { path: { id } },
    });
    setSummaryState(res.error ? "failed" : "requested");
  }, [api, id]);

  const createInactivation = useCallback(
    async (reason: string) => {
      if (!id || !assessment) return;
      setInactivating(true);
      const res = await api.POST("/api/v1/hope/assessments/{id}/inactivations", {
        params: { path: { id } },
        body: { reason: reason.trim(), ifVersion: assessment.version },
      });
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
  if (loading || !assessment) return <LoadingSpinner label="Loading HOPE workspace..." />;
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
            {formatDate(assessment.targetDate)}
          </span>
        </span>
      }
    />
  ) : (
    <PatientBanner name={recordLabel} meta={`Target ${formatDate(assessment.targetDate)}`} />
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
      onCompleteSfv={() => setSfvOpen(true)}
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
                  <input
                    type="checkbox"
                    role="switch"
                    checked={navMode === "all"}
                    aria-checked={navMode === "all"}
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
                    <Button onClick={() => void createCorrection()}>
                      {openCorrectionId ? "Open correction draft" : "Create correction"}
                    </Button>
                    {correctionError ? (
                      <p role="alert" className="wx-hope-action-error">
                        {correctionError}
                      </p>
                    ) : null}
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
          {workspace.huv ? <HuvTimingBanner workspace={workspace} review={review} /> : null}
          {saving === "conflict" ? <ConflictBanner onReload={() => void load()} /> : null}

          {activeSection === "Review" ? (
            <ReviewPanel
              assessment={assessment}
              review={review}
              workspace={workspace}
              onGoTo={goToIssue}
              visibleSections={visibleSections}
              onSetCompletionDate={(value) => void setHuvCompletionDate(value)}
              completionDateSaving={completionDateSaving}
              onSign={() => setSignOpen(true)}
              onCorrection={() => void createCorrection()}
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
                    void createCorrection();
                  },
                }
              : null
          }
          onUseChart={async (value) => {
            const item = sections.get("A")?.items.find((i) => i.itemCode === reconcile.itemCode);
            if (item) await saveAnswer(item, value);
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
          items={
            workspace.sections
              .find((section) => section.code === "J")
              ?.items.filter((item) => item.itemCode.startsWith("J2053")) ?? []
          }
          onCancel={() => setSfvOpen(false)}
          onCompleted={async () => {
            setSfvOpen(false);

            await refreshWorkspaceOnly();
          }}
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

const SFV_SEVERITY = [
  { value: "0", label: "None" },
  { value: "1", label: "Mild" },
  { value: "2", label: "Moderate" },
  { value: "3", label: "Severe" },
] as const;

function CompleteSfvDialog({
  assessment,
  api,
  items,
  onCancel,
  onCompleted,
}: {
  assessment: AssessmentDetail;
  api: HopeApiCompat;
  items: WorkspaceItem[];
  onCancel: () => void;
  onCompleted: () => Promise<void>;
}): JSX.Element {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  const [discipline, setDiscipline] = useState<"RN" | "NP">("RN");

  const [answers, setAnswers] = useState<Record<string, string>>({});

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sfvError, setSfvError] = useState<SfvError | null>(null);

  const sfvQuestions = items.filter((item) => /^J2053[A-H]$/.test(item.itemCode));

  const codes = sfvQuestions.map((item) => item.itemCode);

  const completedCount = codes.filter((code) => Boolean(answers[code])).length;

  const canSubmit =
    Boolean(assessment.admissionId) && date !== "" && completedCount === codes.length;

  // Same navigation as the workspace: one question at a time, or "Show all" (shared preference).
  const [showAll, setShowAll] = useState(() => readNavMode() === "all");
  const [step, setStep] = useState(0);
  const stepTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (stepTimer.current) window.clearTimeout(stepTimer.current);
    },
    [],
  );
  const answer = (itemCode: string, value: string, index: number) => {
    setAnswers((previous) => ({ ...previous, [itemCode]: value }));
    if (showAll || index >= sfvQuestions.length - 1) return;
    // Brief pause so the choice is seen, then move to the next question.
    if (stepTimer.current) window.clearTimeout(stepTimer.current);
    stepTimer.current = window.setTimeout(() => setStep(index + 1), 250);
  };
  const visibleQuestions = showAll
    ? sfvQuestions.map((item, index) => ({ item, index }))
    : sfvQuestions[step]
      ? [{ item: sfvQuestions[step]!, index: step }]
      : [];

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
      const apiError = res.error as {
        error?: {
          code?: string;
          message?: string;
          details?: Array<{
            field?: string;
            code?: string;
            message?: string;
          }>;
        };
      };

      const code = apiError.error?.code;
      const message = apiError.error?.message;

      if (
        code === "FORBIDDEN" ||
        code === "PERMISSION_DENIED" ||
        code === "INSUFFICIENT_PERMISSIONS"
      ) {
        setSfvError({
          type: "permission",
          title: "You don't have permission to complete this SFV",
          message:
            message ?? "Your current role does not allow you to record a Symptom Follow-Up Visit.",
        });
        return;
      }

      if (code === "VALIDATION_FAILED") {
        setSfvError({
          type: "validation",
          title: "Some information needs attention",
          message:
            apiError.error?.details?.[0]?.message ??
            message ??
            "Review the SFV information and try again.",
        });
        return;
      }

      if (code === "CONFLICT") {
        setSfvError({
          type: "conflict",
          title: "The SFV could not be completed",
          message: message ?? "The assessment has changed. Refresh the assessment and try again.",
        });
        return;
      }

      setSfvError({
        type: "generic",
        title: "Unable to complete SFV",
        message: message ?? "Something went wrong while completing the SFV. Please try again.",
      });

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
      <dialog open style={sfvModal} aria-modal="true" aria-labelledby="sfv-dialog-title">
        <header style={sfvModalHeader}>
          <div style={sfvModalHeaderText}>
            <div style={sfvModalEyebrow}>Symptom Follow-Up Visit</div>

            <h2 id="sfv-dialog-title" style={sfvModalTitle}>
              Complete SFV
            </h2>

            <p style={sfvModalDescription}>
              Record the visit details and complete the symptom impact reassessment.
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
                  onChange={(event) => setDiscipline(event.target.value as "RN" | "NP")}
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
                  Complete each required J2053 item based on the follow-up visit.
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

            <div className="wx-sfv-toolbar">
              {!showAll ? (
                <ol className="wx-sfv-steps" aria-label="Reassessment questions">
                  {sfvQuestions.map((item, index) => {
                    const done = Boolean(answers[item.itemCode]);
                    const isActive = index === step;
                    return (
                      <li key={item.itemCode}>
                        <button
                          type="button"
                          className={isActive ? "active" : done ? "done" : undefined}
                          aria-current={isActive ? "step" : undefined}
                          aria-label={`${item.itemCode}${done ? " — answered" : ""}`}
                          onClick={() => setStep(index)}
                        >
                          {done && !isActive ? "✓" : index + 1}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <span />
              )}
              <label className="wx-hope-mode-toggle">
                <input
                  type="checkbox"
                  role="switch"
                  checked={showAll}
                  aria-checked={showAll}
                  onChange={(event) => {
                    const next = event.currentTarget.checked;
                    setShowAll(next);
                    writeStorage(NAV_MODE_KEY, next ? "all" : "guided");
                  }}
                />
                <span className="wx-hope-mode-track" aria-hidden />
                Show all
              </label>
            </div>

            <div className={showAll ? "wx-sfv-questions all" : "wx-sfv-questions"}>
              {visibleQuestions.map(({ item, index }) => {
                const value = answers[item.itemCode] ?? "";
                return (
                  <fieldset
                    key={item.itemCode}
                    className={value ? "wx-sfv-question answered" : "wx-sfv-question"}
                    disabled={saving}
                  >
                    <legend>
                      <span style={sfvAnswerNumber}>{index + 1}</span>
                      <strong style={sfvQuestionText}>{item.label}</strong>
                      <CmsCode code={item.itemCode} />
                    </legend>
                    <div className="wx-sfv-severity">
                      {SFV_SEVERITY.map((option) => (
                        <label
                          key={option.value}
                          className={
                            value === option.value ? "wx-option-row checked" : "wx-option-row"
                          }
                        >
                          <input
                            type="radio"
                            name={`sfv-${item.itemCode}`}
                            value={option.value}
                            checked={value === option.value}
                            onChange={() => answer(item.itemCode, option.value, index)}
                          />
                          <span>{option.label}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                );
              })}
            </div>
            {!showAll ? (
              <div className="wx-sfv-stepnav">
                <button
                  type="button"
                  style={secondaryButton}
                  disabled={step === 0}
                  onClick={() => setStep((n) => Math.max(0, n - 1))}
                >
                  ← Previous question
                </button>
                <span>
                  Question {step + 1} of {sfvQuestions.length}
                </span>
                <button
                  type="button"
                  style={secondaryButton}
                  disabled={step >= sfvQuestions.length - 1}
                  onClick={() => setStep((n) => Math.min(sfvQuestions.length - 1, n + 1))}
                >
                  Next question →
                </button>
              </div>
            ) : null}
          </section>

          {sfvError ? (
            <div
              style={{
                ...sfvErrorBox,
                ...(sfvError.type === "permission" ? sfvPermissionErrorBox : null),
              }}
              role="alert"
            >
              <strong
                style={{
                  color: sfvError.type === "permission" ? t.warning : t.error,
                }}
              >
                {sfvError.title}
              </strong>
              <span>{sfvError.message}</span>
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
            <button type="button" style={secondaryButton} disabled={saving} onClick={onCancel}>
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

function ReviewSfvDialog({
  items,
  onClose,
}: {
  items: WorkspaceItem[];
  onClose: () => void;
}): JSX.Element {
  const completedDate = items.find((item) => item.itemCode === "J2052B")?.value;

  const questions = items.filter((item) => /^J2053[A-H]$/.test(item.itemCode));

  return (
    <div
      style={sfvModalBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <dialog open style={sfvModal} aria-modal="true" aria-labelledby="sfv-review-dialog-title">
        <header style={sfvModalHeader}>
          <div style={sfvModalHeaderText}>
            <div style={sfvModalEyebrow}>Symptom Follow-Up Visit</div>

            <h2 id="sfv-review-dialog-title" style={sfvModalTitle}>
              SFV details
            </h2>

            <p style={sfvModalDescription}>Review the completed symptom follow-up visit.</p>
          </div>

          <button type="button" aria-label="Close" style={sfvCloseButton} onClick={onClose}>
            ×
          </button>
        </header>

        <div style={sfvModalBody}>
          <section style={sfvSection}>
            <div style={sfvSectionHeader}>
              <div>
                <h3 style={sfvSectionTitle}>Visit details</h3>

                <p style={sfvSectionDescription}>Recorded information for this completed SFV.</p>
              </div>

              <StatusPill label="Completed" tone="success" />
            </div>

            <div style={sfvDetailsGrid}>
              <div style={sfvField}>
                <span style={sfvFieldLabel}>SFV date</span>

                <div style={sfvReadonlyAnswer}>
                  {completedDate ? formatDate(String(completedDate)) : "—"}
                </div>
              </div>

              <div style={sfvField}>
                <span style={sfvFieldLabel}>Status</span>

                <div style={sfvReadonlyAnswer}>Completed</div>
              </div>
            </div>
          </section>

          <section style={sfvSection}>
            <div style={sfvSectionHeader}>
              <div>
                <h3 style={sfvSectionTitle}>Symptom impact reassessment</h3>

                <p style={sfvSectionDescription}>Responses recorded during the follow-up visit.</p>
              </div>
            </div>

            <div style={sfvAnswersGrid}>
              {questions.map((item, index) => {
                const value = String(item.value ?? "");

                const option = item.options.find((row) => row.valueCode === value);

                return (
                  <div key={item.itemCode} style={sfvAnswerCard}>
                    <div style={sfvAnswerCardHeader}>
                      <span style={sfvAnswerNumber}>{index + 1}</span>

                      <div style={sfvQuestionContent}>
                        <strong style={sfvQuestionText}>{item.label}</strong>
                      </div>
                      <CmsCode code={item.itemCode} />
                    </div>

                    <div style={sfvReadonlyAnswer}>{option?.label || value || "—"}</div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <footer style={sfvModalFooter}>
          <div />

          <div style={sfvFooterActions}>
            <button type="button" style={secondaryButton} onClick={onClose}>
              Close
            </button>
          </div>
        </footer>
      </dialog>
    </div>
  );
}

type SaveFn = (
  item: WorkspaceItem | readonly WorkspaceItem[],
  value: AnswerValue | null | ReadonlyMap<string, AnswerValue>,
) => Promise<void>;
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
          readonly={props.readonly}
          onComplete={props.onCompleteSfv}
          onReview={props.onReviewSfv}
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

function SfvWorkflowSection({
  items,
  readonly,
  onComplete,
  onReview,
}: {
  items: WorkspaceItem[];
  readonly: boolean;
  onComplete?: () => void;
  onReview?: () => void;
}): JSX.Element {
  const j2052a = items.find((item) => item.itemCode === "J2052A");
  const completed = String(j2052a?.value ?? "") === "1";
  const required = j2052a?.applicability === "applicable";
  return (
    <ClinicalSection
      id="hope-item-J2052A"
      icon="calendar-check"
      title="Symptom Follow-Up Visit"
      description={
        completed
          ? "The follow-up visit has been recorded by the SFV workflow."
          : required
            ? "A moderate or severe symptom impact requires a follow-up visit."
            : "The need for a follow-up visit is determined from the symptom impact assessment."
      }
      aside={
        <StatusPill
          label={completed ? "Completed" : required ? "Required" : "Pending"}
          tone={completed ? "success" : required ? "warning" : "neutral"}
        />
      }
    >
      {completed ? (
        <p style={muted}>
          J2052 and J2053 are workflow-controlled and were populated from the completed SFV.
        </p>
      ) : null}
      {completed || (!readonly && required) ? (
        <div style={actionRow}>
          {completed ? (
            <Button tone="secondary" onClick={onReview}>
              View SFV details
            </Button>
          ) : (
            <Button onClick={onComplete}>Complete SFV</Button>
          )}
        </div>
      ) : null}
    </ClinicalSection>
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
        {sfv?.dueAt ? <span>Due {formatDate(sfv.dueAt)}</span> : null}
        {sfv?.completedAt ? <span>Completed {formatDate(sfv.completedAt)}</span> : null}
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
          Recommended completion window {formatDate(workspace.huv.windowStart)} -{" "}
          {formatDate(workspace.huv.windowEnd)}
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
            disabled={props.readonly || props.saving || !draft || draft === value}
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
      <dialog style={modal} open aria-modal="true" aria-labelledby="hope-sign-title">
        <h2 id="hope-sign-title" style={modalTitle}>
          {props.title}
        </h2>
        <p style={muted}>
          By signing, you confirm this HOPE record is complete. After signing, it becomes read-only.
        </p>
        <div style={modalStats}>
          <span>Warnings: {props.review?.validation.warningCount ?? 0}</span>
          <span>Errors: {props.review?.validation.errorCount ?? 0}</span>
        </div>
        <div style={actionRow}>
          <button type="button" style={secondaryButton} onClick={props.onCancel}>
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
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = reason.trim();
  // Move focus into the dialog when it opens (in place of the `autoFocus` attribute).
  useEffect(() => {
    reasonRef.current?.focus();
  }, []);
  return (
    <div style={modalBackdrop} role="presentation">
      <dialog style={modal} open aria-modal="true" aria-labelledby="hope-inactivation-title">
        <h2 id="hope-inactivation-title" style={modalTitle}>
          Inactivate {props.recordLabel}
        </h2>
        <p style={muted}>
          This creates a CMS inactivation draft for the selected signed record. The original remains
          current until the inactivation draft is signed.
        </p>
        <label style={fieldLabel}>
          Reason
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={4}
            maxLength={2000}
            style={textareaField}
            ref={reasonRef}
          />
        </label>
        <div style={actionRow}>
          <button type="button" style={secondaryButton} onClick={props.onCancel}>
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
      const patient = await api.GET("/api/v1/patients/{id}", {
        params: { path: { id: assessment.patientId } },
      });
      const organizationId = (patient.data as { organizationId?: string } | undefined)
        ?.organizationId;
      if (!organizationId) return;
      const members = await api.GET("/api/v1/orgs/{id}/members", {
        params: { path: { id: organizationId }, query: { q: signerId } },
      });
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
    })();
    return () => {
      active = false;
    };
  }, [api, assessment.patientId, signerId]);

  return (
    <div style={completedBox}>
      <span aria-hidden="true">✓</span>
      <span>
        Completed {formatDate(assessment.signedAt)} · Signed by {signerName ?? "the MD"} · Z0500B{" "}
        {formatDate(review?.z0500b ?? assessment.signedAt)}
      </span>
    </div>
  );
}

function disciplineForCorrection(value: string): "RN" | "NP" | "MD" {
  return value === "NP" || value === "MD" ? value : "RN";
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
            <Link key={tp.id} to={`/hope/assessments/${tp.id}`} style={legacyLink}>
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
  state: "idle" | "saving" | "saved" | "failed" | "conflict";
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
          : state === "conflict"
            ? "Reload needed"
            : "Auto-save on";
  return (
    <span style={saveState(state)} aria-live="polite">
      {label}
    </span>
  );
}

function ConflictBanner({ onReload }: { onReload: () => void }): JSX.Element {
  return (
    <div style={conflictBanner}>
      <span>This assessment changed elsewhere. Reload the latest version before continuing.</span>
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

function formatDate(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = value.slice(0, 10);
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return value;
  // A calendar date built at UTC midnight must also be FORMATTED in UTC — formatting it in the
  // viewer's zone showed the day before everywhere west of Greenwich (DOB, target date).
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function maskIdentifier(value: string | null | undefined): string {
  if (!value) return "MRN not recorded";
  return value.length <= 4 ? value : `MRN ...${value.slice(-4)}`;
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

function stateDot(kind: "complete" | "progress" | "attention" | "empty"): CSSProperties {
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
  color: t.onSurface,
  cursor: "pointer",
};
const radioChoiceSelected: CSSProperties = {
  border: `1px solid ${t.primary}`,
  background: t.primaryTint,
  color: t.primary,
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
  background: "color-mix(in srgb, var(--color-success) 10%, var(--color-surface-lowest))",
  marginBottom: "1rem",
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
  color: "var(--color-on-primary)",
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
  background: "var(--color-scrim)",
  display: "grid",
  placeItems: "center",
  zIndex: 20,
  padding: "1rem",
};
const modal: CSSProperties = {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: "min(440px, 100%)",
  margin: 0,
  borderRadius: 8,
  background: t.surface,
  padding: "1.25rem",
  boxShadow: "var(--shadow-float)",
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
  zIndex: 1000,

  display: "flex",
  alignItems: "center",
  justifyContent: "center",

  padding: "24px",
  background: "var(--color-scrim)",
  backdropFilter: "blur(2px)",
};

const sfvModal: CSSProperties = {
  position: "relative",
  margin: 0,

  width: "min(820px, calc(100vw - 48px))",
  maxHeight: "calc(100vh - 48px)",

  display: "flex",
  flexDirection: "column",

  padding: 0,
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 16,
  background: t.surface,
  color: t.onSurface,
  boxShadow: "var(--shadow-float)",
  overflow: "hidden",
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
  fontSize: "0.8125rem",
  fontWeight: 500,
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
  padding: "24px",
  overflowY: "auto",
  flex: 1,
  minHeight: 0,
};

const sfvPermissionErrorBox: CSSProperties = {
  borderColor: t.warning,
  background: `color-mix(in srgb, ${t.warning} 10%, ${t.surface})`,
  color: t.onSurface,
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
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "16px",
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
  gridTemplateColumns: "1fr",
  gap: "12px",
};

const sfvAnswerCard: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 220px",
  alignItems: "center",
  gap: "20px",

  padding: "16px",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 12,
  background: t.surface,
  color: t.onSurface,
};

const sfvAnswerCardHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
};

const sfvQuestionContent: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
  minWidth: 0,
};

const sfvQuestionText: CSSProperties = {
  color: t.onSurface,
  fontSize: "0.88rem",
  fontWeight: 650,
  lineHeight: 1.4,
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
  gap: "0.25rem",
  padding: "0.75rem 0.85rem",
  border: `1px solid ${t.error}`,
  borderRadius: 8,
  background: `color-mix(in srgb, ${t.error} 10%, ${t.surface})`,
  color: t.onSurface,
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

const optionalLabel: CSSProperties = {
  marginLeft: 8,
  fontSize: 12,
  fontWeight: 500,
  opacity: 0.65,
};

const sfvReadonlyAnswer: CSSProperties = {
  minHeight: 42,
  display: "flex",
  alignItems: "center",
  boxSizing: "border-box",
  padding: "0.55rem 0.65rem",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 8,
  background: t.surface,
  color: t.onSurface,
  fontSize: "0.85rem",
  fontWeight: 600,
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
