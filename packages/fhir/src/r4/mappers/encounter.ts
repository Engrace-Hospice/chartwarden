// @chartwarden/fhir — Encounter mapper (us-core-encounter, M6/M8, M28-T04).

import type { FhirMapper, MapperContext } from "../../interfaces/mapper";
import type { Encounter } from "../types";
import type { EncounterDomain } from "./domain";

export const US_CORE_ENCOUNTER_PROFILE =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-encounter";

const ENCOUNTER_CLASS_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActCode";

export const encounterMapper: FhirMapper<EncounterDomain, Encounter> = {
  version: "4.0.1",
  profile: US_CORE_ENCOUNTER_PROFILE,
  map(row: EncounterDomain, ctx: MapperContext): Encounter {
    return {
      resourceType: "Encounter",
      id: row.id,
      meta: { lastUpdated: ctx.asOfDate, profile: [US_CORE_ENCOUNTER_PROFILE] },
      status: row.status,
      class: {
        system: ENCOUNTER_CLASS_SYSTEM,
        code: row.classCode,
        display: row.classDisplay,
      },
      type: row.typeCode
        ? [
            {
              coding: [{ system: row.typeSystem, code: row.typeCode, display: row.typeText }],
              text: row.typeText,
            },
          ]
        : undefined,
      subject: { reference: `Patient/${row.patientId}` },
      participant: row.practitionerMdmId
        ? [{ individual: { reference: `Practitioner/${row.practitionerMdmId}` } }]
        : undefined,
      period:
        row.periodStart || row.periodEnd
          ? { start: row.periodStart ?? undefined, end: row.periodEnd ?? undefined }
          : undefined,
    };
  },
};
