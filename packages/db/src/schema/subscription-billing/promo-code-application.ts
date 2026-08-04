import { sql } from "drizzle-orm";
// @wardenx/db — `promo_code_application` (M35 §3.3). TENANT-SCOPED, RLS on app.org_id (0143).
// `organization_id` + `applied_by_membership_id` are logical uuids (M35-F04); `subscription_id` and
// `promo_code_id` are REAL FKs.
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { promoCode } from "./promo-code";
import { subscriptionRow } from "./subscription";

export const promoCodeApplication = pgTable(
  "promo_code_application",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptionRow.id, { onDelete: "restrict" }),
    promoCodeId: uuid("promo_code_id")
      .notNull()
      .references(() => promoCode.id, { onDelete: "restrict" }),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    appliedByMembershipId: uuid("applied_by_membership_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    m4AuditEventId: uuid("m4_audit_event_id"),
  },
  (t) => ({
    subActiveUq: uniqueIndex("promo_code_application_sub_active_uq")
      .on(t.subscriptionId, t.promoCodeId)
      .where(sql`revoked_at IS NULL`),
  }),
);

export type PromoCodeApplicationRow = typeof promoCodeApplication.$inferSelect;
export type NewPromoCodeApplicationRow = typeof promoCodeApplication.$inferInsert;
