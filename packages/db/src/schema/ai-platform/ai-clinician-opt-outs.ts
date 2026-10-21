// @chartwarden/db — `ai_clinician_opt_out` (M32 §3.2.7 / §5.4). The individual clinician's refusal: even
// where the tenant has opted in, this person's work is not run through this capability.
//
// TENANT-SCOPED: organization_id NOT NULL, RLS keyed ONLY on app.org_id (0116). The row is keyed on the
// MEMBERSHIP, not the user, because the same human working for two agencies may reasonably decide
// differently for each — and a user-keyed row would leak one tenant's decision into the other.
//
// THE UNIQUE INDEX IS PARTIAL AND IT MATTERS: `WHERE opted_out = true AND reverted_at IS NULL` means
// "one LIVE opt-out per (membership, capability)" while leaving the reverted history unconstrained. An
// unconditional unique index would force a clinician who opts out, reverts, and opts out again to
// overwrite the record of the first refusal — which is the record that explains why their notes for
// three months carry no AI provenance.
//
// `reason` is the clinician's own words and is §3.4-denylisted out of the audit capture: it is a
// statement about their practice, frequently about a specific patient interaction, and the audit ledger
// is not where it belongs.
import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { aiCapability } from "./ai-capabilities";

export const aiClinicianOptOut = pgTable(
  "ai_clinician_opt_out",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** Logical FK → M2 membership (see header: membership-keyed, not user-keyed). */
    membershipId: uuid("membership_id").notNull(),
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => aiCapability.id, { onDelete: "restrict" }),

    optedOut: boolean("opted_out").notNull().default(true),
    /** The clinician's own words. §3.4-denylisted. */
    reason: text("reason"),

    optedOutAt: timestamp("opted_out_at", { withTimezone: true }).notNull().defaultNow(),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One LIVE opt-out per (membership, capability); history unconstrained (see header).
    memberCapabilityIdx: uniqueIndex("ai_clin_optout_member_cap_idx")
      .on(t.membershipId, t.capabilityId)
      .where(sql`opted_out = true AND reverted_at IS NULL`),
  }),
);

export type AiClinicianOptOutRow = typeof aiClinicianOptOut.$inferSelect;
export type NewAiClinicianOptOutRow = typeof aiClinicianOptOut.$inferInsert;
