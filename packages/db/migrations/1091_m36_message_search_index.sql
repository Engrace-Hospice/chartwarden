-- M36 WP 2.7b chunk C1 (ADR-0058, Status PROPOSED) - storage for the global blind-token search index.
-- Nothing reads or writes these tables yet and nothing may enable them in production: the tenant flag defaults OFF, no
-- indexer, rebuild job or query route exists in this chunk, and the ADR's design review and prerequisites P1/P2 are open.
--
-- Three tables, all org-scoped (three-column rule: organization_id, RLS on app.org_id, FORCEd, write-audit trigger):
--   * message_search_token        one row per (message, HMAC tag). EXACTLY four columns: org, key_version, tag, message_id.
--                                 `tag` is a T-bit truncated HMAC (T <= 20, so 0 <= tag < 2^20) or a random dummy. No
--                                 surrogate key, no channel_id, no created_at, no position: nothing that orders or labels a
--                                 tag beyond the message it indexes. Not partitioned. PHI-derived (backup/erasure/DR class).
--   * message_search_index_state  one row per (org, key_version): tag width, build status, resumable checkpoint, last
--                                 reconciliation, distinct-tag statistic and the head-bucket numbers for the tail bound.
--   * tenant_messaging_search_setting  the per-tenant `messaging.global_search_enabled` flag (default OFF; a tenant with no
--                                 row is OFF) and the purge bookkeeping that turning it OFF drives.
--
-- Token table access: wardenx_app may SELECT, INSERT and DELETE - NEVER UPDATE (a tag is replaced, not edited). The
-- write-audit trigger is STATEMENT-level, over transition tables, and records the message ids, the row count and the
-- operation only: it never reads the `tag` column, so the audit trail cannot become a second copy of the index.
--
-- Removal hook (decision 6, same transaction as the state change): an AFTER UPDATE trigger on message deletes the
-- message's token rows when its status becomes 'deleted' or its plaintext digest `body_sha256` changes (an edit). It is
-- NOT keyed on body_cipher: a key-ring re-wrap (ADR-0058 P1) rewrites the cipher with the same plaintext and must not wipe
-- the index. The trigger never consults the tenant flag: it runs while search is OFF so a message deleted while OFF cannot
-- be resurrected into the index. It is SECURITY DEFINER owned by wardenx_admin (which gets SELECT and DELETE policies on the
-- token table), with a pinned search_path, and deletes only NEW.organization_id's rows of the updated message, so it does
-- not depend on which role updates the message or on whether that session carries app.org_id: a role that may update a
-- message can never silently skip the delete. Tenant erasure (destroyTenantDek rewrites cipher and digest under
-- withOrgContext) fires it too; a message DELETE cascades through the composite FK.
--
-- INDEXER CONTRACT (chunk C2): the indexer inserts tokens in a different transaction from the one that edits or deletes a
-- message, so it MUST `SELECT ... FROM message WHERE id = $1 FOR SHARE` and re-check status <> 'deleted' and that
-- body_sha256 still equals the digest of the body it tokenised BEFORE inserting. Without the lock an edit can commit
-- between the indexer's read and its insert, leaving tokens for a body that no longer exists (the hook already ran).
--
-- Index coverage (test:fk-indexes:live): the organization FK and the (organization_id, message_id) -> message FK are each
-- led by an index below; changed_by_user_id points at the soft-deleted `user` parent (exempt from the rule, no index).

CREATE TABLE "message_search_token" (
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "key_version" text NOT NULL,
  "tag" integer NOT NULL,
  "message_id" uuid NOT NULL,
  CONSTRAINT "message_search_token_message_org_fk"
    FOREIGN KEY ("organization_id", "message_id")
    REFERENCES "message"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_search_token_tag_range" CHECK ("tag" >= 0 AND "tag" < 1048576),
  CONSTRAINT "message_search_token_key_version_shape" CHECK (char_length("key_version") BETWEEN 1 AND 32)
);--> statement-breakpoint

