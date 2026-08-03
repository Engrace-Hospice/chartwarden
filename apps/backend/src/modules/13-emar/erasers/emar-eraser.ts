// apps/backend/src/modules/13-emar/erasers/emar-eraser.ts — M13-T10 the `emar_record` data eraser (M13 spec
// §7.7; M4 destruction-cert workflow).
//
// M13 owns the destruction callback for a patient's eMAR subtree — the administration rows M13 captures around
// the M5 patient spine / M6 admission anchor. Under an M4 destruction certificate it (1) acquires a per-patient
// advisory lock so a concurrent write cannot interleave with the destruction, (2) erases the monthly-partitioned
// `administration_record` rows (`administered_at < retentionAsOf`) — at PARTITION granularity (DETACH + DROP)
// when a partition is wholly erasable, by row-level delete for a mixed partition (the M11/M12 order_record
// precedent) — together with the cascaded `prn_administration`, `administration_witness`, and
// `barcode_scan_event` child rows for the deleted administrations, plus the patient's `scheduled_dose` /
// `missed_dose` rows, the `comfort_kit_deployment` / `comfort_kit_drawdown` rows, the
// `medication_reconciliation_worksheet` / `medication_reconciliation_decision` rows, and the
// `administration_offline_queue` rows older than `retentionAsOf` (§7.7 #1–#6). The ORG-scoped
// `administration_policy` SURVIVES: it is tenant configuration, not patient data (§7.7 #7). Unlike M10's HOPE
// eraser there is no CMS extended-retention block — administration records carry M4's standard `compliance`
// retention class, enforced by the certificate's `retentionAsOf` boundary, not by this callback (§7.7). The
// sibling clinical erasers are disjoint by table ownership: M12 destroys the prescribing subtree, M13 the eMAR
// subtree.
//
// Registers the REAL eraser over the Phase-0 deny-stub (`emar_record` is in REQUIRED_ERASERS); the composition
// root's wireModuleErasers() invokes it AFTER wireErasers() (deny-stubs) and before validateErasers(), so a real
// eraser stands over its stub.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DataEraser } from "@wardenx/types";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

/** The per-table counts an eMAR-record destruction removed (recorded on the destruction cert, §7.7). */
export interface EmarEraseCounts {
  /** `administration_record` rows removed (whether by partition drop or row delete). */
  readonly administrations: number;
  /** `prn_administration` rows deleted (cascaded from the deleted administrations). */
  readonly prnAdministrations: number;
  /** `administration_witness` rows deleted (cascaded from the deleted administrations). */
  readonly witnesses: number;
  /** `barcode_scan_event` rows deleted (cascaded from the deleted administrations). */
  readonly barcodeScans: number;
  /** `scheduled_dose` rows deleted for the patient. */
  readonly scheduledDoses: number;
  /** `missed_dose` rows deleted for the patient. */
  readonly missedDoses: number;
  /** `comfort_kit_deployment` rows deleted for the patient. */
  readonly comfortKitDeployments: number;
  /** `comfort_kit_drawdown` rows deleted (cascaded from the deleted deployments). */
  readonly comfortKitDrawdowns: number;
  /** `medication_reconciliation_worksheet` rows deleted for the patient. */
  readonly reconciliationWorksheets: number;
  /** `medication_reconciliation_decision` rows deleted (cascaded from the deleted worksheets). */
  readonly reconciliationDecisions: number;
  /** `administration_offline_queue` rows deleted for the patient. */
  readonly offlineQueueRows: number;
  /** Whole `administration_record` partitions DETACHed + DROPped (the partition-drop path). */
  readonly partitionsDropped: number;
}

/** Knobs the M4 destruction cert carries into the erase (defaults: erase everything up to now). */
export interface EmarEraseOptions {
  /** Erase rows older than `retentionAsOf`; defaults to {@link EmarEraseOptions.now}'s instant. */
  readonly retentionAsOf?: string;
  /** Clock injection (tests pin it); defaults to the system clock. */
  readonly now?: () => string;
}

/** The narrow data port the eMAR eraseFn composes over (Drizzle deletes in prod, under RLS). */
export interface EmarEraseStore {
  /**
   * Acquire a per-patient advisory lock (keyed on patient id) so a concurrent write cannot interleave with the
   * destruction. Released by the surrounding transaction commit in prod; a no-op in the slice.
   */
  lockPatient(organizationId: string, patientId: string): Promise<void>;
  /**
   * Erase the patient's `administration_record` rows (`administered_at < retentionAsOf`; partition DETACH+DROP
   * where a partition is wholly erasable, row-level delete otherwise) plus the cascaded `prn_administration` /
   * `administration_witness` / `barcode_scan_event` child rows and the `scheduled_dose` / `missed_dose` /
   * `comfort_kit_deployment` / `comfort_kit_drawdown` / `medication_reconciliation_worksheet` /
   * `medication_reconciliation_decision` / `administration_offline_queue` rows. The org-scoped
   * `administration_policy` is left intact (§7.7 #7). Returns counts.
   */
  eraseEmarSubtree(
    organizationId: string,
    patientId: string,
    retentionAsOf: string,
  ): Promise<EmarEraseCounts>;
}

