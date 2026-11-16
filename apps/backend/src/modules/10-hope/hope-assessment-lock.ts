// apps/backend/src/modules/10-hope/hope-assessment-lock.ts — the ONE way an answers-writing request path takes the
// assessment row lock (`lockAssessmentRow`; the sign lock and the spec-freezing UPDATE take the same row through
// `takeBoundedLock` directly). M10's total lock order is
//   SFV row  ->  hope_assessment row  ->  hope_assessment_answer rows
// (a path that takes no SFV lock starts at the assessment row). Every REQUEST path that writes answers or UPDATEs a DRAFT
// assessment row takes the assessment lock BEFORE its first answer write, so no two such paths can hold one answer row
// each and wait on the other's assessment lock (the 40P01 the review self-heal and the workspace-open prefill produced
// when one wrote answers first and updated the assessment last). The named exception UPDATEs an assessment row under
// another lock and writes no answers: `importSubmissionResult` stamps `iqies_record_id` on the batch's assessments under
// the SUBMISSION row's lock, and the reconcile runner (`jobs/submission-store.ts`, a cron tick) stamps it too; neither
// calls `lockAssessmentRow`.
//
// WRITERS (each takes its locks in that order; the spec's §4.1.1 carries the same table):
//   patchAnswers                      SFV (HA admission only) -> assessment        validates items BEFORE the first lock
//   workspace open / prefill refresh  assessment, only when a write is needed     unlocked comparison first
//   review self-heal                  SFV -> assessment                           unlocked comparison first
//   recordSfv                         SFV -> assessment (via the answer writer)
//   signTimepoint                     assessment (+ its own Z0500B answer)         never an SFV lock
//   updateDraft, setHuvCompletionDate assessment                                  status and version judged on the locked row
//   recordTimepoint, correct, inactivate   an advisory key (`lockRecordKey`) FIRST, before any row lock
//   assembleSubmission (the route)    an advisory key per provider entity (`lockRecordKey`, `m10:assemble:<org>`), the
//                                     first statement, before the candidate read
//   runAssembleSubmissionCron         the SAME `m10:assemble:<org>` key per provider entity, in a stable order, and only for
//                                     entities whose unlocked scan found batchable work; candidates are read again behind
//                                     the key (`jobs/cron-workers.ts`; a timeout fails that organization's tick, logged)
//   cancel, mark-uploaded, results    the submission row (`takeBoundedLock`); `results` then UPDATEs the batch's assessments
//
// BOUNDED WAITS. A request that cannot get a row lock within `M10_LOCK_TIMEOUT_MS` answers a retryable 409
// `M10_RECORD_BUSY` (that step was not applied; an earlier step of the same request, committed in its own transaction,
// may have been) instead of queueing behind a stuck transaction and holding its pool connection for as long as that
// lasts. The idempotency plugin releases the Idempotency-Key for this code when nothing of the request had committed, so
// the same key may be reused; when an earlier step had committed the 409 is replayed, and the caller checks the current
// state and sends the request again with a NEW key. Every lock statement taken through THIS FILE's helpers goes through
// `takeBoundedLock` (the named helpers below are thin callers of it; the SFV completion lock, the sign lock, the
// submission row locks and the UPDATEs that queue behind a row lock call it directly), so the bound and the mapping live
// in one place. NOT covered: a route that takes none of these locks keeps PostgreSQL's default of no timeout: the
// schedule `skip`, the submission `retry`, `regenerate-schedules` and the validation-finding writes
// (docs/api/CHANGES.md lists them); the destruction eraser takes its own advisory lock directly, with no bound. The bound
// is `SET LOCAL` (it ends with the transaction) and stays in force for the rest of the transaction, so a later wait in the
// same request is bounded too, and `mapLockTimeoutToBusy` (installed on the database `createDbHopeBackend` hands the
// services it builds: its own route transactions and the answer, validation and readiness services; NOT on the database
// the m6 scheduling consumer, the cron ticks and the erasers receive, which take no `mapLockTimeoutToBusy` of their own)
// maps a `55P03` raised by ANY later statement of such a transaction to the same typed error. Each timeout
// is logged once (`console.warn`): the lock kind and the ids it was taken on; a timeout mapped by `mapLockTimeoutToBusy`
// names only "a statement of the transaction", because the statement that waited is not known there. The 409 itself names
// nothing an operator could use to find the transaction that holds the lock.
//
// PARTITION MOVES. `hope_assessment` is partitioned by `target_date`, and `setHuvCompletionDate` changes it, which moves the
// row to another partition (a delete plus an insert). A `SELECT ... FOR UPDATE` that was waiting on the old row version
// then fails `40001` ("tuple to be locked was already moved to another partition"). A lock on an assessment row (the
// assessment lock here, the sign lock, the SFV-completion draft lock) runs the statement under a savepoint and retries it
// ONCE (`retryMovedRow`): the retry finds the row where it now lives, and a caller that judges status or version on the
// locked row then judges the moved row. A second `40001` is left to the generic handler's retryable 409.
import { type DbClient, schema } from "@chartwarden/db";
import { HopeStateError } from "@chartwarden/hope";
import { and, eq, sql } from "drizzle-orm";
import { idForLog } from "./hope-log-id";
import type { HopeIsc } from "./hope-spec-registry";
import { canonicalUuidOrNull } from "./hope-uuid";
import { sqlStateOf } from "./sql-state";

