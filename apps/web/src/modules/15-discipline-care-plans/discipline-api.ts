// apps/web/src/modules/15-discipline-care-plans — the M15 read/write access layer the §5 screens share
// (Track B / ADR-0030, ADR-0032).
//
// The wire shapes below MIRROR the server's response DTOs
// (apps/backend/src/modules/15-discipline-care-plans/routes/read-service.ts). They are declared here —
// not imported — because apps/web may never compile-import the backend (dependency-cruiser); the generated
// client (`packages/ui/src/core/api`) is the contract. M15's routes are enriched with their §4.2 request
// bodies/queries, so every CALL is typed; the RESPONSE bodies are not yet TypeBox-published, so each read
// is cast at exactly one place — here — instead of being re-cast ad hoc in thirteen screens.
//
// Two server contracts every write helper honours (§F08 / §2.5): a mutating route requires an
// `Idempotency-Key`, and a PATCH / state transition requires `If-Match` carrying the row `version` the
// caller READ (a 412 means the row moved under you — reload, never retry blind). The server stays the only
// authorization point: nothing here decides what a caller may see.
import type { ApiClient } from "@wardenx/ui";

// ── wire shapes (mirror of the §4.1 response DTOs) ─────────────────────────────────────────────────────

/** §4.6.1 — the paginated envelope M15 pins (`{data, next_cursor, has_more}`, NOT `{items, nextCursor}`). */
export interface CursorPage<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
  total_count?: number;
}

export interface PlanListItem {
  planId: string;
  patientId: string;
  admissionId: string;
  providerEntityId: string;
  locationId: string;
  kind: string;
  status: string;
  nextSupervisoryDueAt: string | null;
  initialAssessmentClockStartedAt: string | null;
  initialAssessmentSignedAt: string | null;
  spiritualCareDeclinedAt: string | null;
  updatedAt: string;
  version: number;
}

export interface GoalView {
  goalId: string;
  parentProblemId: string | null;
  parentGoalId: string | null;
  source: string;
  status: string;
  originalText: string;
  revisedText: string | null;
  measurableOutcome: string | null;
  targetAt: string | null;
  frequencyText: string | null;
  frequencyValue: string | null;
  modalityText: string | null;
  sudRelated: boolean;
  addedByDiscipline: string;
  addedAt: string;
  version: number;
}

export interface InterventionView {
  interventionId: string;
  parentInterventionId: string | null;
  goalRefs: string[];
  scopeText: string;
  frequencyText: string;
  frequencyValue: string;
  discipline: string;
  responsibleRoles: string[];
  status: string;
  discontinuationReason: string | null;
  addedByDiscipline: string;
  addedAt: string;
  version: number;
}

export interface AssessmentView {
  assessmentId: string;
  kind: string;
  status: string;
  capturedAt: string;
  isInitial: boolean;
  sudFlag: boolean;
  familyViolenceFlag: boolean;
  sourceEncounterId: string | null;
  data: unknown;
  amendsAssessmentId: string | null;
  amendmentReason: string | null;
  capturedByMembershipId: string;
  signedAt: string | null;
  signedByMembershipId: string | null;
  version: number;
}

export interface SupervisoryVisitView {
  supervisoryVisitId: string;
  aideMembershipId: string;
  supervisingRnMembershipId: string;
  sourceEncounterId: string | null;
  supervisoryAt: string;
  attestationMode: string;
  aidePerformanceSatisfactory: boolean;
  correctiveActions: string | null;
  supervisoryNarrative: string;
  nextDueAt: string;
  cadenceDaysAtInsert: number;
  signedAt: string | null;
  version: number;
}

export interface AssignmentView {
  assignmentId: string;
  volunteerMembershipId: string;
  coordinatorMembershipId: string;
  activities: string[];
  startsAt: string;
  endsAt: string | null;
  coordinatorAcknowledgedAt: string | null;
  inactivatedAt: string | null;
  inactivationReason: string | null;
  version: number;
}

export interface VersionListItem {
  versionId: string;
  planId: string;
  sequence: number;
  status: string;
  kind: string;
  idgMeetingId: string | null;
  finalizedAt: string | null;
  signedAt: string | null;
  supersededAt: string | null;
  version: number;
}

export interface SignatureView {
  signatureId: string;
  signerMembershipId: string;
  signerRole: string;
  isAcknowledgment: boolean;
  signedAt: string;
}

