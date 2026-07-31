// apps/web/src/modules/19-oncall — the M19 read/write access layer the §5 screens share
// (Track B / ADR-0030, ADR-0032).
//
// The wire shapes below MIRROR the server's response DTOs
// (apps/backend/src/modules/19-oncall/routes/read-service.ts + write-service.ts). They are declared here —
// not imported — because apps/web may never compile-import the backend (dependency-cruiser); the generated
// client (`packages/ui/src/core/api`) is the contract. M19's routes are enriched with their §4.2 request
// bodies/queries, so every CALL is typed; the RESPONSE bodies are not TypeBox-published, so each read is
// cast at exactly one place — here — instead of being re-cast ad hoc in fifteen screens.
//
// FOUR SERVER CONTRACTS EVERY HELPER HONOURS.
//
//   • ADR-0021 — a mutating route requires an `Idempotency-Key`. Every helper mints a fresh one per attempt.
//   • §2.5 — a state transition requires `If-Match`, and M19's ETag is the row's INTEGER `version`, not a
//     timestamp (unlike M21's `updated_at`). A 412 means the row moved under you — reload, never retry
//     blind. §2.5's own case is the ordinary one: a supervisor reading the call while the RN answers
//     question 4, whose disposition would otherwise silently overwrite two answers.
//   • §4.1.1 — offset pagination is REFUSED (400) on every PHI list; the cursor is opaque and HMAC-SIGNED,
//     and a tampered one is a 422, not a silent page 1. Nothing here parses or constructs a cursor.
//   • D5 — `red_flag_hit` is the SERVER's evaluation and is absent from every request body. A client that
//     could assert it could assert its absence, which is the cheapest way to walk a red-flag question past
//     `completeProtocol`.
//
// The server stays the only authorization point: nothing here decides what a caller may see. An
// out-of-scope call is a non-leaking 404 from the server, never a frontend hide — deliberately, because
// "this call 403s" would tell an unauthorized caller that a particular patient rang the after-hours line.
import type { ApiClient } from "@wardenx/ui";

// ── wire shapes (mirror of the §4.1 response DTOs) ─────────────────────────────────────────────────────

/**
 * §4.1.1's paginated envelope. There is NO `total_count` field, deliberately: §4.1.1 forbids it because a
 * count is an enumeration oracle — a caller who cannot read another ProviderEntity's calls can still learn
 * how many there were. Every KPI on an M19 screen is therefore page-derived and says so.
 */
export interface CursorPage<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

/** §4.1 row 2 — one row of the supervisor board / caseload list. Carries NO caller free text: the phone,
 *  the quote and the chief-complaint prose live on the DETAIL DTO only, which is the difference between a
 *  supervisor opening one call and a list endpoint spraying callers' words into a browser cache. */
export interface TriageCallListItem {
  id: string;
  providerEntityId: string;
  patientId: string | null;
  state: string;
  disposition: string | null;
  callerKind: string;
  inboundChannel: string;
  source: string;
  chiefComplaintSnomed: string | null;
  openedAt: string;
  firstResponseAt: string | null;
  closedAt: string | null;
  /** The catalog label of the pinned protocol — never the caller's words. */
  protocolLabel: string | null;
  /** Non-zero means somebody must look: the board sorts on it. */
  openEscalationCount: number;
  redFlagAnswerCount: number;
  /** The `If-Match` value a transition on this row must echo (§2.5) — an INTEGER, not a stamp. */
  version: number;
}

/** One answer on a call, as the §5.1 stepper renders it (§2.2.3 amend-by-append: corrections are ROWS, so
 *  a "no" later corrected to "yes" still shows that the call HAD a red flag). */
export interface TriageAnswerView {
  id: string;
  questionId: string;
  questionOrder: number;
  prompt: string;
  answerType: string;
  valueText: string | null;
  valueInt: number | null;
  valueBool: boolean | null;
  /** D5 — the SERVER's evaluation. Deliberately outside the §3.6 denylist: it is the tamper-evidence a
   *  suppression investigation reads. */
  redFlagHit: boolean;
  correctionOfAnswerId: string | null;
  answeredAt: string;
  answeredByMembershipId: string;
}

/** One escalation on a call. */
export interface TriageEscalationView {
  id: string;
  tier: string;
  triggerKind: string;
  state: string;
  /** D7 — a `mandatory_protocol` row may NOT be auto-resolved by a call close (§2.2.4). */
  mandatory: boolean;
  escalatedToMembershipId: string | null;
  escalatedToExternalActorId: string | null;
  escalatedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolvedByMembershipId: string | null;
}

/** One `triage_call_state_history` row — the call's own ordered narrative (§2.7's outage-gap scan). */
export interface TriageStateHistoryView {
  id: string;
  fromState: string | null;
  toState: string;
  transitionedAt: string;
  actorMembershipId: string | null;
  systemActor: boolean;
}

/** One M12-sourced slice of the D15 medication context. `unavailable` is not an error the panel must
 *  handle to render — it is a FACT the panel shows, which is the difference between a clinician who knows
 *  they are working blind and one who does not. */
export type MedicationSlice<T> =
  | { kind: "ready"; items: T[] }
  | { kind: "unavailable"; reason: string };

export interface TriageMedicationSummary {
  medicationOrderId: string;
  display: string;
  route: string;
  asNeeded: boolean;
  isControlledSubstance: boolean;
  deaSchedule: string | null;
  isRedacted: boolean;
}

