-- F-204 (#248) — grant the lab-transmission recovery permissions (F-203) to the operational roles a tenant is expected
-- to have, so a tenant with ONE org admin can still complete a two-person recovery.
--
-- F-203 granted `orders.transmission.{recover,view_held,cosign_escalated}` to `administrator` + `org_admin` only. The
-- `not_received_by_lab` recovery needs a DIFFERENT user to co-sign, so a tenant with a single admin could file a request
-- nobody could execute. This adds the grants below WHEREVER THE TENANT HAS CREATED THE ROLE (nothing materializes
-- `ROLE_TEMPLATES`, so a tenant that has no `director_of_nursing` role gets nothing here and is unchanged):
--
--   director_of_nursing  → recover, view_held
--   clinical_supervisor  → recover, view_held
--   compliance_officer   → cosign_escalated, view_held
--
-- Idempotent (`ON CONFLICT DO NOTHING`); never removes a grant; the `permission` mirror rows exist since 0273. The single
-- source of truth is `LAB_RECOVERY_DEFAULT_GRANTS` in packages/auth/src/roles/lab-recovery-grants.ts — the live test in
-- `m11-orm-recovery.live.test.ts` pins this file to it.
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", g."permission_key"
  FROM "role" r
  JOIN (VALUES
    ('director_of_nursing', 'orders.transmission.recover'),
    ('director_of_nursing', 'orders.transmission.view_held'),

    ('clinical_supervisor', 'orders.transmission.recover'),
    ('clinical_supervisor', 'orders.transmission.view_held'),
    ('compliance_officer',  'orders.transmission.cosign_escalated'),
    ('compliance_officer',  'orders.transmission.view_held')
  ) AS g("role_key", "permission_key") ON g."role_key" = r."key"
 WHERE r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
