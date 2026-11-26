-- compat: expand
-- CW-AC-17 — a tenant-held vendor BAA can say when it ends. Until now the record carried only its effective date, so a BAA the
-- vendor let lapse kept a live configuration sending PHI until an operator happened to be told and revoked it.
--   baa_expires_on   the last day the recorded BAA is in force (a calendar day, Eastern: the day the service compares against), or NULL
--                    when the tenant states no end date (an open-ended agreement: nothing then ends it by itself, as before). The tenant
--                    records it with the BAA (its own lane only, as every BAA column); a changed value is a changed record, so it voids the
--                    operator's verification like any other change. The service refuses an end date that is not after the effective date or
--                    that is already past. After the day the resolver, the claims-billing gate and the Claim.MD inbox gates treat the
--                    configuration as out of service (held like a revoked one), and the tenant clears it by recording the renewed BAA.
-- No CHECK on purpose: the order against baa_effective_date is the service's rule (a CHECK would make this migration contract), and a row
-- the service wrote before this column existed has a NULL here, which every reader treats as "no end date". UPDATE is column-level
-- (1417), so the new column is added to the grant; INSERT is table-wide already.
ALTER TABLE "tenant_clearinghouse_config" ADD COLUMN IF NOT EXISTS "baa_expires_on" date;--> statement-breakpoint
GRANT UPDATE ("baa_expires_on") ON "tenant_clearinghouse_config" TO chartwarden_app;
