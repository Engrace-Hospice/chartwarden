import { sql } from "drizzle-orm";
// @wardenx/db — `hospice_visit_charge_schedule` (M23 Billing-Medicare; migration 1056). The TENANT-ENTERED,
// effective-dated charge per 15-MINUTE UNIT per visit discipline that claim assembly bills each hospice visit line at
// (CMS Pub. 100-04 ch. 11 §30.3: a visit line carries "a charge amount", informational — the visit is bundled into the
// level-of-care payment). One row = one VERSION of one provider entity's schedule over `[effective_from, effective_to]`
// (NULL `effective_to` = open). ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS, ENABLED + FORCED). No PHI.
//
// APPEND-ONLY, like `hospice_rate_table` (F-210): a correction SUPERSEDES a row (`superseded_at` + `superseded_by_id`, the
// only app-updatable columns — column GRANT + `hospice_visit_charge_schedule_guard` trigger); charges are never edited in
// place. Two live versions for one provider entity can never overlap in date: the migration's EXCLUDE constraint
// (btree_gist) — drizzle cannot express an EXCLUDE, so it lives in the SQL migration only, with the CHECK constraints.
//
// A discipline column is NULL when no charge was entered for it (assembly then FAILS CLOSED rather than guess); 0 is a
// deliberate "free" charge. All charges are whole cents per 15-minute unit.
// CROSS-MODULE FK POLICY: only organization_id gets a real `.references(...)`; provider_entity_id (M40) and
// entered_by_membership_id (core memberships) are LOGICAL FKs, as `hospice_rate_table`.
import { date, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const hospiceVisitChargeSchedule = pgTable(
  "hospice_visit_charge_schedule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK → M40

    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"), // NULL = open-ended

    /** Per-15-minute-unit charge, whole cents; NULL = no charge entered for that discipline. */
    rnUnitChargeCents: integer("rn_unit_charge_cents"),
    lpnUnitChargeCents: integer("lpn_unit_charge_cents"),
    aideUnitChargeCents: integer("aide_unit_charge_cents"),
    mswUnitChargeCents: integer("msw_unit_charge_cents"),
    ptUnitChargeCents: integer("pt_unit_charge_cents"),
    otUnitChargeCents: integer("ot_unit_charge_cents"),
    slpUnitChargeCents: integer("slp_unit_charge_cents"),

    enteredByMembershipId: uuid("entered_by_membership_id").notNull(), // logical FK → memberships
    entryReason: text("entry_reason"),

    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededById: uuid("superseded_by_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lookup: index("hospice_visit_charge_schedule_lookup_idx").on(
      t.organizationId,
      t.providerEntityId,
      sql`${t.effectiveFrom} DESC`,
    ),
  }),
);

export type HospiceVisitChargeSchedule = typeof hospiceVisitChargeSchedule.$inferSelect;
export type NewHospiceVisitChargeSchedule = typeof hospiceVisitChargeSchedule.$inferInsert;
