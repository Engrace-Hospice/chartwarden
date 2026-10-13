-- M36 WP 2.13 / ADR-0058 P1 (stage 1) — a per-row body-key scheme marker, the legacy-row indexes, and the ONE audited
-- path that may re-seal a message revision.
--
-- 1. `body_envelope_version` is GENERATED from the first byte of `body_cipher` (0 = erased/empty, 1 = legacy HKDF key
--    derived from MESSAGING_ENCRYPTION_KEY, 2 = M34 wrapped-DEK ring). It can never disagree with the ciphertext, needs no
--    dual write, and exposes the scheme without exposing a byte of ciphertext (the platform role gets a COLUMN grant on it,
--    scripts/db/provision-runtime-roles.ts, so boot can count legacy rows cross-tenant without reading PHI).
--    ADD COLUMN ... STORED rewrites the table under ACCESS EXCLUSIVE; both tables are small before launch (prod is demo
--    data), the same reasoning as 1080.
-- 2. Partial indexes over exactly the legacy rows: the backfill pages them in key order and the completion count reads them,
--    and they shrink to nothing as the backfill finishes.
-- 3. message_revision is append-only for the app role (SELECT + INSERT, 1070 / ADR-0055). Re-sealing a revision under the
--    ring needs an UPDATE of `body_cipher` and nothing else, so it goes through ONE SECURITY DEFINER function owned by a
--    role holding only a COLUMN grant: it answers only for the org the session is bound to, only turns a legacy envelope
--    (1) into a ring envelope (2), and compare-and-swaps against the ciphertext the caller read, so a concurrent change
--    cannot be overwritten. Every call is audited by the existing `trg_audit_message_revision` UPDATE trigger (the cipher is
--    scrubbed from the audit row). Ordinary code still cannot rewrite or delete a revision.

ALTER TABLE "message" ADD COLUMN "body_envelope_version" smallint
  GENERATED ALWAYS AS (CASE WHEN octet_length("body_cipher") = 0 THEN 0 ELSE get_byte("body_cipher", 0) END) STORED;--> statement-breakpoint
ALTER TABLE "message_revision" ADD COLUMN "body_envelope_version" smallint
  GENERATED ALWAYS AS (CASE WHEN octet_length("body_cipher") = 0 THEN 0 ELSE get_byte("body_cipher", 0) END) STORED;--> statement-breakpoint

CREATE INDEX "message_body_legacy_idx" ON "message" ("organization_id", "id") WHERE "body_envelope_version" = 1;--> statement-breakpoint
CREATE INDEX "message_revision_body_legacy_idx" ON "message_revision" ("organization_id", "id") WHERE "body_envelope_version" = 1;--> statement-breakpoint

GRANT SELECT ("organization_id", "id", "body_cipher") ON "message_revision" TO wardenx_admin;--> statement-breakpoint
GRANT UPDATE ("body_cipher") ON "message_revision" TO wardenx_admin;--> statement-breakpoint
CREATE POLICY "message_revision_reseal_select" ON "message_revision"
  FOR SELECT TO wardenx_admin
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_revision_reseal_update" ON "message_revision"
  FOR UPDATE TO wardenx_admin
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE OR REPLACE FUNCTION m36_reseal_message_revision(p_organization_id uuid, p_id uuid, p_old bytea, p_new bytea)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_rows integer;
BEGIN
  IF p_organization_id IS NULL OR p_organization_id IS DISTINCT FROM NULLIF(current_setting('app.org_id', true), '')::uuid THEN
    RAISE EXCEPTION 'm36_reseal_message_revision: the organization does not match the session' USING ERRCODE = '42501';
  END IF;
  IF substring(p_old from 1 for 1) IS DISTINCT FROM '\x01'::bytea OR substring(p_new from 1 for 1) IS DISTINCT FROM '\x02'::bytea THEN
    RAISE EXCEPTION 'm36_reseal_message_revision: only a legacy (1) envelope may be replaced by a ring (2) envelope' USING ERRCODE = '22023';
  END IF;
  UPDATE message_revision SET body_cipher = p_new
   WHERE organization_id = p_organization_id AND id = p_id AND body_cipher = p_old;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;--> statement-breakpoint
ALTER FUNCTION m36_reseal_message_revision(uuid, uuid, bytea, bytea) OWNER TO wardenx_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION m36_reseal_message_revision(uuid, uuid, bytea, bytea) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m36_reseal_message_revision(uuid, uuid, bytea, bytea) TO wardenx_app;
