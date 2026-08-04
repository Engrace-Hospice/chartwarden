// @wardenx/fhir — Patient mapper (us-core-patient, M5, M28-T04).

import type { FhirMapper, MapperContext } from "../../interfaces/mapper";
import type { FhirAddress, FhirContactPoint, FhirIdentifier, Patient } from "../types";
import { mrnSystemUri } from "../uris";
import type { PatientRow } from "./deps";

export const US_CORE_PATIENT_PROFILE =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient";

export const patientMapper: FhirMapper<PatientRow, Patient> = {
  version: "4.0.1",
  profile: US_CORE_PATIENT_PROFILE,
  map(row: PatientRow, ctx: MapperContext): Patient {
    const identifier: FhirIdentifier[] = row.mrn
      ? [{ use: "usual", system: mrnSystemUri(ctx), value: row.mrn }]
      : [];

    const telecom: FhirContactPoint[] = [];
    if (row.phone) telecom.push({ system: "phone", value: row.phone });
    if (row.email) telecom.push({ system: "email", value: row.email });

    const address: FhirAddress[] = [];
    if (row.addressLines?.length || row.city || row.state || row.postalCode) {
      address.push({
        line: row.addressLines?.length ? [...row.addressLines] : undefined,
        city: row.city ?? undefined,
        state: row.state ?? undefined,
        postalCode: row.postalCode ?? undefined,
      });
    }

    const given = [row.firstName, ...(row.middleName ? [row.middleName] : [])];

    return {
      resourceType: "Patient",
      id: row.id,
      meta: { lastUpdated: ctx.asOfDate, profile: [US_CORE_PATIENT_PROFILE] },
      identifier: identifier.length ? identifier : undefined,
      active: true,
      name: [{ use: "official", family: row.lastName, given }],
      telecom: telecom.length ? telecom : undefined,
      gender: row.gender ?? "unknown",
      birthDate: row.birthDate ?? undefined,
      deceasedDateTime: row.deceasedDateTime ?? undefined,
      address: address.length ? address : undefined,
    };
  },
};
