-- `session_scope_chk` — admit the five classes 0219 added (F-030 / #75).
--
-- The original constraint enumerates every legal class, so it REJECTS anything it does not name: with
-- 0219 alone, inserting a portal or vendor session fails the CHECK. This is the other half of that
-- migration, split only because PG forbids using a new enum value in the transaction that added it.
--
-- The scope rule per class, and why:
--
--   portal (patient_portal / caregiver_portal / bereaved_portal)
--     `scope ? 'portalAccountId'` is REQUIRED — a portal session is meaningless without the account it
--     acts for, and M31's `portalAccountIdOf` throws 403 rather than fall back to a request parameter.
--     `scope.patientId` is NOT required: a portal session exists before `select-patient` binds its one
--     patient (M31 §2.3 / D2), and M31's actor documents `portalPatientId` as "null before
--     select-patient". Requiring it here would make the mint-then-select flow unrepresentable.
--
--   vendor (external_triage_vendor / external_triage_operator)
--     No additional requirement, like `staff`. An M19 answering-service session is scoped to the
--     organization and to its on-call shift, not to a patient.
--
-- Dropped and recreated rather than amended: PG has no ALTER CONSTRAINT for a CHECK predicate, and the
-- constraint is validated against existing rows on creation — every current row is `staff` and satisfies
-- the unchanged branches, so this is not a rewrite risk.
--
-- ALSO FIXES A PRE-EXISTING HOLE, found by testing this constraint against a real database rather than
-- reading it. `scope ? 'patientId'` on a NULL `scope` is NULL, not false; `NULL OR false OR false` is
-- NULL; and **a CHECK constraint passes when its expression is NULL**. So the collaborator/funeral
-- branch has never enforced anything for a row with no `scope` at all — an `external_collaborator`
-- session (a one-time magic link that exists precisely to be pinned to ONE patient) could be written
-- unpinned, and `sessionPinnedPatientId` then reads it as not pinned. Confirmed by insert, not inferred.
-- Every `?` test is now wrapped in `COALESCE(scope,'{}'::jsonb)`, which yields false rather than NULL.
--
-- The app-layer mirror (`isSessionScopeValid`, @chartwarden/auth) never had this hole — it tests
-- `typeof scope?.patientId === "string"`, which is false for a null scope. The defense-in-depth layer
-- was the strict one and the DB floor was the loose one, which is the opposite of how that pair is
-- meant to work and is why the gap survived: anything going through the auth layer was fine.
ALTER TABLE "session" DROP CONSTRAINT "session_scope_chk";--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_scope_chk" CHECK (("session"."session_class" IN ('external_collaborator','funeral_home') AND COALESCE("session"."scope", '{}'::jsonb) ? 'patientId')
        OR ("session"."session_class" = 'auditor' AND "session"."engagement_start" IS NOT NULL AND "session"."engagement_end" IS NOT NULL)
        OR ("session"."session_class" IN ('patient_portal','caregiver_portal','bereaved_portal') AND COALESCE("session"."scope", '{}'::jsonb) ? 'portalAccountId')
        OR ("session"."session_class" IN ('external_triage_vendor','external_triage_operator'))
        OR ("session"."session_class" = 'staff'));
