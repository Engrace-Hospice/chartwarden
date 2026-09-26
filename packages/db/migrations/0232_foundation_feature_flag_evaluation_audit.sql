-- M1 Foundation / M04 — `feature_flag_evaluation` gets the write-audit trigger every other
-- org-scoped foundation table carries (0004: feature_flag, idempotency_key, outbox_event, …).
--
-- 0120 gave this table the RLS it never had, and called its rows what they are: a per-tenant,
-- per-user behavioural record. It was still missing from the audit set because the fitness-gaps
-- PHI-guard heuristic never inspected it — its org-scoped match on the preceding table definition ran
-- past that statement and swallowed this one (fixed in scripts/check-fitness-gaps.ts alongside this
-- migration). Nothing writes the table today, so attaching the standard trigger has no runtime cost;
-- it only guarantees that any future write is audited like its sibling `feature_flag`.
DROP TRIGGER IF EXISTS "feature_flag_evaluation_audit" ON feature_flag_evaluation;--> statement-breakpoint
CREATE TRIGGER "feature_flag_evaluation_audit" AFTER INSERT OR UPDATE OR DELETE ON feature_flag_evaluation
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
