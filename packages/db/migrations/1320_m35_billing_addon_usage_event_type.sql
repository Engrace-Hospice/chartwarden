-- compat: expand
-- ADR-0108 - the claims-billing add-on is metered per ACTIVE PATIENT per month. Its monthly aggregate lands in
-- usage_period_aggregate under its own usage_event_type so it never mixes with a plan meter's `active_patient` row.
-- Own file (the 1305 precedent): ALTER TYPE ... ADD VALUE is safe in the migration transaction only because nothing
-- in this file uses the new value. Purely additive; no existing row changes.
ALTER TYPE "public"."usage_event_type" ADD VALUE IF NOT EXISTS 'billing_addon_patient';
