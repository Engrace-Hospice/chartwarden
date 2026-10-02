// apps/backend/src/modules/21-supplies/erasers/supply-eraser.ts — M21-T05, the `supply_record` data eraser
// (M21 spec §8.2; M4 destruction-cert workflow).
//
// THIS ERASER IS SHAPED DIFFERENTLY FROM EVERY OTHER ONE ON THE PLATFORM, and the difference is statutory
// rather than stylistic. M5–M18's erasers delete the patient's subtree and tombstone its root. M21 cannot:
// DEA 21 CFR §1304.04 requires a registrant's perpetual inventory record of a scheduled drug to be
// retained (two years federal floor; §8.2 tags those audit rows `regulatory_dea` and hospice clinical
// retention pushes it further), and a patient's right to erasure does not reach it. A morphine lot that
// left a DEA-registered hub is an entry in the agency's controlled-substance ledger, not a fact about the
// patient — the patient is merely where it went.
//
// So the erase is a THREE-PART operation with two different dispositions:
//
//   1. SHRED, then DELETE — `supply_request`. The D13 free text (`delivery_instructions`,
//      `cancellation_reason`) and the `data` jsonb (which carries the D7 delivery-address snapshot) are
//      nulled first so the PHI is unreadable even if a later step fails, and the row then goes. A supply
//      request is a fact about a patient's home and needs; nothing in DEA §1304 preserves it.
//   2. SHRED IN PLACE — `comfort_kit_dispatch` and `comfort_kit_return`. The patient-linking columns
//      (`patient_id`, `admission_id`) are replaced with the all-zero UUID, the D13 narrative columns
//      (`special_handling_notes`, `disposal_notes`, `discrepancy_notes`, `unreturnable_reason`) and the
//      `facility_identifier_jsonb` (which names the ALF or the room the patient was in) are nulled, and the
//      row STAYS. What survives is the custody chain: who dispatched, who witnessed, who reconciled, when.
//   3. UNTOUCHED — `comfort_kit_dispatched_content` and `comfort_kit_returned_content`. These are the
//      perpetual log itself: lot, schedule, quantity out, quantity back, quantity unaccounted. They carry
//      no patient column at all (they are org+PE+location scoped), so there is nothing to de-identify —
//      which is exactly why §3.1 put the tenancy on them and the patient on their parents.
//
// The `dea_perpetual_log_jsonb` entries name MEMBERSHIPS, never patients, so they survive with the lines.
//
// ALSO UNTOUCHED, for the ordinary reason: `supply_item`, `tenant_supply_item_extension`,
// `comfort_kit_template(_medication)`, `vendor_routing_rule` and `par_stock` are org-scoped configuration
// — a catalog, a recipe, a routing ladder and a shelf count. None of them is patient data (M11's
// `order_verbal_policy` / M13's `administration_policy` precedent).
//
// Idempotent: a second erase finds nothing and reports zero. Registers the REAL eraser over the Phase-0
// deny-stub (`supply_record` is in REQUIRED_ERASERS); the composition root's wireModuleErasers() runs it
// AFTER wireErasers() and before validateErasers().
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DataEraser } from "@wardenx/types";
import { eq, inArray, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The de-identification sentinel written over `patient_id` / `admission_id` on a preserved row. */
export const DEIDENTIFIED_UUID = "00000000-0000-0000-0000-000000000000";

/** The per-table counts a supply-record destruction produced (recorded on the cert, §8.2). */
export interface SupplyEraseCounts {
  /** `supply_request` rows shredded and deleted. */
  readonly requestsDeleted: number;
  /** `comfort_kit_dispatch` rows de-identified IN PLACE (preserved — see the header). */
  readonly dispatchesDeidentified: number;
  /** `comfort_kit_return` rows de-identified IN PLACE (preserved). */
  readonly returnsDeidentified: number;
  /** `comfort_kit_dispatched_content` rows left untouched — reported so the cert shows what SURVIVED. */
  readonly perpetualLogLinesPreserved: number;
  /** `comfort_kit_returned_content` rows left untouched (the closing half of the same ledger). */
  readonly reconciliationLinesPreserved: number;
}

const EMPTY_COUNTS: SupplyEraseCounts = {
  requestsDeleted: 0,
  dispatchesDeidentified: 0,
  returnsDeidentified: 0,
  perpetualLogLinesPreserved: 0,
  reconciliationLinesPreserved: 0,
};

/** The narrow data port the eraseFn composes over (Drizzle under RLS in prod; in-memory in tests). */
export interface SupplyEraseStore {
  /** Advisory-lock the patient so a concurrent dispatch cannot interleave with the destruction. */
  lockPatient(organizationId: string, patientId: string): Promise<void>;
  /** Part 1 — shred the D13 free text + the `data` jsonb, then delete the requests. */
  shredAndDeleteRequests(organizationId: string, patientId: string): Promise<number>;
  /** Part 2 — de-identify the dispatch headers in place; returns the count and the preserved-line count. */
  deidentifyDispatches(
    organizationId: string,
    patientId: string,
  ): Promise<{ rows: number; preservedLines: number }>;
  /** Part 2 — de-identify the return headers in place; returns the count and the preserved-line count. */
  deidentifyReturns(
    organizationId: string,
    patientId: string,
  ): Promise<{ rows: number; preservedLines: number }>;
}

/**
 * The pure erase orchestration over the port. Ordering is load-bearing: the lock first, then the SHRED of
 * the deletable rows, then the in-place de-identification. If the process dies between steps the PHI is
 * already unreadable — a half-finished erase must never leave a readable address behind.
 */
export async function eraseSupplyRecord(
  store: SupplyEraseStore,
  organizationId: string,
  patientId: string,
): Promise<SupplyEraseCounts> {
  await store.lockPatient(organizationId, patientId);
  const requestsDeleted = await store.shredAndDeleteRequests(organizationId, patientId);
  const dispatches = await store.deidentifyDispatches(organizationId, patientId);
  const returns = await store.deidentifyReturns(organizationId, patientId);
  return {
    ...EMPTY_COUNTS,
    requestsDeleted,
    dispatchesDeidentified: dispatches.rows,
    returnsDeidentified: returns.rows,
    perpetualLogLinesPreserved: dispatches.preservedLines,
    reconciliationLinesPreserved: returns.preservedLines,
  };
}

/** Build the Drizzle-backed store. Every statement runs under the destruction cert's org context. */
export function buildDrizzleSupplyEraseStore(db: DbClient): SupplyEraseStore {
  const REQUEST = schema.supplyRequest;
  const DISPENSE_FACT = schema.supplyRequestPharmacyDispense;
  const DISPATCH = schema.comfortKitDispatch;
  const DISPATCHED = schema.comfortKitDispatchedContent;
  const RETURN = schema.comfortKitReturn;
  const RETURNED = schema.comfortKitReturnedContent;

  const scoped = <T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, fn);

  return {
    async lockPatient(organizationId, patientId) {
      await scoped(organizationId, async (tx) => {
        // Transaction-scoped advisory lock keyed on the patient, so a dispatch in flight for the same
        // patient serialises against the destruction rather than interleaving with it.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`m21:${patientId}`}))`);
      });
    },

    async shredAndDeleteRequests(organizationId, patientId) {
      return scoped(organizationId, async (tx) => {
        // SHRED first (see the orchestration doc-comment): the address snapshot inside `data` and the two
        // D13 free-text columns are unreadable before anything is deleted.
        await tx
          .update(REQUEST)
          .set({
            data: {},
            deliveryInstructions: null,
            cancellationReason: null,
          })
          .where(eq(REQUEST.patientId, patientId));
        // F-233 — the pharmacy-dispense facts reference the patient's requests (and carry `patient_id`);
        // they go with them. Unmatched (`no_correlating_request`) rows name no patient and stay.
        await tx.delete(DISPENSE_FACT).where(eq(DISPENSE_FACT.patientId, patientId));
        const deleted = await tx
          .delete(REQUEST)
          .where(eq(REQUEST.patientId, patientId))
          .returning({ id: REQUEST.id });
        return deleted.length;
      });
    },

    async deidentifyDispatches(organizationId, patientId) {
      return scoped(organizationId, async (tx) => {
        const ids = await tx
          .select({ id: DISPATCH.id })
          .from(DISPATCH)
          .where(eq(DISPATCH.patientId, patientId));
        if (ids.length === 0) return { rows: 0, preservedLines: 0 };
        const lines = await tx
          .select({ id: DISPATCHED.id })
          .from(DISPATCHED)
          .where(
            inArray(
              DISPATCHED.dispatchId,
              ids.map((r) => r.id),
            ),
          );
        await tx
          .update(DISPATCH)
          .set({
            patientId: DEIDENTIFIED_UUID,
            admissionId: DEIDENTIFIED_UUID,
            // The manifest jsonb is the BOL copy of the lines — it names drugs and lots, not the patient,
            // so it survives with the lines. `facility_identifier_jsonb` does NOT: it names the ALF and the
            // room number, which locates the person.
            facilityIdentifierJsonb: null,
            specialHandlingNotes: null,
          })
          .where(
            inArray(
              DISPATCH.id,
              ids.map((r) => r.id),
            ),
          );
        return { rows: ids.length, preservedLines: lines.length };
      });
    },

    async deidentifyReturns(organizationId, patientId) {
      return scoped(organizationId, async (tx) => {
        const ids = await tx
          .select({ id: RETURN.id })
          .from(RETURN)
          .where(eq(RETURN.patientId, patientId));
        if (ids.length === 0) return { rows: 0, preservedLines: 0 };
        const lines = await tx
          .select({ id: RETURNED.id })
          .from(RETURNED)
          .where(
            inArray(
              RETURNED.returnId,
              ids.map((r) => r.id),
            ),
          );
        await tx
          .update(RETURN)
          .set({
            patientId: DEIDENTIFIED_UUID,
            admissionId: DEIDENTIFIED_UUID,
            // `m13_deployment_id` STAYS: it is M13's key, not a patient identifier, and M13's own eraser
            // is what disposes of the deployment. Nulling it here would orphan the two ledgers from each
            // other while leaving both intact — the worst of both dispositions.
            disposalNotes: null,
            discrepancyNotes: null,
            unreturnableReason: null,
          })
          .where(
            inArray(
              RETURN.id,
              ids.map((r) => r.id),
            ),
          );
        return { rows: ids.length, preservedLines: lines.length };
      });
    },
  };
}

/**
 * Register M21's REAL `supply_record` eraser over the Phase-0 deny-stub (M21-T05). Called by the
 * composition root's `wireModuleErasers()` after `wireErasers()` and before `validateErasers()`.
 *
 * The returned `erased` count is the number of rows DESTROYED, not the number touched: the de-identified
 * dispatch and return headers still exist, and reporting them as erased on a destruction certificate would
 * be a false attestation. The full disposition is available through {@link eraseSupplyRecord}.
 */
export function registerSupplyEraser(db: DbClient): void {
  const store = buildDrizzleSupplyEraseStore(db);
  const eraser: DataEraser = {
    async erase(scope, subjectId) {
      const counts = await eraseSupplyRecord(store, scope.orgId, subjectId);
      return { erased: counts.requestsDeleted };
    },
  };
  registerEraser("supply_record", eraser);
}
