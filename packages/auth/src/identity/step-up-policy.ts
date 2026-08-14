// @wardenx/auth · identity — the tighten-only step-up policy resolution (M2 spec §4.3.2, D9).
//
// THE INVARIANT. A tenant may make step-up HARDER for an operation than the platform floor
// `STEP_UP_POLICY` — never easier. Resolution is `intersect(floor.qualifyingFactors, tenant)` and
// `min(floor.defaultMaxAgeSec, tenant)`, so a row that tries to add SMS or stretch the freshness
// window resolves to the floor's value for that field and grants the tenant nothing.
//
// WHY THIS LIVES HERE and not in apps/backend/src/modules/02-identity. The same math is needed in
// two places that cannot import each other: M2's `SessionContextResolver` seam implementation (this
// package) and M2's own app-module resolver. It had a single definition in the app module, and the
// seam — the one M3's `step_up_recent` predicate actually calls — could not reach it, which is a
// large part of why the tightening was never on the live path at all. The app module now re-exports
// this one, so there is exactly one definition and no drift.
//
// This is the APP-LAYER half of a two-layer control. The at-rest half is
// `trg_tenant_step_up_tighten_only` (migration 0211), which REFUSES a loosening row at write time
// so a tenant gets an error instead of a silently-ignored configuration. Both are needed and they
// do different jobs: without the trigger a tenant's rejected intent looks accepted; without this
// resolution a row written by any path that bypasses the trigger would take effect.
import { STEP_UP_POLICY, type ResolvedStepUpPolicy, type StepUpFactor } from "@wardenx/types";

/** A tenant override row's policy-bearing fields (mirrors `tenant_step_up_policy_override`). */
export interface StepUpOverrideRecord {
  readonly qualifyingFactors: readonly StepUpFactor[];
  readonly maxAgeSec: number;
}

/**
 * Port over the M2-owned `tenant_step_up_policy_override` table (org-scoped, RLS). Returns null
 * when the tenant has configured no override for the operation — the overwhelmingly common case,
 * and the one that must resolve to the floor rather than to anything more permissive.
 */
export interface StepUpOverrideStore {
  find(
    scope: { orgId: string },
    operationKey: string,
  ): Promise<StepUpOverrideRecord | null> | StepUpOverrideRecord | null;
}

/**
 * Tighten the floor with an override (§4.3.2, D9). With no override the floor stands.
 *
 * Note both directions are closed: a factor the tenant names that the floor does not carry is
 * dropped by the intersection, and a `maxAgeSec` above the floor's is dropped by the min. An
 * override that names ONLY non-floor factors resolves to an EMPTY qualifying set — which denies
 * every session rather than falling back to the floor. That is the correct reading of a tenant
 * saying "only SMS qualifies" against a floor that excludes SMS: the operation becomes
 * unsatisfiable, not unrestricted. The trigger refuses such a row at write time.
 */
export function tightenStepUpPolicy(
  override: StepUpOverrideRecord | null | undefined,
): ResolvedStepUpPolicy {
  if (!override) {
    return {
      qualifyingFactors: STEP_UP_POLICY.qualifyingFactors,
      maxAgeSec: STEP_UP_POLICY.defaultMaxAgeSec,
    };
  }
  const floor = new Set<StepUpFactor>(STEP_UP_POLICY.qualifyingFactors);
  return {
    qualifyingFactors: override.qualifyingFactors.filter((f) => floor.has(f)),
    maxAgeSec: Math.min(override.maxAgeSec, STEP_UP_POLICY.defaultMaxAgeSec),
  };
}

/**
 * In-memory override store — the slice default, keyed `${orgId}::${operationKey}`. Production
 * injects the Drizzle store that reads the table inside `withOrgContext` (RLS-scoped).
 */
export function createInMemoryStepUpOverrideStore(
  seed: Record<string, StepUpOverrideRecord> = {},
): StepUpOverrideStore {
  const byKey = new Map<string, StepUpOverrideRecord>(Object.entries(seed));
  return {
    find: ({ orgId }, operationKey) => byKey.get(`${orgId}::${operationKey}`) ?? null,
  };
}
