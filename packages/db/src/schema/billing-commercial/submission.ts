// @chartwarden/db — M41 Billing - Commercial: the submission (migration 1274). One logical send of a claim through the platform
// ClearinghouseTransport. Carries ids, codes and times only (the rendered 837I is never stored). Three-column rule, canonical
// app.org_id RLS (FORCEd) and a write-audit trigger in the migration; a claim has at most one live submission (partial unique index).
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const commercialSubmissions = pgTable(
  "commercial_submission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id").notNull(), // composite FK (claim_id, organization_id) in the migration
    idempotencyKey: text("idempotency_key").notNull(),
    controlNumber: text("control_number").notNull(),
    // X12 ISA13, assigned from a cycling 9-digit sequence at insert so a retry renders the same payload.
    interchangeControlNumber: bigint("interchange_control_number", { mode: "number" })
      .notNull()
      .default(sql`nextval('commercial_submission_icn_seq')`),
    clearinghouseKey: text("clearinghouse_key").notNull(),
    clearinghousePayerId: text("clearinghouse_payer_id").notNull(),
    status: text("status").notNull().default("queued"), // CommercialSubmissionStatus
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastFailureCode: text("last_failure_code"),
    clearinghouseSubmissionId: text("clearinghouse_submission_id"),
    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // The stamp the 837I carries; a re-submission copies it (and the interchange number) from the claim's first submission.
    payloadStamp: timestamp("payload_stamp", { withTimezone: true }).notNull().defaultNow(),
    // Set just before the transport call; cleared on a DEFINITE answer. Still set at the next lease = an interrupted, ambiguous attempt.
    transportCallStartedAt: timestamp("transport_call_started_at", { withTimezone: true }),
    ambiguous: boolean("ambiguous").notNull().default(false),
    resolution: text("resolution"), // receipt | acknowledgment | operator_confirmed | operator_not_received
    // migration 1275: the first clearinghouse-stage acceptance. Never advances the claim to `accepted` (ADR-0053 D2).
    clearinghouseAcceptedAt: timestamp("clearinghouse_accepted_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byClaim: index("commercial_submission_claim_ix").on(t.claimId, t.requestedAt),
    byOrg: index("commercial_submission_org_ix").on(t.organizationId),
    byControl: index("commercial_submission_control_ix").on(t.organizationId, t.controlNumber),
  }),
);

export type CommercialSubmission = typeof commercialSubmissions.$inferSelect;
