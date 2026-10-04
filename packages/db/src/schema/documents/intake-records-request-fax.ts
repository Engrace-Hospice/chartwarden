import { sql } from "drizzle-orm";
// @wardenx/db — `intake_records_request_fax` (M22, F-238 / 0315). One attempt to fax a records request's cover
// sheet + letter through M22's outbound-fax port: `sending` → `sent` (provider + message id) | `failed`.
// At most one `sending`/`sent` row per request (partial unique index) — the send is idempotent per request.
// PHI by association → the three tenancy columns, FORCEd RLS, audit trigger with the destination number and
// the provider's failure text denylisted. No DELETE grant: a send is history.
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { intakeRecordsRequests } from "./intake-records-request";

export const intakeRecordsRequestFaxes = pgTable(
  "intake_records_request_fax",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    patientId: uuid("patient_id"),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id),
    locationId: uuid("location_id").references(() => locations.id),
    recordsRequestId: uuid("records_request_id")
      .notNull()
      .references(() => intakeRecordsRequests.id),
    referralId: uuid("referral_id").notNull(), // M6 — app-validated via ReferralReader; no FK out
    faxNumber: text("fax_number").notNull(), // E.164; DENYLISTED (§3.6)
    status: text("status").notNull().default("sending"),
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id"),
    pageCount: integer("page_count").notNull(),
    documentSha256: text("document_sha256").notNull(),
    failureReason: text("failure_reason"), // DENYLISTED
    sentByMembershipId: uuid("sent_by_membership_id").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    correlationId: text("correlation_id").notNull(),
  },
  (t) => ({
    oneLive: uniqueIndex("intake_records_request_fax_one_live_uq")
      .on(t.recordsRequestId)
      .where(sql`status IN ('sending', 'sent')`),
    byRequest: index("intake_records_request_fax_org_request_idx").on(
      t.organizationId,
      t.recordsRequestId,
      t.attemptedAt,
    ),
    status: check(
      "intake_records_request_fax_status_chk",
      sql`status IN ('sending', 'sent', 'failed')`,
    ),
    number: check(
      "intake_records_request_fax_number_chk",
      sql`fax_number ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),
    sha: check("intake_records_request_fax_sha_chk", sql`document_sha256 ~ '^[0-9a-f]{64}$'`),
    pages: check("intake_records_request_fax_pages_chk", sql`page_count > 0`),
    shape: check(
      "intake_records_request_fax_shape_chk",
      sql`(status = 'sending' AND sent_at IS NULL AND failed_at IS NULL) OR (status = 'sent' AND sent_at IS NOT NULL AND provider_message_id IS NOT NULL AND failed_at IS NULL) OR (status = 'failed' AND failed_at IS NOT NULL AND failure_reason IS NOT NULL AND sent_at IS NULL)`,
    ),
  }),
);

export type IntakeRecordsRequestFax = typeof intakeRecordsRequestFaxes.$inferSelect;
