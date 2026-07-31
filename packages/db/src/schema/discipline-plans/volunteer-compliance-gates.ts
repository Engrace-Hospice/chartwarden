// @wardenx/db — `volunteer_compliance_gate` (M15 §3.3). One row per (volunteer membership × gate kind ×
// validity window): the 42 CFR §418.78(b)/(d) postures `VolunteerComplianceProvider.effectiveStatusFor()`
// answers from — the LIVE binding that closes M17's Wave-F volunteer deny-stub (M15-T05).
//
// §2.2.6: `expiring_soon` is derived nightly, 30 days ahead of `valid_until`; it alerts (30/14/7/1 day) but
// does NOT block. Expiry flips the gate to `expired`, which flips the volunteer's effective status to
// inactive and inactivates open assignments (§7.5). The partial unique index enforces "at most one CURRENT
// row per (volunteer, gate kind)" while leaving the expired history in place as the audit trail.
//
// Tenancy (ADR-0010 / ARCH-011): this is a STAFF-compliance row, not a patient row — no patient/admission
// reference, so it carries organization_id only (the three-column rule scopes PHI-bearing tables; PE and
// location are attributes of the assignment, not of the volunteer's credential). RLS keys on app.org_id.
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { volunteerGateKind, volunteerGateStatus } from "../../enums";
import { organizations } from "../organizations";

export const volunteerComplianceGate = pgTable(
  "volunteer_compliance_gate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    volunteerMembershipId: uuid("volunteer_membership_id").notNull(), // logical FK → M2 membership
    gateKind: volunteerGateKind("gate_kind").notNull(),
    status: volunteerGateStatus("status").notNull(),

    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }), // null = non-expiring (e.g. confidentiality)
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"), // audit-denylisted (§3.6)

    sourceDocumentId: uuid("source_document_id"), // logical FK → M22 document
    recordedByMembershipId: uuid("recorded_by_membership_id").notNull(), // logical FK → M2
    notes: text("notes"), // audit-denylisted (§3.6)

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0), // §2.5 If-Match
  },
  (t) => ({
    volunteerGateCurrentUq: uniqueIndex("volunteer_compliance_gate_current_uq")
      .on(t.organizationId, t.volunteerMembershipId, t.gateKind)
      .where(sql`revoked_at IS NULL AND status <> 'expired'`),
    // Hot path: the nightly expiry/expiring-soon watcher (§4.6).
    expiringIdx: index("volunteer_compliance_gate_expiring_idx")
      .on(t.organizationId, t.validUntil)
      .where(sql`status IN ('satisfied','expiring_soon')`),
    volunteerStatusIdx: index("volunteer_compliance_gate_volunteer_status_idx").on(
      t.organizationId,
      t.volunteerMembershipId,
      t.status,
    ),
    validWindow: check(
      "volunteer_compliance_gate_valid_window_ck",
      sql`valid_until IS NULL OR valid_until > valid_from`,
    ),
    revokedRequiresReason: check(
      "volunteer_compliance_gate_revoked_reason_ck",
      sql`revoked_at IS NULL OR revoked_reason IS NOT NULL`,
    ),
  }),
);

export type VolunteerComplianceGate = typeof volunteerComplianceGate.$inferSelect;
export type NewVolunteerComplianceGate = typeof volunteerComplianceGate.$inferInsert;
