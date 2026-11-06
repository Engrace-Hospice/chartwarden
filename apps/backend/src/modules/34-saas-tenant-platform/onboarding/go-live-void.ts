// apps/backend/src/modules/34-saas-tenant-platform/onboarding/go-live-void.ts - a pending go-live attestation does not survive a
// change to the data it attested.
//
// The compliance officer's attestation says "the onboarding data is ready" as of one moment. If a provider entity, a location,
// a billing credential, the org profile or the BAA register is written afterwards (by the tenant's admin or by an operator
// entering it for them), approval must not rest on that statement: the writer calls this IN THE SAME TRANSACTION as its write,
// which revokes the pending attestation (reason below, audited by the row trigger with the actor's user id) and puts the
// go-live step back to pending so the officer attests again. No fingerprint of the data is kept: any write voids.
//
// It runs on a tenant transaction (the tenant role holds a column-level UPDATE under a pending -> revoked policy, migration
// 1328) or on a platform transaction (the carrier's UPDATE), always scoped to the one organisation. Nothing pending = no-op.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq } from "drizzle-orm";
import { GO_LIVE_DATA_CHANGED_REVOKE_REASON, GO_LIVE_TEMPLATE_KEY } from "./model";

const G = schema.tenantGoLiveAttestation;
const K = schema.onboardingTask;

export async function voidPendingGoLiveForDataChange(
  tx: DbClient,
  input: {
    readonly organizationId: string;
    readonly revokedByUserId: string;
    readonly revokedByMembershipId: string | null;
  },
): Promise<boolean> {
  const at = new Date();
  const [voided] = await tx
    .update(G)
    .set({
      status: "revoked",
      revokedByUserId: input.revokedByUserId,
      revokedByMembershipId: input.revokedByMembershipId,
      revokedAt: at,
      revokeReason: GO_LIVE_DATA_CHANGED_REVOKE_REASON,
      updatedAt: at,
    })
    .where(and(eq(G.organizationId, input.organizationId), eq(G.status, "pending")))
    .returning({ tenantAccountId: G.tenantAccountId });
  if (!voided) return false;
  // Every revoke puts an in-flight go-live step back to pending, so the officer can attest again.
  await tx
    .update(K)
    .set({ status: "pending", startedAt: null })
    .where(
      and(
        eq(K.organizationId, input.organizationId),
        eq(K.tenantAccountId, voided.tenantAccountId),
        eq(K.templateKey, GO_LIVE_TEMPLATE_KEY),
        eq(K.status, "in_progress"),
      ),
    );
  return true;
}
