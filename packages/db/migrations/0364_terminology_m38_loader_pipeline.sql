-- M38 §2.4.2 / §3.1 / §3.7 / §4.3 (GAP-108) — the database half of the terminology LOAD PIPELINE
-- (`packages/terminology-loader`): the write door for concept ingestion, staging, activation, the licence gate,
-- and the seven concept tables the catalog always promised but never had.
--
-- WHAT WAS MISSING. 0206 built the registration door only ("whoever writes the concept-ingestion half needs those
-- ten lines in the same diff"): `terminology_loader` had INSERT/UPDATE grants on the concept tables and NO row
-- policy, so every write matched nothing; the only way ICD-10-CM ever got loaded was `scripts/db/load-icd10cm.ts`
-- as a superuser with `session_replication_role = replica`. This migration adds the policies, the SECURITY DEFINER
-- functions the worker calls as `wardenx_app`, and the staging area the §2.4.2 state machine needs.
--
-- DESIGN CALLS (each also in the spec changelog, 2026-10-06):
--  (1) STAGING IS A SEPARATE TABLE (`concept_staging`), not rows in the concept tables with a "staged" flag. The
--      provider reads concept tables by effective date with no version-status filter, so a staged row there would
--      be visible to clinical lookups before activation. In staging a failed load deletes its rows and there is
--      provably no residue; activation copies staging into the concept table in ONE transaction.
--  (2) THE LOADER NEVER DELETES A CONCEPT ROW (§7.2). Activation INSERTs the new version's rows and UPDATEs the
--      prior version's `end_date`/`status` (retired codes -> `deprecated`); the only DELETEs are on staging and on
--      a value set's own expansion.
--  (3) BULK LOADS ARE NOT PER-ROW AUDITED. A 98k-row ICD-10-CM load would write 98k full-diff audit events. The
--      eleven concept-table audit triggers get `WHEN (current_user IS DISTINCT FROM 'terminology_loader')`:
--      `terminology_loader` is NOLOGIN and writes only inside the SECURITY DEFINER functions below, so the guard
--      cannot be reached by tenant traffic (and `wardenx_app` has no write grant on these tables at all). The
--      version row (audited), the update ledger (counts, checksum, source) and the deprecation mapping remain
--      the audit record — the reasoning the old loader script documented for `session_replication_role = replica`.
--  (4) LICENCE ATTESTATIONS (`terminology_license_attestation`): nothing existing fits (M40's mdm_baa_record is a
--      per-org entity BAA, `code_system.license_source` is only a label). A load of any system whose catalog
--      `license_source` is `umls`/`regenstrief` (or that is SNOMED / LOINC / RxNorm, whatever the label) is refused
--      without an active attestation (licensee, licence reference,
--      attested_by, effective/expiry, attribution text) — at registration, at staging and again at activation.
--  (5) RxNorm's catalog `license_source` becomes 'umls': the FULL release is UMLS-licensed (only the Current
--      Prescribable subset is public). Spec §3.9 had it 'public'.

-- ── (1) the seven concept tables (§2.3 one table per system; common shape, no bespoke columns yet) ──────────────
DO $$
DECLARE s text; t text;
BEGIN
  FOREACH s IN ARRAY ARRAY['icd10pcs','ndc','hcpcs','cvx','revenue','carc','rarc'] LOOP
    t := 'concept_' || s;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I (
         code text NOT NULL,
         display text NOT NULL,
         status concept_status NOT NULL,
         effective_date date NOT NULL,
         end_date date,
         version_id uuid NOT NULL REFERENCES code_system_version(id),
         properties jsonb NOT NULL DEFAULT ''{}''::jsonb,
         created_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT %I PRIMARY KEY (code, version_id))',
      t, t || '_code_version_id_pk');
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (code)', s || '_code_idx', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (code, effective_date, end_date)', s || '_asof_idx', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I USING gin (display gin_trgm_ops)', s || '_display_trgm_idx', t);
  END LOOP;
END $$;--> statement-breakpoint

