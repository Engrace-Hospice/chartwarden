-- M40 §7.6 (GAP-060) — the MERGE-APPROVAL / MERGE-REJECTION / PROVISIONAL-PROMOTION write path.
--
-- WHAT WAS BROKEN. `createDbMdmRouteService`'s `approveMerge` / `rejectMerge` / `promoteProvisional` all
-- called one helper — `governanceNotWired()` — that unconditionally threw a 501, behind three live,
-- fully-enriched admin routes. The M40 spec puts dedup/merge and reference re-pointing squarely in Phase 1
-- (the deferred list is limited to state-medical-board license adapters), and the only tests touching those
-- routes run against the in-memory backend, so nothing ever exercised the production service.
--
-- AND A SECOND, QUIETER DEFECT: `listMergeRequests` — the queue those routes act on — reads `merge_request`
-- directly on the app pool, but migration 0019 gave that table `GRANT ALL TO wardenx_admin` and NO
-- `wardenx_app` grant at all (its own comment says so). So the queue read was a `permission denied` 500
-- sitting next to the three 501s: an admin could not even see the merges they could not approve.
--
-- THE PATTERN is migration 0202's, continued: `mdm_canonical_writer` owns SECURITY DEFINER functions,
-- `wardenx_app` gets EXECUTE and never role membership. 0202 built the NPPES half and, in doing so, found
-- that 0019 had granted that role table privileges but never a ROW POLICY — so it added one for
-- `external_physician` and explicitly left facility/payer/entity_relationship for "whoever writes their
-- writers". That is this migration: a merge is kind-switched, so all three canonical tables need the policy
-- before any of it works.
--
-- WHY FUNCTIONS RATHER THAN GRANTING THE APP POOL WRITE ACCESS. §3.6's posture is that `wardenx_app` can
-- never mutate canonical master data — the whole point being that buggy tenant-pool code cannot corrupt the
-- redirect graph every other module resolves through. A merge is the single most destructive operation on
-- that graph (it makes one entity permanently redirect to another), so it is exactly the operation that
-- should stay behind a narrow, auditable door rather than the one to make an exception for.

-- ── (0) the row policies 0019 never created, for the two canonical tables 0202 deferred ────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['facility','payer'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_canonical_writer ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_canonical_writer ON %I FOR ALL TO mdm_canonical_writer USING (true) WITH CHECK (true)',
      t, t);
  END LOOP;
END $$;--> statement-breakpoint

-- The two platform-ops workflow tables the governance functions read and settle. Neither had ANY
-- `mdm_canonical_writer` grant or policy — 0019 scoped both to `wardenx_admin` alone.
GRANT SELECT, UPDATE ON "merge_request" TO mdm_canonical_writer;--> statement-breakpoint
DROP POLICY IF EXISTS "merge_request_canonical_writer" ON "merge_request";--> statement-breakpoint
CREATE POLICY "merge_request_canonical_writer" ON "merge_request"
  FOR ALL TO mdm_canonical_writer USING (true) WITH CHECK (true);--> statement-breakpoint

GRANT SELECT, UPDATE ON "mdm_provisional" TO mdm_canonical_writer;--> statement-breakpoint
DROP POLICY IF EXISTS "mdm_provisional_canonical_writer" ON "mdm_provisional";--> statement-breakpoint
-- `USING (true)` and NOT the org predicate: promotion is a PLATFORM-ops act on a tenant-staged row, and
-- the function runs with no `app.org_id` set (there is no tenant session behind a platform-ops approval).
-- The tenant-facing `mdm_provisional_org` policy is untouched — a tenant session still sees only its own.
CREATE POLICY "mdm_provisional_canonical_writer" ON "mdm_provisional"
  FOR ALL TO mdm_canonical_writer USING (true) WITH CHECK (true);--> statement-breakpoint

