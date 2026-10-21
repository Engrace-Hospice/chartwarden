// apps/backend/src/modules/21-supplies/seams/providers.ts — M21-T05, the §4.8 / D14 seam implementations:
// pure orchestration over an injected {@link SuppliesSeamStore} plus `@chartwarden/supplies`'s pure policy.
// Each returns the leaf-typed seam interface (`@chartwarden/types`) the M1 registry validates and
// M11/M13/M22/M23/M27/M28/M30/M33/M37 resolve. The providers add NO tenant logic — RLS scopes every store
// read by the caller's ambient `app.org_id` (§3.5) — and NO second copy of the domain rules.
//
// FAIL POSTURE, per seam, deliberately asymmetric — the same rule M15-T05 and M16-T05 set: pick the
// direction by what the consumer DOES with the answer.
//
//   • `ComfortKitDispatchProvider` PROPAGATES a store failure, and this is the one that matters most.
//     M13 reads `listActiveDispatchesForPatient` to render bedside controlled-substance inventory. An
//     empty array on an unreadable store would show a nurse "there is no morphine in this kit" when the
//     truth is "we could not look". A throw shows an error state. `[]` here means the ward genuinely has
//     no live kit; `null` from `getDispatchDetail` means the id does not resolve IN THE CALLER'S ORG,
//     which is indistinguishable from "does not exist" on purpose (a cross-tenant probe learns nothing).
//   • `SupplyFulfillmentProvider.isTerminal` PROPAGATES too, for the mirror-image reason: M11 asks it
//     before issuing a cancellation, and a fabricated `{isTerminal:false}` on an outage would send a
//     cancellation at a kit that already shipped. `null` (id does not resolve) is a distinct answer M11's
//     §7.7 cascade already branches on.
//   • `SupplyCostProvider` PROPAGATES. Its consumers are M23's cap analysis and M27's cost report; a
//     zeroed total on an outage is a reportable misstatement, not a degraded read. An honest error is the
//     right degraded answer for a financial surface — and the numbers stay COUNTS and TOTALS, never a
//     per-patient-day rate (the M15-T05 / M30 lesson, written into the DTO's own doc-comment).
//
// The ONE method that answers softly is `notifyAdministrationDrawdown`: see its doc-comment.
import { computeReturnLine } from "@chartwarden/supplies";
import type {
  ActiveDispatchView,
  AdministrationDrawdownInput,
  ComfortKitDispatchId,
  ComfortKitDispatchProvider,
  CreateDirectSupplyRequestInput,
  DeaPerpetualLogEntry,
  DispatchDetailView,
  IpuRoomId,
  IpuRoomKitInventoryView,
  IsoInstant,
  LocalDate,
  LocationId,
  OrgId,
  OrgSupplySpendSummary,
  PatientId,
  PatientSupplyCostSummary,
  SupplyCostProvider,
  SupplyFulfillmentProvider,
  SupplyRequestId,
} from "@chartwarden/types";
import { SupplyStateError } from "../lifecycle/index";
import type { SuppliesSeamStore, SupplyCostTotals, SupplyRequestCreator } from "./store";

/** The clock the providers derive "now" from — injected so every seam write is deterministic under test. */
export type SuppliesSeamClock = () => IsoInstant;

/**
 * The CALLER'S org, resolved from the ambient request context. Injected rather than imported so the
 * providers stay unit-testable with no request scope, and so the one DTO field that is not a row value
 * (`PatientSupplyCostSummary.orgId`) comes from the same place RLS scoped the read by — never from an
 * argument the caller controls.
 */
export type SuppliesSeamOrgResolver = () => OrgId;

/** The §2.2 terminal set (mirrors `SUPPLY_REQUEST_TERMINAL_STATUSES`). A row in `cancellation_pending` is
 *  NOT terminal — the vendor has not answered yet, and M11's §7.7 cascade depends on the distinction. */
const TERMINAL = new Set(["completed", "cancelled"]);

/**
 * §4.8 `SupplyFulfillmentProvider`. The creation half delegates to the M21 WRITE service through the
 * injected {@link SupplyRequestCreator}: the D4 routing freeze, the per-kind TypeBox validation and the
 * §4.5.2 emit all live there, and a second implementation on the seam would be a second place for them to
 * drift. UNBOUND creator ⇒ the create method raises rather than writing a routing-less row.
 */
