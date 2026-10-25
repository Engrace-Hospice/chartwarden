-- M41 Billing - Commercial (issue #722): the three permission keys the commercial claim routes gate on. No table, no column.
--   commercial_billing.read                read commercial claims, their lines, validation results and authorizations.
--   commercial_billing.write               assemble, validate, make ready and void a commercial claim; record and change
--                                          pre-authorizations.
--   commercial_billing.override_validation override one soft-block validation result with a recorded reason (step-up, audited).
-- Granted to administrator and org_admin by role key, and to every role that already holds the Medicare analogue
-- (billing.claim.read, billing.claim.assemble, billing.validation.override): whoever bills Medicare may bill a commercial plan.
-- Existing tenants get it here; new tenants from the catalog (administrator / org_admin through the non-platform catalog).
-- Idempotent.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('commercial_billing.read', 'commercial_billing', 'read', 'billing', 'commercial_claim_in_billing_caseload', ''),
  ('commercial_billing.write', 'commercial_billing', 'write', 'billing', 'commercial_billing_provider_scope', ''),
  ('commercial_billing.override_validation', 'commercial_billing', 'override_validation', 'billing', 'commercial_override_eligible', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", k."key"
  FROM "role" r
 CROSS JOIN (VALUES ('commercial_billing.read'), ('commercial_billing.write'), ('commercial_billing.override_validation')) AS k("key")
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", m."new_key"
  FROM "role_permission" rp
  JOIN (VALUES
    ('billing.claim.read', 'commercial_billing.read'),
    ('billing.claim.assemble', 'commercial_billing.write'),
    ('billing.validation.override', 'commercial_billing.override_validation')
  ) AS m("old_key", "new_key") ON m."old_key" = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
