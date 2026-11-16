// apps/backend/src/modules/10-hope/hope-sfv-completion-guards.ts — the lookup and refusal guards a
// `recordSfv` completion runs BEFORE it inserts the signed RFA-04, split out of `hope-route-service-db.ts`.
// The ORDER the caller runs them in is security-relevant and is the caller's contract:
//   attestation -> `requireCalendarTargetDate` (pure, body only) -> the URL admission as a canonical uuid (404 when it
//   is none; `recordSfv`) -> `resolveSfvAdmissionPatient` (seam read, outside the tx) -> `lockSfvForCompletion` ->
//   `requireSfvBoundToAdmission` -> `requireValidSfvCompletionContent` (hope-sfv-completion-content.ts) -> insert.
// A foreign / unknown / mispaired SFV is refused by `requireSfvBoundToAdmission`, before any status or content guard,
// so the later guards (ALREADY_COMPLETED, INCOMPLETE, PAST_DUE) can never be used to probe another admission.
import { type DbClient, schema } from "@chartwarden/db";
import { HopeStateError } from "@chartwarden/hope";
import { withOrgContext } from "@chartwarden/tenancy";
import { type AdmissionSummary, DegradedError } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";
import { takeBoundedLock } from "./hope-assessment-lock";
import { errorClassForLog, idForLog } from "./hope-log-id";
import { auditHopeSfvCompletionDenied } from "./hope-operator-audit";
import type { HopeAuditRequestFacts } from "./hope-signature-audit";
import { canonicalUuidOrNull, sameUuid } from "./hope-uuid";

const SFV = schema.symptomFollowUpVisits;

type SfvRow = typeof SFV.$inferSelect;

/**
 * The 422 text for an admission the M6 seam cannot project to a patient. One definition: the in-memory twin
 * (routes/service.ts) raises the same refusal for an admission it was not seeded with, so a route test sees what production sends.
 */
export const sfvProjectionGapMessage = (admissionId: string): string =>
  `Admission ${admissionId} could not be projected by the M6 status seam, so the SFV completion cannot be bound to it. Once the admission is repaired, send the request again with a NEW Idempotency-Key (the idempotency layer replays this 422 for 24 h on the same key).`;

/**
 * The same refusal for `recordTimepoint`: the new record's subject (its patient) is unknown because neither the M6 seam's
 * summary nor a schedule row names one, and it is never guessed. One definition, for the DB backend and the twin to share.
 */
export const timepointProjectionGapMessage = (admissionId: string): string =>
  `Admission ${admissionId} could not be projected by the M6 status seam, so the subject of this HOPE record is unknown. Once the admission is repaired, send the request again with a NEW Idempotency-Key (the idempotency layer replays this 422 for 24 h on the same key).`;

/**
 * The URL admission's patient through M6's `AdmissionStatusReader`. The read is keyed on the URL admission only (never
 * on the body's triggering assessment), so which of these answers a caller gets reveals nothing about any SFV.
 * - A seam that THROWS is an outage, not an answer about the admission: a retryable 503 (`DegradedError`). The
 *   idempotency plugin releases a 5xx key, where a 422 would be cached for 24 hours and a transient fault would
 *   keep refusing the same request. This is the SECOND seam read of the request: `hope.scope` reads the same seam
 *   first and turns a throw there into "not found" (a 503 in the scope guard would be an existence oracle), so a
 *   real M6 outage usually answers 404 before this runs, and the 503 is for a read that fails after the scope
 *   read succeeded.
 * - A seam that answers but cannot say whose admission this is (no summary, another tenant's admission, no
 *   patient) is a PROJECTION GAP: a 422 the admission's repair fixes, NOT "this SFV does not exist".
 * Either way the log carries ids and the error class only (a seam failure's message can carry arbitrary text).
 */
export async function resolveSfvAdmissionPatient(
  organizationId: string,
  admissionId: string,
): Promise<string> {
  let summary: AdmissionSummary | undefined;
  try {
    summary = await getSeam("AdmissionStatusReader").getAdmissionSummary(
      organizationId,
      admissionId,
    );
  } catch (error) {
    console.warn(
      `m10: SFV completion refused: the M6 admission seam threw ${errorClassForLog(error)} resolving admission ${idForLog(admissionId)} (org ${idForLog(organizationId)}).`,
    );
    // A generic label: the component named in the 503 body is not something the caller needs to learn.
    throw new DegradedError(
      "service",
      "a dependency this request needs is temporarily unavailable; retry the request",
    );
  }
  if (summary && summary.organizationId === organizationId && summary.patientId) {
    return summary.patientId;
  }
  console.warn(
    `m10: SFV completion refused: the M6 admission seam returned no patient for admission ${idForLog(admissionId)} (org ${idForLog(organizationId)}).`,
  );
  throw new HopeStateError("M10_ADMISSION_PROJECTION_GAP", sfvProjectionGapMessage(admissionId));
}

