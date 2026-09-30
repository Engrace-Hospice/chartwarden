-- F-207 (#248) — M27: the M21 vendor-invoice forward seam (M21 spec §1.1 D16 — "Does M21 own vendor
-- invoice reconciliation?") is bound. `m21.supply_request.invoice_accrued`/`.invoice_reconciled` have
-- declared m27 a consumer since M21 locked; nothing ever subscribed (m27 `handlers-unbound` group,
-- scripts/outbox-deferred-consumers.ts, #248).
--
-- NEW 4TH COST-BASIS PRECEDENCE TIER, additive to D17's existing M13 administration -> M12 ordered ->
-- manual entry chain for drug/supply cost lines: an M21 vendor invoice for a supply_request (DME,
-- comfort-kit restock, or general supply) is a real, EHR-tracked fact that is NOT reflected through
-- either the M13 administration seam or the M12 DoseSpot-ordered seam (neither covers a bulk vendor
-- invoice for kit/DME stock), and is not yet reflected in the Xero-derived trial balance either (the
-- invoice was just accrued/reconciled in M21, independent of whether/when it lands in the GL). This
-- table is the durable, queryable SOURCE row for that 4th tier -- mirroring `bad_debt_record`'s own
-- shape (a per-transaction financial fact scoped to one cost_report, feeding a worksheet line a human
-- preparer still populates by hand, since no worksheet in this codebase is auto-computed from ANY
-- source yet -- confirmed directly, `putWorksheet` accepts caller-supplied data wholesale). Ranked
-- LAST (tier 4) behind M13/M12/manual: unlike administration/ordered facts, a vendor invoice for kit or
-- DME stock cannot be attributed to a specific patient's specific dose, so it is the least clinically-
-- traceable of the four sources and only fills the residual gap the other three leave.
--
-- FISCAL-YEAR RESOLUTION: the source events carry `providerEntityId` + `accruedAt`/`reconciledAt` but
-- no `costReportId` (they fire continuously all year, unlike `bad_debt_record`'s human entry against an
-- already-open report) -- resolved at consume time to the `cost_report` row whose
-- `[fiscal_year_start_date, fiscal_year_end_date]` window contains the fact date, scoped by
-- `provider_entity_id` (§27 D1's composite-uniqueness anchor). A fact landing outside every existing
-- cost report's window (no report open yet for that year) is a dead-letter, not a guess -- see the
-- consumer's own header.
--
-- NO PHI (D18): the source events are patient-scoped (`patientId`), but `supply_request_id`/`vendor_id`
-- are opaque ids and `patientId` is deliberately NEVER carried onto this row, matching `bad_debt_record`
-- and every other M27-owned table's no-PHI invariant.
--
-- IDEMPOTENT BY CONSTRUCTION: one row per (organization_id, supply_request_id) -- `.invoice_accrued`
-- INSERTs (or no-ops on redelivery, `ON CONFLICT DO NOTHING`, since the accrual fact never changes once
-- written), `.invoice_reconciled` UPDATEs the same row (idempotent: a redelivery re-applies the same
-- reconciled amount/variance).

CREATE TYPE "m27_vendor_invoice_status" AS ENUM ('accrued', 'reconciled');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vendor_invoice_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cost_report_id" uuid NOT NULL,
	"supply_request_id" uuid NOT NULL,
	"vendor_id" uuid,
	"status" "m27_vendor_invoice_status" DEFAULT 'accrued' NOT NULL,
	"accrued_amount_cents" bigint NOT NULL,
	"reconciled_amount_cents" bigint,
	"variance_cents" integer,
	"accrued_at" timestamp with time zone NOT NULL,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_vendor_invoice_line_org_supply_request" UNIQUE("organization_id","supply_request_id"),
	CONSTRAINT "vendor_invoice_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "vendor_invoice_line_cost_report_id_cost_report_id_fk" FOREIGN KEY ("cost_report_id") REFERENCES "public"."cost_report"("id") ON DELETE cascade
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_vendor_invoice_line_org_report" ON "vendor_invoice_line" ("organization_id","cost_report_id");--> statement-breakpoint

-- RLS — the canonical app.org_id predicate (ADR-0010 D3), ENABLE + FORCE together (F-087/0118 precedent).
ALTER TABLE "vendor_invoice_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "vendor_invoice_line" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "vendor_invoice_line_org" ON "vendor_invoice_line"
	FOR ALL TO wardenx_app
	USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "vendor_invoice_line" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "vendor_invoice_line" TO wardenx_admin;--> statement-breakpoint

-- Audit trigger — no PHI column, retention class `compliance` (the `bad_debt_record`/`cost_report`
-- precedent: a financial fact feeding a CMS cost report is retained 7 years regardless of PHI status).
CREATE OR REPLACE FUNCTION audit_phi_write_vendor_invoice_line() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'vendor_invoice_line.' || lower(TG_OP),
    'vendor_invoice_line',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'cost_report_id', COALESCE(NEW.cost_report_id, OLD.cost_report_id)),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_vendor_invoice_line() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_vendor_invoice_line" AFTER INSERT OR UPDATE OR DELETE ON vendor_invoice_line
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_vendor_invoice_line();
