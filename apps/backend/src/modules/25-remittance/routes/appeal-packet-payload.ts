// apps/backend/src/modules/25-remittance/routes/appeal-packet-payload.ts - GAP-036. Builds the typed
// AppealPacketRenderPayload M22 renders the tier-specific appeal letter from. Every fact the letter asserts
// (tier, claim, denial reason, remittance line, deadline) is read HERE from the appeal case and its denial
// case under the acting org's RLS - never taken from the request. Only the biller's own narrative and the
// documents they chose to attach come from the submit input.
import { type DbClient, schema } from "@chartwarden/db";
import {
  type AppealPacketRenderPayload,
  type AppealReconsiderationBlock,
  ChartWardenError,
  NotFoundError,
  buildAppealPacketRenderPayload,
} from "@chartwarden/types";
import { eq } from "drizzle-orm";
import { checkQicEvidence } from "../domain";
import { type AppealSourcePorts, describeEnclosures, loadRemitCopy } from "./appeal-packet-sources";
import { QIC_EVIDENCE_MESSAGES } from "./qic-messages";
import { asEvidence } from "./qic-service";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface SubmittedAppealFacts {
  readonly id: string;
  readonly organizationId: string;
  readonly denialCaseId: string;
  readonly claimId: string;
  readonly tier: AppealPacketRenderPayload["tier"];
  readonly tierDeadlineAt: Date;
}

export interface AppealPacketSubmitInput {
  readonly appealNarrative: string;
  readonly attachedDocumentIds: readonly string[];
  /** An existing M22 document the biller assembled as the medical-records bundle; validated like any enclosure. */
  readonly medicalRecordsBundleDocumentId?: string;
  readonly goodCauseJustification?: string;
  /**
   * Milestone 4 - what only a QIC reconsideration needs and the appeal row does not hold: the redetermination MAC,
   * the attached document that is the copy of the redetermination notice, and the preclusion acknowledgement.
   * Ignored on every other tier; required (and checked against the cited evidence) on a reconsideration.
   */
  readonly reconsideration?: {
    readonly redeterminationMacName?: string;
    readonly redeterminationNoticeDocumentId?: string;
    readonly evidencePreclusionAcknowledged?: boolean;
  };
}

export async function loadAppealPacketPayload(
  tx: Tx,
  appeal: SubmittedAppealFacts,
  input: AppealPacketSubmitInput,
  submittedAt: Date,
  sources: AppealSourcePorts,
): Promise<AppealPacketRenderPayload> {
  const DC = schema.denialCase;
  const rows = await tx
    .select({
      carcCode: DC.carcCode,
      rarcCode: DC.rarcCode,
      dollarValue: DC.dollarValue,
      remittanceLineId: DC.remittanceLineId,
    })
    .from(DC)
    .where(eq(DC.id, appeal.denialCaseId))
    .limit(1);
  const denial = rows[0];
  if (!denial) throw new NotFoundError("denial case not found");

  // The claim M23 holds (header, lines, and the patient every enclosure must belong to). Read, never assumed: a
  // packet whose claim cannot be read is refused rather than filed with a reference and no content.
  const claim = await sources.claims().claimCopyForAppeal(appeal.organizationId, appeal.claimId);
  if (!claim) {
    throw new ChartWardenError(
      "APPEAL_CLAIM_UNAVAILABLE",
      "the claim for this appeal cannot be read, so the packet cannot be assembled",
      422,
    );
  }
  const enclosures = await describeEnclosures(
    sources.documents(),
    appeal.organizationId,
    claim.patientId,
    input.attachedDocumentIds,
    input.medicalRecordsBundleDocumentId,
  );
  const reconsideration =
    appeal.tier === "reconsideration"
      ? await reconsiderationBlock(tx, appeal.id, input, [
          ...enclosures.attached.map((d) => d.documentId),
          ...(enclosures.bundle ? [enclosures.bundle.documentId] : []),
        ])
      : undefined;
  const remitCopy = denial.remittanceLineId
    ? await loadRemitCopy(tx, appeal.organizationId, denial.remittanceLineId)
    : null;
  if (denial.remittanceLineId && !remitCopy) {
    throw new ChartWardenError(
      "APPEAL_REMITTANCE_UNAVAILABLE",
      "the remittance line for this denial cannot be read, so the packet cannot be assembled",
      422,
    );
  }
  return buildAppealPacketRenderPayload({
    appealCaseId: appeal.id,
    denialCaseId: appeal.denialCaseId,
    claimId: appeal.claimId,
    tier: appeal.tier,
    tierDeadlineAt: appeal.tierDeadlineAt.toISOString(),
    submittedAt: submittedAt.toISOString(),
    appealNarrative: input.appealNarrative,
    attachedDocuments: enclosures.attached,
    claimCopy: claim.copy,
    ...(remitCopy ? { remitCopy } : {}),
    ...(enclosures.bundle ? { medicalRecordsBundle: enclosures.bundle } : {}),
    denial: {
      carcCode: denial.carcCode,
      rarcCode: denial.rarcCode ?? null,
      dollarValue: String(denial.dollarValue),
      remittanceLineId: denial.remittanceLineId ?? null,
    },
    ...(input.goodCauseJustification
      ? { lateGoodCause: { justification: input.goodCauseJustification } }
      : {}),
    ...(reconsideration ? { reconsideration } : {}),
  });
}

