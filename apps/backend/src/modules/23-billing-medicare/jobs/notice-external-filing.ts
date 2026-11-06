// apps/backend/src/modules/23-billing-medicare/jobs/notice-external-filing.ts — what the NOE / NOTR submit workers do for an
// organization that bills outside ChartWarden (owner decision D4, ADR-0053 amendment 2026-11-06).
//
// A NOE / NOTR job for an `outside` org is not a failure and not a wait: the tenant files the notice itself, so ChartWarden PARKS
// it (`external_filing_status = 'pending'`: "file with your biller", still on the deadline tracker) and the job COMPLETES without
// generating, uploading or announcing anything. The submit route parks a notice itself (it never enqueues for such an org); this
// catches a job enqueued BEFORE the org switched to `outside`. The pre-flight (`holdBeforeRun`) calls it before the job opens its
// own transaction; an org with nothing chosen yet, or a draft / verified config, is HELD instead (clearinghouse-unbound-hold.ts).
// A leaf of m23-jobs.ts (which imports it): ports are named structurally, so the no-circular fitness rule holds.
import { EXTERNALLY_FILEABLE_STATES, repositories } from "@chartwarden/billing";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type ExternalNoticeKind,
  FILED_EXTERNALLY_ATTEMPT_REASON,
  PARKED_ATTEMPT_REASON,
  closeNoticeAttempt,
  ownedNoticeAttempt,
  parkNotice,
} from "../services/external-notice-filing";
import type { M23TransportDeps } from "./clearinghouse-submission";
import { clearinghouseStateFor } from "./clearinghouse-unbound-hold";
import { M23_QUEUES } from "./queues";

type BillingDb = repositories.BillingDb;

/** The empty-string system sentinel `withOrgContext` carries for a worker (the M4 trigger NULLIFs it: no acting user). */
const WORKER_SYSTEM_USER_ID = "";

/** The notice queues whose job is PARKED, not held, for an org that bills outside. */
export const M23_NOTICE_PARK_QUEUES: ReadonlyMap<string, ExternalNoticeKind> = new Map([
  [M23_QUEUES.noeSubmit, "noe"],
  [M23_QUEUES.notrSubmit, "notr"],
]);

const controlNumberOf = (
  notice: { noeControlNumber: string } | { notrControlNumber: string },
): string => ("noeControlNumber" in notice ? notice.noeControlNumber : notice.notrControlNumber);

/** The notice id a notice job carries (`noeId` / `notrId`). A job without it is malformed: it fails loudly, never silently parks. */
export function noticeIdOfJob(
  kind: ExternalNoticeKind,
  data: Readonly<Record<string, unknown>>,
): string {
  const id = kind === "noe" ? data.noeId : data.notrId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`M23 ${kind}.submit job has no ${kind}Id`);
  }
  return id;
}

/**
 * Park the job's notice for the tenant to file, in its own org-scoped transaction, and close the job's OWN queued attempt (this
 * job will never transmit it). Only a notice still waiting to be filed (draft / ready) and not yet marked is parked; one already
 * pending or filed, or already settled by ChartWarden or Medicare, keeps its marker and state, but the job's attempt is closed all
 * the same (the route may have parked it, or the tenant recorded it filed, while this job waited: nothing is left reading as in
 * flight). Another org's notice, or a missing one, is left alone (the job is simply done). Idempotent, so a redelivered job is
 * harmless.
 */
export async function parkNoticeForExternalFiling(
  deps: { readonly db: BillingDb },
  input: {
    readonly organizationId: string;
    readonly kind: ExternalNoticeKind;
    readonly noticeId: string;
    /** The attempt the job was enqueued for. A job without one falls back to the notice's latest QUEUED attempt. */
    readonly submissionId?: string;
  },
): Promise<void> {
  const { organizationId, kind, noticeId, submissionId } = input;
  await withOrgContext<BillingDb, void>(
    deps.db,
    { organizationId, userId: WORKER_SYSTEM_USER_ID },
    async (tx) => {
      const repo =
        kind === "noe" ? new repositories.NoeRepository(tx) : new repositories.NotrRepository(tx);
      const notice = await repo.findById(noticeId);
      if (!notice || notice.organizationId !== organizationId) return;
      if (
        notice.externalFilingStatus === null &&
        EXTERNALLY_FILEABLE_STATES.includes(notice.state)
      ) {
        await parkNotice(repo, notice);
      }
      // The submit that enqueued this job appended a QUEUED attempt that will now never run: close it, or it reads as in flight forever.
      const submissions = new repositories.ClaimSubmissionRepository(tx);
      const attempt = await ownedNoticeAttempt(submissions, {
        submissionId,
        providerEntityId: notice.providerEntityId,
        controlNumber: controlNumberOf(notice),
      });
      await closeNoticeAttempt(submissions, attempt, PARKED_ATTEMPT_REASON);
    },
  );
}

/**
 * The submit workers' last line of defence: they must never reach X12 generation or the transport for an org whose clearinghouse
 * is not live (the org may have switched between the pre-flight and the run). The thrown error is retried by BullMQ, and the next
 * attempt goes through the pre-flight again, which parks or holds the job.
 */
export async function assertNoticeMayTransmit(
  deps: { readonly transport?: M23TransportDeps },
  organizationId: string,
  kind: ExternalNoticeKind,
): Promise<void> {
  const state = await clearinghouseStateFor(deps, organizationId);
  if (state.state === "unbound") {
    throw new Error(
      `${kind.toUpperCase()} submit refused: the organization's clearinghouse is not live (${state.reason})`,
    );
  }
}

/**
 * What a NOE / NOTR submit worker settles BEFORE it generates or uploads anything, in its own transaction: which attempt row is its
 * own, and whether it may transmit at all.
 *   - A notice the tenant recorded as filed outside ChartWarden is on file with Medicare: it is never transmitted a second time.
 *     The job ENDS (returns; a throw would roll back the close) and its own queued attempt is closed.
 *   - A job whose own attempt is already settled or closed (parked, or long done) has nothing to transmit: the notice's live
 *     attempt has its own job.
 * Otherwise `attempt` is the queued row the transmission terminalizes (null: no queued attempt, the worker appends one).
 */
export async function settleNoticeJobAttempt(
  tx: BillingDb,
  input: {
    readonly submissionId?: string;
    readonly providerEntityId: string;
    readonly controlNumber: string;
    readonly externalFilingStatus: "pending" | "filed" | null;
  },
): Promise<
  | { readonly proceed: false }
  | {
      readonly proceed: true;
      readonly attempt: Awaited<ReturnType<repositories.ClaimSubmissionRepository["findById"]>>;
    }
> {
  const submissions = new repositories.ClaimSubmissionRepository(tx);
  const attempt = await ownedNoticeAttempt(submissions, input);
  if (input.externalFilingStatus === "filed") {
    await closeNoticeAttempt(submissions, attempt, FILED_EXTERNALLY_ATTEMPT_REASON);
    return { proceed: false };
  }
  if (input.submissionId && attempt && attempt.outcome !== "queued") return { proceed: false };
  return { proceed: true, attempt };
}
