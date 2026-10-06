// apps/web/src/modules/17-scheduling — the M17 WRITE access layer the §5.1 screens share
// (Track B / ADR-0030; #91).
//
// Until this file, `apps/web/src/modules/17-scheduling` issued ZERO mutations: eight read screens, every
// one a read. A visit is the unit of hospice care delivery — it is what a clinician travels to, what an
// encounter documents, what EVV brackets, and what a claim's service line is built from. The scheduler
// could look at a day, a week, a proposal inbox and a time-off queue, and could not schedule a visit,
// move one, reassign one, publish a proposal, or approve a day off.
//
// THE PROPOSAL INBOX IS THE SHARPEST CASE. M17 generates visit proposals from the care plan's frequency
// orders, the IDG's decisions and the supervisory cadence — and `publish` is what turns a proposal into
// a real scheduled visit. With no caller, every proposal the platform produced sat in a list forever and
// the visits the plan of care called for were never created.
//
// Every wire shape below is a TYPE ALIAS into the generated `operations` map, never a hand-copied
// interface — the same rule the other modules' api layers follow.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES (ADR-0030 — no frontend authz).
//
//   • §2.2 the visit lifecycle. Whether a visit may be rescheduled, reassigned, cancelled or started is
//     the state machine's; no screen pre-computes it beyond narrowing which ceremonies to OFFER.
//   • §4.7 the D8 PRE-SCHEDULE GATE. Whether the assigned clinician may take this visit purpose is
//     resolved server-side from their active M3 role grants ∩ the scheduling vocabulary, with the M17
//     credential read deciding whether the licence is currently active. This file sends the assignment;
//     the server decides whether it is legal. A 403 is the answer, surfaced verbatim.
//   • The §7.x conflict rules — double-booking, availability, approved time off. A reschedule that
//     collides is refused with a 409 and the message names what it collided with.
import type { ApiClient, operations } from "@wardenx/ui";

// ── schema-derived type extraction ─────────────────────────────────────────────────────────────────────

/** The `application/json` payload of an openapi-fetch response/request-body slot. */
type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
/** The success body of operation `Op` — 200 or 201, whichever the route actually sends. */
type Ok<Op> = Op extends { responses: { 200: infer R } }
  ? Json<R>
  : Op extends { responses: { 201: infer R } }
    ? Json<R>
    : never;
/** The request body of operation `Op`. */
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

// ── wire shapes ────────────────────────────────────────────────────────────────────────────────────────

export type VisitView = Ok<operations["getApiV1VisitsByVisitId"]>;
export type CreateVisitBody = ReqBody<operations["postApiV1Visits"]>;
export type PatchVisitBody = ReqBody<operations["patchApiV1VisitsByVisitId"]>;
export type RescheduleBody = ReqBody<operations["postApiV1VisitsByVisitIdReschedule"]>;
export type ReassignBody = ReqBody<operations["postApiV1VisitsByVisitIdReassign"]>;
export type CancelVisitBody = ReqBody<operations["postApiV1VisitsByVisitIdCancel"]>;
export type NoShowBody = ReqBody<operations["postApiV1VisitsByVisitIdNoshow"]>;
export type CreateRecurringBody = ReqBody<operations["postApiV1Recurringvisits"]>;
export type CreateTimeOffBody = ReqBody<operations["postApiV1Timeoff"]>;
export type AvailabilityBody = ReqBody<operations["putApiV1AvailabilityByMembershipId"]>;

/** The §2.1 visit purposes the server accepts. Derived, so a vocabulary change is a compile error. */
export type VisitPurpose = CreateVisitBody["visitPurpose"];
/** The §2.1 settings a visit can occur in. */
export type VisitSetting = CreateVisitBody["visitSetting"];
/** The §7.x cancellation reason codes. */
export type CancelReasonCode = CancelVisitBody["reasonCode"];
/** The time-off kinds the server accepts. */
export type TimeOffKind = CreateTimeOffBody["kind"];

/** One of the patient's addresses — where a `patient_home` visit is scheduled to. */
export interface PatientAddressOption {
  readonly id: string;
  readonly label: string;
}
/** One of the org's memberships — who a visit is assigned to. */
export interface MembershipOption {
  readonly id: string;
  readonly label: string;
}

/** The outcome of one write — discriminated, because every caller renders the failure in place. */
export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly code: string | null;
      readonly message: string;
    };

/**
 * Turn an openapi-fetch error into copy a scheduler can act on.
 *
 * The D8 pre-schedule refusal is named rather than flattened: "this clinician's discipline or licence
 * does not cover this visit purpose" is a different next step from "this slot is taken", and a scheduler
 * shown a generic error will try the same assignment again. 409 is the conflict rules — double-booking,
 * availability, approved time off — and the server's message names what it collided with.
 */
