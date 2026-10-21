-- M21 Supplies, DME & Comfort Kits §3.1 — the 12 `m21_*` enum types, the NINE unpartitioned owned tables
-- with their indexes and CHECKs, and the D3 platform-floor comfort-kit template seed. The two partitioned
-- tables land in their own files: `supply_request` (monthly RANGE by created_at) in 0104 and
-- `comfort_kit_dispatch` (monthly RANGE by dispatched_at) in 0105. RLS, grants, the M4 write-audit
-- triggers, the D8 discrepancy computation and the controlled-substance expiration floor land in 0106.
--
-- WHY THREE TABLE FILES: check-ddl-legality rule 1 derives ONE partition column per FILE from the first
-- PARTITION clause it sees and then requires every UNIQUE/PK in that file to include it. The nine tables
-- here are keyed on `id` alone; the two partitioned tables carry DIFFERENT composite keys — (id, created_at)
-- and (id, dispatched_at) — so all three sets must be separated (the M25 0081/0082 and M24 0093/0094/0095
-- precedent).
--
-- AUTHORITY (§3.0 / M21-F04 / ADR-0023): the spec's §3.1 SQL is the SINGLE normative schema; §3.2's
-- hand-maintained Drizzle copy had drifted into a materially different database and loses every divergence.
-- The folds §3.0's reconciliation table directs are applied: the `m21_comfort_kit_dispatch_status` enum,
-- the four clinical-attribute flags on `supply_item`, `dea_perpetual_log_jsonb` on the dispatched content,
-- and the invoice columns on `supply_request` (as integer CENTS, matching the payload types M21-T01 locked).
--
-- ENUM NAMING: M21's SQL enum names keep the spec's `m21_` prefix and deliberately break this repo's
-- unprefixed convention. `delivery_method`, `return_state`, `dispatch_source` and `disposal_method` are
-- words M18/M24/M37 will each want, and a pgEnum name is CLUSTER-global.
--
-- TENANCY (ARCH-011 / ADR-0010 / §3.0): the corpus `organization_id` name is used throughout. §3.0 itself
-- records that M21's `org_id` predates the convention and that the rename is cosmetic and non-blocking —
-- architecture wins, and check-tenancy keys on `organization_id`. Nine tables carry it; two carry it
-- NULLABLE paired with a platform discriminator (`comfort_kit_template`/`_medication` with
-- `is_platform_floor`, `vendor_routing_rule` with `scope_kind = 'platform'`) so a tenant READS the floor and
-- can never write it; `supply_item` is genuinely org-less (NON_ORG_SCOPED — the M22 form_template posture).
--
-- CROSS-MODULE FK POLICY (architecture wins): only organization_id / provider_entity_id / location_id (M1
-- core) and UNPARTITIONED intra-M21 parents get real FK constraints. patient_id (M5), admission_id (M6),
-- source_order_id (M11), medication_order_id (M12), m13_deployment_id (M13), the M22 document ids,
-- assigned_vendor_id + pharmacy_partner_id (M40), ipu_room_id (M37) and every `*_membership_id` (M2) are
-- LOGICAL uuid, validated at the write boundary.
--
-- IDENTIFIER LENGTH: every constraint is explicitly named with an `m21_` prefix and a short table
-- abbreviation. PostgreSQL truncates identifiers at 63 characters, and Drizzle's default naming on names
-- like `comfort_kit_dispatched_content_comfort_kit_template_medication_id_fk` truncates two DIFFERENT
-- constraints to the SAME string (the M16-T02 finding).
CREATE TYPE "public"."m21_supply_request_kind" AS ENUM('dme', 'supply', 'comfort_kit_deploy', 'comfort_kit_replenish');--> statement-breakpoint
CREATE TYPE "public"."m21_supply_request_status" AS ENUM('requested', 'vendor_assigned', 'ordered', 'in_transit', 'delivered', 'received_confirmed', 'completed', 'cancelled', 'cancellation_pending', 'returned');--> statement-breakpoint
CREATE TYPE "public"."m21_deployment_site" AS ENUM('home', 'alf', 'snf_residence', 'ipu_room');--> statement-breakpoint
CREATE TYPE "public"."m21_pharmacy_dispatch_mode" AS ENUM('supply_hub_dispatch', 'partner_pharmacy_dispatch', 'dosespot_to_partner_pharmacy');--> statement-breakpoint
CREATE TYPE "public"."m21_fulfillment_mode" AS ENUM('vendor', 'internal_supply_hub', 'partner_pharmacy', 'dosespot_to_partner_pharmacy');--> statement-breakpoint
CREATE TYPE "public"."m21_controlled_substance_schedule" AS ENUM('CII', 'CIII', 'CIV', 'CV');--> statement-breakpoint
CREATE TYPE "public"."m21_disposal_method" AS ENUM('take_back_by_supply_team', 'dispose_at_home_by_witnessed_destruction', 'transferred_to_disposing_pharmacy');--> statement-breakpoint
CREATE TYPE "public"."m21_return_state" AS ENUM('requested', 'assigned', 'retrieving', 'retrieved', 'reconciled', 'overdue', 'unreturnable');--> statement-breakpoint
CREATE TYPE "public"."m21_routing_scope_kind" AS ENUM('sku', 'location', 'tenant', 'platform');--> statement-breakpoint
CREATE TYPE "public"."m21_delivery_method" AS ENUM('agency_courier', 'vendor_direct_ship', 'pharmacy_partner_courier', 'patient_pickup', 'in_facility_internal');--> statement-breakpoint
CREATE TYPE "public"."m21_dispatch_source" AS ENUM('supply_hub', 'pharmacy_partner', 'dosespot_pharmacy');--> statement-breakpoint
CREATE TYPE "public"."m21_comfort_kit_dispatch_status" AS ENUM('dispatched', 'deployed_at_patient', 'partially_returned', 'fully_returned', 'reconciled', 'reconciled_with_discrepancy');--> statement-breakpoint

