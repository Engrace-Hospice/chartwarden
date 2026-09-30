// apps/backend/src/modules/11-orders/erasers/orders-eraser.ts — M11-T08 the `order_record` data eraser
// (M11 spec §7.7 / D12; M4 destruction-cert workflow, D7/D8).
//
// M11 owns the destruction callback for a patient's orders subtree — the order rows M11 captures around the
// M5 patient spine / M6 admission anchor. Under an M4 destruction certificate it (1) acquires a per-patient
// advisory lock so a concurrent write cannot interleave with the destruction, (2) erases the monthly-
// partitioned `order_record` rows (`created_at < retentionAsOf`) — at PARTITION granularity (DETACH + DROP)
// when a partition is wholly erasable, by row-level delete for a mixed partition (D12 / §3.4) — together with
// the cascaded `order_signature` / `verbal_order` / `standing_order_instance` / `order_discontinuation` rows
// for the deleted orders, then (3) deletes the patient's `standing_order` templates. `order_verbal_policy`
// SURVIVES: it is ORG-scoped tenant configuration, not patient data, so the erase never touches it (§7.7 #4).
// Unlike M10's HOPE eraser there is no CMS extended-retention block — orders carry M4's standard `compliance`
// retention class (7-year floor, state overrides), enforced by the certificate's `retentionAsOf` boundary,
// not by this callback (§3.7 / 42 CFR 418.104). The sibling clinical erasers are disjoint by table ownership:
// M5 destroys the patient demographics subtree, M6 the admission subtree, M7 the care-plan subtree, M8 the
// encounter subtree, M9 the clinical-scale rows, M10 the HOPE timepoint subtree, M11 the orders subtree.
//
// Registers the REAL eraser over the Phase-0 deny-stub (`order_record` is in REQUIRED_ERASERS); the
// composition root's wireModuleErasers() invokes it AFTER wireErasers() (deny-stubs) and before
// validateErasers(), so a real eraser stands over its stub.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DataEraser } from "@wardenx/types";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

/** The per-table counts an order-record destruction removed (recorded on the destruction cert, §7.7). */
export interface OrderEraseCounts {
  /** `order_record` rows removed (whether by partition drop or row delete). */
  readonly orders: number;
  /** `order_signature` rows deleted (cascaded from the deleted orders). */
  readonly signatures: number;
  /** `verbal_order` rows deleted (cascaded from the deleted orders). */
  readonly verbalOrders: number;
  /** `standing_order_instance` rows deleted (cascaded from the deleted orders). */
  readonly standingInstances: number;
  /** `order_discontinuation` rows deleted (cascaded from the deleted orders). */
  readonly discontinuations: number;
  /** F-202 — `order_transmission_attestation` rows deleted (the append-only recovery ledger; cascaded from the orders). */
  readonly transmissionAttestations: number;
  /** F-202 — `order_recovery_request` rows deleted (the two-person recovery requests; cascaded from the orders). */
  readonly recoveryRequests: number;
  /** `standing_order` templates deleted for the patient. */
  readonly standingOrders: number;
  /** Whole `order_record` partitions DETACHed + DROPped (the partition-drop path, §3.4 / D12). */
  readonly partitionsDropped: number;
}

/** Knobs the M4 destruction cert carries into the erase (defaults: erase everything up to now). */
export interface OrderEraseOptions {
  /** Erase rows with `created_at < retentionAsOf`; defaults to {@link OrderEraseOptions.now}'s instant. */
  readonly retentionAsOf?: string;
  /** Clock injection (tests pin it); defaults to the system clock. */
  readonly now?: () => string;
}

/** The narrow data port the order eraseFn composes over (Drizzle deletes in prod, under RLS). */
export interface OrderEraseStore {
  /**
   * Acquire a per-patient advisory lock (keyed on patient id) so a concurrent write cannot interleave with
   * the destruction. Released by the surrounding transaction commit in prod; a no-op in the slice.
   */
  lockPatient(organizationId: string, patientId: string): Promise<void>;
  /**
   * Erase the patient's `order_record` rows (`created_at < retentionAsOf`; partition DETACH+DROP where a
   * partition is wholly erasable, row-level delete otherwise) plus the cascaded `order_signature` /
   * `verbal_order` / `standing_order_instance` / `order_discontinuation` child rows and the patient's
   * `standing_order` templates. `order_verbal_policy` is left intact (org-scoped, §7.7 #4). Returns counts.
   */
  eraseOrdersSubtree(
    organizationId: string,
    patientId: string,
    retentionAsOf: string,
  ): Promise<OrderEraseCounts>;
}

/**
 * Erase a patient's orders subtree under a destruction certificate (D7/D8): lock the patient, then delete the
 * order rows + child rows + standing-order templates and report the total removed. Pure orchestration over the
 * store — no I/O of its own. The `order_verbal_policy` org config is never touched (§7.7 #4).
 */
