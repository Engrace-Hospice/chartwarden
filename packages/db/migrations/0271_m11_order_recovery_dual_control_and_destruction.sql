-- F-194 (#248) — M11: DUAL CONTROL for the attested lab-transmission recovery, and the destruction-role grants the
-- attestation table never got.
--
-- WHY. F-187/F-188's `POST /api/v1/orders/:id/recover-transmission` let ONE person attest `not_received_by_lab` — the
-- attestation that re-dispatches a lab order and, if it is wrong, orders the test TWICE at the lab. The evidence
-- (who at the lab, the lab's reference) is recorded and attributable but NOT verifiable, and the control was left
-- single-person because the repo had no second-approver primitive. It does: M3's break-glass (`bge_cosigner_distinct`,
-- migration 0210) is the same shape — a `cosign_pending` state, a `cosigned_by` column, a CHECK that the co-signer is
-- not the invoker, and the guards enforced in the UPDATE's WHERE so two co-signers racing cannot both win. This
-- migration gives the recovery the same, at rest:
--
-- (1) `order_recovery_request` — a PENDING recovery a first person files and a DIFFERENT person co-signs (or either
--     cancels, or the 24 h `expires_at` lapses). At most ONE pending request per order (partial UNIQUE index), the
--     co-signer can never be the requester (CHECK), the status and its resolution columns must agree (CHECK), and once
--     a request leaves `pending_cosign` it is immutable (trigger) — the request is the audit record of who asked, who
--     approved, and what evidence they gave. The lab-contact NAME is denylisted from the write-audit diff.
-- (2) `order_transmission_attestation` gains the co-signer (`cosigned_by_*`) and the request it executed
--     (`recovery_request_id`). A CHECK — NOT VALID, so the F-187/F-188 rows recorded under single control are exempt
--     and every NEW `not_received_by_lab` row is enforced — requires a co-signer DISTINCT from the attester. The ledger
--     itself now refuses a single-person re-dispatch, whatever code path writes it.
-- (3) DESTRUCTION. F-188's attestation table was never granted to the `wardenx_destruction` role (0157's pattern), so
--     erasing an order left its attestation rows behind — and its append-only trigger would have blocked the delete
--     even with the grant. Both new tables get 0157's grant + `<table>_destruction` org-scoped policy, and the
--     append-only trigger now admits a DELETE ONLY from a member of `wardenx_destruction` (the sanctioned erase path);
--     `wardenx_app` still cannot update or delete, and every other role is still refused.
--
-- `order_record_id` is a plain uuid with NO SQL FK on both tables (order_record is partitioned — the
-- `order_discontinuation` precedent). RLS is the canonical app.org_id predicate, ENABLE + FORCE (F-087).

-- ── (2) the ledger: co-signer + the request it executed ──────────────────────────────────────────────────────────
ALTER TABLE "order_transmission_attestation"
  ADD COLUMN IF NOT EXISTS "cosigned_by_membership_id" uuid,
  ADD COLUMN IF NOT EXISTS "cosigned_by_user_id" uuid,
  ADD COLUMN IF NOT EXISTS "recovery_request_id" uuid;--> statement-breakpoint

ALTER TABLE "order_transmission_attestation"
  ADD CONSTRAINT "order_transmission_attestation_cosigner_distinct_chk"
  CHECK ("cosigned_by_user_id" IS NULL OR "attested_by_user_id" IS NULL OR "cosigned_by_user_id" <> "attested_by_user_id");--> statement-breakpoint

-- NOT VALID: rows written before this migration (single control) are exempt; every INSERT after it is checked.
ALTER TABLE "order_transmission_attestation"
  ADD CONSTRAINT "order_transmission_attestation_dual_control_chk"
  CHECK (
    "attestation" <> 'not_received_by_lab'
    OR ("attested_by_user_id" IS NOT NULL AND "cosigned_by_user_id" IS NOT NULL AND "recovery_request_id" IS NOT NULL)
  ) NOT VALID;--> statement-breakpoint

