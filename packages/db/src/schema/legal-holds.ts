// @wardenx/db — `legal_hold` (M4 Audit §3.5, §2.4.3). A legal hold suspends destruction
// for the records its `criteria` match; it is active until released and has supremacy over
// retention-driven destruction (§10.6). Org-scoped on organization_id (standard app.org_id
// RLS lands in M4-T05); not a PHI table itself — `criteria` carries only references/filters,
// so the PE/location columns do not apply (mirrors break_glass_event).
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { legalHoldStatus } from "../enums";
import { organizations } from "./organizations";
import { users } from "./users";

export const legalHolds = pgTable(
  "legal_hold",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    criteria: jsonb("criteria").notNull(), // scope filter: patient refs, date range, resource kinds, ...
    status: legalHoldStatus("status").notNull().default("active"),
    reason: text("reason").notNull(),
    appliedBy: uuid("applied_by").references(() => users.id),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (t) => ({
    orgIdx: index("legal_hold_org_idx").on(t.organizationId),
  }),
);

export type LegalHold = typeof legalHolds.$inferSelect;
export type NewLegalHold = typeof legalHolds.$inferInsert;
