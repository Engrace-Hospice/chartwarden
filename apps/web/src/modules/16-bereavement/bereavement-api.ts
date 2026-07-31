// apps/web/src/modules/16-bereavement — the M16 read/write access layer the §5 screens share
// (Track B / ADR-0030, ADR-0032).
//
// The wire shapes below MIRROR the server's response DTOs
// (apps/backend/src/modules/16-bereavement/routes/read-service.ts + write-service.ts). They are declared
// here — not imported — because apps/web may never compile-import the backend (dependency-cruiser); the
// generated client (`packages/ui/src/core/api`) is the contract. M16's routes are enriched with their §4.2
// request bodies/queries, so every CALL is typed; the RESPONSE bodies are not TypeBox-published, so each
// read is cast at exactly one place — here — instead of being re-cast ad hoc in eleven screens.
//
// Two server contracts every write helper honours (§F08 / §2.5): a mutating route requires an
// `Idempotency-Key`, and a state transition requires `If-Match` carrying the row `version` the caller READ
// (a 412 means the row moved under you — reload, never retry blind). The server stays the only
// authorization point: nothing here decides what a caller may see.
//
// THE OPTIONAL-VS-NULL RULE the DTOs below preserve. `currentRiskTier?: string | null` is a three-valued
// field on purpose: ABSENT means "the D10 volunteer scope or the §7.13 Part 2 gate withheld it", `null`
// means "no tier has been computed yet", and a value is a value. Collapsing absent into null in the web
// layer would tell a volunteer that a high-risk survivor is unscored.
import type { ApiClient } from "@wardenx/ui";

// ── wire shapes (mirror of the §4.1 response DTOs) ─────────────────────────────────────────────────────

/** §4.6.1 — the paginated envelope M16 pins (`{data, next_cursor, has_more}`, NOT `{items, nextCursor}`). */
export interface CursorPage<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
  total_count?: number;
}

/** Route 1 — one row of the plan worklist. */
export interface PlanListItem {
  planId: string;
  patientId: string;
  admissionId: string;
  status: string;
  deathDate: string;
  /** D4 — `death_date + 396 days`, derived server-side by the ONE pure window function. */
  windowEndsAt: string;
  assignedCounselorUserId: string | null;
  assignedVolunteerUserId: string | null;
  currentRiskTier?: string | null;
  contactsActiveCount: number;
  nextOutreachDueAt: string | null;
  overdueOutreachCount: number;
  /** D18 — true while an external-source plan still awaits its medical-director cosign. */
  externalSourceCosignPending: boolean;
  version: number;
  updatedAt: string;
}

/** One survivor as the plan detail / roster renders them. */
export interface ContactRow {
  contactId: string;
  planId: string;
  status: string;
  displayName: string;
  relationshipCode: string;
  preferredLanguageIso639: string;
  portalAccountId: string | null;
  consentRecordId: string | null;
  allowedOutreachKinds: string[];
  volunteerVisibleOnly: boolean;
  confirmedAt: string | null;
  optedOutAt: string | null;
  unreachableAt: string | null;
  deceasedAt: string | null;
  /** D9 — true while the 90-day self-service rescind window is still open on the active opt-out row. */
  mayRescindOptOut: boolean;
  currentRiskTier?: string | null;
  version: number;
}

/** The §2.6 outreach rollup both dashboards and the closure record carry (COUNTS, never a rate). */
export interface OutreachStats {
  completedCount: number;
  missedCount: number;
  contactsActiveCount: number;
  contactsOptedOutCount: number;
}

/** D16 — the external-source provenance an HL7 ADT plan carries. */
export interface ExternalSourceMetadata {
  sourceFacility?: string;
  sourceSystem?: string;
  ackAt?: string;
  cosignStatus?: string;
  cosignedAt?: string;
  cosignedByUserId?: string;
  [k: string]: unknown;
}

