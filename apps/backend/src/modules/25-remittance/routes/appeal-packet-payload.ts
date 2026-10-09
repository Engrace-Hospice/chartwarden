// apps/backend/src/modules/25-remittance/routes/appeal-packet-payload.ts - GAP-036. Builds the typed
// AppealPacketRenderPayload M22 renders the tier-specific appeal letter from. Every fact the letter asserts
// (tier, claim, denial reason, remittance line, deadline) is read HERE from the appeal case and its denial
// case under the acting org's RLS - never taken from the request. Only the biller's own narrative and the
// documents they chose to attach come from the submit input.
import { type DbClient, schema } from "@wardenx/db";
import {
  type AppealPacketRenderPayload,
  NotFoundError,
  WardenXError,
  buildAppealPacketRenderPayload,
} from "@wardenx/types";
import { eq } from "drizzle-orm";
import { type AppealSourcePorts, describeEnclosures, loadRemitCopy } from "./appeal-packet-sources";

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
    throw new WardenXError(
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
  const remitCopy = denial.remittanceLineId
    ? await loadRemitCopy(tx, appeal.organizationId, denial.remittanceLineId)
    : null;
  if (denial.remittanceLineId && !remitCopy) {
    throw new WardenXError(
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
  });
}
