// apps/web/src/modules/20-field-safety — the M20 read/write access layer the §5 screens share
// (Track B / ADR-0030, ADR-0032).
//
// The wire shapes below MIRROR the server's response DTOs
// (apps/backend/src/modules/20-field-safety/routes/read-service.ts + write-service.ts). They are declared
// here — not imported — because apps/web may never compile-import the backend (dependency-cruiser); the
// generated client (`packages/ui/src/core/api`) is the contract. M20's routes are enriched with their §4.2
// request bodies/queries, so every CALL is typed; the RESPONSE bodies are not TypeBox-published, so each
// read is cast at exactly one place — here — instead of being re-cast ad hoc in fourteen screens.
//
// ── FIVE SERVER CONTRACTS EVERY HELPER HONOURS ───────────────────────────────────────────────────────
//
//   • ADR-0021 — a mutating route requires an `Idempotency-Key`. Every helper mints a fresh one per
//     attempt, WITH ONE EXCEPTION: `raiseSos` sends none, because §4.1's Idempotent column says `no` for
//     `POST /safety/sos` and §2.6 / M20-F10 say why — every press is a separate call for help, and
//     collapsing two onto one alert IS the suppression S13 forbids. The absence of the header here is a
//     load-bearing decision, not an oversight.
//   • §2.5 — a state transition carries `If-Match`, and M20's ETag is the row's INTEGER `version`
//     (`safety_sos_alert.version` / `safety_incident.version`), not a timestamp. A 409/412 means the row
//     moved under you — reload, never retry blind.
//   • D5 — `POST /sos/:id/cancel` takes NO `If-Match` either, and for a different reason: the cancel is a
//     five-second one-tap act on a phone the clinician may be palming under a table (§7.4), and requiring
//     a version she had to read first is a round trip that does not fit inside the window.
//   • §4.1.1 — offset pagination is REFUSED (400) on every PHI list; the cursor is opaque and HMAC-signed,
//     and a tampered one is a 422, not a silent page 1. Nothing here parses or constructs a cursor.
//   • D6 / §8.7 — the coordinate stream is the ONLY coordinate-bearing read in the module. Its helper is
//     the only one that takes an `accessReason`, and the response's own `auditWarningBanner` is what the
//     screen renders — the promise the screen makes and the audit row the server writes are one decision.
//
// The server stays the only authorization point: nothing here decides what a caller may see. An
// out-of-scope row is a non-leaking 404 from the server, never a frontend hide.
import type { ApiClient } from "@wardenx/ui";

// ── wire shapes (mirror of the §4.1 response DTOs) ─────────────────────────────────────────────────────

/** §4.1.1's paginated envelope. There is NO `total_count` field: a count is an enumeration oracle. Every
 *  KPI on an M20 screen is therefore page-derived and says so. */
export interface CursorPage<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

/** §4.2 — one `safety_check_in` row. `coordinatesCaptured` is a BOOLEAN and there is no coordinate on
 *  this DTO at all (D11): rendering a check-in can never trip the `safety.sos.read_coords` audit path,
 *  because there is no field to put a latitude in. */
export interface SafetyCheckInView {
  id: string;
  scheduleId: string | null;
  visitId: string | null;
  postedByMembershipId: string;
  postedAt: string;
  kind: string;
  status: string;
  /** §3.6-denylisted free text; present only for a caller who passed the per-row ABAC gate. */
  concernNote: string | null;
  coordinatesCaptured: boolean;
  isPartOfSosBracket: boolean;
  correctsCheckInId: string | null;
  supersededAt: string | null;
  supersededByCheckInId: string | null;
  /**
   * §4.1 row 3's five-minute grace, as of the read.
   *
   * ALWAYS `null` on the LIST projection (`/check-ins/me/today`) — the server answers it only on the
   * DETAIL route, which is why the amend flow re-reads the row by id before offering the form rather than
   * computing the window from `postedAt`. A client-side clock decides nothing here.
   */
  amendableUntil: string | null;
}

/** §4.1 row 4 — the clinician's own day: what she owes, and what she has posted against it. */
export interface SafetyMyDayView {
  asOf: string;
  obligations: {
    scheduleId: string;
    visitId: string | null;
    kind: string;
    expectedAt: string;
    windowMinutes: number;
    state: string;
    fulfilledByCheckInId: string | null;
  }[];
  recentCheckIns: SafetyCheckInView[];
}

