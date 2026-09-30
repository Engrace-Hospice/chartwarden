-- F-210 (#250/#251) — M23: the TENANT-ENTERED, effective-dated hospice per-diem RATE TABLE.
--
-- `POST /claims/assemble` stopped at `SEAM_UNBOUND` on `referenceData.hippsRateTable` / `.chcHourlyRateCents` because no CMS
-- per-diem rate data existed anywhere in the repository. The decision is that rates are TENANT-ENTERED (no bundled CMS data
-- file to go stale): a billing administrator keys the published national base per-diems for a fiscal year, per ProviderEntity.
--
-- One row = one VERSION of one provider entity's rate set over `[effective_from, effective_to]` (`effective_to` NULL = open).
-- Exactly the six numbers the M23 calculators consume, all PRE-wage-index whole cents:
--   rhc_days_1_60 / rhc_days_61_plus / chc_per_diem / irc_per_diem / gip_per_diem   (packages/billing HippsRateTable)
--   chc_hourly_rate_cents                                                            (the SIA add-on's hourly rate)
--
-- APPEND-ONLY VERSIONING. A rate row is never edited in place: a correction SUPERSEDES it (`superseded_at`/`superseded_by_id`
-- are the only columns the app role may UPDATE, write-once, enforced by a column-level GRANT and a trigger). Only rows with
-- `superseded_at IS NULL` are "live"; a database EXCLUDE constraint makes two live rows for one provider entity with
-- overlapping dates impossible, so the date lookup has at most one answer. Already-assembled claims are unaffected by a later
-- change: the assembled per-diems are snapshotted onto `hipps_calculation` at assembly time.
--
-- Not PHI. Org-scoped (`organization_id` NOT NULL, canonical `app.org_id` RLS ENABLED + FORCED). `provider_entity_id` is a
-- logical FK (M23 cross-module FK policy, as `sequestration_policy`). Idempotent.

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hospice_rate_table" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "fiscal_year_starting" integer NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "rhc_days_1_60_per_diem_cents" integer NOT NULL,
  "rhc_days_61_plus_per_diem_cents" integer NOT NULL,
  "chc_per_diem_cents" integer NOT NULL,
  "irc_per_diem_cents" integer NOT NULL,
  "gip_per_diem_cents" integer NOT NULL,
  "chc_hourly_rate_cents" integer NOT NULL,
  "entered_by_membership_id" uuid NOT NULL,
  "entry_reason" text,
  "superseded_at" timestamp with time zone,
  "superseded_by_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "hospice_rate_table_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "hospice_rate_table_period_chk" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  CONSTRAINT "hospice_rate_table_fy_chk" CHECK ("fiscal_year_starting" BETWEEN 2000 AND 2100),
  -- Mis-entry guards on a financial input: positive, and inside a band that catches dollars-keyed-as-cents (a $220 per-diem
  -- typed "220") and cents-keyed-as-dollars. Bounds are deliberately generous; they are not the CMS schedule.
  CONSTRAINT "hospice_rate_table_per_diem_chk" CHECK (
    "rhc_days_1_60_per_diem_cents" BETWEEN 1000 AND 1000000
    AND "rhc_days_61_plus_per_diem_cents" BETWEEN 1000 AND 1000000
    AND "chc_per_diem_cents" BETWEEN 1000 AND 1000000
    AND "irc_per_diem_cents" BETWEEN 1000 AND 1000000
    AND "gip_per_diem_cents" BETWEEN 1000 AND 1000000),
  CONSTRAINT "hospice_rate_table_hourly_chk" CHECK ("chc_hourly_rate_cents" BETWEEN 100 AND 100000),
  -- CMS pays days 1-60 at least as much as day 61+ (ADR-0001).
  CONSTRAINT "hospice_rate_table_rhc_tier_chk" CHECK ("rhc_days_1_60_per_diem_cents" >= "rhc_days_61_plus_per_diem_cents"),
  -- The CHC hourly rate is the 24-hour rate / 24; a published hourly rounds to whole cents, so 24 x hourly is within 24 cents.
  CONSTRAINT "hospice_rate_table_chc_hourly_agrees_chk" CHECK (abs("chc_per_diem_cents" - 24 * "chc_hourly_rate_cents") <= 24),
  -- A superseded row names its successor, and only a superseded row does.
  CONSTRAINT "hospice_rate_table_superseded_chk" CHECK (("superseded_at" IS NULL) = ("superseded_by_id" IS NULL)),
  -- At most ONE live version covers any date for a provider entity (race-safe at the database).
  CONSTRAINT "hospice_rate_table_no_overlap" EXCLUDE USING gist (
    "organization_id" WITH =, "provider_entity_id" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  ) WHERE ("superseded_at" IS NULL)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "hospice_rate_table_lookup_idx"
  ON "hospice_rate_table" ("organization_id", "provider_entity_id", "effective_from" DESC);--> statement-breakpoint

ALTER TABLE "hospice_rate_table" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hospice_rate_table" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "hospice_rate_table_org" ON "hospice_rate_table";--> statement-breakpoint
CREATE POLICY "hospice_rate_table_org" ON "hospice_rate_table"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- The app inserts a version and may only stamp the two supersede columns; it can never edit a rate or delete a row.
GRANT SELECT, INSERT ON "hospice_rate_table" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("superseded_at", "superseded_by_id") ON "hospice_rate_table" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "hospice_rate_table" TO wardenx_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION hospice_rate_table_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only a NON-superuser member of the destruction role: a superuser is implicitly a member of every role.
    IF pg_has_role(current_user, 'wardenx_destruction', 'MEMBER')
       AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'hospice_rate_table cannot be deleted (only the destruction role may erase it)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'hospice_rate_table row is superseded and immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.provider_entity_id <> OLD.provider_entity_id
     OR NEW.fiscal_year_starting <> OLD.fiscal_year_starting
     OR NEW.effective_from <> OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
     OR NEW.rhc_days_1_60_per_diem_cents <> OLD.rhc_days_1_60_per_diem_cents
     OR NEW.rhc_days_61_plus_per_diem_cents <> OLD.rhc_days_61_plus_per_diem_cents
     OR NEW.chc_per_diem_cents <> OLD.chc_per_diem_cents
     OR NEW.irc_per_diem_cents <> OLD.irc_per_diem_cents
     OR NEW.gip_per_diem_cents <> OLD.gip_per_diem_cents
     OR NEW.chc_hourly_rate_cents <> OLD.chc_hourly_rate_cents
     OR NEW.entered_by_membership_id <> OLD.entered_by_membership_id
     OR NEW.entry_reason IS DISTINCT FROM OLD.entry_reason
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'hospice_rate_table rates are append-only; supersede the row instead of editing it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_hospice_rate_table_guard" ON "hospice_rate_table";--> statement-breakpoint
CREATE TRIGGER "trg_hospice_rate_table_guard"
  BEFORE UPDATE OR DELETE ON "hospice_rate_table"
  FOR EACH ROW EXECUTE FUNCTION hospice_rate_table_guard();--> statement-breakpoint

-- M4 write-audit trigger (the sequestration_policy shape): every version and every supersede lands in audit_event.
CREATE OR REPLACE FUNCTION audit_phi_write_hospice_rate_table() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'hospice_rate_table.' || lower(TG_OP), 'hospice_rate_table', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_hospice_rate_table() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_hospice_rate_table" ON "hospice_rate_table";--> statement-breakpoint
CREATE TRIGGER "trg_audit_hospice_rate_table" AFTER INSERT OR UPDATE OR DELETE ON hospice_rate_table
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hospice_rate_table();--> statement-breakpoint

-- Org destruction (0157's pattern): SELECT + DELETE for eraseOrgBillingConfig, and an org-pinned destruction policy.
GRANT SELECT, DELETE ON "hospice_rate_table" TO wardenx_destruction;--> statement-breakpoint
DROP POLICY IF EXISTS "hospice_rate_table_destruction" ON "hospice_rate_table";--> statement-breakpoint
CREATE POLICY "hospice_rate_table_destruction" ON "hospice_rate_table"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- The two new permission keys' catalog mirror rows + the full-catalog admin roles' grants (0273's pattern), so an existing
-- tenant has someone who can enter rates before the catalog sync next runs. No other role is granted anything on purpose.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('billing.rate_table.read',  'billing_rate_table', 'read',  'billing', 'provider_entity_billing_scope', ''),
  ('billing.rate_table.admin', 'billing_rate_table', 'admin', 'billing', 'provider_entity_billing_scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", p."key"
  FROM "role" r
 CROSS JOIN (VALUES ('billing.rate_table.read'), ('billing.rate_table.admin')) AS p("key")
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