/** Route 2 — the plan header with its rolled-up roster + risk. */
export interface PlanDetail {
  planId: string;
  patientId: string;
  admissionId: string;
  providerEntityId: string;
  locationId: string | null;
  status: string;
  deathDate: string;
  deathTime: string | null;
  windowEndsAt: string;
  openedAt: string | null;
  pausedAt: string | null;
  pauseKind: string | null;
  closedAt: string | null;
  assignedCounselorUserId: string | null;
  assignedCounselorAssignedAt: string | null;
  assignedVolunteerUserId: string | null;
  assignedVolunteerAssignedAt: string | null;
  externalSource: ExternalSourceMetadata | null;
  /** §4.3.2 / D18 — false while the counselor's first-contact button must stay locked. */
  firstContactAllowed: boolean;
  /** The §4.3.2 machine-readable denial code when `firstContactAllowed` is false; null otherwise. */
  firstContactGateReason: string | null;
  contacts: ContactRow[];
  stats: OutreachStats;
  currentRiskTier?: string | null;
  currentRiskComputedAt?: string | null;
  legalHoldId: string | null;
  version: number;
  updatedAt: string;
  /** §7.13 — which confidentiality categories were withheld from this body, if any. */
  redactedCategories: string[];
}

/** Route 10 — the §3.3.7 closure record (§7.15 survey reconstruction). */
export interface ClosureView {
  closureId: string;
  planId: string;
  reason: string;
  closeKind: string;
  closedAt: string;
  closedByUserId: string | null;
  cosignedByUserId: string | null;
  cosignedAt: string | null;
  stats: OutreachStats;
  bereavementSummaryDocumentId: string | null;
}

/** Route 19 — one scheduled or historical touchpoint. */
export interface OutreachRow {
  outreachId: string;
  planId: string;
  contactId: string;
  kind: string;
  status: string;
  anniversaryMark: string | null;
  dueAt: string;
  lateGraceUntil: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  assigneeUserId: string | null;
  renderedDocumentId: string | null;
  sourceEncounterId: string | null;
  version: number;
}

/** Route 29 — one immutable row of the append-only score ledger. */
export interface RiskScoreRow {
  scoreId: string;
  planId: string;
  contactId: string | null;
  scoreKind: string;
  assessedAt: string;
  assessedByUserId: string | null;
  tier: string;
  /** The rubric's own tier before any §7.3 counselor override moved `rule_tier` off it. */
  deterministicTier: string;
  /** The 0..100 INTEGER column (`rule_score`). */
  ruleScore: number;
  dataCompleteness: string;
  confidenceBand: string;
  /** D17 — the tri-state factor vector. ABSENT when §7.13 / D10 withheld clinical risk content. */
  factors?: Record<string, boolean | "unknown">;
  pg13Score: number | null;
  ipgrScore: number | null;
  /** True when a seam was unreadable, so the `unknown`s are an OUTAGE rather than an unasked question. */
  evidenceDegraded: boolean;
  redactedCategories: string[];
}

/** Route 30 — the counselor's own caseload plus what is coming due. */
export interface CounselorDashboard {
  counselorUserId: string;
  caseloadCount: number;
  dueWithinDays: number;
  dueSoon: OutreachRow[];
  overdue: OutreachRow[];
  tierDistribution: Record<string, number>;
  externalSourceCosignPendingCount: number;
}

/** Route 31 — the full-tenant rollups (COUNTS, never rates — CMS small-N suppression lives downstream). */
export interface SupervisorDashboard {
  planCountsByStatus: Record<string, number>;
  outreachCountsByStatus: Record<string, number>;
  /** CoP 418.64(d): completed-on-time touchpoints ÷ touchpoints owed, as the raw PAIR. */
  copCounts: { numerator: number; denominator: number };
  tierDistribution: Record<string, number>;
  closureCountsByReason: Record<string, number>;
  unassignedPlanCount: number;
  externalSourceCosignPendingCount: number;
}

