-- M8 `hearthnote_selection` — make the table writable by the authoring path, and make its "one row per
-- parent" claim true (F-048 / #114).
--
-- WHAT WAS WRONG. `PATCH /api/v1/encounters/:id/selections` and its addendum twin publish
-- `UpdateSelectionsSchema` as `required: true`, parse only their path params, bump `version`, and return
-- 200. The clinician's note was accepted and discarded. Nothing has ever written a `hearthnote_selection`
-- row — the only code that touched the three hearthnote tables was the ERASER — and the module said so in
-- its own header ("no `hearthnote_selection`/Layer-2 row is written"). A missing read fails visibly; a
-- write that returns success and drops its payload does not, and what it drops here is the clinical
-- narrative of a signed encounter (42 CFR 418.104).
--
-- Two shape problems stood between the route and the row, both invisible while nothing wrote:
--
-- 1. THE SITING PAIR. `provider_entity_id` / `location_id` are NOT NULL here, but 0128 relaxed exactly
--    this pair on the parent `encounter` (and on vitals / mileage / addendum / cosignature_request) with
--    the reasoning that "the draft route captures neither and the M6 admission may itself be unsited". A
--    child that DENORMALIZES the parent's siting cannot require what the parent may not have, so every
--    encounter created through the API today would be unable to hold a note. `hearthnote_selection` was
--    left out of 0128 only because the write lifecycle did not reach it. It does now. The two remaining
--    hearthnote tables are deliberately NOT relaxed: they are the finalize/assembly path, which still
--    writes nothing, and relaxing a constraint no writer has yet met would be guessing.
--
-- 2. THE UNIQUE INDEXES THAT ARE NOT UNIQUE. `hearthnote_selection_encounter_unique_idx` and its addendum
--    twin were created by 0030 as PLAIN partial indexes whose names say UNIQUE, and the Drizzle model
--    declares them with `index(...)` rather than `uniqueIndex(...)` — so the table's stated invariant
--    ("belongs to exactly one parent", one row per parent) was enforced by nothing. With no writer that
--    is harmless. With one it is not: an upsert needs a conflict target, and without uniqueness a second
--    PATCH inserts a SECOND selection row for the same encounter and every reader afterwards has to guess
--    which one is the note. Recreated as partial UNIQUE indexes under the same names.
--
-- Safe to apply unconditionally: the table has never held a row, so neither the NULL relaxation nor the
-- uniqueness promotion can conflict with existing data.
ALTER TABLE "hearthnote_selection" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hearthnote_selection" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "hearthnote_selection_encounter_unique_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "hearthnote_selection_addendum_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "hearthnote_selection_encounter_unique_idx"
  ON "hearthnote_selection" USING btree ("encounter_id") WHERE encounter_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hearthnote_selection_addendum_unique_idx"
  ON "hearthnote_selection" USING btree ("addendum_id") WHERE addendum_id IS NOT NULL;
