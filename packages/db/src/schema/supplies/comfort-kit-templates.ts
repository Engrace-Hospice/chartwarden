// @wardenx/db — `comfort_kit_template` (M21 §3.1.4). D3's platform-floor-plus-tenant-overlay definition of
// what a comfort kit IS: the four-medication floor (morphine 20 mg/mL 30 mL, lorazepam 2 mg/mL 15 mL,
// haloperidol 5 mg/mL 10 mL, atropine 1% 5 mL) ships as ONE `is_platform_floor` row seeded in migration
// 0103, and a tenant may EXTEND it (add medications) or TIGHTEN it (lower a replenishment threshold) but
// never drop below the floor — the M9 D2 / M11 D3 / M15 D3 pattern, enforced by
// `@wardenx/supplies`'s `template/floor` module at the write boundary.
//
// TENANCY (ARCH-011 / ADR-0010): organization_id is NULLABLE and paired with `is_platform_floor`. The
// platform-floor row is org-less by construction (one row, every tenant reads it); every tenant row carries
// organization_id NOT NULL via the CHECK pair below. RLS therefore reads
// `is_platform_floor = true OR organization_id = app.org_id` for SELECT and the plain org predicate for
// INSERT/UPDATE, so a tenant can see the floor but can never write it (migration 0106). No
// provider_entity_id / location_id: a template is org-level clinical config, not a patient record.
//
// D3 IMMUTABILITY: `system_locked` is what makes the floor un-editable through the app path — the row is
// visible, referenced by every dispatch, and refused by both the RLS write policy and the service layer.
// `replaces_template_id` gives the version chain: a tenant revising its kit inserts a NEW row pointing back,
// so a dispatch from 2026-03 still resolves the template it actually used (survey reconstruction, §7.2).
//
// CROSS-MODULE FK POLICY: only organization_id (M1 core) and the intra-M21 self-reference carry real FKs.
import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const comfortKitTemplate = pgTable(
  "comfort_kit_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // NULL on the platform-floor row ONLY (see the CHECK pair below).
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),

    name: text("name").notNull(),
    isPlatformFloor: boolean("is_platform_floor").notNull().default(false),
    systemLocked: boolean("system_locked").notNull().default(false),

    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    // Self-reference: the superseded template this row replaces. Never cascades — the old row must survive
    // for every dispatch that resolved against it.
    replacesTemplateId: uuid("replaces_template_id"),

    /** §3.1.4 — the state-board labeling requirements the kit's dispensing label must satisfy. */
    stateLabelingPolicyJsonb: jsonb("state_labeling_policy_jsonb")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** The lock-box / witness / chain-of-custody policy. Its digest is frozen onto every dispatch so a
     *  later policy edit cannot retroactively change what the courier was told to do. */
    controlledSubstanceHandlingPolicyJsonb: jsonb("controlled_substance_handling_policy_jsonb")
      .notNull()
      .default(sql`'{}'::jsonb`),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgActiveIdx: index("comfort_kit_template_org_active_idx")
      .on(t.organizationId)
      .where(sql`effective_to IS NULL`),
    platformFloorIdx: index("comfort_kit_template_platform_floor_idx")
      .on(t.isPlatformFloor)
      .where(sql`is_platform_floor = true`),

    // The CHECK pair that makes the nullable org column safe: floor ⇒ org-less, tenant ⇒ org-bearing.
    // Only enforcing the first direction would let an org-less tenant template exist — invisible to its
    // own tenant under RLS and readable by every other one.
    floorIsOrgless: check(
      "m21_ckit_template_floor_orgless",
      sql`is_platform_floor = false OR organization_id IS NULL`,
    ),
    tenantRowHasOrg: check(
      "m21_ckit_template_tenant_has_org",
      sql`is_platform_floor = true OR organization_id IS NOT NULL`,
    ),
    effectiveWindowOrdered: check(
      "m21_ckit_template_effective_window",
      sql`effective_to IS NULL OR effective_to > effective_from`,
    ),
  }),
);

export type ComfortKitTemplateRow = typeof comfortKitTemplate.$inferSelect;
export type NewComfortKitTemplateRow = typeof comfortKitTemplate.$inferInsert;
