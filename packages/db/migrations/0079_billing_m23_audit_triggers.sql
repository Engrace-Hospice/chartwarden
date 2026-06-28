-- M23 Billing — Medicare §3.6 — M4 write-audit triggers (the M27 0072 generator shape) on every owned
-- table + append-only immutability enforcement on the eight append-only tables (§10 task 7).
--
-- Each audit_phi_write_<table>() is the canonical M4 shape: SECURITY DEFINER, SET search_path =
-- pg_catalog, public; OWNER wardenx_audit_writer; org keyed on COALESCE(NEW.organization_id,
-- OLD.organization_id); value-capture scrubbed via audit_scrub(to_jsonb(...), ARRAY[...]) per the §3.6
-- denylist. M23 carries NO PHI (billing aggregates / financial), but every claim mutation is survey
-- evidence → retention_class 'compliance' (per-tenant config validation_rule_config = 'operational').
-- The four partitioned parents get the trigger on the PARENT (propagates to every partition, PG11+).
--
-- §3.6 denylist (value not captured — replaced by audit_scrub marker):
--   claim_submission.worker_correlation_id · claim_acknowledgment.parsed_payload ·
--   hipps_calculation.segments · sia_calculation.qualifying_visits · validation_rule_config.predicate_dsl ·
--   validation_run.run_input_hash · validation_result.remediation · mac_submitter_credential.client_secret_cipher ·
--   eligibility_check.parsed_payload. (claim / claim_line / noe / notr / validation_override /
--   sequestration_policy capture every column — surveyor-essential; MBI is never a column anywhere — D13.)
-- wage_index_factor carries NO organization_id, so the org-keyed generator cannot run on it — it gets
-- M1's null-safe baseline wardenx_audit_trigger() (the M38 platform-table precedent).
--
-- APPEND-ONLY (§3.6 / §10 task 7): claim_state_history, claim_submission, claim_acknowledgment,
-- validation_run, validation_result, validation_override, hipps_calculation, sia_calculation get a BEFORE
-- UPDATE OR DELETE trigger raising M23_TABLE_APPEND_ONLY (corrections-of-record go through the D14
-- replacement chain, never in-place edits). The BEFORE trigger aborts U/D so the AFTER audit trigger's
-- U/D branch never fires for these — INSERT is audited.

-- ============================================================================================
-- M4 write-audit triggers (one function + trigger per owned table).
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'claim.' || lower(TG_OP), 'claim', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claim() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_claim" AFTER INSERT OR UPDATE OR DELETE ON claim FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claim();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_claim_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'claim_line.' || lower(TG_OP), 'claim_line', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claim_line() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_claim_line" AFTER INSERT OR UPDATE OR DELETE ON claim_line FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claim_line();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_claim_state_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'claim_state_history.' || lower(TG_OP), 'claim_state_history', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claim_state_history() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_claim_state_history" AFTER INSERT OR UPDATE OR DELETE ON claim_state_history FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claim_state_history();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_claim_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['worker_correlation_id']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'claim_submission.' || lower(TG_OP), 'claim_submission', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claim_submission() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_claim_submission" AFTER INSERT OR UPDATE OR DELETE ON claim_submission FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claim_submission();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_claim_acknowledgment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['parsed_payload']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'claim_acknowledgment.' || lower(TG_OP), 'claim_acknowledgment', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claim_acknowledgment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_claim_acknowledgment" AFTER INSERT OR UPDATE OR DELETE ON claim_acknowledgment FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claim_acknowledgment();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_noe_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'noe_record.' || lower(TG_OP), 'noe_record', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_noe_record() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_noe_record" AFTER INSERT OR UPDATE OR DELETE ON noe_record FOR EACH ROW EXECUTE FUNCTION audit_phi_write_noe_record();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_notr_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'notr_record.' || lower(TG_OP), 'notr_record', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_notr_record() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_notr_record" AFTER INSERT OR UPDATE OR DELETE ON notr_record FOR EACH ROW EXECUTE FUNCTION audit_phi_write_notr_record();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_hipps_calculation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['segments']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'hipps_calculation.' || lower(TG_OP), 'hipps_calculation', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_hipps_calculation() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hipps_calculation" AFTER INSERT OR UPDATE OR DELETE ON hipps_calculation FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hipps_calculation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_sia_calculation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['qualifying_visits']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'sia_calculation.' || lower(TG_OP), 'sia_calculation', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_sia_calculation() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_sia_calculation" AFTER INSERT OR UPDATE OR DELETE ON sia_calculation FOR EACH ROW EXECUTE FUNCTION audit_phi_write_sia_calculation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_validation_rule_config() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['predicate_dsl']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'validation_rule_config.' || lower(TG_OP), 'validation_rule_config', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'operational');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_validation_rule_config() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_validation_rule_config" AFTER INSERT OR UPDATE OR DELETE ON validation_rule_config FOR EACH ROW EXECUTE FUNCTION audit_phi_write_validation_rule_config();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_validation_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['run_input_hash']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'validation_run.' || lower(TG_OP), 'validation_run', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_validation_run() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_validation_run" AFTER INSERT OR UPDATE OR DELETE ON validation_run FOR EACH ROW EXECUTE FUNCTION audit_phi_write_validation_run();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_validation_result() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['remediation']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'validation_result.' || lower(TG_OP), 'validation_result', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_validation_result() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_validation_result" AFTER INSERT OR UPDATE OR DELETE ON validation_result FOR EACH ROW EXECUTE FUNCTION audit_phi_write_validation_result();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_validation_override() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'validation_override.' || lower(TG_OP), 'validation_override', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'warn', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_validation_override() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_validation_override" AFTER INSERT OR UPDATE OR DELETE ON validation_override FOR EACH ROW EXECUTE FUNCTION audit_phi_write_validation_override();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_sequestration_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'sequestration_policy.' || lower(TG_OP), 'sequestration_policy', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_sequestration_policy() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_sequestration_policy" AFTER INSERT OR UPDATE OR DELETE ON sequestration_policy FOR EACH ROW EXECUTE FUNCTION audit_phi_write_sequestration_policy();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_mac_submitter_credential() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['client_secret_cipher']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'mac_submitter_credential.' || lower(TG_OP), 'mac_submitter_credential', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'warn', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_mac_submitter_credential() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_mac_submitter_credential" AFTER INSERT OR UPDATE OR DELETE ON mac_submitter_credential FOR EACH ROW EXECUTE FUNCTION audit_phi_write_mac_submitter_credential();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_eligibility_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['parsed_payload']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'eligibility_check.' || lower(TG_OP), 'eligibility_check', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_eligibility_check() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_eligibility_check" AFTER INSERT OR UPDATE OR DELETE ON eligibility_check FOR EACH ROW EXECUTE FUNCTION audit_phi_write_eligibility_check();--> statement-breakpoint

