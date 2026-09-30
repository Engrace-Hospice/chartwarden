-- on_call_roster_sync_queue — M19's §4.5 path 1 / §4.8 `m19.shift-sync.debounced` debounce table
-- (m19 `handlers-unbound` group, #248; F-155's own finding, now built). `reconcileOnCallRoster` +
-- `decideRosterSyncTrigger` (`apps/backend/src/modules/19-oncall/roster/shift-sync.ts`) have been a
-- complete, pure, well-documented reconciliation core since M19-T04 with NO caller: M19 shipped with no
-- `jobs/` directory at all, so the spec's `m19.shift-sync.debounced` queue existed in no form and no
-- proactive on-call roster sync had ever run off an `m17.visit.assigned` delivery.
--
-- TRUE DEBOUNCE via `run_after`, not merely the `dosespot_sync_queue`/`measure_recompute_queue` partial-
-- unique dedupe (migrations 0253/0062, F-150/#248) — the spec's "debounced 30 s" means 30 SECONDS OF
-- QUIET, so every new `m17.visit.assigned` delivery must RESET the deadline, which a BullMQ `jobId` dedupe
-- cannot express at all. `run_after` is bumped forward on every trigger by the enqueue's
-- `ON CONFLICT ... DO UPDATE`; the drain worker only claims a row whose `run_after <= now()`.
--
-- ONE PENDING ROW PER ORGANIZATION (not per ProviderEntity) — `shift-sync.ts`'s own debounce key is
-- `m19.shift-sync:${organizationId}`, because M17's `tonightsOnCallRoster` read is org-keyed and one
-- drained row reconciles every ProviderEntity in the org via `tenant_oncall_policy`. See the schema
-- file's own header (`packages/db/src/schema/oncall/on-call-roster-sync-queue.ts`) for the full reasoning,
-- including why the periodic "shift cron tick" catch-up trigger shares this SAME table (a `cron_catchup`
-- row, `ON CONFLICT DO NOTHING`, never bumping an in-flight debounce) rather than a second mechanism.
CREATE TABLE IF NOT EXISTS "on_call_roster_sync_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_after" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"triggering_event_outbox_id" uuid,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	CONSTRAINT "on_call_roster_sync_queue_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "on_call_roster_sync_queue_reason_chk"
		CHECK ("reason" IN ('m17_visit_assigned', 'cron_catchup')),
	CONSTRAINT "on_call_roster_sync_queue_status_chk"
		CHECK ("status" IN ('pending', 'processing', 'completed', 'failed'))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "on_call_roster_sync_queue_pending_uq"
	ON "on_call_roster_sync_queue" ("organization_id")
	WHERE "status" = 'pending';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "on_call_roster_sync_queue_org_status_ix"
	ON "on_call_roster_sync_queue" ("organization_id", "status", "run_after");--> statement-breakpoint

-- RLS — the canonical app.org_id predicate (ADR-0010 D3), ENABLE + FORCE together (F-087, migration
-- 0118): FORCE is what makes the policy apply to the table's OWNER too, since `migrate.ts` connects as
-- `DATABASE_ADMIN_URL ?? DATABASE_URL` and a deployment that migrates with only DATABASE_URL set makes
-- wardenx_app the owner. NULLIF guard (migration 0246/0247 precedent, restated by 0253) even though every
-- real caller in this pass opens `withOrgContext` first — free insurance against a pooled connection whose
-- GUC reverted to '' rather than NULL after a prior transaction.
ALTER TABLE "on_call_roster_sync_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "on_call_roster_sync_queue" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "on_call_roster_sync_queue_org" ON "on_call_roster_sync_queue"
	FOR ALL TO wardenx_app
	USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "on_call_roster_sync_queue" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "on_call_roster_sync_queue" TO wardenx_admin;--> statement-breakpoint

-- Audit trigger — the `dosespot_sync_queue` / `measure_recompute_queue` precedent: no PHI column, no
-- denylist entry needed, but the row still records who/what enqueued and drained a roster-sync pass
-- against a named org, which is worth a compliance trail on its own (`on_call_shift` itself already
-- carries `compliance` retention — CoP 418.100(c)(2) evidence — and this is the queue that populates it).
CREATE OR REPLACE FUNCTION audit_phi_write_on_call_roster_sync_queue() RETURNS trigger
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
    'on_call_roster_sync_queue.' || lower(TG_OP),
    'on_call_roster_sync_queue',
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
ALTER FUNCTION audit_phi_write_on_call_roster_sync_queue() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_on_call_roster_sync_queue" AFTER INSERT OR UPDATE OR DELETE ON on_call_roster_sync_queue
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_on_call_roster_sync_queue();
