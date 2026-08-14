-- M40 §7.4/§7.6 (GAP-099) — the SECURITY DEFINER functions the `mdm_canonical_writer` role was created
-- to own.
--
-- WHAT WAS MISSING. Migration 0019 created the role, the canonical read-all policies and the
-- `GRANT SELECT, INSERT, UPDATE ON external_physician TO mdm_canonical_writer` — and said, in prose, that
-- "the SECURITY DEFINER NPPES/merge/promote functions in packages/mdm own that grant". Those functions
-- were never written. `wardenx_app` has SELECT and nothing else on every canonical table (deliberately:
-- §3.6's whole point is that even buggy tenant-pool code cannot mutate platform master data), and no
-- process anywhere holds a `mdm_canonical_writer` credential. So the canonical physician record has been
-- READ-ONLY since the table landed — M40's NPPES appliers, its nightly delta job and its merge approval
-- all had a role, a policy and a grant pointing at a write path with no door in it.
--
-- This migration builds the two doors the M29 NPPES consumers need (§4.7.1 minimum-update, §4.7.2
-- deactivation). The merge/promote functions §7.6 also names are a different workflow (merge_request is a
-- wardenx_admin break-glass surface with its own approval chain) and are NOT built here — that stays
-- honestly unwired rather than half-wired.
--
-- THE PATTERN is the repo's standard one (0013 audit_writer / 0186 report_writer / 0199 nppes_sync_writer):
-- the function body names its own table and columns, `wardenx_app` gets EXECUTE and never role membership.
-- Scope cannot be widened through an argument — the only caller-supplied targeting is a single canonical
-- row id.
--
-- WHY A jsonb PATCH RATHER THAN COLUMN PARAMETERS. §4.7.1 is a MINIMUM-update: apply only the fields NPPES
-- flagged as changed AND whose value actually differs. With plain parameters, "leave this column alone"
-- and "set this column to NULL" are the same argument — and `credentials` / `specialty_taxonomy` are both
-- genuinely nullable, so that ambiguity is not theoretical. Key PRESENCE (`p_updates ? 'credentials'`) is
-- the only encoding that distinguishes them.

-- ── (0) THE MISSING POLICY. Found by the GAP-099 live suite, and it is the more interesting half of this
-- migration: `mdm_canonical_writer_apply_nppes_update` returned 0 — matched no row — on a row that plainly
-- existed. Migration 0019 gave the role its TABLE PRIVILEGES (`GRANT SELECT, INSERT, UPDATE ON
-- external_physician TO mdm_canonical_writer`) and created exactly one policy on the table:
-- `external_physician_read FOR SELECT TO wardenx_app USING (true)`. RLS is ENABLED, so with no permissive
-- policy naming `mdm_canonical_writer`, every row is invisible to it and every UPDATE quietly affects
-- nothing. A GRANT is not a POLICY — the same shape as GAP-045's finding that BYPASSRLS is not a GRANT,
-- inverted. Had the §7.6 functions been written back in M40-T03 they would have appeared to work and
-- written nothing, with no error anywhere.
--
-- SCOPED TO external_physician DELIBERATELY. `facility`, `payer` and `entity_relationship` carry the
-- identical grant-without-policy gap, and no function owns them yet, so a policy there would be as inert
-- as the grant is today. Naming the gap here is worth more than pre-emptively opening three write paths
-- nothing uses: whoever writes the facility/payer/relationship writers needs this line in the same diff.
DROP POLICY IF EXISTS "external_physician_canonical_writer" ON "external_physician";--> statement-breakpoint
CREATE POLICY "external_physician_canonical_writer" ON "external_physician"
  FOR ALL TO mdm_canonical_writer
  USING (true) WITH CHECK (true);--> statement-breakpoint
COMMENT ON POLICY "external_physician_canonical_writer" ON "external_physician" IS
  'GAP-099 — the row policy migration 0019 granted privileges for but never created. Without it the mdm_canonical_writer SECURITY DEFINER functions see zero rows and every canonical write silently matches nothing.';--> statement-breakpoint

-- ── (1) the §4.7.1 minimum-update applier ──────────────────────────────────────────────────────────────
-- Returns the number of rows actually written (0 = the row is gone or is `merged`), so the caller can tell
-- "applied" from "silently matched nothing" instead of assuming success.
CREATE OR REPLACE FUNCTION mdm_canonical_writer_apply_nppes_update(
  p_id uuid,
  p_updates jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE external_physician SET
    first_name = CASE WHEN p_updates ? 'first_name'
      THEN p_updates->>'first_name' ELSE first_name END,
    last_name = CASE WHEN p_updates ? 'last_name'
      THEN p_updates->>'last_name' ELSE last_name END,
    credentials = CASE WHEN p_updates ? 'credentials'
      THEN p_updates->>'credentials' ELSE credentials END,
    specialty_taxonomy = CASE WHEN p_updates ? 'specialty_taxonomy'
      THEN p_updates->>'specialty_taxonomy' ELSE specialty_taxonomy END,
    nppes_provenance = CASE WHEN p_updates ? 'nppes_provenance'
      THEN p_updates->'nppes_provenance' ELSE nppes_provenance END,
    nppes_last_synced_at = CASE WHEN p_updates ? 'nppes_last_synced_at'
      THEN (p_updates->>'nppes_last_synced_at')::timestamptz ELSE nppes_last_synced_at END,
    updated_at = now()
  -- A `merged` canonical is a tombstone that redirects to its survivor (§2.4.1): writing registry data
  -- into it would resurrect a record every reader is supposed to follow past. The applier's own NPI
  -- lookup already excludes merged rows, so reaching this predicate means the merge landed mid-flight.
  WHERE id = p_id AND status <> 'merged';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;--> statement-breakpoint
ALTER FUNCTION mdm_canonical_writer_apply_nppes_update(uuid, jsonb) OWNER TO mdm_canonical_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION mdm_canonical_writer_apply_nppes_update(uuid, jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION mdm_canonical_writer_apply_nppes_update(uuid, jsonb) TO wardenx_app;--> statement-breakpoint

-- ── (2) the §4.7.2 deactivation ────────────────────────────────────────────────────────────────────────
-- Only an `active` row flips. A second delivery of the same deactivation writes nothing and returns 0
-- (the decision layer already returns `already_deactivated`, but the door itself is idempotent too), and a
-- `merged` or `provisional` canonical is never deactivated by a registry event.
CREATE OR REPLACE FUNCTION mdm_canonical_writer_deactivate_physician(
  p_id uuid,
  p_provenance jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE external_physician SET
    status = 'deactivated',
    nppes_provenance = COALESCE(p_provenance, nppes_provenance),
    nppes_last_synced_at = now(),
    updated_at = now()
  WHERE id = p_id AND status = 'active';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;--> statement-breakpoint
ALTER FUNCTION mdm_canonical_writer_deactivate_physician(uuid, jsonb) OWNER TO mdm_canonical_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION mdm_canonical_writer_deactivate_physician(uuid, jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION mdm_canonical_writer_deactivate_physician(uuid, jsonb) TO wardenx_app;--> statement-breakpoint

-- The 0019 `external_physician_audit` trigger (M1's null-safe baseline, since the table is org-less) fires
-- on both statements above and appends the full before/after to `audit_event` — §3.7's requirement that
-- every NPPES delta on the canonical be reconstructable. Nothing extra to grant: that trigger is itself
-- SECURITY DEFINER and inserts as its own definer.
COMMENT ON FUNCTION mdm_canonical_writer_apply_nppes_update(uuid, jsonb) IS
  'M40 §4.7.1 (GAP-099) — the minimum-update door into external_physician for the M29 NPPES applier. jsonb key PRESENCE selects the columns to write, so a nullable field can be set to NULL distinguishably from being left alone.';--> statement-breakpoint
COMMENT ON FUNCTION mdm_canonical_writer_deactivate_physician(uuid, jsonb) IS
  'M40 §4.7.2 (GAP-099) — flips an active canonical physician to deactivated on an NPPES deactivation event. Idempotent: only an active row matches.';