-- wage_index_factor: NO organization_id → M1 null-safe baseline trigger (M38 platform-table precedent).
CREATE TRIGGER "trg_audit_wage_index_factor" AFTER INSERT OR UPDATE OR DELETE ON wage_index_factor FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

-- ============================================================================================
-- Append-only enforcement (§3.6 / §10 task 7) — BEFORE UPDATE OR DELETE raises M23_TABLE_APPEND_ONLY.
-- ============================================================================================
CREATE OR REPLACE FUNCTION m23_enforce_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'M23_TABLE_APPEND_ONLY: % is append-only; % is forbidden (corrections go through the D14 replacement chain)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_append_only_claim_state_history" BEFORE UPDATE OR DELETE ON claim_state_history FOR EACH ROW EXECUTE FUNCTION m23_enforce_append_only();--> statement-breakpoint
CREATE TRIGGER "trg_append_only_claim_submission" BEFORE UPDATE OR DELETE ON claim_submission FOR EACH ROW EXECUTE FUNCTION m23_enforce_append_only();--> statement-breakpoint
CREATE TRIGGER "trg_append_only_claim_acknowledgment" BEFORE UPDATE OR DELETE ON claim_acknowledgment FOR EACH ROW EXECUTE FUNCTION m23_enforce_append_only();--> statement-breakpoint
CREATE TRIGGER "trg_append_only_validation_run" BEFORE UPDATE OR DELETE ON validation_run FOR EACH ROW EXECUTE FUNCTION m23_enforce_append_only();--> statement-breakpoint
CREATE TRIGGER "trg_append_only_validation_result" BEFORE UPDATE OR DELETE ON validation_result FOR EACH ROW EXECUTE FUNCTION m23_enforce_append_only();--> statement-breakpoint
CREATE TRIGGER "trg_append_only_validation_override" BEFORE UPDATE OR DELETE ON validation_override FOR EACH ROW EXECUTE FUNCTION m23_enforce_append_only();--> statement-breakpoint
CREATE TRIGGER "trg_append_only_hipps_calculation" BEFORE UPDATE OR DELETE ON hipps_calculation FOR EACH ROW EXECUTE FUNCTION m23_enforce_append_only();--> statement-breakpoint
CREATE TRIGGER "trg_append_only_sia_calculation" BEFORE UPDATE OR DELETE ON sia_calculation FOR EACH ROW EXECUTE FUNCTION m23_enforce_append_only();
