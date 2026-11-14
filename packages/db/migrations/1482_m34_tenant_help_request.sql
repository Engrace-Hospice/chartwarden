-- compat: expand
-- M34 slice 7 (piece 7B): onboarding help requests. A member of the tenant asks ChartWarden for help; the organization's
-- org_admin or compliance officer consents to it (which creates a non-PHI `assist` support_consent_grant); the request ends when
-- either side says so, when the grant expires, or when a request nobody answered is 14 days old.
--
-- tenant_help_request: one row per request, never deleted by the application (an ended request stays as history; the tenant-offboarding
-- eraser deletes the org's rows with its grants). Tenant-scoped on organization_id. The message is free text a MEMBER typed; it is
-- PHI-screened by the service and lives in its own column only: the row-audit trigger below records it as `<changed>`, never as text,
-- and no outbox payload, log line or error carries it (same for the operator's close note).
--
-- ONE LIVE REQUEST PER TENANT ACCOUNT is a database fact: the partial unique index `tenant_help_request_live_uq` admits one row whose
-- status is open or approved; the service answers its 23505 as 409 HELP_REQUEST_ALREADY_OPEN carrying the live request's id.
--
-- THE STATE MACHINE is a CHECK plus a guard trigger. Statuses: open -> approved -> resolved, open -> cancelled, open -> resolved (an
-- operator answered it without needing consent). `approved` carries the grant, the approving membership and the time; `cancelled`
-- never had consent (no grant, no approver); `resolved` has the grant, approver and time together or none of them. Every ended row names
-- who ended it (closed_by_actor_kind tenant | platform_ops | system) and when; a system close names no user; only an operator's Resolve
-- carries a note. The guard trigger makes every UPDATE a legal transition, and an approved request's grant link and approver can
-- never be rewritten (the column grants below let two roles touch those columns, so the trigger is what holds them still).
--
-- THE ROLES.
--   * chartwarden_app (the tenant pool, FORCEd RLS on app.org_id): SELECT its own rows; INSERT pinned (status open, nothing else
--     set, the requester is the session's own user acting through an ACTIVE membership of THIS organization); UPDATE limited to the
--     approve columns and the close columns (never message, requester, step, close_note), each by its own pinned branch: approve names
--     a grant of this organization and tenant, held by the session's own user's active membership; a tenant close is by the session user
--     with no note. There is no DELETE and no permissive FOR ALL policy.
--   * chartwarden_platform (the BYPASSRLS carrier): SELECT (the cross-tenant inbox) and a COLUMN-level UPDATE on the close columns
--     only (an operator's Resolve and the system sweep); DELETE for the offboarding eraser. Provisioned in scripts/db/
--     provision-runtime-roles.ts; granted here inside a block that runs only where the carrier already exists.
--   * RLS cannot tell an operator from a member (operators hold an active membership in every tenant), so "ChartWarden staff may not
--     file or answer a tenant's request" is the service's rule, tested; the database cannot express it.
CREATE TABLE IF NOT EXISTS "tenant_help_request" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tenant_account_id" uuid NOT NULL,
	"step_key" text,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"requested_by_membership_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"support_consent_grant_id" uuid,
	"approved_by_membership_id" uuid,
	"approved_at" timestamp with time zone,
	"closed_by_actor_kind" text,
	"closed_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	"close_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_help_request_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "tenant_help_request_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "tenant_help_request_tenant_org_fk" FOREIGN KEY ("tenant_account_id", "organization_id") REFERENCES "public"."tenant_account"("id", "organization_id") ON DELETE restrict,
	CONSTRAINT "tenant_help_request_grant_fk" FOREIGN KEY ("support_consent_grant_id") REFERENCES "public"."support_consent_grant"("id") ON DELETE restrict,
	CONSTRAINT "tenant_help_request_status_ck" CHECK ("status" IN ('open', 'approved', 'resolved', 'cancelled')),
	CONSTRAINT "tenant_help_request_closer_ck" CHECK ("closed_by_actor_kind" IS NULL OR "closed_by_actor_kind" IN ('tenant', 'platform_ops', 'system')),
	CONSTRAINT "tenant_help_request_message_ck" CHECK (length(btrim("message")) BETWEEN 8 AND 1000),
	CONSTRAINT "tenant_help_request_step_key_ck" CHECK ("step_key" IS NULL OR length("step_key") BETWEEN 1 AND 64),
	CONSTRAINT "tenant_help_request_close_note_ck" CHECK ("close_note" IS NULL OR length(btrim("close_note")) BETWEEN 8 AND 500),
	-- a system close names no user; only an operator's Resolve carries a note
	CONSTRAINT "tenant_help_request_closer_user_ck" CHECK ("closed_by_actor_kind" IS DISTINCT FROM 'system' OR "closed_by_user_id" IS NULL),
	CONSTRAINT "tenant_help_request_note_closer_ck" CHECK ("close_note" IS NULL OR "closed_by_actor_kind" = 'platform_ops'),
	CONSTRAINT "tenant_help_request_state_ck" CHECK (
	  ("status" = 'open'
	     AND "support_consent_grant_id" IS NULL AND "approved_by_membership_id" IS NULL AND "approved_at" IS NULL
	     AND "closed_by_actor_kind" IS NULL AND "closed_by_user_id" IS NULL AND "closed_at" IS NULL AND "close_note" IS NULL)
	  OR ("status" = 'approved'
	     AND "support_consent_grant_id" IS NOT NULL AND "approved_by_membership_id" IS NOT NULL AND "approved_at" IS NOT NULL
	     AND "closed_by_actor_kind" IS NULL AND "closed_by_user_id" IS NULL AND "closed_at" IS NULL AND "close_note" IS NULL)
	  OR ("status" = 'resolved'
	     AND "closed_by_actor_kind" IS NOT NULL AND "closed_at" IS NOT NULL
	     AND (("support_consent_grant_id" IS NULL AND "approved_by_membership_id" IS NULL AND "approved_at" IS NULL)
	       OR ("support_consent_grant_id" IS NOT NULL AND "approved_by_membership_id" IS NOT NULL AND "approved_at" IS NOT NULL)))
	  OR ("status" = 'cancelled'
	     AND "closed_by_actor_kind" IS NOT NULL AND "closed_at" IS NOT NULL
	     AND "support_consent_grant_id" IS NULL AND "approved_by_membership_id" IS NULL AND "approved_at" IS NULL)
	)
);--> statement-breakpoint
-- At most one live (open or approved) request per tenant account; an ended one is history.
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_help_request_live_uq" ON "tenant_help_request" ("tenant_account_id")
  WHERE "status" IN ('open', 'approved');--> statement-breakpoint
-- Leads with the composite FK's own columns (tenant_account_id, organization_id) so a parent tenant_account delete or key update does
-- not scan this table (fk-index-coverage); its requested_at tail serves the tenant's "my requests, newest first" read.
CREATE INDEX IF NOT EXISTS "tenant_help_request_tenant_ix" ON "tenant_help_request" ("tenant_account_id", "organization_id", "requested_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_help_request_org_ix" ON "tenant_help_request" ("organization_id");--> statement-breakpoint
-- The grant FK's index, and the lookup "which request belongs to this grant" (the revoke cascade, the expiry sweep).
CREATE INDEX IF NOT EXISTS "tenant_help_request_grant_ix" ON "tenant_help_request" ("support_consent_grant_id");--> statement-breakpoint
-- The operators' inbox across tenants and the sweep's scans: by status, newest first.
CREATE INDEX IF NOT EXISTS "tenant_help_request_status_ix" ON "tenant_help_request" ("status", "requested_at" DESC);--> statement-breakpoint

-- Every UPDATE is a legal transition, and an approved request's consent link is fixed. (The column grants already keep the identity,
-- message and requester columns out of every role's reach; this holds what the two roles that can write the approve and close columns
-- must not do with them: leave a closed request, re-point an approved one at another grant, or move it backwards.)
CREATE OR REPLACE FUNCTION tenant_help_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT ((OLD.status = 'open' AND NEW.status IN ('approved', 'resolved', 'cancelled'))
       OR (OLD.status = 'approved' AND NEW.status = 'resolved')) THEN
    RAISE EXCEPTION 'tenant_help_request_transition: % -> % is not a legal move', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'approved' AND (NEW.support_consent_grant_id IS DISTINCT FROM OLD.support_consent_grant_id
       OR NEW.approved_by_membership_id IS DISTINCT FROM OLD.approved_by_membership_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'tenant_help_request_consent_fixed: an approved request keeps its grant and approver' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_help_request_guard" ON tenant_help_request;--> statement-breakpoint
CREATE TRIGGER "trg_tenant_help_request_guard"
  BEFORE UPDATE ON tenant_help_request
  FOR EACH ROW EXECUTE FUNCTION tenant_help_request_guard();--> statement-breakpoint

ALTER TABLE "tenant_help_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_help_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_help_request_org_read" ON "tenant_help_request";--> statement-breakpoint
CREATE POLICY "tenant_help_request_org_read" ON "tenant_help_request"
  FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- A request is filed by the session's own user, through an ACTIVE membership of THIS organization that user holds, born open with
-- nothing else set. The tenant account is this organization's own (the composite FK).
DROP POLICY IF EXISTS "tenant_help_request_org_file" ON "tenant_help_request";--> statement-breakpoint
CREATE POLICY "tenant_help_request_org_file" ON "tenant_help_request"
  FOR INSERT TO chartwarden_app
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND status = 'open'
    AND support_consent_grant_id IS NULL AND approved_by_membership_id IS NULL AND approved_at IS NULL
    AND closed_by_actor_kind IS NULL AND closed_by_user_id IS NULL AND closed_at IS NULL AND close_note IS NULL
    AND requested_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM membership m
       WHERE m.id = tenant_help_request.requested_by_membership_id
         AND m.organization_id = tenant_help_request.organization_id
         AND m.user_id = tenant_help_request.requested_by_user_id
         AND m.status = 'active'
    )
  );--> statement-breakpoint
-- The tenant moves a live request two ways. APPROVE: open -> approved, linking a grant of THIS organization and tenant, by the session's
-- own user through their active membership of this organization. END: to cancelled or resolved, by the session's own user, with no note
-- (a note is the operator's Resolve). The guard trigger holds which transitions are legal; this holds who and with what.
DROP POLICY IF EXISTS "tenant_help_request_org_update" ON "tenant_help_request";--> statement-breakpoint
CREATE POLICY "tenant_help_request_org_update" ON "tenant_help_request"
  FOR UPDATE TO chartwarden_app
  USING (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND status IN ('open', 'approved')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND (
      (
        status = 'approved'
        AND support_consent_grant_id IS NOT NULL AND approved_at IS NOT NULL
        AND closed_by_actor_kind IS NULL AND closed_by_user_id IS NULL AND closed_at IS NULL AND close_note IS NULL
        AND EXISTS (
          SELECT 1 FROM membership m
           WHERE m.id = tenant_help_request.approved_by_membership_id
             AND m.organization_id = tenant_help_request.organization_id
             AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
             AND m.status = 'active'
        )
        AND EXISTS (
          SELECT 1 FROM support_consent_grant g
           WHERE g.id = tenant_help_request.support_consent_grant_id
             AND g.organization_id = tenant_help_request.organization_id
             AND g.tenant_account_id = tenant_help_request.tenant_account_id
        )
      )
      OR (
        status IN ('resolved', 'cancelled')
        AND closed_by_actor_kind = 'tenant'
        AND closed_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND closed_at IS NOT NULL
        AND close_note IS NULL
      )
    )
  );--> statement-breakpoint

GRANT SELECT ON "tenant_help_request" TO chartwarden_app;--> statement-breakpoint
-- INSERT is a column list (the requester's identity and what they asked); status, requested_at and every approve / close column take
-- their defaults. The repository inserts through a narrow table object because Drizzle lists every column with a DEFAULT.
GRANT INSERT ("organization_id", "tenant_account_id", "step_key", "message", "requested_by_membership_id", "requested_by_user_id") ON "tenant_help_request" TO chartwarden_app;--> statement-breakpoint
-- UPDATE: the approve columns and the close columns, never the message, the requester, the step or close_note.
GRANT UPDATE ("status", "support_consent_grant_id", "approved_by_membership_id", "approved_at", "closed_by_actor_kind", "closed_by_user_id", "closed_at", "updated_at") ON "tenant_help_request" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "tenant_help_request" TO chartwarden_admin;--> statement-breakpoint
-- The platform carrier exists only where provision-runtime-roles.ts has run; that script re-grants on every run.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT SELECT ON "tenant_help_request" TO chartwarden_platform;
    -- UPDATE is column-level (an operator's Resolve and the system sweep close a request): the consent link, the approver, the
    -- message and the requester can never be rewritten from the platform side.
    GRANT UPDATE ("status", "closed_by_actor_kind", "closed_by_user_id", "closed_at", "close_note", "updated_at") ON "tenant_help_request" TO chartwarden_platform;
    -- the tenant-offboarding eraser deletes the organization's requests before its grants (the grant FK restricts)
    GRANT DELETE ON "tenant_help_request" TO chartwarden_platform;
  END IF;
END $$;
--> statement-breakpoint

-- Row audit. The message and the operator's note are free text a person typed: the audit row records them as changed, never as text
-- (the alarm_source precedent); every other column is an id, a status or a time.
CREATE OR REPLACE FUNCTION audit_phi_write_tenant_help_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['message','close_note']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['message','close_note']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after, 'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_tenant_help_request() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "tenant_help_request_audit" ON tenant_help_request;--> statement-breakpoint
CREATE TRIGGER "tenant_help_request_audit"
  AFTER INSERT OR UPDATE OR DELETE ON tenant_help_request
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_help_request();
