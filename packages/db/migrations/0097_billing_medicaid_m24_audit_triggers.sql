-- M24 Billing — Medicaid §3.6 — M4 write-audit triggers (the M23 0079 / M25 0084 / M26 0090 generator shape)
-- on every owned table, plus the §3.3 service-date-within-claim BEFORE trigger on medicaid_claim_line.
-- The architecture-fitness PHI-guards gate requires an audit trigger on EVERY org-scoped table — all 14 are
-- audited (the append-only ones fire only on INSERT in practice, UPDATE/DELETE being revoked from wardenx_app).
--
-- Each audit_phi_write_<table>() is the canonical M4 shape: SECURITY DEFINER, SET search_path = pg_catalog,
-- public; OWNER wardenx_audit_writer; org keyed on COALESCE(NEW.organization_id, OLD.organization_id); the
-- §3.6 denylisted columns (ciphertext blobs, masked recipient id, tenant DSL) scrubbed via audit_scrub;
-- retention_class 'compliance' (7-year billing floor). The state Medicaid Recipient ID digits are NEVER
-- captured (D12/§3.6 — only the masked last-4 exists and it too is scrubbed). The six LIST-partitioned
-- parents get the trigger on the PARENT (propagates to leaves, PG11+).

-- medicaid_claim
CREATE OR REPLACE FUNCTION audit_phi_write_medicaid_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'medicaid_claim.' || lower(TG_OP), 'medicaid_claim', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_medicaid_claim() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medicaid_claim" AFTER INSERT OR UPDATE OR DELETE ON medicaid_claim FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicaid_claim();--> statement-breakpoint

-- medicaid_claim_line
CREATE OR REPLACE FUNCTION audit_phi_write_medicaid_claim_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'medicaid_claim_line.' || lower(TG_OP), 'medicaid_claim_line', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_medicaid_claim_line() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medicaid_claim_line" AFTER INSERT OR UPDATE OR DELETE ON medicaid_claim_line FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicaid_claim_line();--> statement-breakpoint

