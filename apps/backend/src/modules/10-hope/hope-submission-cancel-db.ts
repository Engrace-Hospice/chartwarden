// M10 (R-08) — the DB side of cancelling a never-uploaded iQIES package. The rules (which statuses may be
// cancelled, the 409 texts) live in hope-submission-cancel.ts so the in-memory slice shares them.
import { type DbClient, schema } from "@chartwarden/db";
import { require_ } from "@chartwarden/hope";
import { NotFoundError } from "@chartwarden/types";
import type { HopeSubmissionCancelReasonCode } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import { takeBoundedLock } from "./hope-assessment-lock";
import { idForLog } from "./hope-log-id";
import { auditHopeSubmissionCancelled } from "./hope-operator-audit";
import type { HopeAuditRequestFacts } from "./hope-signature-audit";
import {
  cancelNotAllowedMessage,
  isCancellableSubmissionStatus,
  requireNotCancelled,
} from "./hope-submission-cancel";
import { LIGHT_SUB_COLUMNS, type LightSubmissionColumns } from "./hope-submission-reads-db";
import { uuidOrNotFound } from "./hope-uuid";

const SUB = schema.hopeSubmissions;
const SUBITEM = schema.hopeSubmissionItems;

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
  /** The request's id / address / user agent / session user, carried into the audit event (none for a direct call). */
  readonly request?: HopeAuditRequestFacts;
}

/**
 * Cancel one batch inside the caller's `withOrgContext` transaction. The batch row is locked first, so a
 * double click, a retry after a lost reply, or a cancel racing Mark uploaded sees one consistent status.
 *
 * The package bytes (`acceptance_report`) and every item's XML (`iqies_validation_result`) are NULLed in the same
 * transaction: a cancelled package was never transmitted, so it has no CMS 10-year anchor, no scan or eraser reaches it
 * (`hope_submission` carries no patient id), and keeping its PHI would be retention without a purpose (CW-DS-01). What
 * stays is the evidence that a package existed: its SHA-256, size, filename and the `cancelled_*` provenance, and each
 * item's own XML hash and size. The audit event names the hash of the package whose bytes were purged.
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
  // UPDATE (which nulls it).
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
  // Every item of a never-uploaded batch is `pending` (an item settles only after Mark uploaded), so this is all of them:
  // the status flips and the record's XML (PHI: name, DOB, MBI/SSN) is dropped with the package.
  const cancelledItems = await t
    .update(SUBITEM)
    .set({ itemStatus: "cancelled", iqiesValidationResult: null, updatedAt: args.now })
    .where(
      and(
        eq(SUBITEM.hopeSubmissionId, id),
        eq(SUBITEM.organizationId, args.organizationId),
        eq(SUBITEM.itemStatus, "pending"),
      ),
    )
    .returning({ id: SUBITEM.id });
  const [cancelled] = (await t
    .update(SUB)
    .set({
      status: "cancelled",
      cancelledAt: args.now,
      cancelledByMembershipId: args.actorMembershipId,
      cancelReasonCode: args.reasonCode,
      acceptanceReport: null,
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
    itemsCancelled: cancelledItems.length,
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
): Promise<void> {
  const id = uuidOrNotFound(urlId, `HOPE submission ${urlId} not found`);
  const at = new Date();
  const advanced = await takeBoundedLock(
    t,
    (statement) =>
      statement
        .update(SUB)
        .set({ status: "exported", exportedAt: at, updatedAt: at })
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
