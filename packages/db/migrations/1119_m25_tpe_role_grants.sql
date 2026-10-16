-- M25 TPE permissions (hospice ADR/TPE/QIC PRD, milestone 5): grant the new keys to the roles that already hold the
-- matching appeal key, in every tenant that has them. 1118 added the catalog rows only and the template materializer
-- runs at tenant creation, so an EXISTING tenant's roles would hold none of them (the gap 1111 and 1113 each closed
-- for their own keys).
--
-- TPE parallels the appeal workflow, so the grant mirrors it instead of naming roles:
--   appeal.read -> tpe.read      appeal.create -> tpe.manage      appeal.decide -> tpe_rule.manage
-- Editing exit thresholds is a billing-lead decision, so it follows appeal.decide, the key the MAC-rule edit already
-- follows. A tenant tightens by removing a grant from a role it owns; a role with no appeal keys is unchanged. A
-- tenant that narrowed an appeal key with an ABAC override keeps that narrowing on the keys that act on one program
-- (`copy_abac`); `tpe_rule.manage` edits organization-wide rules, so it keeps its catalog default. Idempotent.
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key", "abac_override")
SELECT rp."organization_id", rp."role_id", m."new_key", CASE WHEN m."copy_abac" THEN rp."abac_override" END
  FROM "role_permission" rp
  JOIN (VALUES
    ('appeal.read', 'tpe.read', true),
    ('appeal.create', 'tpe.manage', true),
    ('appeal.decide', 'tpe_rule.manage', false)
  ) AS m ("appeal_key", "new_key", "copy_abac") ON m."appeal_key" = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
