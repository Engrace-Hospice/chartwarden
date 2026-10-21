// apps/backend/src/modules/08-encounters/erasers/encounter-eraser.ts — M8-T12 the `encounter_record`
// data eraser (M8 spec §3.6 / D9 from Module 4; M4 destruction-cert workflow, D7/D8).
//
// M8 owns the destruction callback for a patient's ENCOUNTER record — the visit-note satellites M8
// creates around the M5 patient spine: encounter signatures, addenda, care-plan links, cosignature
// requests, vitals, mileage, and the HearthNote selection / assembled-output / llm-modification rows.
// Under an M4 destruction certificate it (1) cryptographically erases the HearthNote ciphertext via the
// tenant DEK (§3.6 — `hearthnote_selection.free_text_cipher`, `hearthnote_assembled_output.*_cipher`),
// then (2) deletes that subtree for the subject patient while leaving the `encounter` root as a
// TOMBSTONE (status flip; the PK survives for FK referential integrity) — the same D8 resolver pattern
// M5's `clinical_record`, M6's `admission_record`, and M7's `care_plan_record` erasers use. The four
// erasers are disjoint by table ownership: M5 destroys the patient demographics subtree, M6 the
// admission subtree, M7 the care-plan subtree, M8 the encounter subtree it owns.
//
// Registers the REAL eraser over the Phase-0 deny-stub (`encounter_record` is in REQUIRED_ERASERS); the
// composition root's wireModuleErasers() invokes it AFTER wireErasers() (deny-stubs) and before
// validateErasers(), so a real eraser stands over its stub.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DataEraser } from "@chartwarden/types";
import { type SQL, eq, inArray, or } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The per-table counts an encounter-record destruction removed (recorded on the destruction cert). */
export interface EncounterEraseCounts {
  readonly signatures: number;
  readonly addenda: number;
  readonly carePlanLinks: number;
  readonly cosignatureRequests: number;
  readonly vitals: number;
  readonly mileage: number;
  readonly hearthnoteSelections: number;
  readonly hearthnoteAssembledOutputs: number;
  readonly hearthnoteLlmModifications: number;
}

/** The narrow data port the encounter eraseFn composes over (Drizzle deletes in prod, under RLS). */
export interface EncounterEraseStore {
  /**
   * Cryptographically erase the HearthNote ciphertext for the patient's encounters by destroying the
   * decrypting tenant DEK material (§3.6) — the ciphertext stays in the rows but is irrecoverable. Runs
   * FIRST so a crash mid-erase still leaves the PHI unreadable (same ordering as M36's DEK-first erase).
   */
  cryptoEraseHearthnote(organizationId: string, patientId: string): Promise<void>;
  /** Delete the patient's encounter satellites; return per-table counts. The `encounter` root is NOT deleted. */
  eraseEncounterSubtree(organizationId: string, patientId: string): Promise<EncounterEraseCounts>;
  /** Tombstone the patient's `encounter` root(s) (status flip; keeps the PK for FK integrity, D8). */
  tombstoneEncounters(organizationId: string, patientId: string): Promise<void>;
}

/**
 * Erase a patient's encounter-record subtree under a destruction certificate (D7/D8): crypto-erase the
 * HearthNote ciphertext, delete the satellite rows, tombstone the `encounter` root(s), and report the
 * total removed. Pure orchestration over the store — no I/O of its own. DEK-first so the PHI is
 * unreadable the instant the key is gone, even if a later step fails.
 */
export async function eraseEncounterRecord(
  organizationId: string,
  patientId: string,
  store: EncounterEraseStore,
): Promise<{ erased: number; counts: EncounterEraseCounts }> {
  await store.cryptoEraseHearthnote(organizationId, patientId);
  const counts = await store.eraseEncounterSubtree(organizationId, patientId);
  await store.tombstoneEncounters(organizationId, patientId);
  const erased = Object.values(counts).reduce((a, b) => a + b, 0);
  return { erased, counts };
}

