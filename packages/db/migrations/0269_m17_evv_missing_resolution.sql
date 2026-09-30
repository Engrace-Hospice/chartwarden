-- F-196 (#248) — M17's own EVV missing-resolution stamp, closing the `m18.evv.late_check_resolved`
-- declared-but-unbound pair.
--
-- The fact is real and already fires in production: M23 has a live, bound consumer for this exact event
-- (`m18-late-check-resolved.ts`, F-162), and M18's own catalog entry names M17/M8/M23 as real consumers
-- (M8 dropped, F-140, same seam-pull reasoning as `check_in_recorded`). M17's `visit.evv_bracket_state`
-- (`evv_present`/`evv_missing_documented`) is a push-maintained column already — M17's own two sibling EVV
-- consumers (`m18-evv-check-in.ts`, `m18-evv-at-patient-address.ts`) already write to `visit` on delivery,
-- so a push consumer is this module's established, correct mechanism for EVV facts, not a seam-vs-push
-- mismatch.
--
-- `visit_state_history` is deliberately NOT the target: its `to_state` is NOT NULL and drawn from
-- `visit_status`, used only for genuine lifecycle transitions (`m18-evv-at-patient-address.ts`'s own
-- en_route → in_visit write). A late-check resolution fires once the visit is already `completed` — it
-- does not move `status` — so writing a same-state history row would misuse that table's transition-ledger
-- semantics; this is a same-row informational stamp instead, the `transfer_event.document_id`/
-- `supply_request.caregiver_signature_*` (F-192/F-193) shape.
--
-- Three new nullable columns on `visit`, mirroring the event's own real payload
-- (`apps/backend/src/modules/18-evv/events-by-m18.ts`'s `m18.evv.late_check_resolved` schema:
-- `resolvedByMembershipId`, `status`, `resolutionReason`) rather than inventing a closed enum the source
-- payload itself does not declare (`status` is `Type.String()`, not a fixed union). `resolution_reason` is
-- free text — DENYLISTED (§3.6), the exact `evv_missing_reason` precedent four rows up in the same table —
-- mirrored into `packages/types/src/scheduling.ts`'s `M17_AUDIT_DENYLIST.visit` and registered in
-- `scripts/check-audit-denylist-sync.ts`'s M17 migration list in the SAME change so `arch:audit-denylist-
-- sync` stays green.
--
-- `visit` is PARTITIONED BY RANGE (service_date) monthly (migration 0045); ALTER TABLE on the PARENT
-- propagates the new columns to every leaf (PG11+, the 0266/0131/0268 precedent). No new FK: the acting
-- membership is a LOGICAL M1 reference, matching every other `*_membership_id` column on this table
-- (`cancelled_by_membership_id` etc.) — app-validated, not a SQL FK.
ALTER TABLE "visit"
  ADD COLUMN IF NOT EXISTS "evv_missing_resolution_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visit"
  ADD COLUMN IF NOT EXISTS "evv_missing_resolution_status" text;--> statement-breakpoint
ALTER TABLE "visit"
  ADD COLUMN IF NOT EXISTS "evv_missing_resolution_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "visit"
  ADD COLUMN IF NOT EXISTS "evv_missing_resolution_reason" text;--> statement-breakpoint

-- Extend migration 0045's M4 write-audit trigger denylist: `evv_missing_resolution_reason` is free text by
-- construction (M18's own catalog: "`resolutionReason` is denylisted in audit"), so it is scrubbed from the
-- audit diff the same way `evv_missing_reason` already is. The row itself (not the audit diff) stays the
-- durable evidentiary record.
CREATE OR REPLACE FUNCTION audit_phi_write_visit() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['scheduler_internal_notes','cancellation_reason','reschedule_reason',
    'no_show_reason','evv_missing_reason','evv_missing_resolution_reason']::text[];
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
    'user',
    'visit.' || lower(TG_OP),
    'visit',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'operational'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_visit() OWNER TO wardenx_audit_writer;--> statement-breakpoint
-- Re-affirms the existing trigger→function binding (the function body above is what actually changed;
-- CREATE OR REPLACE FUNCTION alone would suffice) — restating it keeps this migration self-contained and
-- matches what scripts/check-audit-denylist-sync.ts parses per-file (the 0163/0268 precedent).
CREATE OR REPLACE TRIGGER "trg_audit_visit" AFTER INSERT OR UPDATE OR DELETE ON visit
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_visit();
