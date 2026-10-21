import { type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { MedClass } from "@chartwarden/types";

const dea = Type.Union([
  Type.Literal("II"),
  Type.Literal("III"),
  Type.Literal("IV"),
  Type.Literal("V"),
]);
const sig = Type.Object({
  doseQuantity: Type.Number({ minimum: 0.01 }),
  doseUnit: Type.String({ minLength: 1 }),
  route: Type.String({ minLength: 1 }),
  frequencyCode: Type.String({ minLength: 1 }),
  duration: Type.Optional(
    Type.Object({
      durationValue: Type.Integer({ minimum: 1 }),
      durationUnit: Type.Union([
        Type.Literal("days"),
        Type.Literal("weeks"),
        Type.Literal("months"),
      ]),
    }),
  ),
  asNeeded: Type.Boolean(),
  asNeededReasonCode: Type.Optional(Type.String({ minLength: 1 })),
});
const quantity = Type.Object({
  value: Type.Number({ minimum: 0.01 }),
  unit: Type.String({ minLength: 1 }),
});
/**
 * GAP-036 — the allergy acknowledgement SERVER-recorded by `requestSignature` (never client-supplied: the
 * draft validators below reject this key in a non-complete/client payload). It lives in the per-class `data`
 * jsonb because `medication_order` has no dedicated column; the whole column is audit-denylisted (§7.6).
 */
export const ALLERGY_OVERRIDE_DATA_KEY = "allergyOverride";
export const AllergyOverrideData = Type.Object(
  {
    reason: Type.String({ minLength: 10, maxLength: 1000 }),
    acknowledgedByMembershipId: Type.String({ minLength: 1 }),
    acknowledgedAt: Type.String({ minLength: 1 }),
    matchedClasses: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export const StandardMedOrderData = Type.Object(
  {
    sigStructured: sig,
    sigFreeText: Type.String({ minLength: 5, maxLength: 1000 }),
    indication: Type.Optional(Type.String({ maxLength: 1000 })),
    clinicalJustification: Type.Optional(Type.String({ maxLength: 2000 })),
    notes: Type.Optional(Type.String({ maxLength: 2000 })),
    refillsAuthorized: Type.Integer({ minimum: 0, maximum: 11 }),
    dispenseQuantity: quantity,
    daysSupply: Type.Integer({ minimum: 1, maximum: 365 }),
    daw: Type.Boolean(),
    allergyOverride: Type.Optional(AllergyOverrideData),
  },
  { additionalProperties: false },
);
export const ControlledSubstanceMedOrderData = Type.Object(
  {
    sigStructured: sig,
    sigFreeText: Type.String({ minLength: 5, maxLength: 1000 }),
    indication: Type.String({ minLength: 5, maxLength: 1000 }),
    clinicalJustification: Type.String({ minLength: 20, maxLength: 2000 }),
    notes: Type.Optional(Type.String({ maxLength: 2000 })),
    refillsAuthorized: Type.Integer({ minimum: 0, maximum: 5 }),
    dispenseQuantity: quantity,
    daysSupply: Type.Integer({ minimum: 1, maximum: 90 }),
    daw: Type.Boolean(),
    deaSchedule: dea,
    prescriberDea: Type.String({ pattern: "^[A-Z]{2}[0-9]{7}$" }),
    allergyOverride: Type.Optional(AllergyOverrideData),
  },
  { additionalProperties: false },
);
export const CompoundedMedOrderData = Type.Object(
  {
    compoundingPharmacyMdmId: Type.String({ format: "uuid" }),
    formulationDescription: Type.String({ minLength: 20, maxLength: 4000 }),
    components: Type.Array(
      Type.Object(
        {
          rxnormRxcui: Type.Optional(Type.String()),
          ndc: Type.Optional(Type.String()),
          componentName: Type.String({ minLength: 1 }),
          componentStrength: Type.String({ minLength: 1 }),
          quantityRatio: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    containsControlled: Type.Boolean(),
    deaSchedule: Type.Optional(dea),
    sigStructured: sig,
    sigFreeText: Type.String({ minLength: 5, maxLength: 1500 }),
    indication: Type.Optional(Type.String({ maxLength: 1000 })),
    clinicalJustification: Type.Optional(Type.String({ maxLength: 2000 })),
    notes: Type.Optional(Type.String({ maxLength: 2000 })),
    refillsAuthorized: Type.Integer({ minimum: 0, maximum: 11 }),
    dispenseQuantity: quantity,
    daysSupply: Type.Integer({ minimum: 1, maximum: 180 }),
    daw: Type.Literal(true),
    allergyOverride: Type.Optional(AllergyOverrideData),
  },
  { additionalProperties: false },
);

export const MEDICATION_DATA_VERSION = {
  standard: "standard.v1",
  controlled_substance: "controlled_substance.v1",
  compounded: "compounded.v1",
} as const;
const schemas: Record<MedClass, TSchema> = {
  standard: StandardMedOrderData,
  controlled_substance: ControlledSubstanceMedOrderData,
  compounded: CompoundedMedOrderData,
};
export interface MedicationDataFinding {
  field: string;
  code: string;
  message: string;
}
/** Strict only at readiness: drafts may be incomplete but never carry unknown clinical keys. */
export function validateMedicationOrderData(
  medClass: MedClass,
  version: string | undefined,
  data: unknown,
  complete = true,
): MedicationDataFinding[] {
  const schema = schemas[medClass];
  const findings: MedicationDataFinding[] = [];
  if (version !== undefined && version !== MEDICATION_DATA_VERSION[medClass])
    findings.push({
      field: "dataVersion",
      code: "INVALID",
      message: `Expected ${MEDICATION_DATA_VERSION[medClass]}.`,
    });
  if (!data || typeof data !== "object" || Array.isArray(data))
    return complete
      ? [{ field: "data", code: "REQUIRED", message: "Medication order data is required." }]
      : [{ field: "data", code: "INVALID", message: "Medication order data must be an object." }];
  const allowed = Object.keys((schema as { properties?: object }).properties ?? {});
  // The allergy acknowledgement is recorded by the server at requestSignature; a client-supplied draft
  // payload (non-complete) must never carry one.
  for (const key of Object.keys(data))
    if (!allowed.includes(key) || (key === ALLERGY_OVERRIDE_DATA_KEY && !complete))
      findings.push({
        field: `data.${key}`,
        code: "UNKNOWN",
        message: "Unknown medication data field.",
      });
  if (complete)
    for (const error of Value.Errors(schema, data))
      findings.push({
        field: `data${error.path.replace(/\//g, ".")}`,
        code: "INVALID",
        message: error.message,
      });
  const d = data as Record<string, unknown>;
  if (medClass === "controlled_substance" && d.deaSchedule === "II" && d.refillsAuthorized !== 0)
    findings.push({
      field: "data.refillsAuthorized",
      code: "REFILL_SCHEDULE_II_NON_REFILLABLE",
      message: "Schedule II medications are non-refillable.",
    });
  if (medClass === "compounded" && d.containsControlled === true && !d.deaSchedule)
    findings.push({
      field: "data.deaSchedule",
      code: "REQUIRED",
      message: "DEA schedule is required for a controlled compound.",
    });
  if (medClass === "compounded" && d.containsControlled !== true && d.deaSchedule)
    findings.push({
      field: "data.deaSchedule",
      code: "INVALID",
      message: "DEA schedule is only allowed for a controlled compound.",
    });
  return findings;
}
