-- M30 GAP-046 — restore the two-person close: PIP (V-11) and SRA cycle (V-12) closes are now PENDING until the
-- nominee confirms in their OWN authenticated, step-up-fresh session.
--
-- 0335 relaxed V-11/V-12 so a one-step "nominee close" could persist `closed_at` with the nominee's `*_at` NULL.
-- That let one person close the record alone. The service no longer does that:
--   • initiate  — the closer stamps their own slot and names the nominee; `closed_at` stays NULL (PENDING:
--                 `closure_nominee_membership_id` set, nominee slot `_at` NULL, `closure_cosign_attested` false).
--   • confirm   — the nominee, authenticated as themselves, stamps their slot; `closure_cosign_attested` becomes
--                 true and only then is `closed_at` written.
--
-- The close CHECK goes back to "a closed row has BOTH slots stamped by two distinct members". It is added NOT VALID:
-- rows closed under the 0335 nominee shape (never attested by a second person) stay readable as the historical
-- record they are, but no NEW or UPDATED row may be closed without both signatures. A second CHECK pins the
-- pending shape. `closure_outcome` carries the PIP outcome the closer proposed until the nominee confirms.
-- Idempotent.

ALTER TABLE qapi_pip ADD COLUMN IF NOT EXISTS closure_outcome text;--> statement-breakpoint
ALTER TABLE qapi_pip DROP CONSTRAINT IF EXISTS chk_qapi_pip_closure_cosign;--> statement-breakpoint
ALTER TABLE qapi_pip ADD CONSTRAINT chk_qapi_pip_closure_cosign CHECK (
  closed_at IS NULL
  OR (
    closure_cosign_attested
    AND cosign_qapi_coordinator_at IS NOT NULL AND cosign_medical_director_at IS NOT NULL
    AND cosign_qapi_coordinator_membership_id <> cosign_medical_director_membership_id
  )
) NOT VALID;--> statement-breakpoint
ALTER TABLE qapi_pip DROP CONSTRAINT IF EXISTS chk_qapi_pip_close_pending;--> statement-breakpoint
ALTER TABLE qapi_pip ADD CONSTRAINT chk_qapi_pip_close_pending CHECK (
  closed_at IS NOT NULL
  OR closure_nominee_membership_id IS NULL
  OR (
    NOT closure_cosign_attested
    AND closure_closed_by_membership_id IS NOT NULL
    AND (
      (closure_closed_by_membership_id = cosign_qapi_coordinator_membership_id AND cosign_qapi_coordinator_at IS NOT NULL
        AND closure_nominee_membership_id = cosign_medical_director_membership_id AND cosign_medical_director_at IS NULL)
      OR
      (closure_closed_by_membership_id = cosign_medical_director_membership_id AND cosign_medical_director_at IS NOT NULL
        AND closure_nominee_membership_id = cosign_qapi_coordinator_membership_id AND cosign_qapi_coordinator_at IS NULL)
    )
  )
);--> statement-breakpoint

ALTER TABLE sra_cycle DROP CONSTRAINT IF EXISTS chk_sra_cycle_closure_cosign;--> statement-breakpoint
ALTER TABLE sra_cycle ADD CONSTRAINT chk_sra_cycle_closure_cosign CHECK (
  closed_at IS NULL
  OR (
    closure_cosign_attested
    AND cosign_security_officer_at IS NOT NULL AND cosign_compliance_officer_at IS NOT NULL
    AND cosign_security_officer_membership_id <> cosign_compliance_officer_membership_id
  )
) NOT VALID;--> statement-breakpoint
ALTER TABLE sra_cycle DROP CONSTRAINT IF EXISTS chk_sra_cycle_close_pending;--> statement-breakpoint
ALTER TABLE sra_cycle ADD CONSTRAINT chk_sra_cycle_close_pending CHECK (
  closed_at IS NOT NULL
  OR closure_nominee_membership_id IS NULL
  OR (
    NOT closure_cosign_attested
    AND closure_closed_by_membership_id IS NOT NULL
    AND (
      (closure_closed_by_membership_id = cosign_security_officer_membership_id AND cosign_security_officer_at IS NOT NULL
        AND closure_nominee_membership_id = cosign_compliance_officer_membership_id AND cosign_compliance_officer_at IS NULL)
      OR
      (closure_closed_by_membership_id = cosign_compliance_officer_membership_id AND cosign_compliance_officer_at IS NOT NULL
        AND closure_nominee_membership_id = cosign_security_officer_membership_id AND cosign_security_officer_at IS NULL)
    )
  )
);
