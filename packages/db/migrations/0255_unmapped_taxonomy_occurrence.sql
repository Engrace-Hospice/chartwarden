-- unmapped_taxonomy_occurrence — M23's §11.A D13 unmapped-CARC occurrence tracker (the m23
-- `handlers-unbound` group's last remaining pair, #248 — `m25.taxonomy.unmapped_code_observed`).
--
-- M25's D13 spec: "the first occurrence of a CARC not present in M38's catalog ... generates
-- `m25.taxonomy.unmapped_code_observed` outbox to M23 (suggesting a new pre-submission validation rule
-- per architecture §11.A) ... M23 §11.A subscribes to this event; if `occurrenceCount` exceeds 50 within
-- 30 days, M23 surfaces an `unmapped_taxonomy_alert` to the platform-admin queue (D13)." No table, route
-- or consumer for this ever existed anywhere in M23 — the module's other six/seven `m23`
-- `handlers-unbound` events all reuse the already-running `revalidate.consumer` BullMQ worker, but that
-- path re-validates EXISTING claims; this is a raw observation with no claim to revalidate yet, so it
-- needs its own, smaller mechanism.
--
-- ONE ROW PER DELIVERED OCCURRENCE, not a maintained rolling counter (the `measure_recompute_queue` /
-- `dosespot_sync_queue` debounce shape does not transfer): a 30-day ROLLING window needs individual
-- occurrences to age OUT as time passes, which only a per-row history can express — a single counter row
-- has no way to "forget" an occurrence once it turns 31 days old. The read path is a plain windowed
-- `COUNT(*) WHERE observed_at >= now() - interval '30 days'`, computed at delivery time.
--
-- IDEMPOTENCY is a partial-free UNIQUE index on (organization_id, source_event_id) — the delivered
-- outbox event's own id — never a pre-read (the `denial_case_source_idempotency_key` / migration 0249
-- precedent). A redelivery of the same `m25.taxonomy.unmapped_code_observed` event inserts nothing a
-- second time and therefore cannot double-count toward the 30-day threshold.
CREATE TABLE IF NOT EXISTS "unmapped_taxonomy_occurrence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"carc_code" text NOT NULL,
	"rarc_code" text,
	"provider_entity_id" uuid NOT NULL,
	"denial_case_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unmapped_taxonomy_occurrence_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "unmapped_taxonomy_occurrence_source_event_uq"
	ON "unmapped_taxonomy_occurrence" ("organization_id", "source_event_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "unmapped_taxonomy_occurrence_org_carc_observed_idx"
	ON "unmapped_taxonomy_occurrence" ("organization_id", "carc_code", "observed_at");--> statement-breakpoint

-- RLS — the canonical app.org_id predicate (ADR-0010 D3), ENABLE + FORCE together (F-087, migration
-- 0118): FORCE is what makes the policy apply to the table's OWNER too, since `migrate.ts` connects as
-- `DATABASE_ADMIN_URL ?? DATABASE_URL` and a deployment that migrates with only DATABASE_URL set makes
-- wardenx_app the owner. NULLIF guard (migration 0246/0247 precedent) even though every real caller opens
-- `withOrgContext` first — free insurance against a pooled connection whose GUC reverted to '' rather
-- than NULL after a prior transaction.
ALTER TABLE "unmapped_taxonomy_occurrence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "unmapped_taxonomy_occurrence" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "unmapped_taxonomy_occurrence_org" ON "unmapped_taxonomy_occurrence"
	FOR ALL TO wardenx_app
	USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT ON "unmapped_taxonomy_occurrence" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "unmapped_taxonomy_occurrence" TO wardenx_admin;--> statement-breakpoint

-- Audit trigger — the `dosespot_sync_queue` / `measure_recompute_queue` precedent: no PHI column, no
-- denylist entry needed (the row carries a CARC/RARC code and a provider-entity/denial-case id, never a
-- patient or MBI), but it is still worth a compliance trail since it drives a §11.A validation-rule
-- suggestion surface.
CREATE OR REPLACE FUNCTION audit_phi_write_unmapped_taxonomy_occurrence() RETURNS trigger
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
    'unmapped_taxonomy_occurrence.' || lower(TG_OP),
    'unmapped_taxonomy_occurrence',
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
ALTER FUNCTION audit_phi_write_unmapped_taxonomy_occurrence() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_unmapped_taxonomy_occurrence" AFTER INSERT OR UPDATE OR DELETE ON unmapped_taxonomy_occurrence
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_unmapped_taxonomy_occurrence();
