// apps/backend/__tests__/_physician-signer.ts — live-suite fixtures for the 42 CFR 418.25(a) / 418.26(b)
// physician signer set: seed a REAL role grant (membership → membership_role → role) for a user, so the
// production PhysicianAuthorityPort resolves it exactly as it would for a signed-in physician, plus the
// discharge-order body a live discharge on/after 2026-10-01 must carry.
import type { Client } from "pg";
import type { DischargeOrderInput } from "../src/modules/06-admission/physician-signer-checks";

/**
 * Grant `roleKey` (default `medical_director`) to `userId` in `organizationId` as superuser. Idempotent: an
 * existing active membership / org role is reused. The user row must already exist.
 */
export async function seedPhysicianRole(
  admin: Client,
  organizationId: string,
  userId: string,
  roleKey = "medical_director",
): Promise<void> {
  const existing = await admin.query<{ id: string }>(
    "SELECT id FROM membership WHERE user_id=$1 AND organization_id=$2 AND status='active' LIMIT 1",
    [userId, organizationId],
  );
  const membershipId =
    existing.rows[0]?.id ??
    (
      await admin.query<{ id: string }>(
        `INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`,
        [userId, organizationId],
      )
    ).rows[0]?.id;
  const role =
    (
      await admin.query<{ id: string }>(
        "SELECT id FROM role WHERE organization_id=$1 AND key=$2 LIMIT 1",
        [organizationId, roleKey],
      )
    ).rows[0]?.id ??
    (
      await admin.query<{ id: string }>(
        `INSERT INTO role (organization_id,key,name,category,enabled)
         VALUES ($1,$2,$2,'clinical_leadership',true) RETURNING id`,
        [organizationId, roleKey],
      )
    ).rows[0]?.id;
  await admin.query(
    `INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING`,
    [organizationId, membershipId, role],
  );
}

/**
 * A 418.26(b) discharge order signed by `userId`. Signed now, or — for a back-dated discharge — at noon UTC
 * of `dischargeDate` when that is earlier (the order may not post-date the discharge by more than a day).
 */
export function dischargeOrderBy(userId: string, dischargeDate?: string): DischargeOrderInput {
  const now = Date.now();
  const noonOfDischarge = dischargeDate ? Date.parse(`${dischargeDate}T12:00:00.000Z`) : now;
  return {
    signedByUserId: userId,
    signedAt: new Date(Math.min(now, noonOfDischarge)).toISOString(),
    orderText: "Discharge per 42 CFR 418.26(b).",
  };
}
