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
//     (RN/NP/LPN/LVN) read the caller's discipline from their session role grants, never from the
//     `authorDiscipline` sent here — that field is the CMS attribution recorded on the row, which is
//     why it is offered from the caller's own roles rather than as a free choice.
//   • §2.3 / D9 Section Q, and the whole CMS pre-submission rule set. The client renders the findings
//     `GET /validation` returns; it computes none of them.
import type { ApiClient, operations } from "@chartwarden/ui";
import { freshIdempotencyKeyHeaders, nowLocalInput } from "@chartwarden/ui";

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
export type AssessmentView = Ok<operations["putApiV1HopeAssessmentsById"]>;
/** One schedule as the skip write returns it. */
export type ScheduleView = Ok<operations["postApiV1HopeSchedulesByIdSkip"]>;
/** One iQIES submission batch as assemble/retry return it. */
export type SubmissionView = Ok<operations["postApiV1HopeSubmissionsAssemble"]>;

export type RecordTimepointBody = ReqBody<
  operations["postApiV1AdmissionsByAdmissionIdHopeTimepoints"]
>;
export type RecordSfvBody = ReqBody<operations["postApiV1AdmissionsByAdmissionIdHopeSfv"]>;
export type SignAssessmentBody = ReqBody<operations["postApiV1HopeAssessmentsByIdSign"]>;
export type UpdateDraftBody = ReqBody<operations["putApiV1HopeAssessmentsById"]>;
export type SkipScheduleBody = ReqBody<operations["postApiV1HopeSchedulesByIdSkip"]>;
/** The amendments of a signed record. Both carry the `authorDiscipline` the server binds to the caller's own roles. */
export type CorrectAssessmentBody = ReqBody<operations["postApiV1HopeAssessmentsByIdCorrect"]>;
export type InactivateAssessmentBody = ReqBody<
  operations["postApiV1HopeAssessmentsByIdInactivations"]
>;
export type HuvCompletionDateBody = ReqBody<
  operations["patchApiV1HopeAssessmentsByIdHuvCompletiondate"]
>;

/** The five §2.2 Reasons-For-Assessment the server accepts. Derived, so a vocabulary change breaks here. */
export type RfaKind = RecordTimepointBody["rfaKind"];
/** The §4.7 author disciplines the server accepts on a capture. */
export type AuthorDiscipline = RecordTimepointBody["authorDiscipline"];
/** The SFV author disciplines: the timepoint set plus LPN/LVN (CMS HOPE Guidance Manual v1.03). */
export type SfvAuthorDiscipline = RecordSfvBody["authorDiscipline"];
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
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly message: string;
      /** The server's error code (`M10_TIMEPOINT_EXPIRED`...), for a screen that words a few of them itself; null when it sent none. */
      readonly code: string | null;
      /** For a VALIDATION_FAILED or EVIDENCE_LOOKS_LIKE_PHI refusal, the first field it objected to (see {@link validationFieldOf}); absent otherwise. */
      readonly invalidField?: ValidationField;
    };

/**
 * The server's own words from a parsed error body, or null when it carries none. The platform error envelope
 * nests the reason as `{ error: { message } }`; a bare `{ message }` is kept as a fallback. A blank message
 * counts as none. The one parser every HOPE surface shares, so no refusal is shown in two different ways.
 */
export function serverMessageOf(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const { error, message } = body as { error?: { message?: unknown } | null; message?: unknown };
  const usable = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" ? value : null;
  return usable(error?.message) ?? usable(message);
}

/** The error code of a parsed error body (`{ error: { code } }`), or null when it carries none. */
export function errorCodeOf(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const code = (body as { error?: { code?: unknown } | null }).error?.code;
  return typeof code === "string" ? code : null;
}

/**
 * Refusals whose own message addresses an integrator rather than the person at the screen (M10_SPEC_NOT_IN_FORCE and
 * M10_ADMISSION_PROJECTION_GAP end in advice about renewing an Idempotency-Key, which a clinician cannot act on and the web
 * client already does on its own; the second also names an admission id). They are worded here, with the code kept in the
 * sentence for whoever the clinician reports it to.
 */
