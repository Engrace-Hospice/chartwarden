-- F-226 (#248) — the F2F window needs a REAL period start. `election_period.expected_start` is the benefit
-- period's expected first day = the PRECEDING period's `scheduled_end_at` + 1 calendar day (benefit periods
-- are contiguous, 42 CFR 418.21(a); M6 §2.3.2 `setActive`). A pending recert period has no `effective_at`
-- until activation, so before this column the R-F2F-02 window [start-30, start-1] could not be computed
-- when the F2F was completed, and `completeF2f` persisted `within_window = true` unconditionally (F-217).
--
-- Part 1: the column (nullable; NULL = not derivable and for every activated period).
-- Part 2: derive it for not-yet-activated periods (status pending/signed, sequence >= 2) from the prior
--         period's `scheduled_end_at` where that is set. Activated/completed periods are left alone: their
--         start is already `effective_at` and nothing reads their expected_start.
-- Part 3: repair the bogus always-true `face_to_face_encounter.within_window` on NOT-YET-ACTIVATED periods
--         only (the activation gate is the only reader that matters; signed history is not re-judged).
--         Recomputed from `encounter_date` vs `expected_start` with the R-F2F-02 arithmetic
--         (1 <= expected_start - encounter_date <= 30). Where it cannot be derived (no encounter_date, or no
--         expected_start) the value is set to NULL, which the gate treats as unverified = fail closed.
--         NOTE: legacy `encounter_date` was stamped by `completeF2f` as the COMPLETION day, not a
--         clinician-reported encounter date; it is the only evidence on file (compliance to confirm).
-- Idempotent: ADD COLUMN IF NOT EXISTS; part 2 touches only NULL expected_start; part 3 is a pure function of
-- (encounter_date, expected_start) so re-running it rewrites the same values (IS DISTINCT FROM guard skips
-- unchanged rows). Cross-organization UPDATE: assumes the RLS-bypassing migrator like 0218; the M6 write-audit
-- triggers fire normally and record the repair in `audit_event`.
ALTER TABLE "election_period"
ADD COLUMN IF NOT EXISTS "expected_start" date;--> statement-breakpoint

UPDATE "election_period" ep
   SET "expected_start" = (prior."scheduled_end_at" + 1)
  FROM "election_period" prior
 WHERE ep."expected_start" IS NULL
   AND ep."status" IN ('pending', 'signed')
   AND ep."sequence_number" >= 2
   AND prior."admission_id" = ep."admission_id"
   AND prior."organization_id" = ep."organization_id"
   AND prior."sequence_number" = ep."sequence_number" - 1
   AND prior."scheduled_end_at" IS NOT NULL;--> statement-breakpoint

UPDATE "face_to_face_encounter" f
   SET "within_window" = CASE
         WHEN f."encounter_date" IS NOT NULL AND ep."expected_start" IS NOT NULL
           THEN (ep."expected_start" - f."encounter_date") BETWEEN 1 AND 30
         ELSE NULL
       END
  FROM "election_period" ep
 WHERE ep."id" = f."election_period_id"
   AND ep."organization_id" = f."organization_id"
   AND ep."status" IN ('pending', 'signed')
   AND f."status" IN ('completed', 'attested')
   AND f."within_window" IS DISTINCT FROM CASE
         WHEN f."encounter_date" IS NOT NULL AND ep."expected_start" IS NOT NULL
           THEN (ep."expected_start" - f."encounter_date") BETWEEN 1 AND 30
         ELSE NULL
       END;
