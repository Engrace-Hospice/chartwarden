// apps/web/src/modules/09-assessments — the M9 WRITE access layer the §5.2 screens share
// (Track B / ADR-0030; #91).
//
// Until this file, `apps/web/src/modules/09-assessments` issued ZERO mutations: six read screens, every
// one a read. A clinician could look at a PPS timeline and could not record a PPS. The scales are the
// hospice evidence base — PPS/KPS anchor the prognosis a recertification rests on, ESAS-r is the symptom
// record the plan of care is revised against, and the significant-change events derived from them are
// what the IDG reviews. The Significant-Change Inbox in particular is a queue whose one action —
// acknowledge — it did not offer, so a detected decline sat unacknowledged forever.
//
// THE BLOCKER WAS THE INSTRUMENT DEFINITION, NOT THE WRITE ROUTE (F-067).
// `POST /api/v1/patients/:patientId/assessments` publishes `data` as a bare object; which ITEMS a scale
// needs, their ranges and their option values existed only as TypeScript interfaces in
// `@wardenx/assessments`. A client cannot read a type. `SCALE_CATALOG`'s own header calls itself "the
// single source the record-modal scale picker (T07) ... read" — there was no record modal.
// `GET /api/v1/scales` is that definition, so ONE description drives the form and the scorer.
//
// AND TEN OF THE FOURTEEN SCALES CANNOT BE CAPTURED. `scoring.ts` registers four scorers and raises
// `SCALE_SCORER_UNAVAILABLE` — a **500** — for the rest, all of which are in the route's own `scaleType`
// enum. `hasScorer` is documented as "the form-gating ... check" and nothing gated on it. The picker
// offers `recordable` scales only, which is the server's own answer rather than a list copied here.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES (ADR-0030).
//
//   • D6 SCORING. The score and its interpretation are computed server-side from `data`; the API
//     ignores any client-sent score. Nothing here adds up an ESAS-r total — the number shown after a
//     capture is the one the server computed.
//   • D3 LICENSING. Five scales are proprietary and license-gated; the server refuses a capture whose
//     licence is missing or expired. The form surfaces the requirement as information, never as a gate.
//   • §7.6 SUD REDACTION, and the §4.x discipline rules for who may record which scale.
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

export type ScaleCatalog = Ok<operations["getApiV1Scales"]>;
export type ScaleDefinition = ScaleCatalog["scales"][number];
export type ScaleItem = NonNullable<ScaleDefinition["items"]>[number];
export type AssessmentView = Ok<operations["getApiV1PatientsByPatientIdAssessmentsById"]>;
export type RecordAssessmentBody = ReqBody<operations["postApiV1PatientsByPatientIdAssessments"]>;
export type CorrectAssessmentBody = ReqBody<
  operations["postApiV1PatientsByPatientIdAssessmentsByIdCorrections"]
>;
export type AcknowledgeBody = ReqBody<
  operations["postApiV1SignificantchangesByEventIdAcknowledge"]
>;

/** The 14 scale types the route accepts. Derived, so a vocabulary change is a compile error. */
export type ScaleType = RecordAssessmentBody["scaleType"];
/** Who the capture is recorded on behalf of (§7.x consent). */
export type ActingAs = NonNullable<RecordAssessmentBody["actingAs"]>;

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
 * Turn an openapi-fetch error into copy a clinician can act on.
 *
 * `SCALE_SCORER_UNAVAILABLE` is named explicitly and reads as "not built yet" rather than as a server
 * fault, because it IS a 500 and a clinician who sees a bare error will retry a capture that can never
 * succeed. The picker should never let it happen — this is the belt to that braces.
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
    code === "SCALE_SCORER_UNAVAILABLE"
      ? "This scale cannot be recorded yet — the platform has no scoring module for it. Nothing was saved."
      : code === "SCALE_LICENSE_MISSING" || code === "SCALE_LICENSE_EXPIRED"
        ? (detail ??
          "This scale is licensed and the agency's licence is missing or expired. An administrator can record it in the scale-licence registry.")
        : httpStatus === 403
          ? (detail ?? "Your discipline is not permitted to record this scale.")
          : httpStatus === 409
            ? (detail ?? "This record changed before your action was applied.")
            : httpStatus === 404
              ? "That record is no longer available to you."
              : httpStatus === 422
                ? (detail ?? "The server rejected the values supplied.")
                : (detail ?? "The action could not be completed.");
  return { ok: false, status: httpStatus, code, message };
}

