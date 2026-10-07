-- GAP-152 — M29 acknowledge-abnormal is persisted.
--
-- POST /observations/:id/acknowledge-abnormal used to return a literal object: nothing was stored and the M36
-- abnormal-flag badge was never cleared. The acknowledgement is now stamped on the observation (once) and
-- `m29.lab_observation.abnormal_acknowledged` is published for M36. Additive nullable columns on the
-- partitioned parent (propagate to every partition); the FORCEd RLS policy, grants and audit trigger already
-- cover the new columns (the audit scrub denylist does not include them: neither is PHI by itself).
ALTER TABLE "lab_observation" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lab_observation" ADD COLUMN IF NOT EXISTS "acknowledged_by_membership_id" uuid;
