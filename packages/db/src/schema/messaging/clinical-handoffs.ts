// M36 WP 3.5 - clinical handoffs: a thin aggregate of open-work POINTERS offered from one clinician to another, plus the
// append-only event history and the tenant's tighten-only expiry policy. Ids, enums and instants only (no note, title or
// free text). The CHECK/index names match migration 1101 (pinned by a test).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";

export const clinicalHandoffs = pgTable(
  "clinical_handoff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    fromUserId: uuid("from_user_id").notNull(),
    toUserId: uuid("to_user_id").notNull(),
    state: text("state").notNull().default("offered"),
    offeredAt: timestamp("offered_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedReason: text("closed_reason"),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("clinical_handoff_org_id_uq").on(t.organizationId, t.id),
    openPerPair: uniqueIndex("clinical_handoff_open_per_pair")
      .on(t.organizationId, t.fromUserId, t.toUserId)
      .where(sql`${t.state} = 'offered'`),
    byRecipient: index("clinical_handoff_to_idx").on(
      t.organizationId,
      t.toUserId,
      t.state,
      t.expiresAt,
    ),
    bySender: index("clinical_handoff_from_idx").on(t.organizationId, t.fromUserId, t.state),
    due: index("clinical_handoff_due_idx")
      .on(t.organizationId, t.expiresAt)
      .where(sql`${t.state} = 'offered'`),
    stateShape: check(
      "clinical_handoff_state_shape",
      sql`${t.state} IN ('offered', 'accepted', 'declined', 'expired', 'cancelled')`,
    ),
    parties: check("clinical_handoff_parties", sql`${t.fromUserId} <> ${t.toUserId}`),
    deadline: check("clinical_handoff_deadline", sql`${t.expiresAt} > ${t.offeredAt}`),
    reasonShape: check(
      "clinical_handoff_reason_shape",
      sql`${t.closedReason} IS NULL OR ${t.closedReason} IN ('all_resolved', 'deadline', 'sender_cancelled', 'recipient_left')`,
    ),
    closedShape: check(
      "clinical_handoff_closed_shape",
      sql`(${t.state} = 'offered') = (${t.closedAt} IS NULL) AND (${t.state} = 'offered') = (${t.closedReason} IS NULL)`,
    ),
    acceptedShape: check(
      "clinical_handoff_accepted_shape",
      sql`(${t.state} = 'accepted') = (${t.acceptedAt} IS NOT NULL)`,
    ),
  }),
);

export const clinicalHandoffItems = pgTable(
  "clinical_handoff_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    handoffId: uuid("handoff_id").notNull(),
    /** Logical pointer (no FK, like clinical_link); scrubbed from the audit log. */
    patientId: uuid("patient_id").notNull(),
    itemKind: text("item_kind").notNull(),
    /** The owning record's id; for kind 'patient' it equals patient_id. Scrubbed from the audit log. */
    refId: uuid("ref_id").notNull(),
    state: text("state").notNull().default("pending"),
    /** The sender at insert; the recipient only in the update that sets the item accepted (trigger-enforced). */
    accountableUserId: uuid("accountable_user_id").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    handoffFk: foreignKey({
      name: "clinical_handoff_item_handoff_fk",
      columns: [t.organizationId, t.handoffId],
      foreignColumns: [clinicalHandoffs.organizationId, clinicalHandoffs.id],
    }).onDelete("cascade"),
    uniqueInHandoff: uniqueIndex("clinical_handoff_item_unique_in_handoff").on(
      t.organizationId,
      t.handoffId,
      t.itemKind,
      t.refId,
    ),
    onePending: uniqueIndex("clinical_handoff_item_one_pending")
      .on(t.organizationId, t.itemKind, t.refId)
      .where(sql`${t.state} = 'pending'`),
    byHandoff: index("clinical_handoff_item_handoff_idx").on(t.organizationId, t.handoffId),
    byPatient: index("clinical_handoff_item_patient_idx").on(t.organizationId, t.patientId),
    byAccountable: index("clinical_handoff_item_accountable_idx").on(
      t.organizationId,
      t.accountableUserId,
      t.state,
    ),
    kindShape: check(
      "clinical_handoff_item_kind_shape",
      sql`${t.itemKind} IN ('patient', 'visit', 'refill_request', 'symptom_followup', 'task')`,
    ),
    stateShape: check(
      "clinical_handoff_item_state_shape",
      sql`${t.state} IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')`,
    ),
    resolvedShape: check(
      "clinical_handoff_item_resolved_shape",
      sql`(${t.state} = 'pending') = (${t.resolvedAt} IS NULL)`,
    ),
    patientAnchor: check(
      "clinical_handoff_item_patient_anchor",
      sql`${t.itemKind} <> 'patient' OR ${t.refId} = ${t.patientId}`,
    ),
  }),
);

export const clinicalHandoffEvents = pgTable(
  "clinical_handoff_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    handoffId: uuid("handoff_id").notNull(),
    eventType: text("event_type").notNull(),
    /** Null for the system actor (the expiry tick, offboarding). */
    actorUserId: uuid("actor_user_id"),
    actorKind: text("actor_kind").notNull(),
    /** A COUNT of items the event concerns - never an item. */
    itemCount: integer("item_count").notNull().default(0),
    reasonCode: text("reason_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    handoffFk: foreignKey({
      name: "clinical_handoff_event_handoff_fk",
      columns: [t.organizationId, t.handoffId],
      foreignColumns: [clinicalHandoffs.organizationId, clinicalHandoffs.id],
    }).onDelete("cascade"),
    byHandoff: index("clinical_handoff_event_handoff_idx").on(
      t.organizationId,
      t.handoffId,
      t.createdAt,
    ),
    typeShape: check(
      "clinical_handoff_event_type_shape",
      sql`${t.eventType} IN ('offered', 'items_accepted', 'items_declined', 'closed', 'cancelled', 'needs_attention', 'recipient_left', 'sender_left')`,
    ),
    actorShape: check(
      "clinical_handoff_event_actor_shape",
      sql`${t.actorKind} IN ('user', 'system') AND ((${t.actorKind} = 'system') = (${t.actorUserId} IS NULL))`,
    ),
    countShape: check("clinical_handoff_event_count", sql`${t.itemCount} >= 0`),
  }),
);

export const tenantHandoffPolicies = pgTable(
  "tenant_handoff_policy",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "restrict" }),
    expiryMinutes: integer("expiry_minutes").notNull(),
    configuredByUserId: uuid("configured_by_user_id")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    configuredByIdx: index("tenant_handoff_policy_configured_by_idx").on(t.configuredByUserId),
    expiry: check("tenant_handoff_policy_expiry", sql`${t.expiryMinutes} BETWEEN 15 AND 240`),
  }),
);

export type ClinicalHandoffRow = typeof clinicalHandoffs.$inferSelect;
export type NewClinicalHandoffRow = typeof clinicalHandoffs.$inferInsert;
export type ClinicalHandoffItemRow = typeof clinicalHandoffItems.$inferSelect;
export type NewClinicalHandoffItemRow = typeof clinicalHandoffItems.$inferInsert;
export type ClinicalHandoffEventRow = typeof clinicalHandoffEvents.$inferSelect;
export type NewClinicalHandoffEventRow = typeof clinicalHandoffEvents.$inferInsert;
export type TenantHandoffPolicyRow = typeof tenantHandoffPolicies.$inferSelect;
