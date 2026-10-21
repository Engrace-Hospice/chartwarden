// apps/backend/src/modules/36-messaging/handoffs/handoff-policy-store-db.ts - WP 3.5: the tenant's handoff expiry row
// (`tenant_handoff_policy`, one row per organisation, FORCE RLS). Org comes from the request context, never the client.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";

const P = schema.tenantHandoffPolicies;

/** The stored minutes (null = no row = platform default). Reads of the policy are org-level, not per-user. */
export interface HandoffPolicyStore {
  read(orgId: string, userId: string): Promise<number | null>;
  put(orgId: string, userId: string, expiryMinutes: number): Promise<void>;
  remove(orgId: string, userId: string): Promise<void>;
}

export async function readHandoffPolicyInTx(tx: Tx, orgId: string): Promise<number | null> {
  const [row] = await tx.select().from(P).where(eq(P.organizationId, orgId)).limit(1);
  return row ? row.expiryMinutes : null;
}

export function createDbHandoffPolicyStore(db: DbClient): HandoffPolicyStore {
  const run = <R>(orgId: string, userId: string, fn: (tx: Tx) => Promise<R>): Promise<R> =>
    withOrgContext(db, { organizationId: orgId, userId }, (tx) => fn(tx as unknown as Tx));
  return {
    read: (orgId, userId) => run(orgId, userId, (tx) => readHandoffPolicyInTx(tx, orgId)),
    put: (orgId, userId, expiryMinutes) =>
      run(orgId, userId, async (tx) => {
        const values = { expiryMinutes, configuredByUserId: userId, updatedAt: new Date() };
        await tx
          .insert(P)
          .values({ organizationId: orgId, ...values })
          .onConflictDoUpdate({ target: P.organizationId, set: values });
      }),
    remove: (orgId, userId) =>
      run(orgId, userId, async (tx) => {
        await tx.delete(P).where(eq(P.organizationId, orgId));
      }),
  };
}

/** In-memory twin for unit tests. */
export function createMemoryHandoffPolicyStore(
  initial: number | null = null,
): HandoffPolicyStore & {
  current(): number | null;
} {
  let value = initial;
  return {
    read: async () => value,
    put: async (_o, _u, minutes) => {
      value = minutes;
    },
    remove: async () => {
      value = null;
    },
    current: () => value,
  };
}
