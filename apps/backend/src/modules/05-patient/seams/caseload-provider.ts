// apps/backend/src/modules/05-patient/seams/caseload-provider.ts — M5-T07 the CaseloadProvider seam
// (M5 spec §4.1, §7.5). CLOSES the M3 boot-gate deny-stub: M3 declared `CaseloadProvider` + the
// `caseload_membership` ABAC predicate that resolves through it; M5 registers the REAL resolver here
// over `patient_assignment` (open rows = `unassigned_at IS NULL`), additively unioned with M17's
// active-shift visit assignments (an aide on a one-off visit today sees that chart today). §7.5
// caseload narrowing: `caseloadPatientIds` is the `patient_id = ANY(:ids)` list filter; `isInCaseload`
// is the per-chart gate. RLS is the backstop even if ABAC is bypassed (§9.4).
//
// Pure orchestration over an injected `CaseloadStore` port — the in-memory store backs the slice +
// tests; production injects the Drizzle-backed store (reads under `withOrgContext` so RLS scopes by
// app.org_id). M17's shift cache is a forward additive source: Phase-1 the store answers from
// `patient_assignment` alone; the union point is the same method when M17 lands.
import type { CaseloadProvider } from "@wardenx/types";
import { abacRegistry, registerPredicate } from "@wardenx/auth";
import { getSeam, registerSeam } from "../../../bootstrap/index";

/** The data port the CaseloadProvider composes over (Drizzle over patient_assignment in prod). */
export interface CaseloadStore {
  /** Is there an OPEN patient_assignment for (org, user, patient)? (+ M17 shift cache when it lands). */
  isAssigned(organizationId: string, userId: string, patientId: string): Promise<boolean>;
  /** Distinct patient ids with an OPEN assignment for (org, user) — the §7.5 narrowing set. */
  assignedPatientIds(organizationId: string, userId: string): Promise<readonly string[]>;
}

/** Build the real {@link CaseloadProvider} over an injected store (slice in-memory; Drizzle in prod). */
export function createCaseloadProvider(store: CaseloadStore): CaseloadProvider {
  return {
    async isInCaseload({ organizationId, userId, patientId }) {
      return store.isAssigned(organizationId, userId, patientId);
    },
    async caseloadPatientIds({ organizationId, userId }) {
      return store.assignedPatientIds(organizationId, userId);
    },
  };
}

/** Injected production adapter for M5's caseload seam (slice defaults to in-memory). */
export interface CaseloadSeamDeps {
  store?: CaseloadStore;
}

/** The M3 ABAC predicate name M5's CaseloadProvider resolves (M5 §4.1; M3-owned predicate). */
export const CASELOAD_MEMBERSHIP_PREDICATE = "caseload_membership";

/**
 * Register M5's `CaseloadProvider` into the M1 registry AND wire the `caseload_membership` ABAC
 * predicate to resolve through it (M5-T07; before validateSeams()). The predicate denies (fail
 * closed) when the context lacks an org/user or the target carries no patient id.
 */
export function registerCaseloadSeam(deps: CaseloadSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryCaseloadStore().store;
  registerSeam("CaseloadProvider", createCaseloadProvider(store));

  // The predicate is single-owner in the shared ABAC registry (§4.2) and the registry has no clear,
  // so register it ONCE — guard with `has` so a re-boot (tests) re-points the seam without throwing.
  if (!abacRegistry.has(CASELOAD_MEMBERSHIP_PREDICATE)) {
    registerPredicate(CASELOAD_MEMBERSHIP_PREDICATE, async (context, target) => {
      const patientId = typeof target.id === "string" ? target.id : null;
      if (!patientId || !context.organizationId || !context.userId) return false;
      return getCaseloadProvider().isInCaseload({
        organizationId: context.organizationId,
        userId: context.userId,
        patientId,
      });
    });
  }
}

/** Typed resolver for the registered CaseloadProvider (sound: registerCaseloadSeam registered a real
 *  impl and validateSeams() guarantees an instance, fail-closed, before any consumer runs). */
export function getCaseloadProvider(): CaseloadProvider {
  return getSeam("CaseloadProvider");
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────

/** An open assignment seed row (org, user, patient) — an unassigned_at-IS-NULL patient_assignment. */
export interface SeedAssignment {
  readonly organizationId: string;
  readonly userId: string;
  readonly patientId: string;
}

/** An in-memory {@link CaseloadStore} for the slice/tests. Deterministic, no I/O. */
export function createInMemoryCaseloadStore(seed: readonly SeedAssignment[] = []): {
  store: CaseloadStore;
} {
  const key = (o: string, u: string) => `${o} ${u}`;
  const byUser = new Map<string, Set<string>>();
  for (const a of seed) {
    const k = key(a.organizationId, a.userId);
    (byUser.get(k) ?? byUser.set(k, new Set()).get(k)!).add(a.patientId);
  }
  return {
    store: {
      async isAssigned(organizationId, userId, patientId) {
        return byUser.get(key(organizationId, userId))?.has(patientId) ?? false;
      },
      async assignedPatientIds(organizationId, userId) {
        return [...(byUser.get(key(organizationId, userId)) ?? [])];
      },
    },
  };
}