-- ============================================================================================
-- supply_item — D11's PLATFORM-SHARED canonical SKU catalog. NO organization_id by design: one row per
-- real-world HCPCS-keyed item, the same answer for every tenant, rewritten wholesale by the annual CMS
-- HCPCS loader. Effective-dating retires a code without orphaning the historical requests that resolved
-- against it. The four clinical-attribute flags are §3.0's fold from the §3.2 draft and are NULLABLE on
-- purpose: "unclassified" and "definitely not controlled" are different facts, and the dispatch path must
-- tell them apart before it decides whether a lot number is mandatory.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "supply_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hcpcs" text,
	"rxnorm" text,
	"ndc" text,
	"name" text NOT NULL,
	"sku_class" text NOT NULL,
	"default_unit" text NOT NULL,
	"is_billable" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_platform" boolean DEFAULT true NOT NULL,
	"is_controlled_substance" boolean,
	"requires_lot_tracking" boolean,
	"requires_expiration_tracking" boolean,
	"is_serialized_asset" boolean,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m21_supply_item_billable_requires_hcpcs" CHECK ("hcpcs" IS NOT NULL OR "is_billable" = false),
	CONSTRAINT "m21_supply_item_effective_window" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "supply_item_hcpcs_active_uniq" ON "supply_item" ("hcpcs") WHERE hcpcs IS NOT NULL AND effective_to IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supply_item_sku_class_idx" ON "supply_item" ("sku_class") WHERE is_active = true;--> statement-breakpoint

