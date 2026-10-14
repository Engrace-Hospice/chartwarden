-- M36 WP 2.13 follow-up — poll option labels join the message-body key-ring backfill (ADR-0058 P1).
--
-- A poll option label is sealed like a message body (`label_cipher`, the same MessageBodyCipher), so while the legacy HKDF key
-- (MESSAGING_ENCRYPTION_KEY) still exists a label written under it is unreadable once that key is retired. 1089 covered
-- `message` and `message_revision` only. This migration gives the option table the same three things:
--   1. `label_envelope_version`, GENERATED from the first byte of `label_cipher` (0 empty, 1 legacy, 2 ring), so the scheme can
--      never disagree with the ciphertext and is readable without reading a byte of it;
--   2. a partial index over exactly the legacy rows (the backfill work list and the completion count);
--   3. ONE audited path that may re-seal a label: options are INSERT-only for the app role (1093), so the re-seal is a SECURITY
--      DEFINER function owned by wardenx_admin (column grant UPDATE(label_cipher) only), answering only for the org the session
--      is bound to, only turning a legacy envelope into a well-shaped ring envelope of exactly the right length, with a
--      compare-and-swap on the ciphertext the caller read. EXECUTE goes only to the NOLOGIN carrier wardenx_m36_reseal (1090),
--      never to the app role. The audit trigger on the table (1093) records every re-seal with the cipher scrubbed.
-- The platform role (boot legacy count) gets the same COLUMN grant it has on the body tables, when that role already exists;
-- scripts/db/provision-runtime-roles.ts grants it on a fresh setup.

ALTER TABLE "message_poll_option" ADD COLUMN "label_envelope_version" smallint
  GENERATED ALWAYS AS (CASE WHEN octet_length("label_cipher") = 0 THEN 0 ELSE get_byte("label_cipher", 0) END) STORED;--> statement-breakpoint

CREATE INDEX "message_poll_option_label_legacy_idx"
  ON "message_poll_option" ("organization_id", "id") WHERE "label_envelope_version" = 1;--> statement-breakpoint

GRANT SELECT ("organization_id", "id", "label_cipher") ON "message_poll_option" TO wardenx_admin;--> statement-breakpoint
GRANT UPDATE ("label_cipher") ON "message_poll_option" TO wardenx_admin;--> statement-breakpoint
CREATE POLICY "message_poll_option_reseal_select" ON "message_poll_option"
  FOR SELECT TO wardenx_admin
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_poll_option_reseal_update" ON "message_poll_option"
  FOR UPDATE TO wardenx_admin
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE OR REPLACE FUNCTION m36_reseal_poll_option(p_organization_id uuid, p_id uuid, p_old bytea, p_new bytea)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_rows integer;
  v_label_len integer;
BEGIN
  IF p_organization_id IS NULL OR p_organization_id IS DISTINCT FROM NULLIF(current_setting('app.org_id', true), '')::uuid THEN
    RAISE EXCEPTION 'm36_reseal_poll_option: the organization does not match the session' USING ERRCODE = '42501';
  END IF;
  IF p_old IS NULL OR p_new IS NULL THEN
    RAISE EXCEPTION 'm36_reseal_poll_option: only a legacy (1) envelope may be replaced by a ring (2) envelope' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_old) < 29 OR octet_length(p_new) < 31 THEN
    RAISE EXCEPTION 'm36_reseal_poll_option: only a legacy (1) envelope may be replaced by a ring (2) envelope' USING ERRCODE = '22023';
  END IF;
  IF get_byte(p_old, 0) <> 1 OR get_byte(p_new, 0) <> 2 THEN
    RAISE EXCEPTION 'm36_reseal_poll_option: only a legacy (1) envelope may be replaced by a ring (2) envelope' USING ERRCODE = '22023';
  END IF;
  v_label_len := get_byte(p_new, 1);
  IF v_label_len < 1 OR v_label_len > 32 THEN
    RAISE EXCEPTION 'm36_reseal_poll_option: malformed ring envelope' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_new) < 2 + v_label_len + 12 + 16 OR octet_length(p_new) <> octet_length(p_old) + 1 + v_label_len THEN
    RAISE EXCEPTION 'm36_reseal_poll_option: malformed ring envelope' USING ERRCODE = '22023';
  END IF;
  IF encode(substring(p_new from 3 for v_label_len), 'escape') !~ '^[A-Za-z0-9._-]+$' THEN
    RAISE EXCEPTION 'm36_reseal_poll_option: malformed ring envelope' USING ERRCODE = '22023';
  END IF;
  UPDATE message_poll_option SET label_cipher = p_new
   WHERE organization_id = p_organization_id AND id = p_id AND label_cipher = p_old;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;--> statement-breakpoint
ALTER FUNCTION m36_reseal_poll_option(uuid, uuid, bytea, bytea) OWNER TO wardenx_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION m36_reseal_poll_option(uuid, uuid, bytea, bytea) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION m36_reseal_poll_option(uuid, uuid, bytea, bytea) FROM wardenx_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m36_reseal_poll_option(uuid, uuid, bytea, bytea) TO wardenx_m36_reseal;--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wardenx_platform') THEN
    GRANT SELECT ("organization_id", "label_envelope_version") ON "message_poll_option" TO wardenx_platform;
  END IF;
END $$;