export interface TriageRefillSummary {
  refillRequestId: string;
  sourceMedicationOrderId: string;
  requestedAt: string;
  requestedQuantity: number | null;
}

/** D15 — the medication/refill context the panel shows, with per-slice availability. */
export interface TriageMedicationContext {
  activeMedications: MedicationSlice<TriageMedicationSummary>;
  pendingRefills: MedicationSlice<TriageRefillSummary>;
  /** How many active medications were withheld under the 42 CFR Part 2 gate — a COUNT, never the rows. */
  sudRedactedCount: number;
}

/**
 * §4.1 row 3 — the full STAFF projection of one call.
 *
 * The server returns either this or {@link VendorTriageCallView} depending on the session class; the vendor
 * projection is a DIFFERENT TYPE, not a filtered one (§8.3.1), so it has no field for the caller's phone,
 * the quote, the transcript or the free-text complaint and no later edit can widen it into one. The screens
 * read through {@link isStaffProjection} rather than probing for a field.
 */
export interface TriageCallDetail extends TriageCallListItem {
  locationId: string | null;
  admissionId: string | null;
  callerDisplayName: string | null;
  /** §3.6-denylisted; present for the staff projection, absent from the vendor one. */
  callerPhoneE164: string | null;
  callerRelationshipLabel: string | null;
  callerCaregiverId: string | null;
  chiefComplaintText: string | null;
  onCallShiftId: string;
  selectedProtocolId: string | null;
  selectedProtocolVersion: string | null;
  /** D12 — ADVISORY. Recorded and displayed; gates nothing. */
  suggestedProtocolId: string | null;
  suggestedProtocolConfidence: string | null;
  /** D11 — ADVISORY. Excluded from the M31 portal projection by construction. */
  hospitalizationRiskBand: string | null;
  dispositionData: Record<string, unknown> | null;
  linkedEncounterId: string | null;
  linkedVerbalOrderIds: string[];
  linkedVisitProposalId: string | null;
  paperOriginFlag: boolean;
  paperOriginalOpenedAt: string | null;
  documentedAt: string | null;
  answers: TriageAnswerView[];
  escalations: TriageEscalationView[];
  stateHistory: TriageStateHistoryView[];
  /** §7.1 — the SERVER's own cursor through the protocol. The panel renders from it and cannot move it. */
  nextQuestionId: string | null;
  /** §7.3 / D6 — what THIS actor's selector may offer. Server and UI refuse the same set. */
  permittedDispositions: string[];
  medicationContext: TriageMedicationContext | null;
  /** §8.2 — categories this caller is NOT cleared for on this call. */
  redactedCategories: string[];
  /** §7.2 — true when a mandatory escalation is unacknowledged; the disposition block, rendered. */
  dispositionBlockedByMandatoryEscalation: boolean;
}

/** §7.5 / D13 — the PHI-minimized projection an external-vendor operator reads. */
export interface VendorTriageCallView {
  id: string;
  providerEntityId: string;
  state: string;
  callerKind: string;
  inboundChannel: string;
  chiefComplaintSnomed: string | null;
  openedAt: string;
  onCallShiftId: string;
  selectedProtocolId: string | null;
  selectedProtocolVersion: string | null;
  answers: TriageAnswerView[];
  escalations: TriageEscalationView[];
  nextQuestionId: string | null;
  permittedDispositions: string[];
  version: number;
}

/** Either projection — what `GET /triage-calls/:id` actually returns. */
export type TriageCallProjection = TriageCallDetail | VendorTriageCallView;

/**
 * Which projection did the server send?
 *
 * Keyed on `stateHistory`, which the staff DTO always carries (possibly empty) and the vendor DTO does not
 * declare at all. Deliberately NOT keyed on a nullable PHI field such as `callerPhoneE164`: a staff call
 * from an unknown number has a null phone, so "phone is absent" would misclassify a real staff read as a
 * vendor one and hide the panel's own caller block from the nurse working the call.
 */
export function isStaffProjection(call: TriageCallProjection): call is TriageCallDetail {
  return Array.isArray((call as TriageCallDetail).stateHistory);
}

/** §4.1 row 14 — the step-up, per-access-audited transcript read. Its own DTO, because folding the
 *  plaintext into the detail behind a nullable field would mean every detail read had to be TRUSTED not to
 *  have populated it. */
export interface TriageTranscriptView {
  triageCallId: string;
  transcript: string | null;
  callerQuote: string | null;
  decryptedAt: string;
}

/** §4.1 row 16 — one row of the escalation inbox. */
export interface EscalationInboxItem extends TriageEscalationView {
  triageCallId: string;
  providerEntityId: string;
  patientId: string | null;
  callState: string;
  /** Minutes the row has been open — what the §4.8 SLA worker and this inbox both sort on. */
  minutesOpen: number;
  version: number;
}

/** §4.1 rows 19-23 — one `on_call_shift` row. Exactly one of `primaryOnCallMembershipId` /
 *  `externalActorId` is non-null (§3.3 `actorIntegrity`). */
export interface OnCallShiftView {
  id: string;
  providerEntityId: string;
  shiftStartsAt: string;
  shiftEndsAt: string;
  discipline: string;
  status: string;
  primaryOnCallMembershipId: string | null;
  backupMembershipId: string | null;
  externalActorId: string | null;
  externalActorLabel: string | null;
  openedAt: string | null;
  closedAt: string | null;
  m17VisitAssignmentRef: string | null;
  cancellationReason: string | null;
  version: number;
}

