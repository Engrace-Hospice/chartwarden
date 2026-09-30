-- M14 IDG spec extension — LATE ADDENDA to the per-discipline meeting notes (builds on 0282).
--
-- Once a meeting is ADJOURNED its minutes are FINAL and `idg_minutes.discipline_note_snapshot` is frozen (spec D10,
-- "frozen for survey reconstruction"). A discipline that forgot to record something must not edit that record, so
-- a note written AFTER adjournment is stored as an ADDENDUM: a NEW `idg_discipline_note` row that never touches the
-- snapshot or the minutes, is flagged `is_addendum`, carries the server clock time it was recorded
-- (`addendum_recorded_at`) and a REQUIRED short `addendum_reason` (mirrors the post-final amendment discipline).
-- Addenda are append-only (the route refuses PATCH on them; a correction is a further addendum) and are only
-- accepted inside a bounded window after adjournment (route/service guard, `DISCIPLINE_NOTE_ADDENDUM_WINDOW_DAYS`).
--
-- Tenancy/RLS/grants are unchanged from 0282 (same table): wardenx_app keeps SELECT/INSERT/UPDATE, NO DELETE.
-- `addendum_reason` is free text => DENYLISTED in the M4 write-audit trigger next to `body_text` (spec §3.3).
-- Idempotent.

ALTER TABLE "idg_discipline_note" ADD COLUMN IF NOT EXISTS "is_addendum" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "idg_discipline_note" ADD COLUMN IF NOT EXISTS "addendum_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "idg_discipline_note" ADD COLUMN IF NOT EXISTS "addendum_reason" text;--> statement-breakpoint

-- An addendum has all of (flag, recorded-at, non-blank reason ≤ 500); an original note has none of them.
ALTER TABLE "idg_discipline_note" DROP CONSTRAINT IF EXISTS "idg_discipline_note_addendum_chk";--> statement-breakpoint
ALTER TABLE "idg_discipline_note" ADD CONSTRAINT "idg_discipline_note_addendum_chk" CHECK (
  (
    "is_addendum"
    AND "addendum_recorded_at" IS NOT NULL
    AND "addendum_reason" IS NOT NULL
    AND char_length(btrim("addendum_reason")) BETWEEN 1 AND 500
  ) OR (
    NOT "is_addendum"
    AND "addendum_recorded_at" IS NULL
    AND "addendum_reason" IS NULL
  )
);--> statement-breakpoint

-- Live addendum count per meeting (minutes read) — partial index, addenda are rare.
CREATE INDEX IF NOT EXISTS "idg_discipline_note_addendum_idx"
  ON "idg_discipline_note" ("organization_id", "idg_meeting_id")
  WHERE "is_addendum";--> statement-breakpoint

-- M4 write-audit trigger: body_text AND addendum_reason are scrubbed out of before/after.
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
    THEN audit_scrub(to_jsonb(OLD), ARRAY['body_text','addendum_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['body_text','addendum_reason']::text[]) ELSE NULL END;
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
ALTER FUNCTION audit_phi_write_idg_discipline_note() OWNER TO wardenx_audit_writer;
