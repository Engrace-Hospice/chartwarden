-- M6 — 42 CFR 418.26(b) (FY 2027 final rule, CMS-1851-F, effective 2026-10-01): the written physician
-- discharge order, captured ON the discharge_event row.
--
-- "Prior to discharging a patient for any reason listed in paragraph (a) of this section, the hospice must
-- obtain a written physician's discharge order from the hospice medical director (or physician designee, as
-- defined at § 418.3) or physician member of the interdisciplinary group."
--
-- Why columns on discharge_event and not an M11 order kind: there is exactly ONE discharge order per discharge
-- (discharge_event is already unique per admission), it must exist BEFORE the discharge completes (same write),
-- and M6 does not depend on M11 — a separate order row would be a cross-module write inside the discharge
-- transaction plus a second source of truth for the same fact. `discharge_order_reference` carries an optional
-- pointer to the signed source document (an M11 order id, an M22 document id, a fax/scan reference) so the
-- written order itself stays traceable.
--
-- `physician_signer_capacity` is the shared signer-set enum for 418.26(b) AND 418.25(a) (migration 0389):
-- the medical director, the physician designee (§ 418.3), or the physician member of the patient's IDG.
-- The attending physician, NPs and PAs are never signers (FR-F declined PAs).
--
-- Also persists the route-40 cosigner name/NPI that `cosignDischarge` used to discard (`void input`).
-- Additive and nullable: discharges before 2026-10-01 carry no order (legacy rule). The all-or-none CHECK keeps
-- a half-recorded order out. Existing RLS (org_id GUC) + grants cover the new columns. `discharge_order_text`
-- is free text (may carry PHI) so the write-audit trigger now scrubs it alongside `narrative`/`for_cause_reason`.
DO $$ BEGIN
  CREATE TYPE "public"."physician_signer_capacity" AS ENUM('medical_director', 'physician_designee', 'idg_physician_member');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "discharge_event" ADD COLUMN IF NOT EXISTS "discharge_order_signed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "discharge_event" ADD COLUMN IF NOT EXISTS "discharge_order_signer_capacity" "physician_signer_capacity";--> statement-breakpoint
ALTER TABLE "discharge_event" ADD COLUMN IF NOT EXISTS "discharge_order_signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "discharge_event" ADD COLUMN IF NOT EXISTS "discharge_order_text" text;--> statement-breakpoint
ALTER TABLE "discharge_event" ADD COLUMN IF NOT EXISTS "discharge_order_reference" text;--> statement-breakpoint
ALTER TABLE "discharge_event" ADD COLUMN IF NOT EXISTS "cosigner_name" text;--> statement-breakpoint
ALTER TABLE "discharge_event" ADD COLUMN IF NOT EXISTS "cosigner_npi" text;--> statement-breakpoint

ALTER TABLE "discharge_event" DROP CONSTRAINT IF EXISTS "discharge_event_order_signed_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "discharge_event" ADD CONSTRAINT "discharge_event_order_signed_by_user_id_fk"
  FOREIGN KEY ("discharge_order_signed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "discharge_event" DROP CONSTRAINT IF EXISTS "discharge_event_order_all_or_none";--> statement-breakpoint
ALTER TABLE "discharge_event" ADD CONSTRAINT "discharge_event_order_all_or_none" CHECK (
  ("discharge_order_signed_by_user_id" IS NULL AND "discharge_order_signer_capacity" IS NULL AND "discharge_order_signed_at" IS NULL)
  OR ("discharge_order_signed_by_user_id" IS NOT NULL AND "discharge_order_signer_capacity" IS NOT NULL AND "discharge_order_signed_at" IS NOT NULL)
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_discharge_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['for_cause_reason', 'narrative', 'discharge_order_text']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['for_cause_reason', 'narrative', 'discharge_order_text']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'discharge.' || lower(TG_OP),
    'discharge',
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
ALTER FUNCTION audit_phi_write_discharge_event() OWNER TO wardenx_audit_writer;
