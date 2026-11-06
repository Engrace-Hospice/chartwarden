-- compat: expand
-- M35 (slice 2) - the staff ledger records, per pseudonym and month, whether EVERY sign-in observed was by a membership whose grants were
-- all non-staff (the system auditor role, a platform-owned role). The exclusion is therefore decided when the sign-in is OBSERVED, not
-- from today's grants at statement time: a tenant administrator who swaps a member to auditor-only after the member worked as staff (in
-- the month or in the grace window before it finalizes) cannot take that member off the bill. A staff sign-in makes the month staff and a
-- later non-staff one does not undo it (the upsert ANDs the flag). false = staff, the default and what every pre-existing row means.
-- A flag on a pseudonymized row: it identifies no one.
ALTER TABLE "user_active_period" ADD COLUMN "non_staff_observed" boolean NOT NULL DEFAULT false;
