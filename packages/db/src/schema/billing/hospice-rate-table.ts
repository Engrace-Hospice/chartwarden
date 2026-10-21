import { sql } from "drizzle-orm";
// @chartwarden/db — `hospice_rate_table` (M23 Billing-Medicare; F-210). The TENANT-ENTERED, effective-dated hospice
// per-diem rate set the claim assembler prices HIPPS segments and the SIA add-on from. One row = one VERSION of one
// provider entity's rates over `[effective_from, effective_to]` (NULL `effective_to` = open). ORG-SCOPED:
// organization_id NOT NULL (canonical app.org_id RLS, ENABLED + FORCED). No PHI.
//
// APPEND-ONLY: a correction SUPERSEDES a row (`superseded_at` + `superseded_by_id`, the only app-updatable columns —
// column-level GRANT + `hospice_rate_table_guard` trigger); rates are never edited in place. Two live (non-superseded)
// versions for one provider entity can never overlap in date: migration 0279's `hospice_rate_table_no_overlap` EXCLUDE
// constraint (btree_gist) — drizzle cannot express an EXCLUDE, so it lives in the SQL migration only, with the CHECK
// constraints (positive/banded cents, RHC tier order, CHC hourly x24 agreement).
//
// All rates are PRE-wage-index whole cents; the wage index is applied at assembly from `wage_index_factor`.
// CROSS-MODULE FK POLICY: only organization_id gets a real `.references(...)`; provider_entity_id (M40) and
// entered_by_membership_id (core memberships) are LOGICAL FKs, as `sequestration_policy`.
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const hospiceRateTable = pgTable(
  "hospice_rate_table",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK → M40

    /** The federal fiscal year's STARTING calendar year (Oct 1): 2025 = FY2026 (Oct 2025 - Sep 2026). */
    fiscalYearStarting: integer("fiscal_year_starting").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"), // NULL = open-ended

    rhcDays1to60PerDiemCents: integer("rhc_days_1_60_per_diem_cents").notNull(),
    rhcDays61PlusPerDiemCents: integer("rhc_days_61_plus_per_diem_cents").notNull(),
    chcPerDiemCents: integer("chc_per_diem_cents").notNull(),
    ircPerDiemCents: integer("irc_per_diem_cents").notNull(),
    gipPerDiemCents: integer("gip_per_diem_cents").notNull(),
    /** PRE-wage-index CHC hourly rate (the SIA add-on's rate) — 24 x this agrees with `chc_per_diem_cents`. */
    chcHourlyRateCents: integer("chc_hourly_rate_cents").notNull(),

    /**
     * F-211 (migration 0280) — the CMS-published LABOR SHARE per level of care, decimal strings in [0.30, 0.90]. The wage
     * index adjusts only this share of a rate. All four set or all four NULL (a version entered under 0279, before the
     * columns existed): assembly fails closed on a NULL set rather than guessing a share.
     */
    laborShareRhc: numeric("labor_share_rhc", { precision: 5, scale: 4 }),
    laborShareChc: numeric("labor_share_chc", { precision: 5, scale: 4 }),
    laborShareIrc: numeric("labor_share_irc", { precision: 5, scale: 4 }),
    laborShareGip: numeric("labor_share_gip", { precision: 5, scale: 4 }),

    /**
     * FY2027 workstream E (migration 0394) — the provider entity's declared HQRP status for this fiscal year:
     * true = the HQRP-compliant national rates, false = the 4-point-reduced rates (42 CFR 418.306(b)(2)), NULL =
     * undeclared (a version entered before 0394). Append-only like the rates; it only drives the national-reference
     * sanity check, never pricing (assembly prices from the keyed rates).
     */
    hqrpCompliant: boolean("hqrp_compliant"),

    enteredByMembershipId: uuid("entered_by_membership_id").notNull(), // logical FK → memberships
    entryReason: text("entry_reason"),

    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededById: uuid("superseded_by_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lookup: index("hospice_rate_table_lookup_idx").on(
      t.organizationId,
      t.providerEntityId,
      sql`${t.effectiveFrom} DESC`,
    ),
  }),
);

export type HospiceRateTable = typeof hospiceRateTable.$inferSelect;
export type NewHospiceRateTable = typeof hospiceRateTable.$inferInsert;
