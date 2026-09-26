-- M2 `session_class` — the five classes M31/M16/M19's ABAC predicates have always compared against and
-- that the enum has never contained (F-030 / #75).
--
-- WHAT WAS WRONG. `context.attributes.sessionClass` is read by M16, M19, M31 and M39. Three of them gate
-- on the caller's class being one of `patient_portal` / `caregiver_portal` / `bereaved_portal`, and M19
-- additionally on `external_triage_vendor` / `external_triage_operator`. The enum's four values are
-- staff / auditor / external_collaborator / funeral_home, so NONE of those five could ever be the value
-- of a real session — every one of those predicates denied unconditionally, and the whole M31 portal
-- ABAC surface with them. Nothing surfaced it because the readers default an absent attribute to
-- `"staff"`, which those same predicates also deny: a permanently shut door and a correctly shut door
-- return the same 403.
--
-- Additive only — no value removed, no existing row affected, every current session stays `staff`.
--
-- Own migration: PG forbids USING an enum value added earlier in the same transaction, and 0220 needs
-- these five in a CHECK predicate. The 0125 / 0183 precedent (`discharge_type`, `facility_kind`).
ALTER TYPE "public"."session_class" ADD VALUE IF NOT EXISTS 'patient_portal';--> statement-breakpoint
ALTER TYPE "public"."session_class" ADD VALUE IF NOT EXISTS 'caregiver_portal';--> statement-breakpoint
ALTER TYPE "public"."session_class" ADD VALUE IF NOT EXISTS 'bereaved_portal';--> statement-breakpoint
ALTER TYPE "public"."session_class" ADD VALUE IF NOT EXISTS 'external_triage_vendor';--> statement-breakpoint
ALTER TYPE "public"."session_class" ADD VALUE IF NOT EXISTS 'external_triage_operator';