-- ── (2) staging + licence attestation ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "concept_staging" (
  "version_id" uuid NOT NULL REFERENCES "code_system_version"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('concept', 'deprecation')),
  "code" text NOT NULL,
  "display" text NOT NULL,
  "status" "concept_status" NOT NULL DEFAULT 'active',
  "effective_date" date,
  "end_date" date,
  "properties" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "concept_staging_version_id_kind_code_pk" PRIMARY KEY ("version_id", "kind", "code")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "terminology_license_attestation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "system_id" "code_system_id" NOT NULL REFERENCES "code_system"("id") ON DELETE RESTRICT,
  "licensee" text NOT NULL CHECK (btrim("licensee") <> ''),
  "license_reference" text NOT NULL CHECK (btrim("license_reference") <> ''),
  "attested_by" uuid NOT NULL REFERENCES "user"("id"),
  "attested_at" timestamptz NOT NULL DEFAULT now(),
  "effective_from" date NOT NULL,
  "effective_to" date,
  "attribution_text" text NOT NULL CHECK (btrim("attribution_text") <> ''),
  "revoked_at" timestamptz,
  "revoked_by" uuid REFERENCES "user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "terminology_license_attestation_dates_chk" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "terminology_license_attestation_system_idx" ON "terminology_license_attestation" ("system_id", "effective_from");--> statement-breakpoint

-- ── (3) RLS, grants, loader policies ─────────────────────────────────────────────────────────────────────────
-- New concept tables + attestation: read-all for wardenx_app (platform reference data), loader writes.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'concept_icd10pcs','concept_ndc','concept_hcpcs','concept_cvx','concept_revenue','concept_carc','concept_rarc',
    'terminology_license_attestation'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO wardenx_app USING (true)', t || '_read', t);
    EXECUTE format('GRANT SELECT ON %I TO wardenx_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO terminology_loader', t);
    EXECUTE format('GRANT ALL ON %I TO wardenx_admin', t);
  END LOOP;
END $$;--> statement-breakpoint

-- Staging: loader only. wardenx_app gets NO grant (staged rows must never be readable by tenant traffic).
ALTER TABLE "concept_staging" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "concept_staging" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "concept_staging" TO terminology_loader;--> statement-breakpoint
GRANT ALL ON "concept_staging" TO wardenx_admin;--> statement-breakpoint

-- The row policies 0015 granted privileges for but never created (see 0206's header), for every table the
-- load functions below touch. Scoped to terminology_loader only; wardenx_app's read policies are untouched.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'concept_icd10cm','concept_snomed','concept_loinc','concept_rxnorm',
    'concept_icd10pcs','concept_ndc','concept_hcpcs','concept_cvx','concept_revenue','concept_carc','concept_rarc',
    'deprecation_mapping','value_set_expansion','concept_embedding',
    'concept_staging','terminology_license_attestation'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_loader_write', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO terminology_loader USING (true) WITH CHECK (true)', t || '_loader_write', t);
  END LOOP;
END $$;--> statement-breakpoint
-- `terminology_loader_replace_expansion` checks the value set exists: without a SELECT policy the probe sees an empty
-- table and refuses every value set as unknown (the silent-policy trap again).
DROP POLICY IF EXISTS "value_set_loader_read" ON "value_set";--> statement-breakpoint
CREATE POLICY "value_set_loader_read" ON "value_set" FOR SELECT TO terminology_loader USING (true);--> statement-breakpoint
-- An expansion is REPLACED per value set, so the loader needs DELETE there (and nowhere on canonical content).
GRANT DELETE ON "value_set_expansion" TO terminology_loader;--> statement-breakpoint

-- ── (4) audit triggers: new tables, and the bulk-load guard on all eleven concept tables ─────────────────────
CREATE TRIGGER "terminology_license_attestation_audit" AFTER INSERT OR UPDATE OR DELETE ON terminology_license_attestation
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
DO $$
DECLARE s text; t text;
BEGIN
  FOREACH s IN ARRAY ARRAY['icd10cm','snomed','loinc','rxnorm','icd10pcs','ndc','hcpcs','cvx','revenue','carc','rarc'] LOOP
    t := 'concept_' || s;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_audit', t);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW
         WHEN (current_user IS DISTINCT FROM ''terminology_loader'')
         EXECUTE FUNCTION wardenx_audit_trigger()',
      t || '_audit', t);
  END LOOP;
