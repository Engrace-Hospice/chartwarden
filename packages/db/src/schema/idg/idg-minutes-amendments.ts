// @chartwarden/db — `idg_minutes_amendment` (M14 §3.3.1 / W-MIN-01). The append-only amendment ledger for
// finalized minutes: each row is a reason + a structured diff, with a request → approve handshake (no
// in-place mutation of `final` minutes, D10). Org-scoped child of idg_minutes. FK to the minutes (cascade)
// + the tenancy spine; actor refs (requested_by / approved_by → M1 membership) are plain uuid
// app-validated. `amendment_reason` is free-text → denylisted in the M4 write-audit trigger (§3.3). RLS +
// grants + trigger land in the RLS migration (M14-T02).
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { idgMinutes } from "./idg-minutes";

export const idgMinutesAmendment = pgTable("idg_minutes_amendment", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  idgMinutesId: uuid("idg_minutes_id")
    .notNull()
    .references(() => idgMinutes.id, { onDelete: "cascade" }),
  amendmentReason: text("amendment_reason").notNull(), // DENYLISTED
  amendmentDiff: jsonb("amendment_diff").notNull(),
  requestedByMembershipId: uuid("requested_by_membership_id").notNull(), // M1 membership (no cross-module FK)
  approvedByMembershipId: uuid("approved_by_membership_id"), // M1 membership (no cross-module FK)
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type IdgMinutesAmendment = typeof idgMinutesAmendment.$inferSelect;
export type NewIdgMinutesAmendment = typeof idgMinutesAmendment.$inferInsert;
