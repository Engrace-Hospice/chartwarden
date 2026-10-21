-- 1143 — rename the remaining wardenx_* database objects to chartwarden_* (ChartWarden rebrand, PR-B).
--
-- A fully migrated catalog holds exactly four such objects (everything else was renamed by 1139, the roles):
--   function       wardenx_audit_trigger()                  -> chartwarden_audit_trigger()   (144 triggers bound)
--   function       wardenx_secure_new_partition()           -> chartwarden_secure_new_partition()
--   event trigger  wardenx_secure_new_partition_trg         -> chartwarden_secure_new_partition_trg
--   function       wardenx_tenant_step_up_tighten_only()    -> chartwarden_tenant_step_up_tighten_only() (1 trigger)
-- There are no wardenx_* tables, views, sequences, indexes, constraints, types, policies, schemas or
-- extensions, and no function body calls any of the three functions by name.
--
-- ALTER FUNCTION ... RENAME and ALTER EVENT TRIGGER ... RENAME keep the OID, so every pg_trigger row
-- (tgfoid), the event trigger (evtfoid), the owner, ACL, SECURITY DEFINER flag and proconfig carry over
-- untouched; no trigger is dropped or re-created, so none can be missed.
--
-- Applied migrations 0004..1138 still say `EXECUTE FUNCTION wardenx_audit_trigger()` in their CREATE TRIGGER
-- text. That is harmless: they run BEFORE this file on any fresh replay, and an already-migrated database
-- never re-runs them. A migration numbered after this one must use the new names; arch:ddl
-- (scripts/check-ddl-legality.ts, rule legacy-db-object-name) fails the build otherwise.
--
-- Idempotent: each rename happens only when the old object exists and the new one does not.

DO $$
DECLARE
  pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['wardenx_audit_trigger', 'chartwarden_audit_trigger'],
    ['wardenx_secure_new_partition', 'chartwarden_secure_new_partition'],
    ['wardenx_tenant_step_up_tighten_only', 'chartwarden_tenant_step_up_tighten_only']
  ]
  LOOP
    IF EXISTS (SELECT FROM pg_proc p WHERE p.proname = pair[1] AND p.pronamespace = 'public'::regnamespace
                 AND oidvectortypes(p.proargtypes) = '')
       AND NOT EXISTS (SELECT FROM pg_proc p WHERE p.proname = pair[2] AND p.pronamespace = 'public'::regnamespace
                 AND oidvectortypes(p.proargtypes) = '') THEN
      EXECUTE format('ALTER FUNCTION public.%I() RENAME TO %I', pair[1], pair[2]);
    END IF;
  END LOOP;

  IF EXISTS (SELECT FROM pg_event_trigger WHERE evtname = 'wardenx_secure_new_partition_trg')
     AND NOT EXISTS (SELECT FROM pg_event_trigger WHERE evtname = 'chartwarden_secure_new_partition_trg') THEN
    ALTER EVENT TRIGGER wardenx_secure_new_partition_trg RENAME TO chartwarden_secure_new_partition_trg;
  END IF;
END $$;
