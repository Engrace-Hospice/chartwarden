-- M30 GAP-088 follow-up — make the PIP / SRA close rows honest about the nominee-based one-step close.
--
-- The close is signed by the CLOSER only (session membership); the other role-slot party is merely
-- NAMED and never attests (events say so: closedBy / nominatedCosigner / cosignerAttested:false). V-11/V-12
-- forced BOTH `cosign_*_at` non-null on close, so the persisted row stamped the nominee as signed.
--
-- Additive: `closure_cosign_attested` (DEFAULT true — every EXISTING row keeps meaning "both slots signed"),
-- `closure_closed_by_membership_id`, `closure_nominee_membership_id` (nullable; membership ids, not PHI, so
-- the generic to_jsonb audit triggers need no change). The CHECK keeps its name and the old rule for
-- attested rows; a non-attested close must have the closer's slot signed, the nominee's slot `_at` NULL
-- (nomination is not attestation) and both marker ids consistent with the slot columns. Idempotent.

-- V-11 qapi_pip
ALTER TABLE qapi_pip
  ADD COLUMN IF NOT EXISTS closure_closed_by_membership_id uuid,
  ADD COLUMN IF NOT EXISTS closure_nominee_membership_id uuid,
  ADD COLUMN IF NOT EXISTS closure_cosign_attested boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE qapi_pip DROP CONSTRAINT IF EXISTS chk_qapi_pip_closure_cosign;--> statement-breakpoint
ALTER TABLE qapi_pip ADD CONSTRAINT chk_qapi_pip_closure_cosign CHECK (
  closed_at IS NULL
  OR (
    -- attested close (every pre-0335 row): both slots signed.
    closure_cosign_attested
    AND cosign_qapi_coordinator_at IS NOT NULL AND cosign_medical_director_at IS NOT NULL
  )
  OR (
    -- nominee close: exactly the closer's slot is signed; the nominee's slot holds the nominee id only.
    NOT closure_cosign_attested
    AND closure_closed_by_membership_id IS NOT NULL
    AND closure_nominee_membership_id IS NOT NULL
    AND (
      (closure_closed_by_membership_id = cosign_qapi_coordinator_membership_id AND cosign_qapi_coordinator_at IS NOT NULL
        AND closure_nominee_membership_id = cosign_medical_director_membership_id AND cosign_medical_director_at IS NULL)
      OR
      (closure_closed_by_membership_id = cosign_medical_director_membership_id AND cosign_medical_director_at IS NOT NULL
        AND closure_nominee_membership_id = cosign_qapi_coordinator_membership_id AND cosign_qapi_coordinator_at IS NULL)
    )
  )
);--> statement-breakpoint

-- V-12 sra_cycle
ALTER TABLE sra_cycle
  ADD COLUMN IF NOT EXISTS closure_closed_by_membership_id uuid,
  ADD COLUMN IF NOT EXISTS closure_nominee_membership_id uuid,
  ADD COLUMN IF NOT EXISTS closure_cosign_attested boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE sra_cycle DROP CONSTRAINT IF EXISTS chk_sra_cycle_closure_cosign;--> statement-breakpoint
ALTER TABLE sra_cycle ADD CONSTRAINT chk_sra_cycle_closure_cosign CHECK (
  closed_at IS NULL
  OR (
    -- attested close (every pre-0335 row): both slots signed.
    closure_cosign_attested
    AND cosign_security_officer_at IS NOT NULL AND cosign_compliance_officer_at IS NOT NULL
  )
  OR (
    -- nominee close: exactly the closer's slot is signed; the nominee's slot holds the nominee id only.
    NOT closure_cosign_attested
    AND closure_closed_by_membership_id IS NOT NULL
    AND closure_nominee_membership_id IS NOT NULL
    AND (
      (closure_closed_by_membership_id = cosign_security_officer_membership_id AND cosign_security_officer_at IS NOT NULL
        AND closure_nominee_membership_id = cosign_compliance_officer_membership_id AND cosign_compliance_officer_at IS NULL)
      OR
      (closure_closed_by_membership_id = cosign_compliance_officer_membership_id AND cosign_compliance_officer_at IS NOT NULL
        AND closure_nominee_membership_id = cosign_security_officer_membership_id AND cosign_security_officer_at IS NULL)
    )
  )
);
