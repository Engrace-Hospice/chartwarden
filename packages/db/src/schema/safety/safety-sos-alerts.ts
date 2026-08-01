// @wardenx/db — `safety_sos_alert` + `safety_sos_location_stream` + `safety_sos_alert_state_history`
// (M20 §3.3 / §2.2.2, D5/D6/D7). The SOS spine: one row per press, immutable in its identifying facts once
// the cancel window expires, with every lifecycle move appended to the state-history ledger for replay.
//
// THE PRESS IS NOT IDEMPOTENT AND THAT IS THE POINT (§2.6). Every press writes a row. The FAN-OUT is
// idempotent on the outbox `event_id`, so a redelivered alert does not page twice — but a second press is
// a second call for help and the schema must never collapse it into the first. There is deliberately NO
// unique key on (membership, posted_at) or anything like it.
//
// `emergency_terminus` IS AN OPEN STATE. §2.2.2 / M20-F05 / S13 / INT-031 make it the mandated END of the
// life-safety chain — a tier-3 SLA breach with no acknowledgment enters it, and it auto-dials the consented
// emergency contact, surfaces M40's PSAP number to every recipient, pages WardenX ops, and KEEPS
// re-escalating until a human acknowledges. So the SLA-watchdog index below INCLUDES it: an index scoped to
// the three tier states would leave the terminus unscanned, which is precisely how an unacknowledged 3 a.m.
// SOS stops re-escalating.
//
// TENANCY: organization_id + provider_entity_id NOT NULL + location_id NULLABLE on all three. PE is on the
// alert already (§3.3 puts it there for M36 routing) and is DENORMALIZED onto the two children — the M16
// posture — so the §4.3 seam rollups and the M36 recipient resolution never have to join back to the parent
// under RLS. Location is nullable: an SOS is raised wherever the clinician is, which is frequently not a
// Location the org has on file.
//
// COORDINATES ARE REQUIRED HERE, unlike a routine check-in (D6/D11): the location at the moment of the press
// is the single most useful fact a responder has. `coordinates_consent_at` is NOT NULL alongside it, so the
// consent instant is always replayable — but M20-F16 is the boundary: declining `sos_coordinates` consent
// does NOT disable SOS, it means that clinician's presses never reach this table's coordinate columns
// because the recorder writes a coordinate-free alert through the same path with the cipher holding a
// sentinel. The alert always fans out. That is the recorder's contract (M20-T03), not this table's.
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { safetySosCancelStatus, safetySosLifecycleState } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { safetyPolicyVersion } from "./safety-policy";

