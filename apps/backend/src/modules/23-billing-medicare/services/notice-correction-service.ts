// apps/backend/src/modules/23-billing-medicare/services/notice-correction-service.ts — file a corrected NOE / NOTR
// after Medicare rejected one (CMS Pub. 100-04 ch. 11 §20.1.1 / §20.1.2; M23 §2.2 "corrected NOE is its own row").
//
// A notice the 999 or 277CA rejected never posted at the CWF, so the fix is a NEW original notice (TOB 8xA / 8xB),
// drafted here as a copy of the rejected one: same admission / election period / terminating event / provider,
// the notice-owned date optionally corrected (re-validated, window re-derived from it — the NOE clock still runs
// from admission), a fresh D4 control number, and `corrects_notice_id` pointing back. The rejected row is untouched
// history. The draft then goes through the ordinary submit route, queue and ack routing; once accepted it is the
// admission's effective NOE (`findEffectiveByAdmission` skips rejected rows) and the effective NOTR for the
// prior-election closure (`priorElectionClosureTx` counts filed NOTRs per admission).
//
// One correction at a time: `planNoticeCorrection` (pure) replays the correction in progress or the accepted one
// instead of filing a second; `*_open_correction_uq` (migration 0378) is the structural backstop a concurrent
// request hits, answered by the same replay. A notice already superseded by another live NOE / NOTR for the same
// admission / event (e.g. one redrafted from M6) is refused.
//
// Every write runs in one `withOrgContext` transaction (RLS on `app.org_id`, FORCEd); the row insert is captured by
// the table's write-audit trigger and announced by `m23.noe|notr.draft_created` + `.correction_created` on the same
// transaction (transactional outbox). The biller's reason stays on the row — never in an event (it is free text).
import { randomUUID } from "node:crypto";
import {
  type CorrectedDates,
  type NoticeCorrectionPlan,
  type NoticeLink,
  correctedNoticeDates,
  deriveControlNumber,
  minIso,
  planNoticeCorrection,
  repositories,
  validateCorrectionReason,
} from "@wardenx/billing";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, ChartWardenError } from "@wardenx/types";
import {
  type BillingDb,
  type BillingWriteActor,
  type WriteOutboxPort,
  assertNotAiActor,
} from "./claim-state-service";

/** Control numbers carry a 2-digit attempt index (D4); a correction chain deeper than this is refused. */
const MAX_CORRECTION_DEPTH = 99;

/** What the biller sends: why, and optionally the corrected notice-owned date. */
export interface FileNoticeCorrectionArgs {
  readonly reason: string;
  /** NOE: the corrected admission (election effective) date. NOTR: the corrected effective end date. */
  readonly correctedDate?: string | null;
}

export interface NoticeCorrectionResult<R> {
  /** False when the request replayed the correction already in progress (or accepted). */
  readonly created: boolean;
  readonly record: R;
}

export interface NoticeCorrectionPorts {
  readonly outbox?: WriteOutboxPort;
  /** The provider entity's CCN, for the D4 control number (the write service's `ProviderCcnPort`). */
  readonly ccnFor: (
    tx: BillingDb,
    organizationId: string,
    providerEntityId: string,
  ) => Promise<string>;
  readonly now?: () => Date;
}

export interface NoticeCorrectionService {
  correctNoe(
    actor: BillingWriteActor,
    noeId: string,
    args: FileNoticeCorrectionArgs,
  ): Promise<NoticeCorrectionResult<repositories.NoeRecord>>;
  correctNotr(
    actor: BillingWriteActor,
    notrId: string,
    args: FileNoticeCorrectionArgs,
  ): Promise<NoticeCorrectionResult<repositories.NotrRecord>>;
}

/** What a unique violation on the corrected notice's insert means (by the index that refused it). */
type UniqueRace = "open_correction" | "live_notice" | "control_number" | null;

