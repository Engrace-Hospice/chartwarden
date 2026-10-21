// @chartwarden/db — `triage_paper_reentry_worklist` (M19 §3.3 / §2.7, added by the M19-F08 BCP amendment —
// this is the TENTH owned table the spec's §12/§13 checklists predate). DR-013/066: when the platform is
// down, after-hours calls are taken on paper. On recovery the system computes which on-call shifts
// overlapped the outage window and writes one row per shift, so the DON has a bounded, assignable list of
// "these nights are not in the record yet" rather than a hope that someone remembers.
//
// The 72-hour `expires_at` is the row's OPERATIONAL lifetime (outage end + 72 h), not its retention: the
// M4 audit of the re-entry carries the `compliance` class, because a surveyor asking "what happened during
// the outage" is asking a 7-year question.
//
// `outage_window_id` is system-generated per detected outage gap and is deliberately NOT a FK: the outage
// is inferred from the absence of `triage_call_state_history` transitions (§2.7 step 3), so there is no
// outage row to point at. It is the correlation key that groups the worklist and the M4
// `triage_paper_reentry` audit rows for one event.
import { sql } from "drizzle-orm";
import { check, index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { onCallShift } from "./on-call-shifts";
import { triageCall } from "./triage-calls";

export const triagePaperReentryWorklist = pgTable(
  "triage_paper_reentry_worklist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    /** System-generated per detected outage gap — the correlation key, not a FK (see the header). */
    outageWindowId: uuid("outage_window_id").notNull(),

    shiftId: uuid("shift_id").references(() => onCallShift.id, { onDelete: "restrict" }),
    shiftStartsAt: timestamp("shift_starts_at", { withTimezone: true }).notNull(),
    shiftEndsAt: timestamp("shift_ends_at", { withTimezone: true }).notNull(),
    assignedToMembershipId: uuid("assigned_to_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),

    /** NULL until a `paper_origin` call is linked (§2.7 step 3). */
    reenteredAt: timestamp("reentered_at", { withTimezone: true }),
    linkedTriageCallId: uuid("linked_triage_call_id").references(() => triageCall.id, {
      onDelete: "restrict",
    }),

    /** Outage end + 72 h. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgIdx: index("triage_paper_reentry_worklist_org_idx").on(t.organizationId, t.expiresAt),
    byOutageIdx: index("triage_paper_reentry_worklist_outage_idx").on(t.outageWindowId),
    // The DON's actual worklist read: what is still outstanding.
    outstandingIdx: index("triage_paper_reentry_worklist_outstanding_idx")
      .on(t.organizationId, t.expiresAt)
      .where(sql`reentered_at IS NULL`),

    // The two halves of "this night has been re-entered" move together. A `reentered_at` with no linked
    // call closes the worklist item while the night is still missing from the record.
    reentryPair: check(
      "m19_triage_paper_reentry_pair",
      sql`("reentered_at" IS NOT NULL) = ("linked_triage_call_id" IS NOT NULL)`,
    ),
    windowIntegrity: check(
      "m19_triage_paper_reentry_window",
      sql`"shift_ends_at" > "shift_starts_at"`,
    ),
  }),
);

export type TriagePaperReentryWorklistRow = typeof triagePaperReentryWorklist.$inferSelect;
export type NewTriagePaperReentryWorklistRow = typeof triagePaperReentryWorklist.$inferInsert;
