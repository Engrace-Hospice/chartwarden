-- compat: expand
-- ADR-0107 (PROPOSED) - the two portal signing permission keys, mirrored into the DB catalog (the 1253 shape). Portal sessions hold them by
-- SESSION CLASS (packages/auth session-class-permissions.ts), not through role_permission, so only the catalog rows are needed: no role grant,
-- no table, no column. Idempotent.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('portal.signature.read', 'portal_signature_request', 'read', 'portal', 'portal_grant_active_for_patient', ''),
  ('portal.signature.sign', 'portal_signature_request', 'sign', 'portal', 'portal_grant_active_for_patient', '')
ON CONFLICT ("key") DO NOTHING;
