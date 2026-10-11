import { sql } from "drizzle-orm";
// @wardenx/db — `notr_record` (M23 Billing-Medicare §3.3; non-partitioned; retention class
// `compliance`). The Notice of Termination/Revocation: one regulatory NOTR per terminating event
// (revocation / transfer-out / discharge), with the timely-filing window watched by the cron watchdog
// (`window_target_at`). The NOTR lifecycle (D4) lives in `state` (shares the NOE/NOTR 7-state shape).
// Exactly one of the three event ids is populated and must match `trigger_kind` (CHECK constraints).
// ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS).
//
// CROSS-MODULE FK POLICY (architecture WINS over the spec DDL): cross-module FK constraints are
// FORBIDDEN. Only `organization_id` (core) gets a real `.references(...)`. `provider_entity_id` (M40),
// `patient_id`/`admission_id` (M5/M6), the revocation/transfer/discharge event ids (M6), and the
// latest_*/*_document_id pointers are LOGICAL FKs — plain uuid, validated at runtime (mirrors the M27
// cost-report precedent). No MBI is ever stored here (D13, §8.7).
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
import { m23NotrState, m23NotrTriggerKind } from "./types";

export const notrRecord = pgTable(
  "notr_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK → M40

    patientId: uuid("patient_id").notNull(), // M5
    admissionId: uuid("admission_id").notNull(), // M6

    triggerKind: m23NotrTriggerKind("trigger_kind").notNull(),
    revocationEventId: uuid("revocation_event_id"), // logical FK → M6
    transferEventId: uuid("transfer_event_id"), // logical FK → M6
    dischargeEventId: uuid("discharge_event_id"), // logical FK → M6

    effectiveEndDate: date("effective_end_date").notNull(),
    windowTargetAt: date("window_target_at").notNull(),
    windowBreachedAt: date("window_breached_at"),

    state: m23NotrState("state").notNull().default("DRAFT"),

    notrControlNumber: text("notr_control_number").notNull(),
    payerNotrControlNumber: text("payer_notr_control_number"),

    // The MAC's answer (migration 0377): the 277CA acceptance date, or the 999 / 277CA rejection with its PHI-free
    // reason codes. The raw acknowledgment is never stored here (it stays behind `claim_acknowledgment.ack_file_uri`).
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    clearinghouseAcceptedAt: timestamp("clearinghouse_accepted_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionStage: text("rejection_stage").$type<"999" | "277ca" | "clearinghouse">(),
    rejectionCodes: text("rejection_codes").array(),
    // Migration 0378 — the MAC's own date for that answer (277CA STC02; a 999's GS04, else ISA09; else our
    // receipt date) and which of those it is. Timeliness is judged on it, not on `accepted_at` (our receipt time).
    payerStatusDate: date("payer_status_date"),
    payerStatusDateSource: text("payer_status_date_source").$type<
      "277ca_stc02" | "999_gs04" | "999_isa09" | "receipt" | "dde_manual"
    >(),

    // Migration 0378 — a corrected notice filed after a rejection is its own row pointing back at the rejected
    // one (M23 §2.2); the biller's reason stays here and never reaches an event.
    correctsNoticeId: uuid("corrects_notice_id").references((): AnyPgColumn => notrRecord.id),
    correctionReason: text("correction_reason"),

    latestSubmissionId: uuid("latest_submission_id"),
    latestAcknowledgmentId: uuid("latest_acknowledgment_id"),
    confirmationDocumentId: uuid("confirmation_document_id"),

    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneEventKind: sql`CHECK (
    (revocation_event_id IS NOT NULL)::int +
    (transfer_event_id IS NOT NULL)::int +
    (discharge_event_id IS NOT NULL)::int = 1
  )`,
    triggerMatchesEvent: sql`CHECK (
    (trigger_kind = 'revocation' AND revocation_event_id IS NOT NULL) OR
    (trigger_kind = 'transfer_out' AND transfer_event_id IS NOT NULL) OR
    (trigger_kind = 'discharge' AND discharge_event_id IS NOT NULL)
  )`,
    // One correction in progress (or accepted) per rejected notice (migration 0378).
    openCorrectionUq: uniqueIndex("notr_record_open_correction_uq")
      .on(t.correctsNoticeId)
      .where(sql`corrects_notice_id IS NOT NULL AND state NOT IN ('CANCELLED','ACK_REJECTED')`),
    controlNumberUq: uniqueIndex("notr_control_number_uq").on(
      t.providerEntityId,
      t.notrControlNumber,
    ),
    uniqueByEvent: uniqueIndex("notr_unique_by_event_uq")
      .on(t.revocationEventId, t.transferEventId, t.dischargeEventId)
      .where(sql`state NOT IN ('CANCELLED','ACK_REJECTED')`),
    windowWatchIdx: index("notr_window_watch_idx").on(t.organizationId, t.state, t.windowTargetAt),
  }),
);

export type NotrRecord = typeof notrRecord.$inferSelect;
export type NewNotrRecord = typeof notrRecord.$inferInsert;