-- medicaid_claim_line_encounter (no id column — resource_id = medicaid_claim_line_id)
CREATE OR REPLACE FUNCTION audit_phi_write_medicaid_claim_line_encounter() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'medicaid_claim_line_encounter.' || lower(TG_OP), 'medicaid_claim_line_encounter', COALESCE(NEW.medicaid_claim_line_id, OLD.medicaid_claim_line_id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_medicaid_claim_line_encounter() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medicaid_claim_line_encounter" AFTER INSERT OR UPDATE OR DELETE ON medicaid_claim_line_encounter FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicaid_claim_line_encounter();--> statement-breakpoint

-- medicaid_claim_state_history
CREATE OR REPLACE FUNCTION audit_phi_write_medicaid_claim_state_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'medicaid_claim_state_history.' || lower(TG_OP), 'medicaid_claim_state_history', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_medicaid_claim_state_history() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medicaid_claim_state_history" AFTER INSERT OR UPDATE OR DELETE ON medicaid_claim_state_history FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicaid_claim_state_history();--> statement-breakpoint

-- medicaid_submission (scrub vendor_payload_cipher)
CREATE OR REPLACE FUNCTION audit_phi_write_medicaid_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['vendor_payload_cipher'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'medicaid_submission.' || lower(TG_OP), 'medicaid_submission', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_medicaid_submission() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medicaid_submission" AFTER INSERT OR UPDATE OR DELETE ON medicaid_submission FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicaid_submission();--> statement-breakpoint

-- medicaid_acknowledgment (scrub raw_payload_cipher)
CREATE OR REPLACE FUNCTION audit_phi_write_medicaid_acknowledgment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['raw_payload_cipher'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'medicaid_acknowledgment.' || lower(TG_OP), 'medicaid_acknowledgment', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_medicaid_acknowledgment() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medicaid_acknowledgment" AFTER INSERT OR UPDATE OR DELETE ON medicaid_acknowledgment FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicaid_acknowledgment();--> statement-breakpoint

-- medicaid_validation_run
CREATE OR REPLACE FUNCTION audit_phi_write_medicaid_validation_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'medicaid_validation_run.' || lower(TG_OP), 'medicaid_validation_run', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_medicaid_validation_run() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medicaid_validation_run" AFTER INSERT OR UPDATE OR DELETE ON medicaid_validation_run FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicaid_validation_run();--> statement-breakpoint

-- medicaid_validation_result
CREATE OR REPLACE FUNCTION audit_phi_write_medicaid_validation_result() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'medicaid_validation_result.' || lower(TG_OP), 'medicaid_validation_result', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_medicaid_validation_result() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medicaid_validation_result" AFTER INSERT OR UPDATE OR DELETE ON medicaid_validation_result FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicaid_validation_result();--> statement-breakpoint

-- medicaid_validation_override
CREATE OR REPLACE FUNCTION audit_phi_write_medicaid_validation_override() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'medicaid_validation_override.' || lower(TG_OP), 'medicaid_validation_override', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_medicaid_validation_override() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medicaid_validation_override" AFTER INSERT OR UPDATE OR DELETE ON medicaid_validation_override FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicaid_validation_override();--> statement-breakpoint

-- medicaid_validation_rule_config (scrub custom_predicate_dsl)
CREATE OR REPLACE FUNCTION audit_phi_write_medicaid_validation_rule_config() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['custom_predicate_dsl'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'medicaid_validation_rule_config.' || lower(TG_OP), 'medicaid_validation_rule_config', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_medicaid_validation_rule_config() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medicaid_validation_rule_config" AFTER INSERT OR UPDATE OR DELETE ON medicaid_validation_rule_config FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicaid_validation_rule_config();--> statement-breakpoint

-- medicaid_eligibility_check (scrub raw_response_cipher + masked recipient id)
CREATE OR REPLACE FUNCTION audit_phi_write_medicaid_eligibility_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['raw_response_cipher','recipient_id_masked_at_check'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'medicaid_eligibility_check.' || lower(TG_OP), 'medicaid_eligibility_check', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_medicaid_eligibility_check() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_medicaid_eligibility_check" AFTER INSERT OR UPDATE OR DELETE ON medicaid_eligibility_check FOR EACH ROW EXECUTE FUNCTION audit_phi_write_medicaid_eligibility_check();--> statement-breakpoint

-- rb_arrangement
CREATE OR REPLACE FUNCTION audit_phi_write_rb_arrangement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'rb_arrangement.' || lower(TG_OP), 'rb_arrangement', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_rb_arrangement() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_rb_arrangement" AFTER INSERT OR UPDATE OR DELETE ON rb_arrangement FOR EACH ROW EXECUTE FUNCTION audit_phi_write_rb_arrangement();--> statement-breakpoint

-- rb_day
CREATE OR REPLACE FUNCTION audit_phi_write_rb_day() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'rb_day.' || lower(TG_OP), 'rb_day', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_rb_day() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_rb_day" AFTER INSERT OR UPDATE OR DELETE ON rb_day FOR EACH ROW EXECUTE FUNCTION audit_phi_write_rb_day();--> statement-breakpoint

-- state_medicaid_trading_partner_credential (scrub the three ciphers)
CREATE OR REPLACE FUNCTION audit_phi_write_state_medicaid_tp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['client_secret_cipher','sftp_key_cipher','additional_config_cipher'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'state_medicaid_trading_partner_credential.' || lower(TG_OP), 'state_medicaid_trading_partner_credential', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_state_medicaid_tp() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_state_medicaid_tp" AFTER INSERT OR UPDATE OR DELETE ON state_medicaid_trading_partner_credential FOR EACH ROW EXECUTE FUNCTION audit_phi_write_state_medicaid_tp();--> statement-breakpoint

-- §3.3 service-date-within-claim BEFORE trigger: a line's service_date must fall within the parent claim's
-- [service_from, service_to] (PG CHECK cannot reference another table). Parent looked up by the full PK
-- (id, provider_entity_id) since medicaid_claim is PE-partitioned.
CREATE OR REPLACE FUNCTION trg_fn_medicaid_claim_line_service_date_within_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_from timestamptz; v_to timestamptz;
BEGIN
  SELECT service_from, service_to INTO v_from, v_to
  FROM medicaid_claim
  WHERE id = NEW.medicaid_claim_id AND provider_entity_id = NEW.provider_entity_id;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'medicaid_claim_line.medicaid_claim_id % not found for provider_entity %', NEW.medicaid_claim_id, NEW.provider_entity_id;
  END IF;
  IF NEW.service_date < v_from OR NEW.service_date > v_to THEN
    RAISE EXCEPTION 'medicaid_claim_line.service_date % outside claim range [% , %]', NEW.service_date, v_from, v_to;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_medicaid_claim_line_service_date_within_claim" BEFORE INSERT OR UPDATE ON medicaid_claim_line FOR EACH ROW EXECUTE FUNCTION trg_fn_medicaid_claim_line_service_date_within_claim();--> statement-breakpoint
