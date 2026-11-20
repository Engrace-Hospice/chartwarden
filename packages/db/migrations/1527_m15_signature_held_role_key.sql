-- compat: expand
-- M15 (discipline care plans, control CW-AC-53): record the role key a signer HELD when it signed. An Aide POC's RN slot is
-- filled by the RN case manager or by any care-team RN, so `signer_role` (the slot, `rn_case_manager`) no longer says which
-- of the two signed, and a role grant can be changed or expired afterwards. `held_role_key` keeps the key the signer used
-- (`rn_case_manager`, `rn`, `chha`, `msw`, ...). Additive and nullable: rows signed before this migration, and a system-actor
-- signature (which holds no role by design), carry NULL; the previous release never writes it. The row-audit trigger on
-- `discipline_care_plan_signature` (0099) captures every column but `attestation_text`, so the value lands in the audit
-- trail with no trigger change. No new table, no RLS or grant change.
ALTER TABLE "discipline_care_plan_signature" ADD COLUMN IF NOT EXISTS "held_role_key" text;
