-- M25 milestone 7a-1 permissions: grant the new keys to the roles that already hold the matching appeal key, in every
-- tenant that has them. 1171 / 1172 added the catalog rows only and the template materializer runs at tenant creation,
-- so an EXISTING tenant's roles would hold none of them (the gap 1111, 1113 and 1119 each closed for their own keys).
--
-- Audit intake and later-tier record-keeping parallel the appeal workflow, so the grant mirrors it instead of naming roles:
--   appeal.read -> audit_request.read     appeal.create -> audit_request.manage     appeal.create -> appeal.tier_record
-- A tenant tightens by removing a grant from a role it owns; a role with no appeal keys is unchanged. A tenant that
-- narrowed an appeal key with an ABAC override keeps that narrowing (`abac_override` is copied). Idempotent.
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key", "abac_override")
SELECT rp."organization_id", rp."role_id", m."new_key", rp."abac_override"
  FROM "role_permission" rp
  JOIN (VALUES
    ('appeal.read', 'audit_request.read'),
    ('appeal.create', 'audit_request.manage'),
    ('appeal.create', 'appeal.tier_record')
  ) AS m ("appeal_key", "new_key") ON m."appeal_key" = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
