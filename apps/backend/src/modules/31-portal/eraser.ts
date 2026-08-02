// apps/backend/src/modules/31-portal/eraser.ts — M31-T06 the §3.7 / D15 portal destruction eraser.
//
// M31 registers a portal eraseFn with M4's destruction-cert workflow (§3.7). This file is the PURE
// orchestration core + its data port (Drizzle deletes under RLS at boot; slice in tests), the care-plan /
// document eraser precedent (pure `erase*` core + injected store; the composition-root `registerEraser` call
// lands with the module mount in T07 — M31 is not yet in the boot graph, and there is no `portal` DataClass in
// REQUIRED_ERASERS to register against until then).
//
// §3.7 order of operations (the destruction certificate records affected-row counts per table, M4 §24.5):
//   1. Halt active telehealth visits for the patient (force `lifecycle_state='ended_aborted'`).
//   2. Shred telehealth recording bytes via M22 (MinIO + tenant-DEK crypto-erase); M31 stores only refs.
//   3. Revoke active `portal_access_grant` rows with `revoke_cascade_source='destruction'`.
//   4. Flip `portal_account.status='revoked'` iff no active grant remains for the account across OTHER patients.
//   5. Emit `m31.portal_account.shredded` + `m31.telehealth.recordings_shredded` with the hash manifest.
//
// The document-upload provenance step (§3.7 step 3) is a NO-OP in the reduced 3-table scope — M31 owns no
// `portal_document_upload` table (M22 shreds the intake batch under its own `documents` eraser). PURE: no I/O
// of its own; every effect is a port call.
import type { PatientId } from "@wardenx/types";

/** The per-table counts a portal destruction removed/flipped (recorded on the destruction certificate). */
export interface PortalEraseCounts {
  readonly telehealthVisitsAborted: number;
  readonly recordingsShredded: number;
  readonly grantsRevoked: number;
  readonly accountsRevoked: number;
}

/** The narrow data port the portal eraseFn composes over (Drizzle writes under `withOrgContext` in prod). */
export interface PortalEraseStore {
  /** §3.7 step 1 — force every active telehealth visit for the patient to `ended_aborted`; return the count. */
  abortActiveTelehealthVisits(organizationId: string, patientId: PatientId): Promise<number>;
  /** §3.7 step 2 — shred telehealth recording bytes via M22 + flip the M31 ref rows; return the count. */
  shredTelehealthRecordings(organizationId: string, patientId: PatientId): Promise<number>;
  /** §3.7 step 3 — revoke active grants for the patient with `revoke_cascade_source='destruction'`. */
  revokeActiveGrantsForPatient(organizationId: string, patientId: PatientId): Promise<number>;
  /** §3.7 step 4 — flip accounts to `revoked` when the patient's revocation left them with no active grant
   *  across ANY patient; return the count actually flipped. */
  revokeAccountsWithNoRemainingGrants(
    organizationId: string,
    patientId: PatientId,
  ): Promise<number>;
  /** §3.7 step 5 — emit the shred outbox events with the destruction hash manifest. */
  emitShredEvents(input: {
    organizationId: string;
    patientId: PatientId;
    certificateId: string;
    counts: PortalEraseCounts;
  }): Promise<void>;
}

/**
 * Erase a patient's portal footprint under a destruction certificate (§3.7 / D15): abort live visits, shred
 * recording bytes via M22, revoke grants, revoke now-orphaned accounts, and emit the shred manifest. Runs the
 * steps in the spec order (a live visit must halt before its recording is shredded; a grant must be revoked
 * before an account can be judged orphaned). PURE orchestration over the store.
 */
export async function erasePortalRecord(
  organizationId: string,
  patientId: PatientId,
  certificateId: string,
  store: PortalEraseStore,
): Promise<{ erased: number; counts: PortalEraseCounts }> {
  const telehealthVisitsAborted = await store.abortActiveTelehealthVisits(organizationId, patientId);
  const recordingsShredded = await store.shredTelehealthRecordings(organizationId, patientId);
  const grantsRevoked = await store.revokeActiveGrantsForPatient(organizationId, patientId);
  const accountsRevoked = await store.revokeAccountsWithNoRemainingGrants(organizationId, patientId);

  const counts: PortalEraseCounts = {
    telehealthVisitsAborted,
    recordingsShredded,
    grantsRevoked,
    accountsRevoked,
  };
  await store.emitShredEvents({ organizationId, patientId, certificateId, counts });

  const erased = Object.values(counts).reduce((a, b) => a + b, 0);
  return { erased, counts };
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────────────

/** A capturing in-memory {@link PortalEraseStore} for the slice/tests (seeded per-step counts to remove). */
export function createInMemoryPortalEraseStore(seed: Partial<PortalEraseCounts> = {}): {
  store: PortalEraseStore;
  emitted: Array<{ patientId: PatientId; certificateId: string; counts: PortalEraseCounts }>;
} {
  const emitted: Array<{ patientId: PatientId; certificateId: string; counts: PortalEraseCounts }> =
    [];
  return {
    emitted,
    store: {
      async abortActiveTelehealthVisits() {
        return seed.telehealthVisitsAborted ?? 0;
      },
      async shredTelehealthRecordings() {
        return seed.recordingsShredded ?? 0;
      },
      async revokeActiveGrantsForPatient() {
        return seed.grantsRevoked ?? 0;
      },
      async revokeAccountsWithNoRemainingGrants() {
        return seed.accountsRevoked ?? 0;
      },
      async emitShredEvents(input) {
        emitted.push({
          patientId: input.patientId,
          certificateId: input.certificateId,
          counts: input.counts,
        });
      },
    },
  };
}