function uniqueRaceOf(err: unknown): UniqueRace {
  const e = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  if ((e?.code ?? e?.cause?.code) !== "23505") return null;
  const constraint = e?.constraint ?? e?.cause?.constraint ?? "";
  if (constraint.endsWith("_control_number_uq")) return "control_number";
  if (constraint === "noe_record_admission_uq" || constraint === "notr_unique_by_event_uq") {
    return "live_notice";
  }
  // `*_open_correction_uq` (or a driver that does not report the constraint): a concurrent correction won.
  return "open_correction";
}

/**
 * A replay answers with the correction already filed; a request that asked for a DIFFERENT date than that
 * correction carries is refused rather than silently ignored.
 */
function assertReplayMatches(
  existingId: string,
  existingDate: string,
  requested?: string | null,
): void {
  if (requested && requested !== existingDate) {
    throw new ChartWardenError(
      "CORRECTION_IN_PROGRESS",
      `a correction with date ${existingDate} is already in progress; cancel it to file a different date`,
      409,
      [{ field: "correctionNoticeId", code: "CORRECTION_IN_PROGRESS", message: existingId }],
    );
  }
}

function refusal(plan: Extract<NoticeCorrectionPlan, { kind: "refuse" }>): ChartWardenError {
  return new ChartWardenError(
    plan.code,
    plan.message,
    409,
    plan.latestId
      ? [{ field: "latestNoticeId", code: plan.code, message: plan.latestId }]
      : undefined,
  );
}

function invalid(field: string, message: string): ChartWardenError {
  return new ChartWardenError("VALIDATION_FAILED", message, 422, [
    { field, code: "VALIDATION_FAILED", message },
  ]);
}

function datesOrThrow(dates: CorrectedDates, field: string): Extract<CorrectedDates, { ok: true }> {
  if (!dates.ok) throw invalid(field, dates.message);
  return dates;
}

/** How deep in its correction chain `source` is (an original = 0). Bounded by the D4 attempt index. */
async function chainDepth(
  find: (id: string) => Promise<{ readonly correctsNoticeId: string | null } | null>,
  source: { readonly correctsNoticeId: string | null },
): Promise<number> {
  let depth = 0;
  let cursor = source.correctsNoticeId;
  while (cursor !== null) {
    depth += 1;
    if (depth >= MAX_CORRECTION_DEPTH) {
      throw new ChartWardenError(
        "CORRECTION_CHAIN_TOO_LONG",
        "this notice has been corrected too many times; contact the MAC",
        409,
      );
    }
    cursor = (await find(cursor))?.correctsNoticeId ?? null;
  }
  return depth;
}

const links = (rows: readonly { id: string; state: NoticeLink["state"] }[]): NoticeLink[] =>
  rows.map((r) => ({ id: r.id, state: r.state }));