/** One actor currently on call. DISCRIMINATED, because an external vendor actor has no membership and no
 *  user id — a flat DTO with a nullable `userId` would let a vendor-covered night resolve to an empty
 *  recipient list that LOOKS like a normal result. */
export type OnCallActor =
  | {
      kind: "membership";
      shiftId: string;
      membershipId: string;
      userId: string;
      discipline: string;
      isBackup: boolean;
      shiftStartsAt: string;
      shiftEndsAt: string;
    }
  | {
      kind: "external_vendor";
      shiftId: string;
      externalActorId: string;
      externalActorLabel: string | null;
      discipline: "external";
      shiftStartsAt: string;
      shiftEndsAt: string;
    };

/**
 * §4.1 row 24 — who is on call NOW, keyed PER ProviderEntity and never unioned.
 *
 * CoP 418.100(c)(2) is per-CCN, so a union across PEs lets one covered entity mask another's dark night.
 * `actors: []` for a PE is a REAL answer — a coverage gap — not an empty result, and the roster screen
 * renders it as a finding rather than as nothing.
 */
export interface CurrentOnCallView {
  asOf: string;
  perProviderEntity: {
    providerEntityId: string;
    actors: OnCallActor[];
    /** True when no `clinical_rn` actor covers `asOf` — the CoP coverage floor, per PE. */
    rnCoverageGap: boolean;
  }[];
}

/** §4.1 rows 25-26 — the tenant policy row. The three JSON columns are `unknown` on the wire because §4.2
 *  types them as free-form records; the screen renders them as data and never pretends to know a key. */
export interface OncallPolicyView {
  id: string;
  providerEntityId: string;
  model: string;
  escalationTiers: unknown;
  callbackSlaPerSeverity: unknown;
  stateOverrides: unknown;
  externalTriageVendorId: string | null;
  emergencyContactE164: string | null;
  aiProtocolSuggestionEnabled: boolean;
  aiHospitalizationRiskEnabled: boolean;
  version: number;
}

/** §4.1 rows 27-32 — one catalog question. */
export interface TriageProtocolQuestionView {
  id: string;
  questionOrder: number;
  prompt: string;
  answerType: string;
  answerEnumValues: string[] | null;
  required: boolean;
  isRedFlagQuestion: boolean;
  redFlagMatch: unknown;
  isSystemLocked: boolean;
}

/** §4.1 rows 27-32 — one protocol. `organizationId === null` is the platform floor every tenant reads and
 *  no tenant may write (migration 0108's policies; the write service refuses first, with the key named). */
export interface TriageProtocolView {
  id: string;
  organizationId: string | null;
  key: string;
  chiefComplaintLabel: string;
  snomedCode: string;
  disciplineRequired: string;
  isSystemLocked: boolean;
  requiresMandatoryEscalation: boolean;
  mandatoryEscalationTier: string | null;
  version: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sortOrder: number;
  questions: TriageProtocolQuestionView[];
}

/** §4.1 rows 33-35 — one vendor binding. NO secret is ever projected (ADR-0026: none is stored). */
export interface VendorBindingView {
  id: string;
  mdmVendorId: string;
  name: string;
  adapterKey: string;
  rnCoverageAttested: boolean;
  baaInEffect: boolean;
  baaExpiresOn: string | null;
  minimizationProfile: string;
  /** §8.5 — is an adapter for this key actually REGISTERED right now? A binding whose adapter is not
   *  loaded cannot carry calls, and the admin screen must be able to say so before 2 a.m. */
  adapterRegistered: boolean;
}

/** §2.7 — one outstanding paper-re-entry worklist row (the DON's BCP list). */
export interface PaperReentryWorklistView {
  id: string;
  providerEntityId: string;
  outageWindowId: string;
  shiftId: string | null;
  shiftStartsAt: string;
  shiftEndsAt: string;
  assignedToMembershipId: string | null;
  reenteredAt: string | null;
  linkedTriageCallId: string | null;
  expiresAt: string;
}

/** §4.2's open response — the created call plus what the D11/D12 advisories had to say about it. */
export interface OpenTriageCallResult {
  triageCallId: string;
  state: string;
  onCallShiftId: string;
  version: number;
  suggestedProtocolId: string | null;
  suggestedProtocolConfidence: string | null;
  hospitalizationRiskBand: string | null;
  /** §8.6 — true when the AI block must render VISIBLY DISABLED (M32 deny-stubbed, or tenant opted out). */
  aiBlockDisabled: boolean;
}

/** §7.1 / §7.2's answer response — the D5 verdict the panel's sticky banner keys off. */
export interface AnswerWriteResult {
  answerId: string;
  redFlagHit: boolean;
  mandatoryEscalationTriggered: boolean;
  escalationId: string | null;
  tier: string | null;
  nextQuestionId: string | null;
  version: number;
}

/** The §4.2 discriminated answer value — exactly one typed value, as a TYPE fact before it is a
 *  `num_nonnulls(...) = 1` CHECK. */
export type TriageAnswerValue =
  | { kind: "text"; value: string }
  | { kind: "int"; value: number }
  | { kind: "bool"; value: boolean };

// ── request helpers ────────────────────────────────────────────────────────────────────────────────────

