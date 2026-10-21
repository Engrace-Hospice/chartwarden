import { sql } from "drizzle-orm";
// @chartwarden/db — `intake_records_request` (M22, F-238 / 0313). One outbound request for a prospect's older
// records (PCP / hospital), sent with a cover sheet carrying `request_code`; the intake job recognises the
// code on the returned fax pages (or the e-mail subject) and files the batch under `referral_id`.
// PHI by association (who holds this prospect's records) → the three tenancy columns, FORCEd RLS, audit
// trigger with the recipient fields, the free-text note and the cancel reason denylisted. `patient_id` is
// the referral's patient once M6 resolved one (null before). No DELETE grant: a request is cancelled.
import {
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
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const intakeRecordsRequests = pgTable(
  "intake_records_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    patientId: uuid("patient_id"),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id),
    locationId: uuid("location_id").references(() => locations.id),
    referralId: uuid("referral_id").notNull(), // M6 — app-validated via ReferralReader; no FK out
    requestCode: text("request_code").notNull(),
    recipientName: text("recipient_name").notNull(), // DENYLISTED (§3.6)
    recipientOrganization: text("recipient_organization"), // DENYLISTED
    recipientFax: text("recipient_fax"), // DENYLISTED
    recipientEmail: text("recipient_email"), // DENYLISTED
    recordsRequested: jsonb("records_requested").notNull(), // RecordsRequestKind[]
    recordsRequestedNote: text("records_requested_note"), // DENYLISTED
    dateRangeStart: date("date_range_start"),
    dateRangeEnd: date("date_range_end"),
    status: text("status").notNull().default("requested"),
    dueDate: date("due_date"),
    // F-238 (0314) — the day after which an unanswered request is expired by the M22 sweep (null = never),
    // and when it was. `expired_at` is kept after late records arrive (received_at >= expired_at).
    expiresOn: date("expires_on"),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    cancelledByMembershipId: uuid("cancelled_by_membership_id"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"), // DENYLISTED
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    correlationId: text("correlation_id").notNull(),
  },
  (t) => ({
    orgCode: uniqueIndex("intake_records_request_org_code_uq").on(t.organizationId, t.requestCode),
    byReferral: index("intake_records_request_org_referral_idx").on(
      t.organizationId,
      t.referralId,
      t.requestedAt,
    ),
    status: check(
      "intake_records_request_status_chk",
      sql`status IN ('requested', 'received', 'partially_received', 'cancelled', 'expired')`,
    ),
    code: check(
      "intake_records_request_code_chk",
      sql`request_code ~ '^RR-[ACDEFHJKMNPRTVWXY234679]{7}$'`,
    ),
    recipient: check(
      "intake_records_request_recipient_chk",
      sql`recipient_fax IS NOT NULL OR recipient_email IS NOT NULL`,
    ),
    kinds: check(
      "intake_records_request_kinds_chk",
      sql`jsonb_typeof(records_requested) = 'array'`,
    ),
    range: check(
      "intake_records_request_range_chk",
      sql`date_range_start IS NULL OR date_range_end IS NULL OR date_range_start <= date_range_end`,
    ),
    expiredShape: check(
      "intake_records_request_expired_shape",
      sql`status <> 'expired' OR expired_at IS NOT NULL`,
    ),
    openByExpiry: index("intake_records_request_org_open_expiry_idx")
      .on(t.organizationId, t.expiresOn)
      .where(sql`status = 'requested' AND expires_on IS NOT NULL`),
    cancelShape: check(
      "intake_records_request_cancel_shape",
      sql`(status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by_membership_id IS NOT NULL)`,
    ),
  }),
);

export type IntakeRecordsRequest = typeof intakeRecordsRequests.$inferSelect;
