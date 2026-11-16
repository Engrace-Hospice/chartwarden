// M10 (R-08) — the DB side of cancelling a never-uploaded iQIES package. The rules (which statuses may be
// cancelled, the 409 texts) live in hope-submission-cancel.ts so the in-memory slice shares them.
import { type DbClient, schema } from "@chartwarden/db";
import { require_ } from "@chartwarden/hope";
import { NotFoundError } from "@chartwarden/types";
import type { HopeSubmissionCancelReasonCode } from "@chartwarden/types";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { takeBoundedLock } from "./hope-assessment-lock";
import { errorClassForLog, idForLog } from "./hope-log-id";
import { auditHopeSubmissionCancelled } from "./hope-operator-audit";
import type { HopeAuditRequestFacts } from "./hope-signature-audit";
import {
  cancelNotAllowedMessage,
  isCancellableSubmissionStatus,
  requireNotCancelled,
} from "./hope-submission-cancel";
import { LIGHT_SUB_COLUMNS, type LightSubmissionColumns } from "./hope-submission-reads-db";
import { uuidOrNotFound } from "./hope-uuid";
import { heldPatientSql } from "./jobs/retention-store";

const SUB = schema.hopeSubmissions;
const SUBITEM = schema.hopeSubmissionItems;
const ASSESSMENT = schema.hopeAssessments;

/**
 * The M4 legal-hold read a package cancel's byte purge is gated on, run ON THE CANCEL'S OWN TRANSACTION (bound at the composition
 * root to M4's `activeLegalHoldScopeInTransaction`; M10 never reads M4's `legal_hold` table itself). One statement on the open
 * transaction, so the cancel holds one connection, not two. Unbound, or a failing read, FAILS CLOSED: the bytes are kept.
 */
export interface HopeCancelHoldPort {
  activeLegalHoldScopeInTransaction(
    tx: DbClient,
    organizationId: string,
  ): Promise<{ readonly orgWide: boolean; readonly patientIds: ReadonlySet<string> }>;
}

/**
 * Why a cancel kept the bytes, as the audit event records it: `legal_hold` (an org-wide hold, or a held patient among the batch's
 * records), `hold_scope_unreadable` (no reader bound, the read failed, or a held patient id is no uuid so WHO is held cannot be
 * decided: nothing is known to be held, but nothing can be shown not to be), or `none` (the bytes were purged).
 */
export type HopeBytesKeptReason = "legal_hold" | "hold_scope_unreadable" | "none";

/**
 * Read the org's active legal-hold scope as a statement of the cancel's transaction, AFTER its batch row lock. It runs in a
 * SAVEPOINT, so a failed statement (a permission, a missing relation) aborts only the read and not the cancel: the cancel still
 * happens and keeps the bytes. Never throws; the log line carries the organisation id and the error class only. There is no
 * deadline of its own: the statement is bounded as every other statement of this transaction is. Nothing locks `legal_hold`,
 * so a hold committed after this statement and before the commit (the cancel's remaining statements) is not seen: that window is
 * statement-sized, not the checkout-and-lock-wait window of a read made before the transaction.
 */
async function readHoldScope(
  t: DbClient,
  holds: HopeCancelHoldPort | undefined,
  organizationId: string,
) {
  if (!holds) return null;
  try {
    return await t.transaction((savepoint) =>
      holds.activeLegalHoldScopeInTransaction(savepoint as unknown as DbClient, organizationId),
    );
  } catch (error) {
    console.warn(
      `m10: cancel: the M4 legal-hold read failed for organization ${idForLog(organizationId)} (${errorClassForLog(error)}); the package bytes are kept.`,
    );
    return null;
  }
}

/**
 * Whether a legal hold forbids purging this batch's bytes, judged on the scope read NOW (see {@link readHoldScope}): an org-wide
 * hold, or ANY item whose assessment belongs to a held patient (the ZIP is one blob, so one held record keeps the whole batch's
 * bytes). An unreadable scope, or a held patient id that is no uuid, is `hold_scope_unreadable`.
 */