/** An in-memory {@link EncounterEraseStore} for the slice/tests (seeded per-table counts to remove). */
export function createInMemoryEncounterEraseStore(seed: Partial<EncounterEraseCounts> = {}): {
  store: EncounterEraseStore;
  tombstoned: string[];
  cryptoErased: string[];
} {
  const zero: EncounterEraseCounts = {
    signatures: 0,
    addenda: 0,
    carePlanLinks: 0,
    cosignatureRequests: 0,
    vitals: 0,
    mileage: 0,
    hearthnoteSelections: 0,
    hearthnoteAssembledOutputs: 0,
    hearthnoteLlmModifications: 0,
  };
  const counts: EncounterEraseCounts = { ...zero, ...seed };
  const tombstoned: string[] = [];
  const cryptoErased: string[] = [];
  let used = false;
  return {
    tombstoned,
    cryptoErased,
    store: {
      async cryptoEraseHearthnote(_org, patientId) {
        cryptoErased.push(patientId);
      },
      async eraseEncounterSubtree() {
        // idempotent: a second erase removes nothing (rows already gone).
        const out = used ? zero : counts;
        used = true;
        return out;
      },
      async tombstoneEncounters(_org, patientId) {
        tombstoned.push(patientId);
      },
    },
  };
}

/**
 * The Drizzle-backed store: the REAL destruction path (TASK-003 / ARCH-007). Runs inside
 * `withOrgContext` so RLS scopes every statement to the acting org. The §3.6 crypto-erase is executed
 * as a SHRED of the HearthNote cipher columns themselves: with only a `DbClient` this store cannot
 * reach the M36 key custodian to destroy the tenant DEK, and destroying the ciphertext bytes is
 * strictly stronger — the PHI is unreadable under ANY key the moment the shred commits, before any
 * delete runs (shred-before-delete, the M16/M31 ordering). NOT-NULL cipher columns shred to the ""
 * sentinel (the M31 precedent); nullable ones to NULL. Counts come from `returning` lengths (rows
 * ACTUALLY removed). Migration 0031 grants `wardenx_app` no DELETE on any encounter table, so under an
 * app-role connection Postgres REFUSES the delete pass and this store THROWS — the destruction path
 * must be handed a privileged (wardenx_admin) `DbClient` at the composition root.
 */
