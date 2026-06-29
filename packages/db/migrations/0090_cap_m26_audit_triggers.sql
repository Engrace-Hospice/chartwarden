-- M26 Cap Management §3.6 — M4 write-audit triggers (the M23 0079 / M25 0084 / M27 0072 generator shape) on
-- every owned table. The §3.6 spec narrative denylisted the append-only line/snapshot tables, but the
-- architecture-fitness PHI-guards gate (check-fitness-gaps.ts) requires an audit trigger on EVERY org-scoped
-- table — the gate wins (architecture/convention over the spec proposal), so all 11 tenant tables are
-- audited (the append-only ones fire only on INSERT in practice, UPDATE/DELETE being revoked from
-- wardenx_app). cap_period_platform_constant (no organization_id) is audited too (D3: the most consequential
-- write in M26) with NULL org + cap_year carried in context.
--
-- Each audit_phi_write_<table>() is the canonical M4 shape: SECURITY DEFINER, SET search_path = pg_catalog,
-- public; OWNER wardenx_audit_writer; org keyed on COALESCE(NEW.organization_id, OLD.organization_id);
-- free-text columns scrubbed via audit_scrub(to_jsonb(...), ARRAY[...]); retention_class 'compliance'
-- (cost-report material, 7-year floor per 42 CFR §418.104(d)). No MBI value is ever captured (D13). The
-- three LIST(cap_period_id)-partitioned parents get the trigger on the PARENT (propagates to leaves, PG11+).

