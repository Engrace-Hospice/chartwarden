// apps/backend/src/modules/02-identity/step-up-override-admin.ts — the WRITE side of the tenant step-up override
// registry (GAP-115; M2 spec §3.7, §4.3.2, D9, W-M2-10).
//
// `createDrizzleStepUpOverrideStore` (step-up-override-store.ts) has always been read-only: the table existed,
// the resolver read it, and the only way to put a row in it was SQL. This is the admin store behind
// `POST/GET/DELETE /api/v1/orgs/:id/step-up-overrides`, plus the pure validation both the route and the tests
// use. TIGHTEN-ONLY is enforced twice: {@link validateOverrideInput} refuses a loosening with a precise 422, and
// `trg_tenant_step_up_tighten_only` (migration 0211) refuses it at rest against a direct SQL write.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { STEP_UP_POLICY, type StepUpFactor, ValidationError } from "@chartwarden/types";
import { and, asc, eq } from "drizzle-orm";

export interface StepUpOverrideAdminRecord {
  readonly operationKey: string;
  readonly qualifyingFactors: readonly StepUpFactor[];
  readonly maxAgeSec: number;
  readonly rationale: string;
  readonly configuredByMembershipId: string;
  readonly configuredAt: string;
}

export interface StepUpOverrideInput {
  readonly operationKey: string;
  readonly qualifyingFactors: readonly StepUpFactor[];
  readonly maxAgeSec: number;
  readonly rationale: string;
}

/** Admin port over `tenant_step_up_policy_override` (org-scoped under RLS). */
export interface StepUpOverrideAdminStore {
  list(organizationId: string): Promise<readonly StepUpOverrideAdminRecord[]>;
  /** Insert-or-replace the one row for (org, operation). */
  upsert(
    organizationId: string,
    input: StepUpOverrideInput & { configuredByMembershipId: string },
  ): Promise<StepUpOverrideAdminRecord>;
  /** Returns false when there was no override to remove. */
  remove(organizationId: string, operationKey: string): Promise<boolean>;
}

export const OPERATION_KEY_PATTERN = /^[a-z][a-z0-9_.]{0,99}$/;
export const MIN_RATIONALE_CHARS = 10;

const fail = (field: string, message: string): never => {
  throw new ValidationError(message, [{ field, code: "INVALID", message }]);
};

/**
 * Validate an override request against the platform floor. Pure. Refuses anything that would LOOSEN the
 * floor — a factor outside `STEP_UP_POLICY.qualifyingFactors` (SMS), an empty set (a lockout, not a
 * tightening), a window longer than the floor's, or a non-positive one — so the administrator reads the reason
 * here instead of a database exception.
 */
export function validateOverrideInput(body: unknown): StepUpOverrideInput {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const operationKey = b.operationKey;
  if (typeof operationKey !== "string" || !OPERATION_KEY_PATTERN.test(operationKey))
    fail("operationKey", "operationKey must be lower-case letters, digits, '_' or '.' (max 100)");
  const factors = b.qualifyingFactors;
  if (!Array.isArray(factors) || factors.length === 0)
    fail("qualifyingFactors", "name at least one qualifying factor from the platform floor");
  const floor: readonly string[] = STEP_UP_POLICY.qualifyingFactors;
  const extra = (factors as unknown[]).filter((f) => typeof f !== "string" || !floor.includes(f));
  if (extra.length > 0)
    fail(
      "qualifyingFactors",
      `a tenant may only tighten the platform floor [${floor.join(", ")}]; refused: ${extra.map(String).join(", ")}`,
    );
  const maxAgeSec = b.maxAgeSec;
  if (typeof maxAgeSec !== "number" || !Number.isInteger(maxAgeSec) || maxAgeSec <= 0)
    fail("maxAgeSec", "maxAgeSec must be a positive whole number of seconds");
  if ((maxAgeSec as number) > STEP_UP_POLICY.defaultMaxAgeSec)
    fail(
      "maxAgeSec",
      `a tenant may only shorten the freshness window: the platform floor is ${STEP_UP_POLICY.defaultMaxAgeSec}s`,
    );
  const rationale = typeof b.rationale === "string" ? b.rationale.trim() : "";
  if (rationale.length < MIN_RATIONALE_CHARS)
    fail("rationale", `rationale must be at least ${MIN_RATIONALE_CHARS} characters`);
  return {
    operationKey: operationKey as string,
    qualifyingFactors: [...new Set(factors as StepUpFactor[])],
    maxAgeSec: maxAgeSec as number,
    rationale,
  };
}

