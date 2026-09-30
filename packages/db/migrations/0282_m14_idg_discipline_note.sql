-- M14 IDG spec extension — PER-DISCIPLINE NOTE TAKING in the live meeting.
--
-- The M14 spec has only agenda-item body text and the minutes closing note as free text; a live IDG is run by a
-- team of disciplines each of which keeps its own notes (about one patient on the agenda, or about the meeting
-- as a whole). `idg_discipline_note` is that record. Architecture is unchanged: an M14-owned table, org-scoped
-- canonical `app.org_id` RLS (ENABLED + FORCED), the three-column tenancy (nullable, like `idg_agenda_item` —
-- a meeting-level note has no patient), wardenx_app SELECT/INSERT/UPDATE and NO DELETE (append/edit-only, the
-- agenda's posture), and the M4 write-audit trigger with `body_text` DENYLISTED (free-text PHI, spec §3.3).
--
-- `discipline` reuses the free-text vocabulary of `idg_attendance.discipline` (no enum: the roster is the
-- source of truth). `patient_id` / `author_membership_id` are plain uuid, app-validated (no cross-module FK).
-- Editing is a version-bumped UPDATE (If-Match at the route); the note is only writable while the meeting is
-- `live` (route service guard) and is SNAPSHOTTED into `idg_minutes.discipline_note_snapshot` at adjournment.
-- Idempotent.

CREATE TABLE IF NOT EXISTS "idg_discipline_note" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid,
  "location_id" uuid,
  "idg_meeting_id" uuid NOT NULL,
  "patient_id" uuid,
  "discipline" text NOT NULL,
  "body_text" text NOT NULL,
  "author_membership_id" uuid NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "idg_discipline_note_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "idg_discipline_note_provider_entity_id_provider_entity_id_fk"
    FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "idg_discipline_note_location_id_location_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "idg_discipline_note_idg_meeting_id_idg_meeting_id_fk"
    FOREIGN KEY ("idg_meeting_id") REFERENCES "public"."idg_meeting"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "idg_discipline_note_discipline_chk" CHECK (char_length("discipline") BETWEEN 1 AND 64),
  CONSTRAINT "idg_discipline_note_body_chk" CHECK (char_length("body_text") BETWEEN 1 AND 8000)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idg_discipline_note_meeting_idx"
  ON "idg_discipline_note" ("organization_id", "idg_meeting_id", "patient_id", "created_at");--> statement-breakpoint

ALTER TABLE "idg_discipline_note" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "idg_discipline_note" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "idg_discipline_note_org" ON "idg_discipline_note";--> statement-breakpoint
CREATE POLICY "idg_discipline_note_org" ON "idg_discipline_note"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "idg_discipline_note" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "idg_discipline_note" TO wardenx_admin;--> statement-breakpoint

-- M4 write-audit trigger (the idg_agenda_item shape): body_text is scrubbed out of before/after.
CREATE OR REPLACE FUNCTION audit_phi_write_idg_discipline_note() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['body_text']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['body_text']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'idg_discipline_note.' || lower(TG_OP),
    'idg_discipline_note',
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
ALTER FUNCTION audit_phi_write_idg_discipline_note() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_idg_discipline_note" ON "idg_discipline_note";--> statement-breakpoint
CREATE TRIGGER "trg_audit_idg_discipline_note" AFTER INSERT OR UPDATE OR DELETE ON idg_discipline_note
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_idg_discipline_note();--> statement-breakpoint

-- Patient destruction (0157's pattern; idg-eraser.ts deletes a patient's notes): SELECT + DELETE and an
-- org-pinned destruction policy.
GRANT SELECT, DELETE ON "idg_discipline_note" TO wardenx_destruction;--> statement-breakpoint
DROP POLICY IF EXISTS "idg_discipline_note_destruction" ON "idg_discipline_note";--> statement-breakpoint
CREATE POLICY "idg_discipline_note_destruction" ON "idg_discipline_note"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- The minutes freeze the notes at adjournment, next to the three existing snapshot columns.
ALTER TABLE "idg_minutes" ADD COLUMN IF NOT EXISTS "discipline_note_snapshot" jsonb;
