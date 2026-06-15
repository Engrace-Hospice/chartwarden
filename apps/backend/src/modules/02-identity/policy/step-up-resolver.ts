// apps/backend/src/modules/02-identity/policy/step-up-resolver.ts — M2-T05 (M2 spec
// §4.3.2, D9).
//
// Resolves the effective step-up policy for an (organization, operation) by TIGHTENING the
// platform floor `STEP_UP_POLICY` (re-homed to @wardenx/types per ADR-0005 D3) with an
// optional per-tenant override row. Tighten-only is the security invariant (D9): a tenant
// may shrink the qualifying-factor set and the freshness window, never grow them. The
// resolution takes `intersect(floor, tenant)` on factors and `min(floorDefault, tenant)` on
// maxAgeSec, so an override can only ever make step-up harder.
//
// `stepUpSatisfies()` is the evaluation primitive Module 3's `step_up_recent` predicate runs
// against M2's session step-up fields (`lastStepUpAt` / `lastStepUpFactor`). It lives here so
// the contract has ONE definition; M3 consumes it through M2's published session seam
// (M2-T07) rather than re-deriving the freshness/factor math (which would risk drift).
//
// SLICE NOTE: the override is read through an injected `StepUpOverrideReader` port — the slice
// has no live DB. Production injects the reader that selects `tenant_step_up_policy_override`
// (M2-owned, org-scoped) inside `withOrgContext` so RLS scopes the read by `app.org_id`.
import { STEP_UP_POLICY, type StepUpFactor } from "@wardenx/types";

/** A resolved (post-tighten) step-up policy for one (organization, operation). */
export interface ResolvedStepUpPolicy {
  readonly qualifyingFactors: readonly StepUpFactor[];
  readonly maxAgeSec: number;
}

/** A tenant override row's policy-bearing fields (mirrors `tenant_step_up_policy_override`). */
export interface StepUpOverride {
  readonly qualifyingFactors: readonly StepUpFactor[];
  readonly maxAgeSec: number;
}

/** Port over the M2-owned `tenant_step_up_policy_override` table (org-scoped, RLS). */
export interface StepUpOverrideReader {
  find(input: {
    organizationId: string;
    operationKey: string;
  }): Promise<StepUpOverride | null> | StepUpOverride | null;
}

/**
 * Tighten-only resolution (§4.3.2, D9): with no override, the platform floor stands; with
 * one, intersect the qualifying factors against the floor and take the min freshness window.
 * Adding SMS or extending maxAgeSec beyond the floor is impossible by construction — the DB
 * `trg_tenant_step_up_tighten_only` trigger is the at-rest guard; this is its app-layer twin.
 */
export function tightenStepUpPolicy(
  override: StepUpOverride | null | undefined,
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

/** Load + tighten the policy for an (organization, operation). */
export async function resolveStepUpPolicy(
  reader: StepUpOverrideReader,
  input: { organizationId: string; operationKey: string },
): Promise<ResolvedStepUpPolicy> {
  return tightenStepUpPolicy(await reader.find(input));
}

/** The session step-up facts M3's `step_up_recent` predicate evaluates (M2-owned fields). */
export interface SessionStepUpState {
  readonly lastStepUpAt: Date | null;
  readonly lastStepUpFactor: StepUpFactor | null;
}

/** The allow/deny verdict, carrying the deny reason the client UX keys its step-up modal on. */
export interface StepUpDecision {
  readonly allow: boolean;
  readonly reason?: "step_up_required" | "step_up_factor_not_qualifying" | "step_up_stale";
}

/**
 * Whether a session's step-up state satisfies a resolved policy at `now` (§7.8, §7.10):
 *   1. a session that never stepped up is denied (`step_up_required`);
 *   2. a session whose factor isn't in the resolved qualifying set is denied
 *      (`step_up_factor_not_qualifying` — this is what enforces a tenant's WebAuthn-only
 *      tightening against a user who only stepped up with TOTP);
 *   3. a session whose step-up is older than `maxAgeSec` is denied (`step_up_stale`).
 * Evaluated against the LIVE session row at request time — a stale `lastStepUpAt` cannot be
 * replayed to pass (EoP mitigation, §threat-model).
 */
export function stepUpSatisfies(
  policy: ResolvedStepUpPolicy,
  state: SessionStepUpState,
  now: Date,
): StepUpDecision {
  if (!state.lastStepUpAt || !state.lastStepUpFactor) {
    return { allow: false, reason: "step_up_required" };
  }
  if (!policy.qualifyingFactors.includes(state.lastStepUpFactor)) {
    return { allow: false, reason: "step_up_factor_not_qualifying" };
  }
  const ageSec = (now.getTime() - state.lastStepUpAt.getTime()) / 1000;
  if (ageSec > policy.maxAgeSec) {
    return { allow: false, reason: "step_up_stale" };
  }
  return { allow: true };
}

/**
 * In-memory override reader — the slice default. Seeded by `${organizationId}::${operationKey}`.
 * Production injects the Drizzle reader that runs inside `withOrgContext` (RLS-scoped).
 */
export function createInMemoryStepUpOverrideReader(
  seed: Record<string, StepUpOverride> = {},
): StepUpOverrideReader {
  const byKey = new Map<string, StepUpOverride>(Object.entries(seed));
  return {
    find({ organizationId, operationKey }) {
      return byKey.get(`${organizationId}::${operationKey}`) ?? null;
    },
  };
}
