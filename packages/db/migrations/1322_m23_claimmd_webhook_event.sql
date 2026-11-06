-- compat: expand
-- M23 (ADR-0053 amendment, D7/D8) - the durable receipt of every signed Claim.MD webhook event.
--   * PLATFORM-ONLY, like stripe_webhook_event: one Claim.MD account serves every tenant, so a delivery is not a
--     tenant's until the sweep resolves it (enrollment by the platform-unique provider NPI, appeal by the platform-unique
--     control number). RLS is enabled and FORCEd with NO policy and NO chartwarden_app grant: a tenant connection reads
--     nothing. Only the BYPASSRLS platform login (scripts/db/provision-runtime-roles.ts) reads and writes it, through an
--     allowlisted, audited withPlatformContext entry.
--   * Key (usage, acct_number, event_id): Claim.MD delivers at least once and dedupes on (acct_number, eventid). A
--     signed delivery that cannot be split is stored as ONE row keyed `body:<sha256>`; an element without a usable
--     eventid as `x:<sha256(element)>`. Both are `malformed` and terminal.
--   * `payload_cipher` is the event element, AES-256-GCM under CLAIMMD_WEBHOOK_PAYLOAD_KEY (key id in
--     `payload_key_ref`). It can hold a provider TIN (which may be an SSN) and untrusted vendor text, so it never leaves
--     this table in clear. Retention: cleared a fixed number of days after terminal processing; the digest and ids stay.
--   * processing_outcome: NULL = waiting for the sweep; `awaiting_entitlement` = tenant resolved but without the Billing
--     add-on (kept encrypted, re-checked, processed once entitled, `expired_not_entitled` after the retention window).
--     Every other value is terminal.
-- No PHI column in clear: ids, the vendor's event type word, its event time text, and our timestamps.
CREATE TABLE IF NOT EXISTS "claimmd_webhook_event" (
  "usage" text NOT NULL,
  "acct_number" text NOT NULL,
  "event_id" text NOT NULL,
  "remote_acct_number" text,
  "event_type" text,
  "event_time" text,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "signature_verified_at" timestamp with time zone NOT NULL,
  "payload_sha256" text NOT NULL,
  "payload_cipher" text,
  "payload_key_ref" text,
  "derived_organization_id" uuid,
  "derived_provider_entity_id" uuid,
  "processed_at" timestamp with time zone,
  "processing_outcome" text,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "last_error_class" text,
  "entitlement_checked_at" timestamp with time zone,
  "payload_cleared_at" timestamp with time zone,
  CONSTRAINT "claimmd_webhook_event_pkey" PRIMARY KEY ("usage", "acct_number", "event_id"),
  CONSTRAINT "claimmd_webhook_event_usage_chk" CHECK ("usage" IN ('test', 'production')),
  CONSTRAINT "claimmd_webhook_event_acct_len_chk" CHECK (char_length("acct_number") BETWEEN 0 AND 64),
  CONSTRAINT "claimmd_webhook_event_id_len_chk" CHECK (char_length("event_id") BETWEEN 1 AND 160),
  CONSTRAINT "claimmd_webhook_event_type_len_chk" CHECK ("event_type" IS NULL OR char_length("event_type") <= 64),
  CONSTRAINT "claimmd_webhook_event_time_len_chk" CHECK ("event_time" IS NULL OR char_length("event_time") <= 64),
  CONSTRAINT "claimmd_webhook_event_sha_chk" CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "claimmd_webhook_event_error_len_chk" CHECK ("last_error_class" IS NULL OR char_length("last_error_class") <= 64),
  CONSTRAINT "claimmd_webhook_event_outcome_chk" CHECK ("processing_outcome" IS NULL OR "processing_outcome" IN (
    'test_ack', 'malformed', 'unsupported_type', 'unroutable_npi', 'unroutable_claim', 'awaiting_entitlement',
    'expired_not_entitled', 'published', 'failed')),
  -- A terminal row carries processed_at; a waiting row (NULL or awaiting_entitlement) does not.
  CONSTRAINT "claimmd_webhook_event_terminal_chk" CHECK (
    ("processed_at" IS NULL) = ("processing_outcome" IS NULL OR "processing_outcome" = 'awaiting_entitlement')),
  -- The cipher is present until retention clears it, and never without its key reference.
  CONSTRAINT "claimmd_webhook_event_cipher_chk" CHECK (
    ("payload_cipher" IS NULL) = ("payload_key_ref" IS NULL)
    AND ("payload_cipher" IS NULL) = ("payload_cleared_at" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claimmd_webhook_event_pending_ix"
  ON "claimmd_webhook_event" ("received_at") WHERE "processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claimmd_webhook_event_retention_ix"
  ON "claimmd_webhook_event" ("processed_at") WHERE "payload_cipher" IS NOT NULL AND "processed_at" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "claimmd_webhook_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "claimmd_webhook_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT ALL ON "claimmd_webhook_event" TO chartwarden_admin;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "claimmd_webhook_event_admin_all" ON "claimmd_webhook_event"
    FOR ALL TO chartwarden_admin USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- The platform carrier exists only where provision-runtime-roles.ts has run; that script re-grants on every run.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    -- UPDATE is column-level, the same list scripts/db/provision-runtime-roles.ts grants: never the stored receipt.
    GRANT SELECT, INSERT ON "claimmd_webhook_event" TO chartwarden_platform;
    GRANT UPDATE ("derived_organization_id", "derived_provider_entity_id", "last_error_class", "processing_outcome", "entitlement_checked_at", "processed_at", "attempt_count", "payload_cipher", "payload_key_ref", "payload_cleared_at") ON "claimmd_webhook_event" TO chartwarden_platform;
  END IF;
END $$;
--> statement-breakpoint
-- Write audit (M04): the stripe_webhook_event shape. The cipher and its key ref are denylisted; the row key is text, so
-- resource_id is NULL and the key goes in context. Org from the session (NULL under the platform role).
CREATE OR REPLACE FUNCTION audit_phi_write_claimmd_webhook_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['payload_cipher','payload_key_ref']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    NULLIF(current_setting('app.org_id', true), '')::uuid,
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'claimmd_webhook_event.' || lower(TG_OP),
    'claimmd_webhook_event',
    NULL,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object('usage', COALESCE(NEW.usage, OLD.usage), 'acct_number', COALESCE(NEW.acct_number, OLD.acct_number),
      'event_id', COALESCE(NEW.event_id, OLD.event_id)),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claimmd_webhook_event() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_claimmd_webhook_event" AFTER INSERT OR UPDATE OR DELETE ON claimmd_webhook_event
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claimmd_webhook_event();
