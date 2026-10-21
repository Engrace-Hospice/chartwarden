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
import type { ApiClient, operations } from "@chartwarden/ui";

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
export type UpdateDraftBody = ReqBody<operations["putApiV1HopeAssessmentsById"]>;
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

// §4.1 routes 7–8 (sign, correct) are driven by the assessment workspace (`hope-assessment-detail.tsx`),
// which carries the optimistic-concurrency `ifVersion` those routes require.

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

// THE TWO SUBMISSION WRITES ARE STILL DELIBERATELY ABSENT (#150, #177 — reasoning updated twice).
//
// The original objection was that `POST /hope/submissions/assemble` reported success for work the server
// did not do: it wrote a `hope_submission` with `itemCount: 0` and no item rows. F-058 fixed that, and
// F-072 built the two §4.10 stages behind it, so the pipeline is real end to end — assemble, transmit,
// reconcile — and every planner in it now has a production caller.
//
// What is still missing is the TRANSPORT. `@chartwarden/iqies-client` ships only its deny-stub adapter,
// because the CMS endpoint, its auth flow and the HOPE submission XML schema are not in this repository.
// So a batch assembled today is transmitted by a worker whose adapter refuses, the job DLQs, and the
// operator sees an alert. That is the honest behaviour, and it is exactly why an "Assemble batch" button
// would still mislead: it would present a working submission workflow to the one user whose job is to
// know whether the agency has actually submitted to CMS. Retry is the same — it requeues into a stage
// that cannot reach iQIES.
//
// The submission worklist says so on screen instead. The client goes here when a live transport binds.

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
const SFV_AUTHOR_DISCIPLINES: readonly AuthorDiscipline[] = ["RN", "NP"];

/** Readable expansion of the CMS code; the CODE is what is recorded, so it leads. */
const DISCIPLINE_LABELS: Record<AuthorDiscipline, string> = {
  RN: "RN — Registered nurse",
  NP: "NP — Nurse practitioner",
  MD: "MD — Physician",
};

/** The label shown beside a discipline code in an attribution control. */
export function authorDisciplineLabel(discipline: AuthorDiscipline): string {
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
  options: { readonly sfv?: boolean } = {},
): readonly AuthorDiscipline[] {
  const permitted = options.sfv === true ? SFV_AUTHOR_DISCIPLINES : HOPE_AUTHOR_DISCIPLINES;
  const held = new Set(roles.map((r) => r.toUpperCase()));
  return permitted.filter((d) => held.has(d));
}
