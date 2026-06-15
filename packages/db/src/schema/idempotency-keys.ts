// @wardenx/db — `idempotency_key` (M1 Foundation §3.10). Stores the cached response
// for an idempotent mutation, keyed per (organization, key). HELPER-ONLY: written
// exclusively by the packages/shared idempotency middleware — never a direct
// insert/select from a feature module (HELPER_ONLY_TABLES, manifest). org-scoped:
// carries organization_id (no PHI columns → three-column PE/location not required).
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const idempotencyKeys = pgTable(
  "idempotency_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: text("response_status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    orgKeyUniqueIdx: uniqueIndex("idempotency_org_key_idx").on(t.organizationId, t.key),
    expiresIdx: index("idempotency_expires_idx").on(t.expiresAt),
  }),
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;
