-- M5 §4.3 — the actor who creates a patient from a referral (intake / admissions / admin) must be able to open the
-- chart and admission they just made, and `caseload_or_scope` / `admission.scope` decide that by an OPEN
-- `patient_assignment`. Those users are not clinicians, so none of the clinical roles fits: `rn`/`primary_rn` would make
-- an admin look like (and be paged as) a nurse, `md`/`attending_clinician` would feed the IDG physician reader.
-- `admitting_staff` is the non-clinical care-team role for exactly that grant; any number may be open per patient.
-- Its own migration: a new enum value must be committed before anything uses it.
ALTER TYPE "public"."patient_assignment_role" ADD VALUE IF NOT EXISTS 'admitting_staff';
