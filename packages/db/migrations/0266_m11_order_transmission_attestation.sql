-- F-188 (#248) — M11: a proper home for the operator's ATTESTATION, and an attempt identity on the order.
--
-- F-187's attested recovery (`POST /api/v1/orders/:id/recover-transmission`) had two placeholders because it
-- shipped without a migration:
--   (a) the attestation lived in `order_record.transmission_failure_reason` (`recovery_attested:<enum>:<uuid>`) —
--       the only column whose write-audit diff survived — which left a stale marker on a `transmitted` order after
--       `received_by_lab`, and recorded NOTHING about what the operator actually established with the lab;
--   (b) nothing bound a `m29.lab_order.dispatch_refused` to the attempt it refused, so a refusal redelivered AFTER an
--       operator resend flipped the order `failed` again.
--
-- (1) `order_transmission_attestation` — one APPEND-ONLY row per attested recovery: what was attested
--     (`not_received_by_lab` / `received_by_lab`), the STRUCTURED evidence (who at the lab was contacted + the lab's
--     own reference), what the order's failure reason was when it was attested, what the system then did, the
--     attempt it started (NULL for `received_by_lab`) and who attested. The evidence columns are constrained to
--     shapes that cannot carry a patient identifier by construction: a contact name is letters/space/`.'-` only (no
--     digits), a reference is `[A-Za-z0-9._#/-]` only (no spaces, so no names). Grants are SELECT + INSERT only and a
--     trigger rejects UPDATE/DELETE, so an attestation can never be edited or removed after the fact.
-- (2) `order_record.transmission_attempt_id` — the id of the CURRENT outbound attempt (set in the same transaction
--     as every `m11.order.hl7_orm_requested`: sign, F-182 resend, F-187/F-188 recovery). The applier applies a
--     `dispatch_refused` only when the refusal names the order's current attempt. Nullable and additive: existing
--     rows and pre-migration in-flight events (which carry no attempt id) behave exactly as before.
--
-- `order_record` is PARTITIONED BY RANGE (created_at): the ALTER propagates to every leaf (0131 precedent).
-- `order_record_id` on the new table is a plain uuid with NO SQL FK (partitioned parent; the
-- `order_discontinuation` precedent). RLS is the canonical app.org_id predicate, ENABLE + FORCE (F-087).
ALTER TABLE "order_record" ADD COLUMN IF NOT EXISTS "transmission_attempt_id" uuid;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "order_transmission_attestation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid,
  "location_id" uuid,
  "order_record_id" uuid NOT NULL,
  "attestation" text NOT NULL,
  "outcome" text NOT NULL,
  "lab_contact_name" text NOT NULL,
  "lab_reference" text NOT NULL,
  "prior_failure_reason" text NOT NULL,
  "attempt_id" uuid,
  "attested_by_membership_id" uuid,
  "attested_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "order_transmission_attestation_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "order_transmission_attestation_provider_entity_id_provider_entity_id_fk"
    FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "order_transmission_attestation_location_id_location_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action,
  -- `attested_by_membership_id` / `attested_by_user_id` are LOGICAL refs (no FK): the user id is the same Better Auth
  -- id the write-audit trigger records as the actor, and neither is a reason to block recording an attestation.
  CONSTRAINT "order_transmission_attestation_attestation_chk"
    CHECK ("attestation" IN ('not_received_by_lab', 'received_by_lab')),
  CONSTRAINT "order_transmission_attestation_outcome_chk"
    CHECK ("outcome" IN ('redispatched', 'marked_transmitted')),
  -- The attestation and what the system did about it must agree: a re-dispatch starts an attempt, a
  -- mark-transmitted does not.
  CONSTRAINT "order_transmission_attestation_outcome_agrees_chk" CHECK (
    ("attestation" = 'not_received_by_lab' AND "outcome" = 'redispatched' AND "attempt_id" IS NOT NULL)
    OR ("attestation" = 'received_by_lab' AND "outcome" = 'marked_transmitted' AND "attempt_id" IS NULL)
  ),
  -- Evidence shapes that cannot carry a patient identifier: a contact NAME has no digits; a lab REFERENCE has no
  -- spaces (so no free-text names) and is length-bounded.
  CONSTRAINT "order_transmission_attestation_contact_chk"
    CHECK ("lab_contact_name" ~ '^[A-Za-z][A-Za-z .''-]{1,79}$'),
  CONSTRAINT "order_transmission_attestation_reference_chk"
    CHECK ("lab_reference" ~ '^[A-Za-z0-9][A-Za-z0-9._#/-]{2,63}$')
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "order_transmission_attestation_order_idx"
  ON "order_transmission_attestation" ("organization_id", "order_record_id", "created_at");--> statement-breakpoint

ALTER TABLE "order_transmission_attestation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_transmission_attestation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "order_transmission_attestation_org" ON "order_transmission_attestation"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- APPEND-ONLY: no UPDATE, no DELETE for the app role (order_signature posture, 0037) ...
GRANT SELECT, INSERT ON "order_transmission_attestation" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "order_transmission_attestation" TO wardenx_admin;--> statement-breakpoint

-- ... and a trigger so no role that DOES hold the privilege (the owner, an admin session) can rewrite history either.
CREATE OR REPLACE FUNCTION order_transmission_attestation_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'order_transmission_attestation is append-only (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_order_transmission_attestation_append_only"
  BEFORE UPDATE OR DELETE ON "order_transmission_attestation"
  FOR EACH ROW EXECUTE FUNCTION order_transmission_attestation_append_only();--> statement-breakpoint

-- M4 write-audit trigger (the order_discontinuation shape). The contact's NAME is denylisted so it never lands in
-- the audit diff; the row itself is the evidence record.
CREATE OR REPLACE FUNCTION audit_phi_write_order_transmission_attestation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['lab_contact_name']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['lab_contact_name']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'order_transmission_attestation.' || lower(TG_OP),
    'order_transmission_attestation',
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
ALTER FUNCTION audit_phi_write_order_transmission_attestation() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_order_transmission_attestation" AFTER INSERT OR UPDATE OR DELETE ON order_transmission_attestation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_order_transmission_attestation();