const T = schema.tenantStepUpPolicyOverride;

function toRecord(row: {
  operationKey: string;
  qualifyingFactors: readonly string[] | null;
  maxAgeSec: number;
  rationale: string;
  configuredByMembershipId: string;
  configuredAt: Date;
}): StepUpOverrideAdminRecord {
  return {
    operationKey: row.operationKey,
    qualifyingFactors: (row.qualifyingFactors ?? []) as readonly StepUpFactor[],
    maxAgeSec: row.maxAgeSec,
    rationale: row.rationale,
    configuredByMembershipId: row.configuredByMembershipId,
    configuredAt: row.configuredAt.toISOString(),
  };
}

const COLUMNS = {
  operationKey: T.operationKey,
  qualifyingFactors: T.qualifyingFactors,
  maxAgeSec: T.maxAgeSec,
  rationale: T.rationale,
  configuredByMembershipId: T.configuredByMembershipId,
  configuredAt: T.configuredAt,
} as const;

export function createDrizzleStepUpOverrideAdminStore(db: DbClient): StepUpOverrideAdminStore {
  return {
    async list(organizationId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = await tx
          .select(COLUMNS)
          .from(T)
          .where(eq(T.organizationId, organizationId))
          .orderBy(asc(T.operationKey));
        return rows.map(toRecord);
      });
    },
    async upsert(organizationId, input) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const now = new Date();
        const rows = await tx
          .insert(T)
          .values({
            organizationId,
            operationKey: input.operationKey,
            qualifyingFactors: [...input.qualifyingFactors],
            maxAgeSec: input.maxAgeSec,
            rationale: input.rationale,
            configuredByMembershipId: input.configuredByMembershipId,
            configuredAt: now,
          })
          .onConflictDoUpdate({
            target: [T.organizationId, T.operationKey],
            set: {
              qualifyingFactors: [...input.qualifyingFactors],
              maxAgeSec: input.maxAgeSec,
              rationale: input.rationale,
              configuredByMembershipId: input.configuredByMembershipId,
              configuredAt: now,
            },
          })
          .returning(COLUMNS);
        return toRecord(rows[0] as Parameters<typeof toRecord>[0]);
      });
    },
    async remove(organizationId, operationKey) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = await tx
          .delete(T)
          .where(and(eq(T.organizationId, organizationId), eq(T.operationKey, operationKey)))
          .returning({ id: T.id });
        return rows.length > 0;
      });
    },
  };
}

/** In-memory store (route tests + a no-DB slice boot). Same contract, no persistence. */
export function createInMemoryStepUpOverrideAdminStore(): {
  store: StepUpOverrideAdminStore;
  all(): StepUpOverrideAdminRecord[];
} {
  const rows = new Map<string, StepUpOverrideAdminRecord>();
  const key = (org: string, op: string) => `${org}::${op}`;
  return {
    all: () => [...rows.values()],
    store: {
      async list(organizationId) {
        return [...rows.entries()]
          .filter(([k]) => k.startsWith(`${organizationId}::`))
          .map(([, v]) => v)
          .sort((a, b) => a.operationKey.localeCompare(b.operationKey));
      },
      async upsert(organizationId, input) {
        const rec: StepUpOverrideAdminRecord = {
          operationKey: input.operationKey,
          qualifyingFactors: input.qualifyingFactors,
          maxAgeSec: input.maxAgeSec,
          rationale: input.rationale,
          configuredByMembershipId: input.configuredByMembershipId,
          configuredAt: new Date().toISOString(),
        };
        rows.set(key(organizationId, input.operationKey), rec);
        return rec;
      },
      async remove(organizationId, operationKey) {
        return rows.delete(key(organizationId, operationKey));
      },
    },
  };
}
