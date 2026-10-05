-- M12 (GAP-034 follow-up) — persist the DRAFTER's discipline on medication_order.
--
-- The cosign axis (an RN-tier drafter's order owes a supervising cosignature) is decided from the
-- discipline that DRAFTED the order. The DB backend had no column for it, so `requestSignature` fell back to
-- the REQUESTING session's discipline: an RN draft that a physician then submitted for signature silently
-- lost its cosign requirement. The create path now stores the session-held drafting discipline here and
-- `requestSignature` reads it back (falling back to the requester only when this is NULL).
--
-- NULL = unknown / legacy row (drafted before this column existed) => behave exactly as before. No backfill:
-- the original drafter's discipline is not recoverable from existing data, and guessing would be worse than NULL.
-- `medication_order` is partitioned; ADD COLUMN on the parent propagates to every partition. A discipline label
-- is not PHI, so the existing M4 write-audit trigger (row to_jsonb) needs no denylist change.
-- (order_signature.attestation_text already exists, mig 0036/0037 — nothing to add for the M11 seam.)
ALTER TABLE "medication_order"
  ADD COLUMN IF NOT EXISTS "drafted_by_discipline" text;
