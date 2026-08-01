// @wardenx/db — `ai_evaluation_run` (M32 §3.2.11). One row per governance evaluation of a
// (capability, backend) pair: the stage-3/stage-4 gate evidence, a re-approval, a drift response or a
// post-incident re-test.
//
// PLATFORM-SHARED (§3.3): an evaluation is run against the model on a held-out dataset, not inside a
// tenant. Listed in check-tenancy.ts's NON_ORG_SCOPED set.
//
// `mlflow_run_id` + `dataset_version_ref` are the whole point of the row: the metrics live in MLflow and
// the dataset in DVC, and WardenX stores the POINTERS plus the decision a human took on them. Copying
// the metric tables in here would create a second source of truth that drifts from the one the ML team
// actually reads; `summary_metrics` is the headline snapshot the console renders, not the record.
//
// `decision` defaults to `no_decision` and is NOT NULL, so an evaluation that finished but was never
// ruled on is visibly undecided rather than implicitly approved.
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  aiEvaluationRunDecision,
  aiEvaluationRunStage,
  aiEvaluationRunStatus,
} from "../../enums";
import { aiCapability } from "./ai-capabilities";
import { aiModelBackend } from "./ai-model-backends";

export const aiEvaluationRun = pgTable(
  "ai_evaluation_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => aiCapability.id, { onDelete: "restrict" }),
    backendId: uuid("backend_id")
      .notNull()
      .references(() => aiModelBackend.id, { onDelete: "restrict" }),

    /** DVC/dataset pointer — WHICH held-out set produced these numbers. */
    datasetVersionRef: text("dataset_version_ref").notNull(),
    /** MLflow pointer — where the full metric surface lives (see header). */
    mlflowRunId: text("mlflow_run_id").notNull(),

    stage: aiEvaluationRunStage("stage").notNull(),
    /** Headline snapshot for the §5.1 console; MLflow remains the record. */
    summaryMetrics: jsonb("summary_metrics").notNull(),
    status: aiEvaluationRunStatus("status").notNull().default("pending"),

    initiatedByMembershipId: uuid("initiated_by_membership_id").notNull(),
    decision: aiEvaluationRunDecision("decision").notNull().default("no_decision"),

    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    capabilityBackendIdx: index("ai_eval_run_cap_backend_idx").on(
      t.capabilityId,
      t.backendId,
      t.startedAt.desc(),
    ),
    // The in-flight sweep: partial so the completed history stays out of the worker's scan.
    statusIdx: index("ai_eval_run_status_idx")
      .on(t.status)
      .where(sql`status IN ('pending','in_progress')`),
  }),
);

export type AiEvaluationRunRow = typeof aiEvaluationRun.$inferSelect;
export type NewAiEvaluationRunRow = typeof aiEvaluationRun.$inferInsert;
