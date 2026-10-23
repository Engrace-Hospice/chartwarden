-- M25 milestone 7a-1 permissions: grant the new keys to the roles that already hold the matching appeal key, in every
-- tenant that has them. 1171 / 1172 added the catalog rows only and the template materializer runs at tenant creation,
-- so an EXISTING tenant's roles would hold none of them (the gap 1111, 1113 and 1119 each closed for their own keys).
--
-- Audit intake and later-tier record-keeping parallel the appeal workflow, so the grant mirrors it instead of naming roles:
--   appeal.read -> audit_request.read     appeal.create -> audit_request.manage     appeal.create -> appeal.tier_record
-- A tenant tightens by removing a grant from a role it owns; a role with no appeal keys is unchanged. A tenant that
-- narrowed an appeal key with an ABAC override keeps that narrowing on `appeal.tier_record` (it acts on one appeal case,
-- like the key it follows); the audit_request keys do NOT copy it: an override names a predicate written for appeal
-- cases and would be inert or wrong on an audit request. Idempotent.
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key", "abac_override")
SELECT rp."organization_id", rp."role_id", m."new_key", CASE WHEN m."copy_abac" THEN rp."abac_override" END
  FROM "role_permission" rp
  JOIN (VALUES
    ('appeal.read', 'audit_request.read', false),
    ('appeal.create', 'audit_request.manage', false),
    ('appeal.create', 'appeal.tier_record', true)
  ) AS m ("appeal_key", "new_key", "copy_abac") ON m."appeal_key" = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
