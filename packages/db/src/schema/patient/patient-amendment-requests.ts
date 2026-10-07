// @wardenx/db — `patient_amendment_request` (M5 §3.5, §7.7). HIPAA §164.526 right-to-amend: a
// patient/representative requests a demographic/clinical/narrative correction; the org decides within
// 60 days (`sla_due_at` = received_at + 60d). A denial requires a reason; the requester may file a
// statement of disagreement. PHI-bearing → three-column tenancy rule.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { patientAmendmentStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { users } from "../users";
import { patients } from "./patients";

export const patientAmendmentRequests = pgTable(
  "patient_amendment_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id),
    scope: text("scope").notNull(), // 'demographic' | 'clinical' | 'narrative'
    requestedChanges: jsonb("requested_changes").notNull(), // {fieldPath, currentValue, requestedValue, justification}
    rationale: text("rationale").notNull(),
    status: patientAmendmentStatus("status").notNull().default("pending"),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
    denialReason: text("denial_reason"),
    statementOfDisagreement: text("statement_of_disagreement"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }).notNull(), // received_at + 60 days
    // GAP-118 (migration 0431) — once-only markers for the daily SLA scan: set in the same transaction as the
    // `m5.patient.amendment_sla_due_soon` / `_overdue` event so a replayed tick never alerts twice.
    slaDueSoonNotifiedAt: timestamp("sla_due_soon_notified_at", { withTimezone: true }),
    slaOverdueNotifiedAt: timestamp("sla_overdue_notified_at", { withTimezone: true }),
  },
  (t) => ({
    patientIdx: index("patient_amendment_request_patient_idx").on(t.patientId),
    slaIdx: index("patient_amendment_request_sla_idx")
      .on(t.slaDueAt)
      .where(sql`${t.status} = 'pending'`),
    // GAP-006 (0323) — one OPEN portal request per patient per requested change; the portal intake
    // inserts ON CONFLICT DO NOTHING and reads the open row back. Decided/withdrawn rows leave the index.
    portalOpenDedupeUq: uniqueIndex("patient_amendment_request_portal_open_dedupe_uq")
      .on(t.organizationId, t.patientId, sql`(${t.requestedChanges} ->> 'portalDedupeKey')`)
      .where(
        sql`${t.status} = 'pending' AND (${t.requestedChanges} ->> 'portalDedupeKey') IS NOT NULL`,
      ),
    denialReasonRequired: check(
      "patient_amendment_request_denial_reason_required",
      sql`(${t.status} <> 'denied') OR (${t.denialReason} IS NOT NULL)`,
    ),
  }),
);

export type PatientAmendmentRequest = typeof patientAmendmentRequests.$inferSelect;
export type NewPatientAmendmentRequest = typeof patientAmendmentRequests.$inferInsert;
