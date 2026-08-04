-- TASK-040D — the M7 §7.1/§7.2 gate-scan columns `jobs/index.ts`'s pure `planInitialGateScan`/
-- `planReviewGateScan` functions were always specified against but that never landed on `care_plan`:
--   * admission_activated_at — echoed into the `m7.care_plan.initial_overdue` payload (§7.1). Backfilled
--     NULL for existing rows (no reliable source instant to derive it from retroactively); the write
--     lifecycle now stamps it at bootstrap from the SAME instant `initial_due_at` is computed from, so
--     every care plan created from this migration forward carries it.
--   * initial_warning_emitted / review_due_emitted / review_overdue_emitted — the per-due-date emission
--     markers that make a daily gate scan idempotent (fire once per deadline, not once per scan). Default
--     false so a pre-existing plan is scanned fresh rather than presumed already-warned.
ALTER TABLE "care_plan" ADD COLUMN "admission_activated_at" timestamptz;--> statement-breakpoint
ALTER TABLE "care_plan" ADD COLUMN "initial_warning_emitted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "care_plan" ADD COLUMN "review_due_emitted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "care_plan" ADD COLUMN "review_overdue_emitted" boolean DEFAULT false NOT NULL;
