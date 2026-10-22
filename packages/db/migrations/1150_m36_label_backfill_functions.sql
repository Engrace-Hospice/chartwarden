-- M36 - the ONE audited path for the crypto context-label backfill (ChartWarden rename, release 2) over the four sealed-body tables that
-- the app role cannot re-seal: message_revision (append-only), message_poll_option (insert-only), message_draft (owner-isolated) and
-- scheduled_message (body_cipher is not an updatable column). `message` itself needs nothing here: the app role updates its own rows.
--
-- WHY A NEW PATH. 1090 / 1094 let `chartwarden_m36_reseal` turn a LEGACY (1) envelope into a RING (2) envelope and nothing else, so a
-- ring (2) envelope sealed under the old AAD label could never be re-sealed, and drafts / scheduled messages had no re-seal path at all.
-- Both functions below are inert until an operator runs the label backfill: no row changes at deploy.
--
-- m36_label_backfill_page   keyset page of (id, sealed value) for one table of the session's org, so the operator tool can decrypt-probe.
-- m36_label_backfill_swap   compare-and-swap of one sealed value for another of EXACTLY THE SAME SHAPE: same scheme byte (1 or 2), same
--                           length and, for a ring (2) envelope, the same ring version label. So a swap can change which AAD / HKDF
--                           label sealed a value and nothing else; it cannot change the scheme, the ring version or the size.
-- Both are SECURITY DEFINER owned by chartwarden_admin, answer only for the org the session is bound to (a NULL or foreign org matches
-- nothing), and EXECUTE goes only to the NOLOGIN carrier chartwarden_m36_reseal (the login that holds it is operator-only, 1090). Every
-- swap is audited by the table's own UPDATE audit trigger (the cipher is scrubbed from the image).