/** §4.2 — the SOS detail, with its §2.2.2 ledger and its §2.2.6 acknowledgments. */
export interface SafetySosAlertView {
  id: string;
  providerEntityId: string;
  postedByMembershipId: string;
  postedAt: string;
  lastKnownVisitId: string | null;
  lifecycleState: string;
  cancelWindowExpiredAt: string;
  cancelStatus: string;
  cancelAttemptedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedByMembershipId: string | null;
  resolvedAt: string | null;
  resolvedByMembershipId: string | null;
  outcome: string | null;
  /** The cipher pair: `null` narrative with `available: false` means "we cannot open it here", which is a
   *  DIFFERENT answer from "there is no narrative" (the M19-T08 three-state rule). */
  resolutionNarrative: string | null;
  resolutionNarrativeAvailable: boolean;
  linkedIncidentId: string | null;
  /** M20-F16 — false when the clinician declined `sos_coordinates`. The alert fanned out either way. */
  coordinatesCaptured: boolean;
  /** The `If-Match` value a transition on this row must echo (§2.5) — an INTEGER, not a stamp. */
  version: number;
  stateHistory: {
    fromState: string | null;
    toState: string;
    transitionedAt: string;
    transitionedByMembershipId: string | null;
  }[];
  acknowledgments: {
    id: string;
    acknowledgedByMembershipId: string;
    acknowledgedAt: string;
    actionTaken: string;
    outcome: string | null;
  }[];
}

/** §4.1 row 10 — the D6 coordinate stream. The ONE DTO in this module that carries a latitude. */
export interface SosLocationStreamPage {
  sosAlertId: string;
  samples: {
    id: string;
    sampledAt: string;
    latitude: number;
    longitude: number;
    accuracyM: number;
  }[];
  next_cursor: string | null;
  has_more: boolean;
  /** §7.9's banner, rendered VERBATIM by the screen — carried on the response so the promise the screen
   *  makes and the audit row the server writes cannot drift apart. */
  auditWarningBanner: string;
}

/** §4.1 row 11 — the active-SOS board tile. */
export interface ActiveSosView {
  alerts: {
    id: string;
    postedByMembershipId: string;
    /** Minimum-necessary: the clinician's first name, never the patient's identity. */
    postedByFirstName: string;
    postedAt: string;
    lifecycleState: string;
    minutesOpen: number;
    acknowledgedAt: string | null;
  }[];
  fetchedAt: string;
}

/** §4.2 — the incident detail. Two cipher pairs, same three-state rule as the SOS narrative. */
export interface SafetyIncidentView {
  id: string;
  providerEntityId: string;
  affectedClinicianMembershipId: string;
  reportedByMembershipId: string;
  category: string;
  severity: string;
  visitId: string | null;
  patientId: string | null;
  occurredAt: string;
  reportedAt: string;
  locationDescription: string | null;
  narrative: string | null;
  narrativeAvailable: boolean;
  witnesses: string | null;
  oshaReportable: boolean;
  oshaReportableSignedOffByMembershipId: string | null;
  oshaReportableSignedOffAt: string | null;
  workersCompClaimInitiated: boolean;
  workersCompClaimReference: string | null;
  linkedSosAlertId: string | null;
  lifecycleState: string;
  submittedAt: string | null;
  reviewedByMembershipId: string | null;
  reviewedAt: string | null;
  actionPlan: string | null;
  actionPlanAvailable: boolean;
  closedAt: string | null;
  reopenReason: string | null;
  version: number;
  stateHistory: {
    fromState: string | null;
    toState: string;
    transitionedAt: string;
    transitionedByMembershipId: string | null;
    reason: string | null;
  }[];
}

/** §4.1 row 20 — one subscription row (D8). */
export interface SafetySubscriptionView {
  id: string;
  supervisorMembershipId: string;
  clinicianMembershipId: string | null;
  locationId: string | null;
  providerEntityId: string | null;
  scopeKind: string;
  alertKinds: string[];
  isVacationForwarding: boolean;
  vacationForwardToMembershipId: string | null;
  createdAt: string;
}

/** §4.1 row 22's answer — a deactivation that SUCCEEDS and tells the DON what it uncovered (§2.2.5). */
export interface DeleteSubscriptionResult {
  id: string;
  deactivatedAt: string;
  coverageGapsCreated: { clinicianMembershipId: string; reason: string }[];
}

/** §4.1 row 23 — one advisory polygon (D12). Rings are `[longitude, latitude]`, SRID 4326 (M20-F07: no
 *  PostGIS, so the polygon is jsonb and point-in-polygon is an app-code ray-cast). */
export interface SafetyHighRiskAreaView {
  id: string;
  riskCategory: string;
  advisoryMessage: string;
  polygon: [number, number][][];
  policyForVisitsToArea: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdByMembershipId: string | null;
}

