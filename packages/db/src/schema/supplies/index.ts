// @wardenx/db — M21 Supplies, DME & Comfort Kits schema barrel (§3.1, 11 owned tables). The central
// ../index.ts re-exports this barrel; the 12 `m21_*` pgEnums live in ../../enums.ts (M21-T01).
//
// AUTHORITY (§3.0 / M21-F04 / ADR-0023): the spec's §3.1 SQL migration is the SINGLE normative schema and
// §3.2's hand-maintained Drizzle copy had drifted into a materially different database. Every divergence
// here resolves to §3.1, with the folds §3.0's reconciliation table directs (the dispatch-status enum, the
// clinical-attribute flags on `supply_item`, `dea_perpetual_log_jsonb`, the invoice columns). Each file
// documents its own deviations; the two that are NOT cosmetic are the `comfort_kit_template_medication`
// tenancy denormalization and the `expiration_date` floor moving from a CHECK to a trigger.
//
// SHAPE. Three layers:
//   • CATALOG (D11, platform-plus-overlay) — `supply_item` is the platform-shared HCPCS-keyed SKU catalog
//     with NO organization_id at all; `tenant_supply_item_extension` is the tenant's own non-billable
//     items. `comfort_kit_template` + `_medication` are the D3 kit definition on the same floor-plus-overlay
//     shape (one org-less `is_platform_floor` row, tenant rows org-scoped). `vendor_routing_rule` is D4's
//     deterministic routing ladder and `par_stock` is D5's per-Location shelf posture.
//   • REQUEST (D1) — `supply_request`, the ONE shared row across all four kinds with the per-kind payload
//     in a TypeBox-validated `data` jsonb.
//   • KIT CUSTODY (D6/D8) — `comfort_kit_dispatch` → `comfort_kit_dispatched_content` (the DEA 21 CFR §1304
//     outbound log) → `comfort_kit_return` → `comfort_kit_returned_content` (the inbound half, where the
//     single discrepancy formula closes the count).
//
// PARTITIONING (D12 / §3.6): exactly TWO tables are partitioned, and on DIFFERENT keys — `supply_request`
// monthly by `created_at` (migration 0104) and `comfort_kit_dispatch` monthly by `dispatched_at`
// (migration 0105). They live in separate migration files because check-ddl-legality derives one partition
// column per FILE and then requires every PK/UNIQUE in that file to include it. The other nine are
// current-row tables: a catalog, a config ladder, a shelf count and two bounded workflow objects, all of
// whose dominant reads ("what is open", "what is overdue", "what is on this shelf") a RANGE partition would
// force to fan out. The dispatched/returned CONTENT children stay unpartitioned deliberately — they are
// always read through their parent, and partitioning them would forbid the real FKs that keep the
// controlled-substance accounting closed.
//
// TENANCY (ARCH-011 / ADR-0010): nine tables carry organization_id and key RLS on app.org_id ALONE. Two
// carry it NULLABLE by design, paired with a discriminator and a CHECK pair (`comfort_kit_template` /
// `comfort_kit_template_medication` with `is_platform_floor`; `vendor_routing_rule` with
// `scope_kind = 'platform'`), so a tenant READS the platform floor and can never write it. The eleventh,
// `supply_item`, is genuinely org-less — the M22 `form_template` / M38 `code_system` posture, registered in
// check-tenancy's NON_ORG_SCOPED set with dual-grant RLS. Every patient-bearing table additionally carries
// provider_entity_id + location_id NOT NULL; so does `par_stock`, because the published
// `M21ParThresholdPayload` puts `providerEntityId` on every threshold alert.
//
// CROSS-MODULE FK POLICY (architecture wins): only organization_id / provider_entity_id / location_id (M1
// core) and UNPARTITIONED intra-M21 parents get real FK constraints. patient_id (M5), admission_id (M6),
// source_order_id + medication_order_id (M11/M12), m13_deployment_id (M13), the M22 document ids,
// assigned_vendor_id + pharmacy_partner_id (M40), ipu_room_id (M37) and every `*_membership_id` (M2) are
// LOGICAL uuid, validated at the write boundary. `supply_request_id` / `dispatch_id` are logical too —
// their targets are partitioned on a key the child does not carry as part of its own identity.
//
// Enums + the nine unpartitioned tables land in migration 0103; `supply_request` in 0104;
// `comfort_kit_dispatch` in 0105; RLS/grants, the M4 write-audit triggers (D13 denylists), the
// discrepancy computation and the expiration floor in 0106.

export * from "./supply-items"; // supply_item (PLATFORM-shared, no organization_id)
export * from "./tenant-supply-item-extensions"; // tenant_supply_item_extension
export * from "./comfort-kit-templates"; // comfort_kit_template
export * from "./comfort-kit-template-medications"; // comfort_kit_template_medication
export * from "./vendor-routing-rules"; // vendor_routing_rule
export * from "./par-stock"; // par_stock
export * from "./supply-requests"; // supply_request (PARTITIONED, monthly by created_at)
export * from "./comfort-kit-dispatches"; // comfort_kit_dispatch (PARTITIONED, monthly by dispatched_at)
export * from "./comfort-kit-dispatched-contents"; // comfort_kit_dispatched_content
export * from "./comfort-kit-returns"; // comfort_kit_return
export * from "./comfort-kit-returned-contents"; // comfort_kit_returned_content