-- ============================================================================================
-- tenant_supply_item_extension — D11's TENANT half. The agency's own non-billable shelf items, which will
-- never carry a HCPCS code. A separate table rather than org-scoped rows inside supply_item so the annual
-- platform loader never has to merge against tenant data (the M40 canonical/overlay split).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "tenant_supply_item_extension" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"local_sku_code" text NOT NULL,
	"default_unit" text NOT NULL,
	"is_billable" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m21_tsie_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "m21_tenant_supply_item_org_sku_uniq" ON "tenant_supply_item_extension" ("organization_id","local_sku_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_supply_item_extension_org_active_idx" ON "tenant_supply_item_extension" ("organization_id") WHERE is_active = true;--> statement-breakpoint

-- ============================================================================================
-- comfort_kit_template — D3's kit definition. ONE org-less `is_platform_floor` row (seeded at the bottom of
-- this file) plus tenant rows that may EXTEND or TIGHTEN it but never drop below it. The CHECK pair is what
-- makes the nullable organization_id safe: floor => org-less, tenant => org-bearing. Enforcing only the
-- first direction would let an org-less TENANT template exist — invisible to its own tenant under RLS and
-- readable by every other one. `replaces_template_id` is the version chain: a revision is a NEW row, so a
-- 2026-03 dispatch still resolves the template it actually used.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "comfort_kit_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"name" text NOT NULL,
	"is_platform_floor" boolean DEFAULT false NOT NULL,
	"system_locked" boolean DEFAULT false NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"replaces_template_id" uuid,
	"state_labeling_policy_jsonb" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"controlled_substance_handling_policy_jsonb" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m21_ckit_tmpl_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckit_tmpl_replaces_fk" FOREIGN KEY ("replaces_template_id") REFERENCES "public"."comfort_kit_template"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckit_template_floor_orgless" CHECK ("is_platform_floor" = false OR "organization_id" IS NULL),
	CONSTRAINT "m21_ckit_template_tenant_has_org" CHECK ("is_platform_floor" = true OR "organization_id" IS NOT NULL),
	CONSTRAINT "m21_ckit_template_effective_window" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_template_org_active_idx" ON "comfort_kit_template" ("organization_id") WHERE effective_to IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_template_platform_floor_idx" ON "comfort_kit_template" ("is_platform_floor") WHERE is_platform_floor = true;--> statement-breakpoint

-- ============================================================================================
-- comfort_kit_template_medication — one row per medication line of a template.
--
-- DEVIATION FROM §3.1.4 (documented): §3.1 gives this table no tenancy column and scopes it with an
-- EXISTS-subquery RLS policy against its parent. ADR-0010 D2 requires the row's OWN visibility to key on
-- app.org_id — a subquery policy makes tenancy a join, so a mis-scoped parent silently widens the child —
-- and the predicate would run per row on every catalog read. Both discriminators are therefore denormalized
-- here with the same CHECK pair the parent carries, making the policy a flat predicate. Parent/child
-- consistency is a write-boundary invariant; the CHECK pair makes the dangerous half impossible.
--
-- The controlled-substance CHECK is bidirectional on purpose: a CII line with a NULL schedule and a saline
-- line carrying 'CII' are equally wrong, and only the first direction is the one people remember to write.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "comfort_kit_template_medication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"organization_id" uuid,
	"is_platform_floor" boolean DEFAULT false NOT NULL,
	"rxnorm" text NOT NULL,
	"ndc" text,
	"drug_name" text NOT NULL,
	"strength" text NOT NULL,
	"dosage_form" text NOT NULL,
	"route_of_administration" text NOT NULL,
	"is_controlled_substance" boolean NOT NULL,
	"controlled_substance_schedule" "m21_controlled_substance_schedule",
	"expected_quantity" numeric NOT NULL,
	"expected_unit" text NOT NULL,
	"replenishment_threshold_pct" numeric DEFAULT '0.25' NOT NULL,
	"system_locked" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m21_ckit_tmpl_med_template_fk" FOREIGN KEY ("template_id") REFERENCES "public"."comfort_kit_template"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckit_tmpl_med_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckit_tmpl_med_floor_orgless" CHECK ("is_platform_floor" = false OR "organization_id" IS NULL),
	CONSTRAINT "m21_ckit_tmpl_med_tenant_has_org" CHECK ("is_platform_floor" = true OR "organization_id" IS NOT NULL),
	CONSTRAINT "m21_ckit_tmpl_med_schedule_pair" CHECK (("is_controlled_substance" = true AND "controlled_substance_schedule" IS NOT NULL) OR ("is_controlled_substance" = false AND "controlled_substance_schedule" IS NULL)),
	CONSTRAINT "m21_ckit_tmpl_med_qty_positive" CHECK ("expected_quantity" > 0),
	CONSTRAINT "m21_ckit_tmpl_med_threshold_fraction" CHECK ("replenishment_threshold_pct" >= 0 AND "replenishment_threshold_pct" <= 1)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_template_medication_template_idx" ON "comfort_kit_template_medication" ("template_id","display_order");--> statement-breakpoint

