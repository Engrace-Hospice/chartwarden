// @wardenx/db — Module 37 (Inpatient Unit / IPU Management) schema barrel: the twenty-six `ownedTables`
// `architecture/module-manifest.ts` gives M37 (§3.3). ALL are TENANT-SCOPED PHI/compliance tables with
// RLS keyed on canonical app.org_id; M37 is fully outbox-decoupled (D17) — it never FKs into another
// module's schema, so every cross-module id (patient_id, M6 admission/LoC/death ids, M8 encounter,
// M11 order, M22 document, M40 facility/funeral-home/provider-entity) is a logical uuid.
//
// FOUR tables are MONTHLY-PARTITIONED by their time key (composite PK + PARTITION BY RANGE declared in
// migration 0149; each gets a GENERATED write-audit fn that hard-codes the parent name — the M32
// ai_token_ledger lesson): ipu_admission_state_history (at), ipu_bed_cleaning_event (at), ipu_visitor
// (checked_in_at), ipu_meal_service (service_date).
//
// Free-text PHI columns (justification/rationale/notes/reason/visitor_name/…) are §3.6 audit-denylisted
// (D11). Enums land in packages/db/src/enums.ts (M37-T01); tables + RLS/grants + M4 write-audit triggers
// in migrations 0148–0152 (M37-T02).
export * from "./units";
export * from "./admission";
export * from "./gip-irc";
export * from "./staffing";
export * from "./clinical";
export * from "./visitor-meal";
export * from "./equipment";
export * from "./census";