END $$;--> statement-breakpoint

-- ── (5) RxNorm's full release is UMLS-licensed ───────────────────────────────────────────────────────────────
UPDATE "code_system" SET "license_source" = 'umls', "updated_at" = now() WHERE "id" = 'rxnorm' AND "license_source" <> 'umls';--> statement-breakpoint

-- ── (6) the licence gate ─────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION terminology_loader_assert_license(p_system code_system_id) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_source text;
BEGIN
  SELECT cs.license_source INTO v_source FROM code_system cs WHERE cs.id = p_system;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'TERMINOLOGY_UNKNOWN_SYSTEM: % is not in the code_system catalog', p_system
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_source = 'ama' THEN
    RAISE EXCEPTION 'TERMINOLOGY_LICENSE_UNSUPPORTED: % is AMA-licensed and deferred (D4)', p_system
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Gated = a licensed source label (umls / regenstrief) OR one of the three licence-bound systems, whatever the
  -- catalog label says (an older loader wrote free-text labels such as 'CDC/NCHS (public domain)'; those are public).
  IF v_source NOT IN ('umls', 'regenstrief') AND p_system::text NOT IN ('snomed', 'loinc', 'rxnorm') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM terminology_license_attestation a
    WHERE a.system_id = p_system AND a.revoked_at IS NULL
      AND a.effective_from <= current_date AND (a.effective_to IS NULL OR a.effective_to >= current_date)
  ) THEN
    RAISE EXCEPTION 'TERMINOLOGY_LICENSE_ATTESTATION_REQUIRED: % (license source %) has no active licence attestation', p_system, v_source
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION terminology_loader_record_license_attestation(
  p_system code_system_id, p_licensee text, p_license_reference text, p_attested_by uuid,
  p_effective_from date, p_effective_to date, p_attribution_text text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_source text; v_id uuid;
BEGIN
  SELECT cs.license_source INTO v_source FROM code_system cs WHERE cs.id = p_system;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'TERMINOLOGY_UNKNOWN_SYSTEM: % is not in the code_system catalog', p_system
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_source NOT IN ('umls', 'regenstrief', 'ama') AND p_system::text NOT IN ('snomed', 'loinc', 'rxnorm') THEN
    RAISE EXCEPTION 'TERMINOLOGY_LICENSE_NOT_REQUIRED: % is a public code system and needs no attestation', p_system
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO terminology_license_attestation (
    system_id, licensee, license_reference, attested_by, effective_from, effective_to, attribution_text
  ) VALUES (p_system, p_licensee, p_license_reference, p_attested_by, p_effective_from, p_effective_to, p_attribution_text)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION terminology_loader_revoke_license_attestation(p_id uuid, p_revoked_by uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE terminology_license_attestation a SET revoked_at = now(), revoked_by = p_revoked_by
  WHERE a.id = p_id AND a.revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;--> statement-breakpoint

-- ── (7) registration, now licence-gated and able to retry a failed version ───────────────────────────────────
-- Same signature and OUT columns as 0206's, so the Drizzle ops store is unchanged. Two additions:
--   • the licence gate (before ANY insert);
--   • a `failed` (system, version) is re-registrable: the row is reset to `loading` with the new source/checksum
--     and reported `created = true`. Without this a checksum typo could never be corrected — the idempotency
--     key would forever return the dead row.
CREATE OR REPLACE FUNCTION terminology_loader_register_version(
  p_system code_system_id, p_version text, p_source_file_ref text, p_checksum text,
  p_released_on date, p_effective_from date, p_loaded_by uuid
) RETURNS TABLE(version_id uuid, created boolean, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
  v_created boolean := false;
  v_status text;
BEGIN
  PERFORM terminology_loader_assert_license(p_system);

  SELECT v.id, v.status::text INTO v_id, v_status
  FROM code_system_version v WHERE v.code_system_id = p_system AND v.version = p_version;

  IF v_id IS NOT NULL AND v_status = 'failed' THEN
    UPDATE code_system_version
       SET status = 'loading', source_file_ref = p_source_file_ref, checksum = p_checksum,
           released_on = p_released_on, effective_from = p_effective_from, loaded_by = p_loaded_by, loaded_at = now()
     WHERE id = v_id;
    INSERT INTO terminology_update_log (system_id, version_id, action, summary)
    VALUES (p_system, v_id, 'loaded', jsonb_build_object('phase', 'retry_registered', 'version', p_version,
            'source_file_ref', p_source_file_ref));
    RETURN QUERY SELECT v_id, true, 'loading'::text;
    RETURN;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO code_system_version (
      code_system_id, version, released_on, effective_from, effective_to, source_file_ref, checksum, status, loaded_by
    ) VALUES (p_system, p_version, p_released_on, p_effective_from, NULL, p_source_file_ref, p_checksum, 'loading', p_loaded_by)
    ON CONFLICT (code_system_id, version) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      v_created := true;
      v_status := 'loading';
      INSERT INTO terminology_update_log (system_id, version_id, action, summary)
      VALUES (p_system, v_id, 'loaded', jsonb_build_object('phase', 'registered', 'version', p_version,
              'source_file_ref', p_source_file_ref, 'note', 'version registered; concept ingestion is performed by the loader worker'));
    ELSE
      SELECT v.id, v.status::text INTO v_id, v_status
      FROM code_system_version v WHERE v.code_system_id = p_system AND v.version = p_version;
    END IF;
  END IF;
  RETURN QUERY SELECT v_id, v_created, v_status;
END;
$$;--> statement-breakpoint

-- ── (8) stage a chunk of parsed rows ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION terminology_loader_stage_concepts(p_version uuid, p_kind text, p_rows jsonb, p_reset boolean)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_system code_system_id; v_status text; v_n integer;
BEGIN
  SELECT v.code_system_id, v.status::text INTO v_system, v_status FROM code_system_version v WHERE v.id = p_version;
  IF v_system IS NULL THEN
    RAISE EXCEPTION 'TERMINOLOGY_VERSION_NOT_FOUND: %', p_version USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_status <> 'loading' THEN
    RAISE EXCEPTION 'TERMINOLOGY_VERSION_NOT_LOADING: version is %, only a loading version accepts staged rows', v_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_kind NOT IN ('concept', 'deprecation') THEN
    RAISE EXCEPTION 'TERMINOLOGY_STAGE_KIND_INVALID: %', p_kind USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 5000 THEN
    RAISE EXCEPTION 'TERMINOLOGY_STAGE_BATCH_INVALID: rows must be a JSON array of at most 5000' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM terminology_loader_assert_license(v_system);
  IF p_reset THEN DELETE FROM concept_staging s WHERE s.version_id = p_version; END IF;
  INSERT INTO concept_staging (version_id, kind, code, display, status, effective_date, end_date, properties)
  SELECT p_version, p_kind, r.code, r.display, r.status::concept_status, r.effective_date, r.end_date,
         COALESCE(r.properties, '{}'::jsonb)
  FROM jsonb_to_recordset(p_rows) AS r(code text, display text, status text, effective_date date, end_date date, properties jsonb);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;--> statement-breakpoint

-- ── (9) loading -> staged, with the diff vs the prior active version ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION terminology_loader_mark_staged(p_version uuid, p_expected integer)
RETURNS TABLE(r_concepts integer, r_new integer, r_retired integer, r_changed integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_system code_system_id; v_status text; v_name text; v_tbl text; v_prior uuid;
  v_count integer; v_new integer := 0; v_retired integer := 0; v_changed integer := 0;
BEGIN
  SELECT v.code_system_id, v.status::text, v.version INTO v_system, v_status, v_name FROM code_system_version v WHERE v.id = p_version;
  IF v_system IS NULL THEN
    RAISE EXCEPTION 'TERMINOLOGY_VERSION_NOT_FOUND: %', p_version USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_status <> 'loading' THEN
    RAISE EXCEPTION 'TERMINOLOGY_VERSION_NOT_LOADING: version is %', v_status USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::integer INTO v_count FROM concept_staging s WHERE s.version_id = p_version AND s.kind = 'concept';
  IF v_count <> p_expected OR v_count = 0 THEN
    RAISE EXCEPTION 'TERMINOLOGY_STAGING_COUNT_MISMATCH: staged % rows, expected %', v_count, p_expected
      USING ERRCODE = 'data_exception';
  END IF;
  v_tbl := 'concept_' || v_system::text;
  SELECT v.id INTO v_prior FROM code_system_version v
   WHERE v.code_system_id = v_system AND v.status = 'active' AND v.effective_to IS NULL AND v.id <> p_version
   ORDER BY v.effective_from DESC LIMIT 1;
  IF v_prior IS NOT NULL THEN
    EXECUTE format(
      'SELECT count(*) FROM concept_staging s WHERE s.version_id = %L AND s.kind = ''concept''
         AND NOT EXISTS (SELECT 1 FROM %I c WHERE c.version_id = %L AND c.code = s.code)', p_version, v_tbl, v_prior) INTO v_new;
    EXECUTE format(
      'SELECT count(DISTINCT c.code) FROM %I c WHERE c.version_id = %L AND c.status = ''active''
         AND NOT EXISTS (SELECT 1 FROM concept_staging s WHERE s.version_id = %L AND s.kind = ''concept'' AND s.code = c.code)',
      v_tbl, v_prior, p_version) INTO v_retired;
    EXECUTE format(
      'SELECT count(*) FROM concept_staging s JOIN %I c ON c.version_id = %L AND c.code = s.code
        WHERE s.version_id = %L AND s.kind = ''concept'' AND c.display IS DISTINCT FROM s.display',
      v_tbl, v_prior, p_version) INTO v_changed;
  ELSE
    v_new := v_count;
  END IF;
  UPDATE code_system_version SET status = 'staged' WHERE id = p_version;
  INSERT INTO terminology_update_log (system_id, version_id, action, concept_count, new_codes, retired_codes, summary)
  VALUES (v_system, p_version, 'loaded', v_count, v_new, v_retired,
          jsonb_build_object('phase', 'staged', 'version', v_name, 'prior_version_id', v_prior, 'changed_displays', v_changed));
  RETURN QUERY SELECT v_count, v_new, v_retired, v_changed;
END;
$$;--> statement-breakpoint

-- ── (10) staged -> active (+ supersede prior, map deprecations) in ONE transaction ──────────────────────────
CREATE OR REPLACE FUNCTION terminology_loader_activate_version(p_version uuid, p_activated_by uuid)
RETURNS TABLE(r_concepts integer, r_new integer, r_retired integer, r_deprecations integer, r_prior uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_system code_system_id; v_status text; v_name text; v_from date; v_tbl text; v_prior uuid; v_prior_from date;
  v_cols text; v_sel text; v_join text; v_eff text;
  v_inserted integer; v_new integer; v_retired integer := 0;
BEGIN
  SELECT v.code_system_id, v.status::text, v.version, v.effective_from
    INTO v_system, v_status, v_name, v_from FROM code_system_version v WHERE v.id = p_version;
  IF v_system IS NULL THEN
    RAISE EXCEPTION 'TERMINOLOGY_VERSION_NOT_FOUND: %', p_version USING ERRCODE = 'foreign_key_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('terminology.activate.' || v_system::text, 0));
  SELECT v.status::text INTO v_status FROM code_system_version v WHERE v.id = p_version;
  IF v_status = 'active' THEN
    RETURN QUERY SELECT 0, 0, 0, 0, NULL::uuid;  -- already active: idempotent
    RETURN;
  END IF;
  IF v_status <> 'staged' THEN
    RAISE EXCEPTION 'TERMINOLOGY_VERSION_NOT_STAGED: version is %, only a staged version can be activated', v_status
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM terminology_loader_assert_license(v_system);

  v_tbl := 'concept_' || v_system::text;
  SELECT v.id, v.effective_from INTO v_prior, v_prior_from FROM code_system_version v
   WHERE v.code_system_id = v_system AND v.status = 'active' AND v.effective_to IS NULL AND v.id <> p_version
   ORDER BY v.effective_from DESC LIMIT 1;
  IF v_prior IS NOT NULL AND v_prior_from >= v_from THEN
    RAISE EXCEPTION 'TERMINOLOGY_VERSION_NOT_NEWER: effective_from % is not after the active version''s %', v_from, v_prior_from
      USING ERRCODE = 'check_violation';
  END IF;

  v_join := format('LEFT JOIN (SELECT DISTINCT code FROM %I WHERE version_id = %L) pc ON pc.code = s.code',
                   v_tbl, COALESCE(v_prior, '00000000-0000-0000-0000-000000000000'::uuid));
  -- A code the prior version already had keeps the new version's span; a genuinely new code keeps the date the
  -- source declared for it (HCPCS ACT EFF DT, SNOMED effectiveTime, NDC start marketing …) or falls back to the span.
  v_eff := format('CASE WHEN pc.code IS NOT NULL THEN %L::date ELSE COALESCE(s.effective_date, %L::date) END', v_from, v_from);
  IF v_system = 'icd10cm' THEN
    v_cols := 'is_billable_leaf, chapter, parent_code, properties';
    v_sel := $q$COALESCE((s.properties->>'isBillableLeaf')::boolean, false), s.properties->>'chapter', s.properties->>'parentCode', s.properties - 'isBillableLeaf' - 'chapter' - 'parentCode'$q$;
  ELSIF v_system = 'snomed' THEN
    v_cols := 'fully_specified_name, semantic_tag, hierarchy_path, properties';
    v_sel := $q$COALESCE(s.properties->>'fullySpecifiedName', s.display), s.properties->>'semanticTag', CASE WHEN jsonb_typeof(s.properties->'hierarchyPath') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(s.properties->'hierarchyPath')) END, s.properties - 'fullySpecifiedName' - 'semanticTag' - 'hierarchyPath'$q$;
  ELSIF v_system = 'loinc' THEN
    v_cols := $q$component, property, "time", "system", scale, method, short_name, properties$q$;
    v_sel := $q$s.properties->>'component', s.properties->>'property', s.properties->>'time', s.properties->>'system', s.properties->>'scale', s.properties->>'method', s.properties->>'shortName', s.properties - 'component' - 'property' - 'time' - 'system' - 'scale' - 'method' - 'shortName'$q$;
  ELSIF v_system = 'rxnorm' THEN
    v_cols := 'tty, ingredient_rxcui, ndcs, properties';
    v_sel := $q$COALESCE(s.properties->>'tty', ''), s.properties->>'ingredientRxcui', CASE WHEN jsonb_typeof(s.properties->'ndcs') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(s.properties->'ndcs')) END, s.properties - 'tty' - 'ingredientRxcui' - 'ndcs'$q$;
  ELSE
    v_cols := 'properties';
    v_sel := 's.properties';
  END IF;

  EXECUTE format(
    'SELECT count(*) FROM concept_staging s %s WHERE s.version_id = %L AND s.kind = ''concept'' AND pc.code IS NULL',
    v_join, p_version) INTO v_new;
  EXECUTE format(
    'INSERT INTO %I (code, display, status, effective_date, end_date, version_id, %s)
     SELECT s.code, s.display, s.status, %s, s.end_date, %L, %s
       FROM concept_staging s %s WHERE s.version_id = %L AND s.kind = ''concept''',
    v_tbl, v_cols, v_eff, p_version, v_sel, v_join, p_version);
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_prior IS NOT NULL THEN
    -- Retired = prior-active codes the new version no longer carries, PLUS the source-detected transitions the
    -- parser staged as 'deprecation' rows (an ICD-10-CM code that is still present but is now a header).
    EXECUTE format(
      'WITH retired AS (
         SELECT pc.code FROM (SELECT DISTINCT code FROM %1$I WHERE version_id = %2$L AND status = ''active'') pc
          WHERE NOT EXISTS (SELECT 1 FROM concept_staging c WHERE c.version_id = %3$L AND c.kind = ''concept'' AND c.code = pc.code)
         UNION
         SELECT h.code FROM concept_staging h WHERE h.version_id = %3$L AND h.kind = ''deprecation''
       )
       INSERT INTO deprecation_mapping (system_id, deprecated_code, deprecation_effective, successor_codes, mapping_kind, guidance, created_in_version_id)
       SELECT %4$L::code_system_id, r.code, %5$L::date,
              ARRAY(SELECT jsonb_array_elements_text(h.properties->''successors'')),
              COALESCE(h.properties->>''mappingKind'', ''none'')::deprecation_mapping_kind,
              COALESCE(h.properties->>''guidance'', ''Not present in version '' || %6$L || ''; re-code from the documentation.''),
              %3$L
         FROM retired r LEFT JOIN concept_staging h ON h.version_id = %3$L AND h.kind = ''deprecation'' AND h.code = r.code
       ON CONFLICT (system_id, deprecated_code, deprecation_effective) DO NOTHING',
      v_tbl, v_prior, p_version, v_system::text, v_from, v_name);
    GET DIAGNOSTICS v_retired = ROW_COUNT;
    -- The prior version's rows end the day before; codes it had that the new one dropped become `deprecated`.
    EXECUTE format(
      'UPDATE %I c SET end_date = %L::date,
              status = CASE WHEN c.status = ''active'' AND NOT EXISTS (
                  SELECT 1 FROM concept_staging s WHERE s.version_id = %L AND s.kind = ''concept'' AND s.code = c.code)
                THEN ''deprecated''::concept_status ELSE c.status END
        WHERE c.version_id = %L AND c.end_date IS NULL',
      v_tbl, v_from - 1, p_version, v_prior);
    UPDATE code_system_version SET status = 'superseded', effective_to = v_from - 1 WHERE id = v_prior;
  END IF;

  UPDATE code_system_version SET status = 'active', effective_to = NULL WHERE id = p_version;
  INSERT INTO terminology_update_log (system_id, version_id, action, concept_count, new_codes, retired_codes, summary)
  VALUES (v_system, p_version, 'loaded', v_inserted, v_new, v_retired,
          jsonb_build_object('phase', 'activated', 'version', v_name, 'prior_version_id', v_prior, 'activated_by', p_activated_by));
  IF v_retired > 0 THEN
    INSERT INTO terminology_update_log (system_id, version_id, action, retired_codes, summary)
    VALUES (v_system, p_version, 'deprecated', v_retired, jsonb_build_object('version', v_name, 'effective', v_from));
  END IF;
  DELETE FROM concept_staging s WHERE s.version_id = p_version;
  RETURN QUERY SELECT v_inserted, v_new, v_retired, v_retired, v_prior;
END;
$$;--> statement-breakpoint

-- ── (11) failed load: delete staging, mark failed, ledger a content-free reason ─────────────────────────────
CREATE OR REPLACE FUNCTION terminology_loader_fail_version(p_version uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_system code_system_id; v_status text; v_name text;
BEGIN
  SELECT v.code_system_id, v.status::text, v.version INTO v_system, v_status, v_name FROM code_system_version v WHERE v.id = p_version;
  IF v_system IS NULL THEN
    RAISE EXCEPTION 'TERMINOLOGY_VERSION_NOT_FOUND: %', p_version USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_status IN ('active', 'superseded') THEN
    RAISE EXCEPTION 'TERMINOLOGY_VERSION_ALREADY_ACTIVE: an activated version cannot be failed' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM concept_staging s WHERE s.version_id = p_version;
  IF v_status <> 'failed' THEN
    UPDATE code_system_version SET status = 'failed' WHERE id = p_version;
    INSERT INTO terminology_update_log (system_id, version_id, action, summary)
    VALUES (v_system, p_version, 'loaded', jsonb_build_object('phase', 'failed', 'version', v_name, 'reason', left(COALESCE(p_reason, ''), 500)));
  END IF;
END;
$$;--> statement-breakpoint

-- ── (12) expansions + embeddings + ledger ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION terminology_loader_replace_expansion(p_value_set text, p_rows jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM value_set vs WHERE vs.id = p_value_set) THEN
    RAISE EXCEPTION 'TERMINOLOGY_UNKNOWN_VALUE_SET: %', p_value_set USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'TERMINOLOGY_EXPANSION_INVALID: rows must be a JSON array' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM value_set_expansion e WHERE e.value_set_id = p_value_set;
  INSERT INTO value_set_expansion (value_set_id, system_id, code, as_of_lower, as_of_upper, annotations)
  SELECT p_value_set, r.system_id::code_system_id, r.code, r.as_of_lower, r.as_of_upper, COALESCE(r.annotations, '{}'::jsonb)
  FROM jsonb_to_recordset(p_rows) AS r(system_id text, code text, as_of_lower date, as_of_upper date, annotations jsonb);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION terminology_loader_write_embeddings(p_version uuid, p_model text, p_rows jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_system code_system_id; v_status text; v_n integer;
BEGIN
  SELECT v.code_system_id, v.status::text INTO v_system, v_status FROM code_system_version v WHERE v.id = p_version;
  IF v_system IS NULL OR v_status <> 'active' THEN
    RAISE EXCEPTION 'TERMINOLOGY_VERSION_NOT_ACTIVE: embeddings are written only for an active version' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 1000 THEN
    RAISE EXCEPTION 'TERMINOLOGY_EMBEDDING_BATCH_INVALID: rows must be a JSON array of at most 1000' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO concept_embedding (system_id, code, asof_version, embedding, model_id)
  SELECT v_system, r.code, p_version, (r.embedding)::text::vector(384), p_model
  FROM jsonb_to_recordset(p_rows) AS r(code text, embedding jsonb)
  ON CONFLICT (system_id, code, asof_version) DO UPDATE SET embedding = EXCLUDED.embedding, model_id = EXCLUDED.model_id, created_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION terminology_loader_log_event(
  p_system code_system_id, p_version uuid, p_action terminology_update_action,
  p_concept_count integer, p_affected_value_sets integer, p_summary jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_action NOT IN ('expanded', 'embedded') THEN
    RAISE EXCEPTION 'TERMINOLOGY_LOG_ACTION_INVALID: only expanded/embedded may be ledgered through this door' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO terminology_update_log (system_id, version_id, action, concept_count, affected_value_sets, summary)
  VALUES (p_system, p_version, p_action, COALESCE(p_concept_count, 0), COALESCE(p_affected_value_sets, 0), COALESCE(p_summary, '{}'::jsonb));
END;
$$;--> statement-breakpoint

-- ── (13) ownership + execute grants (the 0206 pattern) ──────────────────────────────────────────────────────
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'terminology_loader_assert_license(code_system_id)',
    'terminology_loader_record_license_attestation(code_system_id, text, text, uuid, date, date, text)',
    'terminology_loader_revoke_license_attestation(uuid, uuid)',
    'terminology_loader_register_version(code_system_id, text, text, text, date, date, uuid)',
    'terminology_loader_stage_concepts(uuid, text, jsonb, boolean)',
    'terminology_loader_mark_staged(uuid, integer)',
    'terminology_loader_activate_version(uuid, uuid)',
    'terminology_loader_fail_version(uuid, text)',
    'terminology_loader_replace_expansion(text, jsonb)',
    'terminology_loader_write_embeddings(uuid, text, jsonb)',
    'terminology_loader_log_event(code_system_id, uuid, terminology_update_action, integer, integer, jsonb)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO terminology_loader', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO wardenx_app', f);
  END LOOP;
END $$;--> statement-breakpoint

COMMENT ON TABLE "concept_staging" IS
  'M38 §2.4.2 (GAP-108) — parsed-but-not-active rows of a loading/staged version. Loader-only; wardenx_app has no grant, so staged content is never visible to clinical lookups. Emptied on activation or failure.';--> statement-breakpoint
COMMENT ON TABLE "terminology_license_attestation" IS
  'M38 (GAP-108) — platform-operator attestation that a licence (UMLS/SNOMED, Regenstrief/LOINC, …) is held. A load of a non-public system is refused without an active row; attribution_text is shipped with the data.';--> statement-breakpoint
COMMENT ON FUNCTION terminology_loader_activate_version(uuid, uuid) IS
  'M38 §2.4.2 (GAP-108) — staged -> active in one transaction: copies staging into the concept table, ends the prior version the day before, maps retired codes into deprecation_mapping, supersedes the prior version. Never deletes a concept row.';
