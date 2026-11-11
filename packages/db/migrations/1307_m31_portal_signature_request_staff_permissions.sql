-- compat: expand
-- ADR-0107 (PROPOSED) - the three STAFF permission keys for portal signature requests (create / read / void), mirrored into the DB catalog
-- (the 1253 / 1306 shape). Staff hold them through role_permission as an admin assigns them, so only the catalog rows are needed here:
-- no table, no column, no role grant. Idempotent.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('portal.signature_request.create', 'portal_signature_request', 'create', 'admin', 'caseload_membership', ''),
  ('portal.signature_request.read', 'portal_signature_request', 'read', 'admin', 'caseload_membership', ''),
  ('portal.signature_request.void', 'portal_signature_request', 'void', 'admin', 'caseload_membership', '')
ON CONFLICT ("key") DO NOTHING;
