-- compat: expand
-- ADR-0109 D6 - `bereavement_physician_letter`: the condolence letter from the hospice to the patient's INTERNAL attending clinician, one
-- per bereavement plan, created `pending_review` by the intake that opens the plan and disclosed only after a human approves it.
--   * Lifecycle: pending_review -> approved | declined; approved -> rendered (M22 stamped `rendered_document_id`). `declined` and
--     `rendered` are terminal. Approval emits `m16.bereavement.document_requested` in the same transaction as the status change.
--   * The recipient is internal: `attending_user_id` is the clinician on the care team's open attending/md assignment (M5 CareTeamProvider),
--     else the user the reviewer names at approval (an active member of the organization). No community-physician reference, no ref_kind.
--     It is nullable while pending (nobody may resolve yet) and required once approved or rendered.
--   * `personal_note_cipher` is the reviewer's optional note (<= 1000 characters) sealed with the tenant DEK like the other *_cipher columns
--     (cipher column `bereavement_physician_letter.personal_note`, nulled by the eraser). Only an approved or rendered letter carries one.
--   * `decline_reason_redacted` is prose (>= 20 characters when present) and audit-denylisted; only a declined letter carries one. It may be
--     NULL on a declined row so the eraser can shred it without breaking a CHECK; the service requires it at decline.
--   * `version` is the If-Match token (0 on creation, +1 per review transition).
--   * `plan_id` is UNIQUE: the intake consumers insert with ON CONFLICT DO NOTHING, so a redelivery never makes a second letter.
-- Patient-bearing: carries organization_id NOT NULL + provider_entity_id NOT NULL + location_id (nullable) (three-column rule), from the plan.
CREATE TABLE "bereavement_physician_letter" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "plan_id" uuid NOT NULL REFERENCES "bereavement_plan"("id") ON DELETE RESTRICT,
  "patient_id" uuid NOT NULL,
  "attending_user_id" uuid,
  "status" text DEFAULT 'pending_review' NOT NULL,
  "due_at" timestamptz NOT NULL,
  "personal_note_cipher" text,
  "decline_reason_redacted" text,
  "reviewed_by_membership_id" uuid,
  "reviewed_at" timestamptz,
  "rendered_document_id" uuid,
  "m22_render_requested_at" timestamptz,
  "m22_rendered_at" timestamptz,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "berv_physician_letter_status_chk" CHECK ("status" IN ('pending_review', 'approved', 'rendered', 'declined')),
  -- A review names who decided and when; a pending letter names neither.
  CONSTRAINT "berv_physician_letter_review_chk" CHECK (
    ("status" = 'pending_review') = ("reviewed_at" IS NULL AND "reviewed_by_membership_id" IS NULL)
  ),
  -- The letter goes to an internal clinician: required once it is approved (and so once rendered).
  CONSTRAINT "berv_physician_letter_attending_chk" CHECK ("status" NOT IN ('approved', 'rendered') OR "attending_user_id" IS NOT NULL),
  CONSTRAINT "berv_physician_letter_note_chk" CHECK ("personal_note_cipher" IS NULL OR "status" IN ('approved', 'rendered')),
  CONSTRAINT "berv_physician_letter_decline_chk" CHECK (
    "decline_reason_redacted" IS NULL OR ("status" = 'declined' AND char_length(btrim("decline_reason_redacted")) >= 20)
  ),
  -- The M22 handshake: requested at approval, rendered when the back-ref lands.
  CONSTRAINT "berv_physician_letter_render_request_chk" CHECK (
    ("status" IN ('approved', 'rendered')) = ("m22_render_requested_at" IS NOT NULL)
  ),
  CONSTRAINT "berv_physician_letter_rendered_chk" CHECK (
    ("status" = 'rendered') = ("rendered_document_id" IS NOT NULL AND "m22_rendered_at" IS NOT NULL)
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX "berv_physician_letter_plan_uniq" ON "bereavement_physician_letter" ("plan_id");--> statement-breakpoint
-- The review queue: pending letters oldest-due first.
CREATE INDEX "berv_physician_letter_pending_idx" ON "bereavement_physician_letter" ("organization_id", "due_at") WHERE "status" = 'pending_review';--> statement-breakpoint
CREATE INDEX "berv_physician_letter_org_ix" ON "bereavement_physician_letter" ("organization_id", "created_at");--> statement-breakpoint
CREATE INDEX "berv_physician_letter_provider_entity_idx" ON "bereavement_physician_letter" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX "berv_physician_letter_location_idx" ON "bereavement_physician_letter" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint

-- RLS on app.org_id (FORCEd). The app role reads, inserts and updates; nothing deletes (destruction goes through the admin-run eraser).
ALTER TABLE "bereavement_physician_letter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bereavement_physician_letter" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bereavement_physician_letter_org_isolation" ON "bereavement_physician_letter"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bereavement_physician_letter" TO chartwarden_app;--> statement-breakpoint

-- The 1200 PHI audit pattern. The decline reason is prose, so the audit row scrubs it (M16_AUDIT_DENYLIST); the sealed note stays as
-- ciphertext (the change-detection signal), like every other *_cipher column.
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_physician_letter() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_before jsonb; v_after jsonb;
  v_cols text[] := ARRAY['decline_reason_redacted']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_ARGV[0] || '.' || lower(TG_OP), TG_ARGV[0],
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
ALTER FUNCTION audit_phi_write_bereavement_physician_letter() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_physician_letter"
  AFTER INSERT OR UPDATE OR DELETE ON bereavement_physician_letter
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_physician_letter('bereavement_physician_letter');
