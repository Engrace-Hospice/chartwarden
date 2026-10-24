// apps/backend/src/modules/23-billing-medicare/services/transfer-notice-service.ts — the M23 service behind the
// transfer-notice worklist: the RECEIVING hospice's Medicare Change of Provider / Transfer Notice (TOB 81C/82C),
// its date correction (8xC + OC 56 + CC D0) and the 8xD void that removes a transfer submitted in error.
// CMS Pub. 100-04 ch. 11 §20.1.3 / §20.1.4, Rev. 12847.
//
// Every write runs in ONE `withOrgContext` unit of work (RLS on `app.org_id`), drives the pure
// `transferNoticeMachine`, is version-checked (§2.5 → 412), and emits its `m23.transfer_notice.*` event through
// the injected catalog-validating outbox in the same transaction. The §20.1.3 rules are `evaluateTransferNotice`
// (pure, `@chartwarden/billing`); this file only gathers the one cross-row fact they need (other transfers in the
// benefit period) and the M6 refresh (our admission date and physicians, which M6 may learn after the draft).
//
// SUBMISSION follows the NOE/NOTR outbox-only posture (D2): `submit` appends the queued `claim_submission`
// (kind `transfer_notice`), asks the job gate, and emits `m23.transfer_notice.submit_requested`; the
// `transfer_notice.submit` worker generates + uploads and drives READY → SUBMITTED. The 999 / 277CA ack crons
// route an acknowledgment to this notice by its submission's kind (`jobs/m23-jobs.ts`).
//
// No MBI / no PHI beyond ids, dates and provider identifiers (D13). AI principals are refused (D13).
import { randomUUID } from "node:crypto";
import {
  type NoticeState,
  type TransferNoticeEvaluation,
  deriveControlNumber,
  evaluateTransferNotice,
  repositories,
  transferNoticeMachine,
  transferNoticeTob,
} from "@chartwarden/billing";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, ConflictError, NotFoundError } from "@chartwarden/types";
import type { TransferInFactsResolver } from "../outbox-consumers/m6-transfer-in-notice";
import type { JobEnqueuePort } from "../routes/write-service";
import {
  type BillingTx,
  type BillingWriteActor,
  type WriteOutboxPort,
  assertNotAiActor,
} from "./claim-state-service";

type Notice = repositories.TransferNoticeRecord;

/** The submission queue the outbox bridge drains (a substring of its request event, per the job gate). */
export const TRANSFER_NOTICE_SUBMIT_QUEUE = "transfer_notice.submit";

export type TransferNoticeUiAction =
  | "confirm_prior_billing"
  | "submit"
  | "cancel"
  | "correct_date"
  | "void"
  | "redraft";

