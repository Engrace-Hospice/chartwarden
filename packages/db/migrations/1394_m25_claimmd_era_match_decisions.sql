-- compat: expand
-- BIL-3.2 durable reviewer-confirmed Claim.MD stage identity links. This table is nonposting by design.
CREATE TABLE claimmd_era_match_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  stage_id uuid NOT NULL REFERENCES claimmd_era_m25_stage(id) ON DELETE RESTRICT,
  transaction_set_control_number varchar(9) NOT NULL,
  claim_index integer NOT NULL CHECK (claim_index >= 0),
  decision_version integer NOT NULL CHECK (decision_version > 0),
  outcome text NOT NULL CHECK (outcome IN ('confirmed', 'cleared')),
  claim_id uuid,
  source_digest varchar(64) NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  reason varchar(500) NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  actor_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_era_match_decision_payload_ck CHECK ((outcome = 'confirmed') = (claim_id IS NOT NULL)),
  CONSTRAINT claimmd_era_match_decision_version_uq UNIQUE(stage_id, transaction_set_control_number, claim_index, decision_version)
);--> statement-breakpoint
CREATE INDEX claimmd_era_match_decision_stage_claim_ix ON claimmd_era_match_decision(stage_id, transaction_set_control_number, claim_index, decision_version DESC);--> statement-breakpoint
ALTER TABLE claimmd_era_match_decision ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE claimmd_era_match_decision FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY claimmd_era_match_decision_org ON claimmd_era_match_decision FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY claimmd_era_match_decision_org_insert ON claimmd_era_match_decision FOR INSERT TO chartwarden_app
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM claimmd_era_m25_stage stage
    WHERE stage.id = claimmd_era_match_decision.stage_id
      AND stage.organization_id = claimmd_era_match_decision.organization_id
      AND stage.provider_entity_id = claimmd_era_match_decision.provider_entity_id
  ));--> statement-breakpoint
GRANT SELECT, INSERT ON claimmd_era_match_decision TO chartwarden_app;--> statement-breakpoint
CREATE FUNCTION reject_claimmd_era_match_decision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'claimmd_era_match_decision is append-only';
  RETURN NULL;
END
$fn$;--> statement-breakpoint
CREATE TRIGGER claimmd_era_match_decision_immutable BEFORE UPDATE OR DELETE ON claimmd_era_match_decision
FOR EACH ROW EXECUTE FUNCTION reject_claimmd_era_match_decision_mutation();--> statement-breakpoint
INSERT INTO permission (key, resource, action, category, default_abac, description)
VALUES ('remittance.match_review', 'claimmd_era_match_decision', 'resolve', 'billing', 'provider_entity_scope', 'Confirm nonposting ERA-to-claim review decisions')
ON CONFLICT (key) DO NOTHING;
