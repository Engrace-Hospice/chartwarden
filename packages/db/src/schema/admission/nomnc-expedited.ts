// @chartwarden/db — M6 milestone 10a (migration 1230): `nomnc_notice`, `expedited_review`, `expedited_deadline`.
// RECORD-KEEPING ONLY: who delivered which NOMNC, the BFCC-QIO fast-track facts, and deadlines a person typed from
// the notice / the QIO's call to the minute. Closed sets are text + CHECK in the migration (no pgEnum) and mirrored in
// `apps/backend/src/modules/06-admission/nomnc/domain.ts`; none implies a CMS rule. PHI-bearing: three-column
// tenancy, FORCEd RLS, write-audit triggers that scrub every name and free-text note.
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  date,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { users } from "../users";
import { admissions } from "./admissions";

export const nomncNotices = pgTable(
  "nomnc_notice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated)
    admissionId: uuid("admission_id")
      .notNull()
      .references(() => admissions.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("active"), // active | superseded | withdrawn
    servicesEndOn: date("services_end_on", { mode: "string" }).notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull(),
    deliveredByUserId: uuid("delivered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    recipientKind: text("recipient_kind").notNull(), // beneficiary | representative
    representativeName: text("representative_name"),
    deliveryNote: text("delivery_note"),
    acknowledgementKind: text("acknowledgement_kind"), // signed | refused | other
    acknowledgementNote: text("acknowledgement_note"),
    documentId: uuid("document_id"), // M22 logical FK
    sourceNote: text("source_note").notNull(),
    supersededById: uuid("superseded_by_id"), // self-reference, deferred FK in migration 1230
    withdrawnReason: text("withdrawn_reason"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneActivePerAdmission: uniqueIndex("nomnc_notice_one_active_uq")
      .on(t.admissionId)
      .where(sql`status = 'active'`),
    orgAdmissionIdx: index("nomnc_notice_org_admission_idx").on(
      t.organizationId,
      t.admissionId,
      t.createdAt,
    ),
  }),
);

export const expeditedReviews = pgTable(
  "expedited_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(),
    admissionId: uuid("admission_id")
      .notNull()
      .references(() => admissions.id, { onDelete: "restrict" }),
    nomncNoticeId: uuid("nomnc_notice_id")
      .notNull()
      .references(() => nomncNotices.id, { onDelete: "restrict" }),
    state: text("state").notNull().default("open"), // open | decided | withdrawn
    qioName: text("qio_name").notNull(),
    qioReference: text("qio_reference"),
    qioNotifiedAt: timestamp("qio_notified_at", { withTimezone: true }).notNull(),
    requestedByKind: text("requested_by_kind").notNull(), // beneficiary | representative | unknown
    dencDeliveredAt: timestamp("denc_delivered_at", { withTimezone: true }),
    dencDocumentId: uuid("denc_document_id"),
    recordsSentAt: timestamp("records_sent_at", { withTimezone: true }),
    recordsSentNote: text("records_sent_note"),
    decisionOutcome: text("decision_outcome"), // discharge_upheld | discharge_reversed | other
    decisionReceivedAt: timestamp("decision_received_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    decisionDocumentId: uuid("decision_document_id"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    onePerNotice: uniqueIndex("expedited_review_one_per_notice").on(t.nomncNoticeId),
    orgAdmissionIdx: index("expedited_review_org_admission_idx").on(t.organizationId, t.admissionId),
  }),
);

export const expeditedDeadlines = pgTable(
  "expedited_deadline",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(),
    admissionId: uuid("admission_id")
      .notNull()
      .references(() => admissions.id, { onDelete: "restrict" }),
    nomncNoticeId: uuid("nomnc_notice_id").references(() => nomncNotices.id, {
      onDelete: "restrict",
    }),
    expeditedReviewId: uuid("expedited_review_id").references(() => expeditedReviews.id, {
      onDelete: "restrict",
    }),
    kind: text("kind").notNull(), // appeal_request | denc_delivery | records_to_qio | qio_decision | other
    label: text("label"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    /** What the person typed, `YYYY-MM-DDTHH:MM` in `zone`; echoed back so the screen shows exactly that. */
    dueLocal: text("due_local").notNull(),
    zone: text("zone").notNull(),
    sourceNote: text("source_note").notNull(),
    noticeDocumentId: uuid("notice_document_id"),
    satisfiedAt: timestamp("satisfied_at", { withTimezone: true }),
    lastAlertedBoundaryHours: integer("last_alerted_boundary_hours"),
    overdueAlertedAt: timestamp("overdue_alerted_at", { withTimezone: true }),
    createdByMembershipId: uuid("created_by_membership_id"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    openIdx: index("expedited_deadline_open_idx")
      .on(t.organizationId, t.dueAt)
      .where(sql`satisfied_at IS NULL`),
    admissionIdx: index("expedited_deadline_admission_idx").on(t.organizationId, t.admissionId),
  }),
);

export type NomncNoticeRow = typeof nomncNotices.$inferSelect;
export type ExpeditedReviewRow = typeof expeditedReviews.$inferSelect;
export type ExpeditedDeadlineRow = typeof expeditedDeadlines.$inferSelect;
