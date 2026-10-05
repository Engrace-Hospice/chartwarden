-- M12 (GAP-034 follow-up) — persist the DRAFTER's discipline on medication_order.
--
-- The cosign axis (an RN-tier drafter's order owes a supervising cosignature) is decided from the
-- discipline that DRAFTED the order. The DB backend had no column for it, so `requestSignature` fell back to
-- the REQUESTING session's discipline: an RN draft that a physician then submitted for signature silently
-- lost its cosign requirement. The create path now stores the session-held drafting discipline here and
-- `requestSignature` reads it back (falling back to the requester only when this is NULL).
--
-- NULL = unknown / legacy row => the requester's discipline is used (the pre-0328 behaviour).
--
-- BACKFILL (conservative, idempotent). Without it, an IN-FLIGHT order an RN-tier user drafted before this column
-- existed has NULL here, falls back to the signing physician's discipline and ESCAPES the cosign requirement.
-- The drafter is `medication_order.prescriber_membership_id` (createDraft writes the creating session's membership
-- id there). A row is touched ONLY when ALL hold:
--   * drafted_by_discipline IS NULL and status IN ('draft','pending_signature') — terminal / signed / verbal /
--     EPCS / transmission states are never touched;
--   * the drafter's membership (same organization, not revoked) holds an ACTIVE grant — membership_role unexpired
--     (expires_at NULL or in the future) on an ENABLED role (the membershipRoleKeysForOrg semantic; the role is
--     org-owned in the same org or a platform template, and never a reserved platform_* key) — on
--     `rn_case_manager` or `clinical_supervisor` (DRAFT_ON_BEHALF_DISCIPLINES); rn_case_manager wins when both;
--   * the drafter holds NO active prescriber-tier grant (md, np, pa, physician, hospice_physician,
--     medical_director): a dual-role user may have drafted as the prescriber, so we never guess against them.
-- Undeterminable drafters (membership gone / revoked / no live RN-tier grant) are left NULL. For rows already
-- `pending_signature` (request-signature ran with no cosign requirement) cosign_required is also set true and
-- cosign_status 'pending' (only where cosign_required is not already true), so the existing
-- sign-blocked-until-cosigned guard applies. Nothing is deleted; re-running changes nothing (the NULL filter).
-- `medication_order` is partitioned; ADD COLUMN on the parent propagates to every partition. A discipline label
-- is not PHI, so the existing M4 write-audit trigger (row to_jsonb) needs no denylist change.
-- (order_signature.attestation_text already exists, mig 0036/0037 — nothing to add for the M11 seam.)
ALTER TABLE "medication_order"
  ADD COLUMN IF NOT EXISTS "drafted_by_discipline" text;

WITH rn_drafter AS (
  SELECT mo.id AS order_id,
         mo.created_at AS order_created_at,
         CASE WHEN bool_or(r.key = 'rn_case_manager') THEN 'rn_case_manager' ELSE 'clinical_supervisor' END AS discipline
    FROM "medication_order" mo
    JOIN "membership" m
      ON m.id = mo.prescriber_membership_id
     AND m.organization_id = mo.organization_id
     AND m.status <> 'revoked'
    JOIN "membership_role" mr
      ON mr.membership_id = m.id
     AND mr.organization_id = mo.organization_id
     AND (mr.expires_at IS NULL OR mr.expires_at > now())
    JOIN "role" r
      ON r.id = mr.role_id
     AND r.enabled
     AND (r.organization_id IS NULL OR r.organization_id = mo.organization_id)
     AND r.key NOT LIKE 'platform\_%'
   WHERE mo.drafted_by_discipline IS NULL
     AND mo.status IN ('draft', 'pending_signature')
     AND r.key IN ('rn_case_manager', 'clinical_supervisor')
     AND NOT EXISTS (
       SELECT 1
         FROM "membership_role" pmr
         JOIN "role" pr
           ON pr.id = pmr.role_id
          AND pr.enabled
          AND (pr.organization_id IS NULL OR pr.organization_id = mo.organization_id)
        WHERE pmr.membership_id = m.id
          AND pmr.organization_id = mo.organization_id
          AND (pmr.expires_at IS NULL OR pmr.expires_at > now())
          AND pr.key IN ('md', 'np', 'pa', 'physician', 'hospice_physician', 'medical_director')
     )
   GROUP BY mo.id, mo.created_at
)
UPDATE "medication_order" mo
   SET drafted_by_discipline = d.discipline,
       cosign_required = CASE WHEN mo.status = 'pending_signature' THEN true ELSE mo.cosign_required END,
       cosign_status = CASE WHEN mo.status = 'pending_signature' AND NOT mo.cosign_required
                            THEN 'pending' ELSE mo.cosign_status END
  FROM rn_drafter d
 WHERE mo.id = d.order_id
   AND mo.created_at = d.order_created_at
   AND mo.drafted_by_discipline IS NULL;
