-- M36 WP 1.5 "Attachments via M22" — makes `message_attachment` a real, tenant-safe, scan-gated row and adds the
-- append-only open log.
--
-- Before: `message_attachment` had no organization_id (parent-join RLS only), an unvalidated `document_ref`, and
-- the send path ignored the `attachments` field entirely. After:
--   * organization_id + channel_id + uploaded_by; composite FKs (organization_id, message_id) -> message and
--     (organization_id, channel_id) -> channel, so a cross-tenant link is refused below the application (an FK
--     check bypasses RLS, so the id-only FK could not do this); RLS + FORCE keyed on organization_id.
--   * an attachment is created BEFORE its message (upload -> complete -> scan -> bind on send), so message_id is
--     nullable until bound.
--   * scan_state pending|clean|quarantined (+ scanned_at, scan_signature). Terminal states are final: a trigger
--     refuses quarantined -> clean and clean -> pending. Nothing is delivered unless 'clean'.
--   * the bytes live in the tenant's M22 object-store bucket under an opaque key; `document_ref` is now nullable
--     and unused (no M22 `document` row is created for a chat attachment).
--   * `attachment_access_event`: one row per open attempt (open | denied). The app role may SELECT and INSERT only.
-- Legacy rows (none are written by the app today) keep scan_state='pending' with no object key: never deliverable.

ALTER TABLE "message_attachment"
  ADD COLUMN "organization_id" uuid,
  ADD COLUMN "channel_id" uuid,
  ADD COLUMN "uploaded_by" uuid REFERENCES "user"("id"),
  ADD COLUMN "object_key" text,
  ADD COLUMN "sha256_hex" text,
  ADD COLUMN "scan_state" text NOT NULL DEFAULT 'pending',
  ADD COLUMN "scanned_at" timestamptz,
  ADD COLUMN "scan_signature" text,
  ADD COLUMN "upload_expires_at" timestamptz,
  ADD COLUMN "completed_at" timestamptz,
  ADD COLUMN "scan_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN "last_scan_attempt_at" timestamptz,
  -- Consecutive "object not found" observations (reset by any successful read) and when the run began: a legit file is
  -- finalised object-missing only after >= 3 misses spanning >= 15 min, never because a scanner outage inflated scan_attempts.
  ADD COLUMN "object_missing_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "first_object_missing_at" timestamptz;--> statement-breakpoint

UPDATE "message_attachment" a
   SET "organization_id" = m."organization_id", "channel_id" = m."channel_id", "uploaded_by" = m."author_user_id"
  FROM "message" m
 WHERE m."id" = a."message_id";--> statement-breakpoint

ALTER TABLE "message_attachment"
  ALTER COLUMN "organization_id" SET NOT NULL,
  ALTER COLUMN "channel_id" SET NOT NULL,
  ALTER COLUMN "message_id" DROP NOT NULL,
  ALTER COLUMN "document_ref" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "message_attachment" DROP CONSTRAINT "message_attachment_message_id_message_id_fk";--> statement-breakpoint
