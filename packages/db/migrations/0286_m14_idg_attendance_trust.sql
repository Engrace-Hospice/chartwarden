-- M14 IDG spec extension — ATTENDANCE TRUST. `POST /idg/meetings/:id/attendance` used to accept ANY membership under
-- ANY free-text discipline from any `idg.attend` holder, and both the §2.7 quorum and the per-discipline note
-- authorization trust that roster. The route now (a) restricts a non-coordinator to their OWN membership, (b) validates
-- the discipline against the target's authoritative M3 role keys, and (c) lets a coordinator (the roster keeper) record
-- a discipline the person does not hold ONLY as an explicit, flagged ATTESTATION.
--
-- Two additive columns record who wrote the row and whether it was an attested override:
--   * recorded_by_membership_id — the acting membership (NULL = legacy row written before this migration).
--   * discipline_attested       — true when a coordinator attested a discipline the member's roles do not confer.
-- Existing rows are GRANDFATHERED: recorded_by NULL, discipline_attested false — they keep counting toward quorum
-- exactly as before. Neither column is free text (no audit-denylist change). Tenancy/RLS/grants are UNCHANGED (same
-- table: wardenx_app keeps SELECT/INSERT/UPDATE, NO DELETE; FORCE RLS from 0043/0282-era migrations). Idempotent.

ALTER TABLE "idg_attendance" ADD COLUMN IF NOT EXISTS "recorded_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "idg_attendance" ADD COLUMN IF NOT EXISTS "discipline_attested" boolean DEFAULT false NOT NULL;
