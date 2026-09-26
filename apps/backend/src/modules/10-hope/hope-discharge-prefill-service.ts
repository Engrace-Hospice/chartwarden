import { type DbClient, schema } from "@wardenx/db";
import type { HopeDischargeReason } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import { normalizeHopeAnswerValue } from "./hope-answer-service";

type AssessmentRow = typeof schema.hopeAssessments.$inferSelect;

export function mapAdmissionDischargeReasonToHope(
  reason: string | null | undefined,
): string | null {
  switch (reason) {
    case "death":
      return "1";
    case "revocation":
      return "2";
    case "moved_out_of_service_area":
      return "4";
    case "transfer":
    case "transfer_to_hospice":
      return "5";
    case "for_cause":
      return "6";
    default:
      return null;
  }
}

export interface HopeDischargePrefillService {
  prefillDischarge(input: {
    readonly tx: DbClient;
    readonly organizationId: string;
    readonly assessment: AssessmentRow;
    readonly dischargeDate: string;
    readonly dischargeReason?: HopeDischargeReason | string | null;
  }): Promise<{ readonly assessmentId: string; readonly prefilledItemCodes: readonly string[] }>;
}

export function createHopeDischargePrefillService(): HopeDischargePrefillService {
  const ITEM = schema.hopeSpecItems;
  const ISC = schema.hopeSpecItemIsc;
  const OPTION = schema.hopeSpecItemOptions;
  const ANSWER = schema.hopeAssessmentAnswers;

  async function write(input: {
    readonly tx: DbClient;
    readonly organizationId: string;
    readonly assessment: AssessmentRow;
    readonly itemCode: string;
    readonly value: string;
    readonly sourceReference: Record<string, unknown>;
    readonly at: Date;
  }): Promise<boolean> {
    if (!input.assessment.specVersionId || input.assessment.isc !== "HD") return false;
    const [row] = await input.tx
      .select({ item: ITEM })
      .from(ITEM)
      .innerJoin(ISC, eq(ISC.specItemId, ITEM.id))
      .where(
        and(
          eq(ITEM.specVersionId, input.assessment.specVersionId),
          eq(ITEM.itemCode, input.itemCode),
          eq(ISC.isc, "HD"),
          eq(ISC.active, true),
        ),
      )
      .limit(1);
    if (!row) return false;
    const options = await input.tx.select().from(OPTION).where(eq(OPTION.specItemId, row.item.id));
    const value = normalizeHopeAnswerValue({
      item: row.item,
      options,
      inputValue: input.value,
    });
    await input.tx
      .insert(ANSWER)
      .values({
        organizationId: input.organizationId,
        providerEntityId: input.assessment.providerEntityId,
        locationId: input.assessment.locationId,
        hopeAssessmentId: input.assessment.id,
        specVersionId: input.assessment.specVersionId,
        specItemId: row.item.id,
        state: "answered",
        value,
        source: "admission_prefill",
        sourceReference: input.sourceReference,
        answeredAt: input.at,
      })
      .onConflictDoUpdate({
        target: [ANSWER.hopeAssessmentId, ANSWER.specItemId],
        set: {
          state: "answered",
          value,
          source: "admission_prefill",
          sourceReference: input.sourceReference,
          answeredAt: input.at,
          answeredByMembershipId: null,
          updatedAt: input.at,
        },
      });
    return true;
  }

  return {
    async prefillDischarge({ tx, organizationId, assessment, dischargeDate, dischargeReason }) {
      if (
        assessment.rfaKind !== "05_discharge" ||
        assessment.isc !== "HD" ||
        assessment.status !== "draft"
      ) {
        return { assessmentId: assessment.id, prefilledItemCodes: [] };
      }
      const at = new Date();
      const written: string[] = [];
      if (
        await write({
          tx,
          organizationId,
          assessment,
          itemCode: "A0270",
          value: dischargeDate,
          sourceReference: { reason: "m6_discharge_date" },
          at,
        })
      ) {
        written.push("A0270");
      }
      const mappedReason = mapAdmissionDischargeReasonToHope(dischargeReason);
      if (
        mappedReason &&
        (await write({
          tx,
          organizationId,
          assessment,
          itemCode: "A2115",
          value: mappedReason,
          sourceReference: { reason: "m6_discharge_reason", sourceValue: dischargeReason },
          at,
        }))
      ) {
        written.push("A2115");
      }
      return { assessmentId: assessment.id, prefilledItemCodes: written };
    },
  };
}
