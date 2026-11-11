-- compat: expand
-- BIL-5.2B administrative investigation overlays for authorized M23/M41 submission attempts.
-- These records never transition a claim/submission or create a financial effect.
CREATE TABLE billing_operations_investigation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  source_module text NOT NULL CHECK (source_module IN ('M23', 'M41')),
  source_record_id uuid NOT NULL,
  source_attempt_id uuid NOT NULL,
  source_identity text NOT NULL,
  source_reason_code text,
  source_occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'waiting_external', 'resolved', 'closed')),
  resolution_outcome text CHECK (resolution_outcome IN ('verified_no_action_required', 'referred_to_source_workflow', 'waiting_for_external_confirmation', 'duplicate_investigation', 'unable_to_resolve')),
  assigned_to_membership_id uuid,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT billing_operations_investigation_source_uq UNIQUE (organization_id, source_identity),
  CONSTRAINT billing_operations_investigation_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT billing_operations_investigation_identity_ck CHECK (source_identity = source_module || ':submission:' || source_attempt_id::text),
  CONSTRAINT billing_operations_investigation_resolution_ck CHECK ((status IN ('resolved', 'closed')) = (resolution_outcome IS NOT NULL)),
  CONSTRAINT billing_operations_investigation_closed_ck CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX billing_operations_investigation_worklist_ix ON billing_operations_investigation
  (organization_id, provider_entity_id, status, updated_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX billing_operations_investigation_assignee_ix ON billing_operations_investigation
  (organization_id, assigned_to_membership_id, status, updated_at DESC);
--> statement-breakpoint
ALTER TABLE billing_operations_investigation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE billing_operations_investigation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY billing_operations_investigation_org ON billing_operations_investigation
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON billing_operations_investigation TO chartwarden_app;
--> statement-breakpoint
GRANT UPDATE (status, resolution_outcome, assigned_to_membership_id, updated_at, closed_at, version)
  ON billing_operations_investigation TO chartwarden_app;
--> statement-breakpoint
CREATE TABLE billing_operations_investigation_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  investigation_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created', 'assigned', 'unassigned', 'status_changed', 'resolved', 'reopened', 'note_added')),
  actor_membership_id uuid NOT NULL,
  previous_status text,
  new_status text,
  from_assignee_membership_id uuid,
  to_assignee_membership_id uuid,
  reason text,
  idempotency_key_hash varchar(64) NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_fingerprint varchar(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  correlation_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_operations_investigation_event_parent_fk FOREIGN KEY (organization_id, investigation_id)
    REFERENCES billing_operations_investigation(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT billing_operations_investigation_event_idempotency_uq UNIQUE (organization_id, idempotency_key_hash)
);
--> statement-breakpoint
CREATE INDEX billing_operations_investigation_event_history_ix ON billing_operations_investigation_event
  (organization_id, investigation_id, occurred_at, id);
--> statement-breakpoint
ALTER TABLE billing_operations_investigation_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE billing_operations_investigation_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY billing_operations_investigation_event_org ON billing_operations_investigation_event
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON billing_operations_investigation_event TO chartwarden_app;
--> statement-breakpoint
CREATE FUNCTION reject_billing_operations_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'billing operations investigation history is append-only'; END $fn$;
--> statement-breakpoint
CREATE TRIGGER billing_operations_investigation_event_immutable BEFORE UPDATE OR DELETE ON billing_operations_investigation_event
  FOR EACH ROW EXECUTE FUNCTION reject_billing_operations_history_mutation();
--> statement-breakpoint
CREATE TABLE billing_operations_investigation_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  investigation_id uuid NOT NULL,
  author_membership_id uuid NOT NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  idempotency_key_hash varchar(64) NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_fingerprint varchar(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_operations_investigation_note_parent_fk FOREIGN KEY (organization_id, investigation_id)
    REFERENCES billing_operations_investigation(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT billing_operations_investigation_note_idempotency_uq UNIQUE (organization_id, idempotency_key_hash)
);
--> statement-breakpoint
CREATE INDEX billing_operations_investigation_note_history_ix ON billing_operations_investigation_note
  (organization_id, investigation_id, created_at, id);
--> statement-breakpoint
ALTER TABLE billing_operations_investigation_note ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE billing_operations_investigation_note FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY billing_operations_investigation_note_org ON billing_operations_investigation_note
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON billing_operations_investigation_note TO chartwarden_app;
--> statement-breakpoint
CREATE TRIGGER billing_operations_investigation_note_immutable BEFORE UPDATE OR DELETE ON billing_operations_investigation_note
  FOR EACH ROW EXECUTE FUNCTION reject_billing_operations_history_mutation();
--> statement-breakpoint
INSERT INTO permission (key, resource, action, category, default_abac, description) VALUES
  ('billing.operations.read', 'billing_operations_investigation', 'read', 'billing', 'provider_entity_scope', 'Read scoped Billing Operations investigations'),
  ('billing.operations.triage', 'billing_operations_investigation', 'triage', 'billing', 'provider_entity_scope', 'Open and update scoped Billing Operations investigations'),
  ('billing.operations.assign', 'billing_operations_investigation', 'assign', 'billing', 'provider_entity_scope', 'Assign eligible investigators to Billing Operations investigations'),
  ('billing.operations.resolve', 'billing_operations_investigation', 'resolve', 'billing', 'provider_entity_scope', 'Resolve or close scoped Billing Operations investigations')
ON CONFLICT (key) DO NOTHING;
