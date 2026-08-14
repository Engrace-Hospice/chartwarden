-- M24 §3.x — FORCE ROW LEVEL SECURITY on `medicaid_state_plan_code` + `medicaid_state_rate_schedule`.
--
-- NOT part of GAP-099; found while re-running `test:rls:live` to verify GAP-099's migrations, and verified
-- pre-existing by re-running that suite with 0201/0202 held back (identical failure). Recorded separately
-- rather than folded into either GAP-099 migration.
--
-- WHAT IT IS. Migration 0118 swept every RLS table into `FORCE ROW LEVEL SECURITY` — without FORCE, the
-- TABLE OWNER bypasses row security entirely, so a policy is advisory against anything connecting as the
-- owner (which is what every migration and every `psql` maintenance session does). These two M24 platform
-- tables landed AFTER that sweep (migrations 0175 and 0180), each doing `ENABLE ROW LEVEL SECURITY` and
-- stopping there, so they inherited the enable-without-force gap the sweep existed to close. The structural
-- assertion in `rls-isolation.live.test.ts` ("every RLS table is FORCEd — ownership is not a bypass") has
-- been failing on them, which is the gate doing exactly its job: it named both tables precisely.
--
-- This is the whole fix. Both tables already carry their policies and grants from 0175/0180; nothing about
-- who may read or write them changes — FORCE only stops the owner from silently skipping those policies.
ALTER TABLE "medicaid_state_plan_code" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "medicaid_state_rate_schedule" FORCE ROW LEVEL SECURITY;
