-- compat: expand
-- M23-CM-4C.2: auditable NOE late-filing exception review. A local review is not an external MAC/CMS decision.
CREATE TABLE noe_exception_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  noe_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('operations_disruption','cms_mac_system_issue','new_hospice_access_delay','other_external_determination')),
  justification_document_id uuid NOT NULL, -- protected M22 document ID; no plaintext justification in M23
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','evidence_required','ready_for_external_request','request_recorded','awaiting_external_determination','external_approved_recorded','external_denied_recorded','withdrawn')),
  evidence_document_ids uuid[] NOT NULL DEFAULT '{}',
  external_request_reference text,
  external_request_date date,
  external_authority text CHECK (external_authority IN ('a_b_mac','cms')),
  external_decision text CHECK (external_decision IN ('approved','denied')),
  external_decision_date date,
  external_decision_document_id uuid,
  created_by_membership_id uuid NOT NULL,
  updated_by_membership_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT noe_exception_review_external_request_ck CHECK ((status IN ('request_recorded','awaiting_external_determination','external_approved_recorded','external_denied_recorded')) = (external_request_date IS NOT NULL)),
  CONSTRAINT noe_exception_review_external_decision_ck CHECK ((external_decision IS NULL AND external_authority IS NULL AND external_decision_date IS NULL AND external_decision_document_id IS NULL) OR (external_decision IS NOT NULL AND external_authority IS NOT NULL AND external_decision_date IS NOT NULL AND external_decision_document_id IS NOT NULL)),
  CONSTRAINT noe_exception_review_status_decision_ck CHECK ((status = 'external_approved_recorded') = (external_decision = 'approved') AND (status = 'external_denied_recorded') = (external_decision = 'denied')),
  CONSTRAINT noe_exception_review_org_id_uq UNIQUE (organization_id, id)
);
CREATE INDEX noe_exception_review_noe_ix ON noe_exception_review (organization_id, noe_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX noe_exception_review_active_uq ON noe_exception_review (organization_id, noe_id)
  WHERE status NOT IN ('external_approved_recorded','external_denied_recorded','withdrawn');
ALTER TABLE noe_exception_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE noe_exception_review FORCE ROW LEVEL SECURITY;
CREATE POLICY noe_exception_review_org ON noe_exception_review FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT ON noe_exception_review TO chartwarden_app;
GRANT UPDATE (category, justification_document_id, status, evidence_document_ids, external_request_reference, external_request_date,
  external_authority, external_decision, external_decision_date, external_decision_document_id, updated_by_membership_id,
  version, updated_at) ON noe_exception_review TO chartwarden_app;

CREATE FUNCTION noe_exception_review_org_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM noe_record n WHERE n.id = NEW.noe_id AND n.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'NOE exception review must reference a NOE in the same organization' USING ERRCODE = '23503';
  END IF;
  IF NEW.external_decision IS NOT NULL AND cardinality(NEW.evidence_document_ids) < 1 AND NEW.external_decision_document_id IS NULL THEN
    RAISE EXCEPTION 'external NOE exception decision requires protected evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER noe_exception_review_org_guard BEFORE INSERT OR UPDATE ON noe_exception_review
  FOR EACH ROW EXECUTE FUNCTION noe_exception_review_org_guard();

CREATE TABLE noe_exception_review_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  review_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created','evidence_updated','request_recorded','decision_recorded','withdrawn')),
  from_status text,
  to_status text NOT NULL,
  actor_membership_id uuid NOT NULL,
  evidence_document_ids uuid[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT noe_exception_review_event_parent_fk FOREIGN KEY (organization_id, review_id)
    REFERENCES noe_exception_review(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX noe_exception_review_event_history_ix ON noe_exception_review_event (organization_id, review_id, occurred_at, id);
ALTER TABLE noe_exception_review_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE noe_exception_review_event FORCE ROW LEVEL SECURITY;
CREATE POLICY noe_exception_review_event_org ON noe_exception_review_event FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT ON noe_exception_review_event TO chartwarden_app;
CREATE FUNCTION noe_exception_review_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'NOE exception review history is append-only'; END $fn$;
CREATE TRIGGER noe_exception_review_event_immutable BEFORE UPDATE OR DELETE ON noe_exception_review_event
  FOR EACH ROW EXECUTE FUNCTION noe_exception_review_event_immutable();

CREATE FUNCTION audit_phi_write_noe_exception_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (NEW.organization_id, NULLIF(current_setting('app.user_id', true), '')::uuid, 'system',
    'm23.noe_exception_review.' || lower(TG_OP), 'noe_exception_review', NEW.id,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', NULL,
    jsonb_build_object('status', NEW.status, 'category', NEW.category, 'version', NEW.version),
    jsonb_build_object('noe_id', NEW.noe_id), 'compliance');
  RETURN NEW;
END $fn$;
ALTER FUNCTION audit_phi_write_noe_exception_review() OWNER TO chartwarden_audit_writer;
CREATE TRIGGER audit_noe_exception_review AFTER INSERT OR UPDATE ON noe_exception_review
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_noe_exception_review();
