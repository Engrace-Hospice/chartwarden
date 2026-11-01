// apps/backend/src/bootstrap/rust-bridge/sweep-db.ts — CW-RUST-M02 P1: per-org membership reads for the parity sweep.
//
// Both reads run under the org's own `withOrgContext` with the system actor, on the tenant pool as `chartwarden_app`,
// so RLS scopes them to that org. No cross-tenant read happens here (the org list comes from the audited platform
// enumerator). `count` is a separate query on purpose: it lets the sweep prove it compared everything it listed.
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, countDistinct, eq } from "drizzle-orm";

export interface SweepMembershipReader {
  listActiveMembers(organizationId: string): Promise<readonly string[]>;
  countActiveMembers(organizationId: string): Promise<number>;
}

export function createSweepMembershipReader(db: DbClient): SweepMembershipReader {
  const active = (organizationId: string) =>
    and(
      eq(schema.memberships.organizationId, organizationId),
      eq(schema.memberships.status, "active"),
    );
  return {
    listActiveMembers: (organizationId) =>
      withOrgContext(db, systemOrgContext(organizationId), async (tx) =>
        (
          await tx
            .selectDistinct({ userId: schema.memberships.userId })
            .from(schema.memberships)
            .where(active(organizationId))
        ).map((r) => r.userId),
      ),
    countActiveMembers: (organizationId) =>
      withOrgContext(db, systemOrgContext(organizationId), async (tx) => {
        const rows = await tx
          .select({ n: countDistinct(schema.memberships.userId) })
          .from(schema.memberships)
          .where(active(organizationId));
        return Number(rows[0]?.n ?? 0);
      }),
  };
}
