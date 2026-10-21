// apps/web/src/modules/07-care-plan — the M7 WRITE access layer the §5.2 screens share
// (Track B / ADR-0030; #91).
//
// Until this file, `apps/web/src/modules/07-care-plan` issued ZERO mutations — 895 lines across three
// screens, every one a read. The individualised written plan of care is the LEGAL PREDICATE for
// delivering hospice care at all (42 CFR 418.56(b): "All hospice care and services furnished to
// patients and their families must follow an individualized written plan of care"), and 418.56(d)
// requires the IDG to review and update it at least every 15 days. The module could display a plan and
// could not author, revise, finalize or sign one. All THIRTEEN M7 write routes were mounted, guarded
// and contract-enriched the whole time.
//
// TWO CONCURRENCY DIALECTS, BOTH THE SERVER'S, AND THEY ARE NOT INTERCHANGEABLE:
//
//   • The POST state-changes (finalize / sign / return-to-draft / resolve / discontinue) carry
//     `ifVersion` in the BODY.
//   • The PATCHes (problem / goal / intervention edits) carry the row version in an `If-Match` HEADER
//     and additionally REQUIRE an `Idempotency-Key`. `requireIfMatch` answers 428 for a missing
//     If-Match and `requireIdempotencyKey` 400 for a missing key — before the handler runs.
//
// Both headers are legitimately client-supplied: concurrency control and retry safety, never
// authorization (the F-028 `not-authorization` classification exactly). Both are declared in the
// published contract, so the typed client can send them — which is why this layer never hand-rolls a
// request to reach them.
//
// The version each write must quote comes from the READ: every problem, goal, intervention and version
// row in `GET /patients/:patientId/care-plan` carries its own `version`. Nothing here invents one, and
// nothing re-reads to "refresh" it before writing — that would defeat the check, since the point of
// optimistic concurrency is to fail when the row moved under the caller.
import type { ApiClient, operations } from "@chartwarden/ui";

// ── READ side (the Care Plan workspace screens: plan + readiness + review status + proposed changes) ──

export interface SignerSlot {
  role: string;
  count: number;
}

export interface SignatureView {
  signerRole: string;
  signedAt: string | null;
}

export interface Version {
  id: string;
  planId: string;
  sequence: number;
  kind: string;
  status: string;
  idgMeetingId: string | null;
  requiredSignerSet: SignerSlot[];
  signatures: SignatureView[];
  draftedAt: string | null;
  signedAt: string | null;
  supersededAt: string | null;
  stateSnapshot?: unknown;
  patientUnderstandingText?: string | null;
  version: number;
}

export interface Problem {
  id: string;
  planId: string;
  icd10Code: string | null;
  snomedCode: string | null;
  description: string;
  kind: string;
  source: string;
  sudRelated: boolean;
  status: string;
  onsetAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  version: number;
}

export interface Goal {
  id: string;
  planId: string;
  problemId: string;
  originalText: string;
  revisedText: string | null;
  source: string;
  actingConsentId: string | null;
  measurableOutcome: string | null;
  targetAt: string | null;
  status: string;
  statusNote: string | null;
  version: number;
}

export interface Intervention {
  id: string;
  planId: string;
  problemId: string;
  goalRefs: string[];
  scopeText: string;
  frequencyText: string;
  frequencyValue: string;
  discipline: string;
  responsibleRole: string | null;
  linkedOrderId: string | null;
  status: string;
  discontinueReason: string | null;
  version: number;
}

export interface CarePlan {
  id: string;
  patientId: string;
  admissionId: string;
  status: string;
  activeVersionId: string | null;
  version: number;
  versions: Version[];
  problems: Problem[];
  goals: Goal[];
  interventions: Intervention[];
  redacted: boolean;
}

export interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

export interface Readiness {
  planId: string;
  openVersionId: string | null;
  openVersionStatus?: string;
  canFinalize: boolean;
  canSign: boolean;
  blockers: { code: string; message: string }[];
  signatures: {
    required: SignerSlot[];
    collected: SignatureView[];
    missing: SignerSlot[];
  };
}

export interface ReviewStatus {
  planId: string;
  nextReviewDueAt: string | null;
  status: "not_due" | "due" | "overdue" | "review_in_progress";
  overdueByDays: number;
  openReviewVersionId: string | null;
  openReviewVersionStatus: string | null;
  canStartReview: boolean;
}

