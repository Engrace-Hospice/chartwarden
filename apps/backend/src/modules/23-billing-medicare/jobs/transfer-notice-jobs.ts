// apps/backend/src/modules/23-billing-medicare/jobs/transfer-notice-jobs.ts — the worker side of the Medicare
// transfer notice (TOB 8xC / corrected 8xC / 8xD; CMS Pub. 100-04 ch. 11 §20.1.3 / §20.1.4):
//   • `runTransferNoticeSubmit` — the `transfer_notice.submit` processor: build the PHI-free gateway document
//     (`buildTransferNoticeDocument`), have the X12 gateway generate the 837I and the MAC transport upload it,
//     terminalize the queued `claim_submission`, drive READY → SUBMITTED, emit `m23.transfer_notice.submitted`.
//   • `applyTransferNoticeAck` — what the 999 / 277CA ack crons do when an acknowledgment's submission is a
//     transfer notice (`claim_submission.kind = 'transfer_notice'`): append the `claim_acknowledgment` (no claim
//     back-link), drive the notice's ack transition, emit `m23.transfer_notice.accepted` / `.rejected`.
//
// Leaf module: it takes its ports explicitly (no import of `m23-jobs.ts`, which imports THIS file), so the
// no-circular fitness rule holds. Runs on the caller's org-scoped tx (`withOrgContext` per job / per ack).
//
// A failed generation or upload is RECORDED, not thrown: the queued submission is terminalized
// `failed_worker` / `failed_portal` with its reason and the notice stays READY, so staff see the failure on the
// worklist and resubmit (a new attempt row). Rethrowing would make BullMQ retry against an attempt row that is
// already terminal.
import {
  type NoticeState,
  buildTransferNoticeDocument,
  repositories,
  transferNoticeConditionCodes,
  transferNoticeMachine,
  transferNoticeOccurrenceCodes,
} from "@wardenx/billing";
import type { TransferNoticeDocument837i } from "@wardenx/billing";

type BillingDb = repositories.BillingDb;

export interface TransferNoticeSubmitJob {
  readonly organizationId: string;
  readonly transferNoticeId: string;
  readonly submissionId: string;
}

/** The X12 gateway operation (`POST /generate-transfer-notice`). */
export type GenerateTransferNotice = (input: {
  readonly organizationId: string;
  readonly transferNoticeId: string;
  readonly controlNumber: string;
  readonly document: TransferNoticeDocument837i;
}) => Promise<{ readonly x12: string; readonly correlationId: string }>;

/** The MAC transport upload, narrowed to the transfer-notice kind. */
export type UploadTransferNotice = (input: {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly kind: "transfer_notice";
  readonly x12: string;
  readonly controlNumber: string;
}) => Promise<{ readonly accepted: boolean; readonly generatedFileUri: string }>;