export interface RequiredSignerSlot {
  role: string;
  count: number;
  isAcknowledgment: boolean;
}

export interface VersionDetail extends VersionListItem {
  stateSnapshot: unknown;
  requiredSignerSet: unknown;
  signatures: SignatureView[];
}

/** The §7.1 supervisory ladder as of the read (null before the Aide POC clock arms / on a non-aide plan). */
export interface CadenceView {
  nextDueAt: string;
  cadenceDays: number;
  status: string;
  hoursOverdue: number;
}

export interface PlanDetail extends PlanListItem {
  aideMembershipId: string | null;
  supervisingRnMembershipId: string | null;
  supervisoryCadenceDaysOverride: number | null;
  spiritualCareDeclined: string | null;
  goals: GoalView[];
  interventions: InterventionView[];
  assessments: AssessmentView[];
  supervisoryVisits: SupervisoryVisitView[];
  volunteerAssignments: AssignmentView[];
  versions: VersionListItem[];
  supervisoryCadence: CadenceView | null;
  /** §7.8 / §7.9 — the confidentiality categories withheld from this body for this caller. */
  redacted_categories: string[];
}

export interface PlanSummary {
  planId: string;
  kind: string;
  status: string;
  goals: { goalId: string; text: string; status: string; targetAt: string | null }[];
  interventions: {
    interventionId: string;
    scopeText: string;
    frequencyText: string;
    status: string;
  }[];
  spiritualCareDeclined: boolean;
  redacted_categories: string[];
}

export interface GateView {
  gateId: string;
  volunteerMembershipId: string;
  gateKind: string;
  /** What the last watcher run materialized. */
  storedStatus: string;
  /** What the validity window implies as of NOW — this is what the screen shows (§2.2.6). */
  effectiveStatus: string;
  validFrom: string;
  validUntil: string | null;
  revokedAt: string | null;
  sourceDocumentId: string | null;
  version: number;
}

/** §7.6 / 418.78(e). `ratio`/`staffPatientCareMinutes` are null while the M27 cost basis is unbound —
 *  `status: "unavailable"` is the honest badge, NOT a 0% breach (M15-F04). */
export interface HourRatioView {
  providerEntityId: string;
  fiscalYear: number;
  volunteerHourMinutes: number;
  staffPatientCareMinutes: number | null;
  ratio: number | null;
  status: string;
  reason?: string;
}

// ── request helpers ────────────────────────────────────────────────────────────────────────────────────

