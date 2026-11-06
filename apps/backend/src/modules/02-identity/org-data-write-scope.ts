// apps/backend/src/modules/02-identity/org-data-write-scope.ts — the unit of work behind every write to an organization's own
// data through the M2 admin routes (provider entities, locations, the organization's names): one org-scoped transaction in
// which the route's write and an `afterWrite` step commit or roll back together.
//
// WHY. M34's go-live attestation says "the onboarding data was ready" at one moment; any later write to that data must revoke a
// pending attestation in the SAME transaction (M34 `voidPendingGoLiveForDataChange`). M2 does not import M34, so the
// composition root hands this factory the step. `afterWrite` is REQUIRED: a scope without it would let a write leave a stale
// attestation approvable.
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { createDrizzleSiteAdminRepository } from "../../bootstrap/site-admin-repository";
import { createDrizzleOrgAdminStore } from "./org-admin-store";
import type { OrgDataWriteScope } from "./routes/org-admin-routes";

export type OrgDataWritten = (
  tx: DbClient,
  scope: {
    readonly organizationId: string;
    readonly userId: string;
    readonly membershipId: string | null;
  },
) => Promise<void>;

/**
 * The scope runs under the TARGET organization's own RLS context (the actor's user as `app.user_id`, so the write-audit trigger
 * and any policy that pins the session user see them), hands `run` stores bound to that transaction, then runs `afterWrite` in it.
 */
export function createOrgDataWriteScope(
  db: DbClient,
  afterWrite: OrgDataWritten,
): OrgDataWriteScope {
  return (scope, run) =>
    withOrgContext(
      db,
      { organizationId: scope.organizationId, userId: scope.userId },
      async (rawTx) => {
        const tx = rawTx as unknown as DbClient;
        const result = await run(
          createDrizzleOrgAdminStore(tx, createDrizzleSiteAdminRepository(tx, scope.userId)),
        );
        await afterWrite(tx, scope);
        return result;
      },
    );
}
