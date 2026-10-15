-- M25 reopening permissions (hospice ADR/TPE/QIC PRD, milestone 3): grant the new keys to the roles that already hold
-- the matching appeal key, in every tenant that has them. 1112 added the catalog rows only and the template
-- materializer runs at tenant creation, so an EXISTING tenant's roles would hold none of them (the same gap 2b hit:
-- the ADR screen was a 403 for administrator / org_admin until 1111).
--
-- Reopening parallels the appeal workflow, so the grant mirrors it instead of naming roles:
--   appeal.read -> reopening.read           appeal.create -> reopening.manage
--   appeal.submit -> reopening.submit       appeal.decide -> denial.route_override and denial_route.manage
-- Overriding a route and editing routing rules are billing-lead decisions, so they follow appeal.decide, the key the
-- MAC-rule edit already follows. A tenant tightens by removing a grant from a role it owns; a role with no appeal
-- keys is unchanged. Idempotent.
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", m."new_key"
  FROM "role_permission" rp
  JOIN (VALUES
    ('appeal.read', 'reopening.read'),
    ('appeal.create', 'reopening.manage'),
    ('appeal.submit', 'reopening.submit'),
    ('appeal.decide', 'denial.route_override'),
    ('appeal.decide', 'denial_route.manage')
  ) AS m ("appeal_key", "new_key") ON m."appeal_key" = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
