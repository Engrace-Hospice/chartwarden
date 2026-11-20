-- compat: expand
-- M15 (discipline care plans; the care_plan twin is 1494, control CW-AC-44): the default discipline_plan.* grants for the two
-- RN role keys and the aide's acknowledgment key, wherever a tenant has created them. Pinned to DISCIPLINE_PLAN_DEFAULT_GRANTS
-- (packages/auth/src/roles/discipline-plan-grants.ts) by packages/auth/__tests__/discipline-plan-grants.test.ts.
-- Insert-only and idempotent; a role created later is not touched.
--   rn_case_manager  read, read_summary, author, finalize, sign
--   rn               read, read_summary, author, finalize, sign (signVersion accepts any RN in the Aide POC's RN slot; on the
--                    MSW and volunteer plans that slot stays the RN case manager's, so the key alone signs nothing else)
--   chha             sign only (the Aide POC's CHHA acknowledgment slot, CoP 418.76; no read key, which is not scoped by plan kind)
-- RBAC only: which patient is the care-team scope (caseload_or_scope / discipline_scope / signer role match), unchanged.
-- Not granted: discipline_plan.idg_revise and discipline_plan.read_internal (system paths).
-- A disabled role is included on purpose: every effective-permission path joins `role.enabled`, so its keys are inert
-- until a tenant re-enables it, and it must not come back without them. The rows carry no actor (a migration has no
-- user), so the audit trigger's correlation id names this file: filter `audit_event` on it to list or reverse the batch.
SELECT set_config('app.correlation_id', 'migration-1526-discipline-plan-default-grants', true);--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", g.permission_key
  FROM "role" r
  JOIN (VALUES
    ('rn', 'discipline_plan.read'),
    ('rn', 'discipline_plan.read_summary'),
    ('rn', 'discipline_plan.author'),
    ('rn', 'discipline_plan.finalize'),
    ('rn', 'discipline_plan.sign'),
    ('rn_case_manager', 'discipline_plan.read'),
    ('rn_case_manager', 'discipline_plan.read_summary'),
    ('rn_case_manager', 'discipline_plan.author'),
    ('rn_case_manager', 'discipline_plan.finalize'),
    ('rn_case_manager', 'discipline_plan.sign'),
    ('chha', 'discipline_plan.sign')
  ) AS g(role_key, permission_key) ON g.role_key = r."key"
 WHERE r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
