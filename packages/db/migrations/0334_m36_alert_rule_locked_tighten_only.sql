-- M36 GAP-102 — a tenant may only TIGHTEN a system_locked platform alert rule.
--
-- Spec §7.4 (alert-rule integrity): a `system_locked` rule cannot be disabled or have its
-- `recipient_resolver` changed; §1 / D11: tenants may tighten routing (raise severity, add channels)
-- but never loosen it (downgrade severity, drop channels, remove recipients).
--
-- Before this, the clone-on-first-edit INSERT policy (alert_rule_write, 0017) checked only the org id, so
-- a tenant admin could INSERT an org-scoped row for `field_safety.sos` / `noe.late_risk` /
-- `system.backup_failure` with a lower severity floor or a different resolver (and, as a plain INSERT,
-- with system_locked=false), and the alert emitter would use it instead of the platform rule. The UPDATE
-- policy additionally required system_locked=false, so a legitimately cloned (locked) override could
-- never be edited again.
--
-- Fix: (1) a BEFORE INSERT/UPDATE trigger rejects any org-scoped row whose event_type has a locked
-- platform rule unless it keeps the lock, stays enabled, keeps the platform resolver + resolver_args,
-- does not lower severity_floor (enum order info < warn < critical) and keeps every platform channel
-- (a NULL channels_override is weaker than a platform list); an org row must never carry the lock for an
-- event type whose platform rule is not locked. (2) the UPDATE policy no longer requires
-- system_locked=false — the trigger is now the guard, which is what makes a tightening re-edit possible.
-- Existing org rows are not rewritten; the emitter independently ignores any weaker legacy row.

CREATE OR REPLACE FUNCTION enforce_alert_rule_locked_tighten_only()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  floor_row alert_rule%ROWTYPE;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RETURN NEW; -- platform rows are seeded by the boot slice, not tenant-written
  END IF;

  SELECT * INTO floor_row FROM alert_rule
   WHERE organization_id IS NULL AND event_type = NEW.event_type AND system_locked = true
   LIMIT 1;

  IF NOT FOUND THEN
    IF NEW.system_locked THEN
      RAISE EXCEPTION 'alert_rule: a tenant row for % cannot carry system_locked (no locked platform rule)', NEW.event_type
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.system_locked IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'alert_rule: % is system_locked; a tenant row must keep the lock', NEW.event_type
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'alert_rule: system_locked rule % cannot be disabled', NEW.event_type
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.recipient_resolver IS DISTINCT FROM floor_row.recipient_resolver
     OR NEW.resolver_args IS DISTINCT FROM floor_row.resolver_args THEN
    RAISE EXCEPTION 'alert_rule: system_locked rule % cannot change its recipient resolver', NEW.event_type
      USING ERRCODE = 'check_violation';
  END IF;
  -- Enum comparison (definition order info < warn < critical) — no ::text casts (cf. M36-F06c).
  IF NEW.severity_floor < floor_row.severity_floor THEN
    RAISE EXCEPTION 'alert_rule: system_locked rule % cannot be downgraded below %', NEW.event_type, floor_row.severity_floor
      USING ERRCODE = 'check_violation';
  END IF;
  IF floor_row.channels_override IS NOT NULL
     AND (NEW.channels_override IS NULL OR NOT (NEW.channels_override @> floor_row.channels_override)) THEN
    RAISE EXCEPTION 'alert_rule: system_locked rule % cannot drop a platform channel', NEW.event_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_alert_rule_locked_tighten_only ON alert_rule;--> statement-breakpoint
CREATE TRIGGER trg_alert_rule_locked_tighten_only
  BEFORE INSERT OR UPDATE ON alert_rule
  FOR EACH ROW EXECUTE FUNCTION enforce_alert_rule_locked_tighten_only();--> statement-breakpoint

DROP POLICY IF EXISTS alert_rule_update ON alert_rule;--> statement-breakpoint
CREATE POLICY alert_rule_update ON alert_rule
  FOR UPDATE TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
