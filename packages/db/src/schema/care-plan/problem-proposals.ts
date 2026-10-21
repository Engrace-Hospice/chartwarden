// @chartwarden/db — `problem_proposal` (M7, F-238 dx-writeback). A DocLens-extracted, reviewer-attested
// diagnosis waiting for a clinician. Deliberately a SEPARATE table from `problem`: nothing that reads
// `problem` (M23 claim sequencing through the claim-diagnoses gate, HOPE, the IDG packet, the portal,
// version snapshots, the encounter picker) can see a proposal, so an unaccepted AI-extracted diagnosis can
// never count as a charted one (AI Governance v0.2 §2.1.1; M22 D5). Accepting creates the `problem` row
// (`source = 'intake_extraction'`, `kind` chosen by the clinician) and links it via `accepted_problem_id`.
//
// PHI-bearing → three-column tenancy (siting nullable, inherited from the plan like `problem`, mig 0127).
// `patient_id` is the plan's patient (plain uuid, app-validated — M7 takes no M5 FK), denormalized for the
// per-patient dedupe index. `description` / `dismiss_reason` are free text → denylisted in the M4 audit
// trigger. RLS + grants + trigger land in migration 0310.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  problemProposalDocumentRole,
  problemProposalIcd10Validation,
  problemProposalStatus,
} from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { carePlans } from "./care-plans";
import { problems } from "./problems";

export const problemProposals = pgTable(
  "problem_proposal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    carePlanId: uuid("care_plan_id")
      .notNull()
      .references(() => carePlans.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    description: text("description").notNull(), // DENYLISTED in the audit trigger
    /** As printed in the source document, or as typed by the DocLens reviewer — never model-suggested. */
    icd10Code: text("icd10_code"),
    /** 'document' | 'reviewer_edit' (CHECK) — set iff `icd10_code` is. */
    icd10Source: text("icd10_source"),
    icd10Validation: problemProposalIcd10Validation("icd10_validation"),
    documentRole: problemProposalDocumentRole("document_role").notNull().default("unspecified"),
    sudRelated: boolean("sud_related").notNull().default(false),
    status: problemProposalStatus("status").notNull().default("pending"),
    dedupeKey: text("dedupe_key").notNull(),
    /** The completed M22 `extraction_review` (plain uuid — M7 takes no M22 FK). */
    sourceExtractionCommitId: uuid("source_extraction_commit_id").notNull(),
    sourceItemKey: text("source_item_key").notNull(),
    sourceIntakeBatchId: uuid("source_intake_batch_id").notNull(),
    attestedByMembershipId: uuid("attested_by_membership_id").references(() => memberships.id),
    /** An ACTIVE problem with the same code at proposal time — flagged for the clinician, never merged. */
    duplicateOfProblemId: uuid("duplicate_of_problem_id").references(() => problems.id, {
      onDelete: "restrict",
    }),
    acceptedProblemId: uuid("accepted_problem_id").references(() => problems.id, {
      onDelete: "restrict",
    }),
    decidedByMembershipId: uuid("decided_by_membership_id").references(() => memberships.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    dismissReason: text("dismiss_reason"), // DENYLISTED in the audit trigger
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceItemUq: uniqueIndex("problem_proposal_source_item_uq").on(
      t.organizationId,
      t.sourceExtractionCommitId,
      t.sourceItemKey,
    ),
    pendingDedupeUq: uniqueIndex("problem_proposal_pending_dedupe_uq")
      .on(t.organizationId, t.patientId, t.dedupeKey)
      .where(sql`status = 'pending'`),
    planStatusIdx: index("problem_proposal_plan_status_idx").on(
      t.organizationId,
      t.carePlanId,
      t.status,
    ),
    decisionShape: check(
      "problem_proposal_decision_shape",
      sql`(status = 'pending' AND decided_by_membership_id IS NULL AND decided_at IS NULL AND accepted_problem_id IS NULL)
        OR (status = 'accepted' AND decided_by_membership_id IS NOT NULL AND decided_at IS NOT NULL AND accepted_problem_id IS NOT NULL)
        OR (status = 'dismissed' AND decided_by_membership_id IS NOT NULL AND decided_at IS NOT NULL AND accepted_problem_id IS NULL)`,
    ),
    codeShape: check(
      "problem_proposal_code_shape",
      sql`(icd10_code IS NULL AND icd10_source IS NULL AND icd10_validation IS NULL)
        OR (icd10_code IS NOT NULL AND icd10_source IN ('document', 'reviewer_edit') AND icd10_validation IS NOT NULL)`,
    ),
  }),
);

export type ProblemProposal = typeof problemProposals.$inferSelect;
export type NewProblemProposal = typeof problemProposals.$inferInsert;
