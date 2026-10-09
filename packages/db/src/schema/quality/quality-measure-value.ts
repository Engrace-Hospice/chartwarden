// @wardenx/db — `quality_measure_value` (M30 §3.3; non-partitioned; retention class `compliance`).
// Append-only / soft-supersede ledger of computed HQRP quality measures (HCI components, claims-based
// measures, CAHPS-derived). One current row per (measure, provider_entity, period) with superseded_at
// NULL; recompute writes a new row and stamps superseded_at/superseded_by on the prior. ORG-SCOPED:
// carries organization_id NOT NULL (canonical app.org_id RLS, M34-F02 / ADR-0010). provider_entity_id
// is a logical FK to M40 (plain uuid, app-validated). `computation_snapshot` is audit-denylisted (§3.6).
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import type { MeasureComputationSnapshot } from "./types";

export const m30MeasurePeriodKind = pgEnum("m30_measure_period_kind", [
  "rolling_12m_to_quarter",
  "calendar_quarter",
  "calendar_year",
  "cap_year_overlay",
]);

export const qualityMeasureValue = pgTable(
  "quality_measure_value",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    measureCode: text("measure_code").notNull(), // V-1
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK to M40
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    periodKind: m30MeasurePeriodKind("period_kind").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(), // V-3
    numerator: integer("numerator").notNull(), // V-2
    denominator: integer("denominator").notNull(), // V-2
    ratio: numeric("ratio", { precision: 6, scale: 4 }),
    thresholdMet: boolean("threshold_met"), // for HCI-indicator-style measures
    // GAP-049 (migration 1051): the public band as computed. NULL on rows that predate it (their band is
    // reconstructed from ratio/threshold_met, which cannot tell yellow from red).
    bandColor: text("band_color"),
    computationSnapshot: jsonb("computation_snapshot")
      .$type<MeasureComputationSnapshot>()
      .notNull(), // input seam state; DENYLISTED (§3.6)
    snapshotContentHash: text("snapshot_content_hash").notNull(), // V-5 (64 hex)
    calculatorVersion: text("calculator_version").notNull(), // semver of the calculator
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    computedBy: text("computed_by").notNull().default("worker:measure-recompute"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }), // null = current row
    supersededBy: uuid("superseded_by"), // FK to successor row id (logical)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    uniqCurrent: uniqueIndex("uq_quality_measure_value_current")
      .on(t.measureCode, t.providerEntityId, t.periodStart, t.periodEnd)
      .where(sql`superseded_at IS NULL`), // V-4
    byPeriod: index("idx_quality_measure_value_by_period").on(
      t.providerEntityId,
      t.measureCode,
      t.periodEnd,
    ),
  }),
);

export type QualityMeasureValue = typeof qualityMeasureValue.$inferSelect;
export type NewQualityMeasureValue = typeof qualityMeasureValue.$inferInsert;
