-- M25 ADR permissions (hospice ADR/TPE/QIC PRD, milestones 2a/2b): grant the ADR keys to the roles that already
-- hold the matching appeal key, in every tenant that has them. 1107 and 1109 added the catalog rows only and the
-- template materializer runs at tenant creation, so an EXISTING tenant's roles held none of the adr.* keys and
-- nobody could open the ADR screen (found by the Docker route check: administrator / org_admin got 403
-- "requires permission 'adr.read'" while holding all six appeal.* keys).
--
-- The ADR workflow parallels appeals, so the grant mirrors it instead of naming roles:
--   appeal.read -> adr.read          appeal.create -> adr.manage (log an ADR, assemble, move it)
--   appeal.submit -> adr.submit      appeal.decide -> adr.review (sign off) and mac_rule.manage (edit MAC windows)
-- A tenant tightens by removing a grant from a role it owns; a role with no appeal keys is unchanged. Idempotent.
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", m."adr_key"
  FROM "role_permission" rp
  JOIN (VALUES
    ('appeal.read', 'adr.read'),
    ('appeal.create', 'adr.manage'),
    ('appeal.submit', 'adr.submit'),
    ('appeal.decide', 'adr.review'),
    ('appeal.decide', 'mac_rule.manage')
  ) AS m ("appeal_key", "adr_key") ON m."appeal_key" = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
