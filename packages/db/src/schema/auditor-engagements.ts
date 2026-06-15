// @wardenx/db — `auditor_engagement` (M3 Authorization §3.5). A time-bound, least-privilege,
// accountable window during which an external auditor (CMS/state survey, TPE, UPIC, financial
// audit, …) may read a defined slice of tenant data. Org-scoped on organization_id; the
// in-scope rows an auditor session may read are narrowed by the `engagement_scope` ABAC
// predicate (§3.6), NOT by RLS. `scope` jsonb encodes the slice
// ({tenantWide?, providerEntityIds?, patientIds?, claimIds?, fiscalYears?}); the [start_at,
// end_at) window bounds the engagement. Standard app.org_id RLS lands in M3-T04.
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { engagementStatus, engagementType } from "../enums";
import { organizations } from "./organizations";
import { users } from "./users";

export const auditorEngagements = pgTable(
  "auditor_engagement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    engagementType: engagementType("engagement_type").notNull(),
    auditorAgency: text("auditor_agency").notNull(),
    contact: text("contact"),
    scope: jsonb("scope").notNull(), // {tenantWide?, providerEntityIds?, patientIds?, claimIds?, fiscalYears?}
    status: engagementStatus("status").notNull().default("scheduled"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("engagement_org_idx").on(t.organizationId),
    windowIdx: index("engagement_window_idx").on(t.startAt, t.endAt),
    // §3.7: the engagement window must be a valid forward interval [start_at, end_at).
    windowValid: check("auditor_engagement_window_chk", sql`${t.startAt} < ${t.endAt}`),
  }),
);

export type AuditorEngagement = typeof auditorEngagements.$inferSelect;
export type NewAuditorEngagement = typeof auditorEngagements.$inferInsert;
