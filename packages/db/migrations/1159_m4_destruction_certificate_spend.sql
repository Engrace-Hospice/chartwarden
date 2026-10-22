-- M36 WP 5.6 (ADR-0086, PROPOSED) - the message destruction executor spends an APPROVED certificate's count without touching it.
--   * record_count is what the approver approved. Once the certificate leaves `pending` the guard trigger refuses any change to it, with exactly one
--     positive carve-out: M4's own audit sweep records the ACTUAL erased count while it moves an `audit_event.*` certificate from `approved` to
--     executed / partial_refused / held (same data_class). It also refuses a change of data_class and a return to `pending` after that point.
--   * Spending is tracked beside it in destroyed_count (committed deletions, only ever goes up) and reserved_count (planned, not yet settled).
--     Those two columns are written ONLY through the SECURITY DEFINER functions below (owned by chartwarden_admin; the app role's table-wide UPDATE
--     is replaced by a column-level grant that leaves them out), and the functions enforce the tenant (app.org_id), the `message.*` class, the
--     approved status and the ceiling. A batch RESERVES its planned count in its plan transaction (the executor holds a row lock on the
--     certificate, so a second executor waits and then sees the reduced remainder), deletes, then SETTLES: reserved goes down by the plan, destroyed
--     up by what was really deleted, the difference refunded. A crash after the reserve can only UNDER-delete. remaining =
--     record_count - destroyed_count - reserved_count, and a CHECK keeps destroyed + reserved within the approved figure.
--   * message_destruction_batch: one row per reserved batch (the planned message ids, ids only). It is written ONLY by the same definer
--     functions: RESERVE inserts it (and refuses ids another unsettled batch already holds), SETTLE takes the batch id, locks that row, requires it
--     to be `reserved`, takes the reserved amount from the batch's OWN planned_count and flips it once (settled / reconciled), so a settle can never
--     be replayed, aimed at the wrong batch, or given an invented amount. A reservation stranded by a crash is reconciled through the same SETTLE:
--     ids already gone count as destroyed, the rest are refunded. The app role can only read the table; a guard trigger keeps state monotonic.
--   * The destruction credential may SELECT only the columns it needs from the certificate (org-pinned) so its delete transaction can re-check that
--     the certificate is still approved and fresh; it can write nothing here.
ALTER TABLE "destruction_certificate"
  ADD COLUMN "destroyed_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "reserved_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "destruction_certificate"
  ADD CONSTRAINT "destruction_certificate_spend_nonneg" CHECK ("destroyed_count" >= 0 AND "reserved_count" >= 0),
  ADD CONSTRAINT "destruction_certificate_spend_within_approved" CHECK ("destroyed_count" + "reserved_count" <= "record_count");--> statement-breakpoint

CREATE OR REPLACE FUNCTION destruction_certificate_count_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    IF NEW.status = 'pending' THEN
      RAISE EXCEPTION 'destruction_certificate_count: a certificate cannot return to pending' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.data_class IS DISTINCT FROM OLD.data_class THEN
      RAISE EXCEPTION 'destruction_certificate_count: the data class cannot change once the certificate leaves pending' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.record_count IS DISTINCT FROM OLD.record_count
       AND NOT (OLD.status = 'approved' AND NEW.status IN ('executed', 'partial_refused', 'held')
                AND OLD.data_class LIKE 'audit_event.%' AND NEW.data_class = OLD.data_class) THEN
      RAISE EXCEPTION 'destruction_certificate_count: the approved count cannot change once the certificate leaves pending' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.status = 'pending' AND NEW.status <> 'pending' AND OLD.data_class LIKE 'message.%'
     AND NEW.record_count IS DISTINCT FROM OLD.record_count THEN
    RAISE EXCEPTION 'destruction_certificate_count: the approved count cannot change on the way out of pending' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.destroyed_count < OLD.destroyed_count THEN
    RAISE EXCEPTION 'destruction_certificate_count: destroyed_count only goes up' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_destruction_certificate_count_guard"
  BEFORE UPDATE ON "destruction_certificate"
  FOR EACH ROW EXECUTE FUNCTION destruction_certificate_count_guard();--> statement-breakpoint