/** §4.2 — one clinician's row on the supervisor live-awareness board. NO coordinates, deliberately. */
export interface SafetyClinicianStatusView {
  membershipId: string;
  displayName: string;
  currentVisitId: string | null;
  /** Minimum-necessary per §1.3 / HIPAA §164.502(b): first name only, never the full patient identity. */
  currentPatientFirstName: string | null;
  lastKnownLocation: { source: string; sampledAt: string; ageMinutes: number } | null;
  lastCheckInAt: string | null;
  lastCheckInStatus: string | null;
  nextExpectedCheckInAt: string | null;
  overdueState: string;
  activeSosAlert: { id: string; raisedAt: string; lifecycleState: string } | null;
  inHighRiskArea: { areaId: string; riskCategory: string; advisoryMessage: string } | null;
  /** §7.7 — M18 owns the RESPONSE to a suspected spoof; M20 shows the badge so a supervisor scanning
   *  "is everyone OK?" sees both posture signals at once. */
  gpsSpoofSuspected: boolean;
}

/** §4.2 — the whole board. The two counts are computed over the SAME snapshot as `clinicians`, so the
 *  tiles and the grid can never disagree on screen. */
export interface SafetyDashboardView {
  clinicians: SafetyClinicianStatusView[];
  activeSosCount: number;
  overdueCount: number;
  fetchedAt: string;
}

/** §4.3 — the effective policy, the platform floor merged under the tenant's current version. */
export interface SafetyPolicyView {
  organizationId: string;
  versionId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  midVisitCadenceMinutes: number;
  midVisitMinVisitDurationMinutes: number;
  preVisitWindowMinutes: number;
  postVisitWindowMinutes: number;
  gentleReminderMinutes: number;
  supervisorAlertMinutes: number;
  escalationMinutes: number;
  sosEquivalentMinutes: number;
  sosCancelWindowSeconds: number;
  sosCancelRequiresBiometric: boolean;
  sosContinuousLocationEnabled: boolean;
  sosContinuousLocationSampleSeconds: number;
  sosContinuousLocationMaxDurationHours: number;
  sosTier1SlaSeconds: number;
  sosTier2SlaSeconds: number;
  sosTier3SlaSeconds: number;
  subscriptionModel: string;
  afterHoursStartHour: number;
  afterHoursEndHour: number;
  oshaReportableAutoFlagCategories: string[];
}

/** §4.1 row 27 — one consent grant on the clinician's own surface (§2.2.8 / M20-F06). */
export interface SafetyConsentView {
  purpose: string;
  status: string;
  grantedAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
  /** NOT denylisted, deliberately: it is the one thing a consent dispute turns on. */
  acknowledgmentTextSnapshot: string;
  /** `emergency_contact_call` only. A BOOLEAN, never the spouse's phone number — re-displaying the contact
   *  on every consent screen would widen the disclosure the consent was given for. */
  contactOnFile: boolean;
}

export interface SafetyConsentSurface {
  consents: SafetyConsentView[];
  asOf: string;
}

/** A non-blocking fact the server surfaced beside a successful write (§4.2's `warningsSurfaced`) — a
 *  coordinate DROPPED for want of consent, an already-overdue schedule, an unattested device. Each is a
 *  recorded fact and NONE is a refusal; that asymmetry is S13. */
export interface SafetyWarning {
  code: string;
  message: string;
}

/** §4.2's `RecordCheckInResponse`. */
export interface RecordCheckInResult {
  checkIn: SafetyCheckInView;
  scheduleClosed: boolean;
  warningsSurfaced: SafetyWarning[];
}

/**
 * §4.2's `RaiseSosResponse`.
 *
 * `acknowledgersDispatched` is THREE-VALUED and the screen must treat it that way. It is the size of the
 * recipient set the §4.5 composed resolver produced — not a delivery count — and `null` means the
 * resolver could not be consulted AT ALL. "Nobody is subscribed" (0) and "we could not ask" (null) are
 * different facts, and only the second is the M20-F01 degraded path where D15's `tel:` direct dial is the
 * answer. Rendering null as 0 would tell a clinician standing in a stairwell that nobody is coming when
 * in fact nobody knows.
 */
export interface RaiseSosResult {
  id: string;
  postedAt: string;
  cancelWindowExpiresAt: string;
  lifecycleState: string;
  acknowledgersDispatched: number | null;
  warningsSurfaced: SafetyWarning[];
}

/** §4.2's `CancelSosResponse`. A REJECTED cancel is a 200, not a 4xx — returning an error would tell a
 *  hostile actor holding the device that their tap did something. */
export interface CancelSosResult {
  id: string;
  cancelStatus: string;
  lifecycleState: string;
}

