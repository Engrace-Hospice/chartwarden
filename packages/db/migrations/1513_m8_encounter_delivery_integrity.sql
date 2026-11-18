-- compat: contract
-- M8: integrity of the visit-delivery columns 1510 added (visit_modality*, time_source, and the documented started_at / ended_at).
-- These columns now decide money (the Medicare hospice Service Intensity Add-on counts only a confirmed in-person visit with documented
-- time), so the database, and not only the service, refuses an incoherent or after-the-fact write.
-- Declared `contract` on the conservative rule ("declare contract when unsure"; arch:migration-compat flags ADD CONSTRAINT and
-- DROP TRIGGER): the previous release never writes a post-sign delivery column and writes NULLs to the new ones, so it is in fact
-- compatible, but that is not a claim a heuristic can verify. It ships in the same release as 1512, under the same deploy
-- precondition (docs/runbooks/m23-sia-revisions-deployment.md).
-- Numbered AFTER 1510 so 1510 stays a pure expand (columns, enum, backfill, index). Every constraint below holds for every row the
-- 1510 backfill produced.

-- Coherence of the new columns, so a bad write fails in the database and not only in the service. All four columns are new, so
-- no row existing before 1510 can violate these. The ordering check covers clinician-typed times only: a legacy EVV bracket is
-- not re-judged here.
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_visit_modality_confirmation_chk" CHECK (
  ("visit_modality_confirmed_at" IS NULL) = ("visit_modality_confirmed_by" IS NULL)
  AND ("visit_modality_confirmed_at" IS NULL OR "visit_modality" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_time_source_times_chk" CHECK (
  "time_source" IS NULL OR ("started_at" IS NOT NULL AND "ended_at" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_clinician_times_ordered_chk" CHECK (
  "time_source" IS DISTINCT FROM 'clinician' OR "ended_at" > "started_at"
);--> statement-breakpoint

-- Write-once after sign. Once an encounter is signed its documented times and their source never change, and a CONFIRMED delivery
-- mode never changes; the one permitted post-sign write is the one-time confirmation of an UNCONFIRMED (legacy) visit
-- (NULL -> value). Before sign nothing is frozen: sign itself writes them, in the same UPDATE that sets signed_at.
-- SECURITY INVOKER, pinned search_path, no table references (the 1061 convention). The service already refuses these changes;
-- this makes the database refuse them too.
CREATE OR REPLACE FUNCTION m8_encounter_delivery_freeze() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.signed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
     OR NEW.time_source IS DISTINCT FROM OLD.time_source THEN
    RAISE EXCEPTION 'M8_ENCOUNTER_DELIVERY_FROZEN: the documented visit times and their source cannot change once the encounter is signed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.visit_modality_confirmed_at IS NOT NULL
     AND (NEW.visit_modality IS DISTINCT FROM OLD.visit_modality
          OR NEW.visit_modality_confirmed_at IS DISTINCT FROM OLD.visit_modality_confirmed_at
          OR NEW.visit_modality_confirmed_by IS DISTINCT FROM OLD.visit_modality_confirmed_by) THEN
    RAISE EXCEPTION 'M8_ENCOUNTER_DELIVERY_FROZEN: a confirmed visit delivery mode cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_encounter_delivery_freeze" ON "encounter";--> statement-breakpoint
CREATE TRIGGER "trg_encounter_delivery_freeze" BEFORE UPDATE ON "encounter"
  FOR EACH ROW EXECUTE FUNCTION m8_encounter_delivery_freeze();
