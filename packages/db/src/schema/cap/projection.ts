// @wardenx/db — M26 Cap Management §3.3 — the projection snapshot ledger + the threshold-event queue.
// cap_projection_snapshot is append-only (insert-only; dashboards read latest-per-scope) and LIST-partitioned
// on cap_period_id (§3.2; high volume — ~1k rows/tenant/nightly batch). cap_threshold_event is the
// band-transition queue (non-partitioned, low volume) with acknowledge/resolve mutations.
//
// CROSS-MODULE FK POLICY (architecture wins): organization_id → organization and cap_period_id →
// cap_period (non-partitioned parent) are real FKs on cap_threshold_event. snapshot_id is a LOGICAL uuid
// (a real FK onto the LIST-partitioned cap_projection_snapshot parent would have to carry cap_period_id).
// patient_id (M5), acknowledged_by (M2) are logical.
import {
  bigint,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { capPeriod } from "./cap-period";
import { m26AlertBand, m26Methodology, m26ProjectionScope, m26ProjectionTrigger } from "./enums";

// ---- cap_projection_snapshot — append-only; LIST-partitioned on cap_period_id ----
export const capProjectionSnapshot = pgTable(
  "cap_projection_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(), // composite PK (id, cap_period_id) declared in SQL
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    capPeriodId: uuid("cap_period_id").notNull(), // partition key + logical FK → cap_period
    scope: m26ProjectionScope("scope").notNull(),
    patientId: uuid("patient_id"), // NOT NULL when scope='patient_aggregate'
    methodology: m26Methodology("methodology").notNull(),
    paidYtdCents: bigint("paid_ytd_cents", { mode: "number" }).notNull(),
    outstandingBilledCents: bigint("outstanding_billed_cents", { mode: "number" })
      .notNull()
      .default(0),
    projectedYearEndCents: bigint("projected_year_end_cents", { mode: "number" }).notNull(),
    capAmountCents: bigint("cap_amount_cents", { mode: "number" }), // null for scope='inpatient'
    inpatientDaysYtd: integer("inpatient_days_ytd"),
    inpatientPctYtd: numeric("inpatient_pct_ytd", { precision: 7, scale: 4 }),
    inpatientPctProjected: numeric("inpatient_pct_projected", { precision: 7, scale: 4 }),
    pctOfCap: numeric("pct_of_cap", { precision: 7, scale: 4 }).notNull(),
    alertBand: m26AlertBand("alert_band").notNull(),
    beneficiaryCount: integer("beneficiary_count"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    computedBy: m26ProjectionTrigger("computed_by").notNull(),
  },
  (t) => ({
    uniqByScopeTime: unique("cap_projection_snapshot_uq").on(
      t.capPeriodId,
      t.scope,
      t.patientId,
      t.computedAt,
    ),
    latest: index("cap_projection_snapshot_latest_ix").on(
      t.organizationId,
      t.capPeriodId,
      t.scope,
      t.patientId,
      t.computedAt,
    ),
  }),
);

// ---- cap_threshold_event — band-transition queue (acknowledge / resolve) ----
export const capThresholdEvent = pgTable(
  "cap_threshold_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    capPeriodId: uuid("cap_period_id")
      .notNull()
      .references(() => capPeriod.id, { onDelete: "restrict" }),
    scope: m26ProjectionScope("scope").notNull(),
    patientId: uuid("patient_id"),
    priorBand: m26AlertBand("prior_band").notNull(),
    currentBand: m26AlertBand("current_band").notNull(),
    snapshotId: uuid("snapshot_id").notNull(), // logical FK → cap_projection_snapshot (partitioned)
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedBy: uuid("acknowledged_by"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (t) => ({
    uniqTransition: unique("cap_threshold_event_uq").on(
      t.capPeriodId,
      t.scope,
      t.patientId,
      t.priorBand,
      t.currentBand,
      t.snapshotId,
    ),
    open: index("cap_threshold_event_open_ix").on(t.organizationId, t.acknowledgedAt, t.resolvedAt),
  }),
);
