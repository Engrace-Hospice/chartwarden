-- TASK-063/ARCH-020 follow-up — M7 care_plan_version.state_snapshot redaction (resolves the
-- constant-vs-migration disagreement flagged when the audit-denylist-sync gate was built).
--
-- DECISION: redact state_snapshot in the audit trail, matching M7_AUDIT_DENYLIST's original claim.
-- The tension was: state_snapshot is a serialized copy of every problem/goal/intervention at the
-- moment a version was sealed, INCLUDING the free-text narrative fields (description,
-- resolution_note, goal text, intervention detail) that already get their own redaction when
-- audited via the problem/goal/intervention tables directly — so leaving it unredacted here
-- duplicates that PHI into a second audit_event path. The counter-argument (a version table's
-- whole point is recording what the sealed state was) does not actually hold: `care_plan_version`
-- ITSELF remains the durable, complete, UNREDACTED source of truth for that content forever (it is
-- sealed at in_review and never further mutated) — audit_event's before/after is a forensic
-- who-wrote-what-when record, not a second archive, so redacting it here loses no real
-- functionality. `patient_understanding_text` was already redacted; this makes state_snapshot
-- consistent with it.
CREATE OR REPLACE FUNCTION audit_phi_write_care_plan_version() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['patient_understanding_text', 'state_snapshot']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['patient_understanding_text', 'state_snapshot']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'care_plan_version.' || lower(TG_OP),
    'care_plan_version',
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
ALTER FUNCTION audit_phi_write_care_plan_version() OWNER TO wardenx_audit_writer;--> statement-breakpoint
-- Re-affirms the existing trigger→function binding (PG14+; the function body above is what actually
-- changed — CREATE OR REPLACE FUNCTION alone would suffice — but restating the trigger keeps this
-- migration self-contained and matches what scripts/check-audit-denylist-sync.ts parses per-file).
CREATE OR REPLACE TRIGGER "trg_audit_care_plan_version" AFTER INSERT OR UPDATE OR DELETE ON care_plan_version
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_care_plan_version();