export const SPEC_NOT_IN_FORCE_MESSAGE =
  "No HOPE specification is available for this date. Contact your administrator (code M10_SPEC_NOT_IN_FORCE).";
export const ADMISSION_PROJECTION_GAP_MESSAGE =
  "The admission record is incomplete or unavailable, so this step could not be completed. Contact your administrator (code M10_ADMISSION_PROJECTION_GAP).";
/**
 * A NOT_FOUND names the record's id and doubles its own "not found" ("HOPE schedule <id> not found not found"), and the server answers
 * it just as it does for a record this user may not read (no existence oracle): so every screen says this one sentence instead.
 */
export const RECORD_NOT_AVAILABLE_MESSAGE = "That HOPE record is no longer available to you.";
const CLINICIAN_WORDS_BY_CODE: ReadonlyMap<string, string> = new Map([
  ["M10_SPEC_NOT_IN_FORCE", SPEC_NOT_IN_FORCE_MESSAGE],
  ["M10_ADMISSION_PROJECTION_GAP", ADMISSION_PROJECTION_GAP_MESSAGE],
  ["NOT_FOUND", RECORD_NOT_AVAILABLE_MESSAGE],
]);

/**
 * The words to show for a refusal body: this module's own sentence for a code whose server text is not the clinician's to
 * read, else the server's message (`serverMessageOf`), else null. Every screen that shows a refusal goes through here.
 */
export function refusalWordsOf(body: unknown): string | null {
  const code = errorCodeOf(body);
  return (code === null ? undefined : CLINICIAN_WORDS_BY_CODE.get(code)) ?? serverMessageOf(body);
}

/**
 * For a `VALIDATION_FAILED` refusal, the first field the server objected to and why (`{ error: { details: [{ field, message }] } }`),
 * or null. The envelope's own message is the fixed "request validation failed", which names no field; the field path and the
 * schema's reason ("Expected string length less or equal to 100") carry no record content. Null too when the envelope's own
 * message already says it (several server checks use one sentence for both), so the reason is never shown twice.
 */
export function validationDetailOf(body: unknown): string | null {
  if (errorCodeOf(body) !== "VALIDATION_FAILED") return null;
  const first = (
    body as { error?: { details?: ReadonlyArray<{ field?: unknown; message?: unknown }> } }
  ).error?.details?.[0];
  if (typeof first?.message !== "string" || first.message.trim() === "") return null;
  if (serverMessageOf(body)?.includes(first.message)) return null;
  return typeof first.field === "string" && first.field !== ""
    ? `${first.field}: ${first.message}`
    : first.message;
}

/** The field a VALIDATION_FAILED or EVIDENCE_LOOKS_LIKE_PHI refusal objected to, and the code of that objection (`INVALID_CHARACTERS`, `INVALID`...). */
export interface ValidationField {
  readonly field: string;
  readonly code: string | null;
}

/**
 * The code the server's patient-identifier screen refuses with (422), whichever field it screened: a screen of this web module decides
 * which field it was by the refusal's detail (`validationFieldOf`), never by this code alone.
 */
export const PHI_REFUSAL_CODE = "EVIDENCE_LOOKS_LIKE_PHI";

/** The codes whose `details[0].field` names what was refused: the patient-identifier screen names the field it screened the same way. */
const FIELD_NAMING_CODES: ReadonlySet<string> = new Set(["VALIDATION_FAILED", PHI_REFUSAL_CODE]);

/**
 * For a `VALIDATION_FAILED` or `EVIDENCE_LOOKS_LIKE_PHI` refusal, the first field it objected to and why, or null (another code, no
 * details, a detail that names no field). The patient-identifier screen runs over several fields of one request (a result import
 * screens the report reference AND every row's tokens, as `results.<i>.<token>`), so the code alone does not say which was refused: a
 * screen decides by this field. The wire name is for a screen to match on, never to show: it answers on its own control in its own words.
 */
export function validationFieldOf(body: unknown): ValidationField | null {
  const code = errorCodeOf(body);
  if (code === null || !FIELD_NAMING_CODES.has(code)) return null;
  const first = (body as { error?: { details?: ReadonlyArray<unknown> } }).error?.details?.[0];
  if (typeof first !== "object" || first === null) return null;
  const { field, code: detailCode } = first as { field?: unknown; code?: unknown };
  if (typeof field !== "string" || field === "") return null;
  return { field, code: typeof detailCode === "string" ? detailCode : null };
}

