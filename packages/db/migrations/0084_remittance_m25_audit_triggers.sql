-- M25 Remittance & Denials §3.6 — M4 write-audit triggers (the M23 0079 / M27 0072 generator shape) on
-- every owned table + appeal_case closed-row immutability (§2.2: once a tier is closed the row is frozen).
--
-- Each audit_phi_write_<table>() is the canonical M4 shape: SECURITY DEFINER, SET search_path =
-- pg_catalog, public; OWNER wardenx_audit_writer; org keyed on COALESCE(NEW.organization_id,
-- OLD.organization_id); value-capture scrubbed via audit_scrub(to_jsonb(...), ARRAY[...]) per the §3.6
-- denylist; retention_class 'compliance' (835/remit/denial/appeal are billing-substantiating, 7-year).
-- The four partitioned parents get the trigger on the PARENT (propagates to every partition, PG11+).
--
-- §3.6 denylist (value not captured — replaced by the audit_scrub marker):
--   remittance_remark.free_text · denial_case.override_payload · denial_case_assignment.reason ·
--   appeal_case.appeal_narrative · appeal_case_event.event_payload. No MBI is ever a column (D13).

-- ============================================================================================
-- remittance_advice
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_remittance_advice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'remittance_advice.' || lower(TG_OP), 'remittance_advice', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_remittance_advice() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_remittance_advice" AFTER INSERT OR UPDATE OR DELETE ON remittance_advice FOR EACH ROW EXECUTE FUNCTION audit_phi_write_remittance_advice();--> statement-breakpoint

-- ============================================================================================
-- remittance_line (partitioned parent)
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_remittance_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'remittance_line.' || lower(TG_OP), 'remittance_line', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_remittance_line() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_remittance_line" AFTER INSERT OR UPDATE OR DELETE ON remittance_line FOR EACH ROW EXECUTE FUNCTION audit_phi_write_remittance_line();--> statement-breakpoint

-- ============================================================================================
-- remittance_service_line (partitioned parent)
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_remittance_service_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'remittance_service_line.' || lower(TG_OP), 'remittance_service_line', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_remittance_service_line() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_remittance_service_line" AFTER INSERT OR UPDATE OR DELETE ON remittance_service_line FOR EACH ROW EXECUTE FUNCTION audit_phi_write_remittance_service_line();--> statement-breakpoint

-- ============================================================================================
-- remittance_adjustment (partitioned parent)
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_remittance_adjustment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'remittance_adjustment.' || lower(TG_OP), 'remittance_adjustment', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_remittance_adjustment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_remittance_adjustment" AFTER INSERT OR UPDATE OR DELETE ON remittance_adjustment FOR EACH ROW EXECUTE FUNCTION audit_phi_write_remittance_adjustment();--> statement-breakpoint

-- ============================================================================================
-- remittance_remark (partitioned parent) — DENYLIST: free_text
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_remittance_remark() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['free_text'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'remittance_remark.' || lower(TG_OP), 'remittance_remark', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_remittance_remark() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_remittance_remark" AFTER INSERT OR UPDATE OR DELETE ON remittance_remark FOR EACH ROW EXECUTE FUNCTION audit_phi_write_remittance_remark();--> statement-breakpoint

-- ============================================================================================
-- denial_case — DENYLIST: override_payload
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_denial_case() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['override_payload'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'denial_case.' || lower(TG_OP), 'denial_case', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_denial_case() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_denial_case" AFTER INSERT OR UPDATE OR DELETE ON denial_case FOR EACH ROW EXECUTE FUNCTION audit_phi_write_denial_case();--> statement-breakpoint

-- ============================================================================================
-- denial_case_assignment — DENYLIST: reason
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_denial_case_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['reason'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'denial_case_assignment.' || lower(TG_OP), 'denial_case_assignment', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_denial_case_assignment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_denial_case_assignment" AFTER INSERT OR UPDATE OR DELETE ON denial_case_assignment FOR EACH ROW EXECUTE FUNCTION audit_phi_write_denial_case_assignment();--> statement-breakpoint

-- ============================================================================================
-- appeal_case — DENYLIST: appeal_narrative. Plus closed-row immutability (§2.2).
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_appeal_case() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['appeal_narrative'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'appeal_case.' || lower(TG_OP), 'appeal_case', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_appeal_case() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_appeal_case" AFTER INSERT OR UPDATE OR DELETE ON appeal_case FOR EACH ROW EXECUTE FUNCTION audit_phi_write_appeal_case();--> statement-breakpoint
-- Closed-row immutability: once state reaches 'closed' the row is frozen (mirrors M16 closure pattern).
CREATE OR REPLACE FUNCTION m25_appeal_case_closed_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'closed' THEN
    RAISE EXCEPTION 'M25_APPEAL_CLOSED_IMMUTABLE: appeal_case % is closed and cannot be modified', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_appeal_case_closed_immutable" BEFORE UPDATE ON appeal_case FOR EACH ROW EXECUTE FUNCTION m25_appeal_case_closed_immutable();--> statement-breakpoint

-- ============================================================================================
-- appeal_case_event — DENYLIST: event_payload
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_appeal_case_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['event_payload'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'appeal_case_event.' || lower(TG_OP), 'appeal_case_event', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_appeal_case_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_appeal_case_event" AFTER INSERT OR UPDATE OR DELETE ON appeal_case_event FOR EACH ROW EXECUTE FUNCTION audit_phi_write_appeal_case_event();--> statement-breakpoint

-- ============================================================================================
-- denial_taxonomy_overlay
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_denial_taxonomy_overlay() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'denial_taxonomy_overlay.' || lower(TG_OP), 'denial_taxonomy_overlay', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_denial_taxonomy_overlay() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_denial_taxonomy_overlay" AFTER INSERT OR UPDATE OR DELETE ON denial_taxonomy_overlay FOR EACH ROW EXECUTE FUNCTION audit_phi_write_denial_taxonomy_overlay();--> statement-breakpoint

-- ============================================================================================
-- patient_responsibility_ledger
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_patient_responsibility_ledger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'patient_responsibility_ledger.' || lower(TG_OP), 'patient_responsibility_ledger', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_patient_responsibility_ledger() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_responsibility_ledger" AFTER INSERT OR UPDATE OR DELETE ON patient_responsibility_ledger FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_responsibility_ledger();