export interface TransferNoticeOutbox {
  publish(
    tx: BillingDb,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface TransferNoticeSubmitPorts {
  readonly generate: GenerateTransferNotice;
  readonly upload: UploadTransferNotice;
  readonly outbox: TransferNoticeOutbox;
  readonly now: () => Date;
}

const AGGREGATE = "transfer_notice_record";

export async function runTransferNoticeSubmit(
  tx: BillingDb,
  ports: TransferNoticeSubmitPorts,
  job: TransferNoticeSubmitJob,
): Promise<void> {
  const notices = new repositories.TransferNoticeRepository(tx);
  const submissions = new repositories.ClaimSubmissionRepository(tx);
  const notice = await notices.findById(job.transferNoticeId);
  if (!notice) throw new Error(`transfer_notice_record ${job.transferNoticeId} not found`);
  const submission = await submissions.findById(job.submissionId);
  if (!submission || submission.transferNoticeId !== notice.id) {
    throw new Error(`claim_submission ${job.submissionId} is not this transfer notice's attempt`);
  }
  if (submission.outcome !== "queued") return; // a relay redelivery of an attempt already settled
  const fail = async (outcome: "failed_worker" | "failed_portal", reason: string) => {
    await submissions.terminalize(submission.id, {
      outcome,
      outcomeReason: reason,
      generatedFileUri: null,
      submittedAt: null,
      workerCorrelationId: null,
    });
  };
  if (notice.state !== "ready") {
    await fail("failed_worker", `transfer notice is no longer submittable (state=${notice.state})`);
    return;
  }

  let document: TransferNoticeDocument837i;
  try {
    document = buildTransferNoticeDocument({
      transferNoticeId: notice.id,
      controlNumber: notice.controlNumber,
      action: notice.action,
      tob: notice.tob,
      statementFromDate: notice.statementFromDate,
      admissionDate: notice.admissionDate,
      // The same derivation the §20.1.3 rules ran when the notice was assembled.
      conditionCodes: transferNoticeConditionCodes(notice),
      occurrenceCodes: transferNoticeOccurrenceCodes(notice),
      attendingPhysicianId: notice.attendingPhysicianId,
      certifyingPhysicianId: notice.certifyingPhysicianId,
    });
  } catch (err) {
    await fail("failed_worker", `transfer notice document incomplete: ${(err as Error).message}`);
    return;
  }

  let generated: { readonly x12: string; readonly correlationId: string };
  try {
    generated = await ports.generate({
      organizationId: job.organizationId,
      transferNoticeId: notice.id,
      controlNumber: notice.controlNumber,
      document,
    });
  } catch (err) {
    await fail("failed_worker", `X12 generation failed: ${(err as Error).message}`);
    return;
  }
  let uploaded: { readonly accepted: boolean; readonly generatedFileUri: string };
  try {
    uploaded = await ports.upload({
      organizationId: job.organizationId,
      providerEntityId: notice.providerEntityId,
      kind: "transfer_notice",
      x12: generated.x12,
      controlNumber: notice.controlNumber,
    });
  } catch (err) {
    await fail("failed_portal", `MAC upload failed: ${(err as Error).message}`);
    return;
  }
  if (!uploaded.accepted) {
    await fail("failed_portal", "the MAC portal refused the transfer-notice upload");
    return;
  }
  const submittedAt = ports.now();
  await submissions.terminalize(submission.id, {
    outcome: "submitted",
    outcomeReason: null,
    generatedFileUri: uploaded.generatedFileUri,
    submittedAt,
    workerCorrelationId: generated.correlationId,
  });
  const next = transferNoticeMachine.reduce(notice.state, "submit");
  if (next.error) throw new Error(`illegal transfer-notice transition ${notice.state} --submit-->`);
  const res = await notices.transitionToState(notice.id, notice.version, next.state, {
    latestSubmissionId: submission.id,
  });
  if (!res.ok) throw new Error(`transfer notice ${notice.id} version conflict on submit`);
  await ports.outbox.publish(tx, {
    eventName: "m23.transfer_notice.submitted",
    organizationId: job.organizationId,
    aggregateKind: AGGREGATE,
    aggregateId: notice.id,
    payload: {
      transferNoticeId: notice.id,
      submissionId: submission.id,
      submittedAt: submittedAt.toISOString(),
    },
  });
}

/** One parsed acknowledgment line for a transfer-notice submission (PHI-free). */
export interface TransferNoticeAck {
  readonly organizationId: string;
  readonly submissionId: string;
  readonly kind: "ack_999" | "ack_277ca";
  /** 999: accepted / rejected. 277CA: accepted / rejected / partial (a notice has no lines; partial = rejected). */
  readonly outcome: "accepted" | "rejected" | "partial";
  readonly payerControlNumber: string | null;
  readonly reasonCodes: readonly string[];
  readonly macJurisdiction: string;
  readonly ackFileUri: string;
  readonly receivedAt: Date;
}

/**
 * Route one acknowledgment to its transfer notice. Returns the notice's new state, or null when the ack was
 * recorded but drives no transition (a late or duplicate file against a notice already past that stage).
 */
export async function applyTransferNoticeAck(
  tx: BillingDb,
  outbox: TransferNoticeOutbox,
  ack: TransferNoticeAck,
): Promise<NoticeState | null> {
  const submission = await new repositories.ClaimSubmissionRepository(tx).findById(
    ack.submissionId,
  );
  if (!submission?.transferNoticeId) {
    throw new Error(`claim_submission ${ack.submissionId} is not a transfer-notice submission`);
  }
  const notices = new repositories.TransferNoticeRepository(tx);
  const notice = await notices.findById(submission.transferNoticeId);
  if (!notice) throw new Error(`transfer_notice_record ${submission.transferNoticeId} not found`);
  const accepted = ack.outcome === "accepted";
  const recorded = await new repositories.ClaimAcknowledgmentRepository(tx).append({
    organizationId: ack.organizationId,
    submissionId: submission.id,
    claimId: null,
    kind: ack.kind,
    macJurisdiction: ack.macJurisdiction as never,
    ackFileUri: ack.ackFileUri,
    ackReceivedAt: ack.receivedAt,
    parsedPayload: {
      outcome: ack.outcome,
      payerControlNumber: ack.payerControlNumber,
      reasonCodes: [...ack.reasonCodes],
      transferNoticeId: notice.id,
    },
    outcomeStatus: accepted ? "accepted" : "rejected",
  });
  const event =
    ack.kind === "ack_999"
      ? accepted
        ? "ack_999_accepted"
        : "ack_999_rejected"
      : accepted
        ? "ack_277ca_accepted"
        : "ack_277ca_rejected";
  if (!transferNoticeMachine.canTransition(notice.state, event)) return null;
  const next = transferNoticeMachine.reduce(notice.state, event);
  const res = await notices.transitionToState(notice.id, notice.version, next.state, {
    latestAcknowledgmentId: recorded.id,
    ...(event === "ack_277ca_accepted" && ack.payerControlNumber
      ? { payerControlNumber: ack.payerControlNumber }
      : {}),
  });
  if (!res.ok) throw new Error(`transfer notice ${notice.id} version conflict on ${event}`);
  if (event === "ack_277ca_accepted") {
    await outbox.publish(tx, {
      eventName: "m23.transfer_notice.accepted",
      organizationId: ack.organizationId,
      aggregateKind: AGGREGATE,
      aggregateId: notice.id,
      payload: {
        transferNoticeId: notice.id,
        acknowledgmentId: recorded.id,
        payerControlNumber: ack.payerControlNumber ?? "",
      },
    });
  } else if (!accepted) {
    await outbox.publish(tx, {
      eventName: "m23.transfer_notice.rejected",
      organizationId: ack.organizationId,
      aggregateKind: AGGREGATE,
      aggregateId: notice.id,
      payload: { transferNoticeId: notice.id, rejectionCodes: [...ack.reasonCodes] },
    });
  }
  return next.state;
}