-- ── (1) the dedup queue read (§4.1 GET /admin/mdm/merge-requests) ──────────────────────────────────────
-- A function rather than a `wardenx_app` SELECT grant: §3.6 keeps `merge_request` off the tenant pool
-- entirely, and a read function preserves that while letting the platform-ops route work. Returns the OPEN
-- queue only — settled rows are history, reachable through the audit trail.
CREATE OR REPLACE FUNCTION mdm_canonical_writer_list_merge_requests()
RETURNS TABLE (
  id uuid,
  entity_kind text,
  canonical_id uuid,
  duplicate_id uuid,
  status text,
  evidence jsonb,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT mr.id, mr.entity_kind::text, mr.canonical_id, mr.duplicate_id, mr.status::text,
         mr.evidence, mr.created_at
  FROM merge_request mr
  WHERE mr.status IN ('pending', 'approved')
  ORDER BY mr.created_at DESC;
$$;--> statement-breakpoint
ALTER FUNCTION mdm_canonical_writer_list_merge_requests() OWNER TO mdm_canonical_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION mdm_canonical_writer_list_merge_requests() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION mdm_canonical_writer_list_merge_requests() TO wardenx_app;--> statement-breakpoint

-- ── (2) approve: flip the duplicate to `merged`, record the survivor's `merged_from`, settle the row ────
-- Kind-switched because the canonical is one of three tables (see the mapping inside — the kind name and
-- the table name are NOT the same for `physician`).
CREATE OR REPLACE FUNCTION mdm_canonical_writer_approve_merge(
  p_merge_id uuid,
  p_actor_user_id uuid
) RETURNS TABLE (duplicate_id uuid, canonical_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_merge merge_request%ROWTYPE;
  v_table text;
  v_survivor_status text;
  v_moved integer;
BEGIN
  -- FOR UPDATE: two approvers racing the same merge must not both flip the duplicate. The loser sees a
  -- settled row and gets the not-pending error, not a second execution.
  SELECT * INTO v_merge FROM merge_request WHERE id = p_merge_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MERGE_REQUEST_NOT_FOUND: %', p_merge_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_merge.status <> 'pending' THEN
    RAISE EXCEPTION 'MERGE_REQUEST_NOT_PENDING: % is %', p_merge_id, v_merge.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The kind is NOT the table name: `physician` lives in `external_physician` (the canonical is named
  -- for being an EXTERNAL provider, not for the entity kind). The other four declared kinds have no
  -- phase-1 table at all, so a merge naming one is REFUSED rather than silently settled — the merge row
  -- must not read `executed` when nothing moved.
  v_table := CASE v_merge.entity_kind
    WHEN 'physician' THEN 'external_physician'
    WHEN 'facility'  THEN 'facility'
    WHEN 'payer'     THEN 'payer'
    ELSE NULL
  END;
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'MERGE_KIND_UNSUPPORTED: % has no canonical table in phase 1', v_merge.entity_kind
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The survivor must exist and must not itself be merged away. Merging INTO a tombstone would build a
  -- redirect CHAIN, and every reader in the system resolves exactly one hop (§2.4.1).
  EXECUTE format('SELECT status::text FROM %I WHERE id = $1', v_table)
    INTO v_survivor_status USING v_merge.canonical_id;
  IF v_survivor_status IS NULL THEN
    RAISE EXCEPTION 'MERGE_SURVIVOR_NOT_FOUND: %', v_merge.canonical_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_survivor_status = 'merged' THEN
    RAISE EXCEPTION 'MERGE_SURVIVOR_ALREADY_MERGED: % redirects elsewhere', v_merge.canonical_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Flip the duplicate. `status <> 'merged'` makes this idempotent-safe: a duplicate already merged
  -- somewhere else moves 0 rows and the whole approval aborts rather than re-pointing it.
  EXECUTE format(
    'UPDATE %I SET status = ''merged'', merged_into_id = $1, updated_at = now()
     WHERE id = $2 AND status <> ''merged''', v_table)
    USING v_merge.canonical_id, v_merge.duplicate_id;
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  IF v_moved = 0 THEN
    RAISE EXCEPTION 'MERGE_DUPLICATE_NOT_MERGEABLE: % is absent or already merged', v_merge.duplicate_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Record the provenance on the survivor. Guarded against double-append so a replay cannot grow the array.
  EXECUTE format(
    'UPDATE %I SET merged_from = array_append(merged_from, $1), updated_at = now()
     WHERE id = $2 AND NOT ($1 = ANY(merged_from))', v_table)
    USING v_merge.duplicate_id, v_merge.canonical_id;

  UPDATE merge_request
  SET status = 'executed',
      approved_by = p_actor_user_id,
      approved_at = COALESCE(approved_at, now()),
      executed_at = now()
  WHERE id = p_merge_id;

  duplicate_id := v_merge.duplicate_id;
  canonical_id := v_merge.canonical_id;
  RETURN NEXT;
END;
$$;--> statement-breakpoint
ALTER FUNCTION mdm_canonical_writer_approve_merge(uuid, uuid) OWNER TO mdm_canonical_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION mdm_canonical_writer_approve_merge(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION mdm_canonical_writer_approve_merge(uuid, uuid) TO wardenx_app;--> statement-breakpoint

-- ── (3) reject: settle the proposal with a reason; no canonical is touched ─────────────────────────────
CREATE OR REPLACE FUNCTION mdm_canonical_writer_reject_merge(
  p_merge_id uuid,
  p_reason text,
  p_actor_user_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer;
BEGIN
  -- Only an OPEN proposal can be rejected. Rejecting an already-executed merge would leave the canonical
  -- redirect in place while the paperwork said the merge was refused — the worst of both records.
  UPDATE merge_request
  SET status = 'rejected',
      rejection_reason = p_reason,
      approved_by = p_actor_user_id,
      approved_at = now()
  WHERE id = p_merge_id AND status IN ('pending', 'approved');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;--> statement-breakpoint
ALTER FUNCTION mdm_canonical_writer_reject_merge(uuid, text, uuid) OWNER TO mdm_canonical_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION mdm_canonical_writer_reject_merge(uuid, text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION mdm_canonical_writer_reject_merge(uuid, text, uuid) TO wardenx_app;--> statement-breakpoint

-- ── (4) promote: mint a canonical from a tenant-staged provisional (§2.4.3) ────────────────────────────
-- The proposed fields arrive as jsonb, so each kind's REQUIRED columns are checked explicitly and the
-- promotion is refused when one is missing — a canonical minted with an empty name is worse than a refusal
-- a human can act on.
CREATE OR REPLACE FUNCTION mdm_canonical_writer_promote_provisional(
  p_provisional_id uuid,
  p_actor_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_prov mdm_provisional%ROWTYPE;
  v_fields jsonb;
  v_canonical_id uuid;
BEGIN
  SELECT * INTO v_prov FROM mdm_provisional WHERE id = p_provisional_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROVISIONAL_NOT_FOUND: %', p_provisional_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_prov.resolution <> 'pending' THEN
    RAISE EXCEPTION 'PROVISIONAL_NOT_PENDING: % is %', p_provisional_id, v_prov.resolution
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_fields := v_prov.proposed_fields;

  IF v_prov.entity_kind = 'physician' THEN
    IF COALESCE(btrim(v_fields->>'firstName'), '') = ''
       OR COALESCE(btrim(v_fields->>'lastName'), '') = '' THEN
      RAISE EXCEPTION 'PROVISIONAL_FIELDS_INCOMPLETE: physician requires firstName + lastName'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO external_physician (npi, first_name, last_name, credentials, specialty_taxonomy, status)
    VALUES (
      NULLIF(btrim(COALESCE(v_fields->>'npi', '')), ''),
      v_fields->>'firstName', v_fields->>'lastName',
      NULLIF(btrim(COALESCE(v_fields->>'credentials', '')), ''),
      NULLIF(btrim(COALESCE(v_fields->>'specialtyTaxonomy', '')), ''),
      'active'
    )
    RETURNING id INTO v_canonical_id;

  ELSIF v_prov.entity_kind = 'facility' THEN
    IF COALESCE(btrim(v_fields->>'name'), '') = '' OR COALESCE(btrim(v_fields->>'kind'), '') = '' THEN
      RAISE EXCEPTION 'PROVISIONAL_FIELDS_INCOMPLETE: facility requires name + kind'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO facility (ccn, npi, kind, name, status)
    VALUES (
      NULLIF(btrim(COALESCE(v_fields->>'ccn', '')), ''),
      NULLIF(btrim(COALESCE(v_fields->>'npi', '')), ''),
      (v_fields->>'kind')::facility_kind,
      v_fields->>'name',
      'active'
    )
    RETURNING id INTO v_canonical_id;

  ELSIF v_prov.entity_kind = 'payer' THEN
    IF COALESCE(btrim(v_fields->>'name'), '') = '' OR COALESCE(btrim(v_fields->>'kind'), '') = '' THEN
      RAISE EXCEPTION 'PROVISIONAL_FIELDS_INCOMPLETE: payer requires name + kind'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO payer (kind, state_code, payer_id, name, status)
    VALUES (
      (v_fields->>'kind')::payer_kind,
      NULLIF(btrim(COALESCE(v_fields->>'stateCode', '')), ''),
      NULLIF(btrim(COALESCE(v_fields->>'payerId', '')), ''),
      v_fields->>'name',
      'active'
    )
    RETURNING id INTO v_canonical_id;

  ELSE
    RAISE EXCEPTION 'PROVISIONAL_KIND_UNSUPPORTED: % has no canonical table in phase 1', v_prov.entity_kind
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE mdm_provisional
  SET resolution = 'promoted',
      promoted_canonical_id = v_canonical_id,
      resolved_at = now()
  WHERE id = p_provisional_id;

  -- `p_actor_user_id` is deliberately NOT stored on the provisional: the table records who PROPOSED it
  -- (`proposed_by`) and has no approver column. The approving actor reaches the record through the M4
  -- write-audit trigger, which stamps the session actor on this UPDATE.
  PERFORM p_actor_user_id;
  RETURN v_canonical_id;
END;
$$;--> statement-breakpoint
ALTER FUNCTION mdm_canonical_writer_promote_provisional(uuid, uuid) OWNER TO mdm_canonical_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION mdm_canonical_writer_promote_provisional(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION mdm_canonical_writer_promote_provisional(uuid, uuid) TO wardenx_app;
