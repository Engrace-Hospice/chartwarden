// @wardenx/db — `evv_geofence_policy` (M18 §3.3 / §2.2.2 D3). The three-layer geofence policy with strict
// precedence: platform floor (seeded scope='platform', radius_m=200, max_accuracy_m=50) → tenant default →
// per-address override (requires override_reason ≥30 chars, DENYLISTED §3.6). Tenant-scoped configuration
// data, NOT patient-scoped (the `patient_address_id` column carries no `patient_id`/PHI signal, so the
// three-column rule does not apply — only org-scope). Retained for the life of the tenant. RLS + grants + M4
// write-audit trigger land in the RLS migration (M18-T02 / 0047).
import { bigint, date, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { evvGeofencePolicyScope } from "../../enums";
import { organizations } from "../organizations";
import { memberships } from "../memberships";

export const evvGeofencePolicy = pgTable(
  "evv_geofence_policy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    scope: evvGeofencePolicyScope("scope").notNull(),
    patientAddressId: uuid("patient_address_id"), // non-null only when scope='patient_address'

    radiusM: integer("radius_m").notNull(), // 50..1000 (platform floor ≥50)
    maxAccuracyM: integer("max_accuracy_m").notNull(), // 5..100

    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"), // NULL = currently active

    overrideReason: text("override_reason"), // ≥30 chars for patient_address scope; DENYLISTED (§3.6)
    setByMembershipId: uuid("set_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),

    version: bigint("version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The geofence-policy resolver hot path (§3.4): one active policy row per (scope, address).
    orgScopeActive: index("evv_geofence_policy_org_scope_active_idx")
      .on(t.organizationId, t.scope, t.patientAddressId, t.effectiveFrom)
      .where(sql`effective_to IS NULL`),
  }),
);

export type EvvGeofencePolicy = typeof evvGeofencePolicy.$inferSelect;
export type NewEvvGeofencePolicy = typeof evvGeofencePolicy.$inferInsert;
