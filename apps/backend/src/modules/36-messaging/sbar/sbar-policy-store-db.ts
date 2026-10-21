// apps/backend/src/modules/36-messaging/sbar/sbar-policy-store-db.ts - WP 3.3: the tenant's SBAR policy row
// (`tenant_sbar_policy`, one row per organisation, FORCE RLS). Org comes from the request context, never the client.
import { type DbClient, schema } from "@chartwarden/db";
import type { StoredSbarPolicy } from "@chartwarden/messaging";
import { withOrgContext } from "@chartwarden/tenancy";
import { SBAR_SECTION_KEYS, type SbarSectionKey } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";

const P = schema.tenantSbarPolicies;
type Row = typeof P.$inferSelect;

const MIN_COLUMN = {
  situation: "situationMinChars",
  background: "backgroundMinChars",
  assessment: "assessmentMinChars",
  recommendation: "recommendationMinChars",
} as const satisfies Record<SbarSectionKey, keyof Row>;

const HINT_COLUMN = {
  situation: "situationHint",
  background: "backgroundHint",
  assessment: "assessmentHint",
  recommendation: "recommendationHint",
} as const satisfies Record<SbarSectionKey, keyof Row>;

function toStored(row: Row): StoredSbarPolicy {
  const minChars = {} as Record<SbarSectionKey, number>;
  const hints: Partial<Record<SbarSectionKey, string>> = {};
  for (const key of SBAR_SECTION_KEYS) {
    minChars[key] = row[MIN_COLUMN[key]];
    const hint = row[HINT_COLUMN[key]];
    if (hint) hints[key] = hint;
  }
  return { minChars, requirePatientChannel: row.requirePatientChannel, hints };
}

function toColumns(policy: StoredSbarPolicy) {
  return {
    situationMinChars: policy.minChars.situation,
    backgroundMinChars: policy.minChars.background,
    assessmentMinChars: policy.minChars.assessment,
    recommendationMinChars: policy.minChars.recommendation,
    requirePatientChannel: policy.requirePatientChannel,
    situationHint: policy.hints.situation ?? null,
    backgroundHint: policy.hints.background ?? null,
    assessmentHint: policy.hints.assessment ?? null,
    recommendationHint: policy.hints.recommendation ?? null,
  };
}

/** The org's stored policy inside an open transaction (the write path), or null when it has none. */
export async function readSbarPolicyInTx(tx: Tx, orgId: string): Promise<StoredSbarPolicy | null> {
  const [row] = await tx.select().from(P).where(eq(P.organizationId, orgId)).limit(1);
  return row ? toStored(row) : null;
}

export interface SbarPolicyStore {
  read(orgId: string, userId: string): Promise<StoredSbarPolicy | null>;
  put(orgId: string, userId: string, policy: StoredSbarPolicy): Promise<void>;
  remove(orgId: string, userId: string): Promise<void>;
}

export function createDbSbarPolicyStore(db: DbClient): SbarPolicyStore {
  const run = <R>(orgId: string, userId: string, fn: (tx: Tx) => Promise<R>): Promise<R> =>
    withOrgContext(db, { organizationId: orgId, userId }, (tx) => fn(tx as unknown as Tx));
  return {
    read: (orgId, userId) => run(orgId, userId, (tx) => readSbarPolicyInTx(tx, orgId)),
    put: (orgId, userId, policy) =>
      run(orgId, userId, async (tx) => {
        const values = { ...toColumns(policy), configuredByUserId: userId, updatedAt: new Date() };
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
