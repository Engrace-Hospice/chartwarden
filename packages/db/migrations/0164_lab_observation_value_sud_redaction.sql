-- TASK-063/ARCH-020 follow-up — M29 lab_observation_value row-conditional SUD redaction (resolves
-- the constant-vs-migration-vs-catalog three-way disagreement flagged when the audit-denylist-sync
-- gate was built).
--
-- A THIRD phantom this migration corrects, also only caught by live-Postgres verification: the
-- `audit_retention_class` enum (0000_foundation_initial.sql) is `('operational', 'compliance',
-- 'legal_hold')` — it was NEVER actually extended with `compliance_42cfr_part2`, even though
-- `generate.ts`'s `TriggerRetentionClass` TS type has offered that value since M4 shipped and five
-- other migrations' comments (0102, 0106, 0116, 0139, 0153) already describe the enum as if it had
-- four values. Every one of those migrations stamps the ordinary `compliance` class in practice, so
-- the gap was silent — this is the first migration to actually try to WRITE
-- `compliance_42cfr_part2` into `audit_event.retention_class`. Adding the value here, in its own
-- transaction ahead of the function that will eventually write it (`ALTER TYPE ... ADD VALUE`
-- cannot be used in the same transaction that also evaluates the new value — this migration's own
-- `CREATE FUNCTION` below only stores the literal as text, it does not evaluate the cast, so it is
-- safe to share this transaction).
ALTER TYPE "audit_retention_class" ADD VALUE IF NOT EXISTS 'compliance_42cfr_part2';--> statement-breakpoint
--
-- DECISION: implement the row-conditional redaction AUDIT_DENYLIST_CATALOG already specified
-- (packages/audit/src/triggers/catalog.ts, W-M4-11) — 42 CFR Part 2 confidentiality applies to lab
-- results only when the parent observation was classified SUD at ingest. The PRIOR trigger (0148)
-- did `to_jsonb(OLD/NEW)` directly with no `audit_scrub()` call at all and a hardcoded 'compliance'
-- retention class.
--
-- CORRECTION (superseding the first cut of this migration, caught by live-Postgres verification —
-- static gates alone cannot catch a phantom column reference): the catalog entry this was
-- generated from originally referenced `lab_observation.sud_redaction_status` and
-- `lab_observation_value.observation_value` — NEITHER exists in the shipped schema. Both names
-- come from the T-29.11 SUD-hardening forward-engineering spec
-- (docs/modules/module-29-tasks/WARDENX_T-29.11_SUD_HARDENING.md), whose richer
-- `sud_redaction_status` enum + migration `0034_external_interfaces_sud_hardening.sql` were never
-- actually built (0034 in this repo is the unrelated M10 HOPE migration). The catalog now points at
-- what actually shipped: `lab_observation.sud_redacted_at_ingest` (boolean, migration 0145) and
-- `lab_observation_value.numeric_value` / `.string_value` (there is no single `observation_value`
-- column). Note the app-layer ingest path (`lab-attach-planner.ts`) already replaces a SUD-class
-- row's `numeric_value` with NULL and `string_value` with the `[REDACTED_SUD]` sentinel BEFORE
-- persist — this trigger is defense-in-depth against a future ingest-path bug, not the primary
-- protection.
--
-- This is generateAuditTrigger()'s row-conditional code path (packages/audit/src/triggers/
-- generate.ts) — built for exactly this catalog entry, never before invoked against a real
-- migration (confirmed: zero `v_denylist text[]` occurrences in any prior migration). Output below
-- is the LITERAL, byte-for-byte result of:
--
--   generateAuditTrigger({
--     table: "lab_observation_value",
--     resourceKind: "lab_observation_value",
--     denylistCategories: ["sud_value"],
--     retentionClass: "compliance_42cfr_part2",
--   })
--
-- — never hand-typed, so it cannot drift from the catalog it was generated against. Retention class
-- also corrected from the prior hardcoded 'compliance' to 'compliance_42cfr_part2' (§5.3
-- defense-in-depth: a Part 2 trigger is subject to sud_value scrubbing and files under the Part 2
-- retention class regardless of whether a given row actually turned out to be SUD-class).
--
-- NEW REQUIREMENT this row-conditional path surfaces (also only caught live): the trigger function
-- is SECURITY DEFINER as wardenx_audit_writer, and its guard now SELECTs `lab_observation` — the
-- first audit trigger in the repo to read a SIBLING table. wardenx_audit_writer previously held only
-- INSERT on audit_event (no BYPASSRLS, by design — see generate.ts's header). `lab_observation`'s
-- own RLS policy is scoped `TO wardenx_app` only (0148), so a bare GRANT SELECT would still return
-- zero rows for this role under RLS. Least-privilege fix: grant SELECT plus a role-scoped,
-- org-scoped read-only policy — same `app.org_id` condition as the app policy, mirroring it rather
-- than widening it.
GRANT SELECT ON "lab_observation" TO wardenx_audit_writer;--> statement-breakpoint
DROP POLICY IF EXISTS "lab_observation_audit_writer_read" ON "lab_observation";--> statement-breakpoint
CREATE POLICY "lab_observation_audit_writer_read" ON "lab_observation"
  FOR SELECT TO wardenx_audit_writer
  USING (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_lab_observation_value() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_denylist text[] := ARRAY[]::text[];
BEGIN
  IF EXISTS (SELECT 1 FROM lab_observation lo WHERE lo.id = COALESCE(NEW.observation_id, OLD.observation_id) AND lo.sud_redacted_at_ingest = true) THEN
    v_denylist := v_denylist || ARRAY['numeric_value', 'string_value']::text[];
  END IF;
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_denylist) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_denylist) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'lab_observation_value.' || lower(TG_OP),
    'lab_observation_value',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance_42cfr_part2'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_lab_observation_value() OWNER TO wardenx_audit_writer;--> statement-breakpoint
-- Re-affirms the existing trigger→function binding (PG14+; the function body above is what actually
-- changed — this table is PARTITIONED, so the trigger must stay attached to the PARENT, which
-- CREATE OR REPLACE TRIGGER preserves — and restating it keeps this migration self-contained and
-- matches what scripts/check-audit-denylist-sync.ts parses per-file).
CREATE OR REPLACE TRIGGER "trg_audit_lab_observation_value" AFTER INSERT OR UPDATE OR DELETE ON lab_observation_value
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_lab_observation_value();