export interface TransferNoticeView {
  readonly transferNoticeId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly transferEventId: string;
  readonly action: repositories.TransferNoticeAction;
  readonly supersedesNoticeId: string | null;
  readonly state: NoticeState;
  readonly tob: string;
  readonly statementFromDate: string;
  readonly originalTransferDate: string | null;
  readonly admissionDate: string | null;
  readonly benefitPeriodSequence: number;
  readonly benefitPeriodStartDate: string | null;
  readonly priorHospiceName: string;
  readonly priorHospiceCcn: string | null;
  readonly priorHospiceNpi: string | null;
  readonly providerCcn: string;
  readonly priorBillingConfirmedAt: string | null;
  readonly priorHospiceThroughDate: string | null;
  readonly priorHospicePatientStatus: "50" | "51" | null;
  readonly controlNumber: string;
  readonly payerControlNumber: string | null;
  readonly latestSubmissionId: string | null;
  readonly latestSubmissionOutcome: string | null;
  readonly cancelReason: string | null;
  readonly blockers: TransferNoticeEvaluation["blockers"];
  readonly warnings: TransferNoticeEvaluation["warnings"];
  readonly conditionCodes: readonly string[];
  readonly occurrenceCodes: TransferNoticeEvaluation["occurrenceCodes"];
  readonly allowedActions: readonly TransferNoticeUiAction[];
  /** The correction / void acting on this notice, when one exists (an accepted 8xD means "voided"). */
  readonly followUp: {
    readonly transferNoticeId: string;
    readonly action: repositories.TransferNoticeAction;
    readonly state: NoticeState;
  } | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransferNoticeListFilter {
  readonly patientId?: string;
  readonly admissionId?: string;
  readonly state?: NoticeState;
}

export interface TransferNoticeListView {
  readonly items: readonly TransferNoticeView[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface ConfirmPriorBillingArgs {
  readonly expectedVersion: number;
  /** The Through date on the transferring hospice's final claim (must equal the transfer date). */
  readonly priorHospiceThroughDate: string;
  /** The patient status on that claim: 50 hospice-home, 51 hospice-medical facility. */
  readonly priorHospicePatientStatus: "50" | "51";
  /** Fill in the sending hospice's CCN / NPI when M6 recorded none. */
  readonly priorHospiceCcn?: string;
  readonly priorHospiceNpi?: string;
}

export interface TransferNoticeSubmissionView {
  readonly transferNoticeId: string;
  readonly submissionId: string;
  readonly jobId: string;
  readonly kind: "transfer_notice";
}

export interface TransferNoticeServicePorts {
  readonly outbox?: WriteOutboxPort;
  /** The submission job gate (`buildM23OutboxBackedSubmissionGate`); absent ⇒ submit refused 503. */
  readonly jobs?: JobEnqueuePort;
  /** M6's org-explicit transfer-in facts — refreshes our admission date + physicians before a filing. */
  readonly transferInFacts?: TransferInFactsResolver;
  readonly now?: () => Date;
}

export interface TransferNoticeService {
  list(
    actor: { readonly organizationId: string; readonly userId: string },
    filter: TransferNoticeListFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<TransferNoticeListView>;
  get(
    actor: { readonly organizationId: string; readonly userId: string },
    transferNoticeId: string,
  ): Promise<TransferNoticeView>;
  confirmPriorBilling(
    actor: BillingWriteActor,
    transferNoticeId: string,
    args: ConfirmPriorBillingArgs,
  ): Promise<TransferNoticeView>;
  submit(
    actor: BillingWriteActor,
    transferNoticeId: string,
    args: { readonly expectedVersion: number },
  ): Promise<TransferNoticeSubmissionView>;
  cancel(
    actor: BillingWriteActor,
    transferNoticeId: string,
    args: { readonly expectedVersion: number; readonly reason: string },
  ): Promise<TransferNoticeView>;
  correctDate(
    actor: BillingWriteActor,
    transferNoticeId: string,
    args: { readonly correctedTransferDate: string },
  ): Promise<TransferNoticeView>;
  voidNotice(actor: BillingWriteActor, transferNoticeId: string): Promise<TransferNoticeView>;
  redraft(actor: BillingWriteActor, transferNoticeId: string): Promise<TransferNoticeView>;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const LIVE: readonly NoticeState[] = ["draft", "ready", "submitted", "ack_pending"];

function conflict412(current: number | null): ChartWardenError {
  return new ChartWardenError(
    "VERSION_CONFLICT",
    `the transfer notice was modified concurrently (current version ${current ?? "unknown"})`,
    412,
  );
}

/** Gather the rules' facts for one notice inside the caller's tx (one count + one superseded read). */
async function evaluate(tx: BillingTx, notice: Notice): Promise<TransferNoticeEvaluation> {
  const repo = new repositories.TransferNoticeRepository(tx);
  const otherTransfers =
    notice.action === "original"
      ? await repo.countOtherLiveOriginalsInPeriod({
          organizationId: notice.organizationId,
          patientId: notice.patientId,
          benefitPeriodSequence: notice.benefitPeriodSequence,
          excludeTransferEventId: notice.transferEventId,
        })
      : 0;
  const superseded = notice.supersedesNoticeId
    ? await repo.findById(notice.supersedesNoticeId)
    : null;
  return evaluateTransferNotice({
    action: notice.action,
    facilityTypeCode: notice.tob.startsWith("82") ? "82" : "81",
    statementFromDate: notice.statementFromDate,
    originalTransferDate: notice.originalTransferDate,
    admissionDate: notice.admissionDate,
    benefitPeriodSequence: notice.benefitPeriodSequence,
    benefitPeriodStartDate: notice.benefitPeriodStartDate,
    providerCcn: notice.providerCcn,
    priorHospiceCcn: notice.priorHospiceCcn,
    priorBilling:
      notice.priorHospiceThroughDate !== null && notice.priorHospicePatientStatus !== null
        ? {
            throughDate: notice.priorHospiceThroughDate,
            patientStatus: notice.priorHospicePatientStatus,
          }
        : null,
    otherTransfersInBenefitPeriod: otherTransfers,
    supersededAccepted: notice.supersedesNoticeId ? superseded?.state === "ack_accepted" : null,
  });
}

/** What the worklist may offer for a notice in its current state (the server also re-checks each). */
function allowedActions(
  notice: Notice,
  evaluation: TransferNoticeEvaluation,
  hasLiveFollowUp: boolean,
): TransferNoticeUiAction[] {
  const actions: TransferNoticeUiAction[] = [];
  const preSubmission = notice.state === "draft" || notice.state === "ready";
  if (preSubmission && notice.action === "original") actions.push("confirm_prior_billing");
  if (preSubmission && evaluation.blockers.length === 0) actions.push("submit");
  if (preSubmission) actions.push("cancel");
  if (notice.state === "ack_accepted" && notice.action !== "void" && !hasLiveFollowUp) {
    actions.push("correct_date", "void");
  }
  if (
    (notice.state === "ack_rejected" || notice.state === "cancelled") &&
    notice.action === "original"
  ) {
    actions.push("redraft");
  }
  return actions;
}

async function viewOf(tx: BillingTx, notice: Notice): Promise<TransferNoticeView> {
  const repo = new repositories.TransferNoticeRepository(tx);
  const evaluation = await evaluate(tx, notice);
  const followUp = notice.state === "ack_accepted" ? await repo.findLiveFollowUp(notice.id) : null;
  const submission = notice.latestSubmissionId
    ? await new repositories.ClaimSubmissionRepository(tx).findById(notice.latestSubmissionId)
    : null;
  return {
    transferNoticeId: notice.id,
    organizationId: notice.organizationId,
    providerEntityId: notice.providerEntityId,
    patientId: notice.patientId,
    admissionId: notice.admissionId,
    transferEventId: notice.transferEventId,
    action: notice.action,
    supersedesNoticeId: notice.supersedesNoticeId,
    state: notice.state,
    tob: notice.tob,
    statementFromDate: notice.statementFromDate,
    originalTransferDate: notice.originalTransferDate,
    admissionDate: notice.admissionDate,
    benefitPeriodSequence: notice.benefitPeriodSequence,
    benefitPeriodStartDate: notice.benefitPeriodStartDate,
    priorHospiceName: notice.priorHospiceName,
    priorHospiceCcn: notice.priorHospiceCcn,
    priorHospiceNpi: notice.priorHospiceNpi,
    providerCcn: notice.providerCcn,
    priorBillingConfirmedAt: iso(notice.priorBillingConfirmedAt),
    priorHospiceThroughDate: notice.priorHospiceThroughDate,
    priorHospicePatientStatus: notice.priorHospicePatientStatus,
    controlNumber: notice.controlNumber,
    payerControlNumber: notice.payerControlNumber,
    latestSubmissionId: notice.latestSubmissionId,
    latestSubmissionOutcome: submission?.outcome ?? null,
    cancelReason: notice.cancelReason,
    blockers: evaluation.blockers,
    warnings: evaluation.warnings,
    conditionCodes: evaluation.conditionCodes,
    occurrenceCodes: evaluation.occurrenceCodes,
    allowedActions: allowedActions(notice, evaluation, followUp !== null),
    followUp: followUp
      ? { transferNoticeId: followUp.id, action: followUp.action, state: followUp.state }
      : null,
    version: notice.version,
    createdAt: notice.createdAt.toISOString(),
    updatedAt: notice.updatedAt.toISOString(),
  };
}

async function load(tx: BillingTx, organizationId: string, id: string): Promise<Notice> {
  const notice = await new repositories.TransferNoticeRepository(tx).findById(id);
  if (!notice || notice.organizationId !== organizationId)
    throw new NotFoundError("transfer notice");
  return notice;
}

function requireDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ChartWardenError("VALIDATION_FAILED", `${field} must be a yyyy-mm-dd date`, 422);
  }
}

export function buildTransferNoticeService(
  db: repositories.BillingDb,
  ports: TransferNoticeServicePorts = {},
): TransferNoticeService {
  const now = ports.now ?? (() => new Date());

  const inOrg = <T>(
    actor: { readonly organizationId: string; readonly userId: string },
    fn: (tx: BillingTx) => Promise<T>,
  ) =>
    withOrgContext<BillingTx, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  const emit = async (
    tx: BillingTx,
    organizationId: string,
    eventName: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ) => {
    if (ports.outbox) {
      await ports.outbox.publish(tx, {
        eventName,
        organizationId,
        aggregateKind: "transfer_notice_record",
        aggregateId,
        payload,
      });
    }
  };

  /** M6's current admission date + physicians for this notice's transfer (null when the port is unbound). */
  const freshFacts = async (organizationId: string, transferNoticeId: string) => {
    if (!ports.transferInFacts) return null;
    const notice = await inOrg({ organizationId, userId: "" }, (tx) =>
      load(tx, organizationId, transferNoticeId),
    );
    return ports.transferInFacts(organizationId, notice.transferEventId);
  };

  /** Apply the M6 refresh to a pre-submission notice (same state, version-checked). */
  const refresh = async (
    tx: BillingTx,
    notice: Notice,
    facts: Awaited<ReturnType<typeof freshFacts>>,
  ): Promise<Notice> => {
    if (!facts || notice.action === "void") return notice;
    const patch: repositories.TransferNoticePatch = {
      ...(facts.admissionDate !== notice.admissionDate
        ? { admissionDate: facts.admissionDate }
        : {}),
      ...(facts.attendingPhysicianId !== notice.attendingPhysicianId
        ? { attendingPhysicianId: facts.attendingPhysicianId }
        : {}),
      ...(facts.hospicePhysicianId !== notice.certifyingPhysicianId
        ? { certifyingPhysicianId: facts.hospicePhysicianId }
        : {}),
    };
    if (Object.keys(patch).length === 0) return notice;
    const res = await new repositories.TransferNoticeRepository(tx).transitionToState(
      notice.id,
      notice.version,
      notice.state,
      patch,
    );
    if (!res.ok) throw conflict412(res.currentVersion);
    return res.row;
  };

  /** Create a follow-up notice (correction / void / redraft) acting on `source`. */
  const createFollowUp = async (
    tx: BillingTx,
    actor: BillingWriteActor,
    source: Notice,
    action: repositories.TransferNoticeAction,
    statementFromDate: string,
  ): Promise<Notice> => {
    const id = randomUUID();
    const facility = source.tob.startsWith("82") ? "82" : "81";
    const created = await new repositories.TransferNoticeRepository(tx).create({
      id,
      organizationId: actor.organizationId,
      providerEntityId: source.providerEntityId,
      locationId: source.locationId,
      patientId: source.patientId,
      admissionId: source.admissionId,
      transferEventId: source.transferEventId,
      electionPeriodId: source.electionPeriodId,
      action,
      supersedesNoticeId: action === "original" ? null : source.id,
      tob: transferNoticeTob(facility, action) as Notice["tob"],
      statementFromDate,
      originalTransferDate: action === "correction" ? source.statementFromDate : null,
      admissionDate: source.admissionDate,
      benefitPeriodSequence: source.benefitPeriodSequence,
      benefitPeriodStartDate: source.benefitPeriodStartDate,
      priorHospiceName: source.priorHospiceName,
      priorHospiceCcn: source.priorHospiceCcn,
      priorHospiceNpi: source.priorHospiceNpi,
      providerCcn: source.providerCcn,
      attendingPhysicianId: source.attendingPhysicianId,
      certifyingPhysicianId: source.certifyingPhysicianId,
      // A correction keeps the confirmed prior-billing fact only when it still describes the new date.
      ...(action === "correction" &&
      source.priorBillingConfirmedAt !== null &&
      source.priorHospiceThroughDate === statementFromDate
        ? {
            priorBillingConfirmedAt: source.priorBillingConfirmedAt,
            priorBillingConfirmedByMembershipId: source.priorBillingConfirmedByMembershipId,
            priorHospiceThroughDate: source.priorHospiceThroughDate,
            priorHospicePatientStatus: source.priorHospicePatientStatus,
          }
        : {}),
      controlNumber: deriveControlNumber({
        ccn: source.providerCcn,
        serviceFrom: statementFromDate,
        claimId: id as never,
        attemptIndex: 0,
      }),
    });
    await emit(tx, actor.organizationId, "m23.transfer_notice.draft_created", created.id, {
      transferNoticeId: created.id,
      providerEntityId: created.providerEntityId,
      admissionId: created.admissionId,
      transferEventId: created.transferEventId,
      action: created.action,
      tob: created.tob,
      statementFromDate: created.statementFromDate,
    });
    return created;
  };

  return {
    async list(actor, filter, cursor, limit) {
      return inOrg(actor, async (tx) => {
        const page = await new repositories.TransferNoticeRepository(tx).listByOrgPage(
          actor.organizationId,
          filter,
          cursor,
          limit,
        );
        const items: TransferNoticeView[] = [];
        for (const row of page.items) items.push(await viewOf(tx, row));
        return { items, nextCursor: page.nextCursor, hasMore: page.hasMore };
      });
    },

    async get(actor, transferNoticeId) {
      return inOrg(actor, async (tx) =>
        viewOf(tx, await load(tx, actor.organizationId, transferNoticeId)),
      );
    },

    async confirmPriorBilling(actor, transferNoticeId, args) {
      assertNotAiActor(actor);
      requireDate(args.priorHospiceThroughDate, "priorHospiceThroughDate");
      const facts = await freshFacts(actor.organizationId, transferNoticeId);
      return inOrg(actor, async (tx) => {
        let notice = await load(tx, actor.organizationId, transferNoticeId);
        if (notice.version !== args.expectedVersion) throw conflict412(notice.version);
        if (
          notice.action !== "original" ||
          (notice.state !== "draft" && notice.state !== "ready")
        ) {
          throw new ConflictError(
            `the prior hospice's billing is confirmed on an original notice before submission (state '${notice.state}')`,
          );
        }
        notice = await refresh(tx, notice, facts);
        const res = await new repositories.TransferNoticeRepository(tx).transitionToState(
          notice.id,
          notice.version,
          notice.state,
          {
            priorBillingConfirmedAt: now(),
            priorBillingConfirmedByMembershipId: actor.membershipId,
            priorHospiceThroughDate: args.priorHospiceThroughDate,
            priorHospicePatientStatus: args.priorHospicePatientStatus,
            ...(args.priorHospiceCcn !== undefined && notice.priorHospiceCcn === null
              ? { priorHospiceCcn: args.priorHospiceCcn }
              : {}),
            ...(args.priorHospiceNpi !== undefined && notice.priorHospiceNpi === null
              ? { priorHospiceNpi: args.priorHospiceNpi }
              : {}),
          },
        );
        if (!res.ok) throw conflict412(res.currentVersion);
        return viewOf(tx, res.row);
      });
    },

    async submit(actor, transferNoticeId, args) {
      assertNotAiActor(actor);
      const jobs = ports.jobs;
      if (!jobs) {
        throw new ChartWardenError(
          "SEAM_UNBOUND",
          "transfer-notice submission is not available",
          503,
        );
      }
      const facts = await freshFacts(actor.organizationId, transferNoticeId);
      return inOrg(actor, async (tx) => {
        const repo = new repositories.TransferNoticeRepository(tx);
        let notice = await load(tx, actor.organizationId, transferNoticeId);
        if (notice.version !== args.expectedVersion) throw conflict412(notice.version);
        if (notice.state !== "draft" && notice.state !== "ready") {
          throw new ConflictError(
            `a transfer notice in state '${notice.state}' cannot be submitted`,
          );
        }
        notice = await refresh(tx, notice, facts);
        // Re-evaluated at the moment of filing — a READY notice is re-checked too (a second transfer may
        // have been recorded since it was assembled).
        const evaluation = await evaluate(tx, notice);
        if (evaluation.blockers.length > 0) {
          throw new ChartWardenError(
            "TRANSFER_NOTICE_BLOCKED",
            evaluation.blockers.map((b) => b.message).join(" "),
            422,
            evaluation.blockers.map((b) => ({ code: b.code, message: b.message })),
          );
        }
        if (notice.state === "draft") {
          const stepped = transferNoticeMachine.reduce(notice.state, "assemble", {
            openBlockers: 0,
          });
          if (stepped.error) throw new ConflictError(`cannot assemble a '${notice.state}' notice`);
          const res = await repo.transitionToState(notice.id, notice.version, stepped.state);
          if (!res.ok) throw conflict412(res.currentVersion);
          notice = res.row;
        }
        const submissions = new repositories.ClaimSubmissionRepository(tx);
        const previous = await submissions.findLatestAttempt(
          notice.providerEntityId,
          notice.controlNumber,
        );
        if (previous?.outcome === "queued") {
          throw new ConflictError("this transfer notice already has a submission in flight");
        }
        const submission = await submissions.append({
          organizationId: actor.organizationId,
          providerEntityId: notice.providerEntityId,
          kind: "transfer_notice",
          transferNoticeId: notice.id,
          claimControlNumber: notice.controlNumber,
          attemptIndex: previous ? previous.attemptIndex + 1 : 0,
          outcome: "queued",
        });
        const res = await repo.transitionToState(notice.id, notice.version, notice.state, {
          latestSubmissionId: submission.id,
        });
        if (!res.ok) throw conflict412(res.currentVersion);
        const { jobId } = await jobs.enqueue(
          TRANSFER_NOTICE_SUBMIT_QUEUE,
          `${actor.organizationId}:${notice.id}:${submission.id}`,
          { transferNoticeId: notice.id, submissionId: submission.id },
        );
        await emit(tx, actor.organizationId, "m23.transfer_notice.submit_requested", notice.id, {
          transferNoticeId: notice.id,
          submissionId: submission.id,
          controlNumber: notice.controlNumber,
        });
        return {
          transferNoticeId: notice.id,
          submissionId: submission.id,
          jobId,
          kind: "transfer_notice",
        };
      });
    },

    async cancel(actor, transferNoticeId, args) {
      assertNotAiActor(actor);
      return inOrg(actor, async (tx) => {
        const notice = await load(tx, actor.organizationId, transferNoticeId);
        if (notice.version !== args.expectedVersion) throw conflict412(notice.version);
        const reason = args.reason.trim();
        const stepped = transferNoticeMachine.reduce(notice.state, "cancel", {
          cancelReasonProvided: reason.length > 0,
        });
        if (stepped.error === "GUARD_FAILED") {
          throw new ChartWardenError("VALIDATION_FAILED", "a cancel reason is required", 422);
        }
        if (stepped.error) {
          throw new ConflictError(
            `a '${notice.state}' transfer notice cannot be cancelled; once submitted, void it with an 8xD instead`,
          );
        }
        const res = await new repositories.TransferNoticeRepository(tx).transitionToState(
          notice.id,
          notice.version,
          stepped.state,
          { cancelReason: reason },
        );
        if (!res.ok) throw conflict412(res.currentVersion);
        return viewOf(tx, res.row);
      });
    },

    async correctDate(actor, transferNoticeId, args) {
      assertNotAiActor(actor);
      requireDate(args.correctedTransferDate, "correctedTransferDate");
      return inOrg(actor, async (tx) => {
        const source = await load(tx, actor.organizationId, transferNoticeId);
        await assertFollowUpAllowed(tx, source);
        if (args.correctedTransferDate === source.statementFromDate) {
          throw new ChartWardenError(
            "VALIDATION_FAILED",
            "the corrected transfer date is the same as the date on file",
            422,
          );
        }
        return viewOf(
          tx,
          await createFollowUp(tx, actor, source, "correction", args.correctedTransferDate),
        );
      });
    },

    async voidNotice(actor, transferNoticeId) {
      assertNotAiActor(actor);
      return inOrg(actor, async (tx) => {
        const source = await load(tx, actor.organizationId, transferNoticeId);
        await assertFollowUpAllowed(tx, source);
        // §20.1.4: the 8xD's From date must match the transfer date being removed.
        return viewOf(
          tx,
          await createFollowUp(tx, actor, source, "void", source.statementFromDate),
        );
      });
    },

    async redraft(actor, transferNoticeId) {
      assertNotAiActor(actor);
      return inOrg(actor, async (tx) => {
        const source = await load(tx, actor.organizationId, transferNoticeId);
        if (source.action !== "original" || !["ack_rejected", "cancelled"].includes(source.state)) {
          throw new ConflictError(
            "only a rejected or cancelled original transfer notice can be redrafted",
          );
        }
        const live = await new repositories.TransferNoticeRepository(
          tx,
        ).findLiveOriginalByTransferEvent(source.transferEventId);
        if (live) throw new ConflictError("this transfer already has a live transfer notice");
        return viewOf(
          tx,
          await createFollowUp(tx, actor, source, "original", source.statementFromDate),
        );
      });
    },
  };
}

/** A correction or void acts on an ACCEPTED, non-void notice with no other live follow-up. */
async function assertFollowUpAllowed(tx: BillingTx, source: Notice): Promise<void> {
  if (source.state !== "ack_accepted" || source.action === "void") {
    throw new ConflictError(
      "only a transfer notice Medicare has accepted can be corrected or voided (§20.1.3 / §20.1.4)",
    );
  }
  const followUp = await new repositories.TransferNoticeRepository(tx).findLiveFollowUp(source.id);
  if (followUp && LIVE.includes(followUp.state)) {
    throw new ConflictError("this transfer notice already has a correction or void in progress");
  }
}
