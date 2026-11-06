-- compat: contract
-- M34 - wizard step 10 `dosespot_kickoff_initiated` is settled from a fact, not only attested (tenant onboarding slice 4,
-- ADR-0110). Migration 1327 seeded it with `context.dosespotKickoffRecorded == true`, a field nothing produced; now that each
-- tenant's DoseSpot clinic registration is real data (M12 `dosespot_clinic_registration`, 1380), the advance sweep settles the step
-- when the registration is `active` (registered, connection tested, activated), and a human may still attest it where the fact
-- cannot be read (`either`, the mac_configured shape). The prescriber count does NOT gate: a prescriber needs a membership, and the
-- first-admin step comes after this one. Saving, testing or activating the registration (platform or tenant route) runs the
-- advance pass at once, so the step settles without waiting for the 06:00 sweep.
--
-- `contract` because the previous release cannot run against this row: its precondition evaluator throws on the unknown context
-- field `dosespotSettled` (the same tripwire 1327 and 1351 document), so that release's pass for an onboarding tenant fails loud and
-- is retried instead of settling anything. deploy.sh therefore halts for an operator over this migration rather than auto-restoring.
-- Idempotent; only the seeded row changes, and only while it still carries the old precondition.
UPDATE "onboarding_task_template"
   SET "precondition_dsl" = 'context.dosespotSettled == true',
       "description" = 'DoseSpot clinic registered, connection tested and activated'
 WHERE "key" = 'dosespot_kickoff_initiated'
   AND "precondition_dsl" = 'context.dosespotKickoffRecorded == true'
   AND "retired_at" IS NULL;
