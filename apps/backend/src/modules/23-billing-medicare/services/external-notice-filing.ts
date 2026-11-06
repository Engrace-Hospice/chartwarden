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
// (the actor is the session user; the membership is on the row). No outbox event: nothing downstream consumes this fact yet, and an
// event would need a catalog entry and a binding. The decision rules are pure (`planExternalFilingRecord` in @chartwarden/billing).
import { type NoticeState, planExternalFilingRecord, repositories } from "@chartwarden/billing";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { type BillingDb, type BillingWriteActor, assertNotAiActor } from "./claim-state-service";

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

/** The refusal a submit gives for a notice the tenant already recorded as filed (a submit must never file it twice). */
export const noticeFiledExternally = (kind: ExternalNoticeKind): ChartWardenError =>
  new ChartWardenError(
    "NOTICE_FILED_EXTERNALLY",
    `this ${kind.toUpperCase()} is recorded as filed outside ChartWarden and cannot be submitted`,
    409,
  );

export interface ExternalNoticeFilingPorts {
  readonly billsOutside?: BillsOutsidePort;
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
  readonly filedExternallyOn: string | null;
  readonly windowTargetAt: string;
  readonly windowBreachedAt: string | null;
}

interface KindOps<R extends RecordableRow> {
  find(tx: BillingDb, id: string): Promise<R | null>;
  repo(tx: BillingDb): ExternalFilingRepo<R>;
  /** The earliest a filing can carry: the NOE election effective date / the NOTR effective end date (the DDE-acceptance rule). */
  earliestDate(row: R): string;
}

const NOE_OPS: KindOps<repositories.NoeRecord> = {
  find: (tx, id) => new repositories.NoeRepository(tx).findById(id),
  repo: (tx) => new repositories.NoeRepository(tx),
  earliestDate: (row) => row.electionEffectiveDate,
};
const NOTR_OPS: KindOps<repositories.NotrRecord> = {
  find: (tx, id) => new repositories.NotrRepository(tx).findById(id),
  repo: (tx) => new repositories.NotrRepository(tx),
  earliestDate: (row) => row.effectiveEndDate,
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
          today: at.toISOString().slice(0, 10),
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
        return patchExternalFiling(ops.repo(tx), notice, {
          externalFilingStatus: "filed",
          filedExternallyOn: filedOn,
          filedExternallyRecordedAt: at,
          filedExternallyByMembershipId: actor.membershipId,
          // The breach on record: the watchdog stops scanning a filed notice, so it would never stamp this one.
          ...(plan.stampBreach ? { windowBreachedAt: filedOn } : {}),
        });
      },
    );
  }

  return {
    recordNoe: (actor, noeId, filedOn) => record(NOE_OPS, actor, noeId, filedOn),
    recordNotr: (actor, notrId, filedOn) => record(NOTR_OPS, actor, notrId, filedOn),
  };
}
