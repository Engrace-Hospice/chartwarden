// @chartwarden/db — `referral` (M6 Admission/Election/Certification §3.3). The intake record: a
// prospective patient handed to the agency before (or driving) an admission. PHI-bearing (carries a
// patient reference + name/DOB at receipt) → the three-column tenancy rule (ARCH-011 / ADR-0010 D1):
// organization_id NOT NULL + nullable provider_entity_id / location_id (org-level until an admission
// activates them). Cross-module refs (M5 patient, M40 referral-source) are plain uuid app-validated,
// NOT cross-module FKs. `external_message_ref` carries the M29 HL7 provenance for the consumer path
// (§3.4). RLS + the M4 write-audit trigger land in M6-T03 (§3.6–3.7).
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  referralPatientResolutionStatus,
  referralPriority,
  referralSourceChannel,
  referralStatus,
} from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { users } from "../users";

export const referrals = pgTable(
  "referral",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }), // ARCH-011 (nullable — org-level until admission)
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }), // ARCH-011 (nullable)
    patientId: uuid("patient_id"), // M5 patient (app-validated; no cross-module FK)
    referralSourceId: uuid("referral_source_id"), // M40 referral-source (app-validated; no cross-module FK)
    referrerName: text("referrer_name"),
    referrerPhone: text("referrer_phone"),
    referrerOrganization: text("referrer_organization"),
    externalReferralId: text("external_referral_id"),
    patientNameAtReceipt: text("patient_name_at_receipt").notNull(),
    patientDobAtReceipt: date("patient_dob_at_receipt"),
    // The patient's Medicare number (MBI) as given by the referrer — normalized, CMS MBI format (0317).
    // Copied to M5's `mbi` identifier when the referral creates / is matched to a patient without one.
    medicareNumberAtReceipt: text("medicare_number_at_receipt"),
    // The patient's Medicaid number from the referrer (1-14 alphanumerics, 0317). M5 keeps Medicaid IDs on
    // `patient_payer`, so it pre-fills the intake Coverage / Payers form instead of being copied.
    medicaidNumberAtReceipt: text("medicaid_number_at_receipt"),
    // Captured at referral intake and supplied only when M6 creates a new M5 patient.
    sexAssignedAtBirth: text("sex_assigned_at_birth"),
    referringDxText: text("referring_dx_text"),
    icd10TerminalPrimary: text("icd10_terminal_primary"),
    sourceChannel: referralSourceChannel("source_channel").notNull(),
    status: referralStatus("status").notNull().default("received"),
    patientResolutionStatus: referralPatientResolutionStatus("patient_resolution_status")
      .notNull()
      .default("unresolved"),
    priority: referralPriority("priority").notNull().default("routine"),
    assignedToUserId: uuid("assigned_to_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    rejectionReason: text("rejection_reason"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    qualifiedBy: uuid("qualified_by").references(() => users.id, { onDelete: "set null" }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    convertedAdmissionId: uuid("converted_admission_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    externalMessageRef: jsonb("external_message_ref").$type<{
      source: "m29";
      proposalId: string;
      messageControlId: string;
      sendingFacility: string;
      sendingApplication?: string;
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    orgStatusReceivedIdx: index("referral_org_status_received_idx").on(
      t.organizationId,
      t.status,
      t.receivedAt,
    ),
    patientIdx: index("referral_patient_idx").on(t.patientId),
    externalReferralIdx: uniqueIndex("referral_org_external_referral_uidx")
      .on(t.organizationId, t.externalReferralId)
      .where(sql`external_referral_id IS NOT NULL`),
    medicareNumberFormat: check(
      "referral_medicare_number_format",
      sql`${t.medicareNumberAtReceipt} IS NULL OR ${t.medicareNumberAtReceipt} ~ '^[1-9][AC-HJ-NP-RT-Y][0-9AC-HJ-NP-RT-Y]{9}$'`,
    ),
    medicaidNumberFormat: check(
      "referral_medicaid_number_format",
      sql`${t.medicaidNumberAtReceipt} IS NULL OR ${t.medicaidNumberAtReceipt} ~ '^[A-Z0-9]{1,14}$'`,
    ),
  }),
);

export type Referral = typeof referrals.$inferSelect;
export type NewReferral = typeof referrals.$inferInsert;