/** Envelope-encrypted payload under the tenant DEK, stored as PostgreSQL bytea. */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const safetySosAlert = pgTable(
  "safety_sos_alert",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    postedByMembershipId: uuid("posted_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    /** M2 logical FK. ADVISORY per §2.2.2 — an SOS from a non-attested device still records and still
     *  fans out; the attestation is a forensics signal, never a gate on life safety. */
    postedViaDeviceId: uuid("posted_via_device_id"),

    /** M17 / M5 logical FKs — the last context M20 knew about when the button was pressed. */
    lastKnownVisitId: uuid("last_known_visit_id"),
    lastKnownPatientId: uuid("last_known_patient_id"),

    postedCoordinatesCipher: bytea("posted_coordinates_cipher").notNull(),
    postedCoordinatesAccuracyM: integer("posted_coordinates_accuracy_m").notNull(),
    coordinatesConsentAt: timestamp("coordinates_consent_at", { withTimezone: true }).notNull(),

    /** D5 — `posted_at + policy.sos_cancel_window_seconds`, stamped on insert. The cancel route refuses
     *  any cancel after this instant with 422 CANCEL_WINDOW_EXPIRED. */
    cancelWindowExpiredAt: timestamp("cancel_window_expired_at", { withTimezone: true }).notNull(),
    cancelStatus: safetySosCancelStatus("cancel_status").notNull().default("not_cancelled"),
    cancelAttemptedAt: timestamp("cancel_attempted_at", { withTimezone: true }),
    /** `passed` | `failed` | `not_required` — §3.3 spells it `text`; the vocabulary is a CHECK below
     *  (`SafetySosCancelBiometricResult` in @wardenx/types). `not_required` is the tenant-policy case and
     *  is NOT a pass: a forensics read has to tell them apart. */
    cancelBiometricResult: text("cancel_biometric_result"),

    lifecycleState: safetySosLifecycleState("lifecycle_state").notNull().default("raised"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedByMembershipId: uuid("acknowledged_by_membership_id").references(
      () => memberships.id,
      { onDelete: "restrict" },
    ),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByMembershipId: uuid("resolved_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
    /** Free text under the tenant DEK — §3.6 audit-denylisted. */
    resolutionNarrativeCipher: bytea("resolution_narrative_cipher"),
    /** `SafetySosOutcome` — vocabulary CHECK below. */
    outcome: text("outcome"),

    /** FK added by ALTER once `safety_incident` exists. */
    linkedIncidentId: uuid("linked_incident_id"),

    safetyPolicyVersionId: uuid("safety_policy_version_id")
      .notNull()
      .references(() => safetyPolicyVersion.id, { onDelete: "restrict" }),
    /** WHO was actually paged, encrypted — §3.6 audit-denylisted (it names people, at scale). */
    acknowledgerDispatchPayloadCipher: bytea("acknowledger_dispatch_payload_cipher"),

    /** §2.5 optimistic concurrency; a stale lifecycle write returns 409 STALE_LIFECYCLE_STATE. */
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgActiveIdx: index("ssa_org_active_idx")
      .on(t.organizationId, t.postedAt.desc())
      .where(sql`lifecycle_state NOT IN ('resolved','cancelled_in_window','incident_opened')`),
    byPostedByIdx: index("ssa_posted_by_idx").on(t.postedByMembershipId, t.postedAt.desc()),
    // §3.4 — the SLA watchdog's hot path (every 15 seconds). `emergency_terminus` is IN the predicate;
    // see the header. `acknowledging` is where the fan-out starts and the tier ladder begins.
    bySlaScanIdx: index("ssa_sla_scan_idx")
      .on(t.organizationId, t.lifecycleState)
      .where(
        sql`lifecycle_state IN ('acknowledging','escalation_tier_1','escalation_tier_2','escalation_tier_3','emergency_terminus')`,
      ),

    // D5 — the window is a real window, and it opens at the press.
    cancelWindowAfterPress: check(
      "m20_ssa_cancel_window",
      sql`"cancel_window_expired_at" > "posted_at"`,
    ),
    accuracyNonNegative: check(
      "m20_ssa_accuracy",
      sql`"posted_coordinates_accuracy_m" >= 0`,
    ),
    // §3.3 vocabularies the spec spells inline on `text` columns.
    biometricVocabulary: check(
      "m20_ssa_biometric_vocab",
      sql`"cancel_biometric_result" IS NULL
          OR "cancel_biometric_result" IN ('passed','failed','not_required')`,
    ),
    outcomeVocabulary: check(
      "m20_ssa_outcome_vocab",
      sql`"outcome" IS NULL
          OR "outcome" IN ('no_action_needed','clinician_safe_continued','visit_cancelled','incident_opened','911_called','other')`,
    ),
    // D5 — a cancel that was attempted has an instant and a biometric verdict; one that was not, has
    // neither. Without both directions a `cancelled_in_window` row can claim a cancel nobody made.
    cancelAttemptPair: check(
      "m20_ssa_cancel_attempt",
      sql`("cancel_status" = 'not_cancelled' AND "cancel_attempted_at" IS NULL AND "cancel_biometric_result" IS NULL)
          OR ("cancel_status" <> 'not_cancelled' AND "cancel_attempted_at" IS NOT NULL AND "cancel_biometric_result" IS NOT NULL)`,
    ),
    // §2.2.2 — the cancel row and the lifecycle row cannot disagree about whether the alert stood down.
    // `cancel_attempted_but_rejected` deliberately does NOT pin the lifecycle: the alert PROCEEDS as if
    // no cancel happened, so it may be in any downstream state.
    cancelLifecycleAgreement: check(
      "m20_ssa_cancel_lifecycle",
      sql`("cancel_status" = 'cancelled_in_window') = ("lifecycle_state" = 'cancelled_in_window')`,
    ),
    // A state that names an actor carries the actor and the instant, or the §4.3 reader cannot say who
    // answered at 3 a.m. — which is the whole evidentiary point of the row.
    acknowledgedStamped: check(
      "m20_ssa_ack_stamped",
      sql`"lifecycle_state" NOT IN ('acknowledged','resolving','resolved')
          OR ("acknowledged_at" IS NOT NULL AND "acknowledged_by_membership_id" IS NOT NULL)`,
    ),
    resolvedStamped: check(
      "m20_ssa_resolved_stamped",
      sql`"lifecycle_state" <> 'resolved'
          OR ("resolved_at" IS NOT NULL AND "resolved_by_membership_id" IS NOT NULL AND "outcome" IS NOT NULL)`,
    ),
    incidentOpenedLinked: check(
      "m20_ssa_incident_linked",
      sql`"lifecycle_state" <> 'incident_opened' OR "linked_incident_id" IS NOT NULL`,
    ),
  }),
);

export const safetySosLocationStream = pgTable(
  "safety_sos_location_stream",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    sosAlertId: uuid("sos_alert_id")
      .notNull()
      .references(() => safetySosAlert.id, { onDelete: "restrict" }),
    sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull().defaultNow(),
    coordinatesCipher: bytea("coordinates_cipher").notNull(),
    accuracyM: integer("accuracy_m").notNull(),
    /** Battery, signal strength, motion — §3.6 audit-denylisted (telemetry is not auditable content). */
    deviceTelemetry: jsonb("device_telemetry"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAlertSampledIdx: index("ssls_alert_sampled_idx").on(t.sosAlertId, t.sampledAt),
    // §3.7 — the "SOS resolved + 90 days" physical-delete sweep.
    byOrgSampledIdx: index("ssls_org_sampled_idx").on(t.organizationId, t.sampledAt),
    accuracyNonNegative: check("m20_ssls_accuracy", sql`"accuracy_m" >= 0`),
  }),
);