export function createSupplyFulfillmentProvider(
  store: SuppliesSeamStore,
  creator?: SupplyRequestCreator,
): SupplyFulfillmentProvider {
  return {
    async createDirectSupplyRequest(input: CreateDirectSupplyRequestInput) {
      if (creator === undefined) {
        // Fail LOUD, not silent. A supply request written without its D4 resolution frozen on cannot
        // answer "why this vendor" at survey, and §3.1.7's CHECK would refuse to let it leave `requested`.
        throw new SupplyStateError(
          "M21_ROUTING_NOT_RESOLVED",
          "SupplyFulfillmentProvider.createDirectSupplyRequest is unbound (no M21 write service on this boot)",
        );
      }
      return creator.createDirect(input);
    },

    async getSupplyRequestStatus(supplyRequestId: SupplyRequestId) {
      return store.requestStatus(supplyRequestId);
    },

    async isTerminal(supplyRequestId: SupplyRequestId) {
      const row = await store.requestStatus(supplyRequestId);
      if (row === null) return null;
      return { isTerminal: TERMINAL.has(row.status), currentStatus: row.status };
    },
  };
}

/**
 * §4.8 `ComfortKitDispatchProvider` — M13's bedside surface plus the D17 / M37 IPU-room stock kit.
 */
export function createComfortKitDispatchProvider(
  store: SuppliesSeamStore,
  clock: SuppliesSeamClock,
): ComfortKitDispatchProvider {
  return {
    async listActiveDispatchesForPatient(
      patientId: PatientId,
    ): Promise<readonly ActiveDispatchView[]> {
      return store.activeDispatchesForPatient(patientId);
    },

    async getDispatchDetail(dispatchId: ComfortKitDispatchId): Promise<DispatchDetailView | null> {
      return store.dispatchDetail(dispatchId);
    },

    async getIpuRoomKitInventory(
      locationId: LocationId,
      ipuRoomId: IpuRoomId,
    ): Promise<IpuRoomKitInventoryView> {
      return {
        locationId,
        ipuRoomId,
        dispatches: await store.ipuRoomDispatches(locationId, ipuRoomId),
      };
    },

    /**
     * §4.8 / D6 — M13 reports a bedside count that disagrees with the lot's expected remainder. This
     * APPENDS the observation to the dispatched line's DEA 21 CFR §1304 perpetual log and returns.
     *
     * It does NOT decide a discrepancy, and that is the load-bearing part: §2.6's reconciliation owns the
     * D8 verdict, computed from the dispatched-vs-returned quantities at close-out. Letting a seam caller
     * set (and therefore clear) the flag would make the discrepancy a claim rather than a computation —
     * the same rule M21-T03 wrote into `reconcileReturn`. What the drawdown DOES do is put the observation
     * into the perpetual record so the close-out can be measured against it, and so an investigation can
     * see the count that first looked wrong even if the kit later reconciles clean.
     *
     * `computeReturnLine` is reused for the arithmetic so the number M13 sees at the bedside and the number
     * the reconciliation reports come from ONE implementation.
     *
     * An unresolvable line RAISES `M21_DISPATCH_NOT_FOUND`. Silently dropping a controlled-substance count
     * would leave the log claiming a continuity it does not have.
     */
    async notifyAdministrationDrawdown(input: AdministrationDrawdownInput): Promise<void> {
      const line = computeReturnLine({
        dispatchedQuantity: input.expectedRemainingQuantity,
        quantityReturned: input.observedRemainingQuantity,
        quantityDisposedAtHome: "0",
        // The drawdown seam does not carry the schedule and does not need it: only `quantityUnaccounted`
        // is read below, and the D8 5% FLAG (the part the schedule gates) is not this method's verdict to
        // make. Declaring the line non-controlled here keeps `discrepancyFlagged` false by construction,
        // which is the honest encoding of "this call does not decide that".
        isControlledSubstance: false,
        controlledSubstanceSchedule: null,
      });
      const entry: DeaPerpetualLogEntry = {
        transactionKind: "administer_drawdown",
        // Signed: what left the unit between the expected and the observed remainder. `quantityUnaccounted`
        // is non-negative by construction, so the delta is its negation.
        quantityDelta: `-${line.quantityUnaccounted}`,
        balanceAfterQuantity: input.observedRemainingQuantity,
        unit: "",
        recordedByMembershipId: input.observedByMembershipId,
        witnessMembershipId: null,
        occurredAt: input.observedAt ?? clock(),
        sourceReference: input.dispatchId,
      };
      const appended = await store.appendPerpetualLogEntry(input.dispatchedContentId, entry);
      if (!appended) {
        throw new SupplyStateError(
          "M21_DISPATCH_NOT_FOUND",
          `dispatched content ${input.dispatchedContentId} does not resolve in this org; the drawdown was not logged`,
        );
      }
    },
  };
}

