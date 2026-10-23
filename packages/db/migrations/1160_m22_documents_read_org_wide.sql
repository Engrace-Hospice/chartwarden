-- F-023 (browser audit, #592) - `GET /api/v1/documents` now lists the actor's caseload, not the whole org.
-- `documents.read_org_wide` is the view-only key a tenant grants to a role that legitimately lists every
-- document (HIM, intake, billing review). Metadata only: content stays behind `documents.read_phi_content`.
-- No role is granted it here - org-wide oversight roles already list everything by role, and widening a
-- clinical role is the tenant's call. Mirrors 1156 (additive, idempotent).
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('documents.read_org_wide', 'document', 'read_org_wide', 'clinical', 'none', '')
ON CONFLICT ("key") DO NOTHING;