export function createDrizzleEncounterEraseStore(db: DbClient): EncounterEraseStore {
  const ENC = schema.encounters;
  const SIG = schema.encounterSignatures;
  const ADD = schema.encounterAddenda;
  const LINK = schema.encounterCarePlanLinks;
  const COSIGN = schema.cosignatureRequests;
  const VITALS = schema.vitals;
  const MILEAGE = schema.mileage;
  const SEL = schema.hearthnoteSelections;
  const AO = schema.hearthnoteAssembledOutputs;
  const LLM = schema.hearthnoteLlmModifications;

  /** The patient's encounter-root ids — every satellite is keyed on `encounter_id`, not the patient. */
  const encounterIdsFor = async (tx: Tx, patientId: string): Promise<string[]> =>
    (await tx.select({ id: ENC.id }).from(ENC).where(eq(ENC.patientId, patientId))).map(
      (r) => r.id,
    );

  /** The addendum ids under those encounters — HearthNote rows may hang off an addendum instead. */
  const addendumIdsFor = async (tx: Tx, encounterIds: string[]): Promise<string[]> =>
    (await tx.select({ id: ADD.id }).from(ADD).where(inArray(ADD.encounterId, encounterIds))).map(
      (r) => r.id,
    );

  /** HearthNote rows hang off the encounter OR one of its addenda (both FKs nullable). */
  const selectionScope = (encounterIds: string[], addendumIds: string[]): SQL | undefined =>
    or(
      inArray(SEL.encounterId, encounterIds),
      addendumIds.length > 0 ? inArray(SEL.addendumId, addendumIds) : undefined,
    );
  const assembledScope = (encounterIds: string[], addendumIds: string[]): SQL | undefined =>
    or(
      inArray(AO.encounterId, encounterIds),
      addendumIds.length > 0 ? inArray(AO.addendumId, addendumIds) : undefined,
    );

  return {
    async cryptoEraseHearthnote(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const encounterIds = await encounterIdsFor(tx, patientId);
        if (encounterIds.length === 0) return; // idempotent: nothing to shred.
        const addendumIds = await addendumIdsFor(tx, encounterIds);
        // Shred FIRST (§3.6): free_text_cipher is nullable → NULL; layer1/final are NOT NULL → "".
        await tx
          .update(SEL)
          .set({ freeTextCipher: null })
          .where(selectionScope(encounterIds, addendumIds));
        await tx
          .update(AO)
          .set({ layer1Cipher: "", layer2Cipher: null, finalCipher: "" })
          .where(assembledScope(encounterIds, addendumIds));
      });
    },

    async eraseEncounterSubtree(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const encounterIds = await encounterIdsFor(tx, patientId);
        const zero: EncounterEraseCounts = {
          signatures: 0,
          addenda: 0,
          carePlanLinks: 0,
          cosignatureRequests: 0,
          vitals: 0,
          mileage: 0,
          hearthnoteSelections: 0,
          hearthnoteAssembledOutputs: 0,
          hearthnoteLlmModifications: 0,
        };
        if (encounterIds.length === 0) return zero; // idempotent: a second erase finds nothing.
        const addendumIds = await addendumIdsFor(tx, encounterIds);
        const del = async <T extends { id: string }>(run: () => Promise<T[]>): Promise<number> =>
          (await run()).length;

        // FK order: llm_modification → assembled_output; the two hearthnote tables and the signatures
        // reference addenda, so all of them go before `encounter_addendum`; the remaining satellites
        // (care-plan links / cosignature requests / vitals / mileage) are independent encounter leaves.
        const hearthnoteLlmModifications = await del(() =>
          tx
            .delete(LLM)
            .where(
              inArray(
                LLM.assembledOutputId,
                tx.select({ id: AO.id }).from(AO).where(assembledScope(encounterIds, addendumIds)),
              ),
            )
            .returning({ id: LLM.id }),
        );
        const hearthnoteAssembledOutputs = await del(() =>
          tx.delete(AO).where(assembledScope(encounterIds, addendumIds)).returning({ id: AO.id }),
        );
        const hearthnoteSelections = await del(() =>
          tx.delete(SEL).where(selectionScope(encounterIds, addendumIds)).returning({ id: SEL.id }),
        );
        const signatures = await del(() =>
          tx.delete(SIG).where(inArray(SIG.encounterId, encounterIds)).returning({ id: SIG.id }),
        );
        const addenda = await del(() =>
          tx.delete(ADD).where(inArray(ADD.encounterId, encounterIds)).returning({ id: ADD.id }),
        );
        const carePlanLinks = await del(() =>
          tx.delete(LINK).where(inArray(LINK.encounterId, encounterIds)).returning({ id: LINK.id }),
        );
        const cosignatureRequests = await del(() =>
          tx
            .delete(COSIGN)
            .where(inArray(COSIGN.encounterId, encounterIds))
            .returning({ id: COSIGN.id }),
        );
        const vitals = await del(() =>
          tx
            .delete(VITALS)
            .where(inArray(VITALS.encounterId, encounterIds))
            .returning({ id: VITALS.id }),
        );
        const mileage = await del(() =>
          tx
            .delete(MILEAGE)
            .where(inArray(MILEAGE.encounterId, encounterIds))
            .returning({ id: MILEAGE.id }),
        );

        return {
          signatures,
          addenda,
          carePlanLinks,
          cosignatureRequests,
          vitals,
          mileage,
          hearthnoteSelections,
          hearthnoteAssembledOutputs,
          hearthnoteLlmModifications,
        };
      });
    },

    async tombstoneEncounters(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // D8 tombstone: the root row SURVIVES for FK referential integrity — status flips to the
        // terminal 'voided' and every free-text reason column on the root is scrubbed.
        await tx
          .update(ENC)
          .set({
            status: "voided",
            evvMissingReason: null,
            lateEntryReason: null,
            significantLateOverrideReason: null,
            administrativeOverrideReason: null,
            voidedReason: null,
          })
          .where(eq(ENC.patientId, patientId));
      });
    },
  };
}

/** Injected adapter for the M8 eraser (slice defaults to in-memory). */
export interface EncounterEraserDeps {
  store?: EncounterEraseStore;
}

/** Build M8's `encounter_record` DataEraser. `subjectId` is the patient being destroyed (D7/D8). */
export function createEncounterEraser(store: EncounterEraseStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseEncounterRecord(scope.orgId, subjectId, store);
      return { erased };
    },
  };
}

/** Register M8's REAL `encounter_record` eraser over the Phase-0 deny-stub (M8-T12; before validateErasers()). */
export function registerEncounterErasers(deps: EncounterEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryEncounterEraseStore().store;
  registerEraser("encounter_record", createEncounterEraser(store));
}
