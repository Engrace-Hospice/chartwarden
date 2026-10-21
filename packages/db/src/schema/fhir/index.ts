// @chartwarden/db — Module 28 (FHIR Gateway) schema barrel: the nine `ownedTables`
// `architecture/module-manifest.ts` gives M28 (§3.3).
//
// TENANT-SCOPED (eight) — organization_id NOT NULL (organization_id IS the PK on tenant_fhir_config),
// RLS keyed ONLY on app.org_id (§3.5).
//   tenant_fhir_config · fhir_client · fhir_client_credential · fhir_client_session ·
//   fhir_bulk_export_job · fhir_bulk_export_artifact · fhir_inbound_resource · fhir_read_disclosure
//
// PLATFORM-SHARED (one) — fhir_capability_snapshot, no organization_id: the conformance statement is the
// same for every tenant, so read-all `USING (true)` to chartwarden_app, writes only via chartwarden_admin.
//
// TWO ARE PARTITIONED MONTHLY (§3.3) and therefore carry a composite primary key declared in SQL:
// `fhir_client_session` on `issued_at` (operational, 90-day purge) and `fhir_inbound_resource` on
// `proposed_at` (compliance). They live in their own migrations (0135, 0136) because check-ddl-legality
// derives ONE partition column per file, and their audit triggers are GENERATED functions that hard-code
// the parent name (the M32 `ai_invocation` / `ai_token_ledger` lesson).
//
// `fhir_read_disclosure` (0233, F-035) is the §164.528 accounting ledger the bound read path writes:
// append-only by GRANT (SELECT + INSERT, no UPDATE, no DELETE), compliance retention, unpartitioned.
//
// Enums land in `packages/db/src/enums.ts` (M28-T01). Tables in migrations 0134–0136 and 0233; RLS/grants
// + the M4 write-audit triggers in 0137 (and, for the ledger, in 0233 beside its table).
export * from "./bulk-export-artifact";
export * from "./bulk-export-job";
export * from "./capability-snapshot";
export * from "./client";
export * from "./client-credential";
export * from "./client-session";
export * from "./inbound-resource";
export * from "./read-disclosure";
export * from "./tenant-config";
