// @chartwarden/db — M41 Billing - Commercial: acknowledgment ingestion (migration 1275). A clearinghouse event about a submission
// (codes and ids only) and the pull position. Three-column rule on the PHI-adjacent acknowledgment, canonical app.org_id RLS
// (FORCEd) and write-audit triggers in the migration. Duplicates collapse on the unique (organization, clearinghouse, event id) key.
import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const commercialAcknowledgments = pgTable(
  "commercial_acknowledgment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id").notNull(),
    submissionId: uuid("submission_id").notNull(),
    clearinghouseKey: text("clearinghouse_key").notNull(),
    eventId: text("event_id").notNull(),
    stage: text("stage").notNull(), // clearinghouse | payer
    disposition: text("disposition").notNull(), // accepted | rejected | partial (payer stage only)
    reasonCodes: text("reason_codes").array().notNull().default([]),
    payerClaimNumber: text("payer_claim_number"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byClaim: index("commercial_acknowledgment_claim_ix").on(t.claimId, t.createdAt),
    byOrg: index("commercial_acknowledgment_org_ix").on(t.organizationId),
  }),
);

// An acknowledgment event that was NOT applied (ids and a reason code only; migration 1275). Unique per vendor event id.
export const commercialAckQuarantine = pgTable(
  "commercial_ack_quarantine",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    clearinghouseKey: text("clearinghouse_key").notNull(),
    eventId: text("event_id").notNull(),
    controlNumber: text("control_number"),
    reason: text("reason").notNull(), // malformed | scope_mismatch | vendor_mismatch | no_receipt
    // the validated event (codes and ids), kept only for `no_receipt` so the pull can replay it once the submission is settled
    event: jsonb("event"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("commercial_ack_quarantine_org_ix").on(t.organizationId),
  }),
);

export const commercialAckCursors = pgTable(
  "commercial_ack_cursor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    vendor: text("vendor").notNull(),
    usage: text("usage").notNull(), // test | production
    cursor: text("cursor"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPe: index("commercial_ack_cursor_pe_ix").on(t.providerEntityId),
  }),
);

export type CommercialAcknowledgment = typeof commercialAcknowledgments.$inferSelect;
