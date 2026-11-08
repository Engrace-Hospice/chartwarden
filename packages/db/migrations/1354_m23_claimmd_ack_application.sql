-- compat: expand
-- BIL-1.3: tenant-scoped, append-only decisions for normalized Claim.MD response messages.
-- Raw vendor text remains in the encrypted account inbox. No worker is activated by this DDL.
CREATE TABLE claimmd_ack_application (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES claimmd_response_event(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('shadow','apply')),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  resolution_id uuid NOT NULL REFERENCES claimmd_response_resolution(id) ON DELETE RESTRICT,
  resolution_version integer NOT NULL CHECK (resolution_version > 0),
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  location_id uuid,
  claim_id uuid NOT NULL,
  billing_module text NOT NULL CHECK (billing_module IN ('M23','M24','M41')),
  submission_id uuid NOT NULL,
  evidence_id uuid,
  response_id text,
  source_representation text NOT NULL CHECK (source_representation = 'claimmd_normalized_api'),
  sender_id text,
  message_code text,
  parent_status text,
  message_status text,
  interpreter_version text NOT NULL CHECK (interpreter_version ~ '^bil1\.3\.v[0-9]+$'),
  proposed_action text CHECK (proposed_action IS NULL OR proposed_action = 'record_clearinghouse_receipt'),
  outcome text NOT NULL CHECK (outcome IN ('applied','informational','held','shadow')),
  previous_state text,
  new_state text,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z_]{2,80}$'),
  processed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_ack_application_attempt_uq UNIQUE(event_id,mode,attempt_number),
  CONSTRAINT claimmd_ack_application_evidence_fk FOREIGN KEY (evidence_id,organization_id,account_reference,usage)
    REFERENCES claimmd_submission_evidence(id,organization_id,account_reference,usage) ON DELETE RESTRICT
);--> statement-breakpoint
CREATE INDEX claimmd_ack_application_org_ix ON claimmd_ack_application(organization_id,provider_entity_id,claim_id);--> statement-breakpoint
CREATE UNIQUE INDEX claimmd_ack_application_applied_uq ON claimmd_ack_application(event_id,mode) WHERE outcome = 'applied';--> statement-breakpoint
CREATE INDEX claimmd_ack_application_resolution_ix ON claimmd_ack_application(resolution_id,resolution_version);--> statement-breakpoint
ALTER TABLE claimmd_ack_application ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_ack_application FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_ack_application_org ON claimmd_ack_application FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);--> statement-breakpoint
CREATE POLICY claimmd_ack_application_internal_read ON claimmd_ack_application FOR SELECT TO claimmd_capture USING (true);--> statement-breakpoint
GRANT SELECT,INSERT ON claimmd_ack_application TO chartwarden_app;--> statement-breakpoint
GRANT SELECT ON claimmd_ack_application TO claimmd_capture;--> statement-breakpoint
-- Tenant workers can revalidate the CURRENT resolution under their org RLS transaction.
-- The encrypted event/batch/stream rows stay unavailable to chartwarden_app.
CREATE POLICY claimmd_response_resolution_org_read ON claimmd_response_resolution FOR SELECT TO chartwarden_app
  USING (state = 'resolved' AND organization_id = nullif(current_setting('app.org_id',true),'')::uuid);--> statement-breakpoint
GRANT SELECT ON claimmd_response_resolution TO chartwarden_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION claimmd_ack_application_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'CLAIMMD_ACK_APPLICATION_IMMUTABLE' USING ERRCODE = 'check_violation';
END $fn$;--> statement-breakpoint
CREATE TRIGGER trg_claimmd_ack_application_immutable BEFORE UPDATE OR DELETE ON claimmd_ack_application
  FOR EACH ROW EXECUTE FUNCTION claimmd_ack_application_immutable();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_claimmd_ack_application() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  INSERT INTO audit_event (organization_id,actor_user_id,actor_kind,event_type,resource_kind,resource_id,correlation_id,
    outcome,severity,before,after,context,retention_class)
  VALUES (NEW.organization_id,NULLIF(current_setting('app.user_id',true),'')::uuid,'system','claimmd_ack_application.insert',
    'claimmd_ack_application',NEW.id,COALESCE(NULLIF(current_setting('app.correlation_id',true),''),'system'),
    'success','info',NULL,jsonb_build_object('eventId',NEW.event_id,'resolutionId',NEW.resolution_id,
      'claimId',NEW.claim_id,'outcome',NEW.outcome,'reasonCode',NEW.reason_code),
    jsonb_build_object('billingModule',NEW.billing_module),'compliance');
  RETURN NEW;
END $fn$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claimmd_ack_application() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER trg_audit_claimmd_ack_application AFTER INSERT ON claimmd_ack_application
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claimmd_ack_application();
--> statement-breakpoint
CREATE TABLE claimmd_ack_delivery (
  event_id uuid NOT NULL REFERENCES claimmd_response_event(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('shadow','apply')),
  account_reference text NOT NULL CHECK (account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'),
  usage text NOT NULL CHECK (usage IN ('test','production')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','complete','needs_review')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid,
  lease_until timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z_]{2,80}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_ack_delivery_lease_pair CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CONSTRAINT claimmd_ack_delivery_pk PRIMARY KEY(event_id,mode)
);--> statement-breakpoint
CREATE INDEX claimmd_ack_delivery_due_ix ON claimmd_ack_delivery(account_reference,usage,mode,state,next_attempt_at);--> statement-breakpoint
ALTER TABLE claimmd_ack_delivery ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_ack_delivery FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_ack_delivery_internal ON claimmd_ack_delivery FOR ALL TO claimmd_capture USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON claimmd_ack_delivery TO claimmd_capture;--> statement-breakpoint
INSERT INTO claimmd_ack_delivery(event_id,mode,account_reference,usage)
SELECT r.event_id,m.mode,s.account_reference,s.usage FROM claimmd_response_resolution r
JOIN claimmd_response_event e ON e.id = r.event_id
JOIN claimmd_response_stream s ON s.id = e.stream_id
CROSS JOIN (VALUES ('shadow'),('apply')) AS m(mode)
WHERE r.state = 'resolved' ON CONFLICT(event_id,mode) DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION claimmd_seed_ack_delivery() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.state = 'resolved' THEN
    INSERT INTO claimmd_ack_delivery(event_id,mode,account_reference,usage)
      SELECT NEW.event_id,m.mode,s.account_reference,s.usage FROM claimmd_response_event e
      JOIN claimmd_response_stream s ON s.id = e.stream_id
      CROSS JOIN (VALUES ('shadow'),('apply')) AS m(mode) WHERE e.id = NEW.event_id
      ON CONFLICT(event_id,mode) DO NOTHING;
  END IF;
  RETURN NEW;
END $fn$;--> statement-breakpoint
CREATE TRIGGER trg_claimmd_seed_ack_delivery AFTER INSERT OR UPDATE OF state ON claimmd_response_resolution
  FOR EACH ROW EXECUTE FUNCTION claimmd_seed_ack_delivery();
