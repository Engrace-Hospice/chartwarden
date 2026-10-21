// @chartwarden/fhir — MedicationRequest + MedicationStatement mappers (M12, M28-T04).
//
// Both project the M12 medication vocabulary to FHIR. The medication itself is a `CodeableConcept` on
// the RxNorm system (D9 platform-canonical URI); when RxNorm is absent the free-text `medicationText`
// carries it so the resource is never medication-less. Phase 1 is READ-ONLY (`fhir.write` OFF) — these
// only ever serialize outbound.

import type { FhirMapper, MapperContext } from "../../interfaces/mapper";
import type {
  FhirCodeableConcept,
  FhirDosage,
  MedicationRequest,
  MedicationStatement,
} from "../types";
import { RXNORM_SYSTEM } from "../uris";
import type { MedicationRequestDomain, MedicationStatementDomain } from "./domain";

export const US_CORE_MEDICATION_REQUEST_PROFILE =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-medicationrequest";
export const US_CORE_MEDICATION_STATEMENT_PROFILE =
  "http://hl7.org/fhir/StructureDefinition/MedicationStatement";

/** RxNorm coding + text fallback, shared by both mappers. */
function medicationCodeableConcept(
  rxnormCode: string | null | undefined,
  rxnormText: string | null | undefined,
  medicationText: string | null | undefined,
): FhirCodeableConcept {
  const coding = rxnormCode
    ? [{ system: RXNORM_SYSTEM, code: rxnormCode, display: rxnormText ?? undefined }]
    : [];
  const text = rxnormText ?? medicationText ?? undefined;
  return coding.length ? { coding, text } : { text };
}

export const medicationRequestMapper: FhirMapper<MedicationRequestDomain, MedicationRequest> = {
  version: "4.0.1",
  profile: US_CORE_MEDICATION_REQUEST_PROFILE,
  map(row: MedicationRequestDomain, ctx: MapperContext): MedicationRequest {
    const dosage: FhirDosage[] = [];
    if (row.dosageText || row.routeCode) {
      dosage.push({
        text: row.dosageText ?? undefined,
        route: row.routeCode
          ? {
              coding: [{ code: row.routeCode, display: row.routeText ?? undefined }],
              text: row.routeText ?? undefined,
            }
          : undefined,
      });
    }

    return {
      resourceType: "MedicationRequest",
      id: row.id,
      meta: { lastUpdated: ctx.asOfDate, profile: [US_CORE_MEDICATION_REQUEST_PROFILE] },
      status: row.status,
      intent: row.intent,
      medicationCodeableConcept: medicationCodeableConcept(
        row.rxnormCode,
        row.rxnormText,
        row.medicationText,
      ),
      subject: { reference: `Patient/${row.patientId}` },
      authoredOn: row.authoredOn ?? undefined,
      requester: row.requesterMdmId
        ? { reference: `Practitioner/${row.requesterMdmId}` }
        : undefined,
      dosageInstruction: dosage.length ? dosage : undefined,
    };
  },
};

export const medicationStatementMapper: FhirMapper<MedicationStatementDomain, MedicationStatement> =
  {
    version: "4.0.1",
    profile: US_CORE_MEDICATION_STATEMENT_PROFILE,
    map(row: MedicationStatementDomain, ctx: MapperContext): MedicationStatement {
      const hasPeriod = Boolean(row.effectiveStart || row.effectiveEnd);
      return {
        resourceType: "MedicationStatement",
        id: row.id,
        meta: { lastUpdated: ctx.asOfDate, profile: [US_CORE_MEDICATION_STATEMENT_PROFILE] },
        status: row.status,
        medicationCodeableConcept: medicationCodeableConcept(
          row.rxnormCode,
          row.rxnormText,
          row.medicationText,
        ),
        subject: { reference: `Patient/${row.patientId}` },
        effectivePeriod: hasPeriod
          ? { start: row.effectiveStart ?? undefined, end: row.effectiveEnd ?? undefined }
          : undefined,
        dateAsserted: row.dateAsserted ?? undefined,
        dosage: row.dosageText ? [{ text: row.dosageText }] : undefined,
      };
    },
  };