const ASSESS = schema.hopeAssessments;
const SFV = schema.symptomFollowUpVisits;

/** How long a record write waits for a row lock another transaction holds before it answers `M10_RECORD_BUSY`. */
export const M10_LOCK_TIMEOUT_MS = 5_000;
/** Postgres `lock_not_available` (a `lock_timeout` expired). */
const LOCK_NOT_AVAILABLE = "55P03";
/** Postgres `serialization_failure`, which a row that moved partition under a lock wait also raises. */
const SERIALIZATION_FAILURE = "40001";
/** The assessment lock's first attempt plus ONE retry after a partition move. */
const MAX_LOCK_ATTEMPTS = 2;

/**
 * What a lock needs to know about the row, and nothing else: the identity and siting columns a writer copies onto the
 * rows it creates, the status / version it judges, and the RFA / ISC / spec / correction fields the control-answer and
 * SFV reconciliations read. NOT the two jsonb payloads (`data`, `clinical_context_snapshot`, PHI that can be large) nor
 * the rest of the row: a caller that needs more reads it itself, after the lock.
 */
const LOCKED_COLUMNS = {
  id: ASSESS.id,
  organizationId: ASSESS.organizationId,
  providerEntityId: ASSESS.providerEntityId,
  locationId: ASSESS.locationId,
  patientId: ASSESS.patientId,
  admissionId: ASSESS.admissionId,
  rfaKind: ASSESS.rfaKind,
  specVersionId: ASSESS.specVersionId,
  isc: ASSESS.isc,
  status: ASSESS.status,
  version: ASSESS.version,
  correctsAssessmentId: ASSESS.correctsAssessmentId,
} as const;
export type LockedAssessment = Pick<typeof ASSESS.$inferSelect, keyof typeof LOCKED_COLUMNS>;

async function boundLockWait(tx: DbClient): Promise<void> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${M10_LOCK_TIMEOUT_MS}ms'`));
}

/**
 * The lock a `55P03` came from when the caller did not say: a later statement of a transaction whose bound an earlier
 * lock helper set (see `mapLockTimeoutToBusy`).
 */
const UNLABELLED_LOCK = "an unlabelled lock wait";

/**
 * Nothing about the failed statement is kept on the error: a driver message can carry bound values. The wording does not
 * claim nothing was saved: `getAssessmentWorkspace`, `getAssessmentReview` and `signTimepoint` commit a spec-initialisation
 * transaction BEFORE the one that can time out. `lock` (the kind of lock and the ids it was taken on, never a target date
 * or record content) is logged, not returned: the 409 body is the same for every lock.
 */
const recordBusy = (lock: string): HopeStateError => {
  console.warn(`m10: M10_RECORD_BUSY: the lock wait timed out on ${lock}.`);
  return new HopeStateError(
    "M10_RECORD_BUSY",
    "The record is busy. This step was not applied (an earlier step of the same request may have been); check the current state, then send the request again.",
  );
};

/**
 * Run ONE lock-taking statement (a `SELECT ... FOR UPDATE`, an advisory lock, or an UPDATE that queues behind a row
 * lock) under the bounded wait: `lock_timeout` is set transaction-locally first, and a `55P03` becomes
 * `M10_RECORD_BUSY` (this statement was not applied; check the current state, then send the request again). `statement` receives the executor to
 * run on: the transaction itself, or, with `retryMovedRow`, a savepoint of it (a failed statement aborts the whole
 * transaction unless it can be rolled back to one, and the retry needs the transaction, and any lock taken before it,
 * intact). `retryMovedRow` retries the statement ONCE on a `40001`, which an assessment row that moved partition under
 * the wait raises; any other failure, and a second `40001`, is left to the generic handler. `lock` names the lock for
 * the timeout's log line: its kind and the ids it was taken on (through `idForLog`), nothing else.
 */
export async function takeBoundedLock<T>(
  tx: DbClient,
  statement: (executor: DbClient) => PromiseLike<T>,
  options: { readonly retryMovedRow?: boolean; readonly lock?: string } = {},
): Promise<T> {
  await boundLockWait(tx);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return options.retryMovedRow
        ? await tx.transaction(async (savepoint) => statement(savepoint as unknown as DbClient))
        : await statement(tx);
    } catch (error) {
      const state = sqlStateOf(error);
      if (state === LOCK_NOT_AVAILABLE) throw recordBusy(options.lock ?? UNLABELLED_LOCK);
      if (options.retryMovedRow && state === SERIALIZATION_FAILURE && attempt < MAX_LOCK_ATTEMPTS)
        continue;
      throw error;
    }
  }
}

