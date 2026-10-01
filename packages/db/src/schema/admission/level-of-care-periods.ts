// @wardenx/db — `level_of_care_period` (M6 §3.3). The LOC ledger over an admission (routine home /
// continuous home / inpatient respite / general inpatient), each row driving the `m6.loc.changed`
// outbox and a Q-code (Q5001..Q5010, derived via M38). Org-scoped (no direct patient identifier;
// tenancy via the admission FK). `assigned_by` is an M1 user (FK); `facility_id` (M40) +
// `ipu_bed_assignment_id` (M37) are plain uuid app-validated. One open LOC per admission (partial
// unique). RLS + the M4 write-audit trigger land in M6-T03 (§3.6–3.7).
import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { levelOfCare, levelOfCarePeriodStatus } from "../../enums";
import { organizations } from "../organizations";
import { users } from "../users";
import { admissions } from "./admissions";

export const levelOfCarePeriods = pgTable(
  "level_of_care_period",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    admissionId: uuid("admission_id")
      .notNull()
      .references(() => admissions.id, { onDelete: "restrict" }),
    levelOfCare: levelOfCare("level_of_care").notNull(),
    // The confirm-handshake fix (2026-08-05): persisted so "requested but bed not yet confirmed" is a
    // real, queryable state — always kept in sync with endedAt (never independently stale).
    status: levelOfCarePeriodStatus("status").notNull().default("active"),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // Nullable at create (M6L-T04): changeLoc (route 33) carries only the new level; assigned_by + reason
    // are filled on patchLoc, and q_code is derived from M38 once wired.
    assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason"),
    qCode: text("q_code"), // Q5001..Q5010 — derived (M38)
    facilityId: uuid("facility_id"), // M40 facility (app-validated)
    ipuBedAssignmentId: uuid("ipu_bed_assignment_id"), // M37 bed assignment (logical)
    // F-155 (#248), migration 0250 — the triggering M11 `order_record.id` for an order-driven LOC change
    // (§2.3.5 / M11 D9). Logical, not a SQL FK (M6's `dependsOn` excludes 11, the same posture as
    // facilityId/ipuBedAssignmentId above). NULL for every clinician-initiated LOC change (the ordinary
    // route) and every pre-existing row; the redelivery guard for `m11.order.level_of_care_change_signed`
    // is the plain UNIQUE(organization_id, source_order_id) below (NULLS DISTINCT by default).
    sourceOrderId: uuid("source_order_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    admEffIdx: index("lcp_adm_effective_idx").on(t.admissionId, t.effectiveAt),
    admOpenUnique: uniqueIndex("lcp_adm_open_idx").on(t.admissionId).where(sql`ended_at IS NULL`),
    sourceOrderUnique: unique("level_of_care_period_source_order_id_uq").on(
      t.organizationId,
      t.sourceOrderId,
    ),
  }),
);

export type LevelOfCarePeriod = typeof levelOfCarePeriods.$inferSelect;
export type NewLevelOfCarePeriod = typeof levelOfCarePeriods.$inferInsert;
