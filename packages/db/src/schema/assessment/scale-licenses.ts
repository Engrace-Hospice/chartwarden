// @wardenx/db — `scale_license` (M9 §3.3, D3). Per-tenant licensure for the proprietary scales (PPS,
// FAST, GDS, Braden, Morse): without an active license the recording form is hidden and the API
// rejects writes; historical values recorded under a prior active license stay readable. Org-level
// licensing config, NOT patient PHI → carries organization_id only (the ARCH-011 org-level carve-out).
// Actor ref goes to M1 `membership`. RLS + grants + the M4 write-audit trigger land in the RLS
// migration; the at-most-one-active-license-per-(org,scale) rule is a partial unique index.
import { sql } from "drizzle-orm";
import { date, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { scaleType, scaleLicenseStatus } from "../../enums";
import { organizations } from "../organizations";
import { memberships } from "../memberships";

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
    // At most one active license per (org, scale).
    activePerOrgScale: uniqueIndex("scale_license_active_per_org_scale_uq")
      .on(t.organizationId, t.scaleType)
      .where(sql`status = 'active'`),
  }),
);

export type ScaleLicense = typeof scaleLicenses.$inferSelect;
export type NewScaleLicense = typeof scaleLicenses.$inferInsert;
