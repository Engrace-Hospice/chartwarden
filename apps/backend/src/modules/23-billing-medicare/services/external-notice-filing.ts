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
// into the M36 alert to the tenant and the platform-ops notice. A breach the watchdog already stamped is what ChartWarden OBSERVED
// and is never cleared by a tenant's record: an on-time date recorded over one publishes the same event with `breachObservedAt`
// (the observed breach date) next to the attested `filedOn`. The stamp a LATE record wrote itself is that record's own fact: the
// platform operator's withdrawal of the record takes it back. The decision rules are pure (`planExternalFilingRecord` /
// `planExternalFilingWithdrawal` in @chartwarden/billing); the date they judge "today" against is the Eastern (CMS) calendar day.
import {
  type NoticeState,
  medicareReceiptDay,
  planExternalFilingRecord,
  planExternalFilingWithdrawal,
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
/** The reason a job's queued attempt is closed with when the notice it would have sent is already on file outside ChartWarden. */
export const FILED_EXTERNALLY_ATTEMPT_REASON = "NOTICE_FILED_EXTERNALLY";

type Submissions = InstanceType<typeof repositories.ClaimSubmissionRepository>;
type NoticeAttempt = Awaited<ReturnType<Submissions["findById"]>>;

/**
 * The attempt row a NOE / NOTR job OWNS: the one it was enqueued for (`submissionId`), else (a job from before the id was
 * carried) the notice's latest attempt when that one is still queued. Never "whatever is latest": a stale job must not touch the
 * live attempt of a resubmit.
 */
export async function ownedNoticeAttempt(
  submissions: Submissions,
  input: { submissionId?: string; providerEntityId: string; controlNumber: string },
): Promise<NoticeAttempt> {
  if (input.submissionId) return submissions.findById(input.submissionId);
  const latest = await submissions.findLatestAttempt(input.providerEntityId, input.controlNumber);
  return latest?.outcome === "queued" ? latest : null;
}

/**
 * End a still-`queued` attempt a job will never run (the attempt log is append-only: it ends `failed_worker` with a stable
 * reason). Only the OWNING JOB calls this, from inside its own turn: closing a queued attempt from anywhere else can race a
 * worker that is uploading it. No attempt, or one already settled, is left as is.
 */
export async function closeNoticeAttempt(
  submissions: Submissions,
  attempt: NoticeAttempt,
  reason: string,
): Promise<void> {
  if (!attempt || attempt.outcome !== "queued") return;
  await submissions.terminalize(attempt.id, {
    outcome: "failed_worker",
    outcomeReason: reason,
    generatedFileUri: null,
    submittedAt: null,
    workerCorrelationId: null,
  });
}

/**
 * The attempt index a NEW dispatch of this notice takes. The attempt log is append-only and idempotent on
 * `(provider entity, control number, attempt index)`, so reusing the index of a CLOSED attempt (parked, failed) would hand back
 * that closed row: the next index is one past the latest terminal attempt, the latest's own while it is still queued (a repeated
 * submit collapses onto the live attempt), 0 for the first.
 */
export async function nextNoticeAttemptIndex(
  submissions: Pick<Submissions, "findLatestAttempt">,
  providerEntityId: string,
  controlNumber: string,
): Promise<number> {
  const latest = await submissions.findLatestAttempt(providerEntityId, controlNumber);
  if (!latest) return 0;
  return latest.outcome === "queued" ? latest.attemptIndex : latest.attemptIndex + 1;
}

/** One try plus one retry (see {@link appendQueuedNoticeAttempt}). */
const APPEND_QUEUED_ATTEMPT_TRIES = 2;

/**
 * Append the QUEUED attempt a submit enqueues its job for, at the next index. `append` is idempotent on the attempt index and the
 * index comes from a read that is not locked, so a worker can end the notice's latest queued attempt in between (a park, a
 * recorded filing) and the append then hands back a row that is already CLOSED. A job enqueued for a closed attempt transmits
 * nothing (its own attempt is not queued, so it ends), leaving the notice READY with nothing in flight: one retry re-reads the
 * latest attempt (terminal now, so the index moves on); a row still closed after that is a typed 409, never a job and an event
 * for a closed attempt.
 */
export async function appendQueuedNoticeAttempt(
  submissions: Pick<Submissions, "append" | "findLatestAttempt">,
  values: Omit<Parameters<Submissions["append"]>[0], "attemptIndex" | "outcome">,
): Promise<Awaited<ReturnType<Submissions["append"]>>> {
  for (let tries = 0; tries < APPEND_QUEUED_ATTEMPT_TRIES; tries++) {
    const attempt = await submissions.append({
      ...values,
      outcome: "queued",
      attemptIndex: await nextNoticeAttemptIndex(
        submissions,
        values.providerEntityId,
        values.claimControlNumber,
      ),
    });
    if (attempt.outcome === "queued") return attempt;
  }
  throw new ChartWardenError(
    "NOTICE_SUBMIT_CONFLICT",
    "the notice's transmission attempt changed while it was being submitted; submit it again",
    409,
  );
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
  /** The catalogued event a LATE (or breach-contradicting) filing publishes, and the payload key naming the notice. */
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

/** Clears the marker and the three filed columns together (the table's CHECK moves them as one). */
const WITHDRAW_PATCH: ExternalFilingPatch = {
  externalFilingStatus: null,
  filedExternallyOn: null,
  filedExternallyRecordedAt: null,
  filedExternallyByMembershipId: null,
};

/**
 * A platform operator withdraws a tenant's "filed outside ChartWarden" record, on the caller's transaction (already scoped to the
 * tenant's org and attributed to the operator: the table's write-audit trigger names them). The notice returns to its pre-record
 * state (state unchanged), so it can be recorded again or submitted again, and for a NOTR the prior-election closure it provided
 * is gone with the marker (that closure is derived from the marker, `prior-election-closure.ts`). A breach stamp the watchdog set
 * stays; one the withdrawn LATE record wrote itself is cleared with it (`planExternalFilingWithdrawal`), and a notice that really is
 * overdue is re-stamped by the window watch on its next tick (it scans every un-stamped, un-filed notice past its due day).
 * Pinned to the record the operator read (`expectedRecordedAt`); anything else is a 409.
 */
export async function withdrawExternalNoticeFiling(
  tx: BillingDb,
  input: {
    readonly kind: ExternalNoticeKind;
    readonly organizationId: string;
    readonly noticeId: string;
    /** The `recordedAt` the operator read (its `If-Match`); null when the request named none (a 428 that says what to send). */
    readonly expectedRecordedAt: string | null;
  },
): Promise<{
  readonly notice: repositories.NoeRecord | repositories.NotrRecord;
  readonly withdrawnFiledOn: string;
  /** The `recordedAt` of the record withdrawn (what the operator pinned). */
  readonly withdrawnRecordedAt: string;
  /** The breach stamp the withdrawn record wrote itself, now cleared (null: none was cleared; a stamp the watchdog set stays). */
  readonly clearedBreachStamp: string | null;
}> {
  const ops: KindOps<repositories.NoeRecord> | KindOps<repositories.NotrRecord> =
    input.kind === "noe" ? NOE_OPS : NOTR_OPS;
  const notice = await ops.find(tx, input.noticeId);
  if (!notice || notice.organizationId !== input.organizationId) throw new NotFoundError("notice");
  const plan = planExternalFilingWithdrawal({
    externalFilingStatus: notice.externalFilingStatus,
    filedExternallyOn: notice.filedExternallyOn,
    filedExternallyRecordedAt: notice.filedExternallyRecordedAt?.toISOString() ?? null,
    expectedRecordedAt: input.expectedRecordedAt,
    windowTargetAt: notice.windowTargetAt,
    windowBreachedAt: notice.windowBreachedAt,
  });
  if (plan.kind === "refuse") {
    // The retry's If-Match rides in the envelope's details (a timestamp, no id or free text) so the operator can read it.
    throw new ChartWardenError(
      plan.code,
      plan.message,
      plan.status,
      plan.currentRecordedAt
        ? [{ field: "currentRecordedAt", code: plan.code, message: plan.currentRecordedAt }]
        : undefined,
    );
  }
  const saved = await patchExternalFiling(
    ops.repo(tx) as ExternalFilingRepo<typeof notice>,
    notice,
    plan.clearBreach ? { ...WITHDRAW_PATCH, windowBreachedAt: null } : WITHDRAW_PATCH,
  );
  return {
    notice: saved,
    withdrawnFiledOn: plan.withdrawnFiledOn,
    withdrawnRecordedAt: plan.withdrawnRecordedAt,
    clearedBreachStamp: plan.clearBreach ? notice.windowBreachedAt : null,
  };
}

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
        const announce = plan.late || plan.contradictsBreach;
        // A fact nobody is told of must not be written: no outbox bound = refuse before the patch (typed 503, never a silent skip).
        if (announce && !ports.outbox) {
          throw new ChartWardenError(
            "SEAM_UNBOUND",
            "the outbox is not bound: a filing that must be announced to compliance cannot be recorded",
            503,
          );
        }
        const saved = await patchExternalFiling(ops.repo(tx), notice, {
          externalFilingStatus: "filed",
          filedExternallyOn: filedOn,
          filedExternallyRecordedAt: at,
          filedExternallyByMembershipId: actor.membershipId,
          // The breach on record: the watchdog stops scanning a filed notice, so it would never stamp this one. A stamp the watchdog
          // already set is NEVER touched (it is what ChartWarden observed; the tenant's date does not outrank it).
          ...(plan.stampBreach ? { windowBreachedAt: filedOn } : {}),
        });
        if (announce && ports.outbox) {
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
              ...(plan.contradictsBreach && saved.windowBreachedAt
                ? { breachObservedAt: saved.windowBreachedAt }
                : {}),
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