export interface ProposedChange {
  id: string;
  proposalId: string;
  decisionId: string;
  entityType: string;
  operation: string;
  targetId: string | null;
  before: unknown;
  proposed: unknown;
  status: string;
}

export interface ProposedChanges {
  versionId: string;
  kind: string;
  meetingId: string | null;
  status: string;
  proposals: {
    id: string;
    decisionId: string;
    meetingId: string;
    sourceOutboxEventId: string;
    status: string;
    proposedAt: string | null;
    inReviewAt: string | null;
    appliedAt: string | null;
    conflictReason: string | null;
  }[];
  changes: ProposedChange[];
}

export interface ClinicalSnapshot {
  problems?: Problem[];
  goals?: Goal[];
  interventions?: Intervention[];
}

export function idemKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `m7-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

export function writeHeaders(version?: number | null): Record<string, string> {
  const header: Record<string, string> = { "Idempotency-Key": idemKey() };
  if (version != null) header["If-Match"] = String(version);
  return header;
}

export function errorMessage(error: unknown, fallback: string): string {
  const body = error as {
    title?: string;
    detail?: string;
    message?: string;
    code?: string;
    status?: number;
    error?: { message?: string; code?: string };
    blockers?: { code?: string; message?: string }[];
  } | null;
  if (body?.blockers?.length) return body.blockers.map((b) => b.message ?? b.code).join("; ");
  // §7.7 — these well-known refusals get a friendly, actionable message BEFORE the generic
  // detail/message/title fallbacks below: a stale-write 412 carries `error.message` too (e.g.
  // "version 4 is stale"), and checking the generic fields first would leak that raw text instead
  // of telling the caller what to do.
  if (body?.status === 409) return "Another open revision already exists. Reload to continue it.";
  // The server's stale-write refusal arrives in the platform envelope
  // (`412 { error: { code: "STALE_VERSION" } }`), which carries no top-level `status`; without reading
  // the code the branch below never fired and the IDG member got the generic fallback.
  if (body?.status === 412 || (body?.code ?? body?.error?.code) === "STALE_VERSION")
    return "This record changed while you were working. Reload before saving again.";
  if (body?.status === 422) return "The Care Plan is not ready for this action.";
  if (body?.status === 403) return "You do not have access to this action for this patient.";
  if (body?.detail) return body.detail;
  if (body?.error?.message) return body.error.message;
  if (body?.message) return body.message;
  if (body?.title) return body.title;
  return fallback;
}

export function normalizeSignerSet(raw: unknown): SignerSlot[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry === "string") return [{ role: entry, count: 1 }];
    const e = entry as { role?: unknown; count?: unknown };
    if (typeof e.role !== "string") return [];
    return [{ role: e.role, count: typeof e.count === "number" ? e.count : 1 }];
  });
}

function normalizeVersion(raw: unknown): Version {
  const v = raw as Version & { requiredSignerSet?: unknown };
  return { ...v, requiredSignerSet: normalizeSignerSet(v.requiredSignerSet) };
}

export async function getCarePlanWorkspace(
  client: ApiClient,
  patientId: string,
): Promise<{
  plan: CarePlan | null;
  patient: PatientSummary | null;
  readiness: Readiness | null;
  review: ReviewStatus | null;
  error: unknown;
}> {
  const [planRes, patRes] = await Promise.all([
    client.GET("/api/v1/patients/{patientId}/care-plan", {
      params: { path: { patientId } },
    }),
    client.GET("/api/v1/patients/{id}", {
      params: { path: { id: patientId } },
    }),
  ]);
  if (planRes.error) {
    return {
      plan: null,
      patient: null,
      readiness: null,
      review: null,
      error: planRes.error,
    };
  }
  const patient = patRes.data ? (patRes.data as PatientSummary) : null;
  const data = planRes.data;
  if (!data || !("id" in data) || !data.id) {
    return { plan: null, patient, readiness: null, review: null, error: null };
  }
  const plan = {
    ...(data as unknown as CarePlan),
    versions: ((data as unknown as CarePlan).versions ?? []).map(normalizeVersion),
  };
  const [readinessRes, reviewRes] = await Promise.all([
    client.GET("/api/v1/care-plans/{planId}/readiness", {
      params: { path: { planId: plan.id } },
    }),
    client.GET("/api/v1/care-plans/{planId}/review-status", {
      params: { path: { planId: plan.id } },
    }),
  ]);
  return {
    plan,
    patient,
    readiness: readinessRes.error ? null : (readinessRes.data as Readiness),
    review: reviewRes.error ? null : (reviewRes.data as ReviewStatus),
    error: readinessRes.error ?? reviewRes.error ?? null,
  };
}

export async function getProposedChanges(
  client: ApiClient,
  planId: string,
  versionId: string,
): Promise<{ proposed: ProposedChanges | null; error: unknown }> {
  const res = await client.GET(
    "/api/v1/care-plans/{planId}/versions/{versionId}/proposed-changes",
    {
      params: { path: { planId, versionId } },
    },
  );
  if (res.error) return { proposed: null, error: res.error };
  return { proposed: res.data as ProposedChanges, error: null };
}

export async function getVersion(
  client: ApiClient,
  planId: string,
  versionId: string,
): Promise<{ version: Version | null; error: unknown }> {
  const res = await client.GET("/api/v1/care-plans/{planId}/versions/{versionId}", {
    params: { path: { planId, versionId } },
  });
  if (res.error) return { version: null, error: res.error };
  return { version: normalizeVersion(res.data), error: null };
}

// ── WRITE side (#91 / #155 / #161) ──────────────────────────────────────────────────────────────────────

// ── schema-derived type extraction ─────────────────────────────────────────────────────────────────────

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } }
  ? Json<R>
  : Op extends { responses: { 201: infer R } }
    ? Json<R>
    : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

// ── wire shapes ────────────────────────────────────────────────────────────────────────────────────────

export type CarePlanVersion = Ok<
  operations["postApiV1CareplansByPlanIdVersionsByVersionIdFinalize"]
>;
export type ProblemRecord = Ok<operations["postApiV1CareplansByPlanIdProblems"]>;
export type GoalRecord = Ok<operations["postApiV1CareplansByPlanIdGoals"]>;
export type InterventionRecord = Ok<operations["postApiV1CareplansByPlanIdInterventions"]>;

export type CreateVersionBody = ReqBody<operations["postApiV1CareplansByPlanIdVersions"]>;
export type FinalizeBody = ReqBody<
  operations["postApiV1CareplansByPlanIdVersionsByVersionIdFinalize"]
>;
export type SignBody = ReqBody<
  operations["postApiV1CareplansByPlanIdVersionsByVersionIdSignatures"]
>;
export type CreateProblemBody = ReqBody<operations["postApiV1CareplansByPlanIdProblems"]>;
export type PatchProblemBody = ReqBody<
  operations["patchApiV1CareplansByPlanIdProblemsByElementId"]
>;
export type CreateGoalBody = ReqBody<operations["postApiV1CareplansByPlanIdGoals"]>;
export type PatchGoalBody = ReqBody<operations["patchApiV1CareplansByPlanIdGoalsByElementId"]>;
export type CreateInterventionBody = ReqBody<operations["postApiV1CareplansByPlanIdInterventions"]>;
export type PatchInterventionBody = ReqBody<
  operations["patchApiV1CareplansByPlanIdInterventionsByElementId"]
>;

/** The §2 vocabularies, derived so a server-side change breaks here rather than at runtime. */
export type VersionKind = CreateVersionBody["kind"];
export type SignerRole = SignBody["signerRole"];
export type ProblemKind = CreateProblemBody["kind"];
export type ProblemSource = CreateProblemBody["source"];
export type GoalSource = CreateGoalBody["source"];
export type GoalStatus = NonNullable<PatchGoalBody["status"]>;
export type InterventionDiscipline = CreateInterventionBody["discipline"];

export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number | null; readonly message: string };

/**
 * Turn a failure into copy a clinician can act on.
 *
 * 412 and 428 are the two that matter here and they mean opposite things: 412 STALE_VERSION is "someone
 * else changed this while you had it open", which on a plan reviewed by a whole IDG is ordinary rather
 * than exceptional; 428 PRECONDITION_REQUIRED means this client failed to send the version it read,
 * which is a bug in the caller and should read like one rather than like a server problem.
 */
function failure<T>(status: number | undefined, body: unknown): WriteResult<T> {
  const code = typeof status === "number" ? status : null;
  const detail =
    body && typeof body === "object" && "message" in body && typeof body.message === "string"
      ? body.message
      : null;
  const message =
    code === 412
      ? "Someone else changed this care plan while it was open. Reload to see their change, then try again."
      : code === 428
        ? (detail ?? "This edit did not carry the version it was based on and was refused.")
        : code === 403
          ? (detail ?? "Your role is not permitted to take this action on the care plan.")
          : code === 409
            ? (detail ?? "The plan is not in a state that allows this.")
            : code === 404
              ? "That care plan is no longer available to you."
              : code === 422
                ? (detail ?? "The server rejected the details supplied.")
                : (detail ?? "The action could not be completed.");
  return { ok: false, status: code, message };
}

/**
 * The §4.1.1 idempotency key a PATCH must carry.
 *
 * `randomUUID` is only present in a SECURE context, so a fallback is genuinely needed (plain http on a
 * LAN address is not hypothetical for a field laptop). The fallback is NOT a weaker key for the same
 * purpose — the key only has to be unique per logical attempt, and a retry of the same attempt reuses
 * whatever this returned, because the caller holds it for the duration of the request.
 */
function idempotencyKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

/**
 * The two headers every M7 PATCH must carry (§7.7 + §4.1.1).
 *
 * They go in `params.header`, not a loose `headers` bag, because the contract DECLARES them as required
 * header parameters — so the generated client types them and a PATCH that forgot `If-Match` does not
 * compile. That is the difference between this and the four routes F-028 found gating authorization on
 * a header nothing declared: these are declared, required, and non-authorization by construction
 * (a forged `If-Match` earns a 412, never access).
 */
const patchHeaders = (rowVersion: number): { "If-Match": string; "Idempotency-Key": string } => ({
  "If-Match": String(rowVersion),
  "Idempotency-Key": idempotencyKey(),
});

// ── plan + version lifecycle ───────────────────────────────────────────────────────────────────────────

/**
 * F-066 (#161) — the patient's admissions, newest first (the read F-065 added).
 *
 * `bootstrapCarePlan` below requires an `admissionId`, and until that route existed nothing could
 * resolve one for a patient: `GET /api/v1/admissions` is an org-wide census taking no patient filter,
 * whose items carry no `patientId`, and `GET /patients/:id` returns no admission. So this module had a
 * client for the plan bootstrap and declined to offer a control for it — the screen header said as
 * much: "a 'create care plan' button would need an admissionId this screen does not read". It reads it
 * now.
 */
export async function loadPatientAdmissions(
  client: ApiClient,
  patientId: string,
): Promise<
  { id: string; state: string; admissionAt: string | null; dischargedAt: string | null }[]
> {
  const { data } = await client.GET("/api/v1/patients/{patientId}/admissions", {
    params: { path: { patientId } },
  });
  return (data?.items ?? []) as {
    id: string;
    state: string;
    admissionAt: string | null;
    dischargedAt: string | null;
  }[];
}

/** §5.2 — create the plan shell for an admission. The initial IPOC hangs off this. */
export async function bootstrapCarePlan(
  client: ApiClient,
  patientId: string,
  admissionId: string,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST("/api/v1/patients/{patientId}/care-plan", {
    params: { path: { patientId } },
    body: { admissionId },
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data };
}

/** §2 — open a new DRAFT version. `idg_review` is the 15-day CoP cadence (418.56(d)). */
export async function createVersion(
  client: ApiClient,
  planId: string,
  body: CreateVersionBody,
): Promise<WriteResult<CarePlanVersion>> {
  const { data, error, response } = await client.POST("/api/v1/care-plans/{planId}/versions", {
    params: { path: { planId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as CarePlanVersion };
}

/**
 * §2 — close a draft for signature. `requiredSignerSet` may TIGHTEN the platform quorum floor (add
 * slots) and never loosen it; the server validates that, so this layer passes the tenant's choice
 * through rather than pre-judging it.
 */
export async function finalizeVersion(
  client: ApiClient,
  planId: string,
  versionId: string,
  body: FinalizeBody,
): Promise<WriteResult<CarePlanVersion>> {
  const { data, error, response } = await client.POST(
    "/api/v1/care-plans/{planId}/versions/{versionId}/finalize",
    { params: { path: { planId, versionId } }, body },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as CarePlanVersion };
}

/**
 * §2 — attach one signature. `signerRole` is matched SERVER-side against the caller's own grants by
 * the `SIGNER_MATCH` guard, so this is which slot the caller is filling, not a claim to be allowed to.
 */
export async function signVersion(
  client: ApiClient,
  planId: string,
  versionId: string,
  body: SignBody,
): Promise<WriteResult<CarePlanVersion>> {
  const { data, error, response } = await client.POST(
    "/api/v1/care-plans/{planId}/versions/{versionId}/signatures",
    { params: { path: { planId, versionId } }, body },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as CarePlanVersion };
}

/** §2 — reopen a finalized version for editing (before the quorum completes). */
export async function returnToDraft(
  client: ApiClient,
  planId: string,
  versionId: string,
  ifVersion: number,
): Promise<WriteResult<CarePlanVersion>> {
  const { data, error, response } = await client.POST(
    "/api/v1/care-plans/{planId}/versions/{versionId}/return-to-draft",
    { params: { path: { planId, versionId } }, body: { ifVersion } },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as CarePlanVersion };
}

// ── problems ───────────────────────────────────────────────────────────────────────────────────────────

export async function createProblem(
  client: ApiClient,
  planId: string,
  body: CreateProblemBody,
): Promise<WriteResult<ProblemRecord>> {
  const { data, error, response } = await client.POST("/api/v1/care-plans/{planId}/problems", {
    params: { path: { planId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as ProblemRecord };
}

export async function patchProblem(
  client: ApiClient,
  planId: string,
  elementId: string,
  rowVersion: number,
  body: PatchProblemBody,
): Promise<WriteResult<ProblemRecord>> {
  const { data, error, response } = await client.PATCH(
    "/api/v1/care-plans/{planId}/problems/{elementId}",
    { params: { path: { planId, elementId }, header: patchHeaders(rowVersion) }, body },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as ProblemRecord };
}

/** §2 — resolve a problem. Its goals and interventions are the server's business, not this call's. */
export async function resolveProblem(
  client: ApiClient,
  planId: string,
  elementId: string,
  ifVersion: number,
  resolutionNote: string,
): Promise<WriteResult<ProblemRecord>> {
  const { data, error, response } = await client.POST(
    "/api/v1/care-plans/{planId}/problems/{elementId}/resolve",
    { params: { path: { planId, elementId } }, body: { ifVersion, resolutionNote } },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as ProblemRecord };
}

// ── goals ──────────────────────────────────────────────────────────────────────────────────────────────

export async function createGoal(
  client: ApiClient,
  planId: string,
  body: CreateGoalBody,
): Promise<WriteResult<GoalRecord>> {
  const { data, error, response } = await client.POST("/api/v1/care-plans/{planId}/goals", {
    params: { path: { planId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as GoalRecord };
}

/**
 * §2 — revise a goal. `originalText` is NOT patchable and that is the point: a patient-stated goal is
 * recorded in the patient's words and a revision is appended as `revisedText`, so the original survives
 * the edit. This layer cannot send one because the contract does not carry one.
 */
export async function patchGoal(
  client: ApiClient,
  planId: string,
  elementId: string,
  rowVersion: number,
  body: PatchGoalBody,
): Promise<WriteResult<GoalRecord>> {
  const { data, error, response } = await client.PATCH(
    "/api/v1/care-plans/{planId}/goals/{elementId}",
    { params: { path: { planId, elementId }, header: patchHeaders(rowVersion) }, body },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as GoalRecord };
}

// ── interventions ──────────────────────────────────────────────────────────────────────────────────────

export async function createIntervention(
  client: ApiClient,
  planId: string,
  body: CreateInterventionBody,
): Promise<WriteResult<InterventionRecord>> {
  const { data, error, response } = await client.POST("/api/v1/care-plans/{planId}/interventions", {
    params: { path: { planId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as InterventionRecord };
}

export async function patchIntervention(
  client: ApiClient,
  planId: string,
  elementId: string,
  rowVersion: number,
  body: PatchInterventionBody,
): Promise<WriteResult<InterventionRecord>> {
  const { data, error, response } = await client.PATCH(
    "/api/v1/care-plans/{planId}/interventions/{elementId}",
    { params: { path: { planId, elementId }, header: patchHeaders(rowVersion) }, body },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as InterventionRecord };
}

export async function discontinueIntervention(
  client: ApiClient,
  planId: string,
  elementId: string,
  ifVersion: number,
  reason: string,
): Promise<WriteResult<InterventionRecord>> {
  const { data, error, response } = await client.POST(
    "/api/v1/care-plans/{planId}/interventions/{elementId}/discontinue",
    { params: { path: { planId, elementId } }, body: { ifVersion, reason } },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as InterventionRecord };
}
