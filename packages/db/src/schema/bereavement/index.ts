// @wardenx/db — M16 Bereavement schema barrel (§3.1/§3.3, 9 owned tables). The central ../index.ts
// re-exports this barrel; the 14 pgEnums live in ../../enums.ts (M16-T01).
//
// SHAPE (D1, tripartite): `bereavement_plan` is the program ROOT — one per discharged-by-death admission,
// one 13-month CoP 418.64(d) clock, one counselor caseload entry. `bereaved_contact` is the per-survivor
// tier, because the obligation runs to EACH surviving person (own consent, own opt-out, own risk tier, own
// schedule, own portal scope). `bereavement_contact_log` is the leaf — one outreach fans out to many logs
// (one anniversary letter, five addressees, one shared M22 document). Hanging off those:
// `bereavement_risk_score` (the append-only D3/D17 rubric ledger), `bereavement_outreach` (the D4
// death-anchored schedule), `bereavement_anniversary_reminder` (the lookahead worker's idempotency ledger),
// `bereavement_plan_closure` (the D7 why-it-ended record) and `bereavement_opt_out` (D9 level two). The
// ninth table, `tenant_bereavement_external_source_gate_override`, is org-level CONFIG, not a patient
// record: the D18 tighten-only surface.
//
// PARTITIONING (D12 / §3.6): `bereavement_contact_log` ALONE is partitioned — monthly RANGE by `contact_at`,
// the M4 convention, with the composite PK (id, contact_at) declared in migration 0101. The other eight are
// current-row tables at bounded volume (one plan per decedent; ~10 contacts per plan; ~20 touchpoints per
// contact over 13 months), where a partition key would force every caseload read to fan out.
//
// TENANCY (ARCH-011 / ADR-0010): all 9 carry organization_id NOT NULL and the RLS predicate keys on
// app.org_id ALONE. The eight patient-bearing tables also carry provider_entity_id NOT NULL + location_id
// (nullable — the published `BereavementPlanView.locationId` is already `| null`), denormalized from the
// plan so the §4.6 BereavementComplianceProvider rolls up per CCN/location without joining through M5/M6.
// PE/location narrowing and the D10 volunteer reduced-PHI scope are M3 ABAC, never a second permissive
// policy. The tenant gate-override table is org-only by design.
//
// CROSS-MODULE FK POLICY (architecture wins): only organization_id / provider_entity_id / location_id (M1
// core) and intra-M16 parents get real FK constraints. patient_id (M5), admission_id (M6),
// care_plan_version_id_at_discharge (M7), source_encounter_id (M8), portal_account_id (M31),
// consent_record_id (M39), the M22 document ids, the M32 augmentation refs and every `*_user_id` /
// `*_membership_id` (M2) are LOGICAL uuid, validated at the write boundary.
//
// Enums + the eight unpartitioned tables land in migration 0100; the partitioned contact log in 0101; RLS,
// grants, the M4 write-audit triggers (D11 denylists) and the risk-score immutability trigger in 0102.

export * from "./bereavement-plans"; // bereavement_plan
export * from "./bereaved-contacts"; // bereaved_contact
export * from "./bereavement-risk-scores"; // bereavement_risk_score
export * from "./bereavement-outreach"; // bereavement_outreach
export * from "./bereavement-contact-log"; // bereavement_contact_log (PARTITIONED, monthly by contact_at)
export * from "./bereavement-anniversary-reminders"; // bereavement_anniversary_reminder
export * from "./bereavement-plan-closures"; // bereavement_plan_closure
export * from "./bereavement-opt-outs"; // bereavement_opt_out
export * from "./tenant-external-source-gate-overrides"; // tenant_bereavement_external_source_gate_override
export * from "./bereavement-idg-risk-flags"; // bereavement_idg_risk_flag
