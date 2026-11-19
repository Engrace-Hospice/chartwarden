// apps/backend/src/modules/08-encounters/drafting/default-ports.ts — the seam-backed half of the draft ports, wired
// from the M1 registry (S1 PR C2a). Each seam is resolved at CALL time, so registration order is irrelevant and an
// unregistered or deny-stubbed seam fails inside the guarded read as `DRAFT_UNAVAILABLE`.
//
// The store-backed half (`DraftStorePorts`: time zone, previous visit, vitals, removed links, stored selections)
// is supplied by PR C2b over the M8 tables: `{ ...defaultDraftPorts(), ...storePorts }`.
import type { PatientId } from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";
// M8 `dependsOn` M7: the SAME per-actor Part 2 decision the care-plan reader store applies to its `{ actor }`
// audience (M39 `evaluateForInternalAccess`, then the §7.6 RN-case-manager carve-out where no release names
// others), so the draft never disagrees with the care plan about who may read SUD content.
import { sudDisclosureAllowedForActor } from "../../07-care-plan/abac-predicates";
import { getCarePlanReader } from "../seams/index";
import type { DraftSeamPorts } from "./ports";

export function defaultDraftPorts(): DraftSeamPorts {
  return {
    carePlanAsOf: (patientId, encounterType, discipline, admissionId, viewer, asOf) =>
      getCarePlanReader().relevantElementsAsOf(
        patientId as PatientId,
        encounterType,
        discipline,
        admissionId,
        viewer,
        asOf,
      ),
    scaleSeries: (patientId, scaleType, from, to) =>
      getSeam("ScaleSeriesProvider").series(patientId as PatientId, scaleType, from, to),
    medicationChangesBetween: (organizationId, patientId, from, to) =>
      getSeam("MedicationOrderProvider").getMedicationChangesBetween(
        organizationId,
        patientId,
        from,
        to,
      ),
    // The checker underneath fails closed (an erroring M39 reads as "not allowed"), as M7's own reads do.
    part2DisclosureAllowed: ({ organizationId, patientId, viewer }) =>
      sudDisclosureAllowedForActor({
        organizationId,
        patientId,
        roles: viewer.roles,
        membershipId: viewer.membershipId,
      }),
  };
}
