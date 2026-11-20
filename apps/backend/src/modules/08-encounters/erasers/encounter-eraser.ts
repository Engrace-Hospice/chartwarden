// apps/backend/src/modules/08-encounters/erasers/encounter-eraser.ts — M8-T12 the `encounter_record`
// data eraser (M8 spec §3.6 / D9 from Module 4; M4 destruction-cert workflow, D7/D8).
//
// M8 owns the destruction callback for a patient's ENCOUNTER record — the visit-note satellites M8
// creates around the M5 patient spine: encounter signatures, addenda, care-plan links, cosignature
// requests, vitals, mileage, and the HearthNote selection / assembled-output / llm-modification rows.
// Under an M4 destruction certificate it (1) cryptographically erases the HearthNote ciphertext via the
// tenant DEK (§3.6 — `hearthnote_selection.free_text_cipher`, `hearthnote_assembled_output.*_cipher`),
// then (2) deletes that subtree for the subject patient while leaving the `encounter` root as a
// TOMBSTONE (status `voided`, every reason text replaced with one placeholder; the PK survives for FK
// referential integrity) — the same D8 resolver pattern
// M5's `clinical_record`, M6's `admission_record`, and M7's `care_plan_record` erasers use. The four
// erasers are disjoint by table ownership: M5 destroys the patient demographics subtree, M6 the
// admission subtree, M7 the care-plan subtree, M8 the encounter subtree it owns.
//
// Registers the REAL eraser over the Phase-0 deny-stub (`encounter_record` is in REQUIRED_ERASERS); the
// composition root's wireModuleErasers() invokes it AFTER wireErasers() (deny-stubs) and before
// validateErasers(), so a real eraser stands over its stub.
//
// Two preconditions the eraser relies on rather than owns:
//  - the DESTRUCTION CREDENTIAL. `eraseEncounterRecord` asks the store `assertDestructionRole` BEFORE any write and refuses
//    (DegradedError, 503) when the connection is not a member of `chartwarden_destruction`. wireModuleErasers() falls back to the
//    app pool when DATABASE_DESTRUCTION_URL is unset; without this check the shred and the tombstone (both permitted to the app
//    role) would commit and only the delete (not granted) would fail, voiding the root irreversibly while its satellites stay.
//  - the LEGAL HOLD. M8 owns no hold table and reads none. The only caller of any registered eraser is M34's tenant shred
//    (shred-eraser-adapter.ts), and its preflight (`assertCertApprovedAndNoHold`, shred-worker.ts, before `callbackAllEraserFns`)
//    refuses the whole tenant while ANY `legal_hold` is active in the org (m34-destruction-workflow.ts, shred-preflight.ts), a
//    stricter grain than per patient. The preflight and the eraser run in different transactions and nothing locks `legal_hold`, so
//    a hold committed after the preflight and before this eraser's transactions is not seen.
import { type DbClient, schema } from "@chartwarden/db";
import { VOCAB_VERSION, activeNarrativeVocabRelease } from "@chartwarden/narrative-vocab";
import { withOrgContext } from "@chartwarden/tenancy";
import { type DataEraser, DegradedError } from "@chartwarden/types";
import { type AnyColumn, type SQL, and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/**
 * The one text every non-null free-text reason column on an erased `encounter` root becomes (§3.6 step 2). It carries no PHI and is at
 * least 100 characters, the longest floor any of those columns has in its tier/state (`encounter_administrative_override_consistency`),
 * so the root's CHECKs still hold after the scrub. One fixed value, so a rerun writes the same bytes.
 */
export const ENCOUNTER_ERASED_REASON =
  "Free text erased under a destruction certificate; the original text is not recoverable and this placeholder keeps the record valid.";

/** The per-table counts an encounter-record destruction removed (recorded on the destruction cert). */
export interface EncounterEraseCounts {
  /** `encounter` roots this run tombstoned; a root already tombstoned by an earlier run is not counted again. */
  readonly tombstonedRoots: number;
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

/** What the satellite delete reports; `eraseEncounterRecord` adds the tombstoned roots from {@link EncounterEraseStore.tombstoneEncounters}. */
export type EncounterSubtreeCounts = Omit<EncounterEraseCounts, "tombstonedRoots">;

/** The database role every encounter destruction must run as (migration 0157 grants it the M8 deletes). */
export const ENCOUNTER_DESTRUCTION_ROLE = "chartwarden_destruction";

/** The refusal for a connection that is not the destruction role; thrown before the first write. */
function destructionRoleRefusal(): DegradedError {
  return new DegradedError(
    "encounter-destruction",
    `the database connection is not a member of ${ENCOUNTER_DESTRUCTION_ROLE} (DATABASE_DESTRUCTION_URL is unset or names another role); refusing to erase, nothing was written`,
  );
}

/** The narrow data port the encounter eraseFn composes over (Drizzle deletes in prod, under RLS). */
export interface EncounterEraseStore {
  /** Refuse (throw) unless the connection is the destruction role; called BEFORE any write, so a refusal changes nothing. */
  assertDestructionRole(organizationId: string): Promise<void>;
  /**
   * Cryptographically erase the HearthNote ciphertext for the patient's encounters by destroying the
   * decrypting tenant DEK material (§3.6) — the ciphertext stays in the rows but is irrecoverable. Runs
   * FIRST so a crash mid-erase still leaves the PHI unreadable (same ordering as M36's DEK-first erase).
   */
  cryptoEraseHearthnote(organizationId: string, patientId: string): Promise<void>;
  /** Delete the patient's encounter satellites; return per-table counts. The `encounter` root is NOT deleted. */
  eraseEncounterSubtree(organizationId: string, patientId: string): Promise<EncounterSubtreeCounts>;
  /**
   * Tombstone the patient's `encounter` root(s): voided, reason text scrubbed to a placeholder, PK kept for FK integrity (D8).
   * Returns how many roots it CHANGED: a root an earlier run already tombstoned is left alone and not counted.
   */
  tombstoneEncounters(organizationId: string, patientId: string): Promise<number>;
}

/**
 * Erase a patient's encounter-record subtree under a destruction certificate (D7/D8): crypto-erase the
 * HearthNote ciphertext, tombstone the `encounter` root(s), delete the satellite rows, and report the
 * total (satellite rows deleted plus roots tombstoned). The role check runs first and writes nothing. A failed run (three
 * transactions: shred, tombstone, delete) is retried whole; every step is idempotent, and the retry reports only what IT changed.
 * Pure orchestration over the store — no I/O of its own. DEK-first so the PHI is
 * unreadable the instant the key is gone, even if a later step fails; the root's free text is scrubbed
 * before the deletes so a tombstone that fails leaves the satellites in place for a retry, never a
 * root with its text and no satellites.
 */
export async function eraseEncounterRecord(
  organizationId: string,
  patientId: string,
  store: EncounterEraseStore,
): Promise<{ erased: number; counts: EncounterEraseCounts }> {
  await store.assertDestructionRole(organizationId);
  await store.cryptoEraseHearthnote(organizationId, patientId);
  const tombstonedRoots = await store.tombstoneEncounters(organizationId, patientId);
  const counts = {
    tombstonedRoots,
    ...(await store.eraseEncounterSubtree(organizationId, patientId)),
  };
  const erased = Object.values(counts).reduce((a, b) => a + b, 0);
  return { erased, counts };
}

/** An in-memory {@link EncounterEraseStore} for the slice/tests (seeded per-table counts to remove). */
export function createInMemoryEncounterEraseStore(
  seed: Partial<EncounterEraseCounts> = {},
  options: { destructionRole?: boolean } = {},
): {
  store: EncounterEraseStore;
  tombstoned: string[];
  cryptoErased: string[];
} {
  const zero: EncounterSubtreeCounts = {
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
  const { tombstonedRoots = 0, ...subtreeSeed } = seed;
  const counts: EncounterSubtreeCounts = { ...zero, ...subtreeSeed };
  const tombstoned: string[] = [];
  const cryptoErased: string[] = [];
  let used = false;
  return {
    tombstoned,
    cryptoErased,
    store: {
      async assertDestructionRole() {
        if (options.destructionRole === false) throw destructionRoleRefusal();
      },
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
        // idempotent: a root already tombstoned is not changed, so not counted again.
        if (tombstoned.includes(patientId)) return 0;
        tombstoned.push(patientId);
        return tombstonedRoots;
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
 * sentinel (the M31 precedent); nullable ones to NULL, except `layer2_cipher` on a Layer-2-involved output, which
 * the CHECK keeps non-null (→ ""). Counts come from `returning` lengths (rows ACTUALLY removed). Migration
 * 0031 grants `chartwarden_app` no DELETE on any encounter table, so under an app-role connection Postgres
 * REFUSES the delete pass and this store THROWS — the destruction path must be handed the
 * `chartwarden_destruction` `DbClient` (DATABASE_DESTRUCTION_URL at the composition root): migration 0157
 * grants that role SELECT/UPDATE/DELETE on the M8 tables behind an org-scoped FOR ALL policy on each.
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
    async assertDestructionRole(organizationId) {
      // pg_has_role is true for a superuser too, which can run every statement below; the check is for the app-pool fallback.
      const isMember = await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const result = await tx.execute(
          sql`SELECT pg_has_role(${ENCOUNTER_DESTRUCTION_ROLE}::name, 'member') AS is_member`,
        );
        return (result as unknown as { rows: Array<{ is_member: boolean }> }).rows[0]?.is_member;
      });
      if (isMember !== true) throw destructionRoleRefusal();
    },

    async cryptoEraseHearthnote(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const encounterIds = await encounterIdsFor(tx, patientId);
        if (encounterIds.length === 0) return; // idempotent: nothing to shred.
        const addendumIds = await addendumIdsFor(tx, encounterIds);
        // Shred FIRST (§3.6): free_text_cipher is nullable → NULL; layer1/final are NOT NULL → "". layer2_cipher is nullable, but
        // `hearthnote_output_layer2_consistency` keeps it non-null on an output with layer2_involved_at_finalize, so a null stays
        // null (Layer 2 was off) and a value becomes "" — never a blanket NULL, which that CHECK refuses and rolls the shred back.
        await tx
          .update(SEL)
          .set({ freeTextCipher: null })
          .where(selectionScope(encounterIds, addendumIds));
        await tx
          .update(AO)
          .set({
            layer1Cipher: "",
            layer2Cipher: sql`CASE WHEN ${AO.layer2Cipher} IS NULL THEN NULL ELSE '' END`,
            finalCipher: "",
          })
          .where(assembledScope(encounterIds, addendumIds));
      });
    },

    async eraseEncounterSubtree(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const encounterIds = await encounterIdsFor(tx, patientId);
        const zero: EncounterSubtreeCounts = {
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
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // D8 tombstone (§3.6 step 2): the root SURVIVES as a structural shell (the PK stays for FK integrity) and its text is
        // replaced with sentinels, in ONE statement so every CHECK is judged on the finished row, never on a half-scrubbed one:
        //  - status goes to the terminal 'voided', which `encounter_voided_consistency` only allows with voided_at, voided_by and
        //    a voided_reason of 40+ characters; voided_at / voided_by stay when a human already voided the root (that attribution
        //    is the record's), else now / the root's author (no system membership exists; m17-visit-closed attributes a system
        //    void to the author the same way);
        //  - a non-draft root needs vocab_version_id (`encounter_vocab_pinned_when_finalized`), so a draft is pinned to the
        //    running build's corpus release exactly as finalize pins it (D11); a root that already carries a pin keeps it;
        //  - every non-null reason column becomes the one placeholder (a null stays null), and the placeholder clears every
        //    tier/state length floor. voided_reason is never null on a voided root, so it is always the placeholder, which also
        //    scrubs the text of a root a human had already voided.
        //  - voided_by: a root a human did not void says the clinician voided it (voided_by = authored_by_membership_id), because no
        //    system membership exists; the placeholder reason says it was erased under a destruction certificate, and the audit actor
        //    of the update is NULL (userId ""). Read voided_by on a tombstoned root with that in mind.
        // Only a root that still needs the scrub is updated, and that is the count returned: a rerun finds none, writes nothing (no
        // second write-audit row per root) and reports 0; voided_at/voided_by/vocab keep.
        const pin = activeNarrativeVocabRelease(VOCAB_VERSION).id;
        const scrubbed = (column: AnyColumn): SQL =>
          sql`CASE WHEN ${column} IS NULL THEN NULL ELSE ${ENCOUNTER_ERASED_REASON}::text END`;
        const needsScrub = (column: AnyColumn): SQL =>
          sql`(${column} IS NOT NULL AND ${column} IS DISTINCT FROM ${ENCOUNTER_ERASED_REASON}::text)`;
        const changed = await tx
          .update(ENC)
          .set({
            status: "voided",
            evvMissingReason: scrubbed(ENC.evvMissingReason),
            lateEntryReason: scrubbed(ENC.lateEntryReason),
            significantLateOverrideReason: scrubbed(ENC.significantLateOverrideReason),
            administrativeOverrideReason: scrubbed(ENC.administrativeOverrideReason),
            voidedReason: ENCOUNTER_ERASED_REASON,
            voidedAt: sql`COALESCE(${ENC.voidedAt}, now())`,
            voidedBy: sql`COALESCE(${ENC.voidedBy}, ${ENC.authoredByMembershipId})`,
            vocabVersionId: sql`COALESCE(${ENC.vocabVersionId}, ${pin}::uuid)`,
          })
          .where(
            and(
              eq(ENC.patientId, patientId),
              or(
                ne(ENC.status, "voided"),
                sql`${ENC.voidedReason} IS DISTINCT FROM ${ENCOUNTER_ERASED_REASON}::text`,
                needsScrub(ENC.evvMissingReason),
                needsScrub(ENC.lateEntryReason),
                needsScrub(ENC.significantLateOverrideReason),
                needsScrub(ENC.administrativeOverrideReason),
              ),
            ),
          )
          .returning({ id: ENC.id });
        return changed.length;
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