-- The app role keeps exactly the columns M4 / M34 / the executor's close step write; the spend columns, data_class and the rest are not among them.
-- (DELETE is revoked too: nothing in the repository deletes a certificate through the app role; the destruction credential never did.)
REVOKE UPDATE, DELETE ON "destruction_certificate" FROM chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("status", "approved_by", "executed_at", "record_count", "refusal_reason", "refused_rows_by_module", "dek_destroyed_at", "certificate_pdf_ref")
  ON "destruction_certificate" TO chartwarden_app;--> statement-breakpoint

-- The definer functions run as chartwarden_admin, which is subject to RLS on this table: its own policy (the functions pin the tenant themselves).
CREATE POLICY "destruction_certificate_admin_spend" ON "destruction_certificate"
  FOR ALL TO chartwarden_admin USING (true) WITH CHECK (true);--> statement-breakpoint

CREATE TABLE "message_destruction_batch" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "certificate_id" uuid NOT NULL,
  "planned_message_ids" uuid[] NOT NULL,
  "planned_count" integer NOT NULL,
  "state" text DEFAULT 'reserved' NOT NULL,
  "reserved_at" timestamptz DEFAULT now() NOT NULL,
  "settled_at" timestamptz,
  "destroyed_count" integer,
  CONSTRAINT "message_destruction_batch_state" CHECK ("state" IN ('reserved', 'settled', 'reconciled')),
  CONSTRAINT "message_destruction_batch_planned" CHECK ("planned_count" > 0 AND "planned_count" = cardinality("planned_message_ids")),
  CONSTRAINT "message_destruction_batch_settled_shape" CHECK (
    ("state" = 'reserved' AND "settled_at" IS NULL AND "destroyed_count" IS NULL)
    OR ("state" <> 'reserved' AND "settled_at" IS NOT NULL AND "destroyed_count" BETWEEN 0 AND "planned_count"))
);--> statement-breakpoint
CREATE INDEX "message_destruction_batch_cert_idx" ON "message_destruction_batch" ("organization_id", "certificate_id", "state");--> statement-breakpoint
CREATE INDEX "message_destruction_batch_stranded_idx" ON "message_destruction_batch" ("organization_id", "reserved_at") WHERE "state" = 'reserved';--> statement-breakpoint
CREATE INDEX "message_destruction_batch_reserved_ids_idx" ON "message_destruction_batch" USING gin ("planned_message_ids") WHERE "state" = 'reserved';--> statement-breakpoint
ALTER TABLE "message_destruction_batch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_destruction_batch" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_destruction_batch_org_isolation" ON "message_destruction_batch"
  FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_destruction_batch_admin" ON "message_destruction_batch"
  FOR ALL TO chartwarden_admin USING (true) WITH CHECK (true);--> statement-breakpoint