/** Project the port's per-kind totals onto the §4.8 per-patient summary. */
export function patientCostSummaryOf(
  patientId: PatientId,
  orgId: OrgId,
  fromDate: LocalDate,
  toDate: LocalDate,
  totals: SupplyCostTotals,
): PatientSupplyCostSummary {
  return {
    patientId,
    orgId,
    fromDate,
    toDate,
    dmeTotalCents: totals.dmeTotalCents,
    supplyTotalCents: totals.supplyTotalCents,
    comfortKitTotalCents: totals.comfortKitTotalCents,
    // Summed HERE rather than in SQL so the parts and the whole can never disagree by a rounding rule the
    // adapter applied and the contract did not.
    totalCents: totals.dmeTotalCents + totals.supplyTotalCents + totals.comfortKitTotalCents,
    accruedRequestCount: totals.accruedRequestCount,
    unreconciledRequestCount: totals.unreconciledRequestCount,
  };
}

/** Project the port's per-kind totals onto the §4.8 per-org summary. */
export function orgSpendSummaryOf(
  orgId: OrgId,
  fromDate: LocalDate,
  toDate: LocalDate,
  totals: SupplyCostTotals,
): OrgSupplySpendSummary {
  return {
    orgId,
    fromDate,
    toDate,
    dmeTotalCents: totals.dmeTotalCents,
    supplyTotalCents: totals.supplyTotalCents,
    comfortKitTotalCents: totals.comfortKitTotalCents,
    totalCents: totals.dmeTotalCents + totals.supplyTotalCents + totals.comfortKitTotalCents,
    patientCount: totals.patientCount,
    requestCount: totals.requestCount,
  };
}

/**
 * §4.8 `SupplyCostProvider` — the M23 cap-spend and M27 cost-report inputs.
 *
 * BOTH summaries label their answer with the CALLER'S org, resolved from the ambient request context —
 * never with the `orgId` argument. `getOrgSupplySpendSummary` accepts one on the published contract, but
 * the rows come back under the caller's RLS scope regardless, so echoing the argument would label one
 * tenant's numbers with another tenant's id. That is worse than refusing: a cost report assembled from a
 * mislabelled roll is a filed misstatement. A caller who asks about an org that is not theirs therefore
 * gets an explicit refusal, not a quietly relabelled answer.
 */
export function createSupplyCostProvider(
  store: SuppliesSeamStore,
  orgOf: SuppliesSeamOrgResolver,
): SupplyCostProvider {
  return {
    async getPatientSupplyCostSummary({ patientId, fromDate, toDate }) {
      const totals = await store.patientCostTotals({ patientId, fromDate, toDate });
      return patientCostSummaryOf(patientId, orgOf(), fromDate, toDate, totals);
    },

    async getOrgSupplySpendSummary({ orgId, fromDate, toDate }) {
      const callerOrg = orgOf();
      if (callerOrg !== "" && orgId !== callerOrg) {
        throw new SupplyStateError(
          "M21_SERVING_LOCATION_UNRESOLVED",
          `SupplyCostProvider is RLS-scoped to the caller's org; it cannot report on org ${orgId}`,
        );
      }
      const totals = await store.orgCostTotals({ fromDate, toDate });
      return orgSpendSummaryOf(callerOrg === "" ? orgId : callerOrg, fromDate, toDate, totals);
    },
  };
}
