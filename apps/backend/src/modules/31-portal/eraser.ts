// apps/backend/src/modules/31-portal/eraser.ts — M31-T06 the §3.7 / D15 portal destruction eraser.
//
// M31 registers a portal eraseFn with M4's destruction-cert workflow (§3.7). This file is the PURE
// orchestration core + its data port (`PortalEraseStore`), the care-plan / document eraser precedent (pure
// `erase*` core + injected store), AND the Drizzle-backed store + `registerPortalErasers()` the composition
// root wires over the Phase-0 `portal_record` deny-stub (M31 is mounted in the boot graph as of T08, and
// `portal_record` is now in REQUIRED_ERASERS).
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
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DataEraser, PatientId } from "@chartwarden/types";
import { and, eq, isNull, sql } from "drizzle-orm";
import { registerEraser } from "../../bootstrap/index";
import { type M31EventEmitter, boundM31EventEmitter, emitGrantsRevoked } from "./events";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The per-table counts a portal destruction removed/flipped (recorded on the destruction certificate). */
export interface PortalEraseCounts {
  readonly telehealthVisitsAborted: number;
  readonly recordingsShredded: number;
  readonly grantsRevoked: number;
  readonly accountsRevoked: number;
  /** GAP-092 — staged (not yet submitted) upload bytes shredded; present only when the store models them. */
  readonly stagedUploadsShredded?: number;
  /** GAP-092 — outstanding invitations killed; present only when the store models them. */
  readonly invitationsRevoked?: number;
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
  /** GAP-092 — shred the patient's staged portal-upload bytes (`portal_document_upload.content_cipher`). */
  shredStagedUploads?(organizationId: string, patientId: PatientId): Promise<number>;
  /** GAP-092 — kill the patient's outstanding portal invitations (their tokens must not outlive the record). */
  revokeOutstandingInvitations?(organizationId: string, patientId: PatientId): Promise<number>;
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
  const telehealthVisitsAborted = await store.abortActiveTelehealthVisits(
    organizationId,
    patientId,
  );
  const recordingsShredded = await store.shredTelehealthRecordings(organizationId, patientId);
  const grantsRevoked = await store.revokeActiveGrantsForPatient(organizationId, patientId);
  const accountsRevoked = await store.revokeAccountsWithNoRemainingGrants(
    organizationId,
    patientId,
  );

  const stagedUploadsShredded = await store.shredStagedUploads?.(organizationId, patientId);
  const invitationsRevoked = await store.revokeOutstandingInvitations?.(organizationId, patientId);

  const counts: PortalEraseCounts = {
    telehealthVisitsAborted,
    recordingsShredded,
    grantsRevoked,
    accountsRevoked,
    ...(stagedUploadsShredded === undefined ? {} : { stagedUploadsShredded }),
    ...(invitationsRevoked === undefined ? {} : { invitationsRevoked }),
  };
  await store.emitShredEvents({ organizationId, patientId, certificateId, counts });

  const erased = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
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

// ── Drizzle-backed store + composition-root registration (M31-T06 boot wiring) ──────────────────────────

/** The sentinel written over a NOT-NULL cipher column when it is shredded in place (the plaintext DEK-encrypted
 * value is discarded; the row survives for FK integrity / the custody chain). */
const SHRED = "";

/**
 * Build the Drizzle-backed {@link PortalEraseStore}. Every statement runs under the destruction cert's org
 * context (`withOrgContext` pins app.org_id so RLS scopes the writes to the tenant being erased). Each step
 * opens its OWN scoped transaction and commits before the next — the ordering in {@link erasePortalRecord} is
 * load-bearing precisely because of that (a grant must be revoked-and-committed before an account can be judged
 * to have no remaining active grant). The M6/M21 eraser precedent.
 */
export function buildDrizzlePortalEraseStore(
  db: DbClient,
  getEvents: () => M31EventEmitter | undefined = () => undefined,
): PortalEraseStore {
  const ACCOUNT = schema.portalAccounts;
  const GRANT = schema.portalAccessGrants;
  const VISIT = schema.telehealthVisits;
  const UPLOAD = schema.portalDocumentUploads;
  const INVITE = schema.portalInvitations;

  const scoped = <T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, fn);

