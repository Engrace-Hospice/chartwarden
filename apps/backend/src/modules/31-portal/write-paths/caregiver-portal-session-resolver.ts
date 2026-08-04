// apps/backend/src/modules/31-portal/write-paths/caregiver-portal-session-resolver.ts — M31-T06 (§7.7 / M13 D10).
//
// CLOSES M13's forward deny-stub. M13 ships `CaregiverPortalSessionResolver` (apps/backend/src/modules/13-emar/
// seams/m31-caregiver-attested-portal.ts) as a pure DENY-STUB (`{ bound: false, reason: 'M31_NOT_BOUND' }`) so
// its caregiver-attested write route can, at M31 lock, VERIFY that the posting portal session is actually bound
// to the `{patientId}` in the body — rather than trusting the permission-gated body alone. This file is M31's
// LIVE resolver: given an authenticated caregiver portal session, it returns the patient that session is bound
// to (or a fail-closed deny). The composition root (T07) hands this to M13's route in place of the deny-stub —
// no cross-module import edge either way (M13 declares the CONTRACT; M31 satisfies it structurally; the boot
// wiring adapts M31's richer deny reasons down to M13's `M31_NOT_BOUND` literal).
//
// M31 cannot import M13's type (that would be an apps→apps cross-module import dependency-cruiser forbids and
// there is no M31→M13 `dependsOn` edge). So the resolution shape is declared HERE, structurally identical to
// M13's `CaregiverPortalSessionResolution` on the success branch. This is the same "structural match, adapt at
// the boundary" posture M20's field-safety deny-stubs use.
//
// PURE orchestration over an injected {@link CaregiverSessionPort}: no I/O of its own. FAILS CLOSED — an
// unknown/closed/idle-expired session, an account that is not active, or a session whose bound patient has no
// active grant all resolve to `{ bound: false }`. A read failure in the port is the caller's to catch and map
// to a deny (never a default-allow), the §8.2 layering rule the whole module obeys.
import type { PatientId } from "@wardenx/types";

/** Why a caregiver portal session could not be resolved to a bound patient (all fail-closed). The boot
 *  adapter collapses every value to M13's single `M31_NOT_BOUND` literal when handing this to M13's route. */
export type CaregiverSessionDenyReason =
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_ACTIVE"
  | "PATIENT_MISMATCH"
  | "GRANT_NOT_ACTIVE";

/** The result of resolving an M31 caregiver portal session — structurally matches M13's success branch. */
export type CaregiverPortalSessionResolution =
  | { readonly bound: true; readonly patientId: PatientId; readonly caregiverDisplayName: string }
  | { readonly bound: false; readonly reason: CaregiverSessionDenyReason };

/** The session facts the caller resolves through the T03 session store + the T06 grant reader (Drizzle at
 *  boot). All reads are org-scoped; the port never crosses tenants. */
export interface CaregiverSessionSnapshot {
  /** The portal account backing the session. */
  readonly portalAccountId: string;
  /** The patient the session is scoped to (§8.1 — one session, one patient). */
  readonly activePatientId: PatientId;
  /** The account is `active` or `bereaved` (a suspended/revoked account resolves to a deny). */
  readonly accountActive: boolean;
  /** There is a live (non-revoked) `portal_access_grant` for (account, activePatient). */
  readonly grantActive: boolean;
  /** The caregiver's display name (decrypted at the port; NEVER logged) — M13 shows it on the cosign queue. */
  readonly caregiverDisplayName: string;
}

/** The narrow port the resolver composes over (Drizzle-backed session + grant read at boot; slice in tests). */
export interface CaregiverSessionPort {
  /** Load the session snapshot for an org + session id, or null when no such session exists / it is closed. */
  loadSession(
    organizationId: string,
    caregiverSessionId: string,
  ): Promise<CaregiverSessionSnapshot | null>;
}

/** The live resolver M31 hands M13 in place of `denyStubCaregiverPortalSessionResolver`. */
export interface PortalCaregiverSessionResolver {
  resolve(
    organizationId: string,
    caregiverSessionId: string,
  ): Promise<CaregiverPortalSessionResolution>;
}

/**
 * Build the live {@link PortalCaregiverSessionResolver} over an injected {@link CaregiverSessionPort}. It
 * resolves a session to its bound patient, failing CLOSED at every gap:
 *   • no session row / closed session → SESSION_NOT_FOUND
 *   • account not active/bereaved     → SESSION_NOT_ACTIVE
 *   • no active grant for the patient → GRANT_NOT_ACTIVE
 *
 * `expectedPatientId` (optional) lets M13's route assert the session is bound to the SAME patient named in the
 * request body — a body claiming patient X on a session bound to patient Y resolves to PATIENT_MISMATCH, so a
 * permission-gated but mis-targeted post cannot write into the wrong chart (§7.7 / §8.2).
 */
export function createPortalCaregiverSessionResolver(
  port: CaregiverSessionPort,
): PortalCaregiverSessionResolver & {
  resolveForPatient(
    organizationId: string,
    caregiverSessionId: string,
    expectedPatientId: PatientId,
  ): Promise<CaregiverPortalSessionResolution>;
} {
  async function resolveInternal(
    organizationId: string,
    caregiverSessionId: string,
    expectedPatientId: PatientId | null,
  ): Promise<CaregiverPortalSessionResolution> {
    const snap = await port.loadSession(organizationId, caregiverSessionId);
    if (snap === null) return { bound: false, reason: "SESSION_NOT_FOUND" };
    if (!snap.accountActive) return { bound: false, reason: "SESSION_NOT_ACTIVE" };
    if (expectedPatientId !== null && snap.activePatientId !== expectedPatientId)
      return { bound: false, reason: "PATIENT_MISMATCH" };
    if (!snap.grantActive) return { bound: false, reason: "GRANT_NOT_ACTIVE" };
    return {
      bound: true,
      patientId: snap.activePatientId,
      caregiverDisplayName: snap.caregiverDisplayName,
    };
  }

  return {
    resolve: (organizationId, caregiverSessionId) =>
      resolveInternal(organizationId, caregiverSessionId, null),
    resolveForPatient: (organizationId, caregiverSessionId, expectedPatientId) =>
      resolveInternal(organizationId, caregiverSessionId, expectedPatientId),
  };
}

// ── in-memory slice port ──────────────────────────────────────────────────────────────────────────────

/** A seeded in-memory {@link CaregiverSessionPort} for the slice/tests. */
export function createInMemoryCaregiverSessionPort(
  seed: ReadonlyArray<
    {
      readonly organizationId: string;
      readonly caregiverSessionId: string;
    } & CaregiverSessionSnapshot
  >,
): CaregiverSessionPort {
  const rows = new Map<string, CaregiverSessionSnapshot>();
  for (const r of seed) rows.set(`${r.organizationId}::${r.caregiverSessionId}`, r);
  return {
    async loadSession(organizationId, caregiverSessionId) {
      return rows.get(`${organizationId}::${caregiverSessionId}`) ?? null;
    },
  };
}
