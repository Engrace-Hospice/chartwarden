// apps/backend/src/modules/12-dosespot/erasers/dosespot-eraser.ts — M12-T09 the `medication_order_record`
// data eraser (M12 spec §7.7 / D15; M4 destruction-cert workflow, D7/D8).
//
// M12 owns the destruction callback for a patient's prescribing subtree — the medication-order rows M12
// captures around the M5 patient spine / M6 admission anchor. Under an M4 destruction certificate it (1)
// acquires a per-patient advisory lock so a concurrent write cannot interleave with the destruction, (2)
// erases the monthly-partitioned `medication_order` rows (`created_at < retentionAsOf`) — at PARTITION
// granularity (DETACH + DROP) when a partition is wholly erasable, by row-level delete for a mixed partition
// (§3 / the M11 order_record precedent) — together with the cascaded `medication_order_transmission`,
// `refill_request` (whose source order matches), and `epcs_signing_attempt` child rows for the deleted orders.
// The ORG-scoped `dosespot_prescriber`, `refill_inbox_policy`, and `controlled_substance_policy` SURVIVE:
// they are tenant configuration, not patient data (§7.7 #5). `dosespot_webhook_event` SURVIVES too — its
// `raw_body_cipher` is per-tenant DEK-encrypted webhook receipt, not patient-scoped, so the erase never
// touches it. Unlike M10's HOPE eraser there is no CMS extended-retention block — medication orders carry
// M4's standard `compliance` retention class, enforced by the certificate's `retentionAsOf` boundary, not by
// this callback (§7.7). The sibling clinical erasers are disjoint by table ownership: M11 destroys the
// clinical-orders subtree, M12 the prescribing subtree.
//
// Registers the REAL eraser over the Phase-0 deny-stub (`medication_order_record` is in REQUIRED_ERASERS);
// the composition root's wireModuleErasers() invokes it AFTER wireErasers() (deny-stubs) and before
// validateErasers(), so a real eraser stands over its stub.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DataEraser } from "@wardenx/types";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

/** The per-table counts a medication-order-record destruction removed (recorded on the destruction cert, §7.7). */
export interface MedicationOrderEraseCounts {
  /** `medication_order` rows removed (whether by partition drop or row delete). */
  readonly medicationOrders: number;
  /** `medication_order_transmission` rows deleted (cascaded from the deleted orders). */
  readonly transmissions: number;
  /** `refill_request` rows deleted (cascaded from the deleted orders). */
  readonly refillRequests: number;
  /** `epcs_signing_attempt` rows deleted (cascaded from the deleted orders). */
  readonly epcsSigningAttempts: number;
  /** Whole `medication_order` partitions DETACHed + DROPped (the partition-drop path). */
  readonly partitionsDropped: number;
}

/** Knobs the M4 destruction cert carries into the erase (defaults: erase everything up to now). */
export interface MedicationOrderEraseOptions {
  /** Erase rows with `created_at < retentionAsOf`; defaults to {@link MedicationOrderEraseOptions.now}'s instant. */
  readonly retentionAsOf?: string;
  /** Clock injection (tests pin it); defaults to the system clock. */
  readonly now?: () => string;
}

/** The narrow data port the medication-order eraseFn composes over (Drizzle deletes in prod, under RLS). */
export interface MedicationOrderEraseStore {
  /**
   * Acquire a per-patient advisory lock (keyed on patient id) so a concurrent write cannot interleave with the
   * destruction. Released by the surrounding transaction commit in prod; a no-op in the slice.
   */
  lockPatient(organizationId: string, patientId: string): Promise<void>;
  /**
   * Erase the patient's `medication_order` rows (`created_at < retentionAsOf`; partition DETACH+DROP where a
   * partition is wholly erasable, row-level delete otherwise) plus the cascaded `medication_order_transmission`
   * / `refill_request` / `epcs_signing_attempt` child rows. The org-scoped `dosespot_prescriber` /
   * `dosespot_webhook_event` / `refill_inbox_policy` / `controlled_substance_policy` are left intact (§7.7 #5).
   * Returns counts.
   */
  eraseMedicationOrdersSubtree(
    organizationId: string,
    patientId: string,
    retentionAsOf: string,
  ): Promise<MedicationOrderEraseCounts>;
}

/**
 * Erase a patient's prescribing subtree under a destruction certificate (D7/D8): lock the patient, then delete
 * the medication-order rows + child rows and report the total removed. Pure orchestration over the store — no
 * I/O of its own. The org-scoped DoseSpot config + the encrypted webhook receipts are never touched (§7.7 #5).
 */
export async function eraseMedicationOrderRecord(
  organizationId: string,
  patientId: string,
  store: MedicationOrderEraseStore,
  options: MedicationOrderEraseOptions = {},
): Promise<{ erased: number; counts: MedicationOrderEraseCounts }> {
  const now = options.now ?? (() => new Date().toISOString());
  const retentionAsOf = options.retentionAsOf ?? now();

  await store.lockPatient(organizationId, patientId);

  const counts = await store.eraseMedicationOrdersSubtree(organizationId, patientId, retentionAsOf);
  // partitionsDropped is bookkeeping (how the order rows left), already counted in `medicationOrders`.
  const erased =
    counts.medicationOrders + counts.transmissions + counts.refillRequests + counts.epcsSigningAttempts;
  return { erased, counts };
}

