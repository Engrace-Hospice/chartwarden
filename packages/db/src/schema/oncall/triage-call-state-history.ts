// @chartwarden/db — `triage_call_state_history` (M19 §3.3). APPEND-ONLY, one row per §2.2.1 transition
// (M17's `visit_state_history` pattern). Two things depend on it beyond the audit story: §2.7's outage
// detection finds the BCP window by looking for the gap where no transitions occurred, and the §8.3
// repudiation control is exactly "every state change names an actor".
//
// `command_payload_digest` is a HASH, not the command. The command that moves a call to
// `disposition_pending` carries clinician prose; storing it here would create a second, unscrubbed copy of
// text the §3.6 denylist already protects on `triage_call`. The digest still proves the same command
// produced the same transition.
//
// GRANTS: wardenx_app gets SELECT + INSERT only (migration 0108). Append-only is enforced by the absent
// UPDATE/DELETE grant, not by convention.
import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { triageCallState } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { triageCall } from "./triage-calls";

export const triageCallStateHistory = pgTable(
  "triage_call_state_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    triageCallId: uuid("triage_call_id")
      .notNull()
      .references(() => triageCall.id, { onDelete: "restrict" }),

    /** NULL on the row that records the call's creation. */
    fromState: triageCallState("from_state"),
    toState: triageCallState("to_state").notNull(),
    transitionedAt: timestamp("transitioned_at", { withTimezone: true }).notNull().defaultNow(),

    actorMembershipId: uuid("actor_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
    /** TRUE for the cron/consumer transitions (shift close, `m8.encounter.signed`, SLA timeout). */
    systemActor: boolean("system_actor").notNull().default(false),
    /** §4.8 `awaiting-callback-timeout.cron` — TRUE when the transition is the grace-window timeout, not a
     *  person's or another system event's. */
    autoTimeout: boolean("auto_timeout").notNull().default(false),
    /** Hash of the command payload; the cleartext is not stored here. */
    commandPayloadDigest: text("command_payload_digest"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCallIdx: index("triage_call_state_history_call_idx").on(t.triageCallId, t.transitionedAt),
    // §2.7 — the outage-window detector scans org-wide for the gap where nothing transitioned.
    byOrgTimeIdx: index("triage_call_state_history_org_time_idx").on(
      t.organizationId,
      t.transitionedAt,
    ),

    // §8.3 (repudiation) — a transition is either a named person's or explicitly the system's. An
    // unattributed row is the one shape from which "who moved this call" has no answer.
    transitionIsAttributed: check(
      "m19_triage_call_state_history_actor",
      sql`"system_actor" = true OR "actor_membership_id" IS NOT NULL`,
    ),
    // A row whose from- and to-state are equal records nothing and dilutes the §2.7 gap scan.
    stateActuallyChanged: check(
      "m19_triage_call_state_history_changed",
      sql`"from_state" IS NULL OR "from_state" <> "to_state"`,
    ),
  }),
);

export type TriageCallStateHistoryRow = typeof triageCallStateHistory.$inferSelect;
export type NewTriageCallStateHistoryRow = typeof triageCallStateHistory.$inferInsert;
