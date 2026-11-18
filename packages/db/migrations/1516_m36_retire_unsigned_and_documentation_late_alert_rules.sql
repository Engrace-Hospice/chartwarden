-- compat: expand
-- ADR-0113 D5 - the visit-note closure alerts (`m8.encounter.closure_at_risk | closure_overdue | closure_escalated`) REPLACED the two
-- age-less alert rules `m8.encounter.unsigned` and `m8.encounter.documentation_late`: the seed list no longer carries them and the
-- `encounter.attention` sweep no longer emits them. The boot seed (`alert_rule_platform_upsert`) only ever inserts and updates the rules
-- it names, so the platform rows seeded by an earlier release (organization_id IS NULL) and every per-tenant clone of them would stay
-- enabled forever. Disable them in place: a row is never deleted (an alert keeps its own event_type text, and a tenant's edit history
-- stays readable), and a disabled rule fires for nothing. Neither rule was system_locked, so the tighten-only guard (0334) does not
-- apply. A rollback to the previous release re-seeds the platform rows enabled, which is what that release's sweep expects.
-- Idempotent; a no-op on a database that never carried the rules.
UPDATE "alert_rule"
   SET "enabled" = false, "updated_at" = now()
 WHERE "event_type" IN ('m8.encounter.unsigned', 'm8.encounter.documentation_late')
   AND "enabled" = true;
