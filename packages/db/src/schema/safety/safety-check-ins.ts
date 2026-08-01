// @wardenx/db — `safety_check_in_schedule` + `safety_check_in` (M20 §3.3 / §2.2.1, D2/D3/D4). The
// OBLIGATION and the EVENT, deliberately two tables: the schedule row is what the overdue detector scans
// and escalates, the check-in row is the clinician's own attestation and is append-only after the 5-minute
// amendment grace (a correction is a new row with `corrects_check_in_id`, and the original flips to
// `superseded` in the same transaction).
//
// M20-F04 — the schedule's uniqueness key is (visit_id, kind, expected_at), NOT (visit_id, kind). A
// 90–120-minute visit materializes SEVERAL `mid_visit` cadence rows (D3/§7.1), which the two-column key
// forbade outright — a core feature was unbuildable. It also matches the declared §2.6 idempotency key, so
// re-running the materializer for a visit that already has its schedule is the no-op §2.6 promises.
//
// TENANCY: organization_id + provider_entity_id NOT NULL + location_id NULLABLE. Both rows are joinable to
// a visit and therefore to a served person, so the three-column rule applies (architecture supplies it;
// the §3.3 block omits it). Location is nullable because an `ad_hoc` or `between_visits` check-in has no
// visit to resolve one from.
//
// COORDINATES ARE OFF BY DEFAULT (D11). `posted_coordinates_cipher` is NULL on a routine check-in — M20
// captures a location only when the clinician has consented and the tenant has asked for it. The CHECK
// below makes the three coordinate columns move together: a cipher with no accuracy is unusable evidence,
// and a cipher with no `coordinates_consent_at` is a location captured without a consent instant to
// replay, which is exactly what §8.7 exists to prevent.
//
// RETENTION (§3.7) is row-CONDITIONAL here and the M4 trigger is per-TABLE, so the trigger stamps the
// SAFER class (`compliance`) for every row and the routine-purge lives in an M20 cron that can see the
// row: `is_part_of_sos_bracket = false AND status = 'ok'`. Stamping `operational` would let the 90-day
// purge take the check-ins that BRACKET an SOS — the workers-comp timeline §1.1 exists to preserve.
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { safetyCheckInKind, safetyCheckInState, safetyCheckInStatus } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { safetyPolicyVersion } from "./safety-policy";

