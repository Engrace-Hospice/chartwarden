// apps/backend/src/modules/23-billing-medicare/services/external-notice-filing.ts — a tenant that "bills outside ChartWarden"
// files its NOE / NOTR itself (owner decision D4, ADR-0053 amendment 2026-11-06).
//
// ChartWarden transmits NOTHING for such a tenant. Submitting a notice PARKS it (`external_filing_status = 'pending'`: no
// claim_submission, no job, no `*.submit_requested` event) and the tenant records the date it filed. Until then the notice stays
// on the deadline tracker (the window watch and the DDE watchdog read `window_target_at`, which nothing here touches); recording the
// date takes it off (`'filed'`), stamping the breach on record when the tenant filed after the due date. The notice's STATE never
// changes (a parked notice stays draft / ready): the NOE / NOTR machines describe what ChartWarden did with it, and it did nothing.
//
// The mutation is one version-checked same-state patch through the notice repository, captured by the table's write-audit trigger
// (the actor is the session user; the membership is on the row). A filing recorded AFTER the due date also publishes one catalogued
// event in the same transaction (`m23.noe|notr.filed_externally_late`: ids and dates only), which M23's own outbox consumer turns
// into the M36 alert to the tenant and the platform-ops notice. The decision rules are pure (`planExternalFilingRecord` in
// @chartwarden/billing); the date they judge "today" against is the Eastern (CMS) calendar day.
import {
  type NoticeState,
  medicareReceiptDay,
  planExternalFilingRecord,
  repositories,
} from "@chartwarden/billing";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import {
  type BillingDb,
  type BillingWriteActor,
  type WriteOutboxPort,
  assertNotAiActor,
} from "./claim-state-service";

/** Whether the organization currently bills outside ChartWarden (bound at the composition root over `TenantClearinghouseReader`). */
export type BillsOutsidePort = (organizationId: string) => Promise<boolean>;

export type ExternalNoticeKind = "noe" | "notr";

/**
 * Ask whether `organizationId` bills outside. No port bound = a deployment where nobody does (false). A read that FAILS is a typed
 * 503, never a guess: answering "no" could transmit for a tenant that files elsewhere, and "yes" could park a notice for one that
 * does not.
 */
export async function orgBillsOutside(
  port: BillsOutsidePort | undefined,
  organizationId: string,
): Promise<boolean> {
  if (!port) return false;
  try {
    return await port(organizationId);
  } catch {
    throw new ChartWardenError(
      "CLEARINGHOUSE_CHOICE_UNAVAILABLE",
      "this organization's clearinghouse choice could not be read; nothing was queued, sent or recorded",
      503,
    );
  }
}

/** The columns an external-filing change may set alongside `windowBreachedAt` (common to the NOE and NOTR patches). */
export type ExternalFilingPatch = Pick<
  repositories.NoeTransitionPatch,
  | "externalFilingStatus"
  | "filedExternallyOn"
  | "filedExternallyRecordedAt"
  | "filedExternallyByMembershipId"
  | "windowBreachedAt"
>;

/** Park the notice for the tenant to file. */
export const PARK_PATCH: ExternalFilingPatch = { externalFilingStatus: "pending" };
/** Clear the marker: ChartWarden transmits for the org again, and the notice goes the normal way. */
export const UNPARK_PATCH: ExternalFilingPatch = { externalFilingStatus: null };

/** What both notice repositories offer that parking needs. */
export interface ExternalFilingRow {
  readonly id: string;
  readonly state: NoticeState;
  readonly version: number;
  readonly externalFilingStatus: "pending" | "filed" | null;
}
export interface ExternalFilingRepo<R extends ExternalFilingRow> {
  transitionToState(
    id: string,
    expectedVersion: number,
    nextState: NoticeState,
    patch: ExternalFilingPatch,
  ): Promise<{ ok: true; row: R } | { ok: false; currentVersion: number | null }>;
}

const versionConflict = (currentVersion: number | null): ChartWardenError =>
  new ChartWardenError(
    "VERSION_CONFLICT",
    `the record was modified concurrently (current version ${currentVersion ?? "unknown"})`,
    412,
  );

