import { sql } from "drizzle-orm";
// @chartwarden/db — `transfer_notice_record` (M23 Billing-Medicare; migration 0375; retention class `compliance`).
// The Medicare hospice Change of Provider / Transfer Notice the RECEIVING hospice files (TOB 81C/82C, "8xC"),
// a corrected 8xC (occurrence code 56 + condition code D0) and the 8xD void that removes a transfer submitted in
// error — CMS Pub. 100-04 ch. 11 §20.1.3 / §20.1.4 (Rev. 12847). Shares the NOE/NOTR lifecycle alphabet
// (`noe_state`). ORG-SCOPED with the three tenancy columns (FORCEd app.org_id RLS + M4 write-audit trigger).
//
// CROSS-MODULE FK POLICY: only `organization_id` (core) and the intra-table `supersedes_notice_id` get real
// `.references(...)`; the M5/M6/M40 ids are logical FKs (plain uuid, validated at runtime). No MBI (D13).
import {
  type AnyPgColumn,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { m23NoeState } from "./types";

export const TRANSFER_NOTICE_ACTIONS = ["original", "correction", "void"] as const;
export const TRANSFER_NOTICE_TOBS = ["81C", "82C", "81D", "82D"] as const;
export const PRIOR_HOSPICE_PATIENT_STATUSES = ["50", "51"] as const;

export const transferNoticeRecord = pgTable(
  "transfer_notice_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK → M40
    locationId: uuid("location_id"), // logical FK → M1 location (the admission's siting)
    patientId: uuid("patient_id").notNull(), // M5
    admissionId: uuid("admission_id").notNull(), // M6 (the transferred-in admission)
    transferEventId: uuid("transfer_event_id").notNull(), // M6 transfer_event (direction 'in')
    electionPeriodId: uuid("election_period_id"), // M6 — the inherited benefit period

    /** `original` 8xC · `correction` 8xC + OC 56 + CC D0 · `void` 8xD. */
    action: text("action", { enum: TRANSFER_NOTICE_ACTIONS }).notNull(),
    supersedesNoticeId: uuid("supersedes_notice_id").references(
      (): AnyPgColumn => transferNoticeRecord.id,
      { onDelete: "restrict" },
    ),
    state: m23NoeState("state").notNull().default("DRAFT"),
    tob: text("tob", { enum: TRANSFER_NOTICE_TOBS }).notNull(),

    /** Statement From: the date the change is effective (§20.1.3; no Through date). The corrected date on a
     *  correction; the transfer date being removed on a void (§20.1.4). */
    statementFromDate: date("statement_from_date").notNull(),
    /** Correction only — the original, incorrect transfer date reported with occurrence code 56. */
    originalTransferDate: date("original_transfer_date"),
    /** The receiving hospice's OWN admission date (§20.1.3 "Admission Date"); NULL until M6 knows it. */
    admissionDate: date("admission_date"),
    benefitPeriodSequence: smallint("benefit_period_sequence").notNull(),
    benefitPeriodStartDate: date("benefit_period_start_date"),

    priorHospiceName: text("prior_hospice_name").notNull(),
    priorHospiceCcn: text("prior_hospice_ccn"),
    priorHospiceNpi: text("prior_hospice_npi"),
    /** Snapshot of the filing provider entity's CCN — the §20.1.3 same-CCN block compares against it. */
    providerCcn: text("provider_ccn").notNull(),
    /** M40 physicians snapshotted from the admission when the notice is drafted / confirmed: the attending
     *  (837I Loop 2310A) and the hospice certifying physician ("other physician", Loop 2310F). */
    attendingPhysicianId: uuid("attending_physician_id"),
    certifyingPhysicianId: uuid("certifying_physician_id"),

    // The §20.1.3 hold: "The 8XC does not get submitted until after the other provider has finalized their
    // billing." Nothing in WardenX can observe another hospice's claims, so it is a staff confirmation of the
    // transferring hospice's final claim (Through date + patient status 50/51), all four columns or none.
    priorBillingConfirmedAt: timestamp("prior_billing_confirmed_at", { withTimezone: true }),
    priorBillingConfirmedByMembershipId: uuid("prior_billing_confirmed_by_membership_id"),
    priorHospiceThroughDate: date("prior_hospice_through_date"),
    priorHospicePatientStatus: text("prior_hospice_patient_status", {
      enum: PRIOR_HOSPICE_PATIENT_STATUSES,
    }),

    controlNumber: text("control_number").notNull(),
    payerControlNumber: text("payer_control_number"),
    latestSubmissionId: uuid("latest_submission_id"),
    latestAcknowledgmentId: uuid("latest_acknowledgment_id"),
    cancelReason: text("cancel_reason"),

    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    controlNumberUq: uniqueIndex("transfer_notice_control_number_uq").on(
      t.providerEntityId,
      t.controlNumber,
    ),
    originalUq: uniqueIndex("transfer_notice_original_uq")
      .on(t.transferEventId)
      .where(sql`action = 'original' AND state NOT IN ('CANCELLED','ACK_REJECTED')`),
    followUpUq: uniqueIndex("transfer_notice_follow_up_uq")
      .on(t.supersedesNoticeId)
      .where(sql`supersedes_notice_id IS NOT NULL AND state NOT IN ('CANCELLED','ACK_REJECTED')`),
    worklistIdx: index("transfer_notice_worklist_idx").on(t.organizationId, t.state, t.createdAt),
    patientPeriodIdx: index("transfer_notice_patient_period_idx").on(
      t.organizationId,
      t.patientId,
      t.benefitPeriodSequence,
    ),
    admissionIdx: index("transfer_notice_admission_idx").on(t.admissionId),
  }),
);

export type TransferNoticeRecord = typeof transferNoticeRecord.$inferSelect;
export type NewTransferNoticeRecord = typeof transferNoticeRecord.$inferInsert;