// ── request helpers ────────────────────────────────────────────────────────────────────────────────────

/** ADR-0021 — a fresh client idempotency key per mutation attempt. */
export function idemKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `m20-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

/**
 * §2.5 — the mutation headers. `If-Match` carries the INTEGER row `version` the caller READ.
 *
 * Passing `undefined` is for the routes with no row to have read (the check-in post, the incident create,
 * a subscription, an area, a consent grant); every state transition on a versioned row passes it, and
 * omitting it there is a 428, not a silent last-write-wins.
 */
export function writeHeaders(version?: number | null): Record<string, string> {
  const header: Record<string, string> = { "Idempotency-Key": idemKey() };
  if (version !== undefined && version !== null) header["If-Match"] = String(version);
  return header;
}

/**
 * Turn a failed response into the sentence a clinician at 2 a.m. can act on.
 *
 * The server's problem+json body is the source of truth; the status-derived fallbacks name the contracts a
 * screen can actually violate rather than a generic failure. A 404 is deliberately ambiguous — "absent OR
 * out of your reach" — and the copy says so instead of guessing.
 */
export function errorMessage(error: unknown, fallback: string): string {
  const body = error as { title?: string; detail?: string; code?: string; status?: number } | null;
  if (body?.detail) return body.detail;
  if (body?.title) return body.title;
  if (body?.status === 409 || body?.status === 412)
    return "This record changed while you were working on it. Reload and re-apply your edit — do not retry blind.";
  if (body?.status === 428)
    return "This edit is missing its version stamp. Reload the record and try again.";
  if (body?.status === 422)
    return "The server refused this request as invalid. If you were paging a list, start again from the first page.";
  if (body?.status === 401)
    return "This action needs a step-up re-authentication. Sign in again, then retry.";
  if (body?.status === 403)
    return "You do not hold the authority this action requires for this record.";
  if (body?.status === 404)
    return "Not found — either it does not exist, or it is outside your reach. The server does not distinguish the two.";
  if (body?.status === 503)
    return "A dependency this write needs is not available right now. Nothing was recorded.";
  return fallback;
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────────────

/** §4.1 row 26 — the supervisor live-awareness board. NO coordinates on this DTO (D6). */
export async function getDashboard(
  client: ApiClient,
  query: { locationId?: string; supervisorMembershipId?: string; asOf?: string } = {},
): Promise<{ board: SafetyDashboardView | null; error: unknown }> {
  const res = await client.GET("/api/v1/safety/dashboard", { params: { query } } as never);
  if (res.error) return { board: null, error: res.error };
  return { board: res.data as unknown as SafetyDashboardView, error: null };
}

/** §4.1 row 11 — every SOS still open. Not a cursor page: the active set is small by construction, and a
 *  board that paged would hide the fourth simultaneous emergency behind a "next" button. */
export async function listActiveSos(
  client: ApiClient,
): Promise<{ active: ActiveSosView | null; error: unknown }> {
  const res = await client.GET("/api/v1/safety/sos/active", {} as never);
  if (res.error) return { active: null, error: res.error };
  return { active: res.data as unknown as ActiveSosView, error: null };
}

/** §4.1 row 9 — one alert with its ledger and its acknowledgment chain. */
export async function getSosAlert(
  client: ApiClient,
  sosAlertId: string,
): Promise<{ alert: SafetySosAlertView | null; error: unknown }> {
  const res = await client.GET("/api/v1/safety/sos/{sosAlertId}", {
    params: { path: { sosAlertId } },
  } as never);
  if (res.error) return { alert: null, error: res.error };
  return { alert: res.data as unknown as SafetySosAlertView, error: null };
}

/**
 * §4.1 row 10 — the D6 coordinate stream: its own permission, its own predicate, its own `warn`-severity
 * audit row, and — once the alert has closed — a ≥40-character `accessReason` the clinician herself later
 * sees on her consent surface (§6, §8.7). This is the only helper in the file that reads a latitude, and
 * the only one whose call leaves a trace naming the caller.
 */
export async function getLocationStream(
  client: ApiClient,
  sosAlertId: string,
  query: { limit?: number; cursor?: string; accessReason?: string } = {},
): Promise<{ stream: SosLocationStreamPage | null; error: unknown }> {
  const res = await client.GET("/api/v1/safety/sos/{sosAlertId}/location-stream", {
    params: { path: { sosAlertId }, query },
  } as never);
  if (res.error) return { stream: null, error: res.error };
  return { stream: res.data as unknown as SosLocationStreamPage, error: null };
}

/** §4.1 row 13 — the incident ledger, scoped server-side to what the caller may read. */
export async function listIncidents(
  client: ApiClient,
  query: { limit?: number; cursor?: string; lifecycleState?: string; oshaReportable?: boolean } = {},
): Promise<{ page: CursorPage<SafetyIncidentView> | null; error: unknown }> {
  const res = await client.GET("/api/v1/safety/incidents", { params: { query } } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<SafetyIncidentView>, error: null };
}

/** §4.1 row 13 — one incident. */
export async function getIncident(
  client: ApiClient,
  incidentId: string,
): Promise<{ incident: SafetyIncidentView | null; error: unknown }> {
  const res = await client.GET("/api/v1/safety/incidents/{incidentId}", {
    params: { path: { incidentId } },
  } as never);
  if (res.error) return { incident: null, error: res.error };
  return { incident: res.data as unknown as SafetyIncidentView, error: null };
}

/** §4.1 row 2 — one check-in. The ONLY read that answers `amendableUntil`, which is why the amend flow
 *  goes through it rather than computing the five-minute grace from a client clock. */
export async function getCheckIn(
  client: ApiClient,
  checkInId: string,
): Promise<{ checkIn: SafetyCheckInView | null; error: unknown }> {
  const res = await client.GET("/api/v1/safety/check-ins/{checkInId}", {
    params: { path: { checkInId } },
  } as never);
  if (res.error) return { checkIn: null, error: res.error };
  return { checkIn: res.data as unknown as SafetyCheckInView, error: null };
}

/** §4.1 row 4 — the clinician's own obligations and posts. `from`/`to` widen the default ±24h window,
 *  which is how §5.1's "last 90 days" personal history is asked for. Scoped to the SESSION's membership
 *  inside the read service, so it cannot be pointed at a colleague. */
export async function getMyDay(
  client: ApiClient,
  query: { limit?: number; cursor?: string; from?: string; to?: string } = {},
): Promise<{ day: SafetyMyDayView | null; error: unknown }> {
  const res = await client.GET("/api/v1/safety/check-ins/me/today", { params: { query } } as never);
  if (res.error) return { day: null, error: res.error };
  return { day: res.data as unknown as SafetyMyDayView, error: null };
}

/** §4.1 row 18 — the effective policy. `asOf` is §2.2.4's REPLAY arm: a 2031 review of a 2026 incident
 *  has to read the 2026 thresholds, and reading today's would turn a policy that TIGHTENED into a
 *  regression that never happened. */
export async function getPolicy(
  client: ApiClient,
  asOf?: string,
): Promise<{ policy: SafetyPolicyView | null; error: unknown }> {
  const res = await client.GET("/api/v1/safety/policy", {
    params: { query: asOf ? { asOf } : {} },
  } as never);
  if (res.error) return { policy: null, error: res.error };
  return { policy: res.data as unknown as SafetyPolicyView, error: null };
}

/** §4.1 row 20 — who watches whom (D8). */
export async function listSubscriptions(
  client: ApiClient,
  query: {
    limit?: number;
    cursor?: string;
    clinicianMembershipId?: string;
    supervisorMembershipId?: string;
  } = {},
): Promise<{ page: CursorPage<SafetySubscriptionView> | null; error: unknown }> {
  const res = await client.GET("/api/v1/safety/supervisor-subscriptions", {
    params: { query },
  } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<SafetySubscriptionView>, error: null };
}

/** §4.1 row 23 — the advisory polygons. `includeExpired` defaults FALSE server-side: the pre-visit
 *  advisory must never surface a polygon retired last winter; the EDITOR asks for history explicitly. */
export async function listHighRiskAreas(
  client: ApiClient,
  query: { limit?: number; cursor?: string; includeExpired?: boolean } = {},
): Promise<{ page: CursorPage<SafetyHighRiskAreaView> | null; error: unknown }> {
  const res = await client.GET("/api/v1/safety/high-risk-areas", { params: { query } } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<SafetyHighRiskAreaView>, error: null };
}

/** §4.1 row 27 — my own consents. */
export async function getConsents(
  client: ApiClient,
  purpose?: string,
): Promise<{ surface: SafetyConsentSurface | null; error: unknown }> {
  const res = await client.GET("/api/v1/safety/consent", {
    params: { query: purpose ? { purpose } : {} },
  } as never);
  if (res.error) return { surface: null, error: res.error };
  return { surface: res.data as unknown as SafetyConsentSurface, error: null };
}

// ── check-in writes (§4.1 rows 1, 3) ───────────────────────────────────────────────────────────────────

/** Row 1 — post an attestation. No `If-Match`: there is no row yet. The idempotency key is what protects
 *  a double-tapped button on one bar of signal. The acting membership is stamped from the SESSION, so a
 *  caller cannot post an attestation as somebody else whatever they send. */
export async function recordCheckIn(
  client: ApiClient,
  body: {
    visitId?: string;
    scheduleId?: string;
    kind: string;
    status: string;
    concernNote?: string;
    postedCoordinates?: { latitude: number; longitude: number; accuracyM: number };
    postedViaDeviceId?: string;
  },
): Promise<{ result: RecordCheckInResult | null; error: unknown }> {
  const res = await client.POST("/api/v1/safety/check-ins", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { result: null, error: res.error };
  return { result: res.data as unknown as RecordCheckInResult, error: null };
}

/** Row 3 — amend within the five-minute grace. A correction is a NEW row that SUPERSEDES (§2.2.1); the
 *  original stays readable because it is what the supervisor may already have acted on. */
export async function amendCheckIn(
  client: ApiClient,
  checkInId: string,
  body: { status?: string; concernNote?: string; amendmentReason: string },
): Promise<{ checkIn: SafetyCheckInView | null; error: unknown }> {
  const res = await client.PATCH("/api/v1/safety/check-ins/{checkInId}", {
    params: { path: { checkInId } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { checkIn: null, error: res.error };
  return { checkIn: res.data as unknown as SafetyCheckInView, error: null };
}

// ── SOS writes (§4.1 rows 5-8) ─────────────────────────────────────────────────────────────────────────

/**
 * Row 5 — THE PRESS. Deliberately sends NO `Idempotency-Key` (see the module header): §4.1's Idempotent
 * column says `no`, and M20-F10 makes every press its own call for help.
 *
 * `postedCoordinates` is OPTIONAL because M20-F16 is the opposite of §4.2's sketch: a clinician who
 * declined `sos_coordinates` consent still presses the button and the alert still fans out, with the
 * recipients told there is no location. A required coordinate would either refuse her press — the one
 * refusal S13 forbids — or force this client to fabricate one.
 */
export async function raiseSos(
  client: ApiClient,
  body: {
    postedViaDeviceId?: string;
    postedCoordinates?: { latitude: number; longitude: number; accuracyM: number };
    lastKnownVisitId?: string;
    capturedAt?: string;
    localIdempotencyKey?: string;
    offlineSync?: boolean;
  } = {},
): Promise<{ result: RaiseSosResult | null; error: unknown }> {
  const res = await client.POST("/api/v1/safety/sos", { body } as never);
  if (res.error) return { result: null, error: res.error };
  return { result: res.data as unknown as RaiseSosResult, error: null };
}

/** Row 6 — the D5 cancel. No `If-Match` (see the module header). A REJECTED cancel comes back 200 with
 *  `cancel_attempted_but_rejected`, and the alert PROCEEDS — the screen says so in words. */
export async function cancelSos(
  client: ApiClient,
  sosAlertId: string,
  body: { biometricVerificationToken?: string } = {},
): Promise<{ result: CancelSosResult | null; error: unknown }> {
  const res = await client.POST("/api/v1/safety/sos/{sosAlertId}/cancel", {
    params: { path: { sosAlertId } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { result: null, error: res.error };
  return { result: res.data as unknown as CancelSosResult, error: null };
}

/** Row 7 — a responder answers. The §2.2.6 acknowledgment row is written in the SAME transaction, so an
 *  `acknowledged` alert nobody signed is unrepresentable. `actionTaken` is ≥40 chars: §2.2.6's CRITICAL
 *  tier wants what was DONE, not "ack". */
export async function acknowledgeSos(
  client: ApiClient,
  sosAlertId: string,
  version: number,
  body: { actionTaken: string; outcome?: string; outreachPhoneNumberMasked?: string },
): Promise<{ alert: SafetySosAlertView | null; error: unknown }> {
  const res = await client.POST("/api/v1/safety/sos/{sosAlertId}/acknowledge", {
    params: { path: { sosAlertId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { alert: null, error: res.error };
  return { alert: res.data as unknown as SafetySosAlertView, error: null };
}

/** Row 8 — resolve, or convert into an incident. `openIncidentFromOutcome` dispatches to a DIFFERENT
 *  §2.2.2 command, because `resolved` and `incident_opened` are different terminal states. */
export async function resolveSos(
  client: ApiClient,
  sosAlertId: string,
  version: number,
  body: { resolutionNarrative: string; outcome: string; openIncidentFromOutcome?: boolean },
): Promise<{ alert: SafetySosAlertView | null; error: unknown }> {
  const res = await client.POST("/api/v1/safety/sos/{sosAlertId}/resolve", {
    params: { path: { sosAlertId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { alert: null, error: res.error };
  return { alert: res.data as unknown as SafetySosAlertView, error: null };
}

// ── incident writes (§4.1 rows 12, 14-17) ──────────────────────────────────────────────────────────────

/** Row 12 — open a draft. `oshaReportable` is deliberately ABSENT from the body: D9 makes the
 *  classification a separate, step-up'd act by a supervisor, and a create that could assert it would file
 *  with a state agency on the clinician's own say-so. */
export async function createIncident(
  client: ApiClient,
  body: {
    affectedClinicianMembershipId: string;
    category: string;
    severity: string;
    visitId?: string;
    patientId?: string;
    occurredAt: string;
    locationDescription?: string;
    narrative: string;
    witnesses?: string;
    linkedSosAlertId?: string;
    workersCompClaimInitiated?: boolean;
    workersCompClaimReference?: string;
  },
): Promise<{ incident: SafetyIncidentView | null; error: unknown }> {
  const res = await client.POST("/api/v1/safety/incidents", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { incident: null, error: res.error };
  return { incident: res.data as unknown as SafetyIncidentView, error: null };
}

/** Row 14 — edit a draft (or a supervisor's edit-on-behalf-of). REQUIRES `If-Match`. */
export async function patchIncident(
  client: ApiClient,
  incidentId: string,
  version: number,
  body: {
    category?: string;
    severity?: string;
    occurredAt?: string;
    locationDescription?: string;
    narrative?: string;
    witnesses?: string;
    workersCompClaimInitiated?: boolean;
    workersCompClaimReference?: string;
  },
): Promise<{ incident: SafetyIncidentView | null; error: unknown }> {
  const res = await client.PATCH("/api/v1/safety/incidents/{incidentId}", {
    params: { path: { incidentId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { incident: null, error: res.error };
  return { incident: res.data as unknown as SafetyIncidentView, error: null };
}

/** Row 15 — submit for review. `oshaReportable: true` without an existing sign-off is a 422 that names
 *  the fix (D9) — the flag on this body can only ever LOWER the bar for the clinician filing. */
export async function submitIncident(
  client: ApiClient,
  incidentId: string,
  version: number,
  body: { oshaReportable: boolean; finalNarrative?: string },
): Promise<{ incident: SafetyIncidentView | null; error: unknown }> {
  const res = await client.POST("/api/v1/safety/incidents/{incidentId}/submit", {
    params: { path: { incidentId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { incident: null, error: res.error };
  return { incident: res.data as unknown as SafetyIncidentView, error: null };
}

/** Row 16 — the supervisor state machine (§2.2.3). `reopened` re-enters review on the SAME row, because a
 *  second row would break the workers-comp timeline an insurer reads. */
export async function transitionIncident(
  client: ApiClient,
  incidentId: string,
  version: number,
  body: { toState: string; reason: string; actionPlan?: string },
): Promise<{ incident: SafetyIncidentView | null; error: unknown }> {
  const res = await client.POST("/api/v1/safety/incidents/{incidentId}/state", {
    params: { path: { incidentId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { incident: null, error: res.error };
  return { incident: res.data as unknown as SafetyIncidentView, error: null };
}

/** Row 17 — §7.6 / D9's OSHA-equivalent sign-off (STEP-UP). `stateCode` and `reportingWindowHours` are
 *  REQUIRED and not derived: the classification is state-specific, M20 holds no state-OSHA rule table, and
 *  a defaulted window would put a number on a filing deadline nobody chose. */
export async function oshaSignoff(
  client: ApiClient,
  incidentId: string,
  version: number,
  body: {
    oshaReportable: boolean;
    reason: string;
    stateCode: string;
    reportingWindowHours: number;
  },
): Promise<{ incident: SafetyIncidentView | null; error: unknown }> {
  const res = await client.POST("/api/v1/safety/incidents/{incidentId}/osha-signoff", {
    params: { path: { incidentId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { incident: null, error: res.error };
  return { incident: res.data as unknown as SafetyIncidentView, error: null };
}

// ── policy / subscription / area writes (§4.1 rows 19, 21-22, 24-25) ───────────────────────────────────

/** Row 19 — edit the tenant policy (STEP-UP). Tighten-only against the platform floor: a knob outside its
 *  band is a 422 NAMING the knob and its band, never a silently accepted loosening. */
export async function patchPolicy(
  client: ApiClient,
  version: number | null,
  body: Record<string, unknown> & { editReason: string },
): Promise<{ policy: SafetyPolicyView | null; error: unknown }> {
  const res = await client.PATCH("/api/v1/safety/policy", {
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { policy: null, error: res.error };
  return { policy: res.data as unknown as SafetyPolicyView, error: null };
}

/** Row 21 — add a subscription. The scope-selector pairing is re-checked server-side so the DON is told
 *  WHICH selector is missing rather than shown a constraint name. */
export async function createSubscription(
  client: ApiClient,
  body: {
    supervisorMembershipId: string;
    scopeKind: string;
    clinicianMembershipId?: string;
    locationId?: string;
    providerEntityId?: string;
    alertKinds: string[];
    isVacationForwarding?: boolean;
    vacationForwardToMembershipId?: string;
  },
): Promise<{ subscription: SafetySubscriptionView | null; error: unknown }> {
  const res = await client.POST("/api/v1/safety/supervisor-subscriptions", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { subscription: null, error: res.error };
  return { subscription: res.data as unknown as SafetySubscriptionView, error: null };
}

/** Row 22 — deactivate a subscription. A SOFT deactivation, never a row delete: §3.7's retention keeps the
 *  paging configuration as evidence of who was watching whom on the night an incident happened. The call
 *  SUCCEEDS even when it uncovers clinicians — refusing would leave a departed supervisor's row in place,
 *  which is the worse failure one step earlier — and the gaps it created ride the response. */
export async function deleteSubscription(
  client: ApiClient,
  subscriptionId: string,
): Promise<{ result: DeleteSubscriptionResult | null; error: unknown }> {
  const res = await client.DELETE("/api/v1/safety/supervisor-subscriptions/{subscriptionId}", {
    params: { path: { subscriptionId } },
    headers: writeHeaders(),
  } as never);
  if (res.error) return { result: null, error: res.error };
  return { result: res.data as unknown as DeleteSubscriptionResult, error: null };
}

/** Row 24 — draw an advisory polygon (D12). Ring closure and the ≥4-point minimum are validated in app
 *  code at the moment the Compliance Officer draws it — not on the night a clinician is standing in it. */
export async function createHighRiskArea(
  client: ApiClient,
  body: {
    riskCategory: string;
    advisoryMessage: string;
    polygon: [number, number][][];
    policyForVisitsToArea?: string;
    effectiveFrom?: string;
    effectiveTo?: string;
  },
): Promise<{ area: SafetyHighRiskAreaView | null; error: unknown }> {
  const res = await client.POST("/api/v1/safety/high-risk-areas", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { area: null, error: res.error };
  return { area: res.data as unknown as SafetyHighRiskAreaView, error: null };
}

/** Row 25 — edit or RETIRE an area. Retiring is `effectiveTo`, never a delete: an incident review has to
 *  be able to ask what advisory was in force on the day. */
export async function patchHighRiskArea(
  client: ApiClient,
  areaId: string,
  body: {
    riskCategory?: string;
    advisoryMessage?: string;
    polygon?: [number, number][][];
    policyForVisitsToArea?: string;
    effectiveTo?: string;
  },
): Promise<{ area: SafetyHighRiskAreaView | null; error: unknown }> {
  const res = await client.PATCH("/api/v1/safety/high-risk-areas/{areaId}", {
    params: { path: { areaId } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { area: null, error: res.error };
  return { area: res.data as unknown as SafetyHighRiskAreaView, error: null };
}

// ── consent writes (§4.1 rows 28-29) ───────────────────────────────────────────────────────────────────

/** Row 28 — grant one purpose. The three are separately grantable (M20-F16): declining `sos_coordinates`
 *  never disables SOS. `acknowledgmentTextSnapshot` is REQUIRED and is what a consent dispute turns on —
 *  the screen sends the exact text it displayed, not a summary of it. */
export async function grantConsent(
  client: ApiClient,
  body: {
    purpose: string;
    acknowledgmentTextSnapshot: string;
    expiresAt?: string;
    contact?: { name: string; phone: string; relationship?: string };
  },
): Promise<{ consent: SafetyConsentView | null; error: unknown }> {
  const res = await client.POST("/api/v1/safety/consent/grant", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { consent: null, error: res.error };
  return { consent: res.data as unknown as SafetyConsentView, error: null };
}

/** Row 29 — revoke one purpose. Writes `revoked`, never `expired`: the rotation sweep owns the second, and
 *  a coercion review reads exactly that difference (§2.2.8). */
export async function revokeConsent(
  client: ApiClient,
  body: { purpose: string; reason?: string },
): Promise<{ consent: SafetyConsentView | null; error: unknown }> {
  const res = await client.POST("/api/v1/safety/consent/revoke", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { consent: null, error: res.error };
  return { consent: res.data as unknown as SafetyConsentView, error: null };
}
