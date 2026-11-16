// M10 (R-08) — the DB side of cancelling a never-uploaded iQIES package. The rules (which statuses may be
// cancelled, the 409 texts) live in hope-submission-cancel.ts so the in-memory slice shares them.
import { type DbClient, schema } from "@chartwarden/db";
import { require_ } from "@chartwarden/hope";
import { NotFoundError } from "@chartwarden/types";
import type { HopeSubmissionCancelReasonCode } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import { takeBoundedLock } from "./hope-assessment-lock";
import { idForLog } from "./hope-log-id";
import {
  cancelNotAllowedMessage,
  isCancellableSubmissionStatus,
  requireNotCancelled,
} from "./hope-submission-cancel";
import { LIGHT_SUB_COLUMNS, type LightSubmissionColumns } from "./hope-submission-reads-db";

const SUB = schema.hopeSubmissions;
const SUBITEM = schema.hopeSubmissionItems;

export interface CancelHopeSubmissionArgs {
  readonly id: string;
  /** The tenant the batch belongs to: named (with the batch id) in the lock-timeout log line, nothing else. */
  readonly organizationId: string;
  /** The acting membership, stored on the batch (the write-audit trigger runs with no actor on this path). */
  readonly actorMembershipId: string;
  readonly reasonCode: HopeSubmissionCancelReasonCode;
  readonly now: Date;
}

/**
 * Cancel one batch inside the caller's `withOrgContext` transaction. The batch row is locked first, so a
 * double click, a retry after a lost reply, or a cancel racing Mark uploaded sees one consistent status.
 *
 * Replaying a cancel on an already-cancelled batch is safe and returns it unchanged (the original reason, time
 * and actor stand; nothing is written). RLS hides another tenant's batch, so it reads as absent (404). The lock waits
 * at most `M10_LOCK_TIMEOUT_MS` (then `M10_RECORD_BUSY`: this step was not applied).
 */
export async function cancelHopeSubmission(
  t: DbClient,
  args: CancelHopeSubmissionArgs,
): Promise<LightSubmissionColumns> {
  // Only the light columns: the package ZIP (`acceptance_report`) stays untouched, neither read under the lock nor
  // echoed back by the UPDATE.
  const [row] = (await takeBoundedLock(
    t,
    (statement) =>
      statement
        .select(LIGHT_SUB_COLUMNS)
        .from(SUB)
        .where(eq(SUB.id, args.id))
        .limit(1)
        .for("update"),
    {
      lock: `submission row ${idForLog(args.id)} (org ${idForLog(args.organizationId)}) for a cancel`,
    },
  )) as LightSubmissionColumns[];
  if (!row) throw new NotFoundError(`HOPE submission ${args.id} not found`);
  if (row.status === "cancelled") return row;
  require_(
    isCancellableSubmissionStatus(row.status),
    "M10_SUBMISSION_CANCEL_NOT_ALLOWED",
    cancelNotAllowedMessage(args.id, row.status),
  );
  await t
    .update(SUBITEM)
    .set({ itemStatus: "cancelled", updatedAt: args.now })
    .where(and(eq(SUBITEM.hopeSubmissionId, args.id), eq(SUBITEM.itemStatus, "pending")));
  const [cancelled] = (await t
    .update(SUB)
    .set({
      status: "cancelled",
      cancelledAt: args.now,
      cancelledByMembershipId: args.actorMembershipId,
      cancelReasonCode: args.reasonCode,
      updatedAt: args.now,
    })
    .where(eq(SUB.id, args.id))
    .returning(LIGHT_SUB_COLUMNS)) as LightSubmissionColumns[];
  // Unreachable in practice: the row lock above holds this row until the transaction ends and the UPDATE adds no
  // predicate of its own, so it always returns the locked row. Kept as defence in depth (a zero-row result fails
  // loudly as a 404 instead of returning `undefined`); it becomes reachable if a predicate is ever added to the UPDATE.
  if (!cancelled) throw new NotFoundError(`HOPE submission ${args.id} not found`);
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
  id: string,
): Promise<void> {
  const at = new Date();
  const advanced = await takeBoundedLock(
    t,
    (statement) =>
      statement
        .update(SUB)
        .set({ status: "exported", exportedAt: at, updatedAt: at })
        .where(and(eq(SUB.id, id), eq(SUB.status, "packaged")))
        .returning({ id: SUB.id }),
    {
      lock: `submission row ${idForLog(id)} (org ${idForLog(organizationId)}) for a package download`,
    },
  );
  if (advanced.length > 0) return;
  const [current] = await t.select({ status: SUB.status }).from(SUB).where(eq(SUB.id, id)).limit(1);
  if (!current) throw new NotFoundError(`HOPE submission ${id} not found`);
  requireNotCancelled(id, current.status);
}
