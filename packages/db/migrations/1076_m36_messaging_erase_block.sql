-- M36 WP 1.5 hardening — the per-tenant "erasing" flag that closes the late-upload race in the tenant eraser.
--
-- The race: the eraser destroys every attachment object and then deletes the rows. A presigned PUT minted (or an authorize
-- committed) between its last look and its delete lands an object whose row is gone: PHI bytes with no pointer. The fix is
-- a flag the eraser sets FIRST, under an advisory lock that `authorize`/`complete` hold in SHARED mode for the whole of their
-- transaction:
--   * the eraser takes the lock EXCLUSIVELY to insert the flag, so it waits for every in-flight authorize/complete to commit
--     (their rows are then visible to the eraser's sweeps), and
--   * every later authorize/complete takes the shared lock, sees the committed flag, and refuses.
-- Upload URLs minted BEFORE the flag stay valid until their own expiry; the eraser refuses (retryably) until they have all
-- expired, then destroys. After that nothing can create an object for the tenant, so the delete cannot orphan one.
--
-- The flag is one row per org. Both credentials the eraser may run on can SET it (the supported one is wardenx_destruction;
-- the app role is allowed too so an erase of an org with no attachments still works there), and NOBODY can clear it
-- (no UPDATE/DELETE grant): an org whose erasure started is never uploaded to again. RLS confines every role to its own org,
-- so the worst a compromised app session can do is stop uploads for its own tenant. It is a marker, not a PHI row.

CREATE TABLE "messaging_erase_block" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organization"("id") ON DELETE CASCADE,
  "blocked_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

ALTER TABLE "messaging_erase_block" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messaging_erase_block" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

GRANT SELECT, INSERT ON "messaging_erase_block" TO wardenx_app;--> statement-breakpoint
CREATE POLICY "messaging_erase_block_org_isolation" ON "messaging_erase_block"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

GRANT SELECT, INSERT ON "messaging_erase_block" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "messaging_erase_block_destruction" ON "messaging_erase_block"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
--> statement-breakpoint

-- Write audit (M4 generator shape): the moment a tenant's messaging erasure began is itself an auditable fact. The row
-- carries no PHI, so nothing is scrubbed.
CREATE OR REPLACE FUNCTION audit_phi_write_messaging_erase_block() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'messaging_erase_block.' || lower(TG_OP), 'messaging_erase_block',
    COALESCE(NEW.organization_id, OLD.organization_id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_messaging_erase_block() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_messaging_erase_block"
  AFTER INSERT OR UPDATE OR DELETE ON messaging_erase_block
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_messaging_erase_block();
