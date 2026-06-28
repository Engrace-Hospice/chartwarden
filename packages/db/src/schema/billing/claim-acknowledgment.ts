// @wardenx/db — `claim_acknowledgment` (M23 Billing-Medicare §3.3; non-partitioned; retention class
// `compliance`). Append-only: one row per inbound 999 / 277CA / 835 acknowledgment file processed for a
// submission. ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS).
//
// CROSS-MODULE FK POLICY (architecture WINS over the spec DDL): cross-module FK constraints are
// FORBIDDEN. Only `organization_id` (core) and the intra-M23 parents `submission_id` (claim_submission)
// + `claim_id` (claim, back-link) get real `.references(...)`. No PHI / MBI is ever stored here
// (D13, §8.7); `parsed_payload` carries only X12 status / reason codes (typed loosely at the DB layer —
// the deep per-kind shape is TypeBox-typed in `@wardenx/billing` P2).
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../organizations";
import { claim } from "./claim";
import { claimSubmission } from "./claim-submission";
import { m23ClaimAcknowledgmentKind, m23MacJurisdiction } from "./types";

// claim_acknowledgment.parsed_payload — parsed 999/277CA/835 result, typed by `kind` at the service
// layer (`@wardenx/billing` P2). Opaque at the DB layer; NEVER contains PHI/MBI (D13, §8.7).
// NOTE FOR INTEGRATE: the kernel `types.ts` is the canonical home for jsonb helper types — relocate
// this `ClaimAcknowledgmentParsedPayload` interface there (it was not present in the kernel report).
export interface ClaimAcknowledgmentParsedPayload {
  [key: string]: unknown;
}

export const claimAcknowledgment = pgTable(
  "claim_acknowledgment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => claimSubmission.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id").references(() => claim.id, { onDelete: "restrict" }), // back-link for fast claim->acks lookup

    kind: m23ClaimAcknowledgmentKind("kind").notNull(),
    macJurisdiction: m23MacJurisdiction("mac_jurisdiction").notNull(),

    ackFileUri: text("ack_file_uri").notNull(), // MinIO path to the raw 999/277CA/835 file
    ackReceivedAt: timestamp("ack_received_at", { withTimezone: true }).notNull(),
    parsedAt: timestamp("parsed_at", { withTimezone: true }).notNull().defaultNow(),

    // Parsed payload (typed by kind at the service layer):
    parsedPayload: jsonb("parsed_payload")
      .$type<ClaimAcknowledgmentParsedPayload>()
      .notNull(), // { status, reasonCodes, lineLevelResults?, ... }

    // High-level outcome cached for index:
    outcomeStatus: text("outcome_status").notNull(), // 'accepted'|'rejected'|'partial'|'paid'|'denied'

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fileUq: uniqueIndex("claim_ack_file_uq").on(t.macJurisdiction, t.ackFileUri),
    claimRecent: index("claim_ack_claim_recent_idx")
      .on(t.claimId, t.ackReceivedAt)
      .where(sql`claim_id IS NOT NULL`),
    submission: index("claim_ack_submission_idx").on(t.submissionId),
    // §3.4 — denial-worklist hand-off to M25 (only the negative-outcome slice):
    outcomePartial: index("claim_acknowledgment_outcome_partial")
      .on(t.organizationId, t.claimId, t.outcomeStatus)
      .where(sql`outcome_status IN ('rejected','partial','denied')`),
  }),
);

export type ClaimAcknowledgment = typeof claimAcknowledgment.$inferSelect;
export type NewClaimAcknowledgment = typeof claimAcknowledgment.$inferInsert;
