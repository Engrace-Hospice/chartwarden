import { sql } from "drizzle-orm";
// @wardenx/db — `evv_missing_resolution` (M18 §3.3 / §2.2.4 D6). The missing-EVV resolution state machine
// (open → closed_clinician_attested | closed_supervisor_override | closed_visit_voided |
// closed_documented_at_encounter | closed_system_checkout_received). `documented_missing` is allowed and is
// never a Medicare claim gate (ADR-0008); only `unresolved_missing` (a still-`open` row) blocks downstream.
// Org-scoped (no `patient_id` column — joinable to PHI only via `visit_id`); the free-text `resolution_reason`
// is DENYLISTED from audit (§3.6). The visit/encounter/step-up refs are plain uuid logical FKs (M17/M8/M2).
// RLS + grants + M4 write-audit trigger land in the RLS migration (M18-T02 / 0047).
import { bigint, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { evvMissingResolutionKind, evvMissingResolutionStatus } from "../../enums";
import { organizations } from "../organizations";

export const evvMissingResolution = pgTable(
  "evv_missing_resolution",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    visitId: uuid("visit_id").notNull(), // M17 visit (app-validated; no cross-module FK)

    kind: evvMissingResolutionKind("kind").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    // 'cron_late_check_sweep' | 'geofence_evaluator' | 'device_attestation_gate' | 'encounter_signed_consumer'
    detectedBySource: text("detected_by_source").notNull(),

    status: evvMissingResolutionStatus("status").notNull().default("open"),
    resolvedByMembershipId: uuid("resolved_by_membership_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionReason: text("resolution_reason"), // ≥40 (clinician) / ≥60 (supervisor); DENYLISTED (§3.6)
    stepUpAuthRefId: uuid("step_up_auth_ref_id"), // supervisor override; M2 step_up_session (app-validated)

    encounterIdSource: uuid("encounter_id_source"), // documented-at-encounter close; M8 (app-validated)

    version: bigint("version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // At most one OPEN resolution per (visit, kind) (§3.2 Phase E).
    openIdempotency: uniqueIndex("evv_missing_resolution_open_uidx")
      .on(t.organizationId, t.visitId, t.kind)
      .where(sql`status = 'open'`),
    orgVisit: index("evv_missing_resolution_org_visit_idx").on(t.organizationId, t.visitId),
    // The resolution work queue (§3.4): open rows oldest-first.
    orgStatus: index("evv_missing_resolution_org_status_idx").on(
      t.organizationId,
      t.status,
      t.detectedAt,
    ),
  }),
);

export type EvvMissingResolution = typeof evvMissingResolution.$inferSelect;
export type NewEvvMissingResolution = typeof evvMissingResolution.$inferInsert;