/** Route 5's answer: the opened plan plus what opening it produced. */
export interface PlanActivation {
  plan: PlanDetail;
  contactsSeededCount: number;
  outreachScheduledCount: number;
  anniversaryRemindersCount: number;
  effects: string[];
}

/** Route 27's answer: what the regeneration actually materialized (never a bare 204). */
export interface ScheduleRegeneration {
  planId: string;
  cancelledCount: number;
  generatedCount: number;
  outreach: OutreachRow[];
}

/** Routes 21/26/32's answer: the `bereavement_contact_log` row the transition wrote. */
export interface ContactLogRow {
  contactLogId: string;
  planId: string;
  contactId: string;
  outreachId: string;
  kind: string;
  outcome: string;
  contactAt: string;
  artifactDocumentId: string | null;
}

/** One roster addition (§4.2 `AdditionalContactBody`, shared by routes 5 and 11). */
export interface ContactDraft {
  displayName: string;
  relationshipCode: string;
  email?: string;
  phone?: string;
  mailingAddress?: string;
  preferredLanguageIso639?: string;
  consentRecordId?: string;
  outreachPreferences?: { allowedKinds: string[] };
}

// ── request helpers ────────────────────────────────────────────────────────────────────────────────────

/** §F08 — a fresh client idempotency key per mutation attempt. */
export function idemKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `m16-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

/** §2.5 — the mutation headers: an idempotency key always, `If-Match` whenever a row version was read. */
export function writeHeaders(version?: number | null): Record<string, string> {
  const header: Record<string, string> = { "Idempotency-Key": idemKey() };
  if (version != null) header["If-Match"] = String(version);
  return header;
}

/**
 * Turn a failed response into the sentence a counselor can act on. The server's problem+json body is the
 * source of truth; the status-derived fallbacks name the contracts a screen can actually violate (412 =
 * the row moved, 428 = a blind write, 409 = a gate refused and SAID WHICH) rather than a generic failure.
 */
export function errorMessage(error: unknown, fallback: string): string {
  const body = error as { title?: string; detail?: string; code?: string; status?: number } | null;
  if (body?.detail) return body.detail;
  if (body?.title) return body.title;
  if (body?.status === 412)
    return "This record changed while you were working on it. Reload and re-apply your edit.";
  if (body?.status === 428) return "This edit is missing its version. Reload the record and try again.";
  if (body?.status === 403)
    return "You do not have access to this action for this bereavement plan.";
  return fallback;
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────────────

/** Route 1 — the plan worklist. The server scopes it; a plan the caller may not read is simply absent. */
export async function listPlans(
  client: ApiClient,
  query: {
    patientId?: string;
    admissionId?: string;
    status?: string;
    counselorUserId?: string;
    riskTier?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<{ page: CursorPage<PlanListItem> | null; error: unknown }> {
  const res = await client.GET("/api/v1/bereavement/plans", { params: { query } } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<PlanListItem>, error: null };
}

/** Route 2 — the full plan, already SQL-filtered by the §7.13 gates. A 404 is "absent OR out of reach". */
export async function getPlan(
  client: ApiClient,
  planId: string,
): Promise<{ plan: PlanDetail | null; error: unknown }> {
  const res = await client.GET("/api/v1/bereavement/plans/{planId}", {
    params: { path: { planId } },
  } as never);
  if (res.error) return { plan: null, error: res.error };
  return { plan: res.data as unknown as PlanDetail, error: null };
}

/** Route 10 — the closure record. A plan still open answers 404, which is an ordinary state, not an error. */
export async function getClosure(
  client: ApiClient,
  planId: string,
): Promise<{ closure: ClosureView | null; error: unknown }> {
  const res = await client.GET("/api/v1/bereavement/plans/{planId}/closure", {
    params: { path: { planId } },
  } as never);
  if (res.error) return { closure: null, error: res.error };
  return { closure: res.data as unknown as ClosureView, error: null };
}

/** Route 19 — the plan's touchpoints (scheduled + historical), cursor-paginated. */
export async function listOutreach(
  client: ApiClient,
  planId: string,
  query: {
    contactId?: string;
    status?: string;
    kind?: string;
    dueFrom?: string;
    dueTo?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ page: CursorPage<OutreachRow> | null; error: unknown }> {
  const res = await client.GET("/api/v1/bereavement/plans/{planId}/outreach", {
    params: { path: { planId }, query },
  } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<OutreachRow>, error: null };
}

/** Route 29 — the append-only score ledger, newest first. */
export async function listRiskScores(
  client: ApiClient,
  planId: string,
  query: { contactId?: string; cursor?: string; limit?: number } = {},
): Promise<{ page: CursorPage<RiskScoreRow> | null; error: unknown }> {
  const res = await client.GET("/api/v1/bereavement/plans/{planId}/risk-scores", {
    params: { path: { planId }, query },
  } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<RiskScoreRow>, error: null };
}

/** Route 30 — the caller's OWN caseload. The counselor id comes from the session, never from a param. */
export async function getCounselorDashboard(
  client: ApiClient,
  query: { dueWithinDays?: number; limit?: number } = {},
): Promise<{ view: CounselorDashboard | null; error: unknown }> {
  const res = await client.GET("/api/v1/bereavement/dashboard/counselor", {
    params: { query },
  } as never);
  if (res.error) return { view: null, error: res.error };
  return { view: res.data as unknown as CounselorDashboard, error: null };
}

/** Route 31 — the full-tenant rollups. */
export async function getSupervisorDashboard(
  client: ApiClient,
  query: { providerEntityId?: string; locationId?: string } = {},
): Promise<{ view: SupervisorDashboard | null; error: unknown }> {
  const res = await client.GET("/api/v1/bereavement/dashboard/supervisor", {
    params: { query },
  } as never);
  if (res.error) return { view: null, error: res.error };
  return { view: res.data as unknown as SupervisorDashboard, error: null };
}

// ── plan writes (routes 3–9, 27, 28, 33) ───────────────────────────────────────────────────────────────

/** Route 3 — initial counselor assignment (`eligible → initiating`). */
export async function assignCounselor(
  client: ApiClient,
  planId: string,
  version: number,
  body: { counselorUserId: string; effectiveAt?: string },
): Promise<{ plan: PlanDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/plans/{planId}/assign-counselor", {
    params: { path: { planId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { plan: null, error: res.error };
  return { plan: res.data as unknown as PlanDetail, error: null };
}

/** Route 4 — volunteer assignment. The 418.78 gates resolve through M15's seam, never the body. */
export async function assignVolunteer(
  client: ApiClient,
  planId: string,
  version: number,
  body: { volunteerUserId: string; effectiveAt?: string },
): Promise<{ plan: PlanDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/plans/{planId}/assign-volunteer", {
    params: { path: { planId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { plan: null, error: res.error };
  return { plan: res.data as unknown as PlanDetail, error: null };
}

/** Route 5 — seed the roster + materialize the D4 schedule (`initiating → active`). */
export async function seedRosterAndSchedule(
  client: ApiClient,
  planId: string,
  version: number,
  body: { seedFromCaregivers?: boolean; additionalContacts?: ContactDraft[] },
): Promise<{ activation: PlanActivation | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/plans/{planId}/seed-roster-and-schedule", {
    params: { path: { planId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { activation: null, error: res.error };
  return { activation: res.data as unknown as PlanActivation, error: null };
}

/** Route 6 — pause (cancels future-dated outreach; a reason is mandatory). */
export async function pausePlan(
  client: ApiClient,
  planId: string,
  version: number,
  body: { pauseKind: string; reason: string },
): Promise<{ plan: PlanDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/plans/{planId}/pause", {
    params: { path: { planId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { plan: null, error: res.error };
  return { plan: res.data as unknown as PlanDetail, error: null };
}

/** Route 7 — resume. The schedule regenerates FROM NOW; a touchpoint whose date passed is not resurrected. */
export async function resumePlan(
  client: ApiClient,
  planId: string,
  version: number,
): Promise<{ plan: PlanDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/plans/{planId}/resume", {
    params: { path: { planId } },
    headers: writeHeaders(version),
    body: {},
  } as never);
  if (res.error) return { plan: null, error: res.error };
  return { plan: res.data as unknown as PlanDetail, error: null };
}

/** Route 8 — D7 early close (step-up; ≥40-char narrative). Lands awaiting the route-9 supervisor cosign. */
export async function closeEarly(
  client: ApiClient,
  planId: string,
  version: number,
  body: { reason: string; narrative: string },
): Promise<{ closure: ClosureView | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/plans/{planId}/close-early", {
    params: { path: { planId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { closure: null, error: res.error };
  return { closure: res.data as unknown as ClosureView, error: null };
}

/** Route 9 — the clinical-supervisor cosign that ratifies the early close (step-up). */
export async function cosignClose(
  client: ApiClient,
  planId: string,
  version: number,
  body: { attestation?: string },
): Promise<{ closure: ClosureView | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/plans/{planId}/cosign-close", {
    params: { path: { planId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { closure: null, error: res.error };
  return { closure: res.data as unknown as ClosureView, error: null };
}

/** Route 27 — regenerate the FORWARD outreach book (whole plan, or one contact). */
export async function regenerateSchedule(
  client: ApiClient,
  planId: string,
  version: number,
  body: { contactId?: string; fromAt?: string },
): Promise<{ result: ScheduleRegeneration | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/plans/{planId}/regenerate-schedule", {
    params: { path: { planId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { result: null, error: res.error };
  return { result: res.data as unknown as ScheduleRegeneration, error: null };
}

/** The tri-state a D17 factor carries — `unknown` is a real answer, not a missing one. */
export type TriState = boolean | "unknown";

/** Route 28 — recompute the deterministic D3/D17 score (Layer 2 only when `ai.full` is on server-side). */
export async function recomputeRisk(
  client: ApiClient,
  planId: string,
  body: {
    bereavedContactId?: string;
    factors?: Record<string, TriState | number | string | undefined>;
    requestAugmentation?: boolean;
    overrideTier?: string;
    overrideReason?: string;
  },
): Promise<{ score: RiskScoreRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/plans/{planId}/recompute-risk", {
    params: { path: { planId } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { score: null, error: res.error };
  return { score: res.data as unknown as RiskScoreRow, error: null };
}

/**
 * Route 33 — the counselor's FIRST contact (§4.3.2 / D18). The external-source cosign gate refuses with a
 * 409 carrying the machine-readable reason, which the caller renders verbatim: a generic failure here
 * would leave a coordinator with no idea which gate to clear.
 */
export async function initiateContact(
  client: ApiClient,
  planId: string,
  body: { contactId: string; kind?: string },
): Promise<{ outreach: OutreachRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/plans/{planId}/initiate-contact", {
    params: { path: { planId } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { outreach: null, error: res.error };
  return { outreach: res.data as unknown as OutreachRow, error: null };
}

// ── contact writes (routes 11–18, 26, 32) ──────────────────────────────────────────────────────────────

/** Route 11 — add a bereaved contact to an open plan (lands `proposed`; route 13 confirms it). */
export async function createContact(
  client: ApiClient,
  planId: string,
  body: ContactDraft,
): Promise<{ contact: ContactRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/plans/{planId}/contacts", {
    params: { path: { planId } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { contact: null, error: res.error };
  return { contact: res.data as unknown as ContactRow, error: null };
}

/** Route 12 — update preferences / channels. `If-Match` required: a blind channel overwrite could send a
 *  condolence letter to an address the family already corrected. */
export async function updateContact(
  client: ApiClient,
  contactId: string,
  version: number,
  body: {
    displayName?: string;
    email?: string | null;
    phone?: string | null;
    mailingAddress?: string | null;
    preferredLanguageIso639?: string;
    outreachPreferences?: { allowedKinds: string[] };
    volunteerVisibleOnly?: boolean;
  },
): Promise<{ contact: ContactRow | null; error: unknown }> {
  const res = await client.PATCH("/api/v1/bereavement/contacts/{contactId}", {
    params: { path: { contactId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { contact: null, error: res.error };
  return { contact: res.data as unknown as ContactRow, error: null };
}

/** Route 13 — proposed → active. The D6 consent verdict is resolved through M39 server-side, fail-CLOSED. */
export async function confirmContact(
  client: ApiClient,
  contactId: string,
  version: number,
  body: { consentRecordId?: string },
): Promise<{ contact: ContactRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/contacts/{contactId}/confirm", {
    params: { path: { contactId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { contact: null, error: res.error };
  return { contact: res.data as unknown as ContactRow, error: null };
}

/** Route 14 — per-contact opt-out (D9). Staff OR the survivor's own M31 portal session. */
export async function optOutContact(
  client: ApiClient,
  contactId: string,
  version: number,
  body: { optOutKind: string; channelKinds?: string[]; reason?: string; sourceKind: string },
): Promise<{ contact: ContactRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/contacts/{contactId}/opt-out", {
    params: { path: { contactId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { contact: null, error: res.error };
  return { contact: res.data as unknown as ContactRow, error: null };
}

/** Route 15 — undo an opt-out. The D9 90-day window binds the SELF-SERVICE path, not a counselor rescind. */
export async function rescindOptOut(
  client: ApiClient,
  contactId: string,
  version: number,
  body: { reason?: string },
): Promise<{ contact: ContactRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/contacts/{contactId}/rescind-opt-out", {
    params: { path: { contactId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { contact: null, error: res.error };
  return { contact: res.data as unknown as ContactRow, error: null };
}

/** Route 16 — the survivor themselves died. §2.3's only terminal state, so the verification is mandatory. */
export async function markContactDeceased(
  client: ApiClient,
  contactId: string,
  version: number,
  body: { deceasedAt: string; deathSource: string },
): Promise<{ contact: ContactRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/contacts/{contactId}/mark-deceased", {
    params: { path: { contactId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { contact: null, error: res.error };
  return { contact: res.data as unknown as ContactRow, error: null };
}

/** Route 17 — accept the nightly detector's 3-strikes proposal (the §2.3 machine enforces the threshold). */
export async function markContactUnreachable(
  client: ApiClient,
  contactId: string,
  version: number,
  body: { note?: string },
): Promise<{ contact: ContactRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/contacts/{contactId}/mark-unreachable", {
    params: { path: { contactId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { contact: null, error: res.error };
  return { contact: res.data as unknown as ContactRow, error: null };
}

/** Route 18 — §7.7 complicated grief. ENDS the M16 program for this survivor; the M40 resource is required. */
export async function flagComplicatedGrief(
  client: ApiClient,
  contactId: string,
  version: number,
  body: { externalResourceId: string; pg13Score?: number; ipgrScore?: number; note?: string },
): Promise<{ contact: ContactRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/contacts/{contactId}/flag-complicated-grief", {
    params: { path: { contactId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { contact: null, error: res.error };
  return { contact: res.data as unknown as ContactRow, error: null };
}

/** Route 26 — an ad-hoc contact-log row for a touchpoint that never had a scheduled outreach. */
export async function logDirectContact(
  client: ApiClient,
  contactId: string,
  body: {
    kind: string;
    outcome: string;
    contactAt: string;
    contactResponded: boolean;
    artifactDocumentId?: string | null;
    notes?: string;
  },
): Promise<{ log: ContactLogRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/contacts/{contactId}/log-direct", {
    params: { path: { contactId } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { log: null, error: res.error };
  return { log: res.data as unknown as ContactLogRow, error: null };
}

/** Route 32 — log an M40 external-resource referral WITHOUT ending the program (contrast route 18). */
export async function referExternal(
  client: ApiClient,
  contactId: string,
  body: { externalResourceId: string; contactAt?: string; notes?: string },
): Promise<{ log: ContactLogRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/contacts/{contactId}/refer-external", {
    params: { path: { contactId } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { log: null, error: res.error };
  return { log: res.data as unknown as ContactLogRow, error: null };
}

// ── outreach writes (routes 20–25) ─────────────────────────────────────────────────────────────────────

/** Route 20 — scheduled → in_progress. */
export async function startOutreach(
  client: ApiClient,
  outreachId: string,
  version: number,
): Promise<{ outreach: OutreachRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/outreach/{outreachId}/start", {
    params: { path: { outreachId } },
    headers: writeHeaders(version),
    body: {},
  } as never);
  if (res.error) return { outreach: null, error: res.error };
  return { outreach: res.data as unknown as OutreachRow, error: null };
}

/**
 * Route 21 — in_progress → completed, writing the contact-log row in the SAME transaction. §4.2's body is
 * a DISCRIMINATED UNION on `kind`: the in-person branch REQUIRES the M8 encounter (D15) and every other
 * kind must NOT carry one. The union is preserved here rather than flattened, so a screen cannot compose
 * a body the DB CHECK pair will reject at the end of a long transaction.
 */
export type CompleteOutreachBody =
  | {
      kind: "in_person_visit";
      sourceEncounterId: string;
      outcome: string;
      contactResponded: boolean;
      notes?: string;
    }
  | {
      kind: string;
      outcome: string;
      contactResponded: boolean;
      artifactDocumentId?: string;
      notes?: string;
    };

export async function completeOutreach(
  client: ApiClient,
  outreachId: string,
  version: number,
  body: CompleteOutreachBody,
): Promise<{ outreach: OutreachRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/outreach/{outreachId}/complete", {
    params: { path: { outreachId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { outreach: null, error: res.error };
  return { outreach: res.data as unknown as OutreachRow, error: null };
}

/** Route 22 — the survivor declined THIS touchpoint. Not an opt-out: the forward schedule is untouched. */
export async function declineOutreach(
  client: ApiClient,
  outreachId: string,
  version: number,
  body: { notes?: string },
): Promise<{ outreach: OutreachRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/outreach/{outreachId}/decline", {
    params: { path: { outreachId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { outreach: null, error: res.error };
  return { outreach: res.data as unknown as OutreachRow, error: null };
}

/** Route 23 — no response after retries. Feeds the §2.3 three-strikes `markUnreachable` proposal. */
export async function noResponseOutreach(
  client: ApiClient,
  outreachId: string,
  version: number,
  body: { notes?: string },
): Promise<{ outreach: OutreachRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/outreach/{outreachId}/no-response", {
    params: { path: { outreachId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { outreach: null, error: res.error };
  return { outreach: res.data as unknown as OutreachRow, error: null };
}

/** Route 24 — cancel a scheduled touchpoint (a reason is mandatory, §2.4). */
export async function cancelOutreach(
  client: ApiClient,
  outreachId: string,
  version: number,
  body: { reason: string },
): Promise<{ outreach: OutreachRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/outreach/{outreachId}/cancel", {
    params: { path: { outreachId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { outreach: null, error: res.error };
  return { outreach: res.data as unknown as OutreachRow, error: null };
}

/** Route 25 — missed → in_progress inside the 7-day late grace. Audit-flagged, NOT a compliance failure. */
export async function lateAttemptOutreach(
  client: ApiClient,
  outreachId: string,
  version: number,
): Promise<{ outreach: OutreachRow | null; error: unknown }> {
  const res = await client.POST("/api/v1/bereavement/outreach/{outreachId}/late-attempt", {
    params: { path: { outreachId } },
    headers: writeHeaders(version),
    body: {},
  } as never);
  if (res.error) return { outreach: null, error: res.error };
  return { outreach: res.data as unknown as OutreachRow, error: null };
}
