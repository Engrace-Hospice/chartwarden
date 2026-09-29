// @wardenx/db — `incident_report` (M30 §3.3; PARTITIONED monthly by `occurred_at`; retention class
// `phi`). The safety-incident ledger (falls, med errors, complaints, abuse allegations, exposures),
// with a per-kind TypeBox payload, triage/investigation lifecycle, and mandatory-report tracking.
// Registers a §3.7 eraser. ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS).
//
// THREE-COLUMN RULE (ARCH-011): incident_report carries a bare `patient_id` (PHI signal), so it carries
// `provider_entity_id` + `location_id` (architecture wins over the §3.3 column list, which omits
// location_id). patient_id + location_id are nullable (visitor/staff incidents are not patient-scoped).
// Cross-module refs (M5 patient, M40 provider_entity, M1 location, linked QAPI project, M22 document)
// are logical FKs (plain uuid, app-validated). The free-text members of `kind_data` (narrativeText /
// witnessNames / patientQuote / staffQuote) are audit-denylisted (§3.6).
//
// PARTITION BY RANGE (occurred_at) monthly: the Drizzle definition is the LOGICAL shape (composite PK
// incl. the partition key); the PARTITION BY + monthly children + DEFAULT catch-all land in the
// tables/RLS migration. The auto-creation idempotency backstop (uq on triggering_event_outbox_id) is a
// partial-UNIQUE that OMITS the partition key, so it cannot live on the partitioned PARENT — declared
// as a plain non-unique index here and re-added as a per-LEAF partial-UNIQUE in the migration (the EVV
// `evv_event` precedent).
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import type { IncidentKindData } from "./types";

export const m30IncidentKind = pgEnum("m30_incident_kind", [
  "fall",
  "medication_error",
  "complaint",
  "allegation_of_abuse",
  "exposure_event",
  "other_safety_event",
  // F-185 (#248) — M37 `m37.restraint.applied` auto-files a `restraint_use` draft (thin-pointer payload:
  // restraintEventId + restraintKind + an auto-generated narrativeText; see `../../../quality/src/
  // incidents/auto_creator.ts`).
  "restraint_use",
]);

export const m30IncidentSeverity = pgEnum("m30_incident_severity", [
  "minor",
  "moderate",
  "severe",
  "critical",
]);

export const m30IncidentLifecycle = pgEnum("m30_incident_lifecycle", [
  "draft",
  "submitted",
  "triaged",
  "under_investigation",
  "resolved",
  "closed_followup_complete",
  "reopened",
]);

export const incidentReport = pgTable(
  "incident_report",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with occurred_at (partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK to M40 (ARCH-011)
    // ARCH-011 three-column rule: location_id present (nullable — visitor/staff incidents are not
    // location-scoped). Logical FK to M1 location (app-validated).
    locationId: uuid("location_id"),
    kind: m30IncidentKind("kind").notNull(), // V-14
    kindData: jsonb("kind_data").$type<IncidentKindData>().notNull(), // per-kind TypeBox; free-text DENYLISTED (§3.6)
    patientId: uuid("patient_id"), // logical FK to M5 (nullable for visitor/staff incidents)
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(), // partition key
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    reportedByMembershipId: uuid("reported_by_membership_id").notNull(),
    severity: m30IncidentSeverity("severity").notNull(),
    lifecycle: m30IncidentLifecycle("lifecycle").notNull().default("draft"),
    mandatoryReportFlag: boolean("mandatory_report_flag").notNull().default(false), // V-15
    externalReportRef: text("external_report_ref"),
    externalReportFiledAt: timestamp("external_report_filed_at", { withTimezone: true }),
    correctiveActionTakenText: text("corrective_action_taken_text"),
    linkedQapiProjectId: uuid("linked_qapi_project_id"),
    triagedByMembershipId: uuid("triaged_by_membership_id"),
    triagedAt: timestamp("triaged_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    reopenedAt: timestamp("reopened_at", { withTimezone: true }),
    reopenReason: text("reopen_reason"),
    triggeringEventOutboxId: uuid("triggering_event_outbox_id"), // idempotency for auto-creation
    documentId: uuid("document_id"), // M22 back-ref
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.occurredAt] }), // partition key must be in the PK
    // Auto-creation idempotency: a partial-UNIQUE on (triggering_event_outbox_id) that OMITS the
    // partition key cannot live on the partitioned PARENT — declared plain here; the per-LEAF
    // partial-UNIQUE `uq_incident_auto_creation` (WHERE triggering_event_outbox_id IS NOT NULL) lands
    // in the migration (EVV per-leaf precedent).
    byAutoCreation: index("idx_incident_auto_creation").on(t.triggeringEventOutboxId),
    byPatient: index("idx_incident_by_patient").on(t.patientId, t.occurredAt),
    byOpenForOrg: index("idx_incident_open_for_org")
      .on(t.organizationId, t.severity)
      .where(sql`lifecycle NOT IN ('closed_followup_complete')`),
  }),
);

export type IncidentReport = typeof incidentReport.$inferSelect;
export type NewIncidentReport = typeof incidentReport.$inferInsert;
