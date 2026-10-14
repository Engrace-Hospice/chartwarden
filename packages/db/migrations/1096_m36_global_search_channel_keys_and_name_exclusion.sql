-- M36 ADR-0058 product-owner decisions of 2026-10-13: (1) patient and contact NAMES are excluded from the global search index,
-- (2) tags are derived per CHANNEL (K_ch = HKDF(K_search, channel, T, version)), so the same word has an unrelated tag in every channel.
--
-- CLEAN REBUILD, by design. Global search is inert everywhere (the platform flag is absent and the tenant flag defaults OFF), and the
-- rows written under the old single-key scheme cannot be matched by a per-channel query. The token table is therefore TRUNCATED and
-- every state row is reset to 'stale' with no checkpoint, so the next maintenance tick of an ENABLED tenant sweeps from the start
-- and rewrites its index under the new scheme. A tenant that is OFF has no rows and no state row to reset.
--
-- message_search_token gains `channel_id` (plaintext, = message.channel_id; a message never changes channel). It is the one
-- label a snapshot reader now sees beside a tag: it groups a message's tags by conversation, which is what lets the keys differ per
-- channel. It is deliberately NOT a foreign key: it is derived from the message row the (org, message) composite FK already pins.
-- The lookup index now leads with (org, key_version, channel_id, tag) so a per-channel tag probe stays one index range.
--
-- message_search_index_state:
--   * head_buckets changes from integer[] to text[]: with per-channel keys a "head bucket" is a (channel, tag) pair, stored as
--     '<channel uuid>:<tag>' (bucket numbers only, never a token or a word); capped by the writer at 2000 pairs.
--   * excluded_name_digests / exclusion_pending: KEYED digests (HMAC under K_search, 8 bytes) of the excluded name tokens. No name
--     is stored anywhere by this feature; a digest is meaningless without the tenant's key ring. `exclusion_pending` holds the
--     digests added since the last full reindex pass of the messages that already contain them; both are scrubbed from the audit images.
--   * exclusion_synced_at: the indexer refuses to write a tenant's tokens until the name set has been read at least once.
--
-- No grant changes: the table-level privileges and RLS policies of 1091 already cover the new columns.

-- 1. The audit image scrub learns the new columns BEFORE any state row is touched.
CREATE OR REPLACE FUNCTION audit_phi_write_message_search_index_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['head_buckets','excluded_name_digests','exclusion_pending']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['head_buckets','excluded_name_digests','exclusion_pending']::text[]) ELSE NULL END;
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

-- 2. Token table: empty it, add the channel column, re-key the lookup index.
TRUNCATE TABLE "message_search_token";--> statement-breakpoint
ALTER TABLE "message_search_token" ADD COLUMN "channel_id" uuid NOT NULL;--> statement-breakpoint
DROP INDEX "message_search_token_lookup_idx";--> statement-breakpoint
CREATE INDEX "message_search_token_lookup_idx"
  ON "message_search_token" ("organization_id", "key_version", "channel_id", "tag", "message_id");--> statement-breakpoint

-- 3. State table.
ALTER TABLE "message_search_index_state"
  ALTER COLUMN "head_buckets" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "message_search_index_state"
  ALTER COLUMN "head_buckets" TYPE text[] USING '{}'::text[];--> statement-breakpoint
ALTER TABLE "message_search_index_state"
  ALTER COLUMN "head_buckets" SET DEFAULT '{}'::text[];--> statement-breakpoint
ALTER TABLE "message_search_index_state"
  ADD COLUMN "excluded_name_digests" text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN "exclusion_pending" text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN "exclusion_pending_since" timestamptz,
  ADD COLUMN "exclusion_synced_at" timestamptz;--> statement-breakpoint

UPDATE "message_search_index_state"
   SET "status" = 'stale',
       "checkpoint_created_at" = NULL,
       "checkpoint_message_id" = NULL,
       "reconciled_at" = NULL,
       "distinct_tags" = NULL,
       "stats_at" = NULL,
       "updated_at" = now();
