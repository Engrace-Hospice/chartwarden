-- M25 milestone 7a-2 permissions: grant the new audit-response keys to the roles that already hold the matching appeal
-- key, in every tenant that has them. 1175 added the catalog rows only and the template materializer runs at tenant
-- creation, so an EXISTING tenant's roles would hold neither (the gap 1111, 1113, 1119 and 1173 each closed for their
-- own keys). The audit workflow parallels the ADR one, so the grant mirrors it (1111):
--   appeal.decide -> audit_request.review (sign off)      appeal.submit -> audit_request.submit (record the filing)
-- The ABAC override is NOT copied (a predicate written for appeal cases would be inert or wrong on an audit request,
-- the 1173 reasoning). A tenant tightens by removing a grant from a role it owns; a role with no appeal keys is
-- unchanged. Idempotent.
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", m."audit_key"
  FROM "role_permission" rp
  JOIN (VALUES
    ('appeal.decide', 'audit_request.review'),
    ('appeal.submit', 'audit_request.submit')
  ) AS m ("appeal_key", "audit_key") ON m."appeal_key" = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