function failure(status: number | undefined, body: unknown): WriteResult<never> {
  const httpStatus = typeof status === "number" ? status : null;
  const err =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
  const detail = typeof err?.message === "string" ? err.message : null;
  const code = typeof err?.code === "string" ? err.code : null;
  const message =
    code === "DISCIPLINE_NOT_ELIGIBLE" || code === "PRE_SCHEDULE_DENIED"
      ? // The platform copy LEADS here rather than deferring to `detail`, unlike every other branch: the
        // server's message for this one is a bare refusal ("not eligible"), and a scheduler needs to know
        // that the fix is a different clinician — not a retry. The server's words follow it.
        `That clinician's discipline or active licence does not cover this visit purpose (§4.7 D8).${
          detail ? ` ${detail}` : ""
        }`
      : httpStatus === 403
        ? (detail ?? "Your role is not permitted to take this action on this visit.")
        : httpStatus === 409
          ? (detail ??
            "That change conflicts with an existing visit, availability or approved time off.")
          : httpStatus === 404
            ? "That visit is no longer available to you."
            : httpStatus === 422
              ? (detail ?? "The server rejected the details supplied.")
              : (detail ?? "The action could not be completed.");
  return { ok: false, status: httpStatus, code, message };
}

const ok = <T>(value: T): WriteResult<T> => ({ ok: true, value });

// ── the reads a scheduling form needs ──────────────────────────────────────────────────────────────────

/**
 * The patient's addresses — `POST /visits` requires `patientAddressId` (nullable, but present), and a
 * `patient_home` visit with no address is a visit nobody can travel to. Read rather than typed.
 */
export async function loadPatientAddresses(
  client: ApiClient,
  patientId: string,
): Promise<PatientAddressOption[]> {
  const { data } = await client.GET("/api/v1/patients/{id}/addresses", {
    params: { path: { id: patientId } },
  });
  const rows = (data?.addresses ?? []) as {
    id: string;
    line1?: string | null;
    city?: string | null;
    kind?: string | null;
  }[];
  return rows.map((a) => ({
    id: a.id,
    label: [a.line1, a.city].filter(Boolean).join(", ") || (a.kind ?? a.id.slice(0, 8)),
  }));
}

/**
 * The org's memberships — who a visit can be assigned to. This is a ROSTER, not an eligibility list: the
 * §4.7 D8 gate decides whether the chosen clinician may take this visit purpose, and it decides that
 * from their role grants and the currency of their licence. Filtering here would be a second, divergent
 * implementation of that rule.
 */
export async function loadMemberships(
  client: ApiClient,
  orgId: string,
): Promise<MembershipOption[]> {
  const { data } = await client.GET("/api/v1/orgs/{id}/members", {
    params: { path: { id: orgId } },
  });
  const rows = data?.members ?? [];
  return (
    rows
      // A revoked or suspended membership is not someone a visit can be assigned to. The server would
      // refuse it anyway; offering it would be offering a choice that is certain to fail.
      .filter((m) => m.status === "active")
      .map((m) => ({ id: m.membershipId, label: m.displayName ?? m.membershipId.slice(0, 8) }))
  );
}

/** Search the org's patients — who a visit is being scheduled for. */
export async function searchPatients(
  client: ApiClient,
  q: string,
): Promise<{ id: string; label: string }[]> {
  const { data } = await client.GET("/api/v1/patients", {
    params: { query: q.trim() ? { q: q.trim(), limit: 20 } : { limit: 20 } },
  });
  const rows = data?.items ?? [];
  return rows.map((r) => ({ id: r.id, label: `${r.lastName}, ${r.firstName} · ${r.mrn}` }));
}

/** The patient's admissions, newest first (F-065) — the admission a visit is scheduled under (#161). */
export async function loadPatientAdmissions(
  client: ApiClient,
  patientId: string,
): Promise<{ id: string; state: string; dischargedAt: string | null }[]> {
  const { data } = await client.GET("/api/v1/patients/{patientId}/admissions", {
    params: { path: { patientId } },
  });
  return (data?.items ?? []) as { id: string; state: string; dischargedAt: string | null }[];
}

// ── §2.2 visit lifecycle ───────────────────────────────────────────────────────────────────────────────

/** Schedule a visit. The §4.7 D8 pre-schedule gate decides whether the assignment is legal. */
export async function createVisit(
  client: ApiClient,
  body: CreateVisitBody,
): Promise<WriteResult<VisitView>> {
  const { data, error, response } = await client.POST("/api/v1/visits", { body });
  if (error || !data) return failure(response?.status, error);
  return ok(data as VisitView);
}

/**
 * Move a visit. A collision with another visit, availability or approved time off is a 409.
 *
 * A reschedule is NOT an edit: the route returns `{ original, created }` because it closes the original
 * visit and opens a NEW one, linking them through `rescheduledIntoVisitId`. That matters to a caller —
 * anything holding the old visit id (an encounter draft, an EVV bracket, a claim line) still points at
 * the original, and the caller has to follow the link rather than assume the id it had is current.
 */
