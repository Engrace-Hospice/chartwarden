-- compat: expand
-- #909 — M11: a clinician REVIEW of a returned lab result, append-only, per order.
--
-- A returned lab used to have no review state: `resultsPendingReview` filtered `results_received` and nothing moved
-- an order out of it. This adds:
--
-- (1) `order_result_review` — one APPEND-ONLY row per (order, observation) reviewed: who (membership + the discipline
--     they acted under), when (`reviewed_at` is the database clock; the app never supplies it) and WHICH result
--     (`observation_id` = the order's `last_lab_observation_attached_id` when it was reviewed). UNIQUE on
--     (org, order, observation) makes a double review a no-op. An AMENDED result is a new observation, so the order is
--     "unreviewed" again with no write at all: the queue is `results_received` AND no review row for the current
--     observation. Grants are SELECT + INSERT only and a trigger rejects UPDATE/DELETE.
-- (2) `order_record.results_last_received_at` — when the CURRENT observation arrived (the 24 h SLA clock), stamped by a
--     trigger whenever `last_lab_observation_attached_id` changes, so every writer (the M29 applier included) is
--     covered and no applier change is needed. `results_review_alerted_observation_id` is the sweep's once-per-
--     observation alert marker.
--
-- `order_record` is PARTITIONED (created_at): the ALTER propagates to leaves. `order_record_id`/`observation_id` are
-- plain uuids (no SQL FK; partitioned parent / M29 forward seam). RLS is the canonical app.org_id predicate, ENABLE +
-- FORCE.
ALTER TABLE "order_record" ADD COLUMN IF NOT EXISTS "results_last_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_record" ADD COLUMN IF NOT EXISTS "results_review_alerted_observation_id" uuid;--> statement-breakpoint

CREATE OR REPLACE FUNCTION m11_stamp_results_last_received() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_lab_observation_attached_id IS NOT NULL
     AND NEW.last_lab_observation_attached_id IS DISTINCT FROM OLD.last_lab_observation_attached_id THEN
    NEW.results_last_received_at := now();
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "trg_m11_stamp_results_last_received"
  BEFORE UPDATE OF last_lab_observation_attached_id ON order_record
  FOR EACH ROW EXECUTE FUNCTION m11_stamp_results_last_received();--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "order_result_review" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid,
  "location_id" uuid,
  "order_record_id" uuid NOT NULL,
  "observation_id" uuid NOT NULL,
  "reviewer_membership_id" uuid NOT NULL,
  "reviewer_discipline" text NOT NULL,
  "reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "order_result_review_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "order_result_review_provider_entity_id_provider_entity_id_fk"
    FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "order_result_review_location_id_location_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "order_result_review_discipline_chk" CHECK (char_length("reviewer_discipline") BETWEEN 1 AND 64),
  CONSTRAINT "order_result_review_once_per_observation"
    UNIQUE ("organization_id", "order_record_id", "observation_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_result_review_order_idx"
  ON "order_result_review" ("organization_id", "order_record_id", "reviewed_at");--> statement-breakpoint

ALTER TABLE "order_result_review" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_result_review" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "order_result_review_org" ON "order_result_review"
    FOR ALL TO chartwarden_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
GRANT SELECT, INSERT ON "order_result_review" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "order_result_review" TO chartwarden_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION order_result_review_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'order_result_review is append-only (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "trg_order_result_review_append_only"
  BEFORE UPDATE OR DELETE ON "order_result_review"
  FOR EACH ROW EXECUTE FUNCTION order_result_review_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_order_result_review() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'order_result_review.' || lower(TG_OP),
    'order_result_review',
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
ALTER FUNCTION audit_phi_write_order_result_review() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "trg_audit_order_result_review" AFTER INSERT OR UPDATE OR DELETE ON order_result_review
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_order_result_review();