-- ============================================================================================
-- vendor_routing_rule — D4's deterministic ladder (sku > location > tenant > platform, then
-- precedence_priority). There is NO fallback chain: the §3.2 draft's fallback_vendor_ids_jsonb +
-- fulfillment_channel model is REMOVED by §3.0, because a fallback list means two coordinators reading the
-- same rules can dispatch to different vendors and a survey asks "why did this bed come from Apria"
-- expecting exactly one answer. `scope_id` is polymorphic (supply_item id | location id | org id), hence no
-- FK. §3.1.13 seeds NO platform rows: every tenant must configure its own tenant-scope default, and
-- validateVendorRoutingAtBoot() is what refuses a tenant that has not.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "vendor_routing_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"scope_kind" "m21_routing_scope_kind" NOT NULL,
	"scope_id" uuid,
	"sku_class_pattern" text,
	"assigned_vendor_id" uuid,
	"assigned_fulfillment_mode" "m21_fulfillment_mode" NOT NULL,
	"default_pharmacy_dispatch_mode" "m21_pharmacy_dispatch_mode",
	"precedence_priority" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m21_routing_rule_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m21_routing_rule_platform_scope" CHECK (("scope_kind" = 'platform' AND "organization_id" IS NULL) OR ("scope_kind" <> 'platform' AND "organization_id" IS NOT NULL)),
	CONSTRAINT "m21_routing_rule_scope_target" CHECK (("scope_kind" IN ('sku', 'location') AND "scope_id" IS NOT NULL) OR "scope_kind" IN ('tenant', 'platform')),
	CONSTRAINT "m21_routing_rule_vendor_mode" CHECK ("assigned_fulfillment_mode" <> 'vendor' OR "assigned_vendor_id" IS NOT NULL),
	CONSTRAINT "m21_routing_rule_effective_window" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_routing_rule_org_active_idx" ON "vendor_routing_rule" ("organization_id","scope_kind","scope_id") WHERE is_active = true AND effective_to IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_routing_rule_scope_lookup_idx" ON "vendor_routing_rule" ("scope_kind","scope_id","sku_class_pattern") WHERE is_active = true;--> statement-breakpoint

