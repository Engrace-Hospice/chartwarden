import { sql } from "drizzle-orm";
// @chartwarden/db — `document` (M22 §3.3). The document aggregate root: one row per materialized
// artifact (rendered form, uploaded file, intake source, consent capture). The current bytes live
// in `document_version` (append-only); `active_version_id` is the single source of "current".
//
// PHI-bearing by the three-column rule (it carries `patient_id`) → ARCH-011: the three tenancy
// columns are present. `patient_id` is nullable (a document may be org-level — e.g. a template
// preview or an intake source before patient attachment), so `provider_entity_id` / `location_id`
// are likewise nullable (the "org-level entity" carve-out, check-tenancy.ts). Cross-module logical
// FKs (M5 patient, M6 admission, owning-module aggregate) are plain uuid app-validated
// (M22 dependsOn [1,5]); only the org spine carries a SQL FK. `active_version_id` is a deferred
// self-reference to `document_version` (populated immediately after v1 insert) — plain uuid, no FK,
// to avoid the circular FK with document_version.document_id.
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  documentAggregateType,
  documentRetentionClass,
  documentSourceKind,
  documentStatus,
} from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const documents = pgTable(
  "document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    // ARCH-011 three-column rule: nullable here because a document may be org-level (no patient
    // yet attached) — the "org-level entity" carve-out for the field-service tenancy columns.
    patientId: uuid("patient_id"), // app-side FK to M5
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id),
    locationId: uuid("location_id").references(() => locations.id),

    admissionId: uuid("admission_id"), // app-side FK to M6
    retentionClass: documentRetentionClass("retention_class").notNull(),
    sourceKind: documentSourceKind("source_kind").notNull(),
    aggregateType: documentAggregateType("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id"), // app-side FK; nullable for some intake_source
    title: text("title").notNull(), // DENYLISTED (§3.6) — may carry patient name
    patientFacing: boolean("patient_facing").notNull().default(false),
    attachToDisclosures: boolean("attach_to_disclosures").notNull().default(false),
    // set true when a media_release consent is revoked and prior-rendered media is located
    // (m22.media.disclosure_restricted, §4.10).
    disclosureRestricted: boolean("disclosure_restricted").notNull().default(false),
    // non-PHI render/integrity metadata: { sudRedacted?, observationId?, ... } (D20/D23, W-M22-23).
    metadata: jsonb("metadata"),
    status: documentStatus("status").notNull().default("active"),
    // populated immediately after v1 insert; the single source of "current version" (there is no
    // per-version is_current flag). Plain uuid — deferred self-reference, no FK (avoids the cycle).
    activeVersionId: uuid("active_version_id"),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgPatient: index("document_org_patient_idx").on(t.organizationId, t.patientId),
    byOrgAggregate: index("document_org_aggregate_idx").on(
      t.organizationId,
      t.aggregateType,
      t.aggregateId,
    ),
    byRetention: index("document_retention_idx").on(t.retentionClass, t.status),
    patientFacingIdx: index("document_patient_facing_idx")
      .on(t.organizationId, t.patientId)
      .where(sql`patient_facing = true`),
    legalHoldIdx: index("document_legal_hold_idx")
      .on(t.organizationId)
      .where(sql`status = 'legal_hold'`),
    attachDisclosuresIdx: index("document_attach_disclosures_idx")
      .on(t.organizationId, t.patientId)
      .where(sql`attach_to_disclosures = true`),
  }),
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
