// @wardenx/fhir — per-value child Observation projection (§4.11, M28-T04).
//
// Each value in an M29 `lab_observation.values[]` projects to one FHIR `Observation`. The child IDs use
// the synthetic `<observation-id>--<value-index>` form (D19) so distinct values within one observation
// get distinct, DETERMINISTIC IDs — a re-read at the same `asOf` re-produces byte-identical IDs.
//
// A SUD-class value (`sud_redaction_status !== 'not_applicable'`) is stamped with the internal `R-SUD`
// `meta.security` marker so the whole-report redaction applier (§4.11.3) can detect it and collapse the
// report. The marker is INTERNAL: the applier strips the SUD children before the report reaches the wire.

import type { LabObservationRow, LabObservationValueRow } from "../deps";
import type { FhirCoding, Observation } from "../../types";
import { SUD_SECURITY_MARKER_CODE } from "./sud-redaction-applier";

/** `not_applicable` is the ONLY non-SUD status; anything else is 42 CFR Part 2 SUD-class. */
export function isSudClass(sudRedactionStatus: string): boolean {
  return sudRedactionStatus !== "not_applicable";
}

const SUD_SECURITY: FhirCoding = {
  system: "http://wardenx.com/fhir/CodeSystem/internal-security",
  code: SUD_SECURITY_MARKER_CODE,
};

/** Project one lab value to a child Observation. `subjectRef` is the shared `Patient/{id}` reference;
 *  `effectiveDateTime` is the observation's `attachedAt`. */
export function projectChildObservation(
  observationId: string,
  index: number,
  value: LabObservationValueRow,
  subjectRef: string,
  effectiveDateTime: string,
): Observation {
  const interpretationCode = value.criticalFlag ?? value.abnormalFlag;

  const obs: Observation = {
    resourceType: "Observation",
    id: `${observationId}--${index}`,
    status: "final",
    code: {
      coding: [{ system: "http://loinc.org", code: value.loincCode, display: value.loincText }],
    },
    subject: { reference: subjectRef },
    effectiveDateTime,
    valueQuantity:
      value.numericValue !== null && value.unit !== null
        ? { value: value.numericValue, unit: value.unit, system: "http://unitsofmeasure.org" }
        : undefined,
    valueString: value.numericValue === null && value.stringValue !== null ? value.stringValue : undefined,
    interpretation: interpretationCode
      ? [
          {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
                code: interpretationCode,
              },
            ],
          },
        ]
      : undefined,
    referenceRange: value.referenceRange ? [{ text: value.referenceRange }] : undefined,
  };

  if (isSudClass(value.sudRedactionStatus)) {
    obs.meta = { security: [SUD_SECURITY] };
  }

  return obs;
}

/** Project every value of an observation to its child Observation array (in source order). */
export function projectChildObservations(
  observation: LabObservationRow,
  subjectRef: string,
): Observation[] {
  return observation.values.map((v, idx) =>
    projectChildObservation(observation.id, idx, v, subjectRef, observation.attachedAt),
  );
}
