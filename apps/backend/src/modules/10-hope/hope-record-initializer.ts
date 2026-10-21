import { type DbClient, schema } from "@chartwarden/db";
import type { HopeRfaKind } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import {
  HopeAssessmentSpecNotInitializedError,
  type HopeIsc,
  type HopeSpecRegistry,
} from "./hope-spec-registry";

export type HopeRecordType = "add" | "modify" | "inactivate";
export type HopeReasonForRecord = "admission" | "huv1" | "huv2" | "discharge";

export interface HopeRecordInitialization {
  readonly specVersionId: string;
  readonly specVersionCode: string;
  readonly isc: HopeIsc;
  readonly recordType: HopeRecordType;
  readonly reasonForRecord: HopeReasonForRecord;
  readonly controlAnswers: readonly [
    { readonly itemCode: "A0050"; readonly value: string; readonly source: "derived" },
    { readonly itemCode: "A0250"; readonly value: string; readonly source: "derived" },
  ];
}

export class HopeUnsupportedOfficialRecordKindError extends Error {
  constructor(readonly rfaKind: HopeRfaKind) {
    super(
      `HOPE rfaKind ${rfaKind} is not an official CMS HOPE record kind for Phase 2A initialization`,
    );
    this.name = "HopeUnsupportedOfficialRecordKindError";
  }
}

const ADD_MAPPING: Record<
  Exclude<HopeRfaKind, "04_sfv">,
  { isc: HopeIsc; a0250: string; reasonForRecord: HopeReasonForRecord }
> = {
  "01_admission": { isc: "HA", a0250: "1", reasonForRecord: "admission" },
  "02_huv1": { isc: "HUV", a0250: "2", reasonForRecord: "huv1" },
  "03_huv2": { isc: "HUV", a0250: "3", reasonForRecord: "huv2" },
  "05_discharge": { isc: "HD", a0250: "9", reasonForRecord: "discharge" },
};

function officialMappingFor(rfaKind: HopeRfaKind) {
  if (rfaKind === "04_sfv") throw new HopeUnsupportedOfficialRecordKindError(rfaKind);
  return ADD_MAPPING[rfaKind];
}

async function buildInitialization(
  registry: HopeSpecRegistry,
  specVersionId: string,
  specVersionCode: string,
  rfaKind: HopeRfaKind,
  recordType: HopeRecordType,
): Promise<HopeRecordInitialization> {
  const mapped = officialMappingFor(rfaKind);
  const a0050 = recordType === "add" ? "1" : recordType === "modify" ? "2" : "3";
  await registry.requireAllowedValue(specVersionId, "A0050", a0050);
  await registry.requireAllowedValue(specVersionId, "A0250", mapped.a0250);
  return {
    specVersionId,
    specVersionCode,
    isc: recordType === "inactivate" ? "XX" : mapped.isc,
    recordType,
    reasonForRecord: mapped.reasonForRecord,
    controlAnswers: [
      { itemCode: "A0050", value: a0050, source: "derived" },
      { itemCode: "A0250", value: mapped.a0250, source: "derived" },
    ],
  };
}

export async function initializeNewHopeRecord(
  registry: HopeSpecRegistry,
  input: { readonly rfaKind: HopeRfaKind; readonly targetDate: string | Date },
): Promise<HopeRecordInitialization> {
  const version = await registry.resolveVersionForTargetDate(input.targetDate);
  return buildInitialization(registry, version.id, version.code, input.rfaKind, "add");
}

export async function initializeHopeCorrection(
  registry: HopeSpecRegistry,
  original: {
    readonly id: string;
    readonly rfaKind: HopeRfaKind;
    readonly specVersionId: string | null;
  },
): Promise<HopeRecordInitialization> {
  if (!original.specVersionId) {
    throw new HopeAssessmentSpecNotInitializedError(original.id);
  }
  const version = await registry.requireVersion(original.specVersionId);
  return buildInitialization(registry, version.id, version.code, original.rfaKind, "modify");
}

export async function initializeHopeInactivation(
  registry: HopeSpecRegistry,
  original: {
    readonly id: string;
    readonly rfaKind: HopeRfaKind;
    readonly specVersionId: string | null;
  },
): Promise<HopeRecordInitialization> {
  if (!original.specVersionId) {
    throw new HopeAssessmentSpecNotInitializedError(original.id);
  }
  const version = await registry.requireVersion(original.specVersionId);
  return buildInitialization(registry, version.id, version.code, original.rfaKind, "inactivate");
}

export interface HopeAssessmentAnswerWriter {
  writeDerivedControlAnswers(
    tx: DbClient,
    input: {
      readonly organizationId: string;
      readonly providerEntityId: string | null;
      readonly locationId: string | null;
      readonly hopeAssessmentId: string;
      readonly specVersionId: string;
      readonly controlAnswers: HopeRecordInitialization["controlAnswers"];
    },
  ): Promise<void>;
}

export function createHopeAssessmentAnswerWriter(): HopeAssessmentAnswerWriter {
  const ANSWER = schema.hopeAssessmentAnswers;
  const ITEM = schema.hopeSpecItems;
  return {
    async writeDerivedControlAnswers(tx, input) {
      for (const answer of input.controlAnswers) {
        const [item] = await tx
          .select({ id: ITEM.id })
          .from(ITEM)
          .where(
            // The initializer already required the item/value through the registry; this keeps the
            // writer tiny and scoped to persistence of the derived control facts.
            and(eq(ITEM.specVersionId, input.specVersionId), eq(ITEM.itemCode, answer.itemCode)),
          )
          .limit(1);
        if (!item) throw new Error(`HOPE control item ${answer.itemCode} missing from frozen spec`);
        await tx
          .insert(ANSWER)
          .values({
            organizationId: input.organizationId,
            providerEntityId: input.providerEntityId,
            locationId: input.locationId,
            hopeAssessmentId: input.hopeAssessmentId,
            specVersionId: input.specVersionId,
            specItemId: item.id,
            state: "answered",
            value: answer.value,
            source: answer.source,
            answeredAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [ANSWER.hopeAssessmentId, ANSWER.specItemId],
            set: {
              state: "answered",
              value: answer.value,
              source: answer.source,
              updatedAt: new Date(),
            },
          });
      }
    },
  };
}

export function deriveHopeWorkflowControlAnswers(input: {
  readonly rfaKind: HopeRfaKind;
  readonly isc: HopeIsc | null;
  readonly correctsAssessmentId: string | null;
}): readonly {
  itemCode: "A0050" | "A0250";
  value: string;
}[] {
  const mapped = officialMappingFor(input.rfaKind);

  const a0050 = input.isc === "XX" ? "3" : input.correctsAssessmentId ? "2" : "1";

  return [
    {
      itemCode: "A0050",
      value: a0050,
    },
    {
      itemCode: "A0250",
      value: mapped.a0250,
    },
  ];
}