async function bytesKeptReasonOf(
  t: DbClient,
  batchId: string,
  organizationId: string,
  holds: HopeCancelHoldPort | undefined,
): Promise<HopeBytesKeptReason> {
  const scope = await readHoldScope(t, holds, organizationId);
  if (scope === null) return "hold_scope_unreadable";
  if (scope.orgWide) return "legal_hold";
  if (scope.patientIds.size === 0) return "none";
  const held = heldPatientSql(scope.patientIds);
  if (held.ignored > 0) return "hold_scope_unreadable";
  const [hit] = await t
    .select({ id: SUBITEM.id })
    .from(SUBITEM)
    .innerJoin(
      ASSESSMENT,
      and(
        eq(ASSESSMENT.id, SUBITEM.hopeAssessmentId),
        eq(ASSESSMENT.organizationId, SUBITEM.organizationId),
      ),
    )
    .where(
      and(
        eq(SUBITEM.hopeSubmissionId, batchId),
        eq(SUBITEM.organizationId, organizationId),
        held.predicate,
      ),
    )
    .limit(1);
  return hit === undefined ? "none" : "legal_hold";
}

export interface CancelHopeSubmissionArgs {
  readonly id: string;
  /**
   * The tenant the batch belongs to: an explicit predicate on every statement (on top of RLS, so a connection that
   * bypasses RLS still cannot cancel another tenant's batch), and named (with the batch id) in the lock-timeout log line.
   */
  readonly organizationId: string;
  /**
   * The acting membership: stored on the batch (`cancelled_by_membership_id`) and named in the explicit
   * `hope.submission_cancelled` audit event. The M4 row-diff trigger records the change too, but its `actor_user_id`
   * is only whatever the ambient request context carries (the service opens `withOrgContext` with no user), so the
   * explicit event is what names the operator.
   */
  readonly actorMembershipId: string;
  readonly reasonCode: HopeSubmissionCancelReasonCode;
  readonly now: Date;
  /**
   * The M4 legal-hold read the purge is gated on. REQUIRED, with no default (`undefined` is spelt out by a caller that has none,
   * and keeps the bytes): it is a safety input, and a default of "nothing is held" would purge held bytes when a caller forgot it.
   */
  readonly legalHolds: HopeCancelHoldPort | undefined;
  /** The request's id / address / user agent / session user, carried into the audit event (none for a direct call). */
  readonly request?: HopeAuditRequestFacts;
}

const CANCEL_LOCK_LABEL = (id: string, organizationId: string): string =>
  `submission row ${idForLog(id)} (org ${idForLog(organizationId)}) for a cancel`;

/**
 * Cancel one batch inside the caller's `withOrgContext` transaction. The batch row is locked first, so a
 * double click, a retry after a lost reply, or a cancel racing Mark uploaded sees one consistent status.
 *
 * Unless a legal hold applies, the package bytes (`acceptance_report`) and EVERY item's XML (`iqies_validation_result`) are
 * NULLed in the same transaction: a cancelled package was never transmitted, so it has no CMS 10-year anchor, no scan or
 * eraser reaches it (`hope_submission` carries no patient id), and keeping its PHI would be retention without a purpose
 * (CW-DS-01). The purge is a LOGICAL deletion (NULLed jsonb: dead tuples until vacuum, WAL/replicas/backups until their own
 * retention expires). What stays is the evidence that a package existed: its SHA-256, size, filename and the `cancelled_*`
 * provenance, and each item's own XML hash and size. The audit event names the hash of the package whose bytes were purged.
 *
 * A legal hold wins over the purge (HIPAA hold semantics: the retention cron honours the same M4 holds): when an org-wide
 * hold is active, when ANY item of the batch belongs to a held patient, or when the hold scope cannot be read (fail
 * CLOSED), the cancel still happens but the batch keeps ALL its bytes, and the audit event records WHY
 * (`bytesKeptReason`: `legal_hold` or `hold_scope_unreadable`). The scope is read after the row lock, on this transaction.
 *
 * REPEATING a cancel is the purge path for bytes that were kept: on an already-cancelled batch that still holds bytes, the
 * scope is read again; when nothing holds them now (the hold was released, or the M4 read works again) the same purge runs and
 * a `hope.submission_cancelled` event with `packageBytesPurged: true` and `repeatCancel: true` is written, WITHOUT changing the
 * status or the provenance (the original reason, time and actor stand). When a hold still applies, or the batch holds no bytes
 * (the common replay: one cheap read), it returns the batch unchanged and writes nothing. RLS hides another tenant's batch,
 * so it reads as absent (404), and so does an id that is no uuid (answered before any statement, never sent to a `::uuid`
 * comparison). The lock waits at most `M10_LOCK_TIMEOUT_MS` (then `M10_RECORD_BUSY`: this step was not applied).
 */