-- ============================================================================================
-- par_stock — D5's per-Location shelf posture. Severity (ok / low / critical) is DERIVED in
-- @wardenx/supplies, never stored: a stored severity is a second source of truth that goes stale the moment
-- a threshold is edited, and the screen reading it would show a green shelf that is actually empty.
--
-- provider_entity_id is NOT NULL because the published M21ParThresholdPayload puts providerEntityId on every
-- threshold alert; resolving the CCN by joining M2's Location at alert time is exactly the cross-module read
-- the seam rules forbid.
--
-- DEVIATION FROM §3.1.6 (documented): the spec's four-column `UNIQUE (org, location, sku_id,
-- tenant_sku_extension_id)` does not do what it says — a UNIQUE containing a NULL column does not dedupe in
-- PostgreSQL, so (org, loc, sku, NULL) twice is two legal rows. Two PARTIAL unique indexes, one per side of
-- the XOR, actually enforce it.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "par_stock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"sku_id" uuid,
	"tenant_sku_extension_id" uuid,
	"current_quantity" numeric DEFAULT '0' NOT NULL,
	"unit" text NOT NULL,
	"reorder_point" numeric DEFAULT '0' NOT NULL,
	"reorder_quantity" numeric DEFAULT '0' NOT NULL,
	"min_safety_stock" numeric DEFAULT '0' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_par_review_at" timestamp with time zone,
	"last_par_reviewed_by_membership_id" uuid,
	"reorder_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m21_par_stock_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m21_par_stock_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m21_par_stock_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m21_par_stock_sku_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."supply_item"("id") ON DELETE restrict,
	CONSTRAINT "m21_par_stock_tenant_sku_fk" FOREIGN KEY ("tenant_sku_extension_id") REFERENCES "public"."tenant_supply_item_extension"("id") ON DELETE restrict,
	CONSTRAINT "m21_par_stock_sku_xor" CHECK (("sku_id" IS NOT NULL) <> ("tenant_sku_extension_id" IS NOT NULL)),
	CONSTRAINT "m21_par_stock_qty_non_negative" CHECK ("current_quantity" >= 0),
	CONSTRAINT "m21_par_stock_thresholds_ordered" CHECK ("min_safety_stock" >= 0 AND "reorder_point" >= "min_safety_stock" AND "reorder_quantity" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "m21_par_stock_platform_sku_uniq" ON "par_stock" ("organization_id","location_id","sku_id") WHERE sku_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "m21_par_stock_tenant_sku_uniq" ON "par_stock" ("organization_id","location_id","tenant_sku_extension_id") WHERE tenant_sku_extension_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "par_stock_org_location_active_idx" ON "par_stock" ("organization_id","location_id") WHERE is_active = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "par_stock_below_reorder_idx" ON "par_stock" ("organization_id","location_id") WHERE is_active = true AND current_quantity <= reorder_point;--> statement-breakpoint

-- ============================================================================================
-- comfort_kit_dispatched_content — D6, the OUTBOUND half of the DEA 21 CFR §1304 perpetual log. One row per
-- medication line that physically left the hub: lot, expiration, exact quantity, schedule, and the M12
-- prescription behind it. Everything the return reconciliation subtracts from lives here.
--
-- NOT partitioned even though its parent is (§3.1.9): it is always read THROUGH a dispatch, so it inherits
-- the parent's pruning, and partitioning it would forbid the real FKs — to comfort_kit_template_medication
-- and from comfort_kit_returned_content — that keep the controlled-substance accounting closed. It carries
-- `dispatch_partition_dispatched_at` so a reader can address the parent's composite key directly.
--
-- Declared here rather than alongside its parent in 0105 because this file is the unpartitioned set (see the
-- header): a table keyed on `id` alone cannot share a file with one whose PK is (id, dispatched_at).
--
-- DEVIATION FROM §3.1.9 (documented): the spec's `CHECK (expiration_date >= CURRENT_DATE + INTERVAL '14
-- days')` CANNOT BE CREATED — CURRENT_DATE is STABLE (it reads the transaction clock) and PostgreSQL refuses
-- non-immutable expressions in a CHECK. It is also wrong as a CHECK even if it were legal: a row written
-- today would start FAILING its own constraint fifteen days later, so any unrelated UPDATE to a two-year-old
-- dispatch line would be rejected. The 14-day platform floor moves to the BEFORE INSERT OR UPDATE OF
-- expiration_date trigger `m21_enforce_dispatch_expiration_floor()` in 0106 — the same rule, evaluated at
-- the only moment it means anything. Same class of finding as M16's death_anchor_at.
--
-- Controlled => lot AND expiration; NOT the reverse. A non-controlled line MAY carry them (many do), it is
-- simply not required to.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "comfort_kit_dispatched_content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"dispatch_partition_dispatched_at" timestamp with time zone NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"comfort_kit_template_medication_id" uuid NOT NULL,
	"medication_order_id" uuid,
	"rxnorm" text NOT NULL,
	"ndc" text,
	"drug_name" text NOT NULL,
	"strength" text NOT NULL,
	"dosage_form" text NOT NULL,
	"route_of_administration" text NOT NULL,
	"is_controlled_substance" boolean NOT NULL,
	"controlled_substance_schedule" "m21_controlled_substance_schedule",
	"dispatched_quantity" numeric NOT NULL,
	"dispatched_unit" text NOT NULL,
	"lot_number" text,
	"expiration_date" date,
	"manufacturer_ndc" text,
	"dea_perpetual_log_jsonb" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m21_ckdc_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckdc_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckdc_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckdc_template_med_fk" FOREIGN KEY ("comfort_kit_template_medication_id") REFERENCES "public"."comfort_kit_template_medication"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckit_disp_content_controlled_lot" CHECK ("is_controlled_substance" = false OR ("lot_number" IS NOT NULL AND "expiration_date" IS NOT NULL)),
	CONSTRAINT "m21_ckit_disp_content_schedule_pair" CHECK (("is_controlled_substance" = true AND "controlled_substance_schedule" IS NOT NULL) OR ("is_controlled_substance" = false AND "controlled_substance_schedule" IS NULL)),
	CONSTRAINT "m21_ckit_disp_content_qty_positive" CHECK ("dispatched_quantity" > 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_dispatched_content_dispatch_idx" ON "comfort_kit_dispatched_content" ("dispatch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_dispatched_content_med_order_idx" ON "comfort_kit_dispatched_content" ("medication_order_id") WHERE medication_order_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_dispatched_content_lot_expiry_idx" ON "comfort_kit_dispatched_content" ("lot_number","expiration_date") WHERE lot_number IS NOT NULL;--> statement-breakpoint

-- ============================================================================================
-- comfort_kit_return — D8/§2.6's chain-of-custody machine, from "the patient died, the kit must come back"
-- to a reconciled, witnessed disposal record. `overdue` (30d) and `unreturnable` (90d assumption of loss)
-- are STATES, not flags: a kit that never comes back is a survey-reportable disposition needing an attested
-- reason, not a retrieval still in progress.
--
-- §3.0 drops the §3.2 draft's `reconciliation_status = 'pending'` + `returned_at NOT NULL at creation` fork:
-- the row is created when the OBLIGATION arises, long before anything is returned, and reconciliation is the
-- terminal state rather than a parallel status column.
--
-- THE WITNESS-DISTINCTNESS CHECK is the load-bearing one. At-home witnessed destruction of a CII solution is
-- the most diversion-exposed moment in hospice; a witness who is also the reconciler or the retriever is not
-- a witness, because one person then attests to their own count. Written with IS DISTINCT FROM so a NULL
-- counterpart cannot make the comparison evaluate to NULL and pass by accident.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "comfort_kit_return" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"dispatch_partition_dispatched_at" timestamp with time zone NOT NULL,
	"m13_deployment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"return_required_at" timestamp with time zone NOT NULL,
	"return_due_at" timestamp with time zone NOT NULL,
	"assigned_retrieving_membership_id" uuid,
	"retrieving_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone,
	"returned_to_hub_at" timestamp with time zone,
	"disposal_method" "m21_disposal_method",
	"disposal_method_jurisdiction_policy_digest" text,
	"disposal_witness_membership_id" uuid,
	"reconciled_by_membership_id" uuid,
	"reconciled_at" timestamp with time zone,
	"receipt_document_id" uuid,
	"state" "m21_return_state" DEFAULT 'requested' NOT NULL,
	"disposal_notes" text,
	"discrepancy_notes" text,
	"unreturnable_reason" text,
	"unreturnable_attested_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m21_ckr_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckr_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckr_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckit_return_reconciled_complete" CHECK ("state" <> 'reconciled' OR ("disposal_method" IS NOT NULL AND "reconciled_by_membership_id" IS NOT NULL AND "reconciled_at" IS NOT NULL)),
	CONSTRAINT "m21_ckit_return_home_witness" CHECK ("disposal_method" <> 'dispose_at_home_by_witnessed_destruction' OR "disposal_witness_membership_id" IS NOT NULL),
	CONSTRAINT "m21_ckit_return_witness_distinct" CHECK ("disposal_witness_membership_id" IS NULL OR ("disposal_witness_membership_id" IS DISTINCT FROM "reconciled_by_membership_id" AND "disposal_witness_membership_id" IS DISTINCT FROM "assigned_retrieving_membership_id")),
	CONSTRAINT "m21_ckit_return_unreturnable_attested" CHECK ("state" <> 'unreturnable' OR ("unreturnable_reason" IS NOT NULL AND "unreturnable_attested_by_membership_id" IS NOT NULL)),
	CONSTRAINT "m21_ckit_return_due_after_required" CHECK ("return_due_at" >= "return_required_at")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_return_state_idx" ON "comfort_kit_return" ("organization_id","state","return_due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_return_dispatch_idx" ON "comfort_kit_return" ("dispatch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_return_m13_deployment_idx" ON "comfort_kit_return" ("m13_deployment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_return_overdue_idx" ON "comfort_kit_return" ("organization_id","state") WHERE state IN ('requested','assigned','retrieving','retrieved');--> statement-breakpoint

-- ============================================================================================
-- comfort_kit_returned_content — D8, the INBOUND half of the perpetual log, where the single discrepancy
-- formula closes the count:
--
--     quantity_unaccounted = dispatched_quantity - quantity_returned - quantity_disposed_at_home
--
-- (§3.0 resolves the drift: D8's prose adds an `expected_consumed_if_known` term the §3.1 trigger does not
-- compute, and §3.1 governs.) A controlled line whose |unaccounted| reaches 5% of what was dispatched sets
-- discrepancy_flagged, which is what fires m21.controlled_substance.discrepancy_detected.
--
-- `quantity_disposed_at_home` is the SUPPORT Act column and is NOT optional: when a family destroys the
-- remaining morphine at the bedside under witness, that quantity is ACCOUNTED FOR, not missing. Dropping it
-- (as the §3.2 draft did) turns every legal home disposal into a diversion alert.
--
-- The three computed columns are NOT GENERATED columns: the formula reads dispatched_quantity from ANOTHER
-- row, which a generated column cannot do. `m21_compute_return_discrepancy()` in 0106 computes them and
-- fails CLOSED when the dispatched line is not visible. (§3.0 also removes the spec's placeholder GENERATED
-- definition + its later DROP — one clean definition.)
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "comfort_kit_returned_content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"dispatched_content_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity_returned" numeric DEFAULT '0' NOT NULL,
	"quantity_disposed_at_home" numeric DEFAULT '0' NOT NULL,
	"quantity_unaccounted" numeric DEFAULT '0' NOT NULL,
	"discrepancy_pct" numeric DEFAULT '0' NOT NULL,
	"discrepancy_flagged" boolean DEFAULT false NOT NULL,
	"is_controlled_substance" boolean NOT NULL,
	"controlled_substance_schedule" "m21_controlled_substance_schedule",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m21_ckrc_return_fk" FOREIGN KEY ("return_id") REFERENCES "public"."comfort_kit_return"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckrc_dispatched_content_fk" FOREIGN KEY ("dispatched_content_id") REFERENCES "public"."comfort_kit_dispatched_content"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckrc_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckrc_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckrc_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckit_ret_content_qty_non_negative" CHECK ("quantity_returned" >= 0 AND "quantity_disposed_at_home" >= 0),
	CONSTRAINT "m21_ckit_ret_content_schedule_pair" CHECK (("is_controlled_substance" = true AND "controlled_substance_schedule" IS NOT NULL) OR ("is_controlled_substance" = false AND "controlled_substance_schedule" IS NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_returned_content_return_idx" ON "comfort_kit_returned_content" ("return_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_returned_content_dispatched_idx" ON "comfort_kit_returned_content" ("dispatched_content_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_returned_content_discrepancy_idx" ON "comfort_kit_returned_content" ("organization_id") WHERE discrepancy_flagged = true;--> statement-breakpoint

-- ============================================================================================
-- §3.1.12 — the D3 PLATFORM-FLOOR comfort-kit template seed: the four medications every hospice comfort kit
-- must contain (morphine 20 mg/mL 30 mL, lorazepam 2 mg/mL 15 mL, haloperidol 5 mg/mL 10 mL, atropine 1% 5
-- mL). `system_locked` + `is_platform_floor` with a NULL organization_id: readable inside every tenant,
-- writable by none. Idempotent on the fixed id so a re-run of the chain does not duplicate the floor.
--
-- The RxNorm CUIs are the spec's illustrative values. §3.1.12's note stands: a production migration resolves
-- them against M38's terminology service at migration-prep time with a fallback to these seeded values if
-- M38's RxNorm load has not yet run.
-- ============================================================================================
INSERT INTO "comfort_kit_template"
  ("id", "organization_id", "name", "is_platform_floor", "system_locked", "state_labeling_policy_jsonb", "controlled_substance_handling_policy_jsonb")
VALUES
  ('00000000-0021-0000-0000-000000000001'::uuid,
   NULL,
   'Hospice Comfort Kit — Platform Floor v1',
   true, true,
   '{"requireRxNumberOnLabel": true, "requirePatientNameOnLabel": true, "requirePrescriberNameOnLabel": true, "requireExpirationDateOnLabel": true, "requireLotNumberOnLabel": true}'::jsonb,
   '{"requireLockBox": true, "requireFamilyEducationCompletedAtDelivery": true, "controlledSubstanceWitnessRequired": true, "requireChainOfCustodyScan": true}'::jsonb)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "comfort_kit_template_medication"
  ("id", "template_id", "organization_id", "is_platform_floor", "rxnorm", "drug_name", "strength", "dosage_form", "route_of_administration",
   "is_controlled_substance", "controlled_substance_schedule",
   "expected_quantity", "expected_unit", "replenishment_threshold_pct", "system_locked", "display_order")
VALUES
  ('00000000-0021-0000-0000-000000000101'::uuid, '00000000-0021-0000-0000-000000000001'::uuid, NULL, true,
   '892484', 'Morphine sulfate 20 mg/mL oral solution', '20 mg/mL', 'oral_solution', 'PO', true, 'CII', 30, 'mL', 0.25, true, 1),
  ('00000000-0021-0000-0000-000000000102'::uuid, '00000000-0021-0000-0000-000000000001'::uuid, NULL, true,
   '203128', 'Lorazepam 2 mg/mL oral solution', '2 mg/mL', 'oral_solution', 'PO', true, 'CIV', 15, 'mL', 0.25, true, 2),
  ('00000000-0021-0000-0000-000000000103'::uuid, '00000000-0021-0000-0000-000000000001'::uuid, NULL, true,
   '197518', 'Haloperidol 5 mg/mL oral solution', '5 mg/mL', 'oral_solution', 'PO', false, NULL, 10, 'mL', 0.25, true, 3),
  ('00000000-0021-0000-0000-000000000104'::uuid, '00000000-0021-0000-0000-000000000001'::uuid, NULL, true,
   '1245995', 'Atropine 1% ophthalmic solution', '1%', 'ophthalmic_solution', 'ophthalmic_SL', false, NULL, 5, 'mL', 0.25, true, 4)
ON CONFLICT ("id") DO NOTHING;
