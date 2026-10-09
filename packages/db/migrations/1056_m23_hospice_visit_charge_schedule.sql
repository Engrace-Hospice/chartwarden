-- M23 — the TENANT-ENTERED, effective-dated hospice VISIT-CHARGE SCHEDULE.
--
-- A hospice claim reports every visit by hospice staff as its own line "with the appropriate line item date of service and
-- a charge amount" (CMS Pub. 100-04 ch. 11 §30.3). The charge is informational (the visit is bundled into the level-of-care
-- payment: "no additional payment is made on the visit revenue lines"), so it belongs to the hospice's own charge master,
-- not to CMS — and WardenX has none. Visit lines were billed at a hard-coded $0. A billing administrator now keys a charge
-- PER 15-MINUTE UNIT PER DISCIPLINE per provider entity, following the F-210 rate-table pattern (migration 0279):
--   rn / lpn / aide (chha) / msw / pt / ot / slp   — whole cents per 15 minutes; NULL = no charge entered (assembly then
--                                                      FAILS CLOSED with VISIT_CHARGE_MISSING); 0 = a deliberate free charge.
--
-- APPEND-ONLY VERSIONING. A row is never edited in place: a correction SUPERSEDES it (`superseded_at`/`superseded_by_id` are
-- the only columns the app role may UPDATE, write-once, enforced by a column-level GRANT and a trigger). Only rows with
-- `superseded_at IS NULL` are "live"; a database EXCLUDE constraint makes two live rows for one provider entity with
-- overlapping dates impossible. Already-assembled claims are unaffected by a later change: the line charge is snapshotted
-- onto `claim_line` at assembly.
--
-- Not PHI. Org-scoped (`organization_id` NOT NULL, canonical `app.org_id` RLS ENABLED + FORCED). `provider_entity_id` is a
-- logical FK (M23 cross-module FK policy). Idempotent.

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hospice_visit_charge_schedule" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "rn_unit_charge_cents" integer,
  "lpn_unit_charge_cents" integer,
  "aide_unit_charge_cents" integer,
  "msw_unit_charge_cents" integer,
  "pt_unit_charge_cents" integer,
  "ot_unit_charge_cents" integer,
  "slp_unit_charge_cents" integer,
  "entered_by_membership_id" uuid NOT NULL,
  "entry_reason" text,
  "superseded_at" timestamp with time zone,
  "superseded_by_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "hospice_visit_charge_schedule_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "hospice_visit_charge_schedule_period_chk" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  -- Mis-entry guard on a financial input: 0 .. $1,000.00 per 15 minutes (catches dollars keyed as cents). 0 is allowed.
  CONSTRAINT "hospice_visit_charge_schedule_band_chk" CHECK (
    ("rn_unit_charge_cents" IS NULL OR "rn_unit_charge_cents" BETWEEN 0 AND 100000)
    AND ("lpn_unit_charge_cents" IS NULL OR "lpn_unit_charge_cents" BETWEEN 0 AND 100000)
    AND ("aide_unit_charge_cents" IS NULL OR "aide_unit_charge_cents" BETWEEN 0 AND 100000)
    AND ("msw_unit_charge_cents" IS NULL OR "msw_unit_charge_cents" BETWEEN 0 AND 100000)
    AND ("pt_unit_charge_cents" IS NULL OR "pt_unit_charge_cents" BETWEEN 0 AND 100000)
    AND ("ot_unit_charge_cents" IS NULL OR "ot_unit_charge_cents" BETWEEN 0 AND 100000)
    AND ("slp_unit_charge_cents" IS NULL OR "slp_unit_charge_cents" BETWEEN 0 AND 100000)),
  -- A schedule with no charge at all is meaningless.
  CONSTRAINT "hospice_visit_charge_schedule_any_chk" CHECK (
    "rn_unit_charge_cents" IS NOT NULL OR "lpn_unit_charge_cents" IS NOT NULL OR "aide_unit_charge_cents" IS NOT NULL
    OR "msw_unit_charge_cents" IS NOT NULL OR "pt_unit_charge_cents" IS NOT NULL OR "ot_unit_charge_cents" IS NOT NULL
    OR "slp_unit_charge_cents" IS NOT NULL),
  -- A superseded row names its successor, and only a superseded row does.
  CONSTRAINT "hospice_visit_charge_schedule_superseded_chk" CHECK (("superseded_at" IS NULL) = ("superseded_by_id" IS NULL)),
  -- At most ONE live version covers any date for a provider entity (race-safe at the database).
  CONSTRAINT "hospice_visit_charge_schedule_no_overlap" EXCLUDE USING gist (
    "organization_id" WITH =, "provider_entity_id" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  ) WHERE ("superseded_at" IS NULL)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "hospice_visit_charge_schedule_lookup_idx"
  ON "hospice_visit_charge_schedule" ("organization_id", "provider_entity_id", "effective_from" DESC);--> statement-breakpoint

