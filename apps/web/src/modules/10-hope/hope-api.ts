// apps/web/src/modules/10-hope — the M10 WRITE access layer the §5.2 screens share
// (Track B / ADR-0030; #91).
//
// Until this file, `apps/web/src/modules/10-hope` issued ZERO mutations: 2701 lines across seven
// screens, every one a read. The module's own `screens.ts` header said so — "the recording modal
// (§5.2, all five RFAs), the late-completion confirmation dialog, and the schedule-admin write
// surfaces fill in as their write paths harden". The write paths were never the gap: all TEN M10
// write routes are mounted, guarded and contract-enriched. What was missing was the caller.
//
// Every wire shape below is a TYPE ALIAS into the generated `operations` map (`bun run client:gen`),
// never a hand-copied interface — the `13-emar/emar-api.ts` and `11-orders/orders-api.ts` rule, for
// the same reason: the argument and return types ARE the server contract, so a DTO drift is a compile
// error here rather than a runtime surprise on a screen.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE SECOND-GUESSES.
//
//   • §4.4 the capture gate. Whether a target date is before the window opens, inside it, in the late
//     grace span, or past the deadline is decided by `assertCaptureAllowed` against the STORED window.
//     The modal reads the schedule's own dates to decide what to ASK for (a late-completion reason),
//     never to decide what is permitted — a client clock is not an authority, and the 400/409 the
//     server returns is the answer.
//   • §4.7 the author floor. `hope.authorDisciplineAllowed` (RN/NP/MD) and `hope.sfvAuthorAllowed`
//     (RN/NP) read the caller's discipline from their session role grants, never from the
//     `authorDiscipline` sent here — that field is the CMS attribution recorded on the row, which is
//     why it is offered from the caller's own roles rather than as a free choice.
//   • §2.3 / D9 Section Q, and the whole CMS pre-submission rule set. The client renders the findings
//     `GET /validation` returns; it computes none of them.
import type { ApiClient, operations } from "@wardenx/ui";

// ── schema-derived type extraction ─────────────────────────────────────────────────────────────────────

/** The `application/json` payload of an openapi-fetch response/request-body slot. */
type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
/** The success body of operation `Op` — 200, 201 or 202, whichever the route actually sends. */
type Ok<Op> = Op extends { responses: { 200: infer R } }
  ? Json<R>
  : Op extends { responses: { 201: infer R } }
    ? Json<R>
    : Op extends { responses: { 202: infer R } }
      ? Json<R>
      : never;
/** The request body of operation `Op`. */
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

// ── wire shapes ────────────────────────────────────────────────────────────────────────────────────────

/** One assessment as every M10 assessment write returns it. */
export type AssessmentView = Ok<operations["postApiV1HopeAssessmentsByIdSign"]>;
/** One schedule as the skip write returns it. */
export type ScheduleView = Ok<operations["postApiV1HopeSchedulesByIdSkip"]>;
/** One iQIES submission batch as assemble/retry return it. */
export type SubmissionView = Ok<operations["postApiV1HopeSubmissionsAssemble"]>;

export type RecordTimepointBody = ReqBody<
  operations["postApiV1AdmissionsByAdmissionIdHopeTimepoints"]
>;
export type RecordSfvBody = ReqBody<operations["postApiV1AdmissionsByAdmissionIdHopeSfv"]>;
export type UpdateDraftBody = ReqBody<operations["putApiV1HopeAssessmentsById"]>;
export type CorrectTimepointBody = ReqBody<operations["postApiV1HopeAssessmentsByIdCorrect"]>;
export type SkipScheduleBody = ReqBody<operations["postApiV1HopeSchedulesByIdSkip"]>;

/** The five §2.2 Reasons-For-Assessment the server accepts. Derived, so a vocabulary change breaks here. */
export type RfaKind = RecordTimepointBody["rfaKind"];
/** The §4.7 author disciplines the server accepts on a capture. */
export type AuthorDiscipline = RecordTimepointBody["authorDiscipline"];
/** The D9 discharge reasons (which decide whether Section Q is required or forbidden). */
export type DischargeReason = NonNullable<RecordTimepointBody["dischargeReason"]>;
/** The closed D12 late-completion codelist. */
export type LateReasonCode = NonNullable<RecordTimepointBody["lateCompletionReasonCode"]>;
/** The opaque per-section CMS payload. */
export type HopeData = RecordTimepointBody["data"];

/**
 * The outcome of one write. A DISCRIMINATED result rather than a thrown error, because every caller
 * renders the failure in place — a worklist row that silently stops responding is the failure mode this
 * whole change exists to end.
 */
export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number | null; readonly message: string };

/**
 * Turn an openapi-fetch error into copy a clinician can act on.
 *
 * The statuses are NOT flattened into "something went wrong": each one names a different next step, and
 * M10's 400/409 family is unusually specific — `M10_TIMEPOINT_NOT_OPEN`, `M10_TIMEPOINT_EXPIRED`,
 * `M10_LATE_REASON_REQUIRED`, `M10_RFA_KIND_MISMATCH`, `M10_ADMISSION_NOT_ACTIVE` all arrive as one of
 * those two codes with a precise message. Surfacing the server's own `message` verbatim is therefore
 * strictly better than any generic sentence this layer could write, and the fallbacks below are only
 * for a response that carries none.
 */
