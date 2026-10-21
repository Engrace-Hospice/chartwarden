import { sql } from "drizzle-orm";
// @chartwarden/db — M37 staffing + the 24/7 RN-coverage invariant (§2.3 D3, §3.3): ipu_shift,
// ipu_staff_assignment, and the ipu_rn_coverage_window materialized-invariant table (rebuilt every 5 min
// by the coverage cron). TENANT-SCOPED, RLS on app.org_id. ipu_shift carries a GiST exclusion-style
// index over `tstzrange(shift_start_at, shift_end_at)` declared in the migration (Drizzle can't express
// the range index); the ORM view keeps the plain columns. membership ids are logical uuids;
// intra-module links (unit_id, shift_id) are REAL FKs. `rn_assignment_ids` is a uuid[] snapshot of the
// RN staff-assignment rows covering each hour.
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { ipuShiftAssignmentState, ipuShiftRole } from "../../enums";
import { bigintVersion } from "./shared";
import { inpatientUnit } from "./units";

export const ipuShift = pgTable(
  "ipu_shift",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => inpatientUnit.id, { onDelete: "restrict" }),
    shiftStartAt: timestamp("shift_start_at", { withTimezone: true }).notNull(),
    shiftEndAt: timestamp("shift_end_at", { withTimezone: true }).notNull(),
    displayLabel: text("display_label"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    unitStartIx: index("ipu_shift_unit_start_idx").on(t.unitId, t.shiftStartAt),
  }),
);

export const ipuStaffAssignment = pgTable(
  "ipu_staff_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => ipuShift.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id").notNull(),
    role: ipuShiftRole("role").notNull(),
    state: ipuShiftAssignmentState("state").notNull().default("tentative"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    shiftRoleIx: index("ipu_staff_assignment_shift_role_idx")
      .on(t.shiftId, t.role)
      .where(sql`state IN ('tentative','confirmed')`),
    membershipIx: index("ipu_staff_assignment_membership_idx")
      .on(t.membershipId)
      .where(sql`state IN ('tentative','confirmed')`),
  }),
);

// Materialized invariant, rebuilt every 5 min by the RN-coverage cron (§5.4 W-IPU-04).
export const ipuRnCoverageWindow = pgTable(
  "ipu_rn_coverage_window",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => inpatientUnit.id, { onDelete: "restrict" }),
    hourStartAt: timestamp("hour_start_at", { withTimezone: true }).notNull(),
    isCovered: boolean("is_covered").notNull(),
    rnAssignmentIds: uuid("rn_assignment_ids").array().notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    unitHourUq: uniqueIndex("ipu_rn_coverage_unit_hour_uq").on(t.unitId, t.hourStartAt),
    unitHourIx: index("rn_coverage_unit_hour_idx").on(t.unitId, t.hourStartAt),
    gapIx: index("rn_coverage_gap_idx").on(t.unitId, t.hourStartAt).where(sql`is_covered = false`),
  }),
);

export type IpuShiftRow = typeof ipuShift.$inferSelect;
export type NewIpuShiftRow = typeof ipuShift.$inferInsert;
export type IpuStaffAssignmentRow = typeof ipuStaffAssignment.$inferSelect;
export type NewIpuStaffAssignmentRow = typeof ipuStaffAssignment.$inferInsert;
export type IpuRnCoverageWindowRow = typeof ipuRnCoverageWindow.$inferSelect;
export type NewIpuRnCoverageWindowRow = typeof ipuRnCoverageWindow.$inferInsert;

/**
 * F-071 (#174) — the §2.3 D3 RN-coverage break-glass override.
 *
 * `invokeRnBreakGlass` used to publish an outbox event and write nothing, and the coverage gate reads no
 * event stream — so the documented escape hatch from an uncovered unit changed no gate's answer.
 *
 * Deliberately NOT a flag on `ipu_rn_coverage_window`: that table answers "was an RN on duty for this
 * hour?" and is the platform's only computational answer to that question over a quarter. An override is a
 * different fact — a named person accepted the risk, for a bounded window, with a reason — and writing it
 * into the coverage grid would make a surveyor's report say an RN was present when one was not.
 *
 * One LIVE row per unit (partial unique index on `revoked_at IS NULL`); expired rows stay live-indexed
 * until revoked, and `expiresAt` is what the gate compares against, so an expired override stops passing
 * without anything having to run.
 */
export const ipuRnBreakGlass = pgTable(
  "ipu_rn_break_glass",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => inpatientUnit.id, { onDelete: "restrict" }),
    invokedByMembershipId: uuid("invoked_by_membership_id").notNull(),
    invokedAt: timestamp("invoked_at", { withTimezone: true }).notNull().defaultNow(),
    /** §2.3 — capped at 4 hours by a CHECK. An override with no horizon is a policy change. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(), // >= 40 chars (CHECK)
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByMembershipId: uuid("revoked_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    liveUq: uniqueIndex("ipu_rn_break_glass_live_uq")
      .on(t.organizationId, t.unitId)
      .where(sql`revoked_at IS NULL`),
    unitExpiryIx: index("ipu_rn_break_glass_unit_expiry_idx")
      .on(t.unitId, t.expiresAt)
      .where(sql`revoked_at IS NULL`),
  }),
);
export type IpuRnBreakGlassRow = typeof ipuRnBreakGlass.$inferSelect;
export type NewIpuRnBreakGlassRow = typeof ipuRnBreakGlass.$inferInsert;
