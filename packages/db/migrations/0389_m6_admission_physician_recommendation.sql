-- M6 — 42 CFR 418.25(a) (FY 2026 final rule, 90 FR 37416, effective 2025-10-01): the physician admission
-- recommendation, captured ON the admission row.
--
-- "(a) The hospice admits a patient only on the recommendation of the medical director (or the physician
-- designee, as defined in § 418.3) or the physician member of the hospice interdisciplinary group, in
-- consultation with, or with input from, the patient's attending physician (if any)."
--
-- One recommendation per admission, recorded at or before activation, so it lives on the episode root (no
-- separate table). The recommender is a USER (validated server-side against role grants and, for the IDG
-- physician capacity, an open `md` care-team assignment on this patient), NOT the M40 physician-directory id
-- the older `admitted_by_physician_id` / `hospice_physician_id` carry. `attending_consult_note` is free text
-- and is scrubbed by the write-audit trigger alongside `hold_reason`.
--
-- Also catalogues `admission.record_recommendation` in the `permission` mirror (FK target of role_permission;
-- the 0348 precedent) and grants it to every tenant role that can already ACTIVATE an admission
-- (`admission.activate`) or is a physician signer role (medical_director, hospice_physician). Idempotent;
-- never removes a grant.
ALTER TABLE "admission" ADD COLUMN IF NOT EXISTS "recommended_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "admission" ADD COLUMN IF NOT EXISTS "recommender_capacity" "physician_signer_capacity";--> statement-breakpoint
ALTER TABLE "admission" ADD COLUMN IF NOT EXISTS "recommended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admission" ADD COLUMN IF NOT EXISTS "attending_consulted" boolean;--> statement-breakpoint
ALTER TABLE "admission" ADD COLUMN IF NOT EXISTS "attending_consult_note" text;--> statement-breakpoint
ALTER TABLE "admission" ADD COLUMN IF NOT EXISTS "recommendation_recorded_by_user_id" uuid;--> statement-breakpoint

ALTER TABLE "admission" DROP CONSTRAINT IF EXISTS "admission_recommended_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "admission" ADD CONSTRAINT "admission_recommended_by_user_id_fk"
  FOREIGN KEY ("recommended_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "admission" DROP CONSTRAINT IF EXISTS "admission_recommendation_all_or_none";--> statement-breakpoint
ALTER TABLE "admission" ADD CONSTRAINT "admission_recommendation_all_or_none" CHECK (
  ("recommended_by_user_id" IS NULL AND "recommender_capacity" IS NULL AND "recommended_at" IS NULL AND "attending_consulted" IS NULL)
  OR ("recommended_by_user_id" IS NOT NULL AND "recommender_capacity" IS NOT NULL AND "recommended_at" IS NOT NULL AND "attending_consulted" IS NOT NULL)
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_admission() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['hold_reason', 'attending_consult_note']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['hold_reason', 'attending_consult_note']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'admission.' || lower(TG_OP),
    'admission',
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
ALTER FUNCTION audit_phi_write_admission() OWNER TO wardenx_audit_writer;--> statement-breakpoint

INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('admission.record_recommendation', 'admission', 'record_recommendation', 'clinical', 'admission.scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT DISTINCT r."organization_id", r."id", 'admission.record_recommendation'
  FROM "role" r
 WHERE r."organization_id" IS NOT NULL
   AND (
     r."key" IN ('medical_director', 'hospice_physician')
     OR EXISTS (
       SELECT 1 FROM "role_permission" rp
        WHERE rp."role_id" = r."id" AND rp."permission_key" = 'admission.activate'
     )
   )
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
