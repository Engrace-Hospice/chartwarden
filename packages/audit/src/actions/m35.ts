// @chartwarden/audit — Module 35 (Subscription & Billing) action catalog.
//
// M35's only app-level audit action today: the job-level record of the claims-billing add-on's patient census
// (ADR-0110 D8). The census PULLS every active patient id of an org from M5 on a schedule (no request, so no read
// trail of its own) and writes only HMAC pseudonyms; this event is that pass's trail. It carries the org (the event's own
// column), the period key and counts only, never a patient id or a pseudonym, so the denylist is empty and it is not Part 2
// eligible. `compliance` retention: it is the access record for a bulk read of patient identifiers.
import type { ModuleActionCatalog } from "./types";

/** `m35` Subscription & Billing actions (ADR-0110 D8). */
export const M35_ACTION_CATALOG: ModuleActionCatalog = [
  {
    action: "m35.patient_census.run", // one row per org per `m35.patient-census` pass
    moduleOwner: "m35",
    defaultRetentionClass: "compliance",
    description:
      "One claims-billing census pass ran for an organization: it read the active patient ids from M5 and wrote their pseudonyms (periodYearMonth, seen, inserted; outcome success). outcome failure records that a pass was ATTEMPTED and failed, possibly before any id was read (a missing pseudonym key, a read error). Counts only: no patient id, no pseudonym.",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
];
