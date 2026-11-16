// M10 (R-08) — the DB side of cancelling a never-uploaded iQIES package. The rules (which statuses may be
// cancelled, the 409 texts) live in hope-submission-cancel.ts so the in-memory slice shares them.
import { type DbClient, schema } from "@chartwarden/db";
import { require_ } from "@chartwarden/hope";
import { NotFoundError } from "@chartwarden/types";
import type { HopeSubmissionCancelReasonCode } from "@chartwarden/types";
import { and, eq, sql } from "drizzle-orm";
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
import type { HopeRetentionHoldPort } from "./jobs/cron-workers";
import { DeadlineError, M10_SEAM_READ_TIMEOUT_MS, withinDeadline } from "./jobs/deadline";
import { heldPatientSql } from "./jobs/retention-store";

const SUB = schema.hopeSubmissions;
const SUBITEM = schema.hopeSubmissionItems;
const ASSESSMENT = schema.hopeAssessments;

/**
 * What the cancel knows about the organisation's ACTIVE M4 legal holds. `unreadable` is "the read failed, timed out or
 * no reader is bound": the cancel then FAILS CLOSED and keeps the bytes, exactly as the retention cron refuses to judge an
 * organisation whose hold it cannot read (jobs/cron-workers.ts, jobs/retention-store.ts).
 */
export type HopeCancelHoldScope =
  | { readonly kind: "unreadable" }
  | {
      readonly kind: "read";
      readonly orgWide: boolean;
      readonly patientIds: ReadonlySet<string>;
    };

const UNREADABLE_HOLD_SCOPE: HopeCancelHoldScope = { kind: "unreadable" };

/**
 * Read the org's active legal-hold scope through the M4 port the retention cron uses, BEFORE the cancel's transaction opens
 * (the port runs its own transaction: reading it inside would hold two pool connections per cancel). A hold placed between
 * this read and the commit is not seen; the cancel then purges bytes a hold placed milliseconds earlier would have kept.
 * Never throws: a missing port, a failure or a slow answer is `unreadable`, logged by organisation id and error class only.
 */
export async function readCancelHoldScope(
  holds: HopeRetentionHoldPort | undefined,
  organizationId: string,
): Promise<HopeCancelHoldScope> {
  if (!holds) return UNREADABLE_HOLD_SCOPE;
  try {
    const scope = await withinDeadline(
      () => holds.activeLegalHoldScopeForOrg(organizationId),
      M10_SEAM_READ_TIMEOUT_MS,
      () => new DeadlineError("the M4 legal-hold read", M10_SEAM_READ_TIMEOUT_MS),
    );
    return { kind: "read", orgWide: scope.orgWide, patientIds: scope.patientIds };
  } catch (error) {
    console.warn(
      `m10: cancel: the M4 legal-hold read failed for organization ${idForLog(organizationId)} (${errorClassForLog(error)}); the package bytes are kept.`,
    );
    return UNREADABLE_HOLD_SCOPE;
  }
}

/**
 * Whether a legal hold forbids purging this batch's bytes: an org-wide hold, an unreadable scope, a held patient id that is
 * no uuid (who is held cannot be decided), or ANY item whose assessment belongs to a held patient. The ZIP is one blob, so
 * one held record keeps the whole batch's bytes.
 */
async function legalHoldKeepsBytes(
  t: DbClient,
  batchId: string,
  organizationId: string,
  scope: HopeCancelHoldScope,
): Promise<boolean> {
  if (scope.kind === "unreadable" || scope.orgWide) return true;
  if (scope.patientIds.size === 0) return false;
  const held = heldPatientSql(scope.patientIds);
  if (held.ignored > 0) return true;
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
  return hit !== undefined;
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
   * The org's active legal-hold scope, read by the caller (see {@link readCancelHoldScope}). REQUIRED, with no default: it
   * is a safety input, and a default of "nothing is held" would purge held bytes when a caller forgot it.
   */
  readonly legalHoldScope: HopeCancelHoldScope;
  /** The request's id / address / user agent / session user, carried into the audit event (none for a direct call). */
  readonly request?: HopeAuditRequestFacts;
}

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
 * CLOSED), the cancel still happens but the batch keeps ALL its bytes, and the audit event records
 * `bytesKeptForLegalHold: true`. Nothing erases them later: a held cancelled batch stays until a human purges it.
 *
 * Replaying a cancel on an already-cancelled batch is safe and returns it unchanged (the original reason, time
 * and actor stand; nothing is written, so no second audit event). RLS hides another tenant's batch, so it reads as absent (404), and so does an
 * id that is no uuid (answered before any statement, never sent to a `::uuid` comparison). The lock waits
 * at most `M10_LOCK_TIMEOUT_MS` (then `M10_RECORD_BUSY`: this step was not applied).
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
    {
      lock: `submission row ${idForLog(id)} (org ${idForLog(args.organizationId)}) for a cancel`,
    },
  )) as LightSubmissionColumns[];
  if (!row) throw new NotFoundError(`HOPE submission ${id} not found`);
  if (row.status === "cancelled") return row;
  require_(
    isCancellableSubmissionStatus(row.status),
    "M10_SUBMISSION_CANCEL_NOT_ALLOWED",
    cancelNotAllowedMessage(id, row.status),
  );
  // The cancel always happens; ONLY the byte purge is conditional on the org's legal holds (M4). A held record's bytes are
  // kept whole (the ZIP cannot be partially cleared), and the audit event says so.
  const keepBytes = await legalHoldKeepsBytes(t, id, args.organizationId, args.legalHoldScope);
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
    bytesKeptForLegalHold: keepBytes,
  });
  return cancelled;
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
