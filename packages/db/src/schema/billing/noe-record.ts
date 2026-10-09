import { sql } from "drizzle-orm";
// @wardenx/db — `noe_record` (M23 Billing-Medicare §3.3; non-partitioned; retention class
// `compliance`). The Notice of Election: one regulatory NOE per admission/election period, with the
// 5-day timely-filing window watched by the cron watchdog (`window_target_at` = election effective
// date + 5 days). The NOE lifecycle (D4) lives in `state` (shares the NOE/NOTR 7-state shape).
// ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS).
//
// CROSS-MODULE FK POLICY (architecture WINS over the spec DDL): cross-module FK constraints are
// FORBIDDEN. Only `organization_id` (core) gets a real `.references(...)`. `provider_entity_id` (M40),
// `patient_id`/`admission_id`/`election_period_id` (M5/M6), the latest_*/*_document_id pointers are
// LOGICAL FKs — plain uuid, validated at runtime (mirrors the M27 cost-report precedent). No MBI is
// ever stored here (D13, §8.7).
import {
  type AnyPgColumn,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { m23NoeState } from "./types";

export const noeRecord = pgTable(
  "noe_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK → M40

    // Logical FKs (M5/M6):
    patientId: uuid("patient_id").notNull(), // M5
    admissionId: uuid("admission_id").notNull(), // M6
    electionPeriodId: uuid("election_period_id").notNull(), // M6

    state: m23NoeState("state").notNull().default("DRAFT"),

    electionEffectiveDate: date("election_effective_date").notNull(),
    windowTargetAt: date("window_target_at").notNull(), // = electionEffectiveDate + 5 days
    windowBreachedAt: date("window_breached_at"), // set on watchdog tick when state ∉ ACK_ACCEPTED past windowTargetAt

    // Identifiers (similar shape to claim):
    noeControlNumber: text("noe_control_number").notNull(),
    payerNoeControlNumber: text("payer_noe_control_number"),

    // The MAC's answer (migration 0377): the 277CA acceptance date, or the 999 / 277CA rejection with its PHI-free
    // reason codes. The raw acknowledgment is never stored here (it stays behind `claim_acknowledgment.ack_file_uri`).
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionStage: text("rejection_stage").$type<"999" | "277ca">(),
    rejectionCodes: text("rejection_codes").array(),
    // Migration 0378 — the MAC's own date for that answer (277CA STC02; a 999's GS04, else ISA09; else our
    // receipt date) and which of those it is. Timeliness is judged on it, not on `accepted_at` (our receipt time).
    payerStatusDate: date("payer_status_date"),
    payerStatusDateSource: text("payer_status_date_source").$type<
      "277ca_stc02" | "999_gs04" | "999_isa09" | "receipt" | "dde_manual"
    >(),

    // Migration 0378 — a corrected notice filed after a rejection is its own row pointing back at the rejected
    // one (M23 §2.2); the biller's reason stays here and never reaches an event.
    correctsNoticeId: uuid("corrects_notice_id").references((): AnyPgColumn => noeRecord.id),
    correctionReason: text("correction_reason"),

    // Submission / acknowledgment pointers (latest):
    latestSubmissionId: uuid("latest_submission_id"),
    latestAcknowledgmentId: uuid("latest_acknowledgment_id"),

    // Doc back-ref (M22):
    confirmationDocumentId: uuid("confirmation_document_id"),

    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One NOE per admission (excluding cancelled/rejected which can repeat):
    uniqueByAdmission: uniqueIndex("noe_record_admission_uq")
      .on(t.admissionId)
      .where(sql`state NOT IN ('CANCELLED','ACK_REJECTED')`),
    // One correction in progress (or accepted) per rejected notice (migration 0378).
    openCorrectionUq: uniqueIndex("noe_record_open_correction_uq")
      .on(t.correctsNoticeId)
      .where(sql`corrects_notice_id IS NOT NULL AND state NOT IN ('CANCELLED','ACK_REJECTED')`),
    controlNumberUq: uniqueIndex("noe_control_number_uq").on(
      t.providerEntityId,
      t.noeControlNumber,
    ),
    // §3.4 noe_window_watch_partial — partial on the watch-eligible slice so the cron watchdog scan
    // touches only rows still in flight against the 5-day window:
    windowWatchIdx: index("noe_window_watch_idx")
      .on(t.organizationId, t.state, t.windowTargetAt)
      .where(sql`state NOT IN ('ACK_ACCEPTED','CANCELLED','ACK_REJECTED')`),
  }),
);

export type NoeRecord = typeof noeRecord.$inferSelect;
export type NewNoeRecord = typeof noeRecord.$inferInsert;
