-- M14 IDG spec extension — `reason` becomes an OPTIONAL CONTEXT field on EVERY per-discipline note (builds on 0283).
--
-- 0283 stored the late-addendum reason in `addendum_reason` and forbade a reason on an original (live) note. Product
-- decision: a short "why this note" reason is useful context on ANY note; an ADDENDUM still REQUIRES one. The reason
-- therefore lives in ONE general column: `addendum_reason` is RENAMED to `reason` (metadata-only, no rewrite, existing
-- addendum reasons keep their values; a re-run is a no-op because the rename is guarded).
--
-- New CHECK `idg_discipline_note_addendum_chk` (replaces 0283's):
--   * an addendum has (flag, recorded-at, NON-BLANK reason 1..500) — unchanged;
--   * an original has NO recorded-at, and a reason that is either NULL or non-blank 1..500 (the app trims blank ⇒ NULL).
--
-- Tenancy/RLS/grants are UNCHANGED (same table; wardenx_app keeps SELECT/INSERT/UPDATE, NO DELETE; FORCE RLS from 0282).
-- `reason` is free text => DENYLISTED in the M4 write-audit trigger next to `body_text` (spec §3.3); the trigger
-- function is redefined here because 0283's scrubbed the OLD column name (a scrub of a now-missing key would leak).
-- Idempotent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'idg_discipline_note' AND column_name = 'addendum_reason'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'idg_discipline_note' AND column_name = 'reason'
  ) THEN
    ALTER TABLE "idg_discipline_note" RENAME COLUMN "addendum_reason" TO "reason";
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "idg_discipline_note" DROP CONSTRAINT IF EXISTS "idg_discipline_note_addendum_chk";--> statement-breakpoint
ALTER TABLE "idg_discipline_note" ADD CONSTRAINT "idg_discipline_note_addendum_chk" CHECK (
  (
    "is_addendum"
    AND "addendum_recorded_at" IS NOT NULL
    AND "reason" IS NOT NULL
    AND char_length(btrim("reason")) BETWEEN 1 AND 500
  ) OR (
    NOT "is_addendum"
    AND "addendum_recorded_at" IS NULL
    AND ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 1 AND 500)
  )
);--> statement-breakpoint

-- M4 write-audit trigger: body_text AND reason are scrubbed out of before/after.
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
    THEN audit_scrub(to_jsonb(OLD), ARRAY['body_text','reason','addendum_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['body_text','reason','addendum_reason']::text[]) ELSE NULL END;
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
