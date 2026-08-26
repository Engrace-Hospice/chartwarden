// apps/backend/src/modules/02-identity/device-attestation-store-db.ts — M2, SecHardening §12.4.
//
// The Drizzle store over `device_attestation` plus the `session.device_attestation_id` pointer. M2 owns
// both, so this reads and writes them directly; every other module reaches the fact through the
// resolved actor, never through this table.
//
// WHY THE WRITES ARE TRANSACTIONAL. `device_attestation_live_uq` permits ONE live row per
// (org, membership, device), so re-attesting has to revoke the previous row and insert the new one
// together or the insert loses to the index. Binding the session in the same transaction closes the
// other half: a session pointing at a row that was superseded between the insert and the update is
// exactly the stale-pointer state the resolver's re-read exists to survive, and there is no reason to
// create it deliberately.
import { type DbClient, schema } from "@wardenx/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DeviceAttestationRecord, DeviceAttestationStore } from "./device-attestation-ports";

const DA = schema.deviceAttestations;
const SESSION = schema.sessions;

/** Map a row to the port's DTO (dates as ISO strings, so the route layer never handles a Date). */
function toRecord(row: typeof DA.$inferSelect): DeviceAttestationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    membershipId: row.membershipId,
    deviceKeyFingerprint: row.deviceKeyFingerprint,
    platform: row.platform,
    provider: row.provider,
    verdict: row.verdict,
    verifiedAt: row.verifiedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/** Build the production store. Runs on the app connection under the caller's org RLS context. */
export function createDbDeviceAttestationStore(db: DbClient): DeviceAttestationStore {
  return {
    async recordAttested(input): Promise<DeviceAttestationRecord> {
      return db.transaction(async (tx) => {
        // Supersede the device's previous live attestation. `system_supersede` rather than a human
        // reason: the revocation-consistency CHECK requires an actor and a reason, and the honest
        // answer to "who revoked this" here is the platform, re-attesting the same device.
        await tx
          .update(DA)
          .set({
            verdict: "revoked",
            revokedAt: input.verifiedAt,
            revokedByMembershipId: input.membershipId,
            revokedReason: "superseded by a newer attestation of the same device",
            updatedAt: input.verifiedAt,
          })
          .where(
            and(
              eq(DA.organizationId, input.organizationId),
              eq(DA.membershipId, input.membershipId),
              eq(DA.deviceKeyFingerprint, input.deviceKeyFingerprint),
              eq(DA.verdict, "attested"),
              isNull(DA.revokedAt),
            ),
          );

        const [row] = await tx
          .insert(DA)
          .values({
            organizationId: input.organizationId,
            membershipId: input.membershipId,
            deviceKeyFingerprint: input.deviceKeyFingerprint,
            platform: input.platform,
            provider: input.provider,
            verdict: "attested",
            posture: input.posture,
            verifiedAt: input.verifiedAt,
            expiresAt: input.expiresAt,
          })
          .returning();
        if (!row) throw new Error("device_attestation insert returned no row");

        await tx
          .update(SESSION)
          .set({ deviceAttestationId: row.id, updatedAt: input.verifiedAt })
          .where(eq(SESSION.id, input.sessionId));

        return toRecord(row);
      });
    },

    async recordFailed(input): Promise<DeviceAttestationRecord> {
      // No supersede and no session bind: a failure records what happened without disturbing whatever
      // the device's standing attestation is. A phone that fails one posture check has not thereby
      // lost an attestation it earned earlier — it simply does not gain a new one.
      const [row] = await db
        .insert(DA)
        .values({
          organizationId: input.organizationId,
          membershipId: input.membershipId,
          deviceKeyFingerprint: input.deviceKeyFingerprint,
          platform: input.platform,
          provider: input.provider,
          verdict: "failed",
          posture: input.posture,
          failureReason: input.failureReason,
          verifiedAt: input.verifiedAt,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!row) throw new Error("device_attestation insert returned no row");
      return toRecord(row);
    },

    async revoke(input): Promise<DeviceAttestationRecord | null> {
      return db.transaction(async (tx) => {
        const now = new Date();
        const [row] = await tx
          .update(DA)
          .set({
            verdict: "revoked",
            revokedAt: now,
            revokedByMembershipId: input.revokedByMembershipId,
            revokedReason: input.reason,
            updatedAt: now,
          })
          .where(
            and(
              eq(DA.organizationId, input.organizationId),
              eq(DA.id, input.attestationId),
              eq(DA.verdict, "attested"),
              isNull(DA.revokedAt),
            ),
          )
          .returning();
        if (!row) return null;

        // Clear the pointer from any session still on this device, so a lost handset stops satisfying
        // the gate on its NEXT request. Without this the revocation would only bite when the session
        // expired — the resolver's liveness re-read covers it either way, but leaving a pointer at a
        // revoked row is a misleading record for anyone reading the session table after an incident.
        await tx
          .update(SESSION)
          .set({ deviceAttestationId: null, updatedAt: now })
          .where(eq(SESSION.deviceAttestationId, row.id));

        return toRecord(row);
      });
    },

    async listForMembership(input): Promise<readonly DeviceAttestationRecord[]> {
      const rows = await db
        .select()
        .from(DA)
        .where(
          and(eq(DA.organizationId, input.organizationId), eq(DA.membershipId, input.membershipId)),
        )
        .orderBy(desc(DA.verifiedAt));
      return rows.map(toRecord);
    },
  };
}
