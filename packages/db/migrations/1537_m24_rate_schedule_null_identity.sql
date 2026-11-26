-- compat: contract
-- M24-1075-L2B: make nullable payer and locality keys compare as part of the schedule identity.
-- PostgreSQL UNIQUE treats each NULL as distinct by default, so the 1536 key allowed duplicate
-- statewide/unqualified rows and duplicate payer/locality identities. Existing rows already satisfy
-- the prior key; this forward-only index preserves every row and rejects only new duplicate identities.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM medicaid_state_rate_schedule
    GROUP BY state_code, level_of_care, canonical_payer_id, county_code, effective_from
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '1537 found duplicate nullable medicaid_state_rate_schedule identities; resolve rows manually before applying';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE medicaid_state_rate_schedule
  DROP CONSTRAINT medicaid_state_rate_schedule_uq;--> statement-breakpoint
ALTER TABLE medicaid_state_rate_schedule
  ADD CONSTRAINT medicaid_state_rate_schedule_uq
  UNIQUE NULLS NOT DISTINCT
  (state_code, level_of_care, canonical_payer_id, county_code, effective_from);
