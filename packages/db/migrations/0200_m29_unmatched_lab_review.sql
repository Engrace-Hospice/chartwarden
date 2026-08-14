-- M29 §4.2 / §5.2.4 (GAP-044) — the unmatched-lab review queue's ENTRANCE and EXIT.
--
-- WHERE THE MODEL WENT. The spec (§6 outcome table) says an unmatched lab becomes a `lab_observation`
-- with `patient_id = NULL`, and the §4.2 routes are keyed on that row's id. The T02 schema made
-- `patient_id` NOT NULL — correctly, and architecture wins: ARCH-011 also forces `provider_entity_id`
-- NOT NULL on any patient-bearing table, and an unmatched result HAS no patient, therefore no resolvable
-- agency. There is no honest way to write that row before a human names the patient.
--
-- So the attach planner returned NOTHING for an unmatched lab except an outbox descriptor: no observation,
-- no values, no link row. The review queue read `lab_observation_inbound_link` — a table an unmatched lab
-- never produced a row in — so the queue was permanently EMPTY, and both exit routes threw a 501 with a
-- comment pointing at T-29.13, which is a FRONTEND task that never owned this work.
--
-- WHAT THIS MIGRATION ENABLES. The `lab_observation` PARENT is deferred, not the result. At ingest an
-- unmatched lab RESERVES an observation id and writes its OBX rows to `lab_observation_value` (which
-- carries its own `organization_id`, its own RLS policy and its own audit trigger, and needs no patient)
-- plus one `lab_observation_inbound_link` row with `match_method='unmatched'` and the cascade candidate.
-- The reviewer sees real result values — §5.2.4 requires the detail panel to show them, which an
-- id-and-LOINC-only queue could never do. The bind materializes the parent under the reserved id once the
-- patient (and therefore the agency) is known, and flips `match_method` to the already-existing `manual`
-- enum member the T02 schema reserved for exactly this.
--
-- The four columns below are the queue's EXIT: which way it left, when, by whom, and why. `resolved_at IS
-- NULL` is the queue predicate. Discarded rows are retained (§8: 180 days for unmatched-then-discarded)
-- but stop surfacing — the spec's own wording.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lab_unmatched_resolution') THEN
    CREATE TYPE "lab_unmatched_resolution" AS ENUM ('manually_matched', 'discarded');
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "lab_observation_inbound_link"
  ADD COLUMN IF NOT EXISTS "resolution" "lab_unmatched_resolution";--> statement-breakpoint
ALTER TABLE "lab_observation_inbound_link"
  ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lab_observation_inbound_link"
  ADD COLUMN IF NOT EXISTS "resolved_by_membership_id" uuid;--> statement-breakpoint
-- The bind's optional note and the discard's REQUIRED reason share one column: both are the reviewer's
-- justification for how this result left the queue, and the §164.528 record wants them side by side.
ALTER TABLE "lab_observation_inbound_link"
  ADD COLUMN IF NOT EXISTS "resolution_reason" text;--> statement-breakpoint

-- All-or-nothing: a row is unresolved, or it names its resolution, its instant AND its reviewer. A
-- half-written exit ("resolved, by nobody") is the shape that makes a queue's audit trail useless.
ALTER TABLE "lab_observation_inbound_link"
  DROP CONSTRAINT IF EXISTS "lol_resolution_consistent";--> statement-breakpoint
ALTER TABLE "lab_observation_inbound_link"
  ADD CONSTRAINT "lol_resolution_consistent" CHECK (
    ("resolution" IS NULL AND "resolved_at" IS NULL AND "resolved_by_membership_id" IS NULL)
    OR ("resolution" IS NOT NULL AND "resolved_at" IS NOT NULL AND "resolved_by_membership_id" IS NOT NULL)
  );--> statement-breakpoint

-- §5.2.4: "Discard records m29.lab_observation.discarded and requires a reason ≥10 chars." Enforced at
-- the boundary too (the route's TypeBox), but the column is where a worklist five years from now still
-- has to be able to answer "why was this result thrown away".
ALTER TABLE "lab_observation_inbound_link"
  DROP CONSTRAINT IF EXISTS "lol_discard_reason_required";--> statement-breakpoint
ALTER TABLE "lab_observation_inbound_link"
  ADD CONSTRAINT "lol_discard_reason_required" CHECK (
    "resolution" IS DISTINCT FROM 'discarded'
    OR ("resolution_reason" IS NOT NULL AND length(btrim("resolution_reason")) >= 10)
  );--> statement-breakpoint

-- The queue read: unresolved links, newest first, per org.
CREATE INDEX IF NOT EXISTS "idx_lol_unresolved"
  ON "lab_observation_inbound_link" ("organization_id", "created_at" DESC)
  WHERE "resolved_at" IS NULL;--> statement-breakpoint

-- A bind writes the deferred `lab_observation` parent under the id the link already reserved, so a second
-- concurrent bind of the same queue item must lose. The link row is the lock: `UPDATE … WHERE resolved_at
-- IS NULL` is the atomic claim, and this index makes the (org, observation) lookup that precedes it exact.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_lol_org_observation"
  ON "lab_observation_inbound_link" ("organization_id", "observation_id");
