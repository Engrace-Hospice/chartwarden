// @wardenx/fhir — MedicationAdministration mapper (M13, F-035).
//
// The fourth medication-shaped resource in this package and the only one that says a dose was actually
// GIVEN. `MedicationRequest` is the order, `MedicationStatement` the reconciled history, and this the
// administration record M13 owns — a distinction that matters to the consumer, because a hospice
// patient's comfort-kit order and the 3am dose someone actually pushed are different clinical facts and
// a partner reconciling them needs both.
//
// PURE, like every mapper here: M13's `asFhirMedicationAdministration` seam has already resolved the
// row (and applied its own §7.8/D7 SUD redaction decision); this only shapes it.
import type { FhirMapper, MapperContext } from "../../interfaces/mapper";
import type { FhirCodeableConcept, MedicationAdministration } from "../types";
import { RXNORM_SYSTEM } from "../uris";
import type { MedicationAdministrationDomain } from "./domain";

/** Base FHIR, not US Core — see the note on the `MedicationAdministration` type. */
export const MEDICATION_ADMINISTRATION_PROFILE =
  "http://hl7.org/fhir/StructureDefinition/MedicationAdministration";

function medicationConcept(
  rxnormCode: string | null | undefined,
  medicationText: string | null | undefined,
): FhirCodeableConcept {
  const coding = rxnormCode
    ? [{ system: RXNORM_SYSTEM, code: rxnormCode, display: medicationText ?? undefined }]
    : [];
  const text = medicationText ?? undefined;
  return coding.length ? { coding, text } : { text };
}

export const medicationAdministrationMapper: FhirMapper<
  MedicationAdministrationDomain,
  MedicationAdministration
> = {
  version: "4.0.1",
  profile: MEDICATION_ADMINISTRATION_PROFILE,
  map(row: MedicationAdministrationDomain, ctx: MapperContext): MedicationAdministration {
    // FHIR makes effective[x] a choice, so exactly one of the two may be present. A period WINS when
    // both arrive: an IV-continuous session has a real span, and collapsing it to its start instant
    // would report a four-hour infusion as an instantaneous dose.
    const period = row.effectivePeriod ?? null;
    return {
      resourceType: "MedicationAdministration",
      id: row.id,
      meta: { lastUpdated: ctx.asOfDate, profile: [MEDICATION_ADMINISTRATION_PROFILE] },
      status: row.status,
      medicationCodeableConcept: medicationConcept(row.rxnormCode, row.medicationText),
      subject: { reference: `Patient/${row.patientId}` },
      effectivePeriod:
        period === null ? undefined : { start: period.start, end: period.end ?? undefined },
      effectiveDateTime: period === null ? (row.effectiveDateTime ?? undefined) : undefined,
      request: row.medicationRequestId
        ? { reference: `MedicationRequest/${row.medicationRequestId}` }
        : undefined,
    };
  },
};
