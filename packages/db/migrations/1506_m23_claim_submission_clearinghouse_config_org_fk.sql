-- compat: contract
-- M23-CM5-T1.3: a persisted clearinghouse config ID must belong to the same organization as its submission.
CREATE UNIQUE INDEX tenant_clearinghouse_config_id_org_uq
  ON tenant_clearinghouse_config(id, organization_id);
--> statement-breakpoint
ALTER TABLE claim_submission
  ADD CONSTRAINT claim_submission_clearinghouse_config_org_fk
  FOREIGN KEY (clearinghouse_config_id, organization_id)
  REFERENCES tenant_clearinghouse_config(id, organization_id)
  ON DELETE RESTRICT;
