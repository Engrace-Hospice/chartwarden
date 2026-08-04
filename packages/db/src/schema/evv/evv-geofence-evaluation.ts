// @wardenx/db — `evv_geofence_evaluation` (M18 §3.3 / §2.2.2 D3). The historical record of every geofence
// calculation: per-event Haversine distance vs the resolved three-layer policy (platform → tenant →
// patient_address). Org-scoped (no patient_id column — joinable to PHI only via evv_event_id, which is the
// derived coords source); both coordinate ciphers are DENYLISTED from audit (§3.6) to avoid re-emission. The
// `evv_event_id` ref is plain uuid (no SQL FK — `evv_event` is partitioned). RLS + grants + M4 write-audit
// trigger land in the RLS migration (M18-T02 / 0047).
import {
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { evvGeofencePolicyScope } from "../../enums";
import { organizations } from "../organizations";

export const evvGeofenceEvaluation = pgTable(
  "evv_geofence_evaluation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    evvEventId: uuid("evv_event_id").notNull(), // logical FK to evv_event (partitioned → plain uuid)

    appliedPolicyId: uuid("applied_policy_id").notNull(),
    appliedPolicyScope: evvGeofencePolicyScope("applied_policy_scope").notNull(),
    appliedRadiusM: integer("applied_radius_m").notNull(),
    appliedMaxAccuracyM: integer("applied_max_accuracy_m").notNull(),

    patientAddressCoordsCipher: text("patient_address_coords_cipher"), // baseline; DENYLISTED (§3.6)
    deviceCoordsCipher: text("device_coords_cipher").notNull(), // DENYLISTED (§3.6)
    computedDistanceM: real("computed_distance_m"),
    decision: text("decision").notNull(), // 'pass' | 'fail_distance' | 'fail_accuracy' | 'fail_no_baseline'

    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgEvent: uniqueIndex("evv_geofence_eval_event_uidx").on(t.organizationId, t.evvEventId),
    orgEvaluatedAt: index("evv_geofence_eval_org_evaluated_idx").on(
      t.organizationId,
      t.evaluatedAt,
    ),
  }),
);

export type EvvGeofenceEvaluation = typeof evvGeofenceEvaluation.$inferSelect;
export type NewEvvGeofenceEvaluation = typeof evvGeofenceEvaluation.$inferInsert;
