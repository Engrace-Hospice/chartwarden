-- M23 (FY2027 workstream E) — the per-provider-entity, per-fiscal-year HQRP compliance declaration on the
-- hospice rate table.
--
-- A hospice that failed its Hospice Quality Reporting Program requirements is paid the national rates reduced
-- by 4 percentage points of the annual update (42 CFR 418.306(b)(2); FY2027: +2.3% compliant vs -1.7%
-- non-compliant, CMS-1851-F 91 FR 49118). The rate table is already one version per (provider entity,
-- fiscal year), so the declaration lives ON the version: `hqrp_compliant` says which national column the keyed
-- rates are meant to be, and the rate-table service warns (never blocks) when they match the other column or
-- neither (`checkRatesAgainstNationalReference` in @wardenx/billing). NULLable: versions entered before this
-- column existed are "undeclared", which the check reports as such rather than guessing.
--
-- The column joins the append-only freeze (CREATE OR REPLACE of the 0280 guard, which is otherwise unchanged):
-- a wrong declaration is corrected by SUPERSEDING the version, exactly like a wrong rate. The table-level
-- `GRANT SELECT, INSERT` (0279) already covers the new column for wardenx_app; the column-level UPDATE grant
-- stays limited to the two supersede columns. Not PHI. Idempotent.

ALTER TABLE "hospice_rate_table" ADD COLUMN IF NOT EXISTS "hqrp_compliant" boolean;--> statement-breakpoint
COMMENT ON COLUMN "hospice_rate_table"."hqrp_compliant" IS
  'FY2027 workstream E: true = HQRP-compliant national rates, false = the 4-point HQRP-reduced rates (42 CFR 418.306(b)(2)), NULL = undeclared (pre-0394 version).';--> statement-breakpoint

-- The append-only guard now also freezes hqrp_compliant (CREATE OR REPLACE of 0280's function).
CREATE OR REPLACE FUNCTION hospice_rate_table_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_has_role(current_user, 'wardenx_destruction', 'MEMBER')
       AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'hospice_rate_table cannot be deleted (only the destruction role may erase it)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'hospice_rate_table row is superseded and immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.provider_entity_id <> OLD.provider_entity_id
     OR NEW.fiscal_year_starting <> OLD.fiscal_year_starting
     OR NEW.effective_from <> OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
     OR NEW.rhc_days_1_60_per_diem_cents <> OLD.rhc_days_1_60_per_diem_cents
     OR NEW.rhc_days_61_plus_per_diem_cents <> OLD.rhc_days_61_plus_per_diem_cents
     OR NEW.chc_per_diem_cents <> OLD.chc_per_diem_cents
     OR NEW.irc_per_diem_cents <> OLD.irc_per_diem_cents
     OR NEW.gip_per_diem_cents <> OLD.gip_per_diem_cents
     OR NEW.chc_hourly_rate_cents <> OLD.chc_hourly_rate_cents
     OR NEW.labor_share_rhc IS DISTINCT FROM OLD.labor_share_rhc
     OR NEW.labor_share_chc IS DISTINCT FROM OLD.labor_share_chc
     OR NEW.labor_share_irc IS DISTINCT FROM OLD.labor_share_irc
     OR NEW.labor_share_gip IS DISTINCT FROM OLD.labor_share_gip
     OR NEW.hqrp_compliant IS DISTINCT FROM OLD.hqrp_compliant
     OR NEW.entered_by_membership_id <> OLD.entered_by_membership_id
     OR NEW.entry_reason IS DISTINCT FROM OLD.entry_reason
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'hospice_rate_table rates are append-only; supersede the row instead of editing it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
