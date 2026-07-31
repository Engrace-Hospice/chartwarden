// @wardenx/db — `comfort_kit_template_medication` (M21 §3.1.4). One row per medication line of a template:
// the drug, its strength/form/route, the expected quantity that constitutes a full kit, and the
// `replenishment_threshold_pct` at which M13's bedside drawdown fires `m13.comfort_kit.replenishment_needed`.
// The four platform-floor lines are seeded `system_locked` in migration 0103.
//
// DEVIATION FROM §3.1.4 (documented, architecture wins): §3.1 gives this table NO tenancy column and scopes
// it with an EXISTS-subquery RLS policy against its parent template. Two problems: ADR-0010 D2 requires the
// row's own visibility to key on `app.org_id` (a subquery policy makes tenancy a join, so a mis-scoped
// parent silently widens the child), and an EXISTS predicate runs per row on every catalog read. Both
// discriminators are therefore DENORMALIZED onto this row — `organization_id` (NULL on the floor lines) and
// `is_platform_floor` — with the same CHECK pair the parent carries, so the policy is a flat predicate.
// Consistency with the parent is a write-boundary invariant enforced by `@wardenx/supplies`; the CHECK pair
// makes the dangerous half (an org-less tenant line) impossible at the storage layer.
//
// D6 / DEA: `is_controlled_substance` + `controlled_substance_schedule` are the pair that decides, at
// dispatch time, whether §3.1.9's lot/expiration columns are mandatory. The CHECK enforces both directions —
// a CII line with a NULL schedule and a plain-saline line carrying 'CII' are equally wrong.
//
// CROSS-MODULE FK POLICY: only organization_id (M1 core) and the intra-M21 `template_id` parent carry real
// FKs. `rxnorm`/`ndc` are M38 terminology codes stored as text, never a FK into M38's concept tables.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { controlledSubstanceSchedule } from "../../enums";
import { organizations } from "../organizations";
import { comfortKitTemplate } from "./comfort-kit-templates";

export const comfortKitTemplateMedication = pgTable(
  "comfort_kit_template_medication",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      // RESTRICT, not CASCADE: a template referenced by any dispatch may never be deleted out from under
      // the DEA perpetual log (§3.1.4 is explicit; the §3.2 draft's CASCADE is the drift §3.0 resolves).
      .references(() => comfortKitTemplate.id, { onDelete: "restrict" }),

    // Denormalized tenancy discriminators — see the header. NULL org ⇔ platform-floor line.
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    isPlatformFloor: boolean("is_platform_floor").notNull().default(false),

    rxnorm: text("rxnorm").notNull(),
    ndc: text("ndc"),
    drugName: text("drug_name").notNull(),
    strength: text("strength").notNull(),
    dosageForm: text("dosage_form").notNull(),
    routeOfAdministration: text("route_of_administration").notNull(),

    isControlledSubstance: boolean("is_controlled_substance").notNull(),
    controlledSubstanceSchedule: controlledSubstanceSchedule("controlled_substance_schedule"),

    /** `numeric`, never a float: 0.1 mL of a CII solution must round-trip exactly (D6). */
    expectedQuantity: numeric("expected_quantity").notNull(),
    expectedUnit: text("expected_unit").notNull(),
    /** D3 — the fraction remaining at which M13 asks for a replenish. Tenants may only RAISE it above the
     *  platform floor (a higher threshold replenishes sooner = tighter); lowering it lets a kit run further
     *  down before anyone is told. Enforced by `validateTenantTemplate` in `@wardenx/supplies`. */
    replenishmentThresholdPct: numeric("replenishment_threshold_pct").notNull().default("0.25"),

    systemLocked: boolean("system_locked").notNull().default(false),
    displayOrder: integer("display_order").notNull().default(0),
    /** Clinician-authored line note — D13 audit-denylisted. */
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    templateIdx: index("comfort_kit_template_medication_template_idx").on(
      t.templateId,
      t.displayOrder,
    ),

    floorIsOrgless: check(
      "m21_ckit_tmpl_med_floor_orgless",
      sql`is_platform_floor = false OR organization_id IS NULL`,
    ),
    tenantRowHasOrg: check(
      "m21_ckit_tmpl_med_tenant_has_org",
      sql`is_platform_floor = true OR organization_id IS NOT NULL`,
    ),
    // Both directions of the controlled-substance pair (see header).
    scheduleMatchesControlled: check(
      "m21_ckit_tmpl_med_schedule_pair",
      sql`(is_controlled_substance = true AND controlled_substance_schedule IS NOT NULL)
          OR (is_controlled_substance = false AND controlled_substance_schedule IS NULL)`,
    ),
    quantityPositive: check("m21_ckit_tmpl_med_qty_positive", sql`expected_quantity > 0`),
    thresholdIsFraction: check(
      "m21_ckit_tmpl_med_threshold_fraction",
      sql`replenishment_threshold_pct >= 0 AND replenishment_threshold_pct <= 1`,
    ),
  }),
);

export type ComfortKitTemplateMedicationRow = typeof comfortKitTemplateMedication.$inferSelect;
export type NewComfortKitTemplateMedicationRow = typeof comfortKitTemplateMedication.$inferInsert;