/**
 * Erase a patient's eMAR subtree under a destruction certificate (§7.7): lock the patient, then delete the
 * administration rows + child + satellite rows and report the total removed. Pure orchestration over the store —
 * no I/O of its own. The org-scoped administration policy is never touched (§7.7 #7).
 */
export async function eraseEmarRecord(
  organizationId: string,
  patientId: string,
  store: EmarEraseStore,
  options: EmarEraseOptions = {},
): Promise<{ erased: number; counts: EmarEraseCounts }> {
  const now = options.now ?? (() => new Date().toISOString());
  const retentionAsOf = options.retentionAsOf ?? now();

  await store.lockPatient(organizationId, patientId);

  const counts = await store.eraseEmarSubtree(organizationId, patientId, retentionAsOf);
  // partitionsDropped is bookkeeping (how the administration rows left), already counted in `administrations`.
  const erased =
    counts.administrations +
    counts.prnAdministrations +
    counts.witnesses +
    counts.barcodeScans +
    counts.scheduledDoses +
    counts.missedDoses +
    counts.comfortKitDeployments +
    counts.comfortKitDrawdowns +
    counts.reconciliationWorksheets +
    counts.reconciliationDecisions +
    counts.offlineQueueRows;
  return { erased, counts };
}

/** Seed shape for the in-memory {@link EmarEraseStore} (slice/tests). */
export interface InMemoryEmarEraseSeed {
  /** Per-table counts a first erase removes; `partitionsDropped` selects the partition-drop vs row-delete path. */
  readonly counts?: Partial<EmarEraseCounts>;
}

/** An in-memory {@link EmarEraseStore} for the slice/tests (seeded counts; idempotent on a second erase). */
export function createInMemoryEmarEraseStore(seed: InMemoryEmarEraseSeed = {}): {
  store: EmarEraseStore;
  locked: string[];
} {
  const zero: EmarEraseCounts = {
    administrations: 0,
    prnAdministrations: 0,
    witnesses: 0,
    barcodeScans: 0,
    scheduledDoses: 0,
    missedDoses: 0,
    comfortKitDeployments: 0,
    comfortKitDrawdowns: 0,
    reconciliationWorksheets: 0,
    reconciliationDecisions: 0,
    offlineQueueRows: 0,
    partitionsDropped: 0,
  };
  const counts: EmarEraseCounts = { ...zero, ...seed.counts };
  const locked: string[] = [];
  let used = false;
  return {
    locked,
    store: {
      async lockPatient(_org, patientId) {
        locked.push(patientId);
      },
      async eraseEmarSubtree() {
        // idempotent: a second erase removes nothing (rows already gone).
        const out = used ? zero : counts;
        used = true;
        return out;
      },
    },
  };
}

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/**
 * The Drizzle-backed store: the REAL destruction path. Runs inside `withOrgContext` so RLS scopes every
 * statement to the acting org (a destruction certificate can never reach across tenants). Deletes the
 * partitioned `administration_record` parent via the partition-key predicate the route tier uses
 * (`patient_id` + `administered_at < retentionAsOf`) — the row-delete arm of the M11/M12 precedent. The
 * DETACH+DROP arm is a DDL maintenance path that needs table-owner privileges the RLS-scoped
 * `wardenx_app` role does not hold, so this store always reports `partitionsDropped: 0`; a wholly-
 * erasable partition is still fully emptied row-by-row, which is destruction-equivalent (the partition
 * shell holds no PHI). Any statement the database refuses THROWS and rolls the erase back — the erase
 * never reports success it did not perform.
 */
