// @chartwarden/db — `eligibility_check` (M23 Billing-Medicare §3.3, D13; non-partitioned; retention class
// `operational`). Append-only: one row per HETS 270/271 eligibility round-trip. The §11.A
// eligibility-freshness rule reads the most-recent active/inactive check per patient (≤30 days old via
// stale_at = checked_at + 30d). ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS).
//
// CROSS-MODULE FK POLICY (architecture WINS over the spec DDL): only organization_id (core) gets a real
// `.references(...)`. provider_entity_id (M40) and patient_id (M5) are LOGICAL FKs — plain uuid,
// validated at runtime (mirrors the M27 cost-report precedent).
//
// NO MBI / NO PHI in parsed_payload (D13, §3.6, §8.7): the MBI submitted to HETS is NEVER persisted; the
// parsed 271 payload carries only coverage flags + a MinIO ref to the raw response file.
//
// §3.4 EXTRA INDEX (eligibility_check_recent_per_patient: partial on (organization_id, patient_id,
// checked_at DESC) WHERE outcome IN ('active_part_a','inactive_part_a')) is a migration-phase concern —
// the kernel exemplar (claim.ts) likewise leaves the §3.4 extras to the SQL migration (0074+).
import { date, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { m23EligibilityOutcome } from "./types";

// MISSING-FROM-KERNEL helper type — declared locally pending the integrate phase hoisting it into
// types.ts as `EligibilityCheckParsedPayload` (the parsed HETS 271 response; opaque at the DB layer,
// typed precisely at the service layer in @chartwarden/billing P2; MBI is NEVER a field here):
//   { partAActive: boolean; planEffective?: string; planEnd?: string; otherCoverages?: unknown[]; raw271Ref?: string }
interface EligibilityCheckParsedPayload {
  [key: string]: unknown;
}

export const eligibilityCheck = pgTable(
  "eligibility_check",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK → M40

    patientId: uuid("patient_id").notNull(), // logical FK → M5
    asOfServiceDate: date("as_of_service_date").notNull(), // the date the check was for

    outcome: m23EligibilityOutcome("outcome").notNull(),
    // Parsed response payload (typed; MBI is NEVER persisted here):
    parsedPayload: jsonb("parsed_payload").$type<EligibilityCheckParsedPayload>().notNull(),

    rawResponseFileUri: text("raw_response_file_uri"), // MinIO path; not always present (some responses are inline)
    workerCorrelationId: text("worker_correlation_id"),

    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    staleAt: timestamp("stale_at", { withTimezone: true }).notNull(), // checkedAt + 30 days
  },
  (t) => ({
    patientRecent: index("eligibility_check_patient_recent_idx").on(
      t.organizationId,
      t.patientId,
      t.checkedAt,
    ),
    staleScan: index("eligibility_check_stale_idx").on(t.organizationId, t.staleAt),
  }),
);

export type EligibilityCheck = typeof eligibilityCheck.$inferSelect;
export type NewEligibilityCheck = typeof eligibilityCheck.$inferInsert;