/**
 * `db` with `transaction()` answering `M10_RECORD_BUSY` for a `55P03` raised ANYWHERE in the transaction: the bound a lock
 * helper sets stays in force for the rest of its transaction, so a later statement that waits (an UPDATE behind a row
 * lock, an answer upsert) can time out too, and without this it would reach the generic handler as a 500. Every other
 * member of `db` is the database's own. The platform's shared retryable-SQLSTATE list is deliberately left alone.
 */
export function mapLockTimeoutToBusy<D extends DbClient>(db: D): D {
  const wrapped = Object.create(db) as D;
  Object.defineProperty(wrapped, "transaction", {
    configurable: true,
    writable: true,
    value: async (...args: unknown[]): Promise<unknown> => {
      try {
        return await (db.transaction as (...a: unknown[]) => Promise<unknown>).apply(db, args);
      } catch (error) {
        throw sqlStateOf(error) === LOCK_NOT_AVAILABLE
          ? recordBusy("a statement of the transaction that took no lock helper of its own")
          : error;
      }
    },
  });
  return wrapped;
}

/**
 * The assessment row, read `FOR UPDATE` (undefined when it does not exist, or when `assessmentId` is no uuid). The row is returned AS LOCKED: a caller that
 * judged status or version on an earlier unlocked read judges them again on this one, because a writer that committed
 * in between is only visible here. Waits at most `M10_LOCK_TIMEOUT_MS` (then `M10_RECORD_BUSY`); see the header for the
 * one retry after a partition move.
 */
export async function lockAssessmentRow(
  tx: DbClient,
  organizationId: string,
  assessmentId: string,
): Promise<LockedAssessment | undefined> {
  // An id that is no uuid names no row: "absent" with no statement (a `= 'not-a-uuid'` comparison would be a 22P02, a 500),
  // and the lookup runs on the canonical text, never the caller's spelling.
  const id = canonicalUuidOrNull(assessmentId);
  if (id === null) return undefined;
  const [row] = await takeBoundedLock(
    tx,
    (statement) =>
      statement
        .select(LOCKED_COLUMNS)
        .from(ASSESS)
        .where(and(eq(ASSESS.id, id), eq(ASSESS.organizationId, organizationId)))
        .limit(1)
        .for("update"),
    {
      retryMovedRow: true,
      lock: `assessment row ${idForLog(assessmentId)} (org ${idForLog(organizationId)})`,
    },
  );
  return row;
}

/**
 * A transaction-scoped advisory lock: the serialisation point for a check-then-insert that no row lock can cover because
 * the row does not exist yet (one draft per admission and RFA, one pending correction per signed record). Take it BEFORE
 * any row lock of the same transaction, so it can never be the second half of a lock-order inversion. Waits at most
 * `M10_LOCK_TIMEOUT_MS` (then `M10_RECORD_BUSY`).
 *
 * The key is `<scope>:<id><suffix>`, and the id goes through Postgres's own uuid parser (`$1::uuid` reads it, `::text`
 * writes it back lower-case and hyphenated), never through the caller's spelling: a route id is only length-checked, uuid
 * equality is case-insensitive and also accepts braces and a missing hyphen, so two requests for one record that spell
 * its id differently would otherwise hash to two keys and both pass the check. The text of a canonical id is what the key
 * always held, so the key of an existing lock does not change. Without an `id` the key is `scope` as given.
 */
export async function lockRecordKey(
  tx: DbClient,
  scope: string,
  id?: string,
  suffix = "",
): Promise<void> {
  const key =
    id === undefined
      ? sql`${scope}::text`
      : sql`${scope}::text || ':' || (${id}::uuid)::text || ${suffix}::text`;
  await takeBoundedLock(
    tx,
    (statement) =>
      statement.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`),
    { lock: `advisory key ${scope}${id === undefined ? "" : ` ${idForLog(id)}`}` },
  );
}

/**
 * The triggering SFV row FIRST, before any answer is written. `recordSfv` locks the SFV row and then upserts the
 * triggering draft's J2052/J2053 answers; a patch that upserted answers and only then let the SFV reconciliation update
 * that row would take the same two locks in the opposite order (a 40P01 deadlock: a retryable 409, nothing persisted).
 * Every HA admission draft takes it, not only a patch that names a J2051 input: derived touches can reach one too, and
 * reconciliation acts on exactly these records. No SFV yet means no row and no lock. Waits at most
 * `M10_LOCK_TIMEOUT_MS` (then `M10_RECORD_BUSY`).
 */
export async function lockTriggeredSfv(
  tx: DbClient,
  organizationId: string,
  assessment: Pick<LockedAssessment, "id" | "rfaKind">,
  isc: HopeIsc,
): Promise<void> {
  if (isc !== "HA" || assessment.rfaKind !== "01_admission") return;
  await takeBoundedLock(
    tx,
    (statement) =>
      statement
        .select({ id: SFV.id })
        .from(SFV)
        .where(
          and(
            eq(SFV.organizationId, organizationId),
            eq(SFV.triggeringAssessmentId, assessment.id),
          ),
        )
        .for("update"),
    {
      lock: `SFV row of triggering assessment ${idForLog(assessment.id)} (org ${idForLog(organizationId)})`,
    },
  );
}
