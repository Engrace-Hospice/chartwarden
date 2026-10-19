-- M36 WP 5.5 (ADR-0083, PROPOSED) - session and device controls. One permission, one nullable link column, one partial index.
--   1. messaging.sessions.manage: lets a security officer list and revoke ANOTHER user's sessions in the organisation (the revoke also demands
--      a fresh step-up in the route). Granted to the two full-catalog admin roles only, like messaging.global_search.manage (1092); the tenant's
--      security officer role is named by SEC (ADR-0083 open question).
--   2. delivery_endpoint.session_id: the session that registered the endpoint (the Better Auth session id, text). Deliberately NO foreign key:
--      `session` is M2's table and a hard FK would make session deletion (sign-out, idle timeout, this revoke) depend on a user-RLS'd row; the
--      revoke expires the linked endpoints in the SAME transaction as it deletes the session, and nothing else reads this column. NULL for an
--      endpoint registered before this migration or without a session: it is never touched by a revoke (the user removes it from notification
--      preferences, as before).
--   3. A partial index for the revoke's lookup (user_id leads; the RLS predicate is on user_id).
-- delivery_endpoint stays user-owned (RLS delivery_endpoint_self on app.user_id, FORCEd by arch:tenancy's NON_ORG_SCOPED posture) and keeps its
-- write-audit trigger; no table is added, so no manifest or ownership change.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.sessions.manage', 'session_device', 'manage', 'admin', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.sessions.manage'
  FROM "role" r
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint

ALTER TABLE "delivery_endpoint" ADD COLUMN "session_id" text;--> statement-breakpoint
CREATE INDEX "delivery_endpoint_session_idx" ON "delivery_endpoint" ("user_id", "session_id") WHERE "session_id" IS NOT NULL;
