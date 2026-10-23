-- M25 milestone 8a-1 permissions: grant the readiness keys to the roles that already hold the matching ADR key, in every
-- tenant that has them. 1180 added the catalog rows only and the template materializer runs at tenant creation, so an
-- EXISTING tenant's roles would hold none of them (the gap 1111 and 1173 each closed for their own keys).
--
-- Readiness is advisory and parallels packet assembly, so the grant mirrors the ADR keys instead of naming roles:
--   adr.read -> adr.readiness_read          adr.manage -> adr.readiness_request, adr.readiness_dispose
-- request and dispose are deliberately mirrored from adr.manage: readiness is advisory and gates nothing, so the person who
-- requested a review may also record its dispositions (no separation of duties is wanted here). No role template and no
-- external_auditor role holds adr.read, and an auditor session reaches only the enrolment allowlist, so none gets readiness_read.
-- A tenant tightens by removing a grant from a role it owns; a role with no ADR keys is unchanged. No ABAC override is
-- copied: an override names a predicate written for adr_case rows. Idempotent.
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", m."new_key"
  FROM "role_permission" rp
  JOIN (VALUES
    ('adr.read', 'adr.readiness_read'),
    ('adr.manage', 'adr.readiness_request'),
    ('adr.manage', 'adr.readiness_dispose')
  ) AS m ("adr_key", "new_key") ON m."adr_key" = rp."permission_key"
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
