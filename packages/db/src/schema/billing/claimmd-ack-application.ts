import { index, pgTable, text, timestamp, unique, uuid, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { claimmdResponseEvents } from "./claimmd-response-inbox";
import { claimmdResponseResolutions } from "./claimmd-response-resolution";

/** Tenant-scoped, append-only decision about one immutable account response. Text stays in the encrypted inbox. */
export const claimmdAckApplications = pgTable("claimmd_ack_application", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull().references(() => claimmdResponseEvents.id, { onDelete: "restrict" }),
  mode: text("mode").$type<"shadow" | "apply">().notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  resolutionId: uuid("resolution_id").notNull().references(() => claimmdResponseResolutions.id, { onDelete: "restrict" }),
  resolutionVersion: integer("resolution_version").notNull(),
  accountReference: text("account_reference").notNull(),
  usage: text("usage").$type<"test" | "production">().notNull(),
  organizationId: uuid("organization_id").notNull(),
  providerEntityId: uuid("provider_entity_id").notNull(),
  locationId: uuid("location_id"),
  claimId: uuid("claim_id").notNull(),
  billingModule: text("billing_module").$type<"M23" | "M24" | "M41">().notNull(),
  submissionId: uuid("submission_id").notNull(),
  evidenceId: uuid("evidence_id"),
  responseId: text("response_id"),
  sourceRepresentation: text("source_representation").notNull(),
  senderId: text("sender_id"),
  messageCode: text("message_code"),
  parentStatus: text("parent_status"),
  messageStatus: text("message_status"),
  interpreterVersion: text("interpreter_version").notNull(),
  proposedAction: text("proposed_action"),
  outcome: text("outcome").$type<"applied" | "informational" | "held" | "shadow">().notNull(),
  previousState: text("previous_state"),
  newState: text("new_state"),
  reasonCode: text("reason_code").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("claimmd_ack_application_attempt_uq").on(t.eventId, t.mode, t.attemptNumber),
  uniqueIndex("claimmd_ack_application_applied_uq").on(t.eventId, t.mode).where(sql`${t.outcome} = 'applied'`),
  index("claimmd_ack_application_org_ix").on(t.organizationId, t.providerEntityId, t.claimId),
]);
