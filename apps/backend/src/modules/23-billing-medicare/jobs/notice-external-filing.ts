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
import { type ExternalNoticeKind, parkNotice } from "../services/external-notice-filing";
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
 * Park the job's notice for the tenant to file, in its own org-scoped transaction. Only a notice still waiting to be filed
 * (draft / ready) and not yet marked is touched; one already pending or filed, already settled by ChartWarden or Medicare, another
 * org's, or gone is left alone (the job is simply done). Idempotent, so a redelivered job is harmless.
 */
export async function parkNoticeForExternalFiling(
  deps: { readonly db: BillingDb },
  input: {
    readonly organizationId: string;
    readonly kind: ExternalNoticeKind;
    readonly noticeId: string;
  },
): Promise<void> {
  const { organizationId, kind, noticeId } = input;
  await withOrgContext<BillingDb, void>(
    deps.db,
    { organizationId, userId: WORKER_SYSTEM_USER_ID },
    async (tx) => {
      const repo =
        kind === "noe" ? new repositories.NoeRepository(tx) : new repositories.NotrRepository(tx);
      const notice = await repo.findById(noticeId);
      if (!notice || notice.organizationId !== organizationId) return;
      if (notice.externalFilingStatus !== null) return;
      if (!EXTERNALLY_FILEABLE_STATES.includes(notice.state)) return;
      await parkNotice(repo, notice);
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
