-- compat: expand
-- BIL-3.4.4 immutable plan and append-only controlled posting evidence. No posting is enabled by this DDL.
CREATE TABLE claimmd_era_posting_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  stage_id uuid NOT NULL REFERENCES claimmd_era_m25_stage(id) ON DELETE RESTRICT,
  plan_digest varchar(64) NOT NULL CHECK (plan_digest ~ '^[0-9a-f]{64}$'),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_era_posting_plan_stage_digest_uq UNIQUE(stage_id, plan_digest)
);
--> statement-breakpoint
CREATE INDEX claimmd_era_posting_plan_tenant_stage_ix ON claimmd_era_posting_plan(organization_id, provider_entity_id, stage_id, created_at);
--> statement-breakpoint
ALTER TABLE claimmd_era_posting_plan ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE claimmd_era_posting_plan FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY claimmd_era_posting_plan_read ON claimmd_era_posting_plan FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY claimmd_era_posting_plan_insert ON claimmd_era_posting_plan FOR INSERT TO chartwarden_app
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM claimmd_era_m25_stage stage WHERE stage.id = claimmd_era_posting_plan.stage_id
      AND stage.organization_id = claimmd_era_posting_plan.organization_id
      AND stage.provider_entity_id = claimmd_era_posting_plan.provider_entity_id
  ));
--> statement-breakpoint
GRANT SELECT, INSERT ON claimmd_era_posting_plan TO chartwarden_app;
--> statement-breakpoint
CREATE FUNCTION reject_claimmd_era_posting_plan_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'claimmd_era_posting_plan is immutable'; END $fn$;
--> statement-breakpoint
CREATE TRIGGER claimmd_era_posting_plan_immutable BEFORE UPDATE OR DELETE ON claimmd_era_posting_plan
  FOR EACH ROW EXECUTE FUNCTION reject_claimmd_era_posting_plan_mutation();
--> statement-breakpoint
CREATE TABLE claimmd_era_posting_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  stage_id uuid NOT NULL REFERENCES claimmd_era_m25_stage(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES claimmd_era_posting_plan(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('approved','posted')),
  plan_digest varchar(64) NOT NULL CHECK (plan_digest ~ '^[0-9a-f]{64}$'),
  actor_membership_id uuid NOT NULL,
  idempotency_key_hash varchar(64) NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  advice_id uuid,
  remittance_line_id uuid,
  reason varchar(500) NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_era_posting_event_scope_ck CHECK (
    (event_type = 'approved' AND advice_id IS NULL AND remittance_line_id IS NULL) OR
    (event_type = 'posted' AND advice_id IS NOT NULL AND remittance_line_id IS NOT NULL)
  ),
  CONSTRAINT claimmd_era_posting_event_idempotency_uq UNIQUE(organization_id, idempotency_key_hash)
);
--> statement-breakpoint
CREATE INDEX claimmd_era_posting_event_plan_ix ON claimmd_era_posting_event(plan_id, created_at);
--> statement-breakpoint
ALTER TABLE claimmd_era_posting_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE claimmd_era_posting_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY claimmd_era_posting_event_read ON claimmd_era_posting_event FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY claimmd_era_posting_event_insert ON claimmd_era_posting_event FOR INSERT TO chartwarden_app
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM claimmd_era_m25_stage stage JOIN claimmd_era_posting_plan plan ON plan.id = claimmd_era_posting_event.plan_id
    WHERE stage.id = claimmd_era_posting_event.stage_id AND stage.organization_id = claimmd_era_posting_event.organization_id
      AND stage.provider_entity_id = claimmd_era_posting_event.provider_entity_id AND plan.stage_id = stage.id
      AND plan.organization_id = stage.organization_id AND plan.provider_entity_id = stage.provider_entity_id
      AND plan.plan_digest = claimmd_era_posting_event.plan_digest
  ));
--> statement-breakpoint
GRANT SELECT, INSERT ON claimmd_era_posting_event TO chartwarden_app;
--> statement-breakpoint
CREATE FUNCTION reject_claimmd_era_posting_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'claimmd_era_posting_event is append-only'; END $fn$;
--> statement-breakpoint
CREATE TRIGGER claimmd_era_posting_event_immutable BEFORE UPDATE OR DELETE ON claimmd_era_posting_event
  FOR EACH ROW EXECUTE FUNCTION reject_claimmd_era_posting_event_mutation();
--> statement-breakpoint
INSERT INTO permission (key, resource, action, category, default_abac, description) VALUES
  ('remittance.posting.approve', 'claimmd_era_posting_plan', 'approve', 'billing', 'provider_entity_scope', 'Approve an exact, eligible Claim.MD ERA posting plan'),
  ('remittance.posting.execute', 'claimmd_era_posting_plan', 'execute', 'billing', 'provider_entity_scope', 'Execute an explicitly approved Claim.MD ERA posting plan')
ON CONFLICT (key) DO NOTHING;
