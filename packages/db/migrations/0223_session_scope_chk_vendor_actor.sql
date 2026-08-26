-- F-030 / #75 — `session_scope_chk`: an M19 answering-service session must name the vendor it acts for.
--
-- WHAT WAS BROKEN. M19's `external_triage_actor` predicate decides whether a vendor-class session may
-- touch a triage call by comparing the SHIFT's `external_actor_id` against the SESSION's. The session
-- half was read from `context.attributes.externalActorId`, which nothing has ever written — so no
-- vendor-scoped call could be recognised as one, and every caller on that arm was refused. M19's route
-- actor documents the field as "the vendor binding a vendor-class session is scoped to. Same argument,
-- sharper: this IS the authorization subject for `external_triage_actor`, so reading it from anywhere a
-- caller can write would make the predicate decorative." It was not read from somewhere writable. It was
-- not read from anywhere at all.
--
-- WHY 0220 LEFT IT OPEN, AND WHY THAT WAS WRONG. That migration gave the two vendor classes no scope
-- requirement, like `staff`, reasoning that "an M19 answering-service session is scoped to the
-- organization and to its on-call shift, not to a patient". The first half is right and the conclusion
-- does not follow: not being PATIENT-scoped does not make a session org-scoped. It is VENDOR-scoped, and
-- nothing carried the vendor. A vendor session with no vendor on it is not a session with a wider scope,
-- it is one `external_triage_actor` can never admit — the fail-closed shape that hides in plain sight.
--
-- The requirement is `externalActorId`, matching the shape M31's portal branch already uses: the ACCOUNT
-- the session acts for is required at mint, because unlike a portal patient there is no legitimate
-- moment at which a vendor session exists without knowing its vendor. The session is minted BY the
-- vendor binding; there is no mint-then-select step to leave room for.
--
-- Dropped and recreated rather than amended (PG has no ALTER CONSTRAINT for a CHECK predicate). The
-- constraint is validated against existing rows on creation: no vendor-class session has ever been
-- writable — 0219 added the enum values and 0220 first made the class insertable — so this tightens a
-- branch that has never had a row under it.
--
-- `COALESCE(scope,'{}'::jsonb)` throughout, keeping 0220's fix: `NULL ? 'k'` is NULL and a CHECK PASSES
-- on NULL, so a bare `?` would leave this branch unenforced for exactly the row it is meant to catch —
-- one written with no scope at all.
ALTER TABLE "session" DROP CONSTRAINT "session_scope_chk";--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_scope_chk" CHECK (("session"."session_class" IN ('external_collaborator','funeral_home') AND COALESCE("session"."scope", '{}'::jsonb) ? 'patientId')
        OR ("session"."session_class" = 'auditor' AND "session"."engagement_start" IS NOT NULL AND "session"."engagement_end" IS NOT NULL)
        OR ("session"."session_class" IN ('patient_portal','caregiver_portal','bereaved_portal') AND COALESCE("session"."scope", '{}'::jsonb) ? 'portalAccountId')
        OR ("session"."session_class" IN ('external_triage_vendor','external_triage_operator') AND COALESCE("session"."scope", '{}'::jsonb) ? 'externalActorId')
        OR ("session"."session_class" = 'staff'));
