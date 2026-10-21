// @chartwarden/db — `organization_slug_alias` (M1, ADR-0049 D3). Every slug an organization has ever
// had, kept forever so a slug is never reused and an old host redirects to the current one. Written
// only by the rename trigger on `organization` (migration 1144); the app role can read its own rows.
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const organizationSlugAliases = pgTable(
  "organization_slug_alias",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    alias: text("alias").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    organizationIdx: index("organization_slug_alias_org_idx").on(t.organizationId),
  }),
);

export type OrganizationSlugAlias = typeof organizationSlugAliases.$inferSelect;