export function buildNoticeCorrectionService(
  db: BillingDb,
  ports: NoticeCorrectionPorts,
): NoticeCorrectionService {
  const now = ports.now ?? (() => new Date());
  const today = () => now().toISOString().slice(0, 10);
  const inOrg = <T>(actor: BillingWriteActor, fn: (tx: BillingDb) => Promise<T>) =>
    withOrgContext<BillingDb, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );
  const emit = async (
    tx: BillingDb,
    organizationId: string,
    aggregateKind: string,
    aggregateId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ) => {
    if (ports.outbox) {
      await ports.outbox.publish(tx, {
        eventName,
        organizationId,
        aggregateKind,
        aggregateId,
        payload,
      });
    }
  };

  /**
   * Run `create` (its own transaction). When a concurrent request won the one-open-correction index, answer with
   * its correction instead; a live notice from elsewhere is a 409; a control-number collision (24-bit id prefix)
   * is retried once with a fresh id.
   */
  const withReplayOnRace = async <R>(
    actor: BillingWriteActor,
    create: () => Promise<NoticeCorrectionResult<R>>,
    replay: (tx: BillingDb) => Promise<R | null>,
    attempt = 0,
  ): Promise<NoticeCorrectionResult<R>> => {
    try {
      return await create();
    } catch (err) {
      const race = uniqueRaceOf(err);
      if (race === null) throw err;
      if (race === "control_number" && attempt === 0) {
        return withReplayOnRace(actor, create, replay, attempt + 1);
      }
      // Two corrections of the same notice can trip either index first (the open-correction one, or the admission's
      // one-live-NOE one): whichever it was, the winner's correction is the answer when there is one.
      const record = race === "control_number" ? null : await inOrg(actor, replay);
      if (!record) {
        throw new ChartWardenError(
          "NOTICE_ALREADY_LIVE",
          "another notice for this admission is already in progress",
          409,
        );
      }
      return { created: false, record };
    }
  };

  return {
    async correctNoe(actor, noeId, args) {
      assertNotAiActor(actor);
      const reason = validateCorrectionReason(args.reason);
      if (!reason.ok) throw invalid("reason", reason.message);
      const replayLive = async (tx: BillingDb) => {
        const repo = new repositories.NoeRepository(tx);
        const plan = planNoticeCorrection(
          { id: noeId, state: "ack_rejected" },
          links(await repo.listCorrectionsOf(noeId)),
        );
        const existing = plan.kind === "replay" ? await repo.findById(plan.existing.id) : null;
        if (existing) {
          assertReplayMatches(existing.id, existing.electionEffectiveDate, args.correctedDate);
        }
        return existing;
      };
      return withReplayOnRace(
        actor,
        () =>
          inOrg(actor, async (tx) => {
            const repo = new repositories.NoeRepository(tx);
            const source = await repo.findById(noeId);
            if (!source || source.organizationId !== actor.organizationId) {
              throw new NotFoundError("noe");
            }
            const plan = planNoticeCorrection(
              source,
              links(await repo.listCorrectionsOf(source.id)),
            );
            if (plan.kind === "refuse") throw refusal(plan);
            if (plan.kind === "replay") {
              const existing = await repo.findById(plan.existing.id);
              if (!existing) throw new NotFoundError("noe");
              assertReplayMatches(existing.id, existing.electionEffectiveDate, args.correctedDate);
              return { created: false, record: existing };
            }
            const dates = datesOrThrow(
              correctedNoticeDates({
                sourceDate: source.electionEffectiveDate,
                editedDate: args.correctedDate ?? null,
                today: today(),
              }),
              "correctedDate",
            );
            const live = await repo.findEffectiveByAdmission(source.admissionId);
            if (live) {
              throw new ChartWardenError(
                "NOTICE_ALREADY_LIVE",
                "this admission already has a Notice of Election in progress or accepted",
                409,
                [{ field: "liveNoticeId", code: "NOTICE_ALREADY_LIVE", message: live.id }],
              );
            }
            const depth = await chainDepth((id) => repo.findById(id), source);
            const id = randomUUID();
            const ccn = await ports.ccnFor(tx, actor.organizationId, source.providerEntityId);
            const created = await repo.create({
              id,
              organizationId: actor.organizationId,
              providerEntityId: source.providerEntityId,
              patientId: source.patientId,
              admissionId: source.admissionId,
              electionPeriodId: source.electionPeriodId,
              electionEffectiveDate: dates.date,
              // A correction can fix the date but never extend the filing window (the clock runs from the
              // original admission / end date — CMS ch. 11 §20.1.1 / §20.1.2).
              windowTargetAt: minIso(source.windowTargetAt, dates.windowTargetAt),
              noeControlNumber: deriveControlNumber({
                ccn,
                serviceFrom: dates.date,
                claimId: id as never,
                attemptIndex: depth + 1,
              }),
              correctsNoticeId: source.id,
              correctionReason: reason.reason,
            });
            const base = [actor.organizationId, "noe_record", created.id] as const;
            await emit(tx, ...base, "m23.noe.draft_created", {
              noeId: created.id,
              providerEntityId: created.providerEntityId,
              admissionId: created.admissionId,
              electionEffectiveDate: created.electionEffectiveDate,
              windowTargetAt: created.windowTargetAt,
            });
            await emit(tx, ...base, "m23.noe.correction_created", {
              noeId: created.id,
              correctsNoeId: source.id,
              admissionId: created.admissionId,
              rejectionStage: source.rejectionStage,
              dateCorrected: dates.changed,
              windowTargetAt: created.windowTargetAt,
            });
            return { created: true, record: created };
          }),
        replayLive,
      );
    },

    async correctNotr(actor, notrId, args) {
      assertNotAiActor(actor);
      const reason = validateCorrectionReason(args.reason);
      if (!reason.ok) throw invalid("reason", reason.message);
      const replayLive = async (tx: BillingDb) => {
        const repo = new repositories.NotrRepository(tx);
        const plan = planNoticeCorrection(
          { id: notrId, state: "ack_rejected" },
          links(await repo.listCorrectionsOf(notrId)),
        );
        const existing = plan.kind === "replay" ? await repo.findById(plan.existing.id) : null;
        if (existing) {
          assertReplayMatches(existing.id, existing.effectiveEndDate, args.correctedDate);
        }
        return existing;
      };
      return withReplayOnRace(
        actor,
        () =>
          inOrg(actor, async (tx) => {
            const repo = new repositories.NotrRepository(tx);
            const source = await repo.findById(notrId);
            if (!source || source.organizationId !== actor.organizationId) {
              throw new NotFoundError("notr");
            }
            const plan = planNoticeCorrection(
              source,
              links(await repo.listCorrectionsOf(source.id)),
            );
            if (plan.kind === "refuse") throw refusal(plan);
            if (plan.kind === "replay") {
              const existing = await repo.findById(plan.existing.id);
              if (!existing) throw new NotFoundError("notr");
              assertReplayMatches(existing.id, existing.effectiveEndDate, args.correctedDate);
              return { created: false, record: existing };
            }
            const dates = datesOrThrow(
              correctedNoticeDates({
                sourceDate: source.effectiveEndDate,
                editedDate: args.correctedDate ?? null,
                today: today(),
              }),
              "correctedDate",
            );
            const eventId =
              source.revocationEventId ?? source.transferEventId ?? source.dischargeEventId;
            const live = eventId
              ? await repo.findEffectiveByEvent(source.triggerKind, eventId)
              : null;
            if (live) {
              throw new ChartWardenError(
                "NOTICE_ALREADY_LIVE",
                "this discharge / revocation already has a NOTR in progress or accepted",
                409,
                [{ field: "liveNoticeId", code: "NOTICE_ALREADY_LIVE", message: live.id }],
              );
            }
            const depth = await chainDepth((id) => repo.findById(id), source);
            const id = randomUUID();
            const ccn = await ports.ccnFor(tx, actor.organizationId, source.providerEntityId);
            const created = await repo.create({
              id,
              organizationId: actor.organizationId,
              providerEntityId: source.providerEntityId,
              patientId: source.patientId,
              admissionId: source.admissionId,
              triggerKind: source.triggerKind,
              revocationEventId: source.revocationEventId,
              transferEventId: source.transferEventId,
              dischargeEventId: source.dischargeEventId,
              effectiveEndDate: dates.date,
              // A correction can fix the date but never extend the filing window (the clock runs from the
              // original admission / end date — CMS ch. 11 §20.1.1 / §20.1.2).
              windowTargetAt: minIso(source.windowTargetAt, dates.windowTargetAt),
              notrControlNumber: deriveControlNumber({
                ccn,
                serviceFrom: dates.date,
                claimId: id as never,
                attemptIndex: depth + 1,
              }),
              correctsNoticeId: source.id,
              correctionReason: reason.reason,
            });
            const base = [actor.organizationId, "notr_record", created.id] as const;
            await emit(tx, ...base, "m23.notr.draft_created", {
              notrId: created.id,
              providerEntityId: created.providerEntityId,
              admissionId: created.admissionId,
              terminationEffectiveDate: created.effectiveEndDate,
              windowTargetAt: created.windowTargetAt,
            });
            await emit(tx, ...base, "m23.notr.correction_created", {
              notrId: created.id,
              correctsNotrId: source.id,
              admissionId: created.admissionId,
              rejectionStage: source.rejectionStage,
              dateCorrected: dates.changed,
              windowTargetAt: created.windowTargetAt,
            });
            return { created: true, record: created };
          }),
        replayLive,
      );
    },
  };
}