export const safetySosAlertStateHistory = pgTable(
  "safety_sos_alert_state_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    sosAlertId: uuid("sos_alert_id")
      .notNull()
      .references(() => safetySosAlert.id, { onDelete: "restrict" }),
    /** NULL on the row that records the press itself (there is no state to come from). */
    fromState: safetySosLifecycleState("from_state"),
    toState: safetySosLifecycleState("to_state").notNull(),
    transitionedAt: timestamp("transitioned_at", { withTimezone: true }).notNull().defaultNow(),
    /** NULL when the watchdog moved it — a tier advance has no human actor, and inventing one would
     *  make the ledger claim a supervisor acted when nobody did. */
    transitionedByMembershipId: uuid("transitioned_by_membership_id").references(
      () => memberships.id,
      { onDelete: "restrict" },
    ),
    /** Free text — §3.6 audit-denylisted. */
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAlertIdx: index("ssash_alert_idx").on(t.sosAlertId, t.transitionedAt),
    noSelfTransition: check(
      "m20_ssash_no_self",
      sql`"from_state" IS NULL OR "from_state" <> "to_state"`,
    ),
  }),
);

export type SafetySosAlertRow = typeof safetySosAlert.$inferSelect;
export type NewSafetySosAlertRow = typeof safetySosAlert.$inferInsert;
export type SafetySosLocationStreamRow = typeof safetySosLocationStream.$inferSelect;
export type NewSafetySosLocationStreamRow = typeof safetySosLocationStream.$inferInsert;
export type SafetySosAlertStateHistoryRow = typeof safetySosAlertStateHistory.$inferSelect;
export type NewSafetySosAlertStateHistoryRow = typeof safetySosAlertStateHistory.$inferInsert;
