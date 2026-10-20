-- M36 WP 4.13 slice S1 (ADR-0082 decision 7, PROPOSED, flag-off) - the correlation row between an after-hours send and the M19 triage
-- call it asked for. One row per after-hours send, written in the same transaction as the message and its acknowledgment request
-- (slice S3 writes it; nothing writes it yet). Ids, one closed outcome and instants only: no text, no patient id, no name.
--   * message_id is UNIQUE (a retry converges); source_outbox_event_id is UNIQUE (it is the key M19's outcome event carries back);
--   * triage_call_id and outcome are NULL until M19 replies. They move once, together, NULL -> value (guard below); every other column
--     is fixed at insert. `triage_call_id` is set only for opened / coalesced (CHECK), and has no FK: M19 owns that table and M36 never
--     writes or references M19 tables (ADR-0082 decision 1);
--   * source_outbox_event_id has no FK either: outbox rows are purged after dispatch, the link outlives them.
-- Isolation: org policy on organization_id (ADR-0010; the 1107 / 1129 shape), ENABLE + FORCE, the app role's grant is SELECT, INSERT and a
-- column UPDATE of the two reply columns only. The cascade FK to the request carries the tenant (organization_id, request_id).
CREATE TABLE "message_afterhours_triage_link" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "message_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "source_outbox_event_id" uuid NOT NULL,
  "triage_call_id" uuid,
  "outcome" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_afterhours_triage_link_message_uq" UNIQUE ("message_id"),
  CONSTRAINT "message_afterhours_triage_link_event_uq" UNIQUE ("source_outbox_event_id"),
  CONSTRAINT "message_afterhours_triage_link_request_fk"
    FOREIGN KEY ("organization_id", "request_id")
    REFERENCES "message_acknowledgment_request"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_afterhours_triage_link_outcome" CHECK (
    "outcome" IS NULL OR "outcome" IN ('opened', 'coalesced', 'no_coverage')),
  -- A call id exists exactly when a call was opened or joined; a silent M19 leaves both NULL. Written out so no NULL can pass.
  CONSTRAINT "message_afterhours_triage_link_call" CHECK (
    ("outcome" IS NULL AND "triage_call_id" IS NULL)
    OR ("outcome" IN ('opened', 'coalesced') AND "triage_call_id" IS NOT NULL)
    OR ("outcome" = 'no_coverage' AND "triage_call_id" IS NULL))
);--> statement-breakpoint

-- FK-index coverage (test:fk-indexes:live): the request FK and the organization FK both lead with organization_id.
CREATE INDEX "message_afterhours_triage_link_org_request_idx"
  ON "message_afterhours_triage_link" ("organization_id", "request_id");--> statement-breakpoint

ALTER TABLE "message_afterhours_triage_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_afterhours_triage_link" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_afterhours_triage_link_org_isolation" ON "message_afterhours_triage_link"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_afterhours_triage_link" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("triage_call_id", "outcome") ON "message_afterhours_triage_link" TO wardenx_app;--> statement-breakpoint

-- The reply columns move once, NULL -> value, and nothing else moves, whoever writes (a superuser too: triggers fire for it).
-- SECURITY INVOKER (the default): the body reads only OLD and NEW, so it needs no privilege of its own. The search_path stays pinned.
CREATE OR REPLACE FUNCTION message_afterhours_triage_link_update_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.message_id <> OLD.message_id
     OR NEW.request_id <> OLD.request_id OR NEW.source_outbox_event_id <> OLD.source_outbox_event_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'message_afterhours_triage_link_immutable: identity and the source event are fixed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.outcome IS NOT NULL THEN
    RAISE EXCEPTION 'message_afterhours_triage_link_final: the outcome is recorded once'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.outcome IS NULL THEN
    RAISE EXCEPTION 'message_afterhours_triage_link_outcome: an update records an outcome'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "message_afterhours_triage_link_update_guard"
  BEFORE UPDATE ON "message_afterhours_triage_link"
  FOR EACH ROW EXECUTE FUNCTION message_afterhours_triage_link_update_guard();--> statement-breakpoint

CREATE TRIGGER "trg_audit_message_afterhours_triage_link" AFTER INSERT OR UPDATE OR DELETE ON message_afterhours_triage_link
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

GRANT SELECT, DELETE ON "message_afterhours_triage_link" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "message_afterhours_triage_link_destruction" ON "message_afterhours_triage_link"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
