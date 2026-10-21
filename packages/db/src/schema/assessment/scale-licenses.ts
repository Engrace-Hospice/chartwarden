// @chartwarden/db — `scale_license` (M9 §3.3, D3). Per-tenant licensure for the proprietary scales (PPS,
// FAST, GDS, Braden, Morse): without an active license the recording form is hidden and the API
// rejects writes; historical values recorded under a prior active license stay readable. Org-level
// licensing config, NOT patient PHI → carries organization_id only (the ARCH-011 org-level carve-out).
// Actor ref goes to M1 `membership`. RLS + grants + the M4 write-audit trigger land in the RLS
// migration; the at-most-one-active-license-per-(org,scale) rule is a partial unique index.
import { sql } from "drizzle-orm";
import { date, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { businessRule } from "../../business-rules";
import { scaleLicenseStatus, scaleType } from "../../enums";
import { memberships } from "../memberships";
import { organizations } from "../organizations";

/**
 * At most one ACTIVE license per (org, scale) — the rule the partial unique index enforces, together
 * with what violating it means to the caller. `businessRule()` returns the constraint name, so the
 * index below is defined by this declaration and there is no second list to keep in sync; a `23505`
 * on it answers 409 with this sentence instead of a bare 500 (F-022 / #55).
 *
 * Declared HERE rather than inside `pgTable`'s config callback because Drizzle invokes that callback
 * lazily (only when the table's config is read), and a registration that has not run is a rule the
 * error handler cannot see.
 */
const ACTIVE_PER_ORG_SCALE_UQ = businessRule(
  "scale_license_active_per_org_scale_uq",
  "This organization already has an active license for this scale type. Expire or replace the existing license before registering another.",
);

export const scaleLicenses = pgTable(
  "scale_license",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    scaleType: scaleType("scale_type").notNull(),
    licenseHolder: text("license_holder").notNull(),
    licenseNumber: text("license_number"),
    effectiveDate: date("effective_date").notNull(),
    expiresAt: date("expires_at").notNull(),
    status: scaleLicenseStatus("status").notNull().default("active"),
    // NOT NULL relaxed in mig 0129 (M9L): the license-admin route threads no acting membership.
    recordedByMembershipId: uuid("recorded_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // At most one active license per (org, scale) — see ACTIVE_PER_ORG_SCALE_UQ above.
    activePerOrgScale: uniqueIndex(ACTIVE_PER_ORG_SCALE_UQ)
      .on(t.organizationId, t.scaleType)
      .where(sql`status = 'active'`),
  }),
);

export type ScaleLicense = typeof scaleLicenses.$inferSelect;
export type NewScaleLicense = typeof scaleLicenses.$inferInsert;
