// apps/backend/src/modules/25-remittance/routes/appeal-packet-payload.ts - GAP-036. Builds the typed
// AppealPacketRenderPayload M22 renders the tier-specific appeal letter from. Every fact the letter asserts
// (tier, claim, denial reason, remittance line, deadline) is read HERE from the appeal case and its denial
// case under the acting org's RLS - never taken from the request. Only the biller's own narrative and the
// documents they chose to attach come from the submit input.
import { type DbClient, schema } from "@wardenx/db";
import { type AppealPacketRenderPayload, buildAppealPacketRenderPayload } from "@wardenx/types";
import { NotFoundError } from "@wardenx/types";
import { eq } from "drizzle-orm";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface SubmittedAppealFacts {
  readonly id: string;
  readonly denialCaseId: string;
  readonly claimId: string;
  readonly tier: AppealPacketRenderPayload["tier"];
  readonly tierDeadlineAt: Date;
}

export interface AppealPacketSubmitInput {
  readonly appealNarrative: string;
  readonly attachedDocumentIds: readonly string[];
  readonly goodCauseJustification?: string;
}

export async function loadAppealPacketPayload(
  tx: Tx,
  appeal: SubmittedAppealFacts,
  input: AppealPacketSubmitInput,
  submittedAt: Date,
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
  return buildAppealPacketRenderPayload({
    appealCaseId: appeal.id,
    denialCaseId: appeal.denialCaseId,
    claimId: appeal.claimId,
    tier: appeal.tier,
    tierDeadlineAt: appeal.tierDeadlineAt.toISOString(),
    submittedAt: submittedAt.toISOString(),
    appealNarrative: input.appealNarrative,
    attachedDocumentIds: input.attachedDocumentIds,
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
