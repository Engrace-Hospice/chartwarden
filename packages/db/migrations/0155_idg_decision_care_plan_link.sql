-- 0155 — TASK-002 follow-up (M14 schema-gap closure): `idg_decision` gains its care-plan link.
-- `IdgSeamStore.decisionsForCarePlan` had NO backing fact — `idg_decision` carried no plan column and
-- the §2.6 D4 `care_plan_update` payload's mutations carry element ids only — so the Drizzle store
-- threw the typed IdgSeamSchemaGapError and M30's decision-to-careplan-update latency measure had no
-- input. `care_plan_id` is a plain uuid with NO cross-module FK (M7 owns `care_plan` — an app-side
-- logical ref, the same convention as `idg_decision.patient_id` → M5). The write path stamps it at
-- record time for `care_plan_update` decisions by resolving the patient's ACTIVE plan through M7's
-- CarePlanReader seam (best-effort): a decision recorded without a resolvable active plan keeps NULL,
-- and a NULL row simply never matches the by-care-plan read — an honest under-count, never a
-- fabricated link.
--
-- Forward-only (never edit an applied migration). Idempotent guards so a replay is safe.

ALTER TABLE idg_decision
  ADD COLUMN IF NOT EXISTS care_plan_id uuid;

COMMENT ON COLUMN idg_decision.care_plan_id IS
  'M7 care_plan (app-validated logical ref; no cross-module FK — M7 owns care_plan). Stamped at record time for care_plan_update decisions from the patient''s active plan via the CarePlanReader seam; NULL when the decision updates no care plan or no active plan resolved.';

-- The seam's by-care-plan read predicate. Partial: most decisions are not care_plan_update rows, so
-- the linked subset stays tight (RLS already pins the org; the read keys on the plan id alone).
CREATE INDEX IF NOT EXISTS idg_decision_care_plan_idx
  ON idg_decision (care_plan_id)
  WHERE care_plan_id IS NOT NULL;
