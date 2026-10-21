// @chartwarden/db — `external_grief_resource` (M40; migration 0463, GAP-158). The grief-counseling referral catalog
// M16 references and M31's bereaved portal lists. TENANT-CURATED: organization_id NOT NULL, RLS on app.org_id.
// Reference data, no PHI. A row retires with `is_active = false` (never deleted: referral history points at it).
import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

/** CHECK-constrained in the migration (text, not a pgEnum, so a new kind is a one-line CHECK edit). */
export const EXTERNAL_GRIEF_RESOURCE_KINDS = [
  "community_group",
  "pastoral_care",
  "child_camp",
  "specialist_registry",
  "hotline",
  "other",
] as const;

export const externalGriefResources = pgTable(
  "external_grief_resource",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    resourceKind: text("resource_kind")
      .$type<(typeof EXTERNAL_GRIEF_RESOURCE_KINDS)[number]>()
      .notNull(),
    url: text("url"),
    phone: text("phone"),
    description: text("description"),
    audience: text("audience"),
    isActive: boolean("is_active").notNull().default(true),
    createdByMembershipId: uuid("created_by_membership_id"),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("external_grief_resource_org_idx").on(t.organizationId, t.isActive, t.name),
  }),
);

export type ExternalGriefResourceRow = typeof externalGriefResources.$inferSelect;
export type NewExternalGriefResourceRow = typeof externalGriefResources.$inferInsert;