/** Envelope-encrypted coordinate payload under the tenant DEK, stored as PostgreSQL bytea. */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const safetyCheckInSchedule = pgTable(
  "safety_check_in_schedule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    /** M17 logical FK — validated at the write boundary through M17's `VisitReader`, never a SQL FK. */
    visitId: uuid("visit_id"),
    clinicianMembershipId: uuid("clinician_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),

    kind: safetyCheckInKind("kind").notNull(),
    expectedAt: timestamp("expected_at", { withTimezone: true }).notNull(),
    /** `expected_at` ± this many minutes is the fulfilment window. */
    windowMinutes: integer("window_minutes").notNull(),
    state: safetyCheckInState("state").notNull().default("proposed"),

    /** FK added by ALTER once `safety_check_in` exists (the two tables reference each other). */
    fulfilledByCheckInId: uuid("fulfilled_by_check_in_id"),
    overdueDetectedAt: timestamp("overdue_detected_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),

    /** The §2.2.4 snapshot: the cadence and tier thresholds in force when this obligation was made. */
    safetyPolicyVersionId: uuid("safety_policy_version_id")
      .notNull()
      .references(() => safetyPolicyVersion.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // M20-F04 — expected_at is IN the key; see the header.
    visitKindExpectedUniq: uniqueIndex("scis_visit_kind_expected_uniq")
      .on(t.visitId, t.kind, t.expectedAt)
      .where(sql`visit_id IS NOT NULL`),
    clinicianExpectedIdx: index("scis_clinician_expected_idx").on(
      t.clinicianMembershipId,
      t.expectedAt,
    ),
    // §3.4 — the overdue detector's hot path (every 30 seconds, per tenant).
    overdueScanIdx: index("scis_overdue_scan_idx")
      .on(t.organizationId, t.state, t.expectedAt)
      .where(sql`state IN ('proposed','overdue')`),

    windowPositive: check("m20_scis_window_positive", sql`"window_minutes" > 0`),
    // §2.2.1 — the three visit-bracketing kinds cannot exist without the visit they bracket.
    visitKindRequiresVisit: check(
      "m20_scis_visit_kind",
      sql`("kind" IN ('pre_visit','mid_visit','post_visit') AND "visit_id" IS NOT NULL)
          OR "kind" IN ('between_visits','ad_hoc')`,
    ),
    // A state the detector reached carries the instant it reached it, or the §4.2 dashboard cannot tell
    // "overdue since 14:05" from "overdue, unknown when".
    overdueStamped: check(
      "m20_scis_overdue_stamped",
      sql`"state" NOT IN ('overdue','escalated') OR "overdue_detected_at" IS NOT NULL`,
    ),
    escalatedStamped: check(
      "m20_scis_escalated_stamped",
      sql`"state" <> 'escalated' OR "escalated_at" IS NOT NULL`,
    ),
    // `recorded` is the state the fulfilling check-in put the schedule in; without the pointer the
    // §4.3 `SafetyCheckInProvider` badge cannot say WHICH post satisfied the obligation.
    recordedFulfilled: check(
      "m20_scis_recorded_fulfilled",
      sql`"state" <> 'recorded' OR "fulfilled_by_check_in_id" IS NOT NULL`,
    ),
  }),
);

export const safetyCheckIn = pgTable(
  "safety_check_in",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    /** NULL for `ad_hoc` — a clinician may post a check-in nobody asked for. */
    scheduleId: uuid("schedule_id").references(() => safetyCheckInSchedule.id, {
      onDelete: "restrict",
    }),
    /** M17 logical FK. */
    visitId: uuid("visit_id"),
    postedByMembershipId: uuid("posted_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),

    kind: safetyCheckInKind("kind").notNull(),
    status: safetyCheckInStatus("status").notNull(),
    /** Free text — §3.6 audit-denylisted; required ≥20 chars when `status` is not `ok`. */
    concernNote: text("concern_note"),

    /** D11 — NULL by default. Non-null only with consent; see the coordinate CHECK below. */
    postedCoordinatesCipher: bytea("posted_coordinates_cipher"),
    postedCoordinatesAccuracyM: integer("posted_coordinates_accuracy_m"),
    coordinatesConsentAt: timestamp("coordinates_consent_at", { withTimezone: true }),

    /** M2 logical FK (ADVISORY per §2.2.2 — an unattested device still records). */
    postedViaDeviceId: uuid("posted_via_device_id"),

    /** §2.2.1 correction-of-record; the chain is bounded to 3 generations by the recorder (M20-T03). */
    correctsCheckInId: uuid("corrects_check_in_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByCheckInId: uuid("superseded_by_check_in_id"),

    safetyPolicyVersionId: uuid("safety_policy_version_id")
      .notNull()
      .references(() => safetyPolicyVersion.id, { onDelete: "restrict" }),
    /** §3.7's retention router. Captured VERBATIM in the audit trail: a trail that cannot say which
     *  class a row was filed under cannot prove the purge was lawful. */
    isPartOfSosBracket: boolean("is_part_of_sos_bracket").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byMembershipPostedIdx: index("sci_membership_posted_idx").on(
      t.postedByMembershipId,
      t.postedAt.desc(),
    ),
    byVisitIdx: index("sci_visit_idx").on(t.visitId).where(sql`visit_id IS NOT NULL`),
    // §2.5 — one live post per obligation; a correction supersedes rather than duplicating.
    activeUniq: uniqueIndex("sci_active_uniq")
      .on(t.scheduleId)
      .where(sql`superseded_at IS NULL AND schedule_id IS NOT NULL`),
    // §3.7 — the routine-purge cron's scan (`operational` rows: not SOS-bracketed, status ok).
    purgeScanIdx: index("sci_purge_scan_idx")
      .on(t.organizationId, t.postedAt)
      .where(sql`is_part_of_sos_bracket = false AND status = 'ok'`),

    // §2.3 — the concern the supervisor acts on has to actually say something.
    concernNoteRequired: check(
      "m20_sci_concern_note",
      sql`"status" = 'ok' OR length(btrim("concern_note")) >= 20`,
    ),
    visitKindRequiresVisit: check(
      "m20_sci_visit_kind",
      sql`("kind" IN ('pre_visit','mid_visit','post_visit') AND "visit_id" IS NOT NULL)
          OR "kind" IN ('between_visits','ad_hoc')`,
    ),
    // D11 / §8.7 — the three coordinate columns move together, in both directions. A cipher with no
    // accuracy is unusable, and one with no consent instant is a location captured with nothing to
    // replay the consent against.
    coordinateTriple: check(
      "m20_sci_coordinate_triple",
      sql`("posted_coordinates_cipher" IS NULL
             AND "posted_coordinates_accuracy_m" IS NULL
             AND "coordinates_consent_at" IS NULL)
          OR ("posted_coordinates_cipher" IS NOT NULL
             AND "posted_coordinates_accuracy_m" IS NOT NULL
             AND "posted_coordinates_accuracy_m" >= 0
             AND "coordinates_consent_at" IS NOT NULL)`,
    ),
    // A superseded row names its successor; a live row names none. Without both directions the
    // correction chain can end in a row that says "superseded" and points nowhere.
    supersessionPair: check(
      "m20_sci_supersession_pair",
      sql`("superseded_at" IS NULL AND "superseded_by_check_in_id" IS NULL)
          OR ("superseded_at" IS NOT NULL AND "superseded_by_check_in_id" IS NOT NULL)`,
    ),
    noSelfCorrection: check(
      "m20_sci_no_self_correction",
      sql`"corrects_check_in_id" IS NULL OR "corrects_check_in_id" <> "id"`,
    ),
  }),
);

export type SafetyCheckInScheduleRow = typeof safetyCheckInSchedule.$inferSelect;
export type NewSafetyCheckInScheduleRow = typeof safetyCheckInSchedule.$inferInsert;
export type SafetyCheckInRow = typeof safetyCheckIn.$inferSelect;
export type NewSafetyCheckInRow = typeof safetyCheckIn.$inferInsert;