/**
 * The signature or SFV was refused because the attestation wording the signer was shown is no longer the current one
 * (409). A definite refusal: nothing was written, and the loaded page cannot send the new version, so it must be reloaded.
 */
export const ATTESTATION_STALE_CODE = "M10_ATTESTATION_STALE";
export const ATTESTATION_STALE_MESSAGE =
  "The attestation wording has changed. Reload the page and review it again.";

/** What a write came back with, as far as success goes (an openapi-fetch result, or a test double of one). */
interface WriteReply {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response?: { readonly ok?: boolean; readonly status?: number };
}

/**
 * Whether a write succeeded. openapi-fetch leaves `error` undefined for a non-OK reply with no body and sets it to ""
 * for an empty one, so `error` alone cannot decide it: a success has data, no error, and a response that was OK.
 */
export function writeSucceeded(reply: WriteReply): boolean {
  return reply.error === undefined && Boolean(reply.data) && reply.response?.ok !== false;
}

/** The same test for a read: data came back, with no error, on a response that was OK. An empty 502 is not an empty list. */
export const readSucceeded = writeSucceeded;

/** A refusal body the server actually sent (the error envelope), as opposed to no usable answer at all. */
export function isRefusalBody(error: unknown): boolean {
  return typeof error === "object" && error !== null;
}

/**
 * For a refusal that is the server's fault, not the clinician's: its raw text can carry internals, so it is never shown.
 * The server may have failed AFTER the write landed, so this never says it was not (nor "try again" as if it were safe):
 * it says the result is unknown and to check the record first.
 */
const SERVER_FAULT_MESSAGE =
  "The server could not complete the request, so the result could not be confirmed. Check the record before repeating the action.";

/** A failed write whose reply carries no error body, told apart by status: a 4xx is a refusal, anything else leaves it unknown. */
export function isClientRefusal(status: number | undefined): boolean {
  return typeof status === "number" && status >= 400 && status < 500;
}

/** What a 4xx with no error body says: the request was refused, and the server gave no reason. Distinct from "unconfirmed". */
export const REFUSED_WITHOUT_REASON =
  "The server refused the request without saying why. Review the details and try again.";

/**
 * The wording for a server-side fault, or null when the refusal is the clinician's to read in the server's own words.
 * `DEGRADED` (a dependency is unavailable) keeps a friendly, retryable sentence of the caller's choosing; any other
 * 5xx gets a generic one.
 */
export function serverFaultMessage(
  error: unknown,
  status: number | undefined,
  degradedText: string,
): string | null {
  if (errorCodeOf(error) === "DEGRADED") return degradedText;
  return typeof status === "number" && status >= 500 ? SERVER_FAULT_MESSAGE : null;
}

/**
 * The words for a write that did not succeed: the server's own message for a refusal it explained, a generic sentence
 * for a server fault (its raw text can carry internals), a refusal-without-reason for a 4xx with no body, and
 * `unconfirmed` (the caller's, naming what may or may not have happened) when there was no usable answer at all.
 */
export function failedWriteMessage(
  reply: WriteReply,
  unconfirmed: string,
  fallback: string,
): string {
  if (!isRefusalBody(reply.error)) {
    return isClientRefusal(reply.response?.status) ? REFUSED_WITHOUT_REASON : unconfirmed;
  }
  const fault = serverFaultMessage(
    reply.error,
    reply.response?.status,
    "A service this action needs is temporarily unavailable. Try again in a moment.",
  );
  if (fault !== null) return fault;
  const message = refusalWordsOf(reply.error) ?? fallback;
  const detail = validationDetailOf(reply.error);
  return detail === null ? message : `${message} (${detail})`;
}

/**
 * Whether a failed write may still have been applied: there was no usable answer (a rejection, a timeout, an empty 5xx), or
 * the server answered with a fault of its own. A 4xx refusal, and a degraded dependency (which `failedWriteMessage` words as
 * "try again"), are definite. The header of a save and the words of its error must agree on this.
 */