export async function eraseOrderRecord(
  organizationId: string,
  patientId: string,
  store: OrderEraseStore,
  options: OrderEraseOptions = {},
): Promise<{ erased: number; counts: OrderEraseCounts }> {
  const now = options.now ?? (() => new Date().toISOString());
  const retentionAsOf = options.retentionAsOf ?? now();

  await store.lockPatient(organizationId, patientId);

  const counts = await store.eraseOrdersSubtree(organizationId, patientId, retentionAsOf);
  // partitionsDropped is bookkeeping (how the order rows left), already counted in `orders`.
  const erased =
    counts.orders +
    counts.signatures +
    counts.verbalOrders +
    counts.standingInstances +
    counts.discontinuations +
    counts.transmissionAttestations +
    counts.recoveryRequests +
    counts.standingOrders;
  return { erased, counts };
}

/** Seed shape for the in-memory {@link OrderEraseStore} (slice/tests). */
export interface InMemoryOrderEraseSeed {
  /** Per-table counts a first erase removes; `partitionsDropped` selects the partition-drop vs row-delete path. */
  readonly counts?: Partial<OrderEraseCounts>;
}

/** An in-memory {@link OrderEraseStore} for the slice/tests (seeded counts; idempotent on a second erase). */
export function createInMemoryOrderEraseStore(seed: InMemoryOrderEraseSeed = {}): {
  store: OrderEraseStore;
  locked: string[];
} {
  const zero: OrderEraseCounts = {
    orders: 0,
    signatures: 0,
    verbalOrders: 0,
    standingInstances: 0,
    discontinuations: 0,
    transmissionAttestations: 0,
    recoveryRequests: 0,
    standingOrders: 0,
    partitionsDropped: 0,
  };
  const counts: OrderEraseCounts = { ...zero, ...seed.counts };
  const locked: string[] = [];
  let used = false;
  return {
    locked,
    store: {
      async lockPatient(_org, patientId) {
        locked.push(patientId);
      },
      async eraseOrdersSubtree() {
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
 * partitioned `order_record` parent via the partition-key predicate the route tier uses
 * (`patient_id` + `created_at < retentionAsOf`) — the row-delete arm of D12. The DETACH+DROP arm is a
 * DDL maintenance path that needs table-owner privileges the RLS-scoped `wardenx_app` role does not
 * hold, so this store always reports `partitionsDropped: 0`; a wholly-erasable partition is still fully
 * emptied row-by-row, which is destruction-equivalent (the partition shell holds no PHI).
 * Any statement the database refuses (FK restrict from a surviving row, RLS, permissions) THROWS and
 * rolls the erase transaction back — the erase never reports success it did not perform.
 */
export function createDrizzleOrderEraseStore(db: DbClient): OrderEraseStore {
  const ORD = schema.orderRecords;
  const SIG = schema.orderSignatures;
  const VO = schema.verbalOrders;
  const SOI = schema.standingOrderInstances;
  const DISC = schema.orderDiscontinuations;
  const ATTEST = schema.orderTransmissionAttestations;
  const RECOVERY = schema.orderRecoveryRequests;
  const SO = schema.standingOrders;

  /** The patient's erasable order ids (`created_at < boundary`) — the child cascade is keyed on these. */
  const orderIdsFor = async (tx: Tx, patientId: string, boundary: Date): Promise<string[]> =>
    (
      await tx
        .select({ id: ORD.id })
        .from(ORD)
        .where(and(eq(ORD.patientId, patientId), lt(ORD.createdAt, boundary)))
    ).map((r) => r.id);

  return {
    async lockPatient(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // Advisory lock on the patient key, released by the surrounding transaction commit.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${patientId}))`);
      });
    },

    async eraseOrdersSubtree(organizationId, patientId, retentionAsOf) {
      if (Number.isNaN(Date.parse(retentionAsOf))) {
        throw new Error(`M11_ERASER_BAD_RETENTION_BOUNDARY: ${retentionAsOf}`);
      }
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const boundary = new Date(retentionAsOf);
        const orderIds = await orderIdsFor(tx, patientId, boundary);
        const del = async <T extends { id: string }>(run: () => Promise<T[]>): Promise<number> =>
          (await run()).length;

        // Children first, cascaded from the DELETED orders (no SQL FK to the partitioned parent — the
        // cascade is app-owned). `order_signature` / `verbal_order` are polymorphic (D14): only the
        // `target_kind = 'order'` rows belong to M11's subtree; `'medication_order'` rows are M12's.
        const signatures =
          orderIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(SIG)
                  .where(and(eq(SIG.targetKind, "order"), inArray(SIG.targetId, orderIds)))
                  .returning({ id: SIG.id }),
              );
        const verbalOrders =
          orderIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(VO)
                  .where(and(eq(VO.targetKind, "order"), inArray(VO.targetId, orderIds)))
                  .returning({ id: VO.id }),
              );
        const standingInstances =
          orderIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(SOI)
                  .where(inArray(SOI.orderRecordId, orderIds))
                  .returning({ id: SOI.id }),
              );
        const discontinuations =
          orderIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(DISC)
                  .where(inArray(DISC.orderRecordId, orderIds))
                  .returning({ id: DISC.id }),
              );

        // F-202 — the attested-recovery ledger and its two-person requests. Both carry the lab-contact NAME and the lab's
        // reference for a patient's order, so a destruction certificate must reach them (they were missing from the
        // destruction role's grants, so erasing an order left them behind). Runs as `wardenx_destruction`: the ledger's
        // append-only trigger admits a DELETE from a member of that role and from nobody else.
        const transmissionAttestations =
          orderIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(ATTEST)
                  .where(inArray(ATTEST.orderRecordId, orderIds))
                  .returning({ id: ATTEST.id }),
              );
        const recoveryRequests =
          orderIds.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(RECOVERY)
                  .where(inArray(RECOVERY.orderRecordId, orderIds))
                  .returning({ id: RECOVERY.id }),
              );

        // The partitioned parent, via the partition-key predicate (row-delete arm of D12).
        const orders = await del(() =>
          tx
            .delete(ORD)
            .where(and(eq(ORD.patientId, patientId), lt(ORD.createdAt, boundary)))
            .returning({ id: ORD.id }),
        );

        // The patient's standing_order templates go LAST: `order_record.standing_order_id` and
        // `standing_order_instance.standing_order_id` reference them, so the referencing rows must
        // already be gone. If a surviving out-of-boundary order still references a template, the FK
        // refuses and the whole erase rolls back (fail closed) rather than orphaning the reference.
        const standingOrders = await del(() =>
          tx.delete(SO).where(eq(SO.patientId, patientId)).returning({ id: SO.id }),
        );

        // `order_verbal_policy` is org-scoped tenant configuration — never touched (§7.7 #4).
        return {
          orders,
          signatures,
          verbalOrders,
          standingInstances,
          discontinuations,
          transmissionAttestations,
          recoveryRequests,
          standingOrders,
          partitionsDropped: 0,
        };
      });
    },
  };
}