-- ── (1) the pending recovery ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "order_recovery_request" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid,
  "location_id" uuid,
  "order_record_id" uuid NOT NULL,
  "attestation" text NOT NULL,
  "lab_contact_name" text NOT NULL,
  "lab_reference" text NOT NULL,
  "prior_failure_reason" text NOT NULL,
  "status" text DEFAULT 'pending_cosign' NOT NULL,
  "requested_by_membership_id" uuid,
  "requested_by_user_id" uuid NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "cosigned_by_membership_id" uuid,
  "cosigned_by_user_id" uuid,
  "cancelled_by_membership_id" uuid,
  "cancelled_by_user_id" uuid,
  "resolved_at" timestamp with time zone,
  "attestation_id" uuid,
  CONSTRAINT "order_recovery_request_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "order_recovery_request_provider_entity_id_provider_entity_id_fk"
    FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "order_recovery_request_location_id_location_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action,
  -- Only the duplicate-risk attestation needs a second person; `received_by_lab` sends nothing and stays single-person.
  CONSTRAINT "order_recovery_request_attestation_chk" CHECK ("attestation" = 'not_received_by_lab'),
  CONSTRAINT "order_recovery_request_status_chk"
    CHECK ("status" IN ('pending_cosign', 'executed', 'cancelled', 'expired')),
  CONSTRAINT "order_recovery_request_contact_chk"
    CHECK ("lab_contact_name" ~ '^[A-Za-z][A-Za-z .''-]{1,79}$'),
  CONSTRAINT "order_recovery_request_reference_chk"
    CHECK ("lab_reference" ~ '^[A-Za-z0-9][A-Za-z0-9._#/-]{2,63}$'),
  CONSTRAINT "order_recovery_request_expiry_chk" CHECK ("expires_at" > "requested_at"),
  -- The two-person control at rest (the `bge_cosigner_distinct` shape): the co-signer is never the requester.
  CONSTRAINT "order_recovery_request_cosigner_distinct_chk"
    CHECK ("cosigned_by_user_id" IS NULL OR "cosigned_by_user_id" <> "requested_by_user_id"),
  -- The status and what resolved it must agree.
  CONSTRAINT "order_recovery_request_status_agrees_chk" CHECK (
    ("status" = 'pending_cosign' AND "resolved_at" IS NULL AND "cosigned_by_user_id" IS NULL
       AND "cancelled_by_user_id" IS NULL AND "attestation_id" IS NULL)
    OR ("status" = 'executed' AND "resolved_at" IS NOT NULL AND "cosigned_by_user_id" IS NOT NULL
       AND "cancelled_by_user_id" IS NULL AND "attestation_id" IS NOT NULL)
    OR ("status" = 'cancelled' AND "resolved_at" IS NOT NULL AND "cosigned_by_user_id" IS NULL
       AND "cancelled_by_user_id" IS NOT NULL AND "attestation_id" IS NULL)
    OR ("status" = 'expired' AND "resolved_at" IS NOT NULL AND "cosigned_by_user_id" IS NULL
       AND "cancelled_by_user_id" IS NULL AND "attestation_id" IS NULL)
  )
);--> statement-breakpoint

-- At most ONE pending recovery per order — race-safe at the database (two first-callers cannot both file one).
CREATE UNIQUE INDEX IF NOT EXISTS "order_recovery_request_one_pending_uq"
  ON "order_recovery_request" ("organization_id", "order_record_id") WHERE "status" = 'pending_cosign';--> statement-breakpoint
-- The expiry sweep's read and the order detail's history read.
CREATE INDEX IF NOT EXISTS "order_recovery_request_pending_expiry_idx"
  ON "order_recovery_request" ("organization_id", "expires_at") WHERE "status" = 'pending_cosign';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_recovery_request_order_idx"
  ON "order_recovery_request" ("organization_id", "order_record_id", "requested_at");--> statement-breakpoint

