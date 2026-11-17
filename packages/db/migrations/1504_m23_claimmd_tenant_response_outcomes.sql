-- compat: contract
-- M23-CM-5A.3A: append-only downstream and quarantine provenance for tenant evidence.
ALTER TABLE claimmd_tenant_response_item
  ADD CONSTRAINT claimmd_tenant_response_item_scope_uq UNIQUE (id,organization_id,account_id);--> statement-breakpoint
CREATE TABLE claimmd_tenant_response_item_outcome (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  item_id uuid NOT NULL,
  consumer_key text NOT NULL CHECK (consumer_key ~ '^[a-z0-9._:-]{1,128}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  outcome text NOT NULL CHECK (outcome IN ('processed','quarantined')),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z0-9_]{1,64}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_tenant_response_item_outcome_item_fk
    FOREIGN KEY (item_id,organization_id,account_id)
    REFERENCES claimmd_tenant_response_item(id,organization_id,account_id) ON DELETE RESTRICT,
  CONSTRAINT claimmd_tenant_response_item_outcome_idempotency_uq
    UNIQUE (item_id,consumer_key,idempotency_key),
  CONSTRAINT claimmd_tenant_response_item_outcome_reason_ck
    CHECK ((outcome='quarantined' AND reason_code IS NOT NULL) OR
           (outcome='processed' AND reason_code IS NULL))
);--> statement-breakpoint
CREATE INDEX claimmd_tenant_response_item_outcome_org_ix
  ON claimmd_tenant_response_item_outcome(organization_id,account_id,item_id,occurred_at);--> statement-breakpoint
ALTER TABLE claimmd_tenant_response_item_outcome ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_tenant_response_item_outcome FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_tenant_response_item_outcome_org
  ON claimmd_tenant_response_item_outcome FOR ALL TO chartwarden_app
  USING (organization_id=nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id=nullif(current_setting('app.org_id',true),'')::uuid);--> statement-breakpoint
GRANT SELECT,INSERT ON claimmd_tenant_response_item_outcome TO chartwarden_app;--> statement-breakpoint
CREATE TRIGGER claimmd_tenant_response_item_outcome_audit
  AFTER INSERT ON claimmd_tenant_response_item_outcome
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_claimmd_tenant_response();--> statement-breakpoint
CREATE TRIGGER claimmd_tenant_response_item_outcome_immutable
  BEFORE UPDATE OR DELETE ON claimmd_tenant_response_item_outcome
  FOR EACH ROW EXECUTE FUNCTION claimmd_tenant_response_immutable();
