// @wardenx/db — `safety_acknowledgment` (M20 §3.3 / §2.2.6). One row per act of acknowledging: an SOS, an
// incident, or an overdue check-in. This is the row that proves a human answered, which is the fact a
// workers-comp carrier, a plaintiff's counsel and a surveyor each ask for first.
//
// EXACTLY ONE TARGET, BOTH DIRECTIONS. §3.3 leaves this to "a raw constraint not expressible in the Drizzle
// DSL" — Drizzle's `check()` expresses it fine, and it needs to run in both directions: the discriminator
// `target_kind` must agree with WHICH of the three FK columns is populated. Enforcing only "exactly one is
// non-null" would let a row claim `target_kind='sos_alert'` while pointing at an incident, and the §4.3
// reader keys off the discriminator — so the acknowledgment would silently attach to the wrong alert.
//
// TENANCY: organization_id + provider_entity_id NOT NULL + location_id NULLABLE. PE is denormalized from
// whichever target the row points at, so M36's recipient resolution and the §4.3 rollups never join back
// across three possible parents under RLS.
//
// WHAT THE `action_taken` CHECK CAN SAY. §2.2.6 tiers the minimum length by the TARGET's severity (≥20 for
// warn, ≥40 for critical). Severity lives on the target row, not this one, and a CHECK cannot read another
// table — so the DB enforces the ≥20 FLOOR that applies to every acknowledgment, and the severity-tiered
// ≥40 is the acknowledger service's (M20-T03). The floor is the half that matters here: it is what stops
// "ok" from being a valid answer to a 3 a.m. SOS.
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { safetyAcknowledgmentTargetKind } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { safetyCheckInSchedule } from "./safety-check-ins";
import { safetyIncident } from "./safety-incidents";
import { safetySosAlert } from "./safety-sos-alerts";

export const safetyAcknowledgment = pgTable(
  "safety_acknowledgment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    targetKind: safetyAcknowledgmentTargetKind("target_kind").notNull(),
    sosAlertId: uuid("sos_alert_id").references(() => safetySosAlert.id, { onDelete: "restrict" }),
    incidentId: uuid("incident_id").references(() => safetyIncident.id, { onDelete: "restrict" }),
    overdueCheckInScheduleId: uuid("overdue_check_in_schedule_id").references(
      () => safetyCheckInSchedule.id,
      { onDelete: "restrict" },
    ),

    acknowledgedByMembershipId: uuid("acknowledged_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),

    /** Free text — §3.6 audit-denylisted. The ≥20 floor is a CHECK; the severity-tiered ≥40 is the
     *  acknowledger service's (see the header). */
    actionTaken: text("action_taken").notNull(),
    /** `SafetyAcknowledgmentOutcome` — vocabulary CHECK below. */
    outcome: text("outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // §3.4 — the SOS history-of-acknowledgments read. One index per target, because a three-column
    // composite over two NULLs never serves the query the spec's `sack_target_idx` was written for.
    bySosIdx: index("sack_sos_idx")
      .on(t.sosAlertId, t.acknowledgedAt.desc())
      .where(sql`sos_alert_id IS NOT NULL`),
    byIncidentIdx: index("sack_incident_idx")
      .on(t.incidentId, t.acknowledgedAt.desc())
      .where(sql`incident_id IS NOT NULL`),
    byScheduleIdx: index("sack_schedule_idx")
      .on(t.overdueCheckInScheduleId, t.acknowledgedAt.desc())
      .where(sql`overdue_check_in_schedule_id IS NOT NULL`),
    byActorIdx: index("sack_actor_idx").on(t.acknowledgedByMembershipId, t.acknowledgedAt.desc()),

    // §2.2.6 — exactly one target, and the discriminator agrees with it. Both directions; see the header.
    exactlyOneTarget: check(
      "m20_sack_one_target",
      sql`("target_kind" = 'sos_alert' AND "sos_alert_id" IS NOT NULL AND "incident_id" IS NULL AND "overdue_check_in_schedule_id" IS NULL)
          OR ("target_kind" = 'incident' AND "incident_id" IS NOT NULL AND "sos_alert_id" IS NULL AND "overdue_check_in_schedule_id" IS NULL)
          OR ("target_kind" = 'overdue_check_in' AND "overdue_check_in_schedule_id" IS NOT NULL AND "sos_alert_id" IS NULL AND "incident_id" IS NULL)`,
    ),
    actionTakenFloor: check(
      "m20_sack_action_taken",
      sql`length(btrim("action_taken")) >= 20`,
    ),
    outcomeVocabulary: check(
      "m20_sack_outcome_vocab",
      sql`"outcome" IS NULL
          OR "outcome" IN ('reached_clinician_by_phone','dispatched_supervisor','911_called','no_action_needed','other')`,
    ),
  }),
);

export type SafetyAcknowledgmentRow = typeof safetyAcknowledgment.$inferSelect;
export type NewSafetyAcknowledgmentRow = typeof safetyAcknowledgment.$inferInsert;