export async function cancelHopeSubmission(
  t: DbClient,
  args: CancelHopeSubmissionArgs,
): Promise<LightSubmissionColumns> {
  const id = uuidOrNotFound(args.id, `HOPE submission ${args.id} not found`);
  // Only the light columns: the package ZIP (`acceptance_report`) is neither read under the lock nor echoed back by the
  // UPDATE.
  const [row] = (await takeBoundedLock(
    t,
    (statement) =>
      statement
        .select(LIGHT_SUB_COLUMNS)
        .from(SUB)
        .where(and(eq(SUB.id, id), eq(SUB.organizationId, args.organizationId)))
        .limit(1)
        .for("update"),
    { lock: CANCEL_LOCK_LABEL(id, args.organizationId) },
  )) as LightSubmissionColumns[];
  if (!row) throw new NotFoundError(`HOPE submission ${id} not found`);
  if (row.status === "cancelled") return repeatCancel(t, args, id, row);
  require_(
    isCancellableSubmissionStatus(row.status),
    "M10_SUBMISSION_CANCEL_NOT_ALLOWED",
    cancelNotAllowedMessage(id, row.status),
  );
  // The cancel always happens; ONLY the byte purge is conditional on the org's legal holds (M4). A held record's bytes are
  // kept whole (the ZIP cannot be partially cleared), and the audit event says why.
  const bytesKeptReason = await bytesKeptReasonOf(t, id, args.organizationId, args.legalHolds);
  const keepBytes = bytesKeptReason !== "none";
  // Every item of the batch, whatever its status (the purge must not depend on the state machine): its XML (PHI: name, DOB,
  // MBI/SSN) is dropped with the package. Only a `pending` item flips to `cancelled`; any other status stays as it is. One
  // statement, so each item is rewritten (and audited by the row-diff trigger) once.
  const itemRows = await t
    .update(SUBITEM)
    .set({
      itemStatus: sql`case when ${SUBITEM.itemStatus} = 'pending' then 'cancelled' else ${SUBITEM.itemStatus} end`,
      ...(keepBytes ? {} : { iqiesValidationResult: null }),
      updatedAt: args.now,
    })
    .where(and(eq(SUBITEM.hopeSubmissionId, id), eq(SUBITEM.organizationId, args.organizationId)))
    .returning({ id: SUBITEM.id, itemStatus: SUBITEM.itemStatus });
  const itemsCancelled = itemRows.filter((item) => item.itemStatus === "cancelled").length;
  const [cancelled] = (await t
    .update(SUB)
    .set({
      status: "cancelled",
      cancelledAt: args.now,
      cancelledByMembershipId: args.actorMembershipId,
      cancelReasonCode: args.reasonCode,
      ...(keepBytes ? {} : { acceptanceReport: null }),
      updatedAt: args.now,
    })
    .where(and(eq(SUB.id, id), eq(SUB.organizationId, args.organizationId)))
    .returning(LIGHT_SUB_COLUMNS)) as LightSubmissionColumns[];
  // Unreachable in practice: the row lock above holds this row until the transaction ends and the UPDATE's predicate
  // (the id and the tenant the lock matched) selects exactly it, so it always returns the locked row. Kept as defence in
  // depth (a zero-row result fails loudly as a 404 instead of returning `undefined`).
  if (!cancelled) throw new NotFoundError(`HOPE submission ${id} not found`);
  await auditHopeSubmissionCancelled(t, {
    organizationId: args.organizationId,
    membershipId: args.actorMembershipId,
    request: args.request,
    submissionId: id,
    providerEntityId: row.providerEntityId,
    reasonCode: args.reasonCode,
    priorStatus: row.status,
    packageSha256: row.packageSha256 ?? null,
    itemsCancelled,
    bytesKeptReason,
    repeatCancel: false,
  });
  return cancelled;
}

/**
 * A cancel of a batch that is already cancelled (see {@link cancelHopeSubmission}): unchanged unless it still holds bytes AND no
 * hold applies now, in which case the bytes are purged (status, reason, time and actor untouched) and the event is written.
 * The row is locked by the caller.
 */
