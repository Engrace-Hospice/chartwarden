// @wardenx/db — `claim_submission` (M23 Billing-Medicare §3.3; non-partitioned; retention class
// `compliance`). Append-only: one row per dispatch attempt of an 837I claim, an NOE, or an NOTR to the
// MAC (via the x12-837-client sidecar / portal). ORG-SCOPED: organization_id NOT NULL (canonical
// app.org_id RLS).
//
// CROSS-MODULE FK POLICY (architecture WINS over the spec DDL): cross-module FK constraints are
// FORBIDDEN. Only `organization_id` (core) and `claim_id` (intra-M23 parent) get real `.references(...)`.
// `provider_entity_id` (M40), and `noe_id`/`notr_id` (intra-M23 pointers populated by subject kind) are
// LOGICAL FKs — plain uuid, validated at runtime (mirrors the M27 cost-report precedent). No PHI / MBI
// is ever stored here (D13, §8.7).
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../organizations";
import { claim } from "./claim";
import { m23ClaimSubmissionKind, m23ClaimSubmissionOutcome } from "./types";

export const claimSubmission = pgTable(
  "claim_submission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK → M40

    kind: m23ClaimSubmissionKind("kind").notNull(), // claim_837i | noe | notr
    claimId: uuid("claim_id").references(() => claim.id, { onDelete: "restrict" }), // NULL for noe/notr
    noeId: uuid("noe_id"), // logical FK → noe_record; populated when kind='noe'
    notrId: uuid("notr_id"), // logical FK → notr_record; populated when kind='notr'

    claimControlNumber: text("claim_control_number").notNull(),
    attemptIndex: integer("attempt_index").notNull(),

    outcome: m23ClaimSubmissionOutcome("outcome").notNull().default("queued"),
    outcomeReason: text("outcome_reason"), // populated for failed_* outcomes

    generatedFileUri: text("generated_file_uri"), // MinIO path to the 837I/NOE/NOTR file
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    workerCorrelationId: text("worker_correlation_id"), // x12-837-client request id

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    controlAttemptUq: uniqueIndex("claim_submission_control_attempt_uq").on(
      t.providerEntityId,
      t.claimControlNumber,
      t.attemptIndex,
    ),
    claimIdx: index("claim_submission_claim_idx").on(t.claimId).where(sql`claim_id IS NOT NULL`),
    exactlyOneSubject: sql`CHECK ((claim_id IS NOT NULL)::int + (noe_id IS NOT NULL)::int + (notr_id IS NOT NULL)::int = 1)`,
    kindMatchesSubject: sql`CHECK (
    (kind = 'claim_837i' AND claim_id IS NOT NULL) OR
    (kind = 'noe' AND noe_id IS NOT NULL) OR
    (kind = 'notr' AND notr_id IS NOT NULL)
  )`,
  }),
);

export type ClaimSubmission = typeof claimSubmission.$inferSelect;
export type NewClaimSubmission = typeof claimSubmission.$inferInsert;
