// @wardenx/db — M15 Discipline Care Plans schema barrel (§3.1/§3.3, 11 owned tables). The central
// ../index.ts re-exports this barrel; the 13 pgEnums live in ../../enums.ts (M15-T01).
//
// Shape (§3.3): the plan ROOT (discipline_care_plan, one per admission × kind) owns the authored content
// (discipline_goal / discipline_intervention / discipline_assessment), the §2.2.2 version chain
// (discipline_care_plan_version → discipline_care_plan_signature), the 418.76(h) supervisory ledger
// (aide_supervisory_visit) and the volunteer subtree (volunteer_assignment). The two volunteer-compliance
// tables (volunteer_compliance_gate, volunteer_hour_ledger + volunteer_hour_entry) hang off the volunteer
// membership / provider entity rather than a patient — they back the seams M17 consumes (M15-T05).
//
// M15-F06 / ADR-0022 D1.1: NO M15 table is partitioned. Both candidates (discipline_care_plan,
// discipline_assessment) carry partial UNIQUE indexes that a partition key would break, over trivial
// per-admission volumes.
//
// TENANCY (M15-F05 / ADR-0010 / ARCH-011): all 11 tables carry organization_id NOT NULL and the RLS
// predicate keys on app.org_id ALONE. The eight patient-bearing tables additionally carry
// provider_entity_id + location_id NOT NULL (denormalized from the admission at bootstrap) so the §4.3
// compliance seams aggregate per PE/location without joining through M5/M6 schemas; PE/location narrowing
// is M3 ABAC, never a second permissive RLS policy.
//
// CROSS-MODULE FK POLICY (architecture wins): only organization_id / provider_entity_id / location_id (M1
// core) and intra-M15 parents get real FK constraints. patient_id (M5), admission_id (M6), membership ids
// (M2), source_encounter_id (M8), idg_meeting_id (M14), source_document_id (M22) and acting_consent_id
// (M39) are LOGICAL uuid, app-validated at the write boundary.
//
// RLS, grants and the M4 write-audit triggers land in migrations 0098/0099 (M15-T02).

export * from "./discipline-care-plans"; // discipline_care_plan
export * from "./discipline-care-plan-versions"; // discipline_care_plan_version
export * from "./discipline-plan-idg-decision-applications"; // discipline_plan_idg_decision_application (migration 0306)
export * from "./discipline-care-plan-signatures"; // discipline_care_plan_signature
export * from "./discipline-goals"; // discipline_goal
export * from "./discipline-interventions"; // discipline_intervention
export * from "./discipline-assessments"; // discipline_assessment
export * from "./aide-supervisory-visits"; // aide_supervisory_visit
export * from "./volunteer-assignments"; // volunteer_assignment
export * from "./volunteer-compliance-gates"; // volunteer_compliance_gate
export * from "./volunteer-hour-ledger"; // volunteer_hour_ledger
export * from "./volunteer-hour-entries"; // volunteer_hour_entry
