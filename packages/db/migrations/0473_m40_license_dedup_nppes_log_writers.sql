-- 0473 — M40 GAP-173: what the remaining §4.3 jobs need to exist.
--
--   (1) `mdm_license_record` — the Phase-1 manual license entry (§4.1 POST /mdm/license/manual, D6). The route
--       was a documented no-op ("no canonical license table"), so `mdm.license_expiration_scan` had nothing to
--       scan. Tenant-scoped (each tenant records its own verification of an entity's license), no PHI.
--   (2) `mdm_canonical_writer_scan_fuzzy_duplicates` — the `mdm.fuzzy_dedup_scan` writer. `merge_request` has no
--       writer at all (0019 §5: `wardenx_admin` only), so a pending proposal could never be produced.
--   (3) `mdm_canonical_writer_record_nppes_sync` — the `nppes_sync_log` writer for the nightly delta / weekly
--       full sweep (0019 §6 left the table `wardenx_admin`-only).
-- The writer functions follow 0202 / 0205 / 0470 exactly: `mdm_canonical_writer` owns them, EXECUTE goes to
-- `wardenx_app`, nothing else is opened on the tables.

-- ── (1) mdm_license_record ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "mdm_license_record" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "entity_kind" "mdm_entity_kind" NOT NULL,
  "canonical_id" uuid NOT NULL,
  "license_state" text NOT NULL,
  "expires_on" date NOT NULL,
  "entered_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mdm_license_record_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade,
  CONSTRAINT "mdm_license_record_state_shape" CHECK ("license_state" ~ '^[A-Z]{2}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mdm_license_unique"
  ON "mdm_license_record" ("organization_id", "entity_kind", "canonical_id", "license_state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mdm_license_expires_idx" ON "mdm_license_record" ("expires_on");--> statement-breakpoint
ALTER TABLE "mdm_license_record" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mdm_license_record" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "mdm_license_record_org" ON "mdm_license_record";--> statement-breakpoint
CREATE POLICY "mdm_license_record_org" ON "mdm_license_record"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "mdm_license_record" TO wardenx_app;--> statement-breakpoint
-- Tenant offboarding (D7): the M40 eraser deletes this table with the other overlay rows (0157 pattern).
GRANT SELECT, DELETE ON "mdm_license_record" TO wardenx_destruction;--> statement-breakpoint
DROP POLICY IF EXISTS "mdm_license_record_destruction" ON "mdm_license_record";--> statement-breakpoint
CREATE POLICY "mdm_license_record_destruction" ON "mdm_license_record"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_mdm_license_record() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'mdm_license_record.' || lower(TG_OP),
    'mdm_license_record',
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
ALTER FUNCTION audit_phi_write_mdm_license_record() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_mdm_license_record" ON "mdm_license_record";--> statement-breakpoint
CREATE TRIGGER "trg_audit_mdm_license_record" AFTER INSERT OR UPDATE OR DELETE ON mdm_license_record
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_mdm_license_record();--> statement-breakpoint

-- ── (2) the fuzzy-dedup writer ─────────────────────────────────────────────────────────────────────────
-- Canonical-side reads + the merge_request insert. `facility` had a grant but no writer policy (0202's own
-- comment names the gap); this is the first function that reads it as the definer, so the policy lands here.
GRANT SELECT ON "facility" TO mdm_canonical_writer;--> statement-breakpoint
DROP POLICY IF EXISTS "facility_canonical_writer_read" ON "facility";--> statement-breakpoint
CREATE POLICY "facility_canonical_writer_read" ON "facility"
  FOR SELECT TO mdm_canonical_writer USING (true);--> statement-breakpoint
GRANT INSERT ON "merge_request" TO mdm_canonical_writer;--> statement-breakpoint

-- Proposes `merge_request` rows (proposed_by = 'fuzzy_job', status 'pending') for likely duplicates of ONE kind
-- (`physician` | `facility`). BLOCKING keeps it linear-ish: physicians are compared only within the same lower-cased
-- last name, facilities only within the same 4-character name prefix, so the self-join never goes quadratic over the
-- whole directory. Two physicians that BOTH carry an NPI and differ are NEVER proposed (the NPI is authoritative —
-- they are two people). The pair is stored canonical = the NPI-bearing / older row, duplicate = the other, and the
-- partial unique index `merge_request_unique_pair` makes a re-scan a no-op (ON CONFLICT DO NOTHING). Returns the
-- number of NEW proposals.
CREATE OR REPLACE FUNCTION mdm_canonical_writer_scan_fuzzy_duplicates(
  p_kind text,
  p_threshold real DEFAULT 0.85,
  p_limit integer DEFAULT 200
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_inserted integer := 0;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
  v_threshold real := LEAST(GREATEST(COALESCE(p_threshold, 0.85), 0.5), 1.0);
BEGIN
  IF p_kind = 'physician' THEN
    WITH cand AS (
      SELECT
        CASE WHEN a.npi IS NULL AND b.npi IS NOT NULL THEN b.id ELSE a.id END AS canonical_id,
        CASE WHEN a.npi IS NULL AND b.npi IS NOT NULL THEN a.id ELSE b.id END AS duplicate_id,
        similarity(lower(a.first_name || ' ' || a.last_name), lower(b.first_name || ' ' || b.last_name)) AS name_score,
        (a.npi IS NOT NULL AND a.npi = b.npi) AS npi_match
      FROM external_physician a
      JOIN external_physician b
        ON lower(a.last_name) = lower(b.last_name) AND a.id < b.id
      WHERE a.status <> 'merged' AND b.status <> 'merged'
        AND NOT (a.npi IS NOT NULL AND b.npi IS NOT NULL AND a.npi <> b.npi)
        AND similarity(lower(a.first_name || ' ' || a.last_name), lower(b.first_name || ' ' || b.last_name)) >= v_threshold
      ORDER BY 3 DESC
      LIMIT v_limit
    )
    INSERT INTO merge_request (entity_kind, canonical_id, duplicate_id, proposed_by, evidence, status)
    SELECT 'physician', canonical_id, duplicate_id, 'fuzzy_job',
           jsonb_build_object('nameScore', round(name_score::numeric, 3), 'npiMatch', npi_match, 'lastNameExact', true),
           'pending'
    FROM cand
    ON CONFLICT (entity_kind, canonical_id, duplicate_id) WHERE status IN ('pending', 'approved') DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  ELSIF p_kind = 'facility' THEN
    WITH cand AS (
      SELECT
        CASE WHEN a.ccn IS NULL AND b.ccn IS NOT NULL THEN b.id ELSE a.id END AS canonical_id,
        CASE WHEN a.ccn IS NULL AND b.ccn IS NOT NULL THEN a.id ELSE b.id END AS duplicate_id,
        similarity(lower(a.name), lower(b.name)) AS name_score,
        (a.ccn IS NOT NULL AND a.ccn = b.ccn) AS ccn_match
      FROM facility a
      JOIN facility b
        ON left(lower(a.name), 4) = left(lower(b.name), 4) AND a.id < b.id
      WHERE a.status <> 'merged' AND b.status <> 'merged'
        AND NOT (a.ccn IS NOT NULL AND b.ccn IS NOT NULL AND a.ccn <> b.ccn)
        AND similarity(lower(a.name), lower(b.name)) >= v_threshold
      ORDER BY 3 DESC
      LIMIT v_limit
    )
    INSERT INTO merge_request (entity_kind, canonical_id, duplicate_id, proposed_by, evidence, status)
    SELECT 'facility', canonical_id, duplicate_id, 'fuzzy_job',
           jsonb_build_object('nameScore', round(name_score::numeric, 3), 'ccnMatch', ccn_match),
           'pending'
    FROM cand
    ON CONFLICT (entity_kind, canonical_id, duplicate_id) WHERE status IN ('pending', 'approved') DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  ELSE
    RAISE EXCEPTION 'MDM_FUZZY_SCAN_UNSUPPORTED_KIND: %', p_kind USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v_inserted;
END;
$$;--> statement-breakpoint
ALTER FUNCTION mdm_canonical_writer_scan_fuzzy_duplicates(text, real, integer) OWNER TO mdm_canonical_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION mdm_canonical_writer_scan_fuzzy_duplicates(text, real, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION mdm_canonical_writer_scan_fuzzy_duplicates(text, real, integer) TO wardenx_app;--> statement-breakpoint

-- ── (3) the nppes_sync_log writer ──────────────────────────────────────────────────────────────────────
GRANT INSERT ON "nppes_sync_log" TO mdm_canonical_writer;--> statement-breakpoint
DROP POLICY IF EXISTS "nppes_sync_log_canonical_writer_insert" ON "nppes_sync_log";--> statement-breakpoint
CREATE POLICY "nppes_sync_log_canonical_writer_insert" ON "nppes_sync_log"
  FOR INSERT TO mdm_canonical_writer WITH CHECK (true);--> statement-breakpoint
CREATE OR REPLACE FUNCTION mdm_canonical_writer_record_nppes_sync(
  p_mode text,
  p_looked_up integer,
  p_changed integer,
  p_deactivated integer,
  p_errors integer,
  p_outcome text,
  p_error_summary jsonb DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_outcome NOT IN ('success', 'partial', 'failed') THEN
    RAISE EXCEPTION 'MDM_NPPES_SYNC_LOG_BAD_OUTCOME: %', p_outcome USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO nppes_sync_log (mode, looked_up, changed, deactivated, errors, outcome, error_summary)
  VALUES (p_mode::mdm_nppes_sync_mode, GREATEST(p_looked_up, 0), GREATEST(p_changed, 0),
          GREATEST(p_deactivated, 0), GREATEST(p_errors, 0), p_outcome, p_error_summary)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;--> statement-breakpoint
ALTER FUNCTION mdm_canonical_writer_record_nppes_sync(text, integer, integer, integer, integer, text, jsonb) OWNER TO mdm_canonical_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION mdm_canonical_writer_record_nppes_sync(text, integer, integer, integer, integer, text, jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION mdm_canonical_writer_record_nppes_sync(text, integer, integer, integer, integer, text, jsonb) TO wardenx_app;