export function writeOutcomeUnknown(reply: WriteReply): boolean {
  const status = reply.response?.status;
  if (!isRefusalBody(reply.error)) return !isClientRefusal(status);
  return errorCodeOf(reply.error) !== "DEGRADED" && typeof status === "number" && status >= 500;
}

/**
 * `writeOutcomeUnknown` for the `{ ok: false }` result of one of this file's writes, which kept only the reply's status and code:
 * whether the write may still have been applied (an empty 5xx, a fault of the server's own), so a screen re-reads what it tells the
 * clinician to check. A 4xx refusal and a degraded dependency are definite.
 */
export function failedResultOutcomeUnknown(
  result: Extract<WriteResult<unknown>, { ok: false }>,
): boolean {
  return writeOutcomeUnknown({
    error: result.code === null ? undefined : { error: { code: result.code } },
    response: { status: result.status ?? undefined },
  });
}

/** A 409 that is not a stale version: a lock wait timed out and the step was NOT applied, so the page is not out of date. */
export const RECORD_BUSY_CODE = "M10_RECORD_BUSY";

/**
 * The refusal says the version this page holds is stale (a 409), not that the record was merely busy (send it again as it
 * is). Decided by status and code only: the wording of a message is not a contract (the real M10_SPEC_NOT_IN_FORCE text
 * contains "version" and is not a conflict).
 */
export function isStaleVersionRefusal(reply: WriteReply): boolean {
  return reply.response?.status === 409 && errorCodeOf(reply.error) !== RECORD_BUSY_CODE;
}

/** What a refusal says when the server explained nothing, by status: the next step differs (an unauthorised role is not a stale version). */
const FALLBACK_BY_STATUS: Readonly<Record<number, string>> = {
  400: "The server rejected the details supplied.",
  403: "Your role is not eligible to record or sign this HOPE timepoint.",
  404: RECORD_NOT_AVAILABLE_MESSAGE,
  409: "This timepoint changed before your action was applied. Reload and retry.",
  422: "The server rejected the details supplied.",
};

/**
 * Turn an openapi-fetch error into copy a clinician can act on.
 *
 * The words come from `failedWriteMessage`, the one source every HOPE write shares (so an empty 4xx, a server fault or a
 * degraded dependency reads the same here as in the workspace); only the fallback for a refusal that carries no message of
 * its own is chosen by status. M10's 400/409 family is unusually specific — `M10_TIMEPOINT_NOT_OPEN`,
 * `M10_TIMEPOINT_EXPIRED`, `M10_LATE_REASON_REQUIRED`, `M10_RFA_KIND_MISMATCH`, `M10_ADMISSION_NOT_ACTIVE` all arrive as
 * one of those two codes with a precise message, so the server's own words beat any sentence written here.
 */
function failure<T>(status: number | undefined, body: unknown): WriteResult<T> {
  const code = typeof status === "number" ? status : null;
  const message = failedWriteMessage(
    { error: body, response: { status } },
    SERVER_FAULT_MESSAGE,
    (code !== null && FALLBACK_BY_STATUS[code]) || "The action could not be completed.",
  );
  const invalidField = validationFieldOf(body);
  return {
    ok: false,
    status: code,
    message,
    code: errorCodeOf(body),
    ...(invalidField === null ? {} : { invalidField }),
  };
}

/**
 * How long a request that a dialog waits on (its write, or the read that settles it) may go unanswered. A stalled
 * connection has no timeout of its own (the browser may wait for minutes), and every dialog that disables itself while its
 * request is out would stay shut for as long. Past this the request is aborted: an abort is a rejection like going
 * offline, which every caller already reports as "could not confirm".
 *
 * What a retry then does depends on the write's key. A write that carries none of its own (record, skip, cancel, result, correct,
 * inactivate, HUV date, sign, SFV) keeps the API client's per-intent Idempotency-Key across the abort, so its retry REPLAYS. The
 * three that send a fresh key on every call (`requestSummaryPdf`, `regenerateSchedules`, `assembleSubmission`: each means "do it
 * now, against the records as they are", see `fresh-key-actions.test.ts`) are never tracked by the client, so their retry is a
 * NEW request and repeats the action if the first one had landed. That is why every unconfirmed message says to check the
 * record before trying again, and why `assembleSubmission` is not bounded at all.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Runs `send` with a signal that aborts after {@link REQUEST_TIMEOUT_MS}, and rejects when it does. The rejection does not
 * wait for `send` to honour the signal, so a caller that ignores it (or a double that never answers) is freed all the same.
 */
