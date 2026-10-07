// apps/backend/src/modules/28-fhir/routes/capability-statement.ts — the ONE place the gateway's
// `CapabilityStatement` is assembled (§D11). `GET /fhir/r4/metadata` serves it and the `fhir.capability-
// snapshot-validator` job persists + signs the same bytes, so what the validator vouches for is exactly what
// the endpoint advertises (two builders would let them drift apart silently).
import { type FhirCapabilityStatement, buildCapabilityStatement } from "@wardenx/fhir";
import { FHIR_PHASE_1_VERSION } from "@wardenx/types";

import { SERVED_RESOURCES } from "./projection";

/** The platform release the persisted `fhir_capability_snapshot` row is keyed by (with the FHIR version). */
export const CAPABILITY_RELEASE_TAG = "phase-1";

export function buildGatewayCapabilityStatement(): FhirCapabilityStatement {
  return buildCapabilityStatement({
    fhirVersion: FHIR_PHASE_1_VERSION,
    releaseTag: CAPABILITY_RELEASE_TAG,
    publicationDate: "2026-01-01",
    baseUrl: "/fhir/r4",
    // Each resource declares the interactions it ACTUALLY supports, which is what
    // `CapabilityStatement.rest.resource.interaction` is for. Encounter is `search-type` only —
    // M8 publishes a patient-scoped signed-encounter read and no read-by-id, so an instance read has
    // no data path and claiming one would be the same false promise in a smaller font.
    resources: SERVED_RESOURCES.map((r) => ({
      type: r.type,
      interactions: r.interactions,
      searchParams: r.searchParams,
    })),
    operations: [
      {
        name: "export",
        definition: "http://hl7.org/fhir/uv/bulkdata/OperationDefinition/export",
      },
      {
        name: "everything",
        definition: "http://hl7.org/fhir/OperationDefinition/Patient-everything",
      },
    ],
  });
}
