-- M23 — keep free-text rationale columns out of the M4 write-audit trail.
--
-- The M23 write-audit triggers (0079, 0279, 0375, 1056) snapshot the whole row into `audit_event.before/after` through
-- `audit_scrub(to_jsonb(row), v_cols)`. Several of them passed an EMPTY (or incomplete) `v_cols`, so free-text columns were
-- copied verbatim into the audit log: the 40-2000 char override reason, claim replacement reasons, state-history reasons,
-- the submission outcome text, NOE/NOTR correction reasons, rule-config / sequestration set reasons, and the rate-table,
-- visit-charge and transfer-notice entry/cancel reasons. That text is a tenant's typed billing rationale; it belongs on its
-- own org-scoped RLS row, not duplicated into the compliance-retained audit stream (an audit_event is read through a
-- different surface and is retained for years; free text can carry anything a user typed, including patient detail).
--
-- Each function below is the ORIGINAL definition with the free-text column(s) added to `v_cols` (audit_scrub writes
-- "<changed>" for them, so the event still shows THAT the column changed). Nothing else changes: SECURITY DEFINER, owner
-- `wardenx_audit_writer`, and the triggers stay as they were. The search_path keeps the original `pg_catalog, public` and
-- gains an explicit trailing `pg_temp` (so a TEMP object can never shadow), with the helper and table schema-qualified.
-- Forward-only; CREATE OR REPLACE is idempotent.

CREATE OR REPLACE FUNCTION audit_phi_write_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['replacement_reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'claim.' || lower(TG_OP), 'claim', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claim() OWNER TO wardenx_audit_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_claim_state_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'claim_state_history.' || lower(TG_OP), 'claim_state_history', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claim_state_history() OWNER TO wardenx_audit_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_claim_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['worker_correlation_id', 'outcome_reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'claim_submission.' || lower(TG_OP), 'claim_submission', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claim_submission() OWNER TO wardenx_audit_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_noe_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['correction_reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'noe_record.' || lower(TG_OP), 'noe_record', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_noe_record() OWNER TO wardenx_audit_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_notr_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['correction_reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'notr_record.' || lower(TG_OP), 'notr_record', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_notr_record() OWNER TO wardenx_audit_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_validation_rule_config() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['predicate_dsl', 'set_reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'validation_rule_config.' || lower(TG_OP), 'validation_rule_config', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'operational');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_validation_rule_config() OWNER TO wardenx_audit_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_validation_override() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'validation_override.' || lower(TG_OP), 'validation_override', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'warn', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_validation_override() OWNER TO wardenx_audit_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_sequestration_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['set_reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'sequestration_policy.' || lower(TG_OP), 'sequestration_policy', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_sequestration_policy() OWNER TO wardenx_audit_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_hospice_rate_table() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['entry_reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'hospice_rate_table.' || lower(TG_OP), 'hospice_rate_table', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_hospice_rate_table() OWNER TO wardenx_audit_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_transfer_notice_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['cancel_reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'transfer_notice_record.' || lower(TG_OP), 'transfer_notice_record', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_transfer_notice_record() OWNER TO wardenx_audit_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_hospice_visit_charge_schedule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['entry_reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'hospice_visit_charge_schedule.' || lower(TG_OP), 'hospice_visit_charge_schedule', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_hospice_visit_charge_schedule() OWNER TO wardenx_audit_writer;
