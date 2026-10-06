import { sql } from "drizzle-orm";
// @wardenx/db — `claim` (M23 Billing-Medicare §3.3, D4/D14; retention class `compliance`).
// The Medicare-claim root: one row per hospice claim (TOB 811/812/813/814 + 817/818 replacements).
// The XState lifecycle (D4) lives in `state`; `claim_control_number` is the deterministic per-D4
// identifier. ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS).
//
// PARTITIONING (declared in the SQL migration 0074+, NOT in Drizzle — Drizzle only carries the
// columns/indexes/types): LIST-partitioned on provider_entity_id, then each PE leaf sub-partitioned
// by created-at RANGE QUARTERLY (spec §3.2 Phase B / §3.3 header). The migration agent MUST emit the
// list-then-range quarterly partition DDL + register the table with M4's partition rotation manager
// (spec §3.2 Phase F). Drizzle's pgTable below is the logical shape only.
//
// CROSS-MODULE FK POLICY (architecture WINS over the spec DDL): cross-module FK constraints are
// FORBIDDEN. Only `organization_id` (core) and intra-M23 parents get real `.references(...)`.
// `provider_entity_id` (M40), `patient_id`/`patient_payer_id` (M5), `admission_id`/election ids (M6),
// `*_membership_id` (core memberships), and all latest_*/replaces/replaced-by pointers are LOGICAL
// FKs — plain uuid, validated at runtime (mirrors the M27 cost-report precedent). No MBI is ever
// stored here (D13, §8.7).
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { m23ClaimState, m23ClaimTob, m23MacJurisdiction } from "./types";

export const claim = pgTable(
  "claim",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK → M40

    // Logical FKs (validated at runtime; cross-module FK constraints are forbidden by architecture):
    patientId: uuid("patient_id").notNull(), // M5
    admissionId: uuid("admission_id").notNull(), // M6
    electionPeriodIdFrom: uuid("election_period_id_from").notNull(), // first period covered
    electionPeriodIdTo: uuid("election_period_id_to").notNull(), // last period covered (may equal _from)
    patientPayerId: uuid("patient_payer_id").notNull(), // M5 patient_payer snapshot at assembly time

    // Claim shell:
    tob: m23ClaimTob("tob").notNull(),
    serviceFrom: date("service_from").notNull(),
    serviceTo: date("service_to").notNull(),
    state: m23ClaimState("state").notNull().default("DRAFT"),

    // Identifiers:
    claimControlNumber: text("claim_control_number").notNull(), // deterministic per D4
    payerClaimControlNumber: text("payer_claim_control_number"), // returned by MAC at 277CA
    macJurisdiction: m23MacJurisdiction("mac_jurisdiction").notNull(),

    // Aggregates (snapshot at assembly):
    totalChargeCents: bigint("total_charge_cents", { mode: "number" }).notNull().default(0),
    totalExpectedPaymentCents: bigint("total_expected_payment_cents", { mode: "number" })
      .notNull()
      .default(0),
    sequestrationAppliedPct: text("sequestration_applied_pct").notNull(), // decimal as text e.g. "2.00"
    sequestrationPolicyId: uuid("sequestration_policy_id").notNull(), // logical FK → sequestration_policy

    // Replacement chain (D14):
    replacesClaimId: uuid("replaces_claim_id"),
    replacedByClaimId: uuid("replaced_by_claim_id"), // back-ref populated when a TOB 817/818 against this lands
    replacementReason: text("replacement_reason"), // ≥40 chars when replaces_claim_id IS NOT NULL

    // Latest validation/submission pointers:
    latestValidationRunId: uuid("latest_validation_run_id"),
    latestSubmissionId: uuid("latest_submission_id"),

    // Discharge claim codes (CMS Pub. 100-04 Ch. 11 §30.3; migration 0371), derived at assembly and refreshed
    // on every re-validation by `deriveDischargeClaimCodes`. `patient_status_code` is UB-04 FL 17 / 837I CL103
    // (NULL = could not be derived; the discharge rule blocks the claim); `condition_codes` FL 18-28 / HI*BG;
    // `occurrence_codes` FL 31-34 / HI*BH as `[{code, date}]`.
    patientStatusCode: text("patient_status_code"),
    conditionCodes: jsonb("condition_codes").$type<string[]>().notNull().default([]),
    occurrenceCodes: jsonb("occurrence_codes")
      .$type<{ code: string; date: string }[]>()
      .notNull()
      .default([]),

    // Document back-ref (populated by m22.document.rendered consumer):
    acknowledgmentDocumentId: uuid("acknowledgment_document_id"), // M22 — set after ACK_ACCEPTED + render

    // Optimistic concurrency + timestamps:
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByMembershipId: uuid("created_by_membership_id").notNull(), // logical FK → memberships
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgPe: index("claim_org_pe_idx").on(t.organizationId, t.providerEntityId),
    patient: index("claim_patient_idx").on(t.organizationId, t.patientId, t.serviceFrom),
    state: index("claim_state_idx").on(t.organizationId, t.state, t.serviceFrom),
    controlNumberUq: uniqueIndex("claim_control_number_uq").on(
      t.providerEntityId,
      t.claimControlNumber,
    ),
    // partial unique: at most one non-superseded claim per (PE, patient, exact from-through) for non-replacement TOBs
    uniqueActiveByRange: uniqueIndex("claim_active_by_range_uq")
      .on(t.providerEntityId, t.patientId, t.serviceFrom, t.serviceTo)
      .where(
        sql`tob IN ('811','812','813','814') AND state NOT IN ('VOIDED','REPLACED','ACK_REJECTED')`,
      ),
    replacesIdx: index("claim_replaces_idx")
      .on(t.replacesClaimId)
      .where(sql`replaces_claim_id IS NOT NULL`),
    serviceDatesValid: sql`CHECK (service_to >= service_from)`,
    replacementRequiresPredecessor: sql`CHECK ((tob IN ('817','818')) = (replaces_claim_id IS NOT NULL))`,
    replacementReasonFloor: sql`CHECK (replaces_claim_id IS NULL OR length(replacement_reason) >= 40)`,
  }),
);

export type Claim = typeof claim.$inferSelect;
export type NewClaim = typeof claim.$inferInsert;
