// @wardenx/audit — Module 5 (Patient & Demographics) action catalog (M5-T12; M5 spec §8.1).
//
// M5's app-level audit action under the D9 `m5.<resource>.<verb>` namespace. Patient CRUD itself
// flows through the M4 write-audit triggers (the DB-trigger layer, M5-T05) as `<table>.created/
// updated/deleted`; this file is M5's APP-level event surface — the one cross-cutting action the
// `PatientMutator.apply` path writes (§4.9.2), recording the applied vs stripped fields so ops can
// spot a chatty partner leaking identifiers (W-M5-17). `compliance` retention (patient-row mutation;
// `clinical_record` in the spec is a DATA class, not a retention class — RetentionClass is
// operational/compliance/compliance_42cfr_part2). Part-2 eligible: a mutation may touch a SUD-flagged
// patient, so the M4 runtime may tag the row `compliance_42cfr_part2` per §5.3. The payload carries
// field NAMES only (no PHI values), so the denylist is empty.
import type { ModuleActionCatalog } from "./types";

/** `m5` Patient & Demographics module actions (M5 §8.1). */
export const M5_ACTION_CATALOG: ModuleActionCatalog = [
  {
    action: "m5.patient.mutator_applied", // §8.1 / §4.9.2 — PatientMutator.apply
    moduleOwner: "m5",
    defaultRetentionClass: "compliance",
    description:
      "A PatientMutator field diff was applied (source, sourceRef, appliedFields, strippedFields, addressVersionCreated, externalMrnsAddedCount); the W-M5-17 strip set is recorded.",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
];