-- Column-level reach for the function owner on the two owner-isolated tables (the revision / poll-option grants and policies exist: 1089, 1094).
GRANT SELECT ("organization_id", "id", "body_cipher") ON "message_draft" TO chartwarden_admin;--> statement-breakpoint
GRANT UPDATE ("body_cipher") ON "message_draft" TO chartwarden_admin;--> statement-breakpoint
CREATE POLICY "message_draft_label_backfill_select" ON "message_draft"
  FOR SELECT TO chartwarden_admin
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_draft_label_backfill_update" ON "message_draft"
  FOR UPDATE TO chartwarden_admin
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ("body_cipher") ON "scheduled_message" TO chartwarden_admin;--> statement-breakpoint
GRANT UPDATE ("body_cipher") ON "scheduled_message" TO chartwarden_admin;--> statement-breakpoint
CREATE POLICY "scheduled_message_label_backfill_select" ON "scheduled_message"
  FOR SELECT TO chartwarden_admin
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "scheduled_message_label_backfill_update" ON "scheduled_message"
  FOR UPDATE TO chartwarden_admin
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE OR REPLACE FUNCTION m36_label_backfill_page(p_table text, p_organization_id uuid, p_after uuid, p_limit integer)
RETURNS TABLE (row_id uuid, cipher bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_organization_id IS NULL OR p_organization_id IS DISTINCT FROM NULLIF(current_setting('app.org_id', true), '')::uuid THEN
    RAISE EXCEPTION 'm36_label_backfill_page: the organization does not match the session' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN p_limit := 1; END IF;
  IF p_limit > 500 THEN p_limit := 500; END IF;
  IF p_table = 'message_revision' THEN
    RETURN QUERY SELECT t.id, t.body_cipher FROM message_revision t
      WHERE t.organization_id = p_organization_id AND (p_after IS NULL OR t.id > p_after) AND octet_length(t.body_cipher) > 0
      ORDER BY t.id LIMIT p_limit;
  ELSIF p_table = 'message_poll_option' THEN
    RETURN QUERY SELECT t.id, t.label_cipher FROM message_poll_option t
      WHERE t.organization_id = p_organization_id AND (p_after IS NULL OR t.id > p_after) AND octet_length(t.label_cipher) > 0
      ORDER BY t.id LIMIT p_limit;
  ELSIF p_table = 'message_draft' THEN
    RETURN QUERY SELECT t.id, t.body_cipher FROM message_draft t
      WHERE t.organization_id = p_organization_id AND (p_after IS NULL OR t.id > p_after) AND octet_length(t.body_cipher) > 0
      ORDER BY t.id LIMIT p_limit;
  ELSIF p_table = 'scheduled_message' THEN
    RETURN QUERY SELECT t.id, t.body_cipher FROM scheduled_message t
      WHERE t.organization_id = p_organization_id AND (p_after IS NULL OR t.id > p_after) AND octet_length(t.body_cipher) > 0
      ORDER BY t.id LIMIT p_limit;
  ELSE
    RAISE EXCEPTION 'm36_label_backfill_page: unknown table' USING ERRCODE = '22023';
  END IF;
END $$;--> statement-breakpoint
ALTER FUNCTION m36_label_backfill_page(text, uuid, uuid, integer) OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION m36_label_backfill_page(text, uuid, uuid, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m36_label_backfill_page(text, uuid, uuid, integer) TO chartwarden_m36_reseal;--> statement-breakpoint

CREATE OR REPLACE FUNCTION m36_label_backfill_swap(p_table text, p_organization_id uuid, p_id uuid, p_old bytea, p_new bytea)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_rows integer;
  v_scheme integer;
  v_header integer;
BEGIN
  IF p_organization_id IS NULL OR p_organization_id IS DISTINCT FROM NULLIF(current_setting('app.org_id', true), '')::uuid THEN
    RAISE EXCEPTION 'm36_label_backfill_swap: the organization does not match the session' USING ERRCODE = '42501';
  END IF;
  IF p_old IS NULL OR p_new IS NULL OR octet_length(p_old) < 29 OR octet_length(p_new) <> octet_length(p_old) THEN
    RAISE EXCEPTION 'm36_label_backfill_swap: the new value must have the shape of the old one' USING ERRCODE = '22023';
  END IF;
  v_scheme := get_byte(p_old, 0);
  IF v_scheme NOT IN (1, 2) OR get_byte(p_new, 0) <> v_scheme THEN
    RAISE EXCEPTION 'm36_label_backfill_swap: the scheme must be unchanged (1 or 2)' USING ERRCODE = '22023';
  END IF;
  IF v_scheme = 2 THEN
    -- Ring envelope: version(1) | labelLen(1) | label | nonce | ct | tag. The ring version label must be unchanged.
    v_header := 2 + get_byte(p_old, 1);
    IF get_byte(p_old, 1) < 1 OR get_byte(p_old, 1) > 32 OR octet_length(p_old) < v_header + 12 + 16
       OR substring(p_old from 1 for v_header) <> substring(p_new from 1 for v_header) THEN
      RAISE EXCEPTION 'm36_label_backfill_swap: the ring version must be unchanged' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_table = 'message_revision' THEN
    UPDATE message_revision SET body_cipher = p_new WHERE organization_id = p_organization_id AND id = p_id AND body_cipher = p_old;
  ELSIF p_table = 'message_poll_option' THEN
    UPDATE message_poll_option SET label_cipher = p_new WHERE organization_id = p_organization_id AND id = p_id AND label_cipher = p_old;
  ELSIF p_table = 'message_draft' THEN
    UPDATE message_draft SET body_cipher = p_new WHERE organization_id = p_organization_id AND id = p_id AND body_cipher = p_old;
  ELSIF p_table = 'scheduled_message' THEN
    UPDATE scheduled_message SET body_cipher = p_new WHERE organization_id = p_organization_id AND id = p_id AND body_cipher = p_old;
  ELSE
    RAISE EXCEPTION 'm36_label_backfill_swap: unknown table' USING ERRCODE = '22023';
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;--> statement-breakpoint
ALTER FUNCTION m36_label_backfill_swap(text, uuid, uuid, bytea, bytea) OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION m36_label_backfill_swap(text, uuid, uuid, bytea, bytea) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m36_label_backfill_swap(text, uuid, uuid, bytea, bytea) TO chartwarden_m36_reseal;
