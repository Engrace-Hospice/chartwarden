-- M36 WP 6.2 (ADR-0110, PROPOSED) - response analytics. One permission; no table, no column, no flag row.
--   messaging.analytics.read: read the AGGREGATE response figures (acknowledgment latency, escalation rate, handoff acceptance time,
--   per-discipline response) over a date range. Granted to compliance_officer, administrator and org_admin only (mirrors 1138); the tenant
--   decides who else, but an individual-level view needs HR/compliance review and has no key and no route at all.
-- Nothing else is stored: the figures are computed live from message_acknowledgment_request / _event and clinical_handoff by the
-- tenant's own session (FORCE RLS), so the three-column rule, RLS, manifest ownership and enum mirrors have nothing new to cover. The
-- per-tenant switch is the existing feature_flag mechanism (`messaging.response_analytics`, absent = off).
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.analytics.read', 'response_analytics', 'read', 'compliance', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.analytics.read'
  FROM "role" r
 WHERE r."key" IN ('compliance_officer', 'administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