/**
 * The SFV of THIS admission for this triggering assessment, row-locked so two parallel completions of one SFV
 * serialise (the loser re-reads it `completed`). Keyed on the URL admission as well as the triggering
 * assessment: `hope.scope` verified the admission against the caller's caseload, but the body's
 * `triggeringAssessmentId` is in no guard target, so keying on it alone let a caseload clinician complete
 * ANOTHER patient's SFV. Waits at most `M10_LOCK_TIMEOUT_MS` for the row (then `M10_RECORD_BUSY`).
 */
export async function lockSfvForCompletion(
  tx: DbClient,
  organizationId: string,
  admissionId: string,
  triggeringAssessmentId: string,
): Promise<SfvRow | undefined> {
  // A body id that is no uuid names no SFV: "absent" (the same NO_TRIGGER refusal as any unbound SFV), never a `::uuid`
  // comparison that answers a 22P02. The query runs on the canonical text, not the caller's spelling.
  const admission = canonicalUuidOrNull(admissionId);
  const trigger = canonicalUuidOrNull(triggeringAssessmentId);
  if (admission === null || trigger === null) return undefined;
  const [sfv] = (await takeBoundedLock(
    tx,
    (statement) =>
      statement
        .select()
        .from(SFV)
        .where(
          and(
            eq(SFV.organizationId, organizationId),
            eq(SFV.admissionId, admission),
            eq(SFV.triggeringAssessmentId, trigger),
          ),
        )
        .limit(1)
        .for("update"),
    {
      lock: `SFV row of admission ${idForLog(admissionId)}, triggering assessment ${idForLog(triggeringAssessmentId)} (org ${idForLog(organizationId)}) for an SFV completion`,
    },
  )) as SfvRow[];
  return sfv;
}

/** Who asked, and for what, when an SFV completion is refused as unbound (ids only; no body, no patient). */
export interface SfvCompletionCaller {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly admissionId: string;
  readonly triggeringAssessmentId: string;
}

/**
 * A foreign SFV, a nonexistent one and one whose patient is not the admission's all answer the SAME
 * NO_TRIGGER (message included), so the row we sign never pairs one patient with another admission and the
 * response is no existence oracle. Runs before every status/content guard.
 * The caller sees nothing different between them, but the SERVER does: a refusal leaves a warn log naming the
 * membership, admission and triggering assessment (ids only), the signal a probe for another admission's SFV
 * would otherwise leave nowhere.
 */
export function requireSfvBoundToAdmission(
  sfv: SfvRow | undefined,
  admissionPatientId: string,
  caller: SfvCompletionCaller,
): asserts sfv is SfvRow {
  // The M6 seam's patient id and the database's are two spellings of one uuid when they differ only in case or hyphenation: a valid
  // completion must not be refused as "no SFV obligation" for that. Two ids that are not uuids match only when they are identical.
  if (
    sfv != null &&
    (admissionPatientId === sfv.patientId || sameUuid(admissionPatientId, sfv.patientId))
  )
    return;
  console.warn(
    `m10: SFV completion refused: no SFV obligation bound to this admission (org ${idForLog(caller.organizationId)}, membership ${idForLog(caller.membershipId)}, admission ${idForLog(caller.admissionId)}, triggering assessment ${idForLog(caller.triggeringAssessmentId)}).`,
  );
  throw new HopeStateError(
    "M10_SFV_NO_TRIGGER",
    `No SFV obligation for triggering assessment ${caller.triggeringAssessmentId}.`,
  );
}

/** Whether `error` is the refusal {@link requireSfvBoundToAdmission} throws (the only thrower of `M10_SFV_NO_TRIGGER`). */
export const isSfvNoTriggerRefusal = (error: unknown): boolean =>
  error instanceof HopeStateError && error.code === "M10_SFV_NO_TRIGGER";

/**
 * The `denied` audit event for a refused, unbound SFV completion: the probe a caseload clinician makes by naming ANOTHER
 * patient's triggering assessment, which would otherwise leave only an application log line. The refusal is thrown inside
 * the request transaction and rolls it back, so the event is written on a NEW transaction, AFTER that one ended (never
 * nested inside it: a second pool connection taken while the first is held can starve the pool). Ids only: the org, the
 * membership, the URL admission and, when it is a uuid, the triggering assessment id.
 *
 * Best effort: a failure to write it is logged (ids and the error class only) and NEVER changes the 409 the caller gets,
 * which is byte-for-byte the answer for an absent SFV (no oracle).
 */
export async function auditSfvCompletionRefusal(
  db: DbClient,
  caller: SfvCompletionCaller,
  request?: HopeAuditRequestFacts,
): Promise<void> {
  try {
    await withOrgContext(db, { organizationId: caller.organizationId, userId: "" }, (tx) =>
      auditHopeSfvCompletionDenied(tx as unknown as DbClient, {
        organizationId: caller.organizationId,
        membershipId: caller.membershipId,
        request,
        admissionId: caller.admissionId,
        triggeringAssessmentId: canonicalUuidOrNull(caller.triggeringAssessmentId),
      }),
    );
  } catch (error) {
    console.warn(
      `m10: SFV completion refusal audit not written (${errorClassForLog(error)}): org ${idForLog(caller.organizationId)}, membership ${idForLog(caller.membershipId)}, admission ${idForLog(caller.admissionId)}.`,
    );
  }
}
