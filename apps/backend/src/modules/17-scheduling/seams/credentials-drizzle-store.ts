// apps/backend/src/modules/17-scheduling/seams/credentials-drizzle-store.ts — GAP-093: the real
// Drizzle-backed {@link CredentialStore} over `membership_credential`. Backs BOTH the boot-registered
// `CredentialReader` seam (`activeAsOf`, the cross-module read future M23/M31 consumers resolve
// through `getSeam`) AND M17's own grant/revoke/list write path (`scheduling-route-service-db.ts`
// constructs this same store directly — no self-referential seam round-trip for M17's own table).
//
// TENANCY: every method carries `organizationId` explicitly and opens its own `withOrgContext`
// envelope (the CredentialReader seam is called from OTHER modules' request contexts, not always
// from inside an M17 route) — the M5 `createDrizzleCredentialStore`-sibling `createDrizzleCaseloadStore`
// precedent. `SEAM_SYSTEM_USER_ID` is the actor for the read path (a cross-module identity read has
// no acting membership); grant/revoke pass the REAL caller membership id as the audit actor.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError } from "@wardenx/types";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { CredentialRecord, CredentialStore } from "./credentials";

const MC = schema.membershipCredentials;

/** The seam envelope's actor id for the READ path — a cross-module identity read has no acting membership. */
const SEAM_SYSTEM_USER_ID = "";

type Row = typeof MC.$inferSelect;

function toRecord(row: Row): CredentialRecord {
  return {
    id: row.id,
    membershipId: row.membershipId,
    credentialType: row.credentialType,
    status: row.status,
    effectiveAt: row.effectiveAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    revokedReason: row.revokedReason,
    issuingBody: row.issuingBody,
    grantedByMembershipId: row.grantedByMembershipId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Build the real {@link CredentialStore} over `membership_credential` (GAP-093). */
export function createDrizzleCredentialStore(db: DbClient): CredentialStore {
  return {
    async activeAsOf(organizationId, membershipId, asOf) {
      return withOrgContext(db, { organizationId, userId: SEAM_SYSTEM_USER_ID }, async (tx) => {
        const rows = await tx
          .select()
          .from(MC)
          .where(
            and(
              eq(MC.organizationId, organizationId),
              eq(MC.membershipId, membershipId),
              eq(MC.status, "active"),
              isNull(MC.revokedAt),
              lte(MC.effectiveAt, asOf),
              or(isNull(MC.expiresAt), gte(MC.expiresAt, asOf)),
            ),
          );
        return rows.map((r) => ({ kind: r.credentialType, status: r.status }));
      });
    },

    async listForMembership(organizationId, membershipId) {
      return withOrgContext(db, { organizationId, userId: SEAM_SYSTEM_USER_ID }, async (tx) => {
        const rows = await tx
          .select()
          .from(MC)
          .where(and(eq(MC.organizationId, organizationId), eq(MC.membershipId, membershipId)))
          .orderBy(desc(MC.createdAt));
        return rows.map(toRecord);
      });
    },

    async grant(organizationId, input) {
      return withOrgContext(
        db,
        { organizationId, userId: input.grantedByMembershipId },
        async (tx) => {
          const [inserted] = await tx
            .insert(MC)
            .values({
              organizationId,
              membershipId: input.membershipId,
              credentialType: input.credentialType,
              status: "active",
              effectiveAt: input.effectiveAt,
              expiresAt: input.expiresAt ?? null,
              issuingBody: input.issuingBody ?? null,
              grantedByMembershipId: input.grantedByMembershipId,
            })
            .returning();
          return toRecord(inserted as Row);
        },
      );
    },

    async revoke(organizationId, input) {
      return withOrgContext(
        db,
        { organizationId, userId: input.revokedByMembershipId },
        async (tx) => {
          const updated = await tx
            .update(MC)
            .set({
              status: "revoked",
              revokedAt: new Date(),
              revokedReason: input.revokedReason,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(MC.organizationId, organizationId),
                eq(MC.id, input.credentialId),
                isNull(MC.revokedAt),
              ),
            )
            .returning({ id: MC.id });
          if (updated.length === 0)
            throw new NotFoundError("membership credential", input.credentialId);
        },
      );
    },
  };
}