/** Injected adapter for the M11 eraser (slice defaults to in-memory). */
export interface OrderEraserDeps {
  store?: OrderEraseStore;
  /** Bound from the M4 destruction certificate in prod; the slice keeps the conservative defaults. */
  options?: OrderEraseOptions;
}

/** Build M11's `order_record` DataEraser. `subjectId` is the patient being destroyed (D7/D8). */
export function createOrderEraser(
  store: OrderEraseStore,
  options: OrderEraseOptions = {},
): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseOrderRecord(scope.orgId, subjectId, store, options);
      return { erased };
    },
  };
}

/** Register M11's REAL `order_record` eraser over the Phase-0 deny-stub (M11-T08; before validateErasers()). */
export function registerOrderErasers(deps: OrderEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryOrderEraseStore().store;
  registerEraser("order_record", createOrderEraser(store, deps.options ?? {}));
}

// ── task-15 — the med-order signature cascade (the M11/M12 cross-eraser ownership decision) ──────────
//
// `order_signature` / `verbal_order` are M11-OWNED tables, but rows with
// `target_kind = 'medication_order'` document M12's aggregates — so neither module's own erase pass
// could reach them (M11 cannot resolve which med-order ids belong to the patient; M12 may not touch
// M11's tables). THE DECISION: M11 exports this cascade over its OWN tables, and M12's eraser invokes
// it through an injected port WITH the med-order ids it is erasing — at the only moment those ids are
// still known (before M12 deletes the rows). Ownership stays clean (M11 code deletes M11 tables), and
// the ordering hazard (M12 erasing first ⇒ ids unresolvable ⇒ orphaned signature rows forever) cannot
// occur. The composition root wires it; migration 0157 grants the destruction role both tables.

/** Counts the cascade removed (folded into M12's destruction certificate). */
export interface MedicationOrderSignatureCascadeCounts {
  readonly signatures: number;
  readonly verbalOrders: number;
}

/**
 * Build the cascade: delete the M11-side signature/verbal rows targeting the given med-order ids.
 * Runs under its own explicit org envelope (the caller's erase tx cannot cross module stores).
 */
export function createMedicationOrderSignatureCascade(
  db: DbClient,
): (
  organizationId: string,
  medicationOrderIds: readonly string[],
) => Promise<MedicationOrderSignatureCascadeCounts> {
  const SIG = schema.orderSignatures;
  const VO = schema.verbalOrders;
  return async (organizationId, medicationOrderIds) => {
    if (medicationOrderIds.length === 0) return { signatures: 0, verbalOrders: 0 };
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const signatures = await tx
        .delete(SIG)
        .where(
          and(
            eq(SIG.targetKind, "medication_order"),
            inArray(SIG.targetId, [...medicationOrderIds]),
          ),
        )
        .returning({ id: SIG.id });
      const verbalOrders = await tx
        .delete(VO)
        .where(
          and(eq(VO.targetKind, "medication_order"), inArray(VO.targetId, [...medicationOrderIds])),
        )
        .returning({ id: VO.id });
      return { signatures: signatures.length, verbalOrders: verbalOrders.length };
    });
  };
}