ALTER TABLE "message_attachment"
  ADD CONSTRAINT "message_attachment_org_fk" FOREIGN KEY ("organization_id")
    REFERENCES "organization"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "message_attachment_message_org_fk" FOREIGN KEY ("organization_id", "message_id")
    REFERENCES "message"("organization_id", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "message_attachment_channel_org_fk" FOREIGN KEY ("organization_id", "channel_id")
    REFERENCES "channel"("organization_id", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "message_attachment_org_id_id_unique" UNIQUE ("organization_id", "id"),
  ADD CONSTRAINT "message_attachment_scan_state_valid"
    CHECK ("scan_state" IN ('pending', 'clean', 'quarantined')),
  ADD CONSTRAINT "message_attachment_scanned_at_matches_state"
    CHECK (("scan_state" = 'pending') = ("scanned_at" IS NULL)),
  ADD CONSTRAINT "message_attachment_clean_was_completed"
    CHECK ("scan_state" <> 'clean' OR "completed_at" IS NOT NULL),
  ADD CONSTRAINT "message_attachment_byte_size_bounds" CHECK ("byte_size" BETWEEN 1 AND 25000000),
  ADD CONSTRAINT "message_attachment_sha256_shape"
    CHECK ("sha256_hex" IS NULL OR "sha256_hex" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "message_attachment_completed_has_object"
    CHECK ("completed_at" IS NULL OR ("object_key" IS NOT NULL AND "sha256_hex" IS NOT NULL)),
  ADD CONSTRAINT "message_attachment_unbound_has_uploader"
    CHECK ("message_id" IS NOT NULL OR "uploaded_by" IS NOT NULL);--> statement-breakpoint

CREATE INDEX "message_attachment_org_message_idx" ON "message_attachment" ("organization_id", "message_id")
  WHERE "message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "message_attachment_org_channel_idx" ON "message_attachment" ("organization_id", "channel_id");--> statement-breakpoint
CREATE INDEX "message_attachment_uploaded_by_idx" ON "message_attachment" ("uploaded_by");--> statement-breakpoint
-- The scan sweep's work queue: completed uploads still waiting for a verdict, least-recently-attempted first (a row
-- the scanner keeps failing on must not starve the rows behind it).
CREATE INDEX "message_attachment_scan_pending_idx"
  ON "message_attachment" ("last_scan_attempt_at" NULLS FIRST, "completed_at")
  WHERE "scan_state" = 'pending' AND "completed_at" IS NOT NULL;--> statement-breakpoint
-- The orphan reaper's work queue: uploads that never became part of a message.
CREATE INDEX "message_attachment_unbound_idx" ON "message_attachment" ("organization_id", "created_at")
  WHERE "message_id" IS NULL;--> statement-breakpoint

-- RLS: the parent-join policy is replaced by the three-column shape every other M36 table uses.
DROP POLICY IF EXISTS "message_attachment_via_message" ON "message_attachment";--> statement-breakpoint
ALTER TABLE "message_attachment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_attachment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_attachment_org_isolation" ON "message_attachment"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS "message_attachment_destruction" ON "message_attachment";--> statement-breakpoint
CREATE POLICY "message_attachment_destruction" ON "message_attachment"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- Least privilege (the table inherited a blanket SELECT/INSERT/UPDATE/DELETE grant from 0017): the app role can never
-- DELETE an attachment row (the row is the only pointer to the bytes; deletion belongs to the erase path and the
-- orphan reaper, both on the wardenx_destruction credential, which keeps its 0157 SELECT+DELETE) and UPDATEs only the
-- columns the code legitimately changes. Identity (org/channel/uploader/object/sha/name/type/size) is not updatable.
REVOKE UPDATE, DELETE ON "message_attachment" FROM wardenx_app;--> statement-breakpoint
GRANT UPDATE ("message_id", "completed_at", "scan_state", "scanned_at", "scan_signature",
              "scan_attempts", "last_scan_attempt_at", "object_missing_count", "first_object_missing_at")
  ON "message_attachment" TO wardenx_app;--> statement-breakpoint

-- A verdict is final. A rescan is a NEW attachment, never a flip of an old row; the object key, checksum, tenant,
-- channel and uploader never change after insert, and a bound attachment never moves to another message.
CREATE OR REPLACE FUNCTION message_attachment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.scan_state <> 'pending' AND NEW.scan_state IS DISTINCT FROM OLD.scan_state THEN
    RAISE EXCEPTION 'message_attachment scan_state % is final (cannot become %)', OLD.scan_state, NEW.scan_state
      USING ERRCODE = '23514';
  END IF;
  -- Only an uploaded-and-verified object can be judged clean (defence in depth next to the CHECKs).
  IF OLD.scan_state = 'pending' AND NEW.scan_state = 'clean'
     AND (NEW.completed_at IS NULL OR NEW.object_key IS NULL) THEN
    RAISE EXCEPTION 'message_attachment cannot become clean before its upload is completed'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'message_attachment completed_at is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
     OR NEW.sha256_hex IS DISTINCT FROM OLD.sha256_hex
     OR NEW.object_key IS DISTINCT FROM OLD.object_key THEN
    RAISE EXCEPTION 'message_attachment tenant/channel/uploader/object identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id THEN
    RAISE EXCEPTION 'message_attachment is already bound to a message' USING ERRCODE = '23514';
  END IF;
  -- A bind may only point at a message in the attachment's own channel (the composite FK already pins the tenant).
  IF OLD.message_id IS NULL AND NEW.message_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM message m
        WHERE m.organization_id = NEW.organization_id AND m.id = NEW.message_id AND m.channel_id = NEW.channel_id) THEN
    RAISE EXCEPTION 'message_attachment can only be bound to a message in its own channel'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "message_attachment_guard_trg" BEFORE UPDATE ON "message_attachment"
  FOR EACH ROW EXECUTE FUNCTION message_attachment_guard();--> statement-breakpoint

-- Write audit: the table now has organization_id, so the M4 generator shape applies. filename may carry PHI (a
-- patient name) and object_key is storage-internal, so neither is copied into audit_event.
DROP TRIGGER IF EXISTS "message_attachment_audit" ON "message_attachment";--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_message_attachment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['filename','object_key']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['filename','object_key']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'message_attachment.' || lower(TG_OP), 'message_attachment',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_message_attachment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_attachment"
  AFTER INSERT OR UPDATE OR DELETE ON message_attachment
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_attachment();--> statement-breakpoint

-- ── attachment_access_event: the append-only open log ──────────────────────────────────────────────────────
CREATE TABLE "attachment_access_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "attachment_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id"),
  "action" text NOT NULL,
  "reason" text,
  "occurred_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "attachment_access_event_attachment_org_fk"
    FOREIGN KEY ("organization_id", "attachment_id")
    REFERENCES "message_attachment"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "attachment_access_event_action_valid" CHECK ("action" IN ('open', 'denied')),
  CONSTRAINT "attachment_access_event_reason_shape"
    CHECK (("action" = 'denied') = ("reason" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX "attachment_access_event_org_attachment_idx"
  ON "attachment_access_event" ("organization_id", "attachment_id", "occurred_at");--> statement-breakpoint
CREATE INDEX "attachment_access_event_user_idx" ON "attachment_access_event" ("user_id");--> statement-breakpoint

ALTER TABLE "attachment_access_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachment_access_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "attachment_access_event_org_isolation" ON "attachment_access_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "attachment_access_event" TO wardenx_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_attachment_access_event() RETURNS trigger
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
    'user', 'attachment_access_event.' || lower(TG_OP), 'attachment_access_event',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_attachment_access_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_attachment_access_event"
  AFTER INSERT OR UPDATE OR DELETE ON attachment_access_event
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_attachment_access_event();--> statement-breakpoint

GRANT SELECT, DELETE ON "attachment_access_event" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "attachment_access_event_destruction" ON "attachment_access_event"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