export async function withRequestTimeout<T>(send: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const timedOut = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new DOMException("The request was not answered in time", "TimeoutError")),
      { once: true },
    );
  });
  try {
    return await Promise.race([send(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** The request to record a timepoint got no answer (offline, a reset, a timeout): the server may or may not have recorded it. */
export const RECORD_UNCONFIRMED =
  "Could not confirm that the timepoint was recorded. Check the timeline before trying again.";

/** ISO instant for a `date-time` field. */
export const nowIso = (): string => new Date().toISOString();

/**
 * Today as `YYYY-MM-DD` in the clinician's own zone, for a date-only default or an "as of" date. Never
 * `toISOString().slice(0, 10)`: that is the UTC day, which a US evening has already rolled into tomorrow.
 */
export const localToday = (): string => nowLocalInput().slice(0, 10);

// ── §4.1 the ten M10 writes ────────────────────────────────────────────────────────────────────────────

/** §4.1 route 4 — record a new HOPE timepoint as a DRAFT. RN/NP/MD author floor is the server's. */
export async function recordTimepoint(
  client: ApiClient,
  admissionId: string,
  body: RecordTimepointBody,
): Promise<WriteResult<AssessmentView>> {
  const { data, error, response } = await withRequestTimeout((signal) =>
    client.POST("/api/v1/admissions/{admissionId}/hope/timepoints", {
      params: { path: { admissionId } },
      body,
      signal,
    }),
  );
  if (!writeSucceeded({ data, error, response }) || !data) return failure(response?.status, error);
  return { ok: true, value: data as AssessmentView };
}

// §4.1 route 5 (SFV completion) is driven by the assessment workspace's "Complete SFV" dialog
// (`hope-sfv-complete-dialog.tsx`): the server refuses a completion without the J2053 answers only that dialog collects.
// It builds its body as a `RecordSfvBody`, so the contract is still checked at compile time.

/** §4.1 route 6 — save a draft's section payload. The only write that does not change status. */
export async function updateDraft(
  client: ApiClient,
  id: string,
  body: UpdateDraftBody,
): Promise<WriteResult<AssessmentView>> {
  const { data, error, response } = await withRequestTimeout((signal) =>
    client.PUT("/api/v1/hope/assessments/{id}", { params: { path: { id } }, body, signal }),
  );
  if (!writeSucceeded({ data, error, response }) || !data) return failure(response?.status, error);
  return { ok: true, value: data as AssessmentView };
}

// §4.1 routes 7–8 (sign, correct) are driven by the assessment workspace (`hope-assessment-detail.tsx`),
// which carries the optimistic-concurrency `ifVersion` those routes require.

/** §4.1 route 11 — request the printable HOPE summary. 202: M22 renders it out of band. */
export async function requestSummaryPdf(
  client: ApiClient,
  id: string,
): Promise<WriteResult<{ assessmentId: string; requested: boolean }>> {
  const { data, error, response } = await withRequestTimeout((signal) =>
    client.POST("/api/v1/hope/assessments/{id}/summary-pdf", {
      params: { path: { id } },
      body: {},
      headers: freshIdempotencyKeyHeaders(), // a summary is built from the assessment as it is now: never replay an earlier answer
      signal,
    }),
  );
  if (!writeSucceeded({ data, error, response }) || !data) return failure(response?.status, error);
  return { ok: true, value: data as { assessmentId: string; requested: boolean } };
}

/** §4.1 route 3 — skip a schedule. The reason code is required and recorded against the window. */
export async function skipSchedule(
  client: ApiClient,
  id: string,
  body: SkipScheduleBody,
): Promise<WriteResult<ScheduleView>> {
  const { data, error, response } = await withRequestTimeout((signal) =>
    client.POST("/api/v1/hope/schedules/{id}/skip", { params: { path: { id } }, body, signal }),
  );
  if (!writeSucceeded({ data, error, response }) || !data) return failure(response?.status, error);
  return { ok: true, value: data as ScheduleView };
}

// SUBMISSION WRITES (#150, #177). There is no automated transport to iQIES and there will not be one:
// CMS states iQIES "does not support API interoperability" (HOPE FAQs Q30). The real path is manual —
// generate a package (`assembleSubmission`, below), download the ZIP, upload it in the iQIES portal, then
// mark it uploaded (`submission-detail.tsx`). `POST /hope/submissions/assemble` is honest about that: it
// builds the `.zip` of CMS XML records and answers `packaged`, a status the transmit worker (which only
// takes `queued`) never touches. Retry stays absent — it requeues into a stage that cannot reach iQIES.

/**
 * `POST /hope/submissions/assemble` — build the iQIES upload package for one provider entity. NOT bounded by
 * `withRequestTimeout` (the other writes are): building a large package can legitimately outlast it, and giving up on a
 * request that is still building would let a retry, on its fresh key, build a second package.
 */
export async function assembleSubmission(
  client: ApiClient,
  providerEntityId: string,
): Promise<WriteResult<SubmissionView>> {
  const { data, error, response } = await client.POST("/api/v1/hope/submissions/assemble", {
    body: { providerEntityId },
    // The package is built from the records as they are now (after a correction): never replay an earlier (lost-reply) answer.
    headers: freshIdempotencyKeyHeaders(),
  });
  if (!writeSucceeded({ data, error, response }) || !data) return failure(response?.status, error);
  return { ok: true, value: data };
}

/** R-08 — why a package that never reached CMS is cancelled: one of the server's fixed codes, never free text. */
export type CancelSubmissionBody = ReqBody<operations["postApiV1HopeSubmissionsByIdCancel"]>;

/**
 * `POST /hope/submissions/:id/cancel` — retire a package that was generated but never marked uploaded, so its
 * signed assessments can be packaged again in a NEW batch. The server answers 409 (with its own reason) once the
 * batch was marked uploaded; replaying a cancel returns the cancelled batch. No fresh Idempotency-Key is needed:
 * a retry after a lost reply is the same request and the same answer.
 */
export async function cancelSubmission(
  client: ApiClient,
  id: string,
  body: CancelSubmissionBody,
): Promise<WriteResult<SubmissionView>> {
  const { data, error, response } = await withRequestTimeout((signal) =>
    client.POST("/api/v1/hope/submissions/{id}/cancel", { params: { path: { id } }, body, signal }),
  );
  if (!writeSucceeded({ data, error, response }) || !data) return failure(response?.status, error);
  return { ok: true, value: data };
}

/**
 * §4.1 route 20 — create the timepoint windows an admission is entitled to and does not have yet (a backfill). A window that already
 * exists, in any status, is left exactly as it is: this does NOT recompute or move one after a date correction.
 */
export async function regenerateSchedules(
  client: ApiClient,
  admissionId: string,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await withRequestTimeout((signal) =>
    client.POST("/api/v1/hope/admin/regenerate-schedules", {
      body: { admissionId },
      headers: freshIdempotencyKeyHeaders(), // creates what is missing from the admission as it is now: never replay an earlier answer
      signal,
    }),
  );
  if (!writeSucceeded({ data, error, response }) || !data) return failure(response?.status, error);
  return { ok: true, value: data };
}

// ── §4.7 author attribution ────────────────────────────────────────────────────────────────────────
//
// F-074 (#91) — `authorDiscipline` is the ONE field in the platform whose wire vocabulary is not the
// lowercase M3 role key: the route schema is `Type.Union([Literal("RN"), Literal("NP"), Literal("MD")])`
// (`10-hope/routes/hope-typebox.ts`), and `seed-scenario-clinical-core.ts`'s header has said so all
// along. The record modal offered the caller's raw role keys as the select's VALUES and sent one
// through an `as AuthorDiscipline` cast, so every capture from the UI was rejected 422
// `authorDiscipline: Expected union value` — all five RFAs, the SFV, and the correction alike. The cast
// is why `tsc` was silent; the DOM suite asserted `sent.authorDiscipline === "rn"` against a stub that
// 200s any non-GET, so it encoded the defect as the expectation.
//
// The derivation below MIRRORS THE SERVER'S rather than introducing a second one. M10's ABAC predicate
// is `hopeDisciplinesOf(context).some(isHopeAuthorDisciplineAllowed)`, and `hopeDisciplinesOf` is
// literally `roles.map(r => r.toUpperCase())` (`10-hope/abac-predicates.ts`) — so a role satisfies the
// author floor exactly when its UPPERCASED key is one of RN / NP / MD. That matters beyond the casing:
// the old `AUTHOR_ROLE_KEYS` also offered `rn_case_manager` and `medical_director`, and neither can ever
// satisfy `hope.authorDisciplineAllowed` (`RN_CASE_MANAGER` is not in the list). A caller holding only
// one of those would have been offered an attribution the server then refused 403 — the client and the
// server disagreeing about who may author, which is worse than the casing bug because it fails later.
//
// Typed against `AuthorDiscipline`, which is extracted from the generated client, so a change to the
// route's union becomes a compile error here instead of a 422 in front of a clinician.

/** §4.7 — disciplines permitted to author any HOPE timepoint (mirrors `HOPE_AUTHOR_DISCIPLINES`). */
const HOPE_AUTHOR_DISCIPLINES: readonly AuthorDiscipline[] = ["RN", "NP", "MD"];
/** §4.7 — the narrower CMS floor for a Symptom-Follow-Up Visit (mirrors `SFV_AUTHOR_DISCIPLINES`). */
const SFV_AUTHOR_DISCIPLINES: readonly SfvAuthorDiscipline[] = ["RN", "NP", "LPN", "LVN"];

/** Readable expansion of the CMS code; the CODE is what is recorded, so it leads. */
const DISCIPLINE_LABELS: Record<SfvAuthorDiscipline, string> = {
  RN: "RN — Registered nurse",
  NP: "NP — Nurse practitioner",
  MD: "MD — Physician",
  LPN: "LPN — Licensed practical nurse",
  LVN: "LVN — Licensed vocational nurse",
};

/** The label shown beside a discipline code in an attribution control. */
export function authorDisciplineLabel(discipline: SfvAuthorDiscipline): string {
  return DISCIPLINE_LABELS[discipline];
}

/**
 * The disciplines this caller may be ATTRIBUTED as, derived from their own session role keys the same
 * way M10's ABAC predicate derives them. Deduplicated, because two role keys can normalize to one
 * discipline (`rn` and `rn_case_manager` both mean RN to a reader, though only the first satisfies the
 * server) and offering the same attribution twice is a choice with one answer.
 *
 * Empty means the capture cannot be attributed — NOT a permission verdict, which stays the server's.
 */
export function authorDisciplinesForRoles(
  roles: readonly string[],
  options?: { readonly sfv?: false },
): readonly AuthorDiscipline[];
export function authorDisciplinesForRoles(
  roles: readonly string[],
  options: { readonly sfv?: boolean },
): readonly SfvAuthorDiscipline[];
export function authorDisciplinesForRoles(
  roles: readonly string[],
  options: { readonly sfv?: boolean } = {},
): readonly SfvAuthorDiscipline[] {
  const permitted: readonly SfvAuthorDiscipline[] =
    options.sfv === true ? SFV_AUTHOR_DISCIPLINES : HOPE_AUTHOR_DISCIPLINES;
  const held = new Set(roles.map((r) => r.toUpperCase()));
  return permitted.filter((d) => held.has(d));
}

// ── iQIES result recording (no iQIES API: the user pastes/keys the CMS Final Validation Report) ────────

export type SubmissionResultBody = ReqBody<operations["postApiV1HopeSubmissionsByIdResults"]>;

/** Record the CMS result for a downloaded/uploaded batch. 409/422 reasons come back verbatim in `message`. */
export async function recordSubmissionResult(
  client: ApiClient,
  submissionId: string,
  body: SubmissionResultBody,
): Promise<WriteResult<unknown>> {
  const { data, error, response } = await withRequestTimeout((signal) =>
    client.POST("/api/v1/hope/submissions/{id}/results", {
      params: { path: { id: submissionId } },
      body,
      signal,
    }),
  );
  if (!writeSucceeded({ data, error, response }) || !data) return failure(response?.status, error);
  return { ok: true, value: data };
}
