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
import type { CareTeamProvider } from "@chartwarden/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";

/** The data port CareTeamProvider composes over (Drizzle over patient_assignment in prod). */
export interface CareTeamStore {
  /** Every distinct clinician user id with an OPEN patient_assignment for (org, patient). */
  listMembers(organizationId: string, patientId: string): Promise<readonly string[]>;
  /**
   * The clinician user id on the OPEN `primary_rn` assignment for (org, patient), or null (GAP-022).
   * Separate from {@link listMembers} rather than a filter the caller applies afterwards: the role lives
   * on the assignment row, and returning every member's role to let a consumer pick would leak the whole
   * roster to answer a one-clinician question.
   */
  findPrimaryRn(organizationId: string, patientId: string): Promise<string | null>;
  /**
   * The same open `primary_rn` assignment as {@link findPrimaryRn}, resolved to the clinician's ACTIVE
   * membership id in `organizationId` (M8 §2.6 check 10 / §2.4 D3 routing — a cosignature is routed to a
   * membership, not to a user account). Null when there is no such assignment OR the clinician's
   * membership in that org is no longer active: an RN who has left the agency is not an eligible
   * cosigner, and answering with their stale membership id would route a clinical duty to nobody.
   */
  findPrimaryRnMembership(organizationId: string, patientId: string): Promise<string | null>;
}

/** Build the real {@link CareTeamProvider} over an injected store (slice in-memory; Drizzle in prod). */
export function createCareTeamProvider(store: CareTeamStore): CareTeamProvider {
  return {
    async careTeamMembers({ organizationId, patientId }) {
      return store.listMembers(organizationId, patientId);
    },
    async primaryRnUserId({ organizationId, patientId }) {
      return store.findPrimaryRn(organizationId, patientId);
    },
    async primaryRnMembershipId({ organizationId, patientId }) {
      return store.findPrimaryRnMembership(organizationId, patientId);
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
  /** The `patient_assignment_role` value; defaults to a non-case-manager role (GAP-022). */
  readonly role?: string;
  /**
   * The clinician's ACTIVE membership id in this org, for `findPrimaryRnMembership`. Omitted means the
   * clinician has no active membership — which is a real state (an RN who has left), not a shorthand
   * for "same as the user id", so the seam answers null for them.
   */
  readonly membershipId?: string;
}

/** The `patient_assignment_role` member that IS the RN case manager (§3.5; one open row per patient). */
export const PRIMARY_RN_ASSIGNMENT_ROLE = "primary_rn";

/**
 * The non-clinical access-grant role given to whoever created a patient from a referral (migration 1137). It
 * puts the actor on the caseload so the chart opens, and is NOT a care-team member: every care-team roster
 * (channel membership, display) excludes it.
 */
export const ADMITTING_STAFF_ASSIGNMENT_ROLE = "admitting_staff";

/** An in-memory {@link CareTeamStore} for the slice/tests. Deterministic, no I/O. */
export function createInMemoryCareTeamStore(seed: readonly SeedCareTeamAssignment[] = []): {
  store: CareTeamStore;
} {
  const key = (o: string, p: string) => `${o} ${p}`;
  const byPatient = new Map<string, Set<string>>();
  const primaryRnByPatient = new Map<string, string>();
  const primaryRnMembershipByPatient = new Map<string, string>();
  for (const a of seed) {
    const k = key(a.organizationId, a.patientId);
    (byPatient.get(k) ?? byPatient.set(k, new Set()).get(k)!).add(a.clinicianUserId);
    // First seeded primary_rn wins — mirrors the DB's partial unique index (at most one open row), so a
    // seed that violates it behaves like the DB would rather than silently picking the last writer.
    if (a.role === PRIMARY_RN_ASSIGNMENT_ROLE && !primaryRnByPatient.has(k)) {
      primaryRnByPatient.set(k, a.clinicianUserId);
      if (a.membershipId !== undefined) primaryRnMembershipByPatient.set(k, a.membershipId);
    }
  }
  return {
    store: {
      async listMembers(organizationId, patientId) {
        return [...(byPatient.get(key(organizationId, patientId)) ?? [])];
      },
      async findPrimaryRn(organizationId, patientId) {
        return primaryRnByPatient.get(key(organizationId, patientId)) ?? null;
      },
      async findPrimaryRnMembership(organizationId, patientId) {
        return primaryRnMembershipByPatient.get(key(organizationId, patientId)) ?? null;
      },
    },
  };
}
