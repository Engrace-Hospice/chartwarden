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
import type { DataEraser } from "@wardenx/types";
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

/** Injected adapter for the M11 eraser (slice defaults to in-memory). */
export interface OrderEraserDeps {
  store?: OrderEraseStore;
  /** Bound from the M4 destruction certificate in prod; the slice keeps the conservative defaults. */
  options?: OrderEraseOptions;
}

/** Build M11's `order_record` DataEraser. `subjectId` is the patient being destroyed (D7/D8). */
export function createOrderEraser(store: OrderEraseStore, options: OrderEraseOptions = {}): DataEraser {
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