/**
 * The evidence-completeness guard of a QIC reconsideration (milestone 4), run on BOTH submit paths because both build
 * the packet here. The cited items come from the appeal row (editable only in draft), the notice copy and the
 * preclusion acknowledgement from the submit input; nothing is taken on trust. A refusal rolls the submit back.
 */
async function reconsiderationBlock(
  tx: Tx,
  appealId: string,
  input: AppealPacketSubmitInput,
  enclosedIds: readonly string[],
): Promise<AppealReconsiderationBlock> {
  const AC = schema.appealCase;
  const rows = await tx
    .select({
      citedEvidence: AC.citedEvidence,
      citedEvidenceNone: AC.citedEvidenceNone,
      noticeDatedOn: AC.noticeDatedOn,
    })
    .from(AC)
    .where(eq(AC.id, appealId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("appeal case not found");
  const given = input.reconsideration ?? {};
  const macName = (given.redeterminationMacName ?? "").trim();
  if (macName === "") {
    throw new ChartWardenError(
      "REDETERMINATION_MAC_REQUIRED",
      "name the MAC that issued the redetermination notice",
      422,
    );
  }
  if (!row.noticeDatedOn) {
    throw new ChartWardenError(
      "REDETERMINATION_NOTICE_DATE_UNKNOWN",
      "this reconsideration has no recorded redetermination notice date, so its request cannot be assembled",
      422,
    );
  }
  const items = asEvidence(row.citedEvidence);
  const noticeDocumentId = given.redeterminationNoticeDocumentId ?? null;
  const acknowledged = given.evidencePreclusionAcknowledged === true;
  const refusal = checkQicEvidence({
    items,
    none: row.citedEvidenceNone,
    enclosedIds,
    preclusionAcknowledged: acknowledged,
    redeterminationNoticeDocumentId: noticeDocumentId,
  });
  if (refusal) throw new ChartWardenError(refusal, QIC_EVIDENCE_MESSAGES[refusal], 422);
  return {
    redeterminationMacName: macName,
    redeterminationNoticeDate: row.noticeDatedOn,
    redeterminationNoticeDocumentId: noticeDocumentId as string,
    citedEvidence: items.map((i) => ({
      label: i.label.trim(),
      documentId: i.documentId,
      notAvailableReason: i.documentId === null ? (i.notAvailableReason ?? "").trim() : null,
    })),
    citedEvidenceNone: row.citedEvidenceNone,
    evidencePreclusionAcknowledged: acknowledged,
  };
}
