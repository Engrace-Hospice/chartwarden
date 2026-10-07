-- M5 §4.3 — a patient's care team needs RNs beyond the one RN case manager (`primary_rn`, at most one
-- open per patient via `patient_assignment_primary_rn_unique`). `rn` is a visiting/staff RN: any number
-- may be open per patient, and only the per-(patient, clinician, role) open-duplicate guard applies.
-- Its own migration: a new enum value must be committed before anything uses it.
ALTER TYPE "public"."patient_assignment_role" ADD VALUE IF NOT EXISTS 'rn' AFTER 'primary_rn';