/** Same-state, version-checked change of the external-filing columns. Throws the 412 on a lost race. */
export async function patchExternalFiling<R extends ExternalFilingRow>(
  repo: ExternalFilingRepo<R>,
  notice: R,
  patch: ExternalFilingPatch,
): Promise<R> {
  const res = await repo.transitionToState(notice.id, notice.version, notice.state, patch);
  if (!res.ok) throw versionConflict(res.currentVersion);
  return res.row;
}

/** Park a notice (idempotent: already `pending` is returned as is). */
export async function parkNotice<R extends ExternalFilingRow>(
  repo: ExternalFilingRepo<R>,
  notice: R,
): Promise<R> {
  return notice.externalFilingStatus === "pending"
    ? notice
    : patchExternalFiling(repo, notice, PARK_PATCH);
}

/**
 * The refusal for a notice the tenant already recorded as filed: a submit must never file it twice, and a cancel must never hide
 * a notice that is on file with Medicare (the correction for a wrong filing is Medicare's, outside ChartWarden).
 */
export const noticeFiledExternally = (
  kind: ExternalNoticeKind,
  action: "submitted" | "cancelled" = "submitted",
): ChartWardenError =>
  new ChartWardenError(
    "NOTICE_FILED_EXTERNALLY",
    `this ${kind.toUpperCase()} is recorded as filed outside ChartWarden and cannot be ${action}`,
    409,
  );

/** The reason a parked notice's leftover queued attempt is closed with (a stable code: no free text). */
export const PARKED_ATTEMPT_REASON = "PARKED_FOR_EXTERNAL_FILING";

/**
 * Close the `queued` transmission attempt a notice may still hold from before its org switched to `outside` (the submit route
 * appended it, the job never ran). Left open it would sit `queued` forever and read as a submission in flight. The attempt log is
 * append-only, so it ends `failed_worker` with a stable reason. No queued attempt (or an already settled one) is left as is.
 */
export async function closeQueuedAttempt(
  tx: BillingDb,
  providerEntityId: string,
  controlNumber: string,
): Promise<void> {
  const submissions = new repositories.ClaimSubmissionRepository(tx);
  const latest = await submissions.findLatestAttempt(providerEntityId, controlNumber);
  if (!latest || latest.outcome !== "queued") return;
  await submissions.terminalize(latest.id, {
    outcome: "failed_worker",
    outcomeReason: PARKED_ATTEMPT_REASON,
    generatedFileUri: null,
    submittedAt: null,
    workerCorrelationId: null,
  });
}

export interface ExternalNoticeFilingPorts {
  readonly billsOutside?: BillsOutsidePort;
  /** The catalog-validating publisher (callerModule m23): a LATE filing publishes its event here, in the record's transaction. */
  readonly outbox?: WriteOutboxPort;
  readonly now?: () => Date;
}

export interface ExternalNoticeFilingService {
  recordNoe(
    actor: BillingWriteActor,
    noeId: string,
    filedOn: string,
  ): Promise<repositories.NoeRecord>;
  recordNotr(
    actor: BillingWriteActor,
    notrId: string,
    filedOn: string,
  ): Promise<repositories.NotrRecord>;
}

interface RecordableRow extends ExternalFilingRow {
  readonly organizationId: string;
  readonly admissionId: string;
  readonly filedExternallyOn: string | null;
  readonly windowTargetAt: string;
  readonly windowBreachedAt: string | null;
}

interface KindOps<R extends RecordableRow> {
  find(tx: BillingDb, id: string): Promise<R | null>;
  repo(tx: BillingDb): ExternalFilingRepo<R>;
  /** The earliest a filing can carry: the NOE election effective date / the NOTR effective end date (the DDE-acceptance rule). */
  earliestDate(row: R): string;
  /** The catalogued event a LATE filing publishes, and the payload key naming the notice. */
  readonly lateEvent: "m23.noe.filed_externally_late" | "m23.notr.filed_externally_late";
  readonly idKey: "noeId" | "notrId";
  readonly aggregateKind: "noe_record" | "notr_record";
}

