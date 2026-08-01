// @wardenx/db — `safety_incident` + `safety_incident_state_history` (M20 §3.3 / §2.2.3, D9). The formal
// report, opened either from an SOS (auto-draft) or freestanding (the clinician reports a near-miss the
// next morning), progressing through a state machine that gates supervisor sign-off before the row can be
// externalized to a workers-comp carrier or an OSHA-equivalent state filing.
//
// TENANCY: organization_id + provider_entity_id NOT NULL + location_id NULLABLE; the history child
// denormalizes both. `patient_id` is a logical M5 FK — an incident that happened during a visit names the
// served person, which is exactly why the narrative is PHI-by-content and the row's ciphers are
// audit-denylisted (§3.5/§3.6).
//
// `reopened` IS A STATE, NOT A NEW ROW (§2.2.3). New evidence about a closed incident re-enters
// `under_review` on the SAME row, because a second row would break the workers-comp timeline that is the
// thing an insurer reads.
//
// WHAT THE DATABASE CAN AND CANNOT ENFORCE, stated rather than assumed:
//   • §2.3 asks for "`narrative_cipher` ≥ 200 chars for submit" as a DB CHECK. The column holds CIPHERTEXT,
//     and no CHECK can measure the plaintext length through it. `octet_length(narrative_cipher) >= 200` is
//     the honest floor available here (AEAD ciphertext is never shorter than its plaintext, so a ≥200-char
//     narrative always clears it) — NECESSARY, not sufficient. The sufficient check is the submit service's
//     (M20-T03), which sees the plaintext.
//   • §2.2.3's "`occurred_at` ≥ now() - 30 days" is deliberately NOT a CHECK: `now()` is not IMMUTABLE and
//     PostgreSQL rejects it in a CHECK — and the rule is wrong as a hard constraint anyway, since §2.2.3
//     itself allows a delayed report with supervisor attestation. The upper bound (`occurred_at <=
//     reported_at`) IS expressible, because both are columns of the row, and it is the half that catches
//     the real error: an incident that happened in the future.
//   • D9's "cannot submit with osha_reportable=true without supervisor sign-off" IS expressible, because
//     the sign-off columns live on this row — and it is the one rule in this module a route-layer-only
//     guard would leave to a repair script to violate.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { safetyIncidentCategory, safetyIncidentSeverity, safetyIncidentState } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { safetyPolicyVersion } from "./safety-policy";
import { safetySosAlert } from "./safety-sos-alerts";