ALTER TABLE "order_recovery_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_recovery_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "order_recovery_request_org" ON "order_recovery_request"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- The app files (INSERT), resolves (UPDATE status) and reads a request; it can never delete one.
GRANT SELECT, INSERT, UPDATE ON "order_recovery_request" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "order_recovery_request" TO wardenx_admin;--> statement-breakpoint

-- A request is the audit record of who asked, who approved and on what evidence: once it leaves `pending_cosign` it
-- is frozen, and while pending only its resolution columns may change. DELETE is the destruction path only.
CREATE OR REPLACE FUNCTION order_recovery_request_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only a NON-superuser member of the destruction role: a superuser is implicitly a member of every role.
    IF pg_has_role(current_user, 'wardenx_destruction', 'MEMBER')
       AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'order_recovery_request cannot be deleted (only the destruction role may erase it)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'pending_cosign' THEN
    RAISE EXCEPTION 'order_recovery_request is % and immutable', OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.order_record_id <> OLD.order_record_id
     OR NEW.attestation <> OLD.attestation
     OR NEW.lab_contact_name <> OLD.lab_contact_name
     OR NEW.lab_reference <> OLD.lab_reference
     OR NEW.prior_failure_reason <> OLD.prior_failure_reason
     OR NEW.requested_by_user_id <> OLD.requested_by_user_id
     OR NEW.requested_by_membership_id IS DISTINCT FROM OLD.requested_by_membership_id
     OR NEW.requested_at <> OLD.requested_at
     OR NEW.expires_at <> OLD.expires_at
     OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    RAISE EXCEPTION 'order_recovery_request evidence and requester are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_order_recovery_request_guard"
  BEFORE UPDATE OR DELETE ON "order_recovery_request"
  FOR EACH ROW EXECUTE FUNCTION order_recovery_request_guard();--> statement-breakpoint

-- M4 write-audit trigger (the order_transmission_attestation shape; the contact's NAME is denylisted).
CREATE OR REPLACE FUNCTION audit_phi_write_order_recovery_request() RETURNS trigger
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
    'order_recovery_request.' || lower(TG_OP),
    'order_recovery_request',
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
ALTER FUNCTION audit_phi_write_order_recovery_request() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_order_recovery_request" AFTER INSERT OR UPDATE OR DELETE ON order_recovery_request
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_order_recovery_request();--> statement-breakpoint

-- ── (3) DESTRUCTION: the attestation append-only trigger admits ONLY the sanctioned erase path ─────────────────
-- (0266's version rejected every UPDATE/DELETE from every role). `wardenx_app` holds no UPDATE/DELETE grant and is not
-- a member of the destruction role, so its posture is unchanged; an UPDATE is refused for everyone.
CREATE OR REPLACE FUNCTION order_transmission_attestation_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only a NON-superuser member of the destruction role: a superuser is implicitly a member of every role, and "not even a
  -- superuser can rewrite an attestation" is the guarantee 0266 gave.
  IF TG_OP = 'DELETE'
     AND pg_has_role(current_user, 'wardenx_destruction', 'MEMBER')
     AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'order_transmission_attestation is append-only (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint

-- 0157's pattern: SELECT + DELETE for the erase store (SELECT because the store `.returning()`s), plus a
-- `<table>_destruction` policy pinned to the canonical `app.org_id` so a destruction run can never reach across tenants.
GRANT SELECT, DELETE ON "order_transmission_attestation" TO wardenx_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "order_recovery_request" TO wardenx_destruction;--> statement-breakpoint

DROP POLICY IF EXISTS "order_transmission_attestation_destruction" ON "order_transmission_attestation";--> statement-breakpoint
CREATE POLICY "order_transmission_attestation_destruction" ON "order_transmission_attestation"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "order_recovery_request_destruction" ON "order_recovery_request";--> statement-breakpoint
CREATE POLICY "order_recovery_request_destruction" ON "order_recovery_request"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
