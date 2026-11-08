// Account-wide identity results remain internal until BIL-1.3 dispatch; no tenant app grants.
import { index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { claimmdResponseEvents } from "./claimmd-response-inbox";

export const claimmdResponseResolutions = pgTable(
  "claimmd_response_resolution",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => claimmdResponseEvents.id, { onDelete: "restrict" }),
    state: text("state")
      .notNull()
      .$type<"pending" | "resolved" | "unmatched" | "ambiguous" | "conflict" | "needs_review">(),
    organizationId: uuid("organization_id"),
    providerEntityId: uuid("provider_entity_id"),
    locationId: uuid("location_id"),
    claimId: uuid("claim_id"),
    module: text("module").$type<"M23" | "M24" | "M41">(),
    submissionId: uuid("submission_id"),
    submissionAttemptId: uuid("submission_attempt_id"),
    strategy: text("strategy"),
    reasonCode: text("reason_code"),
    evidenceRef: jsonb("evidence_ref").$type<Record<string, string>>().notNull().default({}),
    algorithmVersion: text("algorithm_version").notNull(),
    version: integer("version").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseOwner: uuid("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("claimmd_response_resolution_event_uq").on(t.eventId),
    index("claimmd_response_resolution_due_ix").on(t.state, t.nextAttemptAt, t.createdAt),
    index("claimmd_response_resolution_org_ix").on(t.organizationId, t.providerEntityId, t.state),
  ],
);

export const claimmdResponseResolutionHistory = pgTable(
  "claimmd_response_resolution_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resolutionId: uuid("resolution_id")
      .notNull()
      .references(() => claimmdResponseResolutions.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    state: text("state").notNull(),
    organizationId: uuid("organization_id"),
    providerEntityId: uuid("provider_entity_id"),
    locationId: uuid("location_id"),
    claimId: uuid("claim_id"),
    module: text("module"),
    submissionId: uuid("submission_id"),
    submissionAttemptId: uuid("submission_attempt_id"),
    strategy: text("strategy"),
    reasonCode: text("reason_code"),
    evidenceRef: jsonb("evidence_ref").$type<Record<string, string>>().notNull().default({}),
    algorithmVersion: text("algorithm_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("claimmd_response_resolution_history_version_uq").on(t.resolutionId, t.version)],
);
