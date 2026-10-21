// @chartwarden/db — `medicaid_state_plan_code` (M24 Billing-Medicaid §3.3/D8-adjacent; non-partitioned;
// retention class `reference`). The per-state Medicaid program/plan catalog `medicaid_claim.state_plan_code_id`
// snapshots at assembly (WX-PR-011). D8 in the locked spec names this an M40 platform-shared table read via
// `MdmEntityProvider` — DEVIATION: M40's real `MdmEntityProvider` (@chartwarden/mdm) is a physician/facility/payer
// entity-MERGE engine (generic `CanonicalFields<K>`/`OverlayFields<K>` per kind); a static state-plan-code
// reference list is not an entity-resolution problem, so routing it through that machinery would be a large,
// disproportionate extension for one NOT-NULL FK. Self-owned here instead, mirroring the ACTUAL M23
// `wage_index_factor` precedent (a platform-shared reference table owned by the CONSUMING billing module, not
// M40) — same posture as that table: no organization_id, RLS is SELECT-only `USING (true)` for app_user, and
// only the platform loader role writes it.
//
// PHASE-1 SIMPLIFICATION: Oregon OHP has multiple sub-plans (OHP Plus / OHP Standard / OHP CHIP / Long-Term
// Care Medicaid) selected per-member by eligibility, but M5's `PatientCoverageReader` seam does not yet surface
// which sub-plan a patient's coverage carries. Assembly therefore resolves the state's single ACTIVE default
// plan row (see 0176 seed) rather than a per-patient plan lookup. Per-patient plan differentiation is a
// follow-up once `PatientCoverageReader` carries a plan-code field.
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const medicaidStatePlanCode = pgTable(
  "medicaid_state_plan_code",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    stateCode: text("state_code").notNull(), // 2-char state postal code (matches medicaid_claim.service_state)
    planCode: text("plan_code").notNull(), // the state program code snapshotted onto medicaid_claim
    planName: text("plan_name").notNull(), // human label, e.g. "OHP Plus"
    isStateDefault: boolean("is_state_default").notNull().default(false), // the Phase-1 fallback row per state

    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }), // null = still active

    loadSourceRef: text("load_source_ref").notNull(),
    loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueByStatePlanFrom: uniqueIndex("medicaid_state_plan_code_state_plan_from_uq").on(
      t.stateCode,
      t.planCode,
      t.effectiveFrom,
    ),
    byState: index("medicaid_state_plan_code_state_idx").on(t.stateCode),
  }),
);

export type MedicaidStatePlanCode = typeof medicaidStatePlanCode.$inferSelect;
export type NewMedicaidStatePlanCode = typeof medicaidStatePlanCode.$inferInsert;
