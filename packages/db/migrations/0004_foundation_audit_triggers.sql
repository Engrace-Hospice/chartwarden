-- M1 Foundation §3.9 — baseline write-audit triggers on the org-scoped foundation
-- tables (the phi-guards fitness gate requires every org-scoped table to carry both
-- an RLS policy and a write-audit trigger). Per M04 spec §3.3 / line 661, per-table
-- audit triggers are installed *in the migration that enables a table's RLS*, the
-- same way each module calls M1's RLS generator. M1 owns audit_event, so it ships a
-- baseline capture trigger for its own tables here. M4 later supersedes this with the
-- full generator (column-level diffing, denylist scrubbing, the wardenx_audit_writer
-- role ownership, INSERT-only policy — M04-F06); this foundation version captures the
-- before/after row image with no scrubbing.
--
-- SECURITY DEFINER: the function is owned by the migration role (admin), which is the
-- audit_event table owner and therefore bypasses RLS — so wardenx_app can never write
-- audit_event directly (it has no INSERT policy), only the trigger can. The function
-- keys org-context ONLY on the canonical app.org_id var (ADR-0010 D2).

CREATE OR REPLACE FUNCTION wardenx_audit_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_org uuid;
  v_rid uuid;
BEGIN
  -- Recursion guard + hot-path skip list: the append-only audit log must never audit
  -- itself, and the high-churn transactional-mechanism tables (idempotency cache,
  -- outbox queue) would flood the trail. The trigger is still attached to them (the
  -- fitness gate asserts presence) but is a no-op for these names.
  -- NOTE: audit_event is RANGE-partitioned by month, so a write routes to a dated child
  -- (e.g. audit_event_2026_06) and the trigger fires with TG_TABLE_NAME = that PARTITION.
  -- The guard MUST match the partition prefix, not just the parent — else every audited
  -- write recurses (audit insert -> partition trigger -> audit insert -> ...) and dies with
  -- "stack depth limit exceeded". (Caught by the live-PG test; see rls-isolation.live.test.ts.)
  IF TG_TABLE_NAME LIKE 'audit_event%'
     OR TG_TABLE_NAME = ANY (ARRAY['idempotency_key', 'outbox_event']) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_before := to_jsonb(OLD); v_after := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := to_jsonb(OLD); v_after := to_jsonb(NEW);
  ELSE
    v_before := NULL; v_after := to_jsonb(NEW);
  END IF;

  -- The organization itself is its own org scope; other tables carry organization_id
  -- (or are scoped via a parent — fall back to the session var).
  IF TG_TABLE_NAME = 'organization' THEN
    v_org := COALESCE(v_after->>'id', v_before->>'id')::uuid;
  ELSE
    v_org := NULLIF(COALESCE(v_after->>'organization_id', v_before->>'organization_id'), '')::uuid;
  END IF;
  IF v_org IS NULL THEN
    v_org := NULLIF(current_setting('app.org_id', true), '')::uuid;
  END IF;

  v_rid := NULLIF(COALESCE(v_after->>'id', v_before->>'id'), '')::uuid;

  INSERT INTO audit_event (
    organization_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, retention_class
  ) VALUES (
    v_org, 'system', TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME, v_rid,
    'db-trigger', 'success', 'info', v_before, v_after, 'compliance'
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint

-- Attach the trigger to every org-scoped foundation table. The table name in the ON
-- clause is intentionally unquoted (these identifiers are all lowercase / non-reserved)
-- so the shape reads as the conventional `... ON <table> ...`. audit_event +
-- audit_event_default get it too (no-op via the guard) so the append-only log keeps a
-- consistent shape across the partition set.
CREATE TRIGGER "organization_audit" AFTER INSERT OR UPDATE OR DELETE ON organization
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "provider_entity_audit" AFTER INSERT OR UPDATE OR DELETE ON provider_entity
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "location_audit" AFTER INSERT OR UPDATE OR DELETE ON location
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "membership_audit" AFTER INSERT OR UPDATE OR DELETE ON membership
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "account_audit" AFTER INSERT OR UPDATE OR DELETE ON account
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "session_audit" AFTER INSERT OR UPDATE OR DELETE ON session
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "system_status_audit" AFTER INSERT OR UPDATE OR DELETE ON system_status
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "feature_flag_audit" AFTER INSERT OR UPDATE OR DELETE ON feature_flag
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "organization_settings_registry_audit" AFTER INSERT OR UPDATE OR DELETE ON organization_settings_registry
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
-- Attached but no-op (recursion guard / hot-path skip — see function body).
CREATE TRIGGER "idempotency_key_audit" AFTER INSERT OR UPDATE OR DELETE ON idempotency_key
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "outbox_event_audit" AFTER INSERT OR UPDATE OR DELETE ON outbox_event
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "audit_event_audit" AFTER INSERT OR UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "audit_event_default_audit" AFTER INSERT OR UPDATE OR DELETE ON audit_event_default
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
