-- M36 WP 4.12 (ADR-0080) - the read-only on-call directory. One permission, no table, no enum, no column.
-- messaging.oncall.read: may read "who is covering now" for a role (names and roles only; nothing is paged or sent). Granted to every
-- tenant role that already holds messaging.read: a directory of who to call is an everyday clinical-staff need, and the route also
-- requires messaging.read, so this grants nothing beyond what those roles already reach except this one read. PROVISIONAL until the
-- clinical lead signs the role map (docs/messaging-hub/brief-clinical-lead-signoff.md). A tenant tightens by removing the grant from a
-- role it owns. The tenant flag messaging.oncall_directory (absent = off) gates the route.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.oncall.read', 'oncall_directory', 'read', 'clinical', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", 'messaging.oncall.read'
  FROM "role_permission" rp
 WHERE rp."permission_key" = 'messaging.read'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
