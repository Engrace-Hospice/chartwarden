-- compat: expand
-- BIL-1.1: unresolved Claim.MD account data has no tenant owner. Capture role is NOLOGIN;
-- chartwarden_app receives no grants or policy. Explicit operator bootstrap inserts the stream row.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimmd_capture') THEN
    CREATE ROLE claimmd_capture NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO claimmd_capture;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT claimmd_capture TO chartwarden_platform;
  END IF;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS claimmd_response_stream (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  stream_type text NOT NULL DEFAULT 'claim_responses' CHECK (stream_type = 'claim_responses'),
  cursor text NOT NULL CHECK (cursor ~ '^[0-9]{1,30}$'),
  lease_owner uuid,
  lease_until timestamptz,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z_]{1,40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_response_stream_identity_uq UNIQUE (account_reference,usage,stream_type),
  CONSTRAINT claimmd_response_stream_lease_pair CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS claimmd_response_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL REFERENCES claimmd_response_stream(id) ON DELETE RESTRICT,
  after_cursor text NOT NULL CHECK (after_cursor ~ '^[0-9]{1,30}$'),
  next_cursor text NOT NULL CHECK (next_cursor ~ '^[0-9]{1,30}$'),
  payload_cipher bytea NOT NULL CHECK (octet_length(payload_cipher) BETWEEN 29 AND 8388800),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  parent_count integer NOT NULL CHECK (parent_count BETWEEN 0 AND 20000),
  event_count integer NOT NULL CHECK (event_count BETWEEN 0 AND 200000),
  captured_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS claimmd_response_batch_stream_ix ON claimmd_response_batch(stream_id,captured_at);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS claimmd_response_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL REFERENCES claimmd_response_stream(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES claimmd_response_batch(id) ON DELETE RESTRICT,
  response_id text CHECK (response_id IS NULL OR response_id ~ '^[0-9]{1,30}$'),
  source_cursor text NOT NULL CHECK (source_cursor ~ '^[0-9]{1,30}$'),
  parent_index integer NOT NULL CHECK (parent_index BETWEEN 0 AND 19999),
  message_index integer NOT NULL CHECK (message_index BETWEEN -1 AND 199999),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  capture_state text NOT NULL CHECK (capture_state IN ('captured','needs_review','malformed')),
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_response_event_fallback_uq UNIQUE (stream_id,source_cursor,parent_index,message_index,payload_digest)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS claimmd_response_event_vendor_uq ON claimmd_response_event(stream_id,response_id) WHERE response_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS claimmd_response_event_review_ix ON claimmd_response_event(stream_id,capture_state,captured_at);--> statement-breakpoint

ALTER TABLE claimmd_response_stream ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_response_stream FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_response_stream_capture ON claimmd_response_stream FOR ALL TO claimmd_capture USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE claimmd_response_batch ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_response_batch FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_response_batch_capture ON claimmd_response_batch FOR ALL TO claimmd_capture USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE claimmd_response_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_response_event FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_response_event_capture ON claimmd_response_event FOR ALL TO claimmd_capture USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (cursor,lease_owner,lease_until,generation,last_attempt_at,last_success_at,error_code,updated_at) ON claimmd_response_stream TO claimmd_capture;--> statement-breakpoint
GRANT SELECT, INSERT ON claimmd_response_batch, claimmd_response_event TO claimmd_capture;
