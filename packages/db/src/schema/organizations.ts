// @chartwarden/db — `organization` (M1 Foundation §3.3). Root of the tenancy spine:
// it DEFINES org scope, so it is NON_ORG_SCOPED in check-tenancy.ts rather than
// carrying organization_id itself. RLS for this table is the platform/global read
// policy (added with the initial migration, M1-T04).
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizationStatus } from "../enums";
import { users } from "./users";

export const organizations = pgTable(
  "organization",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    legalName: text("legal_name").notNull(),
    displayName: text("display_name").notNull(),
    status: organizationStatus("status").notNull().default("created"),
    settings: jsonb("settings").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    statusIdx: index("organization_status_idx").on(t.status),
    createdAtIdx: index("organization_created_at_idx").on(t.createdAt),
  }),
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