-- The query path: candidates by (org, version, tag) then message. The (org, message) index serves the per-message
-- replace/delete hook and the composite FK's cascade.
CREATE INDEX "message_search_token_lookup_idx" ON "message_search_token" ("organization_id", "key_version", "tag", "message_id");--> statement-breakpoint
CREATE INDEX "message_search_token_org_message_idx" ON "message_search_token" ("organization_id", "message_id");--> statement-breakpoint

CREATE TABLE "message_search_index_state" (
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "key_version" text NOT NULL,
  "tag_bits" smallint NOT NULL DEFAULT 19,
  "status" text NOT NULL DEFAULT 'building',
  "checkpoint_created_at" timestamptz,
  "checkpoint_message_id" uuid,
  "reconciled_at" timestamptz,
  "distinct_tags" integer,
  "head_buckets" integer[] NOT NULL DEFAULT '{}'::integer[],
  "stats_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_search_index_state_pk" PRIMARY KEY ("organization_id", "key_version"),
  CONSTRAINT "message_search_index_state_key_version_shape" CHECK (char_length("key_version") BETWEEN 1 AND 32),
  CONSTRAINT "message_search_index_state_tag_bits_range" CHECK ("tag_bits" BETWEEN 12 AND 20),
  CONSTRAINT "message_search_index_state_status_valid" CHECK ("status" IN ('building', 'ready', 'stale')),
  CONSTRAINT "message_search_index_state_checkpoint_pair"
    CHECK (("checkpoint_created_at" IS NULL) = ("checkpoint_message_id" IS NULL)),
  CONSTRAINT "message_search_index_state_distinct_tags_nonneg" CHECK ("distinct_tags" IS NULL OR "distinct_tags" >= 0)
);--> statement-breakpoint

CREATE TABLE "tenant_messaging_search_setting" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organization"("id") ON DELETE RESTRICT,
  "enabled" boolean NOT NULL DEFAULT false,
  "changed_by_user_id" uuid REFERENCES "user"("id"),
  "changed_at" timestamptz DEFAULT now() NOT NULL,
  "purge_requested_at" timestamptz,
  "purge_completed_at" timestamptz,
  CONSTRAINT "tenant_messaging_search_setting_purge_order"
    CHECK ("purge_completed_at" IS NULL OR "purge_requested_at" IS NOT NULL)
);--> statement-breakpoint

-- ── RLS (FORCEd, NULLIF guard: an unset or empty GUC matches nothing instead of throwing) ──────────────────────────────
ALTER TABLE "message_search_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_search_token" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_search_token_org_isolation" ON "message_search_token"
  FOR ALL TO wardenx_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "message_search_token" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_search_token" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "message_search_token_destruction" ON "message_search_token"
  FOR ALL TO wardenx_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "message_search_index_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_search_index_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_search_index_state_org_isolation" ON "message_search_index_state"
  FOR ALL TO wardenx_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "message_search_index_state" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_search_index_state" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "message_search_index_state_destruction" ON "message_search_index_state"
  FOR ALL TO wardenx_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "tenant_messaging_search_setting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_messaging_search_setting" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_messaging_search_setting_org_isolation" ON "tenant_messaging_search_setting"
  FOR ALL TO wardenx_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- No DELETE for the app role: a setting is switched OFF, never removed (the audit trail of who changed it stays attached).
GRANT SELECT, INSERT, UPDATE ON "tenant_messaging_search_setting" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, DELETE ON "tenant_messaging_search_setting" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "tenant_messaging_search_setting_destruction" ON "tenant_messaging_search_setting"
  FOR ALL TO wardenx_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- ── write audit ────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Token table: STATEMENT-level, one audit row per org per statement, from the transition table. Only message_id,