async function repeatCancel(
  t: DbClient,
  args: CancelHopeSubmissionArgs,
  id: string,
  row: LightSubmissionColumns,
): Promise<LightSubmissionColumns> {
  // Only the ids: the ZIP is neither read nor returned. The first branch is the batch's own bytes, the second any item's XML.
  const [stillHoldsBytes] = await t
    .select({ id: SUB.id })
    .from(SUB)
    .where(
      and(
        eq(SUB.id, id),
        eq(SUB.organizationId, args.organizationId),
        or(
          isNotNull(SUB.acceptanceReport),
          sql`exists (select 1 from ${SUBITEM} where ${SUBITEM.hopeSubmissionId} = ${SUB.id} and ${SUBITEM.organizationId} = ${SUB.organizationId} and ${SUBITEM.iqiesValidationResult} is not null)`,
        ),
      ),
    )
    .limit(1);
  if (!stillHoldsBytes) return row;
  const bytesKeptReason = await bytesKeptReasonOf(t, id, args.organizationId, args.legalHolds);
  if (bytesKeptReason !== "none") return row;
  await t
    .update(SUBITEM)
    .set({ iqiesValidationResult: null, updatedAt: args.now })
    .where(
      and(
        eq(SUBITEM.hopeSubmissionId, id),
        eq(SUBITEM.organizationId, args.organizationId),
        isNotNull(SUBITEM.iqiesValidationResult),
      ),
    );
  const [purged] = (await t
    .update(SUB)
    .set({ acceptanceReport: null, updatedAt: args.now })
    .where(and(eq(SUB.id, id), eq(SUB.organizationId, args.organizationId)))
    .returning(LIGHT_SUB_COLUMNS)) as LightSubmissionColumns[];
  if (!purged) throw new NotFoundError(`HOPE submission ${id} not found`);
  await auditHopeSubmissionCancelled(t, {
    organizationId: args.organizationId,
    membershipId: args.actorMembershipId,
    request: args.request,
    submissionId: id,
    providerEntityId: row.providerEntityId,
    // The reason the batch was cancelled for stands; a repeat's own body is not stored anywhere.
    reasonCode: row.cancelReasonCode ?? args.reasonCode,
    priorStatus: row.status,
    packageSha256: row.packageSha256 ?? null,
    itemsCancelled: 0,
    bytesKeptReason: "none",
    repeatCancel: true,
  });
  return purged;
}

/**
 * `packaged -> exported` on a download, written only if the batch is STILL `packaged`. The UPDATE queues behind the
 * row lock a concurrent cancel (or mark-uploaded) holds and then re-checks its predicate, so it can never write
 * `exported` over `cancelled` / `submitted_pending_result`. When it matches nothing the status is re-read: a batch
 * cancelled in the meantime refuses the download (409 M10_SUBMISSION_CANCELLED, the transaction rolls back and no
 * bytes leave); one marked uploaded in the meantime is simply a re-download of an uploaded batch. The queueing UPDATE
 * waits at most `M10_LOCK_TIMEOUT_MS` (then `M10_RECORD_BUSY`: this step was not applied).
 */
export async function advancePackagedToExported(
  t: DbClient,
  organizationId: string,
  urlId: string,
  /**
   * The membership that downloaded the package: stamped as `exported_by_membership_id` beside `exported_at`, so the row
   * says WHO took the PHI package out. `null` only for a direct service call that names no actor (the route always does).
   */
  actorMembershipId: string | null,
): Promise<void> {
  const id = uuidOrNotFound(urlId, `HOPE submission ${urlId} not found`);
  const at = new Date();
  const advanced = await takeBoundedLock(
    t,
    (statement) =>
      statement
        .update(SUB)
        .set({
          status: "exported",
          exportedAt: at,
          exportedByMembershipId: actorMembershipId,
          updatedAt: at,
        })
        .where(
          and(eq(SUB.id, id), eq(SUB.organizationId, organizationId), eq(SUB.status, "packaged")),
        )
        .returning({ id: SUB.id }),
    {
      lock: `submission row ${idForLog(id)} (org ${idForLog(organizationId)}) for a package download`,
    },
  );
  if (advanced.length > 0) return;
  const [current] = await t
    .select({ status: SUB.status })
    .from(SUB)
    .where(and(eq(SUB.id, id), eq(SUB.organizationId, organizationId)))
    .limit(1);
  if (!current) throw new NotFoundError(`HOPE submission ${id} not found`);
  requireNotCancelled(id, current.status);
}
