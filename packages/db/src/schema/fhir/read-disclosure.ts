// @chartwarden/db — `fhir_read_disclosure` (M28, F-035). The 45 CFR §164.528 accounting ledger: one row per
// FHIR read SERVED to an external client, recording who read what, about whom, and when.
//
// The Phase-1 gateway served nothing, so no disclosure existed to account for and the M30 scorecard's
// zero was true. Binding the read path (#95) inverts that — a gateway that hands PHI to a third party
// while its accounting seam answers zero is publishing a false compliance statement, not failing closed.
//
// TENANT-SCOPED: `organization_id` NOT NULL on canonical app.org_id RLS (§3.5). APPEND-ONLY BY GRANT —
// `chartwarden_app` holds SELECT + INSERT and nothing else (migration 0233), so the ledger cannot be edited
// or deleted by the application role that writes it. Retention is `compliance` (six years, §164.530(j)),
// NOT the `operational` 90 days its sibling `fhir_client_session` carries, which is also why this table
// is deliberately UNPARTITIONED: partitioning exists there to make a routine purge cheap, and nothing
// here is ever purged.
//
// `client_id` is a LOGICAL uuid, no FK: a disclosure record must outlive the client that made it (a
// revoked and later erased partner does not erase the accounting owed to the patients it read). The
// §3.6 denylist is empty — the ledger holds no narrative, payload or cipher — so it audits through M1's
// baseline `chartwarden_audit_trigger()`.
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const fhirReadDisclosure = pgTable(
  "fhir_read_disclosure",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    /** Logical uuid → `fhir_client.id` (see header: no FK, deliberately). */
    fhirClientId: uuid("fhir_client_id").notNull(),
    resourceType: text("resource_type").notNull(),
    /** The disclosed subject. NULL only for a type-level search that named no patient. */
    patientId: uuid("patient_id"),
    /** The NORMALIZED parameter map the route assembled — never the raw query string (§164.528). */
    queryParameters: jsonb("query_parameters").notNull().default({}),
    resultCount: integer("result_count").notNull(),
    servedAt: timestamp("served_at", { withTimezone: true }).notNull(),
    /** Set when a staff member initiated the read (a bulk export); NULL when the client is the actor. */
    initiatedByMembershipId: uuid("initiated_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("fhir_read_disclosure_org_served_idx").on(t.organizationId, t.servedAt),
    clientIdx: index("fhir_read_disclosure_client_idx").on(
      t.organizationId,
      t.fhirClientId,
      t.servedAt,
    ),
    patientIdx: index("fhir_read_disclosure_patient_idx").on(
      t.organizationId,
      t.patientId,
      t.servedAt,
    ),
  }),
);

export type FhirReadDisclosureRow = typeof fhirReadDisclosure.$inferSelect;
export type NewFhirReadDisclosureRow = typeof fhirReadDisclosure.$inferInsert;