-- the row count and the operation are read; `tag` and `key_version` are never selected. A statement touching a single
-- message carries it as resource_id; a bulk statement lists up to 50 ids and the true count.
CREATE OR REPLACE FUNCTION audit_phi_write_message_search_token() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  )
  SELECT
    r.organization_id,
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'message_search_token.' || lower(TG_OP), 'message_search_token',
    CASE WHEN count(DISTINCT r.message_id) = 1 THEN min(r.message_id::text)::uuid ELSE NULL END,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', NULL, NULL,
    jsonb_build_object(
      'row_count', count(*),
      'message_count', count(DISTINCT r.message_id),
      'message_ids', (SELECT COALESCE(jsonb_agg(m.message_id), '[]'::jsonb)
                        FROM (SELECT DISTINCT r2.message_id FROM changed_rows r2
                               WHERE r2.organization_id = r.organization_id LIMIT 50) m)
    ),
    'compliance'
  FROM changed_rows r
  GROUP BY r.organization_id;
  RETURN NULL;
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_message_search_token() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_search_token_insert"
  AFTER INSERT ON message_search_token
  REFERENCING NEW TABLE AS changed_rows
  FOR EACH STATEMENT EXECUTE FUNCTION audit_phi_write_message_search_token();--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_search_token_delete"
  AFTER DELETE ON message_search_token
  REFERENCING OLD TABLE AS changed_rows
  FOR EACH STATEMENT EXECUTE FUNCTION audit_phi_write_message_search_token();--> statement-breakpoint

-- Index state: row-level; the head-bucket numbers are scrubbed from both images (they are frequency statistics).
CREATE OR REPLACE FUNCTION audit_phi_write_message_search_index_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['head_buckets']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['head_buckets']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'message_search_index_state.' || lower(TG_OP), 'message_search_index_state',
    NULL,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object('key_version', COALESCE(NEW.key_version, OLD.key_version)),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_message_search_index_state() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_search_index_state"
  AFTER INSERT OR UPDATE OR DELETE ON message_search_index_state
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_search_index_state();--> statement-breakpoint

-- Setting: who flipped the flag, when, old and new image, actor. resource_id is the org (the setting's identity).
CREATE OR REPLACE FUNCTION audit_phi_write_tenant_messaging_search_setting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'tenant_messaging_search_setting.' || lower(TG_OP), 'tenant_messaging_search_setting',
    COALESCE(NEW.organization_id, OLD.organization_id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_tenant_messaging_search_setting() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tenant_messaging_search_setting"
  AFTER INSERT OR UPDATE OR DELETE ON tenant_messaging_search_setting
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_messaging_search_setting();--> statement-breakpoint

-- ── removal hook: a deleted or edited message leaves the index in the SAME transaction ─────────────────────────────────
GRANT SELECT, DELETE ON "message_search_token" TO wardenx_admin;--> statement-breakpoint
-- A DELETE ... WHERE also reads the rows, so the SELECT policy is needed beside the DELETE one.
CREATE POLICY "message_search_token_purge_hook_select" ON "message_search_token"
  FOR SELECT TO wardenx_admin USING (true);--> statement-breakpoint
CREATE POLICY "message_search_token_purge_hook_delete" ON "message_search_token"
  FOR DELETE TO wardenx_admin USING (true);--> statement-breakpoint
CREATE OR REPLACE FUNCTION message_search_token_purge_on_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  DELETE FROM public.message_search_token
   WHERE organization_id = NEW.organization_id AND message_id = NEW.id;
  RETURN NULL;
END $$;--> statement-breakpoint
ALTER FUNCTION message_search_token_purge_on_change() OWNER TO wardenx_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION message_search_token_purge_on_change() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "trg_message_search_token_purge"
  AFTER UPDATE ON message
  FOR EACH ROW
  WHEN ((NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted')
        OR NEW.body_sha256 IS DISTINCT FROM OLD.body_sha256)
  EXECUTE FUNCTION message_search_token_purge_on_change();
