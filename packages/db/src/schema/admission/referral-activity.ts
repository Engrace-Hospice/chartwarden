import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { referrals } from "./referrals";

export const referralActivities = pgTable(
  "referral_activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    referralId: uuid("referral_id")
      .notNull()
      .references(() => referrals.id, { onDelete: "restrict" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    referralCreatedIdx: index("referral_activity_referral_created_idx").on(
      t.referralId,
      t.createdAt,
    ),
    orgCreatedIdx: index("referral_activity_org_created_idx").on(t.organizationId, t.createdAt),
  }),
);

export type ReferralActivity = typeof referralActivities.$inferSelect;
export type NewReferralActivity = typeof referralActivities.$inferInsert;