const NOE_OPS: KindOps<repositories.NoeRecord> = {
  find: (tx, id) => new repositories.NoeRepository(tx).findById(id),
  repo: (tx) => new repositories.NoeRepository(tx),
  earliestDate: (row) => row.electionEffectiveDate,
  lateEvent: "m23.noe.filed_externally_late",
  idKey: "noeId",
  aggregateKind: "noe_record",
};
const NOTR_OPS: KindOps<repositories.NotrRecord> = {
  find: (tx, id) => new repositories.NotrRepository(tx).findById(id),
  repo: (tx) => new repositories.NotrRepository(tx),
  earliestDate: (row) => row.effectiveEndDate,
  lateEvent: "m23.notr.filed_externally_late",
  idKey: "notrId",
  aggregateKind: "notr_record",
};

export function buildExternalNoticeFilingService(
  db: BillingDb,
  ports: ExternalNoticeFilingPorts,
): ExternalNoticeFilingService {
  const now = ports.now ?? (() => new Date());

  async function record<R extends RecordableRow>(
    ops: KindOps<R>,
    actor: BillingWriteActor,
    noticeId: string,
    filedOn: string,
  ): Promise<R> {
    assertNotAiActor(actor);
    // The choice is read before the transaction (the seam opens its own org context; two connections are not held at once).
    if (!(await orgBillsOutside(ports.billsOutside, actor.organizationId))) {
      throw new ChartWardenError(
        "ORG_NOT_BILLING_OUTSIDE",
        "this organization files its notices through ChartWarden; there is no outside filing to record",
        409,
      );
    }
    return withOrgContext<BillingDb, R>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      async (tx) => {
        const notice = await ops.find(tx, noticeId);
        if (!notice || notice.organizationId !== actor.organizationId) {
          throw new NotFoundError("notice");
        }
        const at = now();
        const plan = planExternalFilingRecord({
          state: notice.state,
          externalFilingStatus: notice.externalFilingStatus,
          filedExternallyOn: notice.filedExternallyOn,
          earliestDate: ops.earliestDate(notice),
          windowTargetAt: notice.windowTargetAt,
          windowBreachedAt: notice.windowBreachedAt,
          filedOn,
          today: medicareReceiptDay(at),
        });
        if (plan.kind === "refuse") {
          throw new ChartWardenError(
            plan.code,
            plan.message,
            plan.status,
            plan.status === 422
              ? [{ field: "filedOn", code: plan.code, message: plan.message }]
              : undefined,
          );
        }
        if (plan.kind === "replay") return notice;
        const saved = await patchExternalFiling(ops.repo(tx), notice, {
          externalFilingStatus: "filed",
          filedExternallyOn: filedOn,
          filedExternallyRecordedAt: at,
          filedExternallyByMembershipId: actor.membershipId,
          // The breach on record: the watchdog stops scanning a filed notice, so it would never stamp this one...
          ...(plan.stampBreach ? { windowBreachedAt: filedOn } : {}),
          // ...and one it stamped BEFORE this on-time filing was recorded was wrong: clear it.
          ...(plan.clearBreach ? { windowBreachedAt: null } : {}),
        });
        if (plan.late && ports.outbox) {
          // Ids and dates only (no patient, no free text). Same transaction: the fact and its announcement commit together.
          await ports.outbox.publish(tx, {
            eventName: ops.lateEvent,
            organizationId: actor.organizationId,
            aggregateKind: ops.aggregateKind,
            aggregateId: saved.id,
            payload: {
              [ops.idKey]: saved.id,
              admissionId: saved.admissionId,
              filedOn,
              windowTargetAt: saved.windowTargetAt,
            },
          });
        }
        return saved;
      },
    );
  }

  return {
    recordNoe: (actor, noeId, filedOn) => record(NOE_OPS, actor, noeId, filedOn),
    recordNotr: (actor, notrId, filedOn) => record(NOTR_OPS, actor, notrId, filedOn),
  };
}
