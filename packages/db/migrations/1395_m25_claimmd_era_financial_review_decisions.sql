-- compat: expand
-- BIL-3.3 durable nonposting review history; deliberately separate from financial ledger state.
CREATE TABLE claimmd_era_financial_review_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  provider_entity_id uuid NOT NULL,
  stage_id uuid NOT NULL REFERENCES claimmd_era_m25_stage(id) ON DELETE RESTRICT,
  item_type text NOT NULL CHECK (item_type IN ('era', 'claim')),
  item_index integer NOT NULL,
  decision_version integer NOT NULL CHECK (decision_version > 0),
  disposition text NOT NULL CHECK (disposition IN ('note', 'follow_up', 'reviewed', 'reopened', 'completed')),
  source_digest varchar(64) NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  idempotency_key_hash varchar(64) NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  reason varchar(1000) NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  actor_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claimmd_era_fin_review_item_ck CHECK ((item_type = 'era' AND item_index = -1) OR (item_type = 'claim' AND item_index >= 0)),
  CONSTRAINT claimmd_era_fin_review_version_uq UNIQUE(stage_id, item_type, item_index, decision_version),
  CONSTRAINT claimmd_era_fin_review_idempotency_uq UNIQUE(organization_id, idempotency_key_hash)
);
--> statement-breakpoint
ALTER TABLE claimmd_era_financial_review_decision ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE claimmd_era_financial_review_decision FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY claimmd_era_fin_review_org ON claimmd_era_financial_review_decision FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY claimmd_era_fin_review_org_insert ON claimmd_era_financial_review_decision FOR INSERT TO chartwarden_app
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM claimmd_era_m25_stage stage
    WHERE stage.id = claimmd_era_financial_review_decision.stage_id
      AND stage.organization_id = claimmd_era_financial_review_decision.organization_id
      AND stage.provider_entity_id = claimmd_era_financial_review_decision.provider_entity_id
  ));
--> statement-breakpoint
GRANT SELECT, INSERT ON claimmd_era_financial_review_decision TO chartwarden_app;
--> statement-breakpoint
CREATE FUNCTION reject_claimmd_era_fin_review_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'claimmd_era_financial_review_decision is append-only';
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER claimmd_era_fin_review_immutable BEFORE UPDATE OR DELETE ON claimmd_era_financial_review_decision
FOR EACH ROW EXECUTE FUNCTION reject_claimmd_era_fin_review_mutation();
--> statement-breakpoint
INSERT INTO permission (key, resource, action, category, default_abac, description)
VALUES ('remittance.financial_review', 'claimmd_era_financial_review_decision', 'review', 'billing', 'provider_entity_scope', 'Record nonposting ERA financial-review decisions and follow-up notes')
ON CONFLICT (key) DO NOTHING;
