// @chartwarden/db — `fhir_inbound_resource` (M28 §3.3). A staged inbound FHIR resource (D8): an external
// client POSTs a resource, M28 stages it as a PROPOSAL, and the owner module's reviewer (M5 / M12)
// accepts or rejects it — M28 never writes a native record itself. The §2.2 staged-proposal FSM lives in
// `proposal_status`; a `rejected` needs a ≥40-char rationale and shreds `payload` at +30 days, while an
// `accepted` proposal KEEPS its payload (the owner module now owns the native row).
//
// PARTITIONED, so the composite primary key `(id, proposed_at)` is declared in SQL (migration 0136) — see
// the M32 `ai_invocation` precedent for why the audit trigger on the parent must be a GENERATED function
// that hard-codes the parent name.
//
// PHI-BEARING but by the tenancy gate's own heuristic it is NOT (no `patient_id` / `observation` column) —
// the raw FHIR resource lives in the opaque `payload` jsonb, which is §3.6-denylisted to its
// `payload_sha256` until proposal-decision time. TENANT-SCOPED: `organization_id` NOT NULL on canonical
// app.org_id RLS (§3.5). `source_client_id` / `decided_by_membership_id` / `accepted_aggregate_id` are
// LOGICAL uuids validated at the write boundary.
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { fhirInboundOwnerModule, fhirInboundStatus } from "../../enums";

export const fhirInboundResource = pgTable(
  "fhir_inbound_resource",
  {
    // Composite PK (id, proposed_at) declared in SQL (0136) — see header.
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    sourceClientId: uuid("source_client_id").notNull(),
    resourceType: text("resource_type").notNull(),
    /** The consumer's claimed id for the resource. */
    sourceFhirId: text("source_fhir_id"),
    /** The raw FHIR resource — §3.6-denylisted; only `payload_sha256` enters the audit value_capture. */
    payload: jsonb("payload").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(), // PARTITION KEY
    ownerModule: fhirInboundOwnerModule("owner_module").notNull(),
    proposalStatus: fhirInboundStatus("proposal_status").notNull().default("pending"),
    decidedByMembershipId: uuid("decided_by_membership_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** ≥40 chars on reject (§2.3). */
    decisionRationale: text("decision_rationale"),
    acceptedAggregateId: uuid("accepted_aggregate_id"),
    validationErrors: jsonb("validation_errors"),
    /** GAP-198 (0490): the WardenX patient the proposal is about, stamped at staging; NULL = no chart. */
    subjectPatientId: uuid("subject_patient_id"),
    payloadEraseScheduledAt: timestamp("payload_erase_scheduled_at", { withTimezone: true }),
  },
  (t) => ({
    orgIdx: index("fhir_inbound_org_idx").on(t.organizationId, t.proposalStatus, t.proposedAt),
    ownerIdx: index("fhir_inbound_owner_idx").on(t.ownerModule, t.proposalStatus),
    dedupIdx: index("fhir_inbound_dedup_idx").on(t.sourceClientId, t.resourceType, t.sourceFhirId),
  }),
);
// Partition by RANGE (proposed_at) monthly per M4 §3.6.

export type FhirInboundResourceRow = typeof fhirInboundResource.$inferSelect;
export type NewFhirInboundResourceRow = typeof fhirInboundResource.$inferInsert;