-- Read-only for the app role: every write goes through the definer functions (owned by chartwarden_admin) below.
REVOKE ALL ON "message_destruction_batch" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON "message_destruction_batch" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "message_destruction_batch" TO chartwarden_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_destruction_batch_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.state <> 'reserved' THEN
    RAISE EXCEPTION 'message_destruction_batch: a settled batch cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.certificate_id IS DISTINCT FROM OLD.certificate_id
     OR NEW.planned_message_ids IS DISTINCT FROM OLD.planned_message_ids
     OR NEW.planned_count IS DISTINCT FROM OLD.planned_count OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at THEN
    RAISE EXCEPTION 'message_destruction_batch: the plan cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_destruction_batch_guard"
  BEFORE UPDATE ON "message_destruction_batch"
  FOR EACH ROW EXECUTE FUNCTION message_destruction_batch_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION destruction_certificate_reserve(p_org uuid, p_id uuid, p_batch uuid, p_ids uuid[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_count integer := cardinality(p_ids);
BEGIN
  IF v_count IS NULL OR v_count <= 0 OR p_batch IS NULL THEN
    RAISE EXCEPTION 'destruction_certificate_reserve: a batch needs at least one message id' USING ERRCODE = 'check_violation';
  END IF;
  IF p_org IS DISTINCT FROM nullif(current_setting('app.org_id', true), '')::uuid THEN
    RAISE EXCEPTION 'destruction_certificate_reserve: not this tenant''s certificate' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A message another unsettled batch has planned is not planned twice (its delete may still be in flight).
  IF EXISTS (SELECT 1 FROM public.message_destruction_batch b
              WHERE b.organization_id = p_org AND b.state = 'reserved' AND b.planned_message_ids && p_ids) THEN
    RETURN false;
  END IF;
  UPDATE public.destruction_certificate
     SET reserved_count = reserved_count + v_count
   WHERE id = p_id AND organization_id = p_org AND status = 'approved' AND data_class LIKE 'message.%'
     AND record_count - destroyed_count - reserved_count >= v_count;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.message_destruction_batch (id, organization_id, certificate_id, planned_message_ids, planned_count)
  VALUES (p_batch, p_org, p_id, p_ids, v_count);
  RETURN true;
END $$;--> statement-breakpoint
-- Settle ONE batch: the reserved amount is the batch's own planned_count (never a caller figure), the batch must be `reserved` and is flipped
-- exactly once, and a reservation that would go negative is an error, not a clamp. p_state is 'settled' (the executor) or 'reconciled'.
CREATE OR REPLACE FUNCTION destruction_certificate_settle(p_org uuid, p_batch uuid, p_destroyed integer, p_state text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_batch public.message_destruction_batch%ROWTYPE; v_left integer;
BEGIN
  IF p_org IS DISTINCT FROM nullif(current_setting('app.org_id', true), '')::uuid THEN
    RAISE EXCEPTION 'destruction_certificate_settle: not this tenant''s batch' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_state NOT IN ('settled', 'reconciled') THEN
    RAISE EXCEPTION 'destruction_certificate_settle: unknown target state' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_batch FROM public.message_destruction_batch
   WHERE id = p_batch AND organization_id = p_org AND state = 'reserved' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'destruction_certificate_settle: no reserved batch %', p_batch USING ERRCODE = 'no_data_found';
  END IF;
  IF p_destroyed IS NULL OR p_destroyed < 0 OR p_destroyed > v_batch.planned_count THEN
    RAISE EXCEPTION 'destruction_certificate_settle: destroyed must be within the planned batch' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.destruction_certificate
     SET reserved_count = reserved_count - v_batch.planned_count, destroyed_count = destroyed_count + p_destroyed
   WHERE id = v_batch.certificate_id AND organization_id = p_org AND data_class LIKE 'message.%'
     AND reserved_count >= v_batch.planned_count
  RETURNING greatest(record_count - destroyed_count - reserved_count, 0) INTO v_left;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'destruction_certificate_settle: the certificate does not hold this reservation' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.message_destruction_batch
     SET state = p_state, settled_at = now(), destroyed_count = p_destroyed
   WHERE id = p_batch;
  RETURN v_left;
END $$;--> statement-breakpoint
ALTER FUNCTION destruction_certificate_reserve(uuid, uuid, uuid, uuid[]) OWNER TO chartwarden_admin;--> statement-breakpoint
ALTER FUNCTION destruction_certificate_settle(uuid, uuid, integer, text) OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION destruction_certificate_reserve(uuid, uuid, uuid, uuid[]) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION destruction_certificate_settle(uuid, uuid, integer, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION destruction_certificate_reserve(uuid, uuid, uuid, uuid[]) TO chartwarden_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION destruction_certificate_settle(uuid, uuid, integer, text) TO chartwarden_app;--> statement-breakpoint

GRANT SELECT ("id", "organization_id", "status", "data_class", "created_at", "record_count", "destroyed_count", "reserved_count")
  ON "destruction_certificate" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "destruction_certificate_destruction_read" ON "destruction_certificate"
  FOR SELECT TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- The 1107 PHI audit pattern (ids only: no patient column, nothing to scrub).
CREATE OR REPLACE FUNCTION audit_phi_write_message_destruction_batch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD) - 'planned_message_ids', ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW) - 'planned_message_ids', ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'message_destruction_batch.' || lower(TG_OP), 'message_destruction_batch',
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
ALTER FUNCTION audit_phi_write_message_destruction_batch() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_destruction_batch"
  AFTER INSERT OR UPDATE OR DELETE ON message_destruction_batch
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_destruction_batch();
