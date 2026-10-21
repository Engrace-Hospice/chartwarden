// @chartwarden/db — `ai_capability_calibration` (M32 §3.2.3). The per-(capability, backend) threshold set
// and the baseline metrics drift is measured AGAINST. W6 promotes a new calibration; W7's drift monitor
// compares live metrics to `baseline_metrics`.
//
// PLATFORM-SHARED (§3.3): a calibration is a property of the model, not of a tenant. Listed in
// check-tenancy.ts's NON_ORG_SCOPED set.
//
// WHY (capability, backend) AND NOT capability ALONE: the same capability behaves differently on a cloud
// frontier model and on a local 3B — that is the whole point of §5.3's "calibration trade-off" the tenant
// acknowledges at opt-in. One threshold set per capability would silently apply the cloud baseline to the
// local route, and the drift monitor would then fire continuously on a backend that is working exactly as
// specified.
//
// SUPERSESSION, NOT MUTATION (§3.5): the `is_current = true` row may only be flipped to false with the
// `superseded_*` columns set, in the same transaction that inserts its replacement; `thresholds`,
// `baseline_metrics` and the baseline provenance are frozen by the 0116 immutability trigger. The
// partial unique index is what makes "one current calibration per (capability, backend)" a database
// fact rather than a convention — without the WHERE clause it would forbid history instead.
//
// `superseded_by_id` is a LOGICAL self-reference, not an FK (§3.2.3): the two rows are written in one
// transaction and a hard self-FK would impose an ordering the supersede statement cannot satisfy.
// `baseline_evaluation_run_id` is likewise logical — the run is platform-shared but written by an
// asynchronous worker.
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { aiCapability } from "./ai-capabilities";

export const aiCapabilityCalibration = pgTable(
  "ai_capability_calibration",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => aiCapability.id, { onDelete: "restrict" }),
    /** Resolved against `ai_model_backend.backend_key` (key, not FK — the `ai_capability` posture). */
    backendKey: text("backend_key").notNull(),

    /** Typed PerCapabilityThresholds — the gate values the routing/QA path compares against. */
    thresholds: jsonb("thresholds").notNull(),
    /** The metric snapshot W7's drift monitor measures the live window against. */
    baselineMetrics: jsonb("baseline_metrics").notNull(),
    baselineSetAt: timestamp("baseline_set_at", { withTimezone: true }).notNull(),
    /** Logical uuid → `ai_evaluation_run` (see header): WHICH run produced this baseline. */
    baselineEvaluationRunId: uuid("baseline_evaluation_run_id").notNull(),

    isCurrent: boolean("is_current").notNull().default(true),
    supersededReason: text("superseded_reason"),
    /** Logical self-reference (see header). */
    supersededById: uuid("superseded_by_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => ({
    // Partial: exactly ONE current calibration per (capability, backend); history is unconstrained.
    currentPerBackendIdx: uniqueIndex("ai_cap_calib_current_per_backend_idx")
      .on(t.capabilityId, t.backendKey)
      .where(sql`is_current = true`),
    historyIdx: index("ai_cap_calib_history_idx").on(
      t.capabilityId,
      t.backendKey,
      t.createdAt.desc(),
    ),
  }),
);

export type AiCapabilityCalibrationRow = typeof aiCapabilityCalibration.$inferSelect;
export type NewAiCapabilityCalibrationRow = typeof aiCapabilityCalibration.$inferInsert;