ALTER TABLE "hospice_visit_charge_schedule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hospice_visit_charge_schedule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "hospice_visit_charge_schedule_org" ON "hospice_visit_charge_schedule";--> statement-breakpoint
CREATE POLICY "hospice_visit_charge_schedule_org" ON "hospice_visit_charge_schedule"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- The app inserts a version and may only stamp the two supersede columns; it can never edit a charge or delete a row.
GRANT SELECT, INSERT ON "hospice_visit_charge_schedule" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("superseded_at", "superseded_by_id") ON "hospice_visit_charge_schedule" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "hospice_visit_charge_schedule" TO wardenx_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION hospice_visit_charge_schedule_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only a NON-superuser member of the destruction role: a superuser is implicitly a member of every role.
    IF pg_has_role(current_user, 'wardenx_destruction', 'MEMBER')
       AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'hospice_visit_charge_schedule cannot be deleted (only the destruction role may erase it)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'hospice_visit_charge_schedule row is superseded and immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.provider_entity_id <> OLD.provider_entity_id
     OR NEW.effective_from <> OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
     OR NEW.rn_unit_charge_cents IS DISTINCT FROM OLD.rn_unit_charge_cents
     OR NEW.lpn_unit_charge_cents IS DISTINCT FROM OLD.lpn_unit_charge_cents
     OR NEW.aide_unit_charge_cents IS DISTINCT FROM OLD.aide_unit_charge_cents
     OR NEW.msw_unit_charge_cents IS DISTINCT FROM OLD.msw_unit_charge_cents
     OR NEW.pt_unit_charge_cents IS DISTINCT FROM OLD.pt_unit_charge_cents
     OR NEW.ot_unit_charge_cents IS DISTINCT FROM OLD.ot_unit_charge_cents
     OR NEW.slp_unit_charge_cents IS DISTINCT FROM OLD.slp_unit_charge_cents
     OR NEW.entered_by_membership_id <> OLD.entered_by_membership_id
     OR NEW.entry_reason IS DISTINCT FROM OLD.entry_reason
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'hospice_visit_charge_schedule charges are append-only; supersede the row instead of editing it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_hospice_visit_charge_schedule_guard" ON "hospice_visit_charge_schedule";--> statement-breakpoint
CREATE TRIGGER "trg_hospice_visit_charge_schedule_guard"
  BEFORE UPDATE OR DELETE ON "hospice_visit_charge_schedule"
  FOR EACH ROW EXECUTE FUNCTION hospice_visit_charge_schedule_guard();--> statement-breakpoint

-- M4 write-audit trigger (the hospice_rate_table shape): every version and every supersede lands in audit_event.
CREATE OR REPLACE FUNCTION audit_phi_write_hospice_visit_charge_schedule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'hospice_visit_charge_schedule.' || lower(TG_OP), 'hospice_visit_charge_schedule', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_hospice_visit_charge_schedule() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_hospice_visit_charge_schedule" ON "hospice_visit_charge_schedule";--> statement-breakpoint
CREATE TRIGGER "trg_audit_hospice_visit_charge_schedule" AFTER INSERT OR UPDATE OR DELETE ON hospice_visit_charge_schedule
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hospice_visit_charge_schedule();--> statement-breakpoint

-- Org destruction (0157's pattern): SELECT + DELETE for eraseOrgBillingConfig, and an org-pinned destruction policy.
GRANT SELECT, DELETE ON "hospice_visit_charge_schedule" TO wardenx_destruction;--> statement-breakpoint
DROP POLICY IF EXISTS "hospice_visit_charge_schedule_destruction" ON "hospice_visit_charge_schedule";--> statement-breakpoint
CREATE POLICY "hospice_visit_charge_schedule_destruction" ON "hospice_visit_charge_schedule"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- The two new permission keys' catalog mirror rows + the full-catalog admin roles' grants (0279's pattern), so an existing
-- tenant has someone who can enter charges before the catalog sync next runs. No other role is granted anything on purpose.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('billing.visit_charge.read',  'billing_visit_charge', 'read',  'billing', 'provider_entity_billing_scope', ''),
  ('billing.visit_charge.admin', 'billing_visit_charge', 'admin', 'billing', 'provider_entity_billing_scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", p."key"
  FROM "role" r
 CROSS JOIN (VALUES ('billing.visit_charge.read'), ('billing.visit_charge.admin')) AS p("key")
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