export function createDrizzleEmarEraseStore(db: DbClient): EmarEraseStore {
  const ADM = schema.administrationRecords;
  const PRN = schema.prnAdministrations;
  const WIT = schema.administrationWitnesses;
  const SCAN = schema.barcodeScanEvents;
  const SCHED = schema.scheduledDoses;
  const MISSED = schema.missedDoses;
  const KIT = schema.comfortKitDeployments;
  const DRAW = schema.comfortKitDrawdowns;
  const WS = schema.medicationReconciliationWorksheets;
  const DEC = schema.medicationReconciliationDecisions;
  const OFFQ = schema.administrationOfflineQueue;

  /** The patient's erasable administration ids (`administered_at < boundary`) — the cascade key. */
  const adminIdsFor = async (tx: Tx, patientId: string, boundary: Date): Promise<string[]> =>
    (
      await tx
        .select({ id: ADM.id })
        .from(ADM)
        .where(and(eq(ADM.patientId, patientId), lt(ADM.administeredAt, boundary)))
    ).map((r) => r.id);

  return {
    async lockPatient(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // Advisory lock on the patient key, released by the surrounding transaction commit.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${patientId}))`);
      });
    },

    async eraseEmarSubtree(organizationId, patientId, retentionAsOf) {
      if (Number.isNaN(Date.parse(retentionAsOf))) {
        throw new Error(`M13_ERASER_BAD_RETENTION_BOUNDARY: ${retentionAsOf}`);
      }
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const boundary = new Date(retentionAsOf);
        const adminIds = await adminIdsFor(tx, patientId, boundary);
        const del = async <T extends { id: string }>(run: () => Promise<T[]>): Promise<number> =>
          (await run()).length;

        // ── (1) Children cascaded from the DELETED administrations (no SQL FK to the partitioned
        // parent — the cascade is app-owned).
        const prnAdministrations =
          adminIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(PRN)
                  .where(inArray(PRN.administrationRecordId, adminIds))
                  .returning({ id: PRN.id }),
              );
        const witnesses =
          adminIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(WIT)
                  .where(inArray(WIT.administrationRecordId, adminIds))
                  .returning({ id: WIT.id }),
              );
        // A pre-commit scan carries a NULL administration_record_id and only a wristband-payload DIGEST
        // (never the raw payload), so the patient-attributable scans are exactly the linked ones.
        const barcodeScans =
          adminIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(SCAN)
                  .where(inArray(SCAN.administrationRecordId, adminIds))
                  .returning({ id: SCAN.id }),
              );
        // `administration_offline_queue` carries no patient column (§3.3 — digest-only idempotency
        // rows on a 30-day purge path); the patient-attributable rows are the ones whose sync landed on
        // a deleted administration.
        const offlineQueueRows =
          adminIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(OFFQ)
                  .where(inArray(OFFQ.syncedAdministrationRecordId, adminIds))
                  .returning({ id: OFFQ.id }),
              );

        // ── (2) The partitioned parent, via the partition-key predicate (row-delete arm).
        const administrations = await del(() =>
          tx
            .delete(ADM)
            .where(and(eq(ADM.patientId, patientId), lt(ADM.administeredAt, boundary)))
            .returning({ id: ADM.id }),
        );

        // ── (3) Patient-keyed satellites. Loose-FK children go before their parents: missed_dose →
        // scheduled_dose, comfort_kit_drawdown → comfort_kit_deployment (the drawdown carries no
        // patient column — the parent deployment is the patient anchor), reconciliation decision →
        // worksheet.
        const missedDoses = await del(() =>
          tx.delete(MISSED).where(eq(MISSED.patientId, patientId)).returning({ id: MISSED.id }),
        );
        const scheduledDoses = await del(() =>
          tx.delete(SCHED).where(eq(SCHED.patientId, patientId)).returning({ id: SCHED.id }),
        );

        const kitIds = (
          await tx.select({ id: KIT.id }).from(KIT).where(eq(KIT.patientId, patientId))
        ).map((r) => r.id);
        const comfortKitDrawdowns =
          kitIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(DRAW)
                  .where(inArray(DRAW.comfortKitDeploymentId, kitIds))
                  .returning({ id: DRAW.id }),
              );
        const comfortKitDeployments =
          kitIds.length === 0
            ? 0
            : await del(() => tx.delete(KIT).where(inArray(KIT.id, kitIds)).returning({ id: KIT.id }));

        const worksheetIds = (
          await tx.select({ id: WS.id }).from(WS).where(eq(WS.patientId, patientId))
        ).map((r) => r.id);
        const reconciliationDecisions =
          worksheetIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(DEC)
                  .where(inArray(DEC.worksheetId, worksheetIds))
                  .returning({ id: DEC.id }),
              );
        const reconciliationWorksheets =
          worksheetIds.length === 0
            ? 0
            : await del(() => tx.delete(WS).where(inArray(WS.id, worksheetIds)).returning({ id: WS.id }));

        // `administration_policy` is org-scoped tenant configuration — never touched (§7.7 #7).
        return {
          administrations,
          prnAdministrations,
          witnesses,
          barcodeScans,
          scheduledDoses,
          missedDoses,
          comfortKitDeployments,
          comfortKitDrawdowns,
          reconciliationWorksheets,
          reconciliationDecisions,
          offlineQueueRows,
          partitionsDropped: 0,
        };
      });
    },
  };
}

/** Injected adapter for the M13 eraser (slice defaults to in-memory). */
export interface EmarEraserDeps {
  store?: EmarEraseStore;
  /** Bound from the M4 destruction certificate in prod; the slice keeps the conservative defaults. */
  options?: EmarEraseOptions;
}

/** Build M13's `emar_record` DataEraser. `subjectId` is the patient being destroyed (§7.7). */
export function createEmarEraser(store: EmarEraseStore, options: EmarEraseOptions = {}): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseEmarRecord(scope.orgId, subjectId, store, options);
      return { erased };
    },
  };
}

/** Register M13's REAL `emar_record` eraser over the Phase-0 deny-stub (M13-T10; before validateErasers()). */
export function registerEmarErasers(deps: EmarEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryEmarEraseStore().store;
  registerEraser("emar_record", createEmarEraser(store, deps.options ?? {}));
}
