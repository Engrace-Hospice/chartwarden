-- F-211 (#252) — M23: TENANT-ENTERED wage index + per-level-of-care LABOR SHARE (audit M23-F02, ADR-0016 D1).
--
-- After F-210 `POST /claims/assemble` stopped at `WAGE_INDEX_UNAVAILABLE`: `wage_index_factor` is PLATFORM-SHARED, has no
-- loader, and only five non-authoritative placeholder CCNs (0080). Three things are added here.
--
-- (1) `tenant_wage_index` — the ORG-SCOPED, append-only wage-index entry surface. A tenant administrator keys the CMS-
--     published hospice wage index for a CCN + federal fiscal year. It is deliberately NOT a write path into
--     `wage_index_factor`: that table is platform-shared (D12, NO organization_id, `wardenx_app` holds SELECT only), so one
--     tenant's hand-keyed value would silently reprice EVERY tenant. The adapter reads the tenant row first, then a
--     platform AUTHORITATIVE row; a non-authoritative placeholder never prices a claim.
--     One LIVE row per (org, ccn, fiscal_year_starting) (partial unique index); a correction SUPERSEDES (append-only,
--     column-level GRANT + guard trigger, the `hospice_rate_table` shape). The factor is numeric(6,4) inside a
--     plausibility-band CHECK (0.5..2.5: the real hospice wage index spans roughly 0.7-2.0).
--
-- (2) `wage_index_factor.is_authoritative` — marks which platform rows are real CMS loads. Default TRUE (a future platform
--     loader writes real data); the five 0080 placeholder rows are flipped to FALSE.
--
-- (3) Labor shares on `hospice_rate_table`. The wage index adjusts ONLY the labor share of each rate:
--     payment = base x (labor_share x wage_index + (1 - labor_share)). CMS publishes a labor share per level of care each
--     fiscal year (they differ: IRC/GIP are lower than RHC/CHC); no repository doc states a value (ADR-0016 D1 says only
--     "each has a published labor share"), so they are TENANT-ENTERED with the rest of the rate set. NULLable so versions
--     entered under 0279 (before these columns existed) stay readable; the all-or-none CHECK forbids a half-filled set, and
--     the assembler fails CLOSED (`RATE_TABLE_LABOR_SHARE_MISSING`) on a legacy row instead of guessing a share. Band
--     0.30..0.90 catches 68.71 keyed as a percent and 0.0687. numeric(5,4).
--
-- Not PHI. Idempotent.

-- ── (2) authoritative marker on the platform table ─────────────────────────────────────────────────────────────────────
ALTER TABLE "wage_index_factor" ADD COLUMN IF NOT EXISTS "is_authoritative" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "wage_index_factor" SET "is_authoritative" = false WHERE "load_source_ref" LIKE 'TODO(cms-fixture)%';--> statement-breakpoint
COMMENT ON COLUMN "wage_index_factor"."is_authoritative" IS
  'F-211: false = a non-authoritative placeholder/fixture row (0080). Claim assembly never prices from a non-authoritative row.';--> statement-breakpoint

-- ── (3) labor shares on the rate table ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "hospice_rate_table" ADD COLUMN IF NOT EXISTS "labor_share_rhc" numeric(5,4);--> statement-breakpoint
ALTER TABLE "hospice_rate_table" ADD COLUMN IF NOT EXISTS "labor_share_chc" numeric(5,4);--> statement-breakpoint
ALTER TABLE "hospice_rate_table" ADD COLUMN IF NOT EXISTS "labor_share_irc" numeric(5,4);--> statement-breakpoint
ALTER TABLE "hospice_rate_table" ADD COLUMN IF NOT EXISTS "labor_share_gip" numeric(5,4);--> statement-breakpoint
ALTER TABLE "hospice_rate_table" DROP CONSTRAINT IF EXISTS "hospice_rate_table_labor_share_chk";--> statement-breakpoint
ALTER TABLE "hospice_rate_table" ADD CONSTRAINT "hospice_rate_table_labor_share_chk" CHECK (
  ("labor_share_rhc" IS NULL AND "labor_share_chc" IS NULL AND "labor_share_irc" IS NULL AND "labor_share_gip" IS NULL)
  -- (A CHECK passes on NULL, so each share is also asserted NOT NULL: a partly-filled set must be refused.)
  OR ("labor_share_rhc" IS NOT NULL AND "labor_share_chc" IS NOT NULL
      AND "labor_share_irc" IS NOT NULL AND "labor_share_gip" IS NOT NULL
      AND "labor_share_rhc" BETWEEN 0.30 AND 0.90 AND "labor_share_chc" BETWEEN 0.30 AND 0.90
      AND "labor_share_irc" BETWEEN 0.30 AND 0.90 AND "labor_share_gip" BETWEEN 0.30 AND 0.90));--> statement-breakpoint

-- The append-only guard now also freezes the four labor shares (CREATE OR REPLACE of 0279's function).
CREATE OR REPLACE FUNCTION hospice_rate_table_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
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
     OR NEW.labor_share_rhc IS DISTINCT FROM OLD.labor_share_rhc
     OR NEW.labor_share_chc IS DISTINCT FROM OLD.labor_share_chc
     OR NEW.labor_share_irc IS DISTINCT FROM OLD.labor_share_irc
     OR NEW.labor_share_gip IS DISTINCT FROM OLD.labor_share_gip
     OR NEW.entered_by_membership_id <> OLD.entered_by_membership_id
     OR NEW.entry_reason IS DISTINCT FROM OLD.entry_reason
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'hospice_rate_table rates are append-only; supersede the row instead of editing it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- ── (1) tenant_wage_index ──────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tenant_wage_index" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "ccn" text NOT NULL,
  "fiscal_year_starting" integer NOT NULL,
  "cbsa_code" text,
  "factor_decimal" numeric(6,4) NOT NULL,
  "source_reference" text NOT NULL,
  "entered_by_membership_id" uuid NOT NULL,
  "entry_reason" text,
  "superseded_at" timestamp with time zone,
  "superseded_by_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tenant_wage_index_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "tenant_wage_index_ccn_chk" CHECK ("ccn" ~ '^[0-9A-Za-z]{6}$'),
  CONSTRAINT "tenant_wage_index_cbsa_chk" CHECK ("cbsa_code" IS NULL OR "cbsa_code" ~ '^[0-9]{5}$'),
  CONSTRAINT "tenant_wage_index_fy_chk" CHECK ("fiscal_year_starting" BETWEEN 2000 AND 2100),
  -- Plausibility band on a hand-keyed financial input: the published hospice wage index is a ratio near 1.
  CONSTRAINT "tenant_wage_index_factor_chk" CHECK ("factor_decimal" BETWEEN 0.5 AND 2.5),
  CONSTRAINT "tenant_wage_index_source_chk" CHECK (length(btrim("source_reference")) > 0),
  CONSTRAINT "tenant_wage_index_superseded_chk" CHECK (("superseded_at" IS NULL) = ("superseded_by_id" IS NULL))
);--> statement-breakpoint

-- At most ONE live wage index per (org, ccn, fiscal year), race-safe at the database.
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_wage_index_live_uq"
  ON "tenant_wage_index" ("organization_id", "ccn", "fiscal_year_starting") WHERE "superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_wage_index_lookup_idx"
  ON "tenant_wage_index" ("organization_id", "ccn", "fiscal_year_starting", "created_at" DESC);--> statement-breakpoint

ALTER TABLE "tenant_wage_index" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_wage_index" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_wage_index_org" ON "tenant_wage_index";--> statement-breakpoint
CREATE POLICY "tenant_wage_index_org" ON "tenant_wage_index"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT ON "tenant_wage_index" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("superseded_at", "superseded_by_id") ON "tenant_wage_index" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "tenant_wage_index" TO wardenx_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION tenant_wage_index_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_has_role(current_user, 'wardenx_destruction', 'MEMBER')
       AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'tenant_wage_index cannot be deleted (only the destruction role may erase it)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'tenant_wage_index row is superseded and immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.ccn <> OLD.ccn
     OR NEW.fiscal_year_starting <> OLD.fiscal_year_starting
     OR NEW.cbsa_code IS DISTINCT FROM OLD.cbsa_code
     OR NEW.factor_decimal <> OLD.factor_decimal
     OR NEW.source_reference <> OLD.source_reference
     OR NEW.entered_by_membership_id <> OLD.entered_by_membership_id
     OR NEW.entry_reason IS DISTINCT FROM OLD.entry_reason
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'tenant_wage_index is append-only; supersede the row instead of editing it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_wage_index_guard" ON "tenant_wage_index";--> statement-breakpoint
CREATE TRIGGER "trg_tenant_wage_index_guard"
  BEFORE UPDATE OR DELETE ON "tenant_wage_index"
  FOR EACH ROW EXECUTE FUNCTION tenant_wage_index_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_tenant_wage_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'tenant_wage_index.' || lower(TG_OP), 'tenant_wage_index', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('ccn', COALESCE(NEW.ccn, OLD.ccn), 'fiscal_year_starting', COALESCE(NEW.fiscal_year_starting, OLD.fiscal_year_starting)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_tenant_wage_index() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_tenant_wage_index" ON "tenant_wage_index";--> statement-breakpoint
CREATE TRIGGER "trg_audit_tenant_wage_index" AFTER INSERT OR UPDATE OR DELETE ON tenant_wage_index
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_wage_index();--> statement-breakpoint

GRANT SELECT, DELETE ON "tenant_wage_index" TO wardenx_destruction;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_wage_index_destruction" ON "tenant_wage_index";--> statement-breakpoint
CREATE POLICY "tenant_wage_index_destruction" ON "tenant_wage_index"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- Permission catalog mirror rows + admin-role grants (0279's pattern).
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('billing.wage_index.read',  'billing_wage_index', 'read',  'billing', 'inOrg', ''),
  ('billing.wage_index.admin', 'billing_wage_index', 'admin', 'billing', 'inOrg', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", p."key"
  FROM "role" r
 CROSS JOIN (VALUES ('billing.wage_index.read'), ('billing.wage_index.admin')) AS p("key")
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
