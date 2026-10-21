// @chartwarden/db - `legal_hold_audit_event` (M4, GAP-008; migration 1053): the append-only OVERLAY that says which
// `audit_event` rows an active legal hold covers. See ADR-0051: a hold is NOT a `retention_class` flip, because that
// column is part of the integrity hash and `wardenx_app` holds no UPDATE on `audit_event`. A row is "held" while the
// referenced hold's status is 'active'; releasing the hold is the one existing UPDATE and un-holds every row at once.
// No FK to the partitioned `audit_event`: (auditEventId, auditEventCreatedAt) is the row's identity across the
// partition key. Tenant-scoped, RLS keyed on app.org_id; wardenx_app has SELECT and INSERT only. Ids only, no PHI.
import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { legalHolds } from "./legal-holds";
import { organizations } from "./organizations";

export const legalHoldAuditEvents = pgTable(
  "legal_hold_audit_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    legalHoldId: uuid("legal_hold_id")
      .notNull()
      .references(() => legalHolds.id, { onDelete: "restrict" }),
    auditEventId: uuid("audit_event_id").notNull(),
    auditEventCreatedAt: timestamp("audit_event_created_at", { withTimezone: true }).notNull(),
    heldAt: timestamp("held_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqHoldRow: uniqueIndex("uq_legal_hold_audit_event").on(
      t.legalHoldId,
      t.auditEventId,
      t.auditEventCreatedAt,
    ),
    rowIdx: index("idx_legal_hold_audit_event_row").on(
      t.organizationId,
      t.auditEventId,
      t.auditEventCreatedAt,
    ),
  }),
);

export type LegalHoldAuditEvent = typeof legalHoldAuditEvents.$inferSelect;
export type NewLegalHoldAuditEvent = typeof legalHoldAuditEvents.$inferInsert;