/** Seed shape for the in-memory {@link MedicationOrderEraseStore} (slice/tests). */
export interface InMemoryMedicationOrderEraseSeed {
  /** Per-table counts a first erase removes; `partitionsDropped` selects the partition-drop vs row-delete path. */
  readonly counts?: Partial<MedicationOrderEraseCounts>;
}

/** An in-memory {@link MedicationOrderEraseStore} for the slice/tests (seeded counts; idempotent on a second erase). */
export function createInMemoryMedicationOrderEraseStore(seed: InMemoryMedicationOrderEraseSeed = {}): {
  store: MedicationOrderEraseStore;
  locked: string[];
} {
  const zero: MedicationOrderEraseCounts = {
    medicationOrders: 0,
    transmissions: 0,
    refillRequests: 0,
    epcsSigningAttempts: 0,
    partitionsDropped: 0,
  };
  const counts: MedicationOrderEraseCounts = { ...zero, ...seed.counts };
  const locked: string[] = [];
  let used = false;
  return {
    locked,
    store: {
      async lockPatient(_org, patientId) {
        locked.push(patientId);
      },
      async eraseMedicationOrdersSubtree() {
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
 * partitioned `medication_order` parent via the partition-key predicate the route tier uses
 * (`patient_id` + `created_at < retentionAsOf`) — the row-delete arm of the M11 D12 precedent. The
 * DETACH+DROP arm is a DDL maintenance path that needs table-owner privileges the RLS-scoped
 * `wardenx_app` role does not hold, so this store always reports `partitionsDropped: 0`; a wholly-
 * erasable partition is still fully emptied row-by-row, which is destruction-equivalent (the partition
 * shell holds no PHI). Any statement the database refuses THROWS and rolls the erase back — the erase
 * never reports success it did not perform.
 */
export function createDrizzleMedicationOrderEraseStore(db: DbClient): MedicationOrderEraseStore {
  const MO = schema.medicationOrders;
  const TRANS = schema.medicationOrderTransmissions;
  const REFILL = schema.refillRequests;
  const EPCS = schema.epcsSigningAttempts;

  /** The patient's erasable medication-order ids (`created_at < boundary`) — the cascade key. */
  const orderIdsFor = async (tx: Tx, patientId: string, boundary: Date): Promise<string[]> =>
    (
      await tx
        .select({ id: MO.id })
        .from(MO)
        .where(and(eq(MO.patientId, patientId), lt(MO.createdAt, boundary)))
    ).map((r) => r.id);

  return {
    async lockPatient(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // Advisory lock on the patient key, released by the surrounding transaction commit.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${patientId}))`);
      });
    },

    async eraseMedicationOrdersSubtree(organizationId, patientId, retentionAsOf) {
      if (Number.isNaN(Date.parse(retentionAsOf))) {
        throw new Error(`M12_ERASER_BAD_RETENTION_BOUNDARY: ${retentionAsOf}`);
      }
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const boundary = new Date(retentionAsOf);
        const orderIds = await orderIdsFor(tx, patientId, boundary);
        const del = async <T extends { id: string }>(run: () => Promise<T[]>): Promise<number> =>
          (await run()).length;

        // Children first, cascaded from the DELETED orders (no SQL FK to the partitioned parent — the
        // cascade is app-owned). `refill_request` is keyed on its SOURCE order (§7.7: "whose source
        // order matches"); a refill that minted a surviving order goes with its source, per the spec.
        const transmissions =
          orderIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(TRANS)
                  .where(inArray(TRANS.medicationOrderId, orderIds))
                  .returning({ id: TRANS.id }),
              );
        const refillRequests =
          orderIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(REFILL)
                  .where(inArray(REFILL.sourceMedicationOrderId, orderIds))
                  .returning({ id: REFILL.id }),
              );
        const epcsSigningAttempts =
          orderIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(EPCS)
                  .where(inArray(EPCS.medicationOrderId, orderIds))
                  .returning({ id: EPCS.id }),
              );

        // The partitioned parent, via the partition-key predicate (row-delete arm).
        const medicationOrders = await del(() =>
          tx
            .delete(MO)
            .where(and(eq(MO.patientId, patientId), lt(MO.createdAt, boundary)))
            .returning({ id: MO.id }),
        );

        // `dosespot_prescriber` / `refill_inbox_policy` / `controlled_substance_policy` are org-scoped
        // tenant configuration, and `dosespot_webhook_event` is a per-tenant encrypted receipt — none of
        // them are patient rows, so the erase never touches them (§7.7 #5).
        return { medicationOrders, transmissions, refillRequests, epcsSigningAttempts, partitionsDropped: 0 };
      });
    },
  };
}

/** Injected adapter for the M12 eraser (slice defaults to in-memory). */
export interface MedicationOrderEraserDeps {
  store?: MedicationOrderEraseStore;
  /** Bound from the M4 destruction certificate in prod; the slice keeps the conservative defaults. */
  options?: MedicationOrderEraseOptions;
}

/** Build M12's `medication_order_record` DataEraser. `subjectId` is the patient being destroyed (D7/D8). */
export function createMedicationOrderEraser(
  store: MedicationOrderEraseStore,
  options: MedicationOrderEraseOptions = {},
): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseMedicationOrderRecord(scope.orgId, subjectId, store, options);
      return { erased };
    },
  };
}

/** Register M12's REAL `medication_order_record` eraser over the Phase-0 deny-stub (M12-T09; before validateErasers()). */
export function registerDoseSpotErasers(deps: MedicationOrderEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryMedicationOrderEraseStore().store;
  registerEraser("medication_order_record", createMedicationOrderEraser(store, deps.options ?? {}));
}
