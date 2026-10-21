// @chartwarden/db — `consent_revocation` (M39 Consent §3.3 #6). One row per explicit revocation event
// (§2.2.3, D7): the actor, the reason (≥40 chars + evidence doc when staff-initiated, CHECK-
// enforced), and the typed-cascade progress. cascade_status / cascade_consumer_status_jsonb are
// DERIVED columns maintained by the service layer + the revocation-cascade-retry cron (the canonical
// m39.consent.revoked outbox event is emitted by the service in-transaction, NEVER by a trigger —
// ARCH-144/264 / M39-F08). Org-scoped child of consent_record → standard app.org_id RLS in M39-T03.
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { consentRevocationActorKind, consentRevocationCascadeStatus } from "../../enums";
import { organizations } from "../organizations";
import { consentRecord } from "./consent-record";

export const consentRevocation = pgTable(
  "consent_revocation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    consentRecordId: uuid("consent_record_id")
      .notNull()
      .references(() => consentRecord.id, { onDelete: "restrict" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),
    revokedByKind: consentRevocationActorKind("revoked_by_kind").notNull(),
    revokedByUserId: uuid("revoked_by_user_id"),
    revokedByCaregiverId: uuid("revoked_by_caregiver_id"),
    reasonText: text("reason_text").notNull(),
    evidenceDocumentId: uuid("evidence_document_id"), // M22 doc ref; required for staff revocation
    cascadeStatus: consentRevocationCascadeStatus("cascade_status").notNull().default("pending"),
    cascadeStartedAt: timestamp("cascade_started_at", { withTimezone: true }),
    cascadeCompletedAt: timestamp("cascade_completed_at", { withTimezone: true }),
    cascadeConsumerStatusJsonb: jsonb("cascade_consumer_status_jsonb")
      .notNull()
      .default(sql`'{}'::jsonb`),
    stepUpEvidenceId: uuid("step_up_evidence_id"),
    auditEventId: uuid("audit_event_id"),
  },
  (t) => ({
    consentIdx: index("ix_cr_revocation_consent").on(t.consentRecordId),
    cascadeStuckIdx: index("ix_cr_revocation_cascade_stuck")
      .on(t.cascadeStatus, t.cascadeStartedAt)
      .where(sql`cascade_status IN ('pending', 'in_progress')`),
    staffReasonFloor: check(
      "cr_revocation_staff_reason_floor",
      sql`revoked_by_kind <> 'staff' OR length(reason_text) >= 40`,
    ),
    staffEvidenceRequired: check(
      "cr_revocation_staff_evidence",
      sql`revoked_by_kind <> 'staff' OR evidence_document_id IS NOT NULL`,
    ),
  }),
);

export type ConsentRevocation = typeof consentRevocation.$inferSelect;
export type NewConsentRevocation = typeof consentRevocation.$inferInsert;