export async function rescheduleVisit(
  client: ApiClient,
  visitId: string,
  body: RescheduleBody,
): Promise<WriteResult<{ original: VisitView; created: VisitView }>> {
  const { data, error, response } = await client.POST("/api/v1/visits/{visitId}/reschedule", {
    params: { path: { visitId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as { original: VisitView; created: VisitView });
}

/** Hand a visit to another clinician. The D8 gate runs again against the NEW assignee. */
export async function reassignVisit(
  client: ApiClient,
  visitId: string,
  newAssignedMembershipId: string,
): Promise<WriteResult<VisitView>> {
  const { data, error, response } = await client.POST("/api/v1/visits/{visitId}/reassign", {
    params: { path: { visitId } },
    body: { newAssignedMembershipId } as ReassignBody,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as VisitView);
}

/** Cancel a visit, with the coded reason the §5.1 metrics count. */
export async function cancelVisit(
  client: ApiClient,
  visitId: string,
  body: CancelVisitBody,
): Promise<WriteResult<VisitView>> {
  const { data, error, response } = await client.POST("/api/v1/visits/{visitId}/cancel", {
    params: { path: { visitId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as VisitView);
}

/**
 * Record a no-show. Distinct from a cancellation on purpose: a cancelled visit was called off, a
 * no-show is a visit the clinician attended and the patient did not receive — the §5.1 metrics count
 * them separately and only one of them reflects on scheduling.
 */
export async function markNoShow(
  client: ApiClient,
  visitId: string,
  body: NoShowBody,
): Promise<WriteResult<VisitView>> {
  const { data, error, response } = await client.POST("/api/v1/visits/{visitId}/no-show", {
    params: { path: { visitId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as VisitView);
}

/**
 * Start a visit (GAP-050). `evvMissingReason` (40..1000 chars) is mandatory: the start is always a
 * self-attestation, because an unexplained missing bracket is what a Medicaid EVV audit asks about. The
 * route also needs a fresh step-up and the assigned clinician.
 */
export async function startVisit(
  client: ApiClient,
  visitId: string,
  evvMissingReason: string,
): Promise<WriteResult<VisitView>> {
  const { data, error, response } = await client.POST("/api/v1/visits/{visitId}/start", {
    params: { path: { visitId } },
    body: { evvMissingReason },
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as VisitView);
}

// ── §5.1 the proposal inbox ────────────────────────────────────────────────────────────────────────────

/**
 * PUBLISH a proposal — turn it into a real scheduled visit. This is the write the inbox exists for.
 * M17 generates proposals from the care plan's frequency orders, the IDG's decisions and the supervisory
 * cadence; with no caller, every one of them sat in a list and the visits the plan of care called for
 * were never created.
 */
export async function publishProposal(
  client: ApiClient,
  proposalId: string,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST(
    "/api/v1/visit-proposals/{proposalId}/publish",
    { params: { path: { proposalId } } },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

/** Dismiss a proposal the scheduler will not act on. The row is kept — dismissal is a decision. */
export async function dismissProposal(
  client: ApiClient,
  proposalId: string,
  reason: string,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST(
    "/api/v1/visit-proposals/{proposalId}/dismiss",
    { params: { path: { proposalId } }, body: { reason } },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

// ── §5.1 recurring policies ────────────────────────────────────────────────────────────────────────────

/** Create a recurring-visit policy — the cadence the proposal generator works from. */
export async function createRecurring(
  client: ApiClient,
  body: CreateRecurringBody,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST("/api/v1/recurring-visits", { body });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

/** Discontinue a recurring policy. Already-scheduled visits are unaffected — the server decides that. */
export async function discontinueRecurring(
  client: ApiClient,
  id: string,
  reason: string,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST("/api/v1/recurring-visits/{id}/discontinue", {
    params: { path: { id } },
    body: { reason },
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

// ── §5.1 time off ──────────────────────────────────────────────────────────────────────────────────────

/** Request time off. Approved time off is what the conflict rules refuse a visit against. */
export async function requestTimeOff(
  client: ApiClient,
  body: CreateTimeOffBody,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST("/api/v1/time-off", { body });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

/** Approve a time-off request — the action the approval queue exists for. */
export async function approveTimeOff(client: ApiClient, id: string): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST("/api/v1/time-off/{id}/approve", {
    params: { path: { id } },
    body: {},
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

/** Deny a time-off request, with the reason the requester is told. */
export async function denyTimeOff(
  client: ApiClient,
  id: string,
  reason: string,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST("/api/v1/time-off/{id}/deny", {
    params: { path: { id } },
    body: { reason },
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

/** Withdraw one's own request. */
export async function cancelTimeOff(client: ApiClient, id: string): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST("/api/v1/time-off/{id}/cancel", {
    params: { path: { id } },
    body: {},
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

/** ISO instant for a `date-time` field. */
export const nowIso = (): string => new Date().toISOString();
