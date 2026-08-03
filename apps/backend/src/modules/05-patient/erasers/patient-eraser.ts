// apps/backend/src/modules/05-patient/erasers/patient-eraser.ts — M5-T12 the `clinical_record` data
// eraser (M5 spec §8 / §10, D7/D8). M5 owns the destruction-cert callback for the patient clinical
// record: under an M4 destruction certificate, it erases the patient SUBTREE (addresses / identifiers
// / payers / caregiver links / contacts / assignments / communication-prefs / privacy snapshots /
// amendments) for the subject patient, while PRESERVING `patient_merge` (audit) and leaving the
// `patient` row as a tombstone (`status='merged'`/destroyed) for FK referential integrity — deletion
// is never destructive on the satellite-table FKs (D8 resolver pattern). Registers the REAL eraser
// over the Phase-0 deny-stub (the `clinical_record` data class is in REQUIRED_ERASERS); the
// composition root's wireModuleErasers() invokes it before validateErasers().
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DataEraser } from "@wardenx/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

/** The per-subtree counts a patient destruction removed (the destruction certificate records these). */
export interface PatientEraseCounts {
  readonly addresses: number;
  readonly identifiers: number;
  readonly payers: number;
  readonly caregiverLinks: number;
  readonly emergencyContacts: number;
  readonly assignments: number;
  readonly communicationPreferences: number;
  readonly privacySnapshots: number;
  readonly amendments: number;
  readonly nameAliases: number;
  readonly phones: number;
  readonly emails: number;
}

/** The narrow data port the patient eraseFn composes over (Drizzle deletes in prod). */
export interface PatientEraseStore {
  /** Delete the patient's subtree rows; return the per-table counts. `patient_merge` is NOT touched. */
  erasePatientSubtree(organizationId: string, patientId: string): Promise<PatientEraseCounts>;
  /** Tombstone the `patient` row (status flip; keeps the PK for FK integrity, D8). */
  tombstonePatient(organizationId: string, patientId: string): Promise<void>;
}

/**
 * Erase a patient's clinical-record subtree under a destruction certificate (D7/D8): delete the
 * satellite rows, tombstone the patient row, and report the total removed. `patient_merge` survives
 * (it is audit). Pure orchestration over the store.
 */
export async function erasePatientClinicalRecord(
  organizationId: string,
  patientId: string,
  store: PatientEraseStore,
): Promise<{ erased: number; counts: PatientEraseCounts }> {
  const counts = await store.erasePatientSubtree(organizationId, patientId);
  await store.tombstonePatient(organizationId, patientId);
  const erased = Object.values(counts).reduce((a, b) => a + b, 0);
  return { erased, counts };
}

/** An in-memory {@link PatientEraseStore} for the slice/tests (seeded per-table counts to remove). */
export function createInMemoryPatientEraseStore(seed: Partial<PatientEraseCounts> = {}): {
  store: PatientEraseStore;
  tombstoned: string[];
} {
  const zero: PatientEraseCounts = {
    addresses: 0,
    identifiers: 0,
    payers: 0,
    caregiverLinks: 0,
    emergencyContacts: 0,
    assignments: 0,
    communicationPreferences: 0,
    privacySnapshots: 0,
    amendments: 0,
    nameAliases: 0,
    phones: 0,
    emails: 0,
  };
  const counts: PatientEraseCounts = { ...zero, ...seed };
  const tombstoned: string[] = [];
  let used = false;
  return {
    tombstoned,
    store: {
      async erasePatientSubtree() {
        // idempotent: a second erase removes nothing (rows already gone).
        const out = used ? zero : counts;
        used = true;
        return out;
      },
      async tombstonePatient(_org, patientId) {
        tombstoned.push(patientId);
      },
    },
  };
}

/**
 * The Drizzle-backed store: the REAL destruction path (ARCH-007 bind). Every statement runs inside
 * `withOrgContext` so RLS scopes it to the acting org (a destruction certificate can never reach
 * across tenants). Discipline:
 *
 *   • SHRED BEFORE DELETE — the envelope-encrypted identifier values (§2.2 ssn/state_id, the only
 *     cipher columns in the M5 subtree) are overwritten FIRST, inside the same transaction, so a
 *     delete pass that fails halfway leaves no readable ciphertext behind. The CHECK
 *     `patient_identifier_sensitive_encrypted` requires `value_encrypted` NOT NULL for those kinds,
 *     so the shred writes an EMPTY bytea (the M31 NOT-NULL shred-sentinel pattern), never NULL.
 *   • COUNTS come from rows actually deleted (`.returning()`), never from input length.
 *   • `patient_merge` is NEVER touched (audit — the header's law), and `patient_match_review` is an
 *     org-level workqueue outside the per-patient subtree contract.
 *   • The `patient` row is TOMBSTONED, not deleted (D8: every module FKs the spine). The enum has no
 *     'destroyed' value; 'merged' demands a redirect target the reader would follow and 'deceased'
 *     demands a death date this path must not invent — so a still-open row flips to the terminal
 *     'discharged' (an already-terminal 'deceased'/'merged' status survives as-is), and the OPTIONAL
 *     demographics (SOGI/marital/race/ethnicity/pronoun codes, middle name/suffix, NPP doc ref) are
 *     cleared. The NOT-NULL identity minimum (legal name, dob, mrn, sex assigned at birth) stays:
 *     the tombstone must remain identifiable for the M4 destruction certificate and the §164.528
 *     accounting of disclosures ("whose records were destroyed").
 *
 * A statement that cannot write THROWS (Drizzle surfaces the SQL error); nothing is swallowed.
 */
