-- M36 WP 6.5 (ADR-0095, PROPOSED) - AI thread summaries and reply drafts. One permission; no table, no column, no flag row.
--   messaging.ai.use: ask for an AI summary or a reply draft of a conversation the caller can read. The route also demands the per-tenant
--   flag `messaging.ai.enabled` (absent = off, the existing feature_flag mechanism), M32's own gates (ai.full, capability lifecycle, tenant
--   opt-in, clinician opt-out, kill switch, token cap) and CURRENT membership of the channel at call time. Granted to the two full-catalog
--   admin roles only (the 1204 shape), so existing tenants match a freshly materialized one; the clinical lead names who else (hazard H-08).
-- Nothing is stored by M36: a generated summary or draft lives in the browser, and the only server copy is M32's encrypted ai_invocation row.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.ai.use', 'message_ai', 'use', 'clinical', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.ai.use'
  FROM "role" r
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
