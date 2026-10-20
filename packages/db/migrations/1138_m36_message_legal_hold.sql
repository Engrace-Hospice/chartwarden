-- M36 WP 5.6 (ADR-0086, PROPOSED) - legal hold over MESSAGES, as the ADR-0051 OVERLAY (migration 1053 is the precedent).
--   * `legal_hold_message` records which messages an M4 `legal_hold` holds: one row per (hold, message), written by the hold workflow
--     in a tenant context, append-only for the app role (SELECT, INSERT; it can record that a message is held, never un-hold one).
--     No released_at: a row is "held" while its legal_hold.status = 'active', so releasing the hold is the single existing M4 UPDATE and
--     takes effect for every row at once; overlay rows stay as history. legal_hold_id is a plain uuid (no FK): M4 owns the table and
--     the seam is the id. The message FK is composite (organization_id, message_id) and cascades.
--   * Backstop: BEFORE DELETE and BEFORE UPDATE OF body_cipher on `message` refuse (23001) a message with an overlay row whose hold is
--     active, whoever runs the statement (the destruction credential, a tenant eraser, an out-of-band delete). SECURITY DEFINER owned by
--     wardenx_admin with a pinned search_path (pg_catalog only, every relation schema-qualified) so it sees the overlay and the hold whatever RLS context the caller carries (a missing
--     GUC must not read as "no hold"). The FK cascade from channel delete runs the per-row BEFORE DELETE trigger too, so it is covered.
--     The hold is joined on its own organization too: an overlay row naming another tenant's hold uuid cannot make a message undeletable.
--     Not covered, stated plainly: DROP / TRUNCATE or session_replication_role = replica by a superuser (procedural control).
--     Consequence: editing the body of a HELD message is refused (body_cipher is rewritten on edit); the revision chain is unaffected.
--     The M36 body backfill (re-seal under the ring) rewrites body_cipher too: it runs each row in a savepoint, treats this 23001 as
--     'skipped, legal hold' (counted as skippedLegalHold, audited in the batch row) and leaves the row on the legacy envelope until
--     the hold is released. The edit route additionally checks the LIVE hold predicate, so a not-yet-materialised held message is refused too.
--   * Messaging-only: no audit_event row is held by this overlay (ADR-0086 D5).
-- Table name starts with `legal_hold_`, not `audit_event`, so wardenx_audit_trigger() audits it (as 1053 does legal_hold_audit_event).

CREATE TABLE "legal_hold_message" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "legal_hold_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "held_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "legal_hold_message_message_fk"
    FOREIGN KEY ("organization_id", "message_id")
    REFERENCES "message"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "legal_hold_message_hold_message_unique" UNIQUE ("legal_hold_id", "message_id")
);--> statement-breakpoint
CREATE INDEX "legal_hold_message_message_idx" ON "legal_hold_message" ("organization_id", "message_id");--> statement-breakpoint

ALTER TABLE "legal_hold_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_hold_message" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "legal_hold_message_org_isolation" ON "legal_hold_message"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- The destruction credential reads the overlay (the eraser pre-check) and deletes it with the message subtree, pinned to the context org.
CREATE POLICY "legal_hold_message_destruction" ON "legal_hold_message"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- The backstop function must see EVERY tenant's rows whatever RLS context the deleting session carries: its dedicated policies.
CREATE POLICY "legal_hold_message_admin_all" ON "legal_hold_message"
  FOR ALL TO wardenx_admin USING (true) WITH CHECK (true);--> statement-breakpoint
-- (The guard reads legal_hold as wardenx_admin through 1053's legal_hold_admin_read policy.)

GRANT SELECT, INSERT ON "legal_hold_message" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, DELETE ON "legal_hold_message" TO wardenx_destruction;--> statement-breakpoint
GRANT ALL ON "legal_hold_message" TO wardenx_admin;--> statement-breakpoint

-- Bulk-written by the hold workflow, so INSERT is not audited (the hold's own apply / release are audited, with counts). What IS
-- audited is anything that changes or removes an overlay row: the app role cannot, so this fires for the cascade and for an
-- administrative correction.
CREATE TRIGGER "legal_hold_message_audit" AFTER UPDATE OR DELETE ON legal_hold_message
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_legal_hold_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
       SELECT 1
         FROM public.legal_hold_message h
         JOIN public.legal_hold l ON l.id = h.legal_hold_id
                          AND l.organization_id = h.organization_id
                          AND l.status = 'active'
        WHERE h.organization_id = OLD.organization_id
          AND h.message_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'message % is under an active legal hold and cannot be % (ADR-0086)', OLD.id,
      CASE TG_OP WHEN 'DELETE' THEN 'deleted' ELSE 'rewritten' END
      USING ERRCODE = '23001',
            HINT = 'release the legal hold first (a legal hold outranks retention and erasure)';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
ALTER FUNCTION message_legal_hold_guard() OWNER TO wardenx_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION message_legal_hold_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "message_legal_hold_guard_delete" BEFORE DELETE ON "message"
  FOR EACH ROW EXECUTE FUNCTION message_legal_hold_guard();--> statement-breakpoint
CREATE TRIGGER "message_legal_hold_guard_body" BEFORE UPDATE OF "body_cipher" ON "message"
  FOR EACH ROW EXECUTE FUNCTION message_legal_hold_guard();--> statement-breakpoint

-- The permission (mirrors 1130 / 1131). Apply and release also demand a fresh step-up and a written reason in the route (S4).
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.retention.manage', 'message_retention', 'manage', 'compliance', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.retention.manage'
  FROM "role" r
 WHERE r."key" IN ('compliance_officer', 'administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
