// @wardenx/db — `certification_of_terminal_illness` (M6 §3.3). The CTI for an election period:
// hospice MD (and optionally attending MD) attesting a ≤6-month prognosis. Org-scoped (no direct
// patient identifier; tenancy via the election_period FK). Cross-module refs (M40 physicians, M22
// document) are plain uuid app-validated; the election_period FK is intra-M6. One non-voided CTI per
// period (partial unique). RLS + the M4 write-audit trigger land in M6-T03 (§3.6–3.7).
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ctiStatus } from "../../enums";
import { organizations } from "../organizations";
import { electionPeriods } from "./election-periods";

export const certificationsOfTerminalIllness = pgTable(
  "certification_of_terminal_illness",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    electionPeriodId: uuid("election_period_id")
      .notNull()
      .references(() => electionPeriods.id, { onDelete: "restrict" }),
    hospiceMdId: uuid("hospice_md_id").notNull(), // M40 physician (app-validated)
    hospiceMdSignedAt: timestamp("hospice_md_signed_at", { withTimezone: true }),
    attendingMdId: uuid("attending_md_id"), // M40 physician (app-validated)
    attendingMdSignedAt: timestamp("attending_md_signed_at", { withTimezone: true }),
    // Nullable at draft (M6L-T03): a `drafted` CTI carries only the physicians + period ref; the clinical
    // fields are filled when known / on completion. See migration 0124.
    terminalDiagnosisIcd10: text("terminal_diagnosis_icd10"),
    relatedConditionsIcd10: text("related_conditions_icd10").array().notNull().default(sql`'{}'`),
    narrative: text("narrative"),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    signedLate: boolean("signed_late").notNull().default(false),
    lateReason: text("late_reason"),
    status: ctiStatus("status").notNull().default("drafted"),
    documentId: uuid("document_id"), // M22 document (app-validated)
    voidedSupersedesId: uuid("voided_supersedes_id"), // self-reference (logical)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    periodActiveUnique: uniqueIndex("cti_period_active_idx")
      .on(t.electionPeriodId)
      .where(sql`status <> 'voided'`),
    orgStatusIdx: index("cti_org_status_idx").on(t.organizationId, t.status, t.periodStart),
  }),
);

export type CertificationOfTerminalIllness = typeof certificationsOfTerminalIllness.$inferSelect;
export type NewCertificationOfTerminalIllness = typeof certificationsOfTerminalIllness.$inferInsert;
