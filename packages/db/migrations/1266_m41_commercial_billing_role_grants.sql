-- M41 Billing - Commercial (issue #722): role grants for the claim lane's permission keys. No table, no column, no new key (migration
-- 1265 created commercial_billing.read / .write / .override_validation and granted them to compliance_officer, administrator and
-- org_admin). Here every role that already holds the Medicare analogue also gets the commercial key, because whoever bills Medicare
-- may bill a commercial plan: billing.claim.read -> read, billing.claim.assemble -> write, billing.validation.override ->
-- override_validation. The override additionally needs a billing override role in scope (the commercial_override_eligible predicate)
-- and a fresh step-up. Idempotent.
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", m."new_key"
  FROM "role_permission" rp
  JOIN (VALUES
    ('billing.claim.read', 'commercial_billing.read'),
    ('billing.claim.assemble', 'commercial_billing.write'),
    ('billing.validation.override', 'commercial_billing.override_validation')
  ) AS m("old_key", "new_key") ON m."old_key" = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