/** §F08 — a fresh client idempotency key per mutation attempt. */
export function idemKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `m15-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

/** §2.5 — the mutation headers: an idempotency key always, `If-Match` whenever a row version was read. */
export function writeHeaders(version?: number | null): Record<string, string> {
  const header: Record<string, string> = { "Idempotency-Key": idemKey() };
  if (version != null) header["If-Match"] = String(version);
  return header;
}

/**
 * Turn a failed response into the sentence a clinician can act on. The server's problem+json body is the
 * source of truth; the status-derived fallbacks name the two contracts a screen can actually violate
 * (412 = the row moved, 428 = a blind write) rather than a generic "something went wrong".
 */
export function errorMessage(error: unknown, fallback: string): string {
  const body = error as { title?: string; detail?: string; code?: string; status?: number } | null;
  if (body?.detail) return body.detail;
  if (body?.title) return body.title;
  if (body?.status === 412)
    return "This record changed while you were working on it. Reload and re-apply your edit.";
  if (body?.status === 428) return "This edit is missing its version. Reload the record and try again.";
  if (body?.status === 403)
    return "You do not have access to this action for this patient or provider entity.";
  return fallback;
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────────────

/** Route 1 — the plan worklist. `kind`/`status` narrow it; the server scopes to what the caller may read. */
export async function listPlans(
  client: ApiClient,
  query: { patientId?: string; kind?: string; status?: string; limit?: number },
): Promise<{ page: CursorPage<PlanListItem> | null; error: unknown }> {
  const res = await client.GET("/api/v1/discipline-plans", { params: { query } } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<PlanListItem>, error: null };
}

/** Route 2 — the full plan, already SQL-filtered by the §7.8/§7.9 gates. */
export async function getPlan(
  client: ApiClient,
  planId: string,
): Promise<{ plan: PlanDetail | null; error: unknown }> {
  const res = await client.GET("/api/v1/discipline-plans/{planId}", {
    params: { path: { planId } },
  } as never);
  if (res.error) return { plan: null, error: res.error };
  return { plan: res.data as unknown as PlanDetail, error: null };
}

/**
 * The kind-scoped read every discipline screen opens with: resolve the patient's plan of `kind` from the
 * worklist, then read it in full. A patient with no plan of that kind is `plan: null` with no error — the
 * bootstrap worker creates the three CoP plans on `m6.admission.activated` and the volunteer plan on the
 * first assignment, so "not yet" is an ordinary state, not a failure.
 */
export async function getPlanByKind(
  client: ApiClient,
  patientId: string,
  kind: string,
): Promise<{ plan: PlanDetail | null; error: unknown }> {
  const { page, error } = await listPlans(client, { patientId, kind, limit: 5 });
  if (error) return { plan: null, error };
  // Prefer the live plan over a discharged one when an admission has been re-opened.
  const rows = page?.data ?? [];
  const row = rows.find((p) => p.status !== "discharged") ?? rows[0];
  if (!row) return { plan: null, error: null };
  return getPlan(client, row.planId);
}

/** Route 3 — the patient-shareable summary (both confidential categories always stripped). */
export async function getPlanSummary(
  client: ApiClient,
  planId: string,
): Promise<{ summary: PlanSummary | null; error: unknown }> {
  const res = await client.GET("/api/v1/discipline-plans/{planId}/summary", {
    params: { path: { planId } },
  } as never);
  if (res.error) return { summary: null, error: res.error };
  return { summary: res.data as unknown as PlanSummary, error: null };
}

/** Route 4 — the version chain. */
export async function listVersions(
  client: ApiClient,
  planId: string,
): Promise<{ page: CursorPage<VersionListItem> | null; error: unknown }> {
  const res = await client.GET("/api/v1/discipline-plans/{planId}/versions", {
    params: { path: { planId } },
  } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<VersionListItem>, error: null };
}

/** Route 5 — one version with its SEALED snapshot, its frozen quorum and its collected signatures. */
export async function getVersion(
  client: ApiClient,
  planId: string,
  versionId: string,
): Promise<{ version: VersionDetail | null; error: unknown }> {
  const res = await client.GET("/api/v1/discipline-plans/{planId}/versions/{versionId}", {
    params: { path: { planId, versionId } },
  } as never);
  if (res.error) return { version: null, error: res.error };
  return { version: res.data as unknown as VersionDetail, error: null };
}

/** Route 19 — the compliance-gate worklist (status re-derived over the validity window, §2.2.6). */
export async function listGates(
  client: ApiClient,
  query: { volunteerMembershipId?: string; gateKind?: string; expiringWithinDays?: number },
): Promise<{ page: CursorPage<GateView> | null; error: unknown }> {
  const res = await client.GET("/api/v1/volunteer-compliance-gates", {
    params: { query },
  } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<GateView>, error: null };
}

/** Route 23 — the 418.78(e) 5% ratio for one (provider entity × fiscal year). */
export async function getHourRatio(
  client: ApiClient,
  query: { providerEntityId: string; fiscalYear: number },
): Promise<{ ratio: HourRatioView | null; error: unknown }> {
  const res = await client.GET("/api/v1/volunteer-hour-ratio", { params: { query } } as never);
  if (res.error) return { ratio: null, error: res.error };
  return { ratio: res.data as unknown as HourRatioView, error: null };
}

/**
 * The signer quorum a version was SEALED with (route 5's `requiredSignerSet`). Stored as an opaque jsonb
 * on the wire; normalized here so the sign ceremony can show "2 of 3 collected" without every screen
 * re-deriving the shape. An unreadable set yields `[]` — the ceremony then says so rather than inventing
 * a quorum the server never froze.
 */
export function normalizeSignerSet(raw: unknown): RequiredSignerSlot[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry === "string") return [{ role: entry, count: 1, isAcknowledgment: false }];
    const e = entry as { role?: unknown; count?: unknown; isAcknowledgment?: unknown };
    if (typeof e?.role !== "string") return [];
    return [
      {
        role: e.role,
        count: typeof e.count === "number" ? e.count : 1,
        isAcknowledgment: e.isAcknowledgment === true,
      },
    ];
  });
}