/** ADR-0021 — a fresh client idempotency key per mutation attempt. */
export function idemKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `m19-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

/**
 * §2.5 — the mutation headers. `If-Match` carries the INTEGER row `version` the caller READ.
 *
 * Passing `undefined` is for the routes that have no row to have read (`POST /triage-calls`, the §2.7
 * paper re-entry, `POST /oncall/shifts`, the protocol/vendor creates); every state transition passes the
 * version, and omitting it is a 428, not a silent last-write-wins.
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
 * screen can actually violate (412 = the row moved, 428 = a blind write, 422 = a stale/forged cursor or an
 * invalid body, 403 = a §4.7 predicate refused) rather than a generic failure. A 404 is deliberately
 * ambiguous — "absent OR out of your reach" — and the copy says so instead of guessing.
 */
export function errorMessage(error: unknown, fallback: string): string {
  const body = error as { title?: string; detail?: string; code?: string; status?: number } | null;
  if (body?.detail) return body.detail;
  if (body?.title) return body.title;
  if (body?.status === 412)
    return "This call changed while you were working on it. Reload and re-apply your edit — do not retry blind.";
  if (body?.status === 428)
    return "This edit is missing its version stamp. Reload the record and try again.";
  if (body?.status === 422)
    return "The server refused this request as invalid. If you were paging a list, start again from the first page.";
  if (body?.status === 403)
    return "You do not hold the authority this action requires for this record.";
  if (body?.status === 404)
    return "Not found — either it does not exist, or it is outside your reach. The server does not distinguish the two.";
  return fallback;
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────────────

/** §4.1 row 2 — the supervisor board / caseload list. The server scopes it; a call out of reach is absent. */
export async function listTriageCalls(
  client: ApiClient,
  query: {
    state?: string;
    openOnly?: boolean;
    providerEntityId?: string;
    patientId?: string;
    openedFrom?: string;
    openedTo?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ page: CursorPage<TriageCallListItem> | null; error: unknown }> {
  const res = await client.GET("/api/v1/triage-calls", { params: { query } } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<TriageCallListItem>, error: null };
}

/** §4.1 row 3 — the full call. Returns the STAFF or the VENDOR projection per session class. */
export async function getTriageCall(
  client: ApiClient,
  triageCallId: string,
): Promise<{ call: TriageCallProjection | null; error: unknown }> {
  const res = await client.GET("/api/v1/triage-calls/{triageCallId}", {
    params: { path: { triageCallId } },
  } as never);
  if (res.error) return { call: null, error: res.error };
  return { call: res.data as unknown as TriageCallProjection, error: null };
}

/** §4.1 row 14 — the transcript decrypt: its OWN permission (`triage.read_transcript`), an M2 step-up and a
 *  per-access M4 audit row. Reading this leaves a trace that names you; the screen says so before you ask. */
export async function getTranscript(
  client: ApiClient,
  triageCallId: string,
): Promise<{ transcript: TriageTranscriptView | null; error: unknown }> {
  const res = await client.GET("/api/v1/triage-calls/{triageCallId}/transcript-decrypt", {
    params: { path: { triageCallId } },
  } as never);
  if (res.error) return { transcript: null, error: res.error };
  return { transcript: res.data as unknown as TriageTranscriptView, error: null };
}

/** §4.1 row 16 — the escalation inbox, narrowed server-side to the actor's tier band. `openOnly` defaults
 *  TRUE in the read service: an inbox shows what is outstanding, and a resolved page is history. */
export async function listEscalations(
  client: ApiClient,
  query: { tier?: string; openOnly?: boolean; triageCallId?: string; cursor?: string; limit?: number } = {},
): Promise<{ page: CursorPage<EscalationInboxItem> | null; error: unknown }> {
  const res = await client.GET("/api/v1/escalations", { params: { query } } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<EscalationInboxItem>, error: null };
}

/** §4.1 row 19 — the shift schedule. */
export async function listShifts(
  client: ApiClient,
  query: {
    providerEntityId?: string;
    discipline?: string;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ page: CursorPage<OnCallShiftView> | null; error: unknown }> {
  const res = await client.GET("/api/v1/oncall/shifts", { params: { query } } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<OnCallShiftView>, error: null };
}

/** §4.1 row 24 — who is on call NOW, per ProviderEntity, with the per-PE RN coverage verdict beside each. */
export async function getCurrentOnCall(
  client: ApiClient,
  query: { providerEntityId?: string; asOf?: string } = {},
): Promise<{ current: CurrentOnCallView | null; error: unknown }> {
  const res = await client.GET("/api/v1/oncall/current", { params: { query } } as never);
  if (res.error) return { current: null, error: res.error };
  return { current: res.data as unknown as CurrentOnCallView, error: null };
}

/** §4.1 row 25 — the tenant policy for one ProviderEntity. NOT auto-created on read: D7 pins this row onto
 *  every shift that opens, and a default invented at read time would be pinned as though the tenant had
 *  chosen it. A 404 here means "no policy authored yet", and the screen says exactly that. */
export async function getPolicy(
  client: ApiClient,
  providerEntityId: string,
): Promise<{ policy: OncallPolicyView | null; error: unknown }> {
  const res = await client.GET("/api/v1/oncall/policy", {
    params: { query: { providerEntityId } },
  } as never);
  if (res.error) return { policy: null, error: res.error };
  return { policy: res.data as unknown as OncallPolicyView, error: null };
}

/** §4.1 row 27 — the catalog: the platform floor plus this tenant's own rows (D4), effective-dated. */
export async function listProtocols(
  client: ApiClient,
  query: {
    effectiveOnly?: boolean;
    disciplineRequired?: string;
    search?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ page: CursorPage<TriageProtocolView> | null; error: unknown }> {
  const res = await client.GET("/api/v1/triage-protocols", { params: { query } } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<TriageProtocolView>, error: null };
}

/** §4.1 row 28 — one protocol with its ordered questions (what the §5.1 stepper renders from). */
export async function getProtocol(
  client: ApiClient,
  protocolId: string,
): Promise<{ protocol: TriageProtocolView | null; error: unknown }> {
  const res = await client.GET("/api/v1/triage-protocols/{protocolId}", {
    params: { path: { protocolId } },
  } as never);
  if (res.error) return { protocol: null, error: res.error };
  return { protocol: res.data as unknown as TriageProtocolView, error: null };
}

/** §4.1 row 33 — the tenant's vendor bindings, each with whether its §8.5 adapter is actually loaded. */
export async function listVendorBindings(
  client: ApiClient,
): Promise<{ bindings: VendorBindingView[] | null; error: unknown }> {
  const res = await client.GET("/api/v1/oncall/external-vendors", {} as never);
  if (res.error) return { bindings: null, error: res.error };
  return { bindings: res.data as unknown as VendorBindingView[], error: null };
}

/** §2.7 — the DON's outstanding BCP re-entry worklist. */
export async function listPaperReentryWorklist(
  client: ApiClient,
): Promise<{ rows: PaperReentryWorklistView[] | null; error: unknown }> {
  const res = await client.GET("/api/v1/triage-calls/paper-reentry/worklist", {} as never);
  if (res.error) return { rows: null, error: res.error };
  return { rows: res.data as unknown as PaperReentryWorklistView[], error: null };
}

// ── triage-call writes (§4.1 rows 1, 4-13) ─────────────────────────────────────────────────────────────

/** Row 1 — open a call. `source` is pinned to `manual` server-side (`OpenableSource`) and the covering
 *  shift is resolved server-side, because letting a caller name the shift lets them attribute their call to
 *  someone else's coverage window — which IS the CoP 418.100(c)(2) record. */
export async function openTriageCall(
  client: ApiClient,
  body: {
    providerEntityId: string;
    inboundChannel: string;
    callerKind: string;
    callerDisplayName?: string;
    callerPhoneE164?: string;
    callerRelationshipLabel?: string;
    patientId?: string;
    admissionId?: string;
    callerCaregiverId?: string;
    chiefComplaintText?: string;
    chiefComplaintSnomed?: string;
    callerQuote?: string;
  },
): Promise<{ result: OpenTriageCallResult | null; error: unknown }> {
  const res = await client.POST("/api/v1/triage-calls", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { result: null, error: res.error };
  return { result: res.data as unknown as OpenTriageCallResult, error: null };
}

/** Row 4 — resolve the caller to a served person. §7.1 runs this before any encounter can open: M8
 *  requires patient AND admission NOT NULL, and both are nullable on `triage_call` until now. */
export async function identifyPatient(
  client: ApiClient,
  triageCallId: string,
  version: number,
  body: { patientId: string; admissionId: string; locationId?: string; callerCaregiverId?: string },
): Promise<{ call: TriageCallProjection | null; error: unknown }> {
  const res = await client.POST("/api/v1/triage-calls/{triageCallId}/identify-patient", {
    params: { path: { triageCallId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { call: null, error: res.error };
  return { call: res.data as unknown as TriageCallProjection, error: null };
}

/** Row 5 — pin the protocol (D4). `aiOverrideReason` is required only above the D12 confidence floor, and
 *  the condition is a fact on the ROW, not in the request — so the server decides, and the form asks for a
 *  reason only when the suggestion it is overriding was at or above the floor. */
export async function applyProtocol(
  client: ApiClient,
  triageCallId: string,
  version: number,
  body: { triageProtocolId: string; aiOverrideReason?: string },
): Promise<{ call: TriageCallProjection | null; error: unknown }> {
  const res = await client.POST("/api/v1/triage-calls/{triageCallId}/apply-protocol", {
    params: { path: { triageCallId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { call: null, error: res.error };
  return { call: res.data as unknown as TriageCallProjection, error: null };
}

/** Row 6 — append one answer. `redFlagHit` comes BACK; it is never sent (D5). */
export async function recordAnswer(
  client: ApiClient,
  triageCallId: string,
  version: number,
  body: { triageProtocolQuestionId: string; value: TriageAnswerValue },
): Promise<{ result: AnswerWriteResult | null; error: unknown }> {
  const res = await client.POST("/api/v1/triage-calls/{triageCallId}/answers", {
    params: { path: { triageCallId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { result: null, error: res.error };
  return { result: res.data as unknown as AnswerWriteResult, error: null };
}

/** Row 7 — append a CORRECTION (§2.2.3 amend-by-append). The original row is PRESERVED. */
export async function correctAnswer(
  client: ApiClient,
  triageCallId: string,
  answerId: string,
  version: number,
  body: { triageProtocolQuestionId: string; value: TriageAnswerValue; correctionReason?: string },
): Promise<{ result: AnswerWriteResult | null; error: unknown }> {
  const res = await client.PATCH("/api/v1/triage-calls/{triageCallId}/answers/{answerId}/correct", {
    params: { path: { triageCallId, answerId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { result: null, error: res.error };
  return { result: res.data as unknown as AnswerWriteResult, error: null };
}

/** Row 8 — close the walk. Both §2.3 gates run in the MACHINE: every required question answered, and no
 *  red-flag escalation still open. The button is offered; the server is the gate. */
export async function completeProtocol(
  client: ApiClient,
  triageCallId: string,
  version: number,
): Promise<{ call: TriageCallProjection | null; error: unknown }> {
  const res = await client.POST("/api/v1/triage-calls/{triageCallId}/complete-protocol", {
    params: { path: { triageCallId } },
    headers: writeHeaders(version),
    body: {},
  } as never);
  if (res.error) return { call: null, error: res.error };
  return { call: res.data as unknown as TriageCallProjection, error: null };
}

/** Row 9 — park on a callback. The call STAYS in the open set, so it keeps its place on the supervisor
 *  board while the §4.8 SLA detector watches the clock. */
export async function markAwaitingCallback(
  client: ApiClient,
  triageCallId: string,
  version: number,
  body: { reason: string; callbackTargetAt?: string },
): Promise<{ call: TriageCallProjection | null; error: unknown }> {
  const res = await client.POST("/api/v1/triage-calls/{triageCallId}/awaiting-callback", {
    params: { path: { triageCallId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { call: null, error: res.error };
  return { call: res.data as unknown as TriageCallProjection, error: null };
}

/** Row 10 — resume the same walk at the SERVER's own cursor. No answer is discarded and none is re-asked. */
export async function resumeAfterCallback(
  client: ApiClient,
  triageCallId: string,
  version: number,
): Promise<{ call: TriageCallProjection | null; error: unknown }> {
  const res = await client.POST("/api/v1/triage-calls/{triageCallId}/resume", {
    params: { path: { triageCallId } },
    headers: writeHeaders(version),
    body: {},
  } as never);
  if (res.error) return { call: null, error: res.error };
  return { call: res.data as unknown as TriageCallProjection, error: null };
}

/** Row 11 — select the disposition (D6). ONE route for both §2.2.1 edges into
 *  `documented_pending_encounter`, so a clinician acting on the medical director's guidance at 2 a.m. does
 *  not have to know which of two routes their call sits behind. */
export async function selectDisposition(
  client: ApiClient,
  triageCallId: string,
  version: number,
  dispositionData: Record<string, unknown>,
): Promise<{ call: TriageCallProjection | null; error: unknown }> {
  const res = await client.POST("/api/v1/triage-calls/{triageCallId}/disposition", {
    params: { path: { triageCallId } },
    headers: writeHeaders(version),
    body: { dispositionData },
  } as never);
  if (res.error) return { call: null, error: res.error };
  return { call: res.data as unknown as TriageCallProjection, error: null };
}

/** Row 12 — invoke M8's `EncounterCreator` (D8). The call does NOT reach `documented` here: that
 *  transition belongs to the `m8.encounter.signed` consumer, so the record advances when the encounter is
 *  SIGNED, not when it is created. */
export async function documentCall(
  client: ApiClient,
  triageCallId: string,
  version: number | null,
  body: { narrativeSummary?: string },
): Promise<{ call: TriageCallProjection | null; error: unknown }> {
  const res = await client.POST("/api/v1/triage-calls/{triageCallId}/document", {
    params: { path: { triageCallId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { call: null, error: res.error };
  return { call: res.data as unknown as TriageCallProjection, error: null };
}

/** Row 13 — the caller disconnected. A mandatory escalation still BLOCKS (§2.2.4): "the caller hung up" is
 *  not an answer to "did a human respond to the suicidal-ideation page?". */
export async function abandonCall(
  client: ApiClient,
  triageCallId: string,
  version: number,
  body: { reason: string; callbackAttempts: number },
): Promise<{ call: TriageCallProjection | null; error: unknown }> {
  const res = await client.POST("/api/v1/triage-calls/{triageCallId}/abandon", {
    params: { path: { triageCallId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { call: null, error: res.error };
  return { call: res.data as unknown as TriageCallProjection, error: null };
}

/** §2.7 step 3 — the BCP paper-origin re-entry (own permission + step-up; the back-dated `opened_at` is
 *  §8.3.2's way a coverage gap gets hidden, so the worklist row's outage window bounds it server-side). */
export async function reenterPaperCall(
  client: ApiClient,
  body: {
    worklistId: string;
    providerEntityId: string;
    paperOriginalOpenedAt: string;
    inboundChannel: string;
    callerKind: string;
    patientId?: string;
    admissionId?: string;
    chiefComplaintText?: string;
    callerDisplayName?: string;
  },
): Promise<{ result: OpenTriageCallResult | null; error: unknown }> {
  const res = await client.POST("/api/v1/triage-calls/paper-reentry", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { result: null, error: res.error };
  return { result: res.data as unknown as OpenTriageCallResult, error: null };
}

// ── escalation writes (§4.1 rows 15, 17-18) ────────────────────────────────────────────────────────────

/** Row 15 — raise an escalation on a call. Gated by the CALL's predicate, not the escalation ones: the
 *  actor raising the page is the clinician working the call. */
export async function escalate(
  client: ApiClient,
  triageCallId: string,
  version: number | null,
  body: {
    tier: string;
    reason: string;
    escalatedToMembershipId?: string;
    escalatedToExternalActorId?: string;
    handOffCall?: boolean;
  },
): Promise<{ escalation: EscalationInboxItem | null; error: unknown }> {
  const res = await client.POST("/api/v1/triage-calls/{triageCallId}/escalations", {
    params: { path: { triageCallId } },
    headers: writeHeaders(body.handOffCall === true ? version : undefined),
    body,
  } as never);
  if (res.error) return { escalation: null, error: res.error };
  return { escalation: res.data as unknown as EscalationInboxItem, error: null };
}

/** Row 17 — acknowledge. This is the write §7.2 waits on: until it lands, the call may take no disposition
 *  other than the escalate-unresolved hand-off. */
export async function acknowledgeEscalation(
  client: ApiClient,
  escalationId: string,
  version: number,
): Promise<{ escalation: EscalationInboxItem | null; error: unknown }> {
  const res = await client.POST("/api/v1/escalations/{escalationId}/acknowledge", {
    params: { path: { escalationId } },
    headers: writeHeaders(version),
    body: {},
  } as never);
  if (res.error) return { escalation: null, error: res.error };
  return { escalation: res.data as unknown as EscalationInboxItem, error: null };
}

/** Row 18 — resolve, with the escalated party's own account of what was decided (≥ 30 chars). This is the
 *  ONLY place a MANDATORY row can reach `resolved` (§2.2.4) — the whole point is that the agency can prove
 *  a named human answered. */
export async function resolveEscalation(
  client: ApiClient,
  escalationId: string,
  version: number,
  body: { resolution: string },
): Promise<{ escalation: EscalationInboxItem | null; error: unknown }> {
  const res = await client.POST("/api/v1/escalations/{escalationId}/resolve", {
    params: { path: { escalationId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { escalation: null, error: res.error };
  return { escalation: res.data as unknown as EscalationInboxItem, error: null };
}

// ── shift + policy writes (§4.1 rows 20-23, 26) ────────────────────────────────────────────────────────

/** Row 20 — manual create. `policySnapshot` is NOT a body field: D7 pins it from the tenant policy at the
 *  `scheduled → active` transition, and a caller-supplied snapshot would be a caller-supplied answer to
 *  "which escalation ladder was in effect that night". */
export async function createShift(
  client: ApiClient,
  body: {
    providerEntityId: string;
    shiftStartsAt: string;
    shiftEndsAt: string;
    discipline: string;
    primaryOnCallMembershipId?: string;
    backupMembershipId?: string;
    externalActorId?: string;
    externalActorLabel?: string;
  },
): Promise<{ shift: OnCallShiftView | null; error: unknown }> {
  const res = await client.POST("/api/v1/oncall/shifts", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { shift: null, error: res.error };
  return { shift: res.data as unknown as OnCallShiftView, error: null };
}

/** Row 21 — cancel with a reason. Emits NO outbox event: a shift that never activated was never in M36's
 *  `on_call` channel, so a `cancelled` emit would ask M36 to remove a member it never added. The hole the
 *  cancellation leaves is the coverage-gap watchdog's finding, on its own 30-minute cadence. */
export async function cancelShift(
  client: ApiClient,
  shiftId: string,
  version: number,
  body: { reason: string },
): Promise<{ shift: OnCallShiftView | null; error: unknown }> {
  const res = await client.PATCH("/api/v1/oncall/shifts/{shiftId}/cancel", {
    params: { path: { shiftId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { shift: null, error: res.error };
  return { shift: res.data as unknown as OnCallShiftView, error: null };
}

/** Row 22 — the "go on shift" CTA. Pins the D7 policy snapshot and emits `m19.oncall_shift.activated`, the
 *  single canonical shift-open topic M36's channel synchronizer and M20's SOS path both subscribe to. */
export async function openShift(
  client: ApiClient,
  shiftId: string,
  version: number,
): Promise<{ shift: OnCallShiftView | null; error: unknown }> {
  const res = await client.POST("/api/v1/oncall/shifts/{shiftId}/open", {
    params: { path: { shiftId } },
    headers: writeHeaders(version),
    body: {},
  } as never);
  if (res.error) return { shift: null, error: res.error };
  return { shift: res.data as unknown as OnCallShiftView, error: null };
}

/** Row 23 — close. Emits `m19.oncall_shift.completed`, which removes the departing actor from M36's
 *  channel; messages sent during their tenure stay attributed to them (§4.5). */
export async function closeShift(
  client: ApiClient,
  shiftId: string,
  version: number,
): Promise<{ shift: OnCallShiftView | null; error: unknown }> {
  const res = await client.POST("/api/v1/oncall/shifts/{shiftId}/close", {
    params: { path: { shiftId } },
    headers: writeHeaders(version),
    body: {},
  } as never);
  if (res.error) return { shift: null, error: res.error };
  return { shift: res.data as unknown as OnCallShiftView, error: null };
}

/** Row 26 — edit the policy (STEP-UP; §8.3.2 lists "lower the mandatory-escalation tiers" as the tampering
 *  threat). A `hybrid` / `centralized` selection where the D3 flag is off is REFUSED rather than
 *  accepted-and-ignored: a tenant must never believe a vendor is answering their nights when none is. */
export async function patchPolicy(
  client: ApiClient,
  providerEntityId: string,
  version: number,
  body: {
    model?: string;
    escalationTiers?: Record<string, unknown>;
    callbackSlaPerSeverity?: Record<string, unknown>;
    stateOverrides?: Record<string, unknown>;
    externalTriageVendorId?: string | null;
    emergencyContactE164?: string | null;
    aiProtocolSuggestionEnabled?: boolean;
    aiHospitalizationRiskEnabled?: boolean;
  },
): Promise<{ policy: OncallPolicyView | null; error: unknown }> {
  const res = await client.PATCH("/api/v1/oncall/policy", {
    params: { query: { providerEntityId } },
    headers: writeHeaders(version),
    body,
  } as never);
  if (res.error) return { policy: null, error: res.error };
  return { policy: res.data as unknown as OncallPolicyView, error: null };
}

// ── protocol-catalog writes (§4.1 rows 29-32) ──────────────────────────────────────────────────────────

/** Row 29 — author a TENANT-CUSTOM protocol (step-up). `isSystemLocked` is absent from the body: accepting
 *  it and ignoring it would leave the DON believing they had authored a protected question. */
export async function createProtocol(
  client: ApiClient,
  body: {
    key: string;
    chiefComplaintLabel: string;
    snomedCode: string;
    disciplineRequired: string;
    requiresMandatoryEscalation?: boolean;
    mandatoryEscalationTier?: string | null;
    version?: string;
    effectiveFrom?: string;
    effectiveTo?: string | null;
    sortOrder?: number;
  },
): Promise<{ protocol: TriageProtocolView | null; error: unknown }> {
  const res = await client.POST("/api/v1/triage-protocols", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { protocol: null, error: res.error };
  return { protocol: res.data as unknown as TriageProtocolView, error: null };
}

/** Row 30 — edit a TENANT protocol. A platform-floor row is refused with its key NAMED, because "0 rows
 *  updated" is not an answer a DON can act on. */
export async function patchProtocol(
  client: ApiClient,
  protocolId: string,
  body: {
    chiefComplaintLabel?: string;
    snomedCode?: string;
    disciplineRequired?: string;
    requiresMandatoryEscalation?: boolean;
    mandatoryEscalationTier?: string | null;
    version?: string;
    effectiveTo?: string | null;
    sortOrder?: number;
  },
): Promise<{ protocol: TriageProtocolView | null; error: unknown }> {
  const res = await client.PATCH("/api/v1/triage-protocols/{protocolId}", {
    params: { path: { protocolId } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { protocol: null, error: res.error };
  return { protocol: res.data as unknown as TriageProtocolView, error: null };
}

/** Row 31 — add a question. A tenant cannot write a child row against an ORG-LESS parent (migration 0108's
 *  INSERT policy), so the attempt against a platform protocol is refused with the protocol named. */
export async function addProtocolQuestion(
  client: ApiClient,
  protocolId: string,
  body: {
    questionOrder: number;
    prompt: string;
    answerType: string;
    answerEnumValues?: string[] | null;
    required?: boolean;
    isRedFlagQuestion?: boolean;
    redFlagMatch?: unknown;
  },
): Promise<{ protocol: TriageProtocolView | null; error: unknown }> {
  const res = await client.POST("/api/v1/triage-protocols/{protocolId}/questions", {
    params: { path: { protocolId } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { protocol: null, error: res.error };
  return { protocol: res.data as unknown as TriageProtocolView, error: null };
}

/** Row 32 — edit one question. A system-locked question is refused: it is the D5 red-flag predicate behind
 *  a platform-floor mandatory escalation, and editing it is the cheapest way to disable one. */
export async function patchProtocolQuestion(
  client: ApiClient,
  questionId: string,
  body: {
    questionOrder?: number;
    prompt?: string;
    answerType?: string;
    answerEnumValues?: string[] | null;
    required?: boolean;
    isRedFlagQuestion?: boolean;
    redFlagMatch?: unknown;
  },
): Promise<{ protocol: TriageProtocolView | null; error: unknown }> {
  const res = await client.PATCH("/api/v1/triage-protocol-questions/{questionId}", {
    params: { path: { questionId } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { protocol: null, error: res.error };
  return { protocol: res.data as unknown as TriageProtocolView, error: null };
}

// ── vendor-binding writes (§4.1 rows 34-35) ────────────────────────────────────────────────────────────

/** Row 34 — create a binding (step-up). The BAA attestation is a PRECONDITION (§8.5), so a binding without
 *  it is refused rather than created-and-inert: an inert binding is the worse outcome, because the tenant's
 *  policy would then name a vendor that silently cannot carry a call. There is NO secret field — ADR-0026
 *  puts vendor credentials in the platform secret store, and the ABSENCE of the field is the control. */
export async function createVendorBinding(
  client: ApiClient,
  body: {
    mdmVendorId: string;
    name: string;
    adapterKey: string;
    rnCoverageAttested: boolean;
    baaInEffect: boolean;
    baaExpiresOn?: string | null;
    defaultMinimizationPolicy: { profile: string };
  },
): Promise<{ binding: VendorBindingView | null; error: unknown }> {
  const res = await client.POST("/api/v1/oncall/external-vendors", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { binding: null, error: res.error };
  return { binding: res.data as unknown as VendorBindingView, error: null };
}

/** Row 35 — "BAA renewal updates only" (§4.1's own Notes). The narrow request shape IS the rule: neither
 *  the adapter key nor the minimization profile can be changed here, because either would silently
 *  re-point live PHI at a different contract. */
export async function patchVendorBinding(
  client: ApiClient,
  vendorId: string,
  body: { rnCoverageAttested?: boolean; baaInEffect?: boolean; baaExpiresOn?: string | null },
): Promise<{ binding: VendorBindingView | null; error: unknown }> {
  const res = await client.PATCH("/api/v1/oncall/external-vendors/{vendorId}", {
    params: { path: { vendorId } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { binding: null, error: res.error };
  return { binding: res.data as unknown as VendorBindingView, error: null };
}