-- cap_period (scrub notes)
CREATE OR REPLACE FUNCTION audit_phi_write_cap_period() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['notes'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'cap_period.' || lower(TG_OP), 'cap_period', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_cap_period() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_cap_period" AFTER INSERT OR UPDATE OR DELETE ON cap_period FOR EACH ROW EXECUTE FUNCTION audit_phi_write_cap_period();--> statement-breakpoint

-- cap_period_methodology_lock (scrub reason)
CREATE OR REPLACE FUNCTION audit_phi_write_cap_period_methodology_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['reason'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'cap_period_methodology_lock.' || lower(TG_OP), 'cap_period_methodology_lock', COALESCE(NEW.cap_period_id, OLD.cap_period_id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_cap_period_methodology_lock() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_cap_period_methodology_lock" AFTER INSERT OR UPDATE OR DELETE ON cap_period_methodology_lock FOR EACH ROW EXECUTE FUNCTION audit_phi_write_cap_period_methodology_lock();--> statement-breakpoint

-- cap_beneficiary_accrual
CREATE OR REPLACE FUNCTION audit_phi_write_cap_beneficiary_accrual() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'cap_beneficiary_accrual.' || lower(TG_OP), 'cap_beneficiary_accrual', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_cap_beneficiary_accrual() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_cap_beneficiary_accrual" AFTER INSERT OR UPDATE OR DELETE ON cap_beneficiary_accrual FOR EACH ROW EXECUTE FUNCTION audit_phi_write_cap_beneficiary_accrual();--> statement-breakpoint

-- cap_beneficiary_accrual_line (partitioned parent; scrub reason)
CREATE OR REPLACE FUNCTION audit_phi_write_cap_beneficiary_accrual_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['reason'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'cap_beneficiary_accrual_line.' || lower(TG_OP), 'cap_beneficiary_accrual_line', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_cap_beneficiary_accrual_line() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_cap_beneficiary_accrual_line" AFTER INSERT OR UPDATE OR DELETE ON cap_beneficiary_accrual_line FOR EACH ROW EXECUTE FUNCTION audit_phi_write_cap_beneficiary_accrual_line();--> statement-breakpoint

-- cap_inpatient_accrual
CREATE OR REPLACE FUNCTION audit_phi_write_cap_inpatient_accrual() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'cap_inpatient_accrual.' || lower(TG_OP), 'cap_inpatient_accrual', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_cap_inpatient_accrual() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_cap_inpatient_accrual" AFTER INSERT OR UPDATE OR DELETE ON cap_inpatient_accrual FOR EACH ROW EXECUTE FUNCTION audit_phi_write_cap_inpatient_accrual();--> statement-breakpoint

-- cap_inpatient_day_line (partitioned parent)
CREATE OR REPLACE FUNCTION audit_phi_write_cap_inpatient_day_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'cap_inpatient_day_line.' || lower(TG_OP), 'cap_inpatient_day_line', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_cap_inpatient_day_line() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_cap_inpatient_day_line" AFTER INSERT OR UPDATE OR DELETE ON cap_inpatient_day_line FOR EACH ROW EXECUTE FUNCTION audit_phi_write_cap_inpatient_day_line();--> statement-breakpoint

-- cap_projection_snapshot (partitioned parent)
CREATE OR REPLACE FUNCTION audit_phi_write_cap_projection_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'cap_projection_snapshot.' || lower(TG_OP), 'cap_projection_snapshot', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_cap_projection_snapshot() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_cap_projection_snapshot" AFTER INSERT OR UPDATE OR DELETE ON cap_projection_snapshot FOR EACH ROW EXECUTE FUNCTION audit_phi_write_cap_projection_snapshot();--> statement-breakpoint

-- cap_threshold_event (scrub notes)
CREATE OR REPLACE FUNCTION audit_phi_write_cap_threshold_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['notes'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'cap_threshold_event.' || lower(TG_OP), 'cap_threshold_event', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_cap_threshold_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_cap_threshold_event" AFTER INSERT OR UPDATE OR DELETE ON cap_threshold_event FOR EACH ROW EXECUTE FUNCTION audit_phi_write_cap_threshold_event();--> statement-breakpoint

-- cap_psr_import (scrub parse_error)
CREATE OR REPLACE FUNCTION audit_phi_write_cap_psr_import() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['parse_error'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'cap_psr_import.' || lower(TG_OP), 'cap_psr_import', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_cap_psr_import() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_cap_psr_import" AFTER INSERT OR UPDATE OR DELETE ON cap_psr_import FOR EACH ROW EXECUTE FUNCTION audit_phi_write_cap_psr_import();--> statement-breakpoint

-- cap_psr_reconciliation (scrub resolution_notes)
CREATE OR REPLACE FUNCTION audit_phi_write_cap_psr_reconciliation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['resolution_notes'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'cap_psr_reconciliation.' || lower(TG_OP), 'cap_psr_reconciliation', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_cap_psr_reconciliation() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_cap_psr_reconciliation" AFTER INSERT OR UPDATE OR DELETE ON cap_psr_reconciliation FOR EACH ROW EXECUTE FUNCTION audit_phi_write_cap_psr_reconciliation();--> statement-breakpoint

-- cap_settlement (scrub notes)
CREATE OR REPLACE FUNCTION audit_phi_write_cap_settlement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['notes'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'cap_settlement.' || lower(TG_OP), 'cap_settlement', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_cap_settlement() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_cap_settlement" AFTER INSERT OR UPDATE OR DELETE ON cap_settlement FOR EACH ROW EXECUTE FUNCTION audit_phi_write_cap_settlement();--> statement-breakpoint

-- cap_period_platform_constant (PLATFORM-scoped; NULL org + cap_year in context; D3 most-consequential write)
CREATE OR REPLACE FUNCTION audit_phi_write_cap_period_platform_constant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (NULL, NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'cap_period_platform_constant.' || lower(TG_OP), 'cap_period_platform_constant', NULL, COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'warn', v_before, v_after, jsonb_build_object('cap_year', COALESCE(NEW.cap_year, OLD.cap_year)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_cap_period_platform_constant() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_cap_period_platform_constant" AFTER INSERT OR UPDATE OR DELETE ON cap_period_platform_constant FOR EACH ROW EXECUTE FUNCTION audit_phi_write_cap_period_platform_constant();
