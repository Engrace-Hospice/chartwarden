// apps/backend/src/modules/05-patient/seams/care-team-provider.ts — the CareTeamProvider seam
// (M36 spec D5, §2.3; GAP-059). CLOSES M36's `syncCareTeamChannel` deny-stub: the spec says a
// per-patient `care_team` channel's membership is auto-managed against the M5/M17 caseload and
// "a CareTeamProvider seam (boot-validated) tells M36 who's on the team" — this is that seam.
// Same `patient_assignment` open-row source as CaseloadProvider (M5-T07), just the reverse
// direction (patient → users instead of user → patients).
//
// Pure orchestration over an injected CareTeamStore port — the in-memory store backs the slice +
// tests; production injects the Drizzle-backed store (reads under `withOrgContext` so RLS scopes
// by app.org_id).
import type { CareTeamProvider } from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";

/** The data port CareTeamProvider composes over (Drizzle over patient_assignment in prod). */
export interface CareTeamStore {
  /** Every distinct clinician user id with an OPEN patient_assignment for (org, patient). */
  listMembers(organizationId: string, patientId: string): Promise<readonly string[]>;
}

/** Build the real {@link CareTeamProvider} over an injected store (slice in-memory; Drizzle in prod). */
export function createCareTeamProvider(store: CareTeamStore): CareTeamProvider {
  return {
    async careTeamMembers({ organizationId, patientId }) {
      return store.listMembers(organizationId, patientId);
    },
  };
}

/** Injected production adapter for M5's care-team seam (slice defaults to in-memory). */
export interface CareTeamSeamDeps {
  store?: CareTeamStore;
}

/** Register M5's `CareTeamProvider` into the M1 registry (before validateSeams()). */
export function registerCareTeamSeam(deps: CareTeamSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryCareTeamStore().store;
  registerSeam("CareTeamProvider", createCareTeamProvider(store));
}

/** Typed resolver for the registered CareTeamProvider (sound: registerCareTeamSeam registered a
 *  real impl and validateSeams() guarantees an instance, fail-closed, before any consumer runs). */
export function getCareTeamProvider(): CareTeamProvider {
  return getSeam("CareTeamProvider");
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────

/** An open assignment seed row (org, patient, clinician) — an unassigned_at-IS-NULL patient_assignment. */
export interface SeedCareTeamAssignment {
  readonly organizationId: string;
  readonly patientId: string;
  readonly clinicianUserId: string;
}

/** An in-memory {@link CareTeamStore} for the slice/tests. Deterministic, no I/O. */
export function createInMemoryCareTeamStore(seed: readonly SeedCareTeamAssignment[] = []): {
  store: CareTeamStore;
} {
  const key = (o: string, p: string) => `${o} ${p}`;
  const byPatient = new Map<string, Set<string>>();
  for (const a of seed) {
    const k = key(a.organizationId, a.patientId);
    (byPatient.get(k) ?? byPatient.set(k, new Set()).get(k)!).add(a.clinicianUserId);
  }
  return {
    store: {
      async listMembers(organizationId, patientId) {
        return [...(byPatient.get(key(organizationId, patientId)) ?? [])];
      },
    },
  };
}
