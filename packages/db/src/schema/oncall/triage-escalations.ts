// @wardenx/db — `triage_escalation` (M19 §3.3 / §2.2.4). D7: the escalation ladder's row. Three of the
// four trigger kinds are written by the SERVER, not by a human — `red_flag_question` (D5),
// `mandatory_protocol` (the four platform-locked protocols) and `sla_breach` (the §4.8 callback detector)
// — which is why a tenant cannot configure any of them away.
//
// §7.2 — the mandatory case: applying a `requires_mandatory_escalation` protocol writes this row in the
// SAME transaction as the protocol application. There is no code path that applies the protocol without
// it, and §2.2.4 forbids a call close from auto-resolving a mandatory row: it needs an explicit
// `resolveEscalation(resolution)` write by the escalated party.
//
// §3.6 DENYLIST: `trigger_detail` and `resolution` — both are clinician prose about a person in crisis.
// The TIER and the trigger KIND are not denylisted: they are the structure a suppression investigation
// reads, and they name a role, not a patient.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { triageEscalationTier, triageEscalationTrigger } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { externalTriageVendor } from "./external-triage-vendors";
import { triageCall } from "./triage-calls";

export const triageEscalation = pgTable(
  "triage_escalation",
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

    tier: triageEscalationTier("tier").notNull(),
    triggerKind: triageEscalationTrigger("trigger_kind").notNull(),
    /** DENYLISTED (§3.6). */
    triggerDetail: text("trigger_detail"),

    escalatedToMembershipId: uuid("escalated_to_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
    escalatedToExternalActorId: uuid("escalated_to_external_actor_id").references(
      () => externalTriageVendor.id,
      { onDelete: "restrict" },
    ),

    escalatedAt: timestamp("escalated_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    /** DENYLISTED (§3.6). */
    resolution: text("resolution"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByMembershipId: uuid("resolved_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),

    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCallIdx: index("triage_escalation_call_idx").on(t.triageCallId, t.tier),
    // §3.4 — the escalation inbox: the tier-filtered open queue.
    openByTierIdx: index("triage_escalation_open_tier_idx")
      .on(t.organizationId, t.tier)
      .where(sql`resolved_at IS NULL`),

    // §3.3 — exactly one recipient kind, decided by the tier. `tier_5_external` is the only vendor tier.
    recipientIntegrity: check(
      "m19_triage_escalation_recipient",
      sql`("tier" = 'tier_5_external' AND "escalated_to_external_actor_id" IS NOT NULL AND "escalated_to_membership_id" IS NULL)
          OR ("tier" <> 'tier_5_external' AND "escalated_to_membership_id" IS NOT NULL AND "escalated_to_external_actor_id" IS NULL)`,
    ),
    // §2.2.4 — open → acknowledged → resolved. A row resolved without ever being acknowledged means
    // nobody answered the page and someone closed the record anyway.
    acknowledgedBeforeResolved: check(
      "m19_triage_escalation_ack_before_resolve",
      sql`"resolved_at" IS NULL OR "acknowledged_at" IS NOT NULL`,
    ),
    // NO `resolved_at ⇒ resolved_by_membership_id IS NOT NULL` companion, deliberately: §2.2.4's
    // auto-resolve-on-call-close is a SYSTEM write with no membership behind it, and a CHECK demanding one
    // would either block that path or push it to invent an actor. Attribution for the system case lives in
    // the M4 audit row (actor_kind), where a fabricated membership id would be worse than none.
  }),
);

export type TriageEscalationRow = typeof triageEscalation.$inferSelect;
export type NewTriageEscalationRow = typeof triageEscalation.$inferInsert;