export function createDrizzlePatientEraseStore(db: DbClient): PatientEraseStore {
  const P = schema.patients;
  const ADDR = schema.patientAddresses;
  const IDENT = schema.patientIdentifiers;
  const PAYER = schema.patientPayers;
  const CGLINK = schema.patientCaregivers;
  const EC = schema.emergencyContacts;
  const ASSIGN = schema.patientAssignments;
  const COMM = schema.patientCommunicationPreferences;
  const PRIV = schema.patientPrivacyFlagSnapshots;
  const AMEND = schema.patientAmendmentRequests;
  const ALIAS = schema.patientNameAliases;
  const PHONE = schema.patientPhones;
  const EMAIL = schema.patientEmails;

  return {
    async erasePatientSubtree(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // Concurrency fence: same per-patient advisory lock the M15/M16 erasers take, released at
        // transaction commit — a concurrent writer cannot interleave with the destruction.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${patientId}))`);

        // SHRED FIRST (§2.2): the ssn/state_id ciphertexts become an empty bytea + the display tail
        // is cleared, before any delete — a partial failure leaves nothing decryptable. The CHECK
        // demands `value_encrypted` NOT NULL for these kinds, hence the empty-buffer sentinel.
        await tx
          .update(IDENT)
          .set({ valueEncrypted: Buffer.alloc(0), valueLast4: null })
          .where(and(eq(IDENT.patientId, patientId), inArray(IDENT.kind, ["ssn", "state_id"])));

        const del = async <T extends { id: string }>(run: () => Promise<T[]>): Promise<number> =>
          (await run()).length;

        // All satellites hang directly off `patient_id` (no inter-satellite FKs) — the order below
        // simply mirrors the PatientEraseCounts contract.
        const addresses = await del(() =>
          tx.delete(ADDR).where(eq(ADDR.patientId, patientId)).returning({ id: ADDR.id }),
        );
        const identifiers = await del(() =>
          tx.delete(IDENT).where(eq(IDENT.patientId, patientId)).returning({ id: IDENT.id }),
        );
        const payers = await del(() =>
          tx.delete(PAYER).where(eq(PAYER.patientId, patientId)).returning({ id: PAYER.id }),
        );
        // The patient↔caregiver LINK rows go; the org-scoped `caregiver` registry rows survive (they
        // are the caregiver's own record, and M39's delegated-access projection may reference them).
        const caregiverLinks = await del(() =>
          tx.delete(CGLINK).where(eq(CGLINK.patientId, patientId)).returning({ id: CGLINK.id }),
        );
        const emergencyContacts = await del(() =>
          tx.delete(EC).where(eq(EC.patientId, patientId)).returning({ id: EC.id }),
        );
        const assignments = await del(() =>
          tx.delete(ASSIGN).where(eq(ASSIGN.patientId, patientId)).returning({ id: ASSIGN.id }),
        );
        // PK is `patient_id` on the one-row-per-patient tables — return that as the count key.
        const communicationPreferences = await del(() =>
          tx
            .delete(COMM)
            .where(eq(COMM.patientId, patientId))
            .returning({ id: COMM.patientId }),
        );
        const privacySnapshots = await del(() =>
          tx
            .delete(PRIV)
            .where(eq(PRIV.patientId, patientId))
            .returning({ id: PRIV.patientId }),
        );
        const amendments = await del(() =>
          tx.delete(AMEND).where(eq(AMEND.patientId, patientId)).returning({ id: AMEND.id }),
        );
        const nameAliases = await del(() =>
          tx.delete(ALIAS).where(eq(ALIAS.patientId, patientId)).returning({ id: ALIAS.id }),
        );
        const phones = await del(() =>
          tx.delete(PHONE).where(eq(PHONE.patientId, patientId)).returning({ id: PHONE.id }),
        );
        const emails = await del(() =>
          tx.delete(EMAIL).where(eq(EMAIL.patientId, patientId)).returning({ id: EMAIL.id }),
        );

        return {
          addresses,
          identifiers,
          payers,
          caregiverLinks,
          emergencyContacts,
          assignments,
          communicationPreferences,
          privacySnapshots,
          amendments,
          nameAliases,
          phones,
          emails,
        };
      });
    },

    async tombstonePatient(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // Clear the optional demographics on the tombstone (the NOT-NULL identity minimum survives —
        // see the factory header). Idempotent: a second pass re-writes the same values.
        await tx
          .update(P)
          .set({
            legalMiddleName: null,
            legalNameSuffix: null,
            genderIdentityCode: null,
            sexualOrientationCode: null,
            pronounsCode: null,
            maritalStatusCode: null,
            raceCodes: null,
            ethnicityCodes: null,
            nppAcknowledgmentDocRef: null,
            updatedAt: new Date(),
          })
          .where(eq(P.id, patientId));
        // Status flip to the terminal 'discharged' — but never off an already-terminal state:
        // 'deceased' must keep its date-backed truth and 'merged' its redirect (both CHECK-enforced).
        await tx
          .update(P)
          .set({ status: "discharged" })
          .where(
            and(eq(P.id, patientId), sql`${P.status} NOT IN ('deceased','merged','discharged')`),
          );
      });
    },
  };
}

/** Injected adapter for the M5 eraser (slice defaults to in-memory). */
export interface PatientEraserDeps {
  store?: PatientEraseStore;
}

/** Build M5's `clinical_record` DataEraser. `subjectId` is the patient being destroyed (§10). */
export function createPatientEraser(store: PatientEraseStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await erasePatientClinicalRecord(scope.orgId, subjectId, store);
      return { erased };
    },
  };
}

/** Register M5's REAL `clinical_record` eraser over the Phase-0 deny-stub (M5-T12; before validateErasers()). */
export function registerPatientErasers(deps: PatientEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryPatientEraseStore().store;
  registerEraser("clinical_record", createPatientEraser(store));
}