function failure<T>(status: number | undefined, body: unknown): WriteResult<T> {
  const code = typeof status === "number" ? status : null;
  const detail =
    body && typeof body === "object" && "message" in body && typeof body.message === "string"
      ? body.message
      : null;
  const message =
    code === 403
      ? (detail ?? "Your role is not eligible to record or sign this HOPE timepoint.")
      : code === 409
        ? (detail ?? "This timepoint changed before your action was applied. Reload and retry.")
        : code === 404
          ? "That HOPE record is no longer available to you."
          : code === 400 || code === 422
            ? (detail ?? "The server rejected the details supplied.")
            : (detail ?? "The action could not be completed.");
  return { ok: false, status: code, message };
}

/** ISO instant for a `date-time` field. */
export const nowIso = (): string => new Date().toISOString();

// ── §4.1 the ten M10 writes ────────────────────────────────────────────────────────────────────────────

/** §4.1 route 4 — record a new HOPE timepoint as a DRAFT. RN/NP/MD author floor is the server's. */
export async function recordTimepoint(
  client: ApiClient,
  admissionId: string,
  body: RecordTimepointBody,
): Promise<WriteResult<AssessmentView>> {
  const { data, error, response } = await client.POST(
    "/api/v1/admissions/{admissionId}/hope/timepoints",
    { params: { path: { admissionId } }, body },
  );
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as AssessmentView };
}

/** §4.1 route 5 — record an SFV completion (RFA-04) against an OPEN follow-up obligation. RN/NP only. */
export async function recordSfv(
  client: ApiClient,
  admissionId: string,
  body: RecordSfvBody,
): Promise<WriteResult<AssessmentView>> {
  const { data, error, response } = await client.POST("/api/v1/admissions/{admissionId}/hope/sfv", {
    params: { path: { admissionId } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as AssessmentView };
}

/** §4.1 route 6 — save a draft's section payload. The only write that does not change status. */
export async function updateDraft(
  client: ApiClient,
  id: string,
  body: UpdateDraftBody,
): Promise<WriteResult<AssessmentView>> {
  const { data, error, response } = await client.PUT("/api/v1/hope/assessments/{id}", {
    params: { path: { id } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as AssessmentView };
}

/**
 * §4.1 route 7 — sign a draft. The server runs the D4 J2051 trigger from the STORED payload and may
 * create the 2-calendar-day SFV obligation as a consequence; `j2051TriggerFired` on the returned row is
 * how the caller learns it happened, and it is not something the client can predict or suppress (D4 is
 * explicit that a misconfigured client must never suppress the trigger).
 */
export async function signTimepoint(
  client: ApiClient,
  id: string,
): Promise<WriteResult<AssessmentView>> {
  const { data, error, response } = await client.POST("/api/v1/hope/assessments/{id}/sign", {
    params: { path: { id } },
    body: { attestationConfirmed: true as const },
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as AssessmentView };
}

/** §4.1 route 8 — insert a correction RFA. Append-only: the original is superseded, never edited (D7). */
export async function correctTimepoint(
  client: ApiClient,
  id: string,
  body: CorrectTimepointBody,
): Promise<WriteResult<AssessmentView>> {
  const { data, error, response } = await client.POST("/api/v1/hope/assessments/{id}/correct", {
    params: { path: { id } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as AssessmentView };
}

/** §4.1 route 11 — request the printable HOPE summary. 202: M22 renders it out of band. */
export async function requestSummaryPdf(
  client: ApiClient,
  id: string,
): Promise<WriteResult<{ assessmentId: string; requested: boolean }>> {
  const { data, error, response } = await client.POST("/api/v1/hope/assessments/{id}/summary-pdf", {
    params: { path: { id } },
    body: {},
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as { assessmentId: string; requested: boolean } };
}

/** §4.1 route 3 — skip a schedule. The reason code is required and recorded against the window. */
export async function skipSchedule(
  client: ApiClient,
  id: string,
  body: SkipScheduleBody,
): Promise<WriteResult<ScheduleView>> {
  const { data, error, response } = await client.POST("/api/v1/hope/schedules/{id}/skip", {
    params: { path: { id } },
    body,
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data as ScheduleView };
}

// THE TWO SUBMISSION WRITES ARE STILL DELIBERATELY ABSENT (#150, updated by F-058).
//
// `POST /hope/submissions/assemble` now does real work: it runs `planAssembleSubmissions` over the
// provider entity's eligible signed assessments and writes one `hope_submission` per CMS submission
// period WITH its `hope_submission_item` rows (that table had no writer at all before F-058). So the
// original objection to a client — that the route reported success for work the server did not do — no
// longer applies to assemble.
//
// The buttons stay off anyway, and for a different reason: a batch stops at `queued` and there is
// nothing downstream to move it. `iqies-submit-worker` terminates in `@wardenx/iqies-client`, whose only
// adapter is the deny-stub, so `submitBatch` still has no caller and `m10.hope.submission_transmitted`
// is still emitted by nothing. Putting "Assemble batch" on a compliance screen would present a working
// submission workflow to the one user whose job is to know whether the agency has submitted — and,
// through `uniq_hope_sub_item_assessment_active`, would permanently exclude every batched assessment
// from any future batch. Retry is unchanged: it requeues into that same unreachable stage.
//
// The submission worklist says so on screen instead. The client goes here when a live iQIES transport
// binds.

/** §4.1 route 20 — recompute an admission's timepoint schedules after a post-hoc date correction. */
export async function regenerateSchedules(
  client: ApiClient,
  admissionId: string,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await client.POST("/api/v1/hope/admin/regenerate-schedules", {
    body: { admissionId },
  });
  if (error || !data) return failure(response?.status, error);
  return { ok: true, value: data };
}
