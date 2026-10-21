// @chartwarden/db — `fhir_bulk_export_job` (M28 §3.3). One row per `$export` (system / Group / Patient); the
// §2.2 async-export FSM lives in `status`. `accepted` + `in_progress` hold the §2.5 per-client
// concurrency lock (a further request is a 429); `completed` mints output URLs with a 24h TTL (W-FHIR-04).
//
// TENANT-SCOPED: `organization_id` NOT NULL on canonical app.org_id RLS (§3.5). The request envelope is
// metadata (the empty §3.6 denylist) so it audits through M1's baseline `chartwarden_audit_trigger()` — a
// `compliance` retention row that reconstructs a bulk disclosure long after the NDJSON is gone. `patient_ids`
// / `group_id` / `client_id` / `initiated_by_membership_id` are LOGICAL uuids validated at the write boundary.
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { fhirBulkExportRequestKind, fhirBulkExportStatus } from "../../enums";

export const fhirBulkExportJob = pgTable(
  "fhir_bulk_export_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    clientId: uuid("client_id").notNull(),
    requestKind: fhirBulkExportRequestKind("request_kind").notNull(),
    /** When request_kind='group'. */
    groupId: uuid("group_id"),
    /** When request_kind='patient'; string[]. */
    patientIds: jsonb("patient_ids"),
    /** string[] — the resource types requested. */
    resourceTypes: jsonb("resource_types").notNull(),
    sinceIso: timestamp("since_iso", { withTimezone: true }),
    /** sha256 of the normalized request envelope — the §2.6 dedup key. */
    requestEnvelopeSha256: text("request_envelope_sha256").notNull(),
    status: fhirBulkExportStatus("status").notNull().default("accepted"),
    totalResources: integer("total_resources"),
    artifactCount: integer("artifact_count"),
    failureReason: text("failure_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Null when initiated by the FHIR client itself (vs an operator-initiated export). */
    initiatedByMembershipId: uuid("initiated_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    clientIdx: index("fhir_bulk_export_client_idx").on(t.clientId, t.status),
    orgIdx: index("fhir_bulk_export_org_idx").on(t.organizationId, t.createdAt),
    expiryIdx: index("fhir_bulk_export_expiry_idx").on(t.expiresAt),
    dedupIdx: index("fhir_bulk_export_dedup_idx").on(
      t.clientId,
      t.requestEnvelopeSha256,
      t.createdAt,
    ),
  }),
);

export type FhirBulkExportJobRow = typeof fhirBulkExportJob.$inferSelect;
export type NewFhirBulkExportJobRow = typeof fhirBulkExportJob.$inferInsert;
