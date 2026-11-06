-- compat: contract
-- M34 - wizard step 7 `clearinghouse_selected` is settled from a fact, not only attested (ADR-0053 amendment 2026-11-06).
-- Migration 1327 seeded it as `attestation`; now that each tenant's clearinghouse choice is real data (M23
-- `tenant_clearinghouse_config`, 1350), the advance sweep settles the step when the choice is settled (`outside`, or stedi /
-- claimmd in `active` status), and a human may still attest it where the fact cannot be read (`either`, the mac_configured
-- shape). Choosing a vendor in the platform or tenant routes runs the advance pass at once, so the step settles without waiting
-- for the 06:00 sweep.
--
-- `contract` because the previous release cannot run against this row: its precondition evaluator throws on the unknown
-- context field `clearinghouseSettled` (the same tripwire 1327 documents for go-live), so that release's pass for an
-- onboarding tenant fails loud and is retried instead of settling anything. deploy.sh therefore halts for an operator over
-- this migration rather than auto-restoring. Idempotent; only the seeded row changes, and only while it still says `attestation`.
UPDATE "onboarding_task_template"
   SET "completion_mode" = 'either',
       "precondition_dsl" = 'context.clearinghouseSettled == true'
 WHERE "key" = 'clearinghouse_selected'
   AND "completion_mode" = 'attestation'
   AND "retired_at" IS NULL;
