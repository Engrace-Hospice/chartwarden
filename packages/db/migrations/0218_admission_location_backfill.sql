-- M6 Admission — backfill `admission.location_id` where the answer is unambiguous (#50, 2026-08-25).
--
-- `admission.location_id` was never written by ANY code path: no route accepted a location, no state
-- transition assigned one, nothing backfilled it. Every admission in every organization carried NULL,
-- which is the second half of the #44 siting gap (that one fixed `provider_entity_id`; there was no
-- equivalent source for a location, so it was left behind).
--
-- Consequences that made this worth a migration rather than a forward-only fix: M10 refuses to create a
-- HOPE timepoint schedule for an unsited admission (`hope_timepoint_schedule.location_id` is NOT NULL),
-- M10's D8 compensating validation finding cannot be written for the same reason, and every M9 capture
-- is recorded with a null location. Existing admissions would stay in that state forever, because
-- activation — the write that now sites them — has already happened.
--
-- THE RULE, identical to the one the application applies at activation: an admission is sited from its
-- ELECTED provider entity's active locations, and ONLY when there is exactly one. `location` carries no
-- primary/default flag, so with two or more candidates there is no defensible pick and guessing would
-- put a federal capture window (and the timezone its deadlines are computed in) at the wrong site.
--
-- ROWS LEFT ALONE, and why each is correct rather than merely convenient:
--   · `provider_entity_id IS NULL` — nothing to scope a location to. These are #44's transfer-in
--     residue; siting them needs the provider entity first.
--   · the provider entity has ZERO active locations — there is nothing to site to.
--   · the provider entity has TWO OR MORE — a human has to say which. The activation route now asks.
-- The DO block below RAISEs a WARNING with a count per reason, so an operator sees what was skipped in
-- the migration output rather than discovering it later as an empty HOPE worklist.
--
-- Idempotent: a sited row no longer matches `location_id IS NULL`. Only `active` locations count — a
-- `created` site has not opened and a `suspended`/`closed` one is not accepting patients.
--
-- Privilege: a cross-organization UPDATE, like the 0184 backfill, so it assumes a migrator that bypasses
-- RLS. `scripts/db/migrate.ts` provisions roles, so it already does. The M4 write-audit trigger fires
-- normally and records the repair in `audit_event`, which is intended.

UPDATE "admission" a
   SET "location_id" = sole."location_id",
       "updated_at" = now()
  FROM (
    -- `min()` has no uuid overload in PostgreSQL, so the sole id is taken off an aggregate array. The
    -- HAVING clause guarantees there is exactly one, which is what makes taking [1] meaningful.
    SELECT l."provider_entity_id",
           (array_agg(l."id"))[1] AS "location_id"
      FROM "location" l
     WHERE l."status" = 'active'
     GROUP BY l."provider_entity_id"
    HAVING count(*) = 1
  ) AS sole
 WHERE a."location_id" IS NULL
   AND a."provider_entity_id" IS NOT NULL
   AND a."provider_entity_id" = sole."provider_entity_id";--> statement-breakpoint

DO $$
DECLARE
  v_no_pe bigint;
  v_no_location bigint;
  v_ambiguous bigint;
BEGIN
  SELECT count(*) INTO v_no_pe
    FROM "admission" WHERE "location_id" IS NULL AND "provider_entity_id" IS NULL;

  SELECT count(*) INTO v_no_location
    FROM "admission" a
   WHERE a."location_id" IS NULL AND a."provider_entity_id" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "location" l
                      WHERE l."provider_entity_id" = a."provider_entity_id"
                        AND l."status" = 'active');

  SELECT count(*) INTO v_ambiguous
    FROM "admission" a
   WHERE a."location_id" IS NULL AND a."provider_entity_id" IS NOT NULL
     AND (SELECT count(*) FROM "location" l
           WHERE l."provider_entity_id" = a."provider_entity_id"
             AND l."status" = 'active') > 1;

  IF v_no_pe > 0 OR v_no_location > 0 OR v_ambiguous > 0 THEN
    RAISE WARNING
      'M6 #50 backfill: % admission(s) left unsited — % with no elected provider entity, % whose provider entity has no active location, % whose provider entity has several (a human must name one; re-activate or set it explicitly). An unsited admission gets no HOPE timepoint windows.',
      v_no_pe + v_no_location + v_ambiguous, v_no_pe, v_no_location, v_ambiguous;
  END IF;
END $$;
