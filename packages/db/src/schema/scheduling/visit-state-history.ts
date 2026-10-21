// @chartwarden/db — `visit_state_history` (M17 §3.3 / D3). Append-only ledger: one row per `visit` lifecycle
// transition, written in the SAME transaction as the transition (XState side-effect). Captures from/to
// state, the actor (NULL for system-driven cron/EVV-consumer transitions), the system source tag, the
// optional outbox event that drove it, and the free-text reason (DENYLISTED §3.6). Org-scoped; the three
// tenancy columns are carried per M17-F01 (nullable here — denormalized from the parent visit, system
// inserts). The `visit_id` ref is plain uuid (the parent `visit` is RANGE-partitioned → no SQL FK, D14).
//
// PARTITION BY RANGE (transitioned_at) monthly (D14 — denser than its parent, partitioning matches): the
// Drizzle definition is the LOGICAL shape (composite PK incl. the partition key); the PARTITION BY + monthly
// children + DEFAULT catch-all land in the RLS migration (M17-T02). UPDATE/DELETE are refused at the grant
// layer (append-only). RLS + grants + the M4 write-audit trigger land in M17-T02.
import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { visitStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const visitStateHistory = pgTable(
  "visit_state_history",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with transitioned_at (the partition key, D14)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // M17-F01: tenancy columns present; nullable (denormalized from the parent visit on system inserts).
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    visitId: uuid("visit_id").notNull(), // parent visit (partitioned → no SQL FK, app-validated)

    fromState: visitStatus("from_state"), // NULL for the initial 'proposed' insert
    toState: visitStatus("to_state").notNull(),
    actorMembershipId: uuid("actor_membership_id"), // NULL for system-driven (cron, EVV consumer)
    systemSource: text("system_source"), // 'cron_propose' | 'evv_check_in' | 'encounter_signed' | ...
    reason: text("reason"), // DENYLISTED (§3.6)
    outboxEventId: uuid("outbox_event_id"), // set when the transition was triggered by an outbox event
    transitionedAt: timestamp("transitioned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.transitionedAt] }), // partition key must be in the PK (D14)
    visitTransitionedAt: index("vsh_visit_at_idx").on(t.visitId, t.transitionedAt),
  }),
);

export type VisitStateHistory = typeof visitStateHistory.$inferSelect;
export type NewVisitStateHistory = typeof visitStateHistory.$inferInsert;