/** Envelope-encrypted free text under the tenant DEK, stored as PostgreSQL bytea. */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const safetyIncident = pgTable(
  "safety_incident",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    /** §2.2.3 — defaults to the reporter but may differ (a supervisor opening one on behalf of a
     *  clinician who is incapacitated is the case the column exists for). */
    affectedClinicianMembershipId: uuid("affected_clinician_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    reportedByMembershipId: uuid("reported_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),

    category: safetyIncidentCategory("category").notNull(),
    severity: safetyIncidentSeverity("severity").notNull(),

    /** M17 / M5 logical FKs. */
    visitId: uuid("visit_id"),
    patientId: uuid("patient_id"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    /** Free text — §3.6 audit-denylisted (it describes where a person lives). */
    locationDescription: text("location_description"),

    narrativeCipher: bytea("narrative_cipher").notNull(),
    witnessesCipher: bytea("witnesses_cipher"),

    oshaReportable: boolean("osha_reportable").notNull().default(false),
    oshaReportableSignedOffByMembershipId: uuid(
      "osha_reportable_signed_off_by_membership_id",
    ).references(() => memberships.id, { onDelete: "restrict" }),
    oshaReportableSignedOffAt: timestamp("osha_reportable_signed_off_at", { withTimezone: true }),

    workersCompClaimInitiated: boolean("workers_comp_claim_initiated").notNull().default(false),
    /** The tenant's WC vendor reference — §3.6 audit-denylisted (an external claim identifier). */
    workersCompClaimReference: text("workers_comp_claim_reference"),

    linkedSosAlertId: uuid("linked_sos_alert_id").references(() => safetySosAlert.id, {
      onDelete: "restrict",
    }),

    lifecycleState: safetyIncidentState("lifecycle_state").notNull().default("draft"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedByMembershipId: uuid("reviewed_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    actionPlanCipher: bytea("action_plan_cipher"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** Free text — §3.6 audit-denylisted. */
    reopenReason: text("reopen_reason"),

    safetyPolicyVersionId: uuid("safety_policy_version_id")
      .notNull()
      .references(() => safetyPolicyVersion.id, { onDelete: "restrict" }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgOccurredIdx: index("si_org_occurred_idx").on(t.organizationId, t.occurredAt.desc()),
    byClinicianIdx: index("si_clinician_idx").on(
      t.affectedClinicianMembershipId,
      t.occurredAt.desc(),
    ),
    // §3.4 — the compliance officer's OSHA filing queue.
    oshaScanIdx: index("si_osha_scan_idx")
      .on(t.organizationId, t.oshaReportable, t.lifecycleState)
      .where(sql`osha_reportable = true`),
    reviewQueueIdx: index("si_review_queue_idx")
      .on(t.organizationId, t.lifecycleState, t.submittedAt)
      .where(sql`lifecycle_state = 'submitted'`),

    // See the header: the half of §2.2.3's occurred_at rule a CHECK can actually express.
    occurredBeforeReported: check(
      "m20_si_occurred_before_reported",
      sql`"occurred_at" <= "reported_at"`,
    ),
    // §2.3 — the necessary (not sufficient) narrative floor; the plaintext rule is the submit service's.
    narrativeFloorOnSubmit: check(
      "m20_si_narrative_floor",
      sql`"lifecycle_state" = 'draft' OR octet_length("narrative_cipher") >= 200`,
    ),
    // D9 — the sign-off is a PAIR, and a submitted OSHA-reportable incident must carry it. This is the
    // rule §7.6 turns on: without it a route-layer guard is the only thing between an unsigned filing
    // and a state agency.
    oshaSignOffPair: check(
      "m20_si_osha_signoff_pair",
      sql`("osha_reportable_signed_off_by_membership_id" IS NULL) = ("osha_reportable_signed_off_at" IS NULL)`,
    ),
    oshaSignOffBeforeSubmit: check(
      "m20_si_osha_signoff_required",
      sql`"lifecycle_state" = 'draft'
          OR "osha_reportable" = false
          OR "osha_reportable_signed_off_at" IS NOT NULL`,
    ),
    submittedStamped: check(
      "m20_si_submitted_stamped",
      sql`"lifecycle_state" = 'draft' OR "submitted_at" IS NOT NULL`,
    ),
    reviewedPair: check(
      "m20_si_reviewed_pair",
      sql`("reviewed_by_membership_id" IS NULL) = ("reviewed_at" IS NULL)`,
    ),
    // A closed incident carries its close instant and, when it closed WITH a plan, the plan itself.
    closedStamped: check(
      "m20_si_closed_stamped",
      sql`"lifecycle_state" NOT IN ('closed_with_action_plan','closed_no_action')
          OR "closed_at" IS NOT NULL`,
    ),
    actionPlanRequired: check(
      "m20_si_action_plan_required",
      sql`"lifecycle_state" <> 'closed_with_action_plan' OR "action_plan_cipher" IS NOT NULL`,
    ),
    reopenReasonRequired: check(
      "m20_si_reopen_reason",
      sql`"lifecycle_state" <> 'reopened' OR length(btrim("reopen_reason")) >= 20`,
    ),
  }),
);

export const safetyIncidentStateHistory = pgTable(
  "safety_incident_state_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    incidentId: uuid("incident_id")
      .notNull()
      .references(() => safetyIncident.id, { onDelete: "restrict" }),
    fromState: safetyIncidentState("from_state"),
    toState: safetyIncidentState("to_state").notNull(),
    transitionedAt: timestamp("transitioned_at", { withTimezone: true }).notNull().defaultNow(),
    transitionedByMembershipId: uuid("transitioned_by_membership_id").references(
      () => memberships.id,
      { onDelete: "restrict" },
    ),
    /** Free text — §3.6 audit-denylisted. */
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byIncidentIdx: index("sish_incident_idx").on(t.incidentId, t.transitionedAt),
    noSelfTransition: check(
      "m20_sish_no_self",
      sql`"from_state" IS NULL OR "from_state" <> "to_state"`,
    ),
  }),
);

export type SafetyIncidentRow = typeof safetyIncident.$inferSelect;
export type NewSafetyIncidentRow = typeof safetyIncident.$inferInsert;
export type SafetyIncidentStateHistoryRow = typeof safetyIncidentStateHistory.$inferSelect;
export type NewSafetyIncidentStateHistoryRow = typeof safetyIncidentStateHistory.$inferInsert;