const ok = <T>(value: T): WriteResult<T> => ({ ok: true, value });

// ── the capture form's definition read (F-067) ─────────────────────────────────────────────────────────

/** The instrument catalog: every scale, its items, and whether it can be captured at all. */
export async function loadScaleCatalog(client: ApiClient): Promise<ScaleDefinition[]> {
  const { data } = await client.GET("/api/v1/scales");
  return (data?.scales ?? []) as ScaleDefinition[];
}

/**
 * The patient's admissions, newest first (F-065). `POST .../assessments` requires `admissionId`, and
 * until that read existed nothing could resolve one for a patient — see #161.
 */
export async function loadPatientAdmissions(
  client: ApiClient,
  patientId: string,
): Promise<{ id: string; state: string; dischargedAt: string | null }[]> {
  const { data } = await client.GET("/api/v1/patients/{patientId}/admissions", {
    params: { path: { patientId } },
  });
  return (data?.items ?? []) as { id: string; state: string; dischargedAt: string | null }[];
}

// ── §2 capture ─────────────────────────────────────────────────────────────────────────────────────────

/** Record a scale capture. The SERVER scores it (D6) — the response carries the number, not the request. */
export async function recordAssessment(
  client: ApiClient,
  patientId: string,
  body: RecordAssessmentBody,
): Promise<WriteResult<AssessmentView>> {
  const { data, error, response } = await client.POST("/api/v1/patients/{patientId}/assessments", {
    params: { path: { patientId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data as AssessmentView);
}

/**
 * Correct a capture. NOT an edit: the server supersedes the original with a new row and keeps both, so
 * the record of what was first recorded survives — a scale capture is a clinical observation, and an
 * observation that can be silently rewritten is not evidence.
 */
export async function correctAssessment(
  client: ApiClient,
  patientId: string,
  id: string,
  version: number,
  body: CorrectAssessmentBody,
): Promise<WriteResult<AssessmentView>> {
  // §7.7 — `If-Match` is a TYPED header param on this operation, so omitting it does not compile. A 412
  // means the capture was corrected by someone else first; correcting again would supersede their row.
  const { data, error, response } = await client.POST(
    "/api/v1/patients/{patientId}/assessments/{id}/corrections",
    {
      params: { path: { patientId, id }, header: { "If-Match": String(version) } },
      body,
    },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data as AssessmentView);
}

/** Attach the required cosignature to a capture that needs one. */
export async function cosignAssessment(
  client: ApiClient,
  id: string,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST("/api/v1/assessments/{id}/cosignatures", {
    params: { path: { id } },
    body: { attestationConfirmed: true },
  });
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

/**
 * Acknowledge a detected significant change — the one action the §5.2 inbox exists for. The event stays
 * on the record; acknowledging says a clinician has seen it, which is what stops the escalation.
 */
export async function acknowledgeChange(
  client: ApiClient,
  eventId: string,
  note?: string,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST(
    "/api/v1/significant-changes/{eventId}/acknowledge",
    { params: { path: { eventId } }, body: (note ? { note } : {}) as AcknowledgeBody },
  );
  if (error || !data) return failure(response?.status, error);
  return ok(data);
}

/** ISO instant for a `date-time` field the server records as client-observed time. */
export const nowIso = (): string => new Date().toISOString();
