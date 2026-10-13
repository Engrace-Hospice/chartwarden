-- M36 WP 2.13 fix round — least privilege for the revision re-seal (supersedes the grant in 1089).
--
-- 1089 granted EXECUTE on m36_reseal_message_revision to wardenx_app and only checked that the new bytes start with 0x02, so any
-- request-path or injected caller inside an org session could replace a legacy revision (append-only edit-history evidence)
-- with garbage or a forged envelope. Now:
--   * EXECUTE is REVOKEd from wardenx_app and PUBLIC; it is granted only to the NOLOGIN carrier wardenx_m36_reseal. The operator
--     backfill login (scripts/db/provision-runtime-roles.ts, WARDENX_BODY_BACKFILL_PASSWORD) is a member of that carrier; no
--     application credential is.
--   * the function validates the SHAPE of both envelopes: the old one must be a plausible legacy envelope (version byte 1,
--     >= 29 bytes) and the new one a well-formed ring envelope (version byte 2, label length 1..32, label of [A-Za-z0-9._-],
--     >= header + nonce + tag) whose length is exactly the legacy length plus 1 + label length (same plaintext, different
--     header), so garbage or a differently-sized forged blob is refused. GCM authenticity cannot be checked in SQL; the
--     backfill proves the round trip before calling, and hash_verify detects a forged blob that passed the shape check.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wardenx_m36_reseal') THEN
    CREATE ROLE wardenx_m36_reseal NOLOGIN;
  END IF;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION m36_reseal_message_revision(p_organization_id uuid, p_id uuid, p_old bytea, p_new bytea)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_rows integer;
  v_label_len integer;
BEGIN
  IF p_organization_id IS NULL OR p_organization_id IS DISTINCT FROM NULLIF(current_setting('app.org_id', true), '')::uuid THEN
    RAISE EXCEPTION 'm36_reseal_message_revision: the organization does not match the session' USING ERRCODE = '42501';
  END IF;
  IF p_old IS NULL OR p_new IS NULL
     OR octet_length(p_old) < 29 OR get_byte(p_old, 0) <> 1
     OR octet_length(p_new) < 31 OR get_byte(p_new, 0) <> 2 THEN
    RAISE EXCEPTION 'm36_reseal_message_revision: only a legacy (1) envelope may be replaced by a ring (2) envelope' USING ERRCODE = '22023';
  END IF;
  v_label_len := get_byte(p_new, 1);
  IF v_label_len < 1 OR v_label_len > 32
     OR octet_length(p_new) < 2 + v_label_len + 12 + 16
     OR encode(substring(p_new from 3 for v_label_len), 'escape') !~ '^[A-Za-z0-9._-]+$'
     OR octet_length(p_new) <> octet_length(p_old) + 1 + v_label_len THEN
    RAISE EXCEPTION 'm36_reseal_message_revision: malformed ring envelope' USING ERRCODE = '22023';
  END IF;
  UPDATE message_revision SET body_cipher = p_new
   WHERE organization_id = p_organization_id AND id = p_id AND body_cipher = p_old;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;--> statement-breakpoint
ALTER FUNCTION m36_reseal_message_revision(uuid, uuid, bytea, bytea) OWNER TO wardenx_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION m36_reseal_message_revision(uuid, uuid, bytea, bytea) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION m36_reseal_message_revision(uuid, uuid, bytea, bytea) FROM wardenx_app;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO wardenx_m36_reseal;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m36_reseal_message_revision(uuid, uuid, bytea, bytea) TO wardenx_m36_reseal;
