// @chartwarden/fhir — Condition mapper (us-core-condition, M6, M28-T04).

import type { FhirMapper, MapperContext } from "../../interfaces/mapper";
import type { Condition, FhirCoding } from "../types";
import { ICD10CM_SYSTEM, SNOMED_SYSTEM } from "../uris";
import type { ConditionDomain } from "./domain";

export const US_CORE_CONDITION_PROFILE =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-condition-problems-health-concerns";

const CLINICAL_STATUS_SYSTEM = "http://terminology.hl7.org/CodeSystem/condition-clinical";
const VERIFICATION_STATUS_SYSTEM = "http://terminology.hl7.org/CodeSystem/condition-ver-status";
const CATEGORY_SYSTEM = "http://terminology.hl7.org/CodeSystem/condition-category";

export const conditionMapper: FhirMapper<ConditionDomain, Condition> = {
  version: "4.0.1",
  profile: US_CORE_CONDITION_PROFILE,
  map(row: ConditionDomain, ctx: MapperContext): Condition {
    const coding: FhirCoding[] = [];
    if (row.icd10Code)
      coding.push({
        system: ICD10CM_SYSTEM,
        code: row.icd10Code,
        display: row.icd10Text ?? undefined,
      });
    if (row.snomedCode) coding.push({ system: SNOMED_SYSTEM, code: row.snomedCode });

    return {
      resourceType: "Condition",
      id: row.id,
      meta: { lastUpdated: ctx.asOfDate, profile: [US_CORE_CONDITION_PROFILE] },
      clinicalStatus: { coding: [{ system: CLINICAL_STATUS_SYSTEM, code: row.clinicalStatus }] },
      verificationStatus: row.verificationStatus
        ? { coding: [{ system: VERIFICATION_STATUS_SYSTEM, code: row.verificationStatus }] }
        : undefined,
      category: row.categoryCode
        ? [{ coding: [{ system: CATEGORY_SYSTEM, code: row.categoryCode }] }]
        : undefined,
      code: coding.length
        ? { coding, text: row.icd10Text ?? undefined }
        : { text: row.icd10Text ?? undefined },
      subject: { reference: `Patient/${row.patientId}` },
      onsetDateTime: row.onsetDateTime ?? undefined,
      recordedDate: row.recordedDate ?? undefined,
    };
  },
};
