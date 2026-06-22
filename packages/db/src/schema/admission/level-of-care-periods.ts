// @wardenx/db — `level_of_care_period` (M6 §3.3). The LOC ledger over an admission (routine home /
// continuous home / inpatient respite / general inpatient), each row driving the `m6.loc.changed`
// outbox and a Q-code (Q5001..Q5010, derived via M38). Org-scoped (no direct patient identifier;
// tenancy via the admission FK). `assigned_by` is an M1 user (FK); `facility_id` (M40) +
// `ipu_bed_assignment_id` (M37) are plain uuid app-validated. One open LOC per admission (partial
// unique). RLS + the M4 write-audit trigger land in M6-T03 (§3.6–3.7).
import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { levelOfCare } from "../../enums";
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
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    assignedBy: uuid("assigned_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    qCode: text("q_code").notNull(), // Q5001..Q5010 — derived (M38)
    facilityId: uuid("facility_id"), // M40 facility (app-validated)
    ipuBedAssignmentId: uuid("ipu_bed_assignment_id"), // M37 bed assignment (logical)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    admEffIdx: index("lcp_adm_effective_idx").on(t.admissionId, t.effectiveAt),
    admOpenUnique: uniqueIndex("lcp_adm_open_idx").on(t.admissionId).where(sql`ended_at IS NULL`),
  }),
);

export type LevelOfCarePeriod = typeof levelOfCarePeriods.$inferSelect;
export type NewLevelOfCarePeriod = typeof levelOfCarePeriods.$inferInsert;
