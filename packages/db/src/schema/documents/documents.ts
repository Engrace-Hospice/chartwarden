// @wardenx/db — `document` (M22 §3.3 / §2.2.1). The document aggregate root: one row per logical document,
// versioned by `document_version` (the active version is pointed at by `active_version_id` — there is no
// per-version is_current flag, F19/§2.2.2). PHI-bearing by the three-column rule (it carries `patient_id`)
// → ARCH-011: provider_entity_id + location_id are present (nullable — a raw `intake_source` upload may be
// stored before patient/admission context is known, matching the nullable `patient_id`/`admission_id`). The
// cross-module logical FKs (M5 patient, M6 admission, the M5/M6/M8/… aggregate the document instantiates) are
// plain uuid app-validated (M22 dependsOn [1,5]); only the tenancy spine carries SQL FKs. `title` may carry a
// patient name → DENYLISTED in the §3.6 write-audit trigger. RLS + grants + the M4 write-audit trigger land
// in the RLS migration (M22-T02 / 0049).
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  documentAggregateType,
  documentRetentionClass,
  documentSourceKind,
  documentStatus,
} from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";

export const documents = pgTable(
  "document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // ARCH-011 three-column rule: PHI-bearing (carries patient_id). Nullable because a raw intake_source
    // upload may be stored before the patient/provider/location context is resolved.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    patientId: uuid("patient_id"), // M5 patient (app-validated; nullable for some intake_source)
    admissionId: uuid("admission_id"), // M6 admission (app-validated; nullable)

    retentionClass: documentRetentionClass("retention_class").notNull(),
    sourceKind: documentSourceKind("source_kind").notNull(),
    aggregateType: documentAggregateType("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id"), // app-validated; nullable for some intake_source

    title: text("title").notNull(), // may carry a patient name → DENYLISTED (§3.6)
    patientFacing: boolean("patient_facing").notNull().default(false),
    attachToDisclosures: boolean("attach_to_disclosures").notNull().default(false),
    // set true when a media_release consent is revoked and prior-rendered media is located
    // (m22.media.disclosure_restricted, §4.10)
    disclosureRestricted: boolean("disclosure_restricted").notNull().default(false),
    // non-PHI render/integrity metadata: { sudRedacted?, ... } (D20/D23, W-M22-23)
    metadata: jsonb("metadata"),

    status: documentStatus("status").notNull().default("active"),
    // populated immediately after v1 insert; the single source of "current version"
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
