-- compat: expand
-- M36 death-notification cascade (builds on ADR-0098, PROPOSED) - who must be told a patient died, and whether each recipient has
-- acknowledged. Behind the tenant flag messaging.death_notifications (default off). Ids, enums and instants only: no clinical
-- content, no names, no free text.
--   * death_notification: one row per (board, recipient_kind, recipient_ref); the unique index is the idempotency arbiter, so the two
--     death events and any redelivery converge on the same rows. recipient_ref is a user id (attending), the kind name (role-resolved
--     internal kinds) or the MDM entity id (external kinds).
--   * state: pending | sent | acked | failed | blocked_no_baa | not_applicable. blocked_no_baa = an external disclosure was refused
--     because no BAA is on file for the entity (the row is the evidence; nothing left the perimeter).
-- Rules the database enforces (the service checks first, these are the backstop):
--   * a row is BORN pending, blocked_no_baa or failed-free: never acked; acked_at / acked_by are set together and only by the ack
--     transition; acked is final; acked_at and updated_at come from the DATABASE clock, whatever the client sends;
--   * the app role has NO DELETE and may UPDATE only the lifecycle columns; chartwarden_destruction may DELETE for tenant destruction.
-- Tenancy: organization_id plus a server-validated patient_id (a logical pointer, like death_board); M36 carries no provider/location.
-- The PHI audit row scrubs patient_id.

CREATE TABLE "death_notification" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "board_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "recipient_kind" text NOT NULL,
  "recipient_ref" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "sent_at" timestamptz,
  "acked_at" timestamptz,
  "acked_by" uuid,
  "sent_outbox_event_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "death_notification_org_id_uq" UNIQUE ("organization_id", "id"),
  CONSTRAINT "death_notification_board_fk"
    FOREIGN KEY ("organization_id", "board_id")
    REFERENCES "death_board"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "death_notification_kind_shape" CHECK ("recipient_kind" IN
    ('attending', 'medical_director', 'bereavement_coordinator', 'billing_lead', 'pharmacy_liaison', 'dme_liaison',
     'funeral_home', 'pharmacy_vendor', 'dme_vendor')),
  CONSTRAINT "death_notification_state_shape" CHECK ("state" IN
    ('pending', 'sent', 'acked', 'failed', 'blocked_no_baa', 'not_applicable')),
  CONSTRAINT "death_notification_ref_shape" CHECK (length("recipient_ref") BETWEEN 1 AND 64),
  CONSTRAINT "death_notification_acked_shape"
    CHECK (("state" = 'acked') = ("acked_at" IS NOT NULL) AND ("state" = 'acked') = ("acked_by" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "death_notification_one_per_recipient"
  ON "death_notification" ("organization_id", "board_id", "recipient_kind", "recipient_ref");--> statement-breakpoint
CREATE INDEX "death_notification_state_idx" ON "death_notification" ("organization_id", "state", "created_at");--> statement-breakpoint
CREATE INDEX "death_notification_patient_idx" ON "death_notification" ("organization_id", "patient_id");--> statement-breakpoint

-- Born pending / blocked_no_baa / failed only (no INSERT may plant an acknowledged row).
CREATE OR REPLACE FUNCTION death_notification_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state = 'acked' THEN
    RAISE EXCEPTION 'death_notification_insert_state: a notification is never created acknowledged' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_death_notification_insert_guard"
  BEFORE INSERT ON death_notification
  FOR EACH ROW EXECUTE FUNCTION death_notification_insert_guard();--> statement-breakpoint

-- Finality and the database clock. SECURITY INVOKER; reads no session variable.
CREATE OR REPLACE FUNCTION death_notification_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.state = 'acked' THEN
    RAISE EXCEPTION 'death_notification_final: an acknowledged notification cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'acked' THEN
    NEW.acked_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_death_notification_guard"
  BEFORE UPDATE ON death_notification
  FOR EACH ROW EXECUTE FUNCTION death_notification_guard();--> statement-breakpoint

ALTER TABLE "death_notification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "death_notification" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "death_notification_org_isolation" ON "death_notification"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "death_notification" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("state", "sent_at", "acked_at", "acked_by", "sent_outbox_event_id", "updated_at")
  ON "death_notification" TO chartwarden_app;--> statement-breakpoint

-- The 1103 PHI audit pattern: patient_id is recorded as changed without being copied into the immutable log.
CREATE OR REPLACE FUNCTION audit_phi_write_death_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['patient_id']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['patient_id']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME,
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
ALTER FUNCTION audit_phi_write_death_notification() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_death_notification"
  AFTER INSERT OR UPDATE OR DELETE ON death_notification
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_death_notification();--> statement-breakpoint

GRANT SELECT, DELETE ON "death_notification" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "death_notification_destruction" ON "death_notification"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
