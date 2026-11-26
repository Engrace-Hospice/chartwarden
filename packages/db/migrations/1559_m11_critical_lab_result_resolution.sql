-- compat: expand
-- #1136 (CW-CS-01) -- M11: an audited way to RESOLVE a quarantined (no-order) critical lab result.
--
-- A critical result bound to no order is quarantined in `critical_lab_result` (1297), paged, and escalated once. Nothing
-- could close it: the row stayed `quarantined_no_order` until someone edited the database. This adds the closing
-- record, and nothing else changes on the ledger row:
--
--   * `critical_lab_result_resolution` -- one APPEND-ONLY row per resolved result: WHAT the clinician decided
--     (`matched_to_order` + the order id, or `reviewed_no_action`), WHY (`reason`, required, 10-1000 chars), WHO
--     (`resolver_membership_id` + the discipline they acted under) and WHEN (`resolved_at` is the database clock; the
--     app never supplies it). UNIQUE (organization_id, critical_lab_result_id): a result is resolved once. Grants are
--     SELECT + INSERT only and a trigger rejects UPDATE and DELETE, so a cleared result cannot be re-opened, rewritten
--     or silently un-cleared by anything running as the application role. The ledger row keeps its original
--     disposition ('quarantined_no_order'); "open" is now "quarantined, no resolution row" (the escalation sweep and
--     the queue read both ask exactly that), so the app role gains NO new UPDATE grant on `critical_lab_result`. A BEFORE
--     INSERT trigger makes the claims above the database's own: it overwrites `resolved_at` with now() and requires the
--     ledger row to be a QUARANTINED one of the same organization and patient.
--   * `reason` is free clinical text: the audit trigger replaces it with '<changed>' in the before/after images
--     (`audit_scrub`, denylist ['reason']), and it never rides the outbox event or an error message.
--   * Destruction: like 1298's `order_result_review`, the destruction role gets SELECT + DELETE, an org-pinned FOR ALL
--     policy, and the append-only trigger admits a DELETE ONLY from a NON-superuser member of
--     `chartwarden_destruction`. The patient FK is ON DELETE restrict, so the M11 eraser deletes these rows before the
--     ledger rows they point at. An UPDATE is refused for everyone.
-- `matched_order_id` is a plain uuid (order_record is partitioned; the service checks the order is a lab order of the
-- same patient in the same org). Three-column tenancy, ENABLE + FORCE RLS on the canonical `app.org_id` predicate,
-- M4 write-audit trigger. Idempotent.

CREATE TABLE IF NOT EXISTS "critical_lab_result_resolution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"critical_lab_result_id" uuid NOT NULL,
	"resolution" text NOT NULL,
	"matched_order_id" uuid,
	"reason" text NOT NULL,
	"resolver_membership_id" uuid NOT NULL,
	"resolver_discipline" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clr_resolution_org_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "clr_resolution_provider_entity_fk"
		FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "clr_resolution_location_fk"
		FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "clr_resolution_patient_fk"
		FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict,
	CONSTRAINT "clr_resolution_result_fk"
		FOREIGN KEY ("critical_lab_result_id") REFERENCES "public"."critical_lab_result"("id") ON DELETE restrict,
	CONSTRAINT "clr_resolution_kind_chk"
		CHECK ("resolution" IN ('matched_to_order', 'reviewed_no_action')),
	-- "matched to order X" names the order; "reviewed, no action" names none.
	CONSTRAINT "clr_resolution_match_shape_chk"
		CHECK (("resolution" = 'matched_to_order') = ("matched_order_id" IS NOT NULL)),
	CONSTRAINT "clr_resolution_reason_chk"
		CHECK (char_length(btrim("reason")) BETWEEN 10 AND 1000),
	CONSTRAINT "clr_resolution_discipline_chk"
		CHECK (char_length("resolver_discipline") BETWEEN 1 AND 64)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "clr_resolution_once_uq"
	ON "critical_lab_result_resolution" ("organization_id", "critical_lab_result_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clr_resolution_result_idx"
	ON "critical_lab_result_resolution" ("critical_lab_result_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clr_resolution_patient_idx"
	ON "critical_lab_result_resolution" ("patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clr_resolution_provider_entity_idx"
	ON "critical_lab_result_resolution" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clr_resolution_location_idx"
	ON "critical_lab_result_resolution" ("location_id");--> statement-breakpoint

ALTER TABLE "critical_lab_result_resolution" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "critical_lab_result_resolution" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "critical_lab_result_resolution_org" ON "critical_lab_result_resolution"
    FOR ALL TO chartwarden_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
GRANT SELECT, INSERT ON "critical_lab_result_resolution" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "critical_lab_result_resolution" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, DELETE ON "critical_lab_result_resolution" TO chartwarden_destruction;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "critical_lab_result_resolution_destruction" ON "critical_lab_result_resolution"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- The database, not the app, owns the clock and the shape of the claim: `resolved_at` is overwritten with now(), and the
-- row must point at a QUARANTINED ledger row of the SAME organization and patient (the FK checks existence only, and
-- bypasses RLS). SECURITY INVOKER: the ledger read runs under the caller's own RLS.
CREATE OR REPLACE FUNCTION critical_lab_result_resolution_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.resolved_at := now();
  IF NOT EXISTS (
    SELECT 1 FROM critical_lab_result c
     WHERE c.id = NEW.critical_lab_result_id
       AND c.organization_id = NEW.organization_id
       AND c.patient_id = NEW.patient_id
       AND c.disposition = 'quarantined_no_order'
  ) THEN
    RAISE EXCEPTION 'critical_lab_result_resolution must resolve a quarantined result of the same organization and patient'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_critical_lab_result_resolution_before_insert" ON "critical_lab_result_resolution";--> statement-breakpoint
CREATE TRIGGER "trg_critical_lab_result_resolution_before_insert"
  BEFORE INSERT ON "critical_lab_result_resolution"
  FOR EACH ROW EXECUTE FUNCTION critical_lab_result_resolution_before_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION critical_lab_result_resolution_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND pg_has_role(current_user, 'chartwarden_destruction', 'MEMBER')
     AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'critical_lab_result_resolution is append-only (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_critical_lab_result_resolution_append_only" ON "critical_lab_result_resolution";--> statement-breakpoint
CREATE TRIGGER "trg_critical_lab_result_resolution_append_only"
  BEFORE UPDATE OR DELETE ON "critical_lab_result_resolution"
  FOR EACH ROW EXECUTE FUNCTION critical_lab_result_resolution_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_critical_lab_result_resolution() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'critical_lab_result_resolution.' || lower(TG_OP),
    'critical_lab_result_resolution',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_critical_lab_result_resolution() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_critical_lab_result_resolution" ON "critical_lab_result_resolution";--> statement-breakpoint
CREATE TRIGGER "trg_audit_critical_lab_result_resolution"
  AFTER INSERT OR UPDATE OR DELETE ON critical_lab_result_resolution
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_critical_lab_result_resolution();