  return {
    async abortActiveTelehealthVisits(organizationId, patientId) {
      return scoped(organizationId, async (tx) => {
        // §3.7 step 1 — a live video room for a destroyed patient must be halted. The CHECK
        // `telehealth_visit_ended_requires_end_reason` forces an end_reason alongside the terminal state.
        const rows = await tx
          .update(VISIT)
          .set({
            lifecycleState: "ended_aborted",
            endReason: "destruction",
            visitEndedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(VISIT.patientId, patientId),
              sql`${VISIT.lifecycleState} not in ('ended_clean','ended_aborted','reconciled')`,
            ),
          )
          .returning({ id: VISIT.id, m17VisitId: VISIT.m17VisitId });
        for (const v of rows) {
          await getEvents()?.emitInTx(
            tx,
            organizationId,
            "m31.telehealth.visit_ended",
            { kind: "telehealth_visit", id: v.id },
            {
              telehealthVisitId: v.id,
              m17VisitId: v.m17VisitId,
              lifecycleState: "ended_aborted",
              endReason: "destruction",
            },
          );
        }
        return rows.length;
      });
    },

    async shredTelehealthRecordings(organizationId, patientId) {
      return scoped(organizationId, async (tx) => {
        // §3.7 step 2 — M31 stores only recording REFS (the two vendor-room ciphers + the end-reason detail).
        // Shred them across ALL the patient's visits so the room is unreachable; the recording BYTES in MinIO
        // are M22's to crypto-erase under its own `telehealth_recording`/`documents` class. The NOT-NULL room
        // ciphers take the SHRED sentinel; the nullable detail cipher goes to NULL.
        const rows = await tx
          .update(VISIT)
          .set({
            vendorRoomIdCipher: SHRED,
            vendorRoomUrlCipher: SHRED,
            endReasonDetailCipher: null,
            updatedAt: sql`now()`,
          })
          .where(eq(VISIT.patientId, patientId))
          .returning({ id: VISIT.id });
        if (rows.length > 0) {
          await getEvents()?.emitInTx(
            tx,
            organizationId,
            "m31.telehealth.recordings_shredded",
            { kind: "telehealth_visit", id: rows[0]?.id ?? patientId },
            { recordingIds: rows.map((r) => r.id) },
          );
        }
        return rows.length;
      });
    },

    async revokeActiveGrantsForPatient(organizationId, patientId) {
      return scoped(organizationId, async (tx) => {
        // §3.7 step 3 — revoke every active grant to the patient. The CHECK
        // `portal_access_grant_revoked_requires_source` forces `revoke_cascade_source` alongside `revoked_at`;
        // the D13 free-text `revoke_reason_cipher` is shredded (nullable → NULL).
        const rows = await tx
          .update(GRANT)
          .set({
            revokedAt: sql`now()`,
            revokeCascadeSource: "destruction",
            revokeReasonCipher: null,
            updatedAt: sql`now()`,
          })
          .where(and(eq(GRANT.patientId, patientId), isNull(GRANT.revokedAt)))
          .returning({
            id: GRANT.id,
            portalAccountId: GRANT.portalAccountId,
            patientId: GRANT.patientId,
          });
        await emitGrantsRevoked(getEvents(), tx, organizationId, rows, "destruction");
        return rows.length;
      });
    },

    async revokeAccountsWithNoRemainingGrants(organizationId, patientId) {
      return scoped(organizationId, async (tx) => {
        // §3.7 step 4 — an account reaches patients ONLY through grants; once the patient's grants are revoked
        // (step 3, already committed), any account left with no active grant to ANY patient is orphaned and is
        // flipped to `revoked` with its contact ciphers shredded. The CHECK `portal_account_revoked_terminal`
        // forces `status='revoked'` alongside `revoked_at`.
        const candidates = await tx
          .selectDistinct({ accountId: GRANT.portalAccountId })
          .from(GRANT)
          .where(eq(GRANT.patientId, patientId));
        let flipped = 0;
        for (const { accountId } of candidates) {
          const remaining = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(GRANT)
            .where(and(eq(GRANT.portalAccountId, accountId), isNull(GRANT.revokedAt)));
          if ((remaining[0]?.n ?? 0) > 0) continue;
          const res = await tx
            .update(ACCOUNT)
            .set({
              status: "revoked",
              revokedAt: sql`now()`,
              displayNameCipher: SHRED,
              emailCipher: SHRED,
              phoneCipher: null,
              updatedAt: sql`now()`,
            })
            .where(and(eq(ACCOUNT.id, accountId), isNull(ACCOUNT.revokedAt)))
            .returning({ id: ACCOUNT.id });
          flipped += res.length;
          for (const a of res) {
            const aggregate = { kind: "portal_account", id: a.id } as const;
            await getEvents()?.emitInTx(
              tx,
              organizationId,
              "m31.portal_account.revoked",
              aggregate,
              {
                portalAccountId: a.id,
                reason: "destruction",
                affectedPatientIds: [patientId],
              },
            );
            await getEvents()?.emitInTx(
              tx,
              organizationId,
              "m31.portal_account.shredded",
              aggregate,
              {
                portalAccountId: a.id,
              },
            );
          }
        }
        return flipped;
      });
    },

    async shredStagedUploads(organizationId, patientId) {
      return scoped(organizationId, async (tx) => {
        // GAP-092 — a staged upload is the caregiver's bytes under the tenant DEK. The row survives as provenance
        // (the app role cannot DELETE); the ciphertext goes and the upload is closed. The CHECK ties the staged
        // status to a present cipher, so both change together.
        const rows = await tx
          .update(UPLOAD)
          .set({
            status: "rejected",
            rejectionCode: "destruction",
            contentCipher: null,
            contentKeyVersion: null,
          })
          .where(
            and(eq(UPLOAD.patientId, patientId), sql`${UPLOAD.status} in ('initiated','staged')`),
          )
          .returning({ id: UPLOAD.id });
        return rows.length;
      });
    },

    async revokeOutstandingInvitations(organizationId, patientId) {
      return scoped(organizationId, async (tx) => {
        const rows = await tx
          .update(INVITE)
          .set({ revokedAt: sql`now()` })
          .where(
            and(
              eq(INVITE.patientId, patientId),
              isNull(INVITE.acceptedAt),
              isNull(INVITE.revokedAt),
            ),
          )
          .returning({ id: INVITE.id });
        return rows.length;
      });
    },

    async emitShredEvents() {
      // §3.7 step 5 — the shred-manifest outbox emit. NO registered eraser on the platform emits
      // transactional-outbox events (the M6/M7/M21 precedent): the destruction itself is the DB disposition
      // above, and the per-table affected-row counts are recorded on the M4 destruction certificate. The
      // `m31.portal_account.shredded` / `m31.telehealth.recordings_shredded` notification emit binds when
      // M31's outbox publisher lands; erasure correctness does not depend on it, so it is a no-op here rather
      // than an un-runnable stub that would make a real destruction throw.
    },
  };
}

/**
 * Register M31's REAL `portal_record` eraser over the Phase-0 deny-stub (M31-T06). Called by the composition
 * root after `wireErasers()` and before `validateErasers()`. `subjectId` is the patient being destroyed; the
 * `DataEraser` contract carries no certificate id, so the emit step (a no-op — see the store) takes none.
 * The returned `erased` is the total count of dispositions (visits aborted + recording refs shredded + grants
 * revoked + accounts revoked).
 */
export function registerPortalErasers(db: DbClient): void {
  // The emitter is bound at boot AFTER the publisher exists (this registration runs earlier), so it is read lazily.
  const store = buildDrizzlePortalEraseStore(db, boundM31EventEmitter);
  const eraser: DataEraser = {
    async erase(scope, subjectId) {
      const { erased } = await erasePortalRecord(scope.orgId, subjectId as PatientId, "", store);
      return { erased };
    },
  };
  registerEraser("portal_record", eraser);
}
