// apps/backend/src/modules/13-emar/administration-safety-gates.ts -- GAP-020/021: the order-context safety
// gates the production administration write path composes from the PURE `@wardenx/emar` deciders
// (§5.11 five-rights, §2.9 BCMA order/patient context).
//
// Every fact here comes from the M12 ORDER (through `EmarMedicationOrderPort`), never from the request body:
// the body supplies only what the clinician says they GAVE (route, amount, unit, instant); the order says what
// was authorised. Kept out of `emar-route-service-db.ts` (already past the file-size ceiling) and pure so the
// gates are unit-testable without a database.
import {
  type BarcodeOrderContext,
  type BarcodePatientContext,
  type FiveRightsOrderContext,
  type FiveRightsRequest,
  assertFiveRights,
} from "@wardenx/emar";

/** The slice of the M12 order identity the gates read (all optional: an unbound port states nothing). */
export interface OrderSafetyFacts {
  readonly patientId: string;
  readonly route: string;
  readonly allowAdministration: boolean;
  readonly doseAmount?: number | null;
  readonly doseUnit?: string | null;
  readonly rxnormRxcui?: string | null;
  readonly ndc?: string | null;
  readonly patientWristbandPayloadDigest?: string | null;
}

/** What the clinician / caregiver says was given. */
export interface GivenDose {
  readonly route?: string | null;
  readonly doseAmount?: number | null;
  readonly doseUnit?: string | null;
}

/**
 * §5.11 -- run the five-rights validator for one administration against the ORDER.
 *
 *  - patient / drug: the administration is filed under the order's own patient and order id (the caller has
 *    already refused a mismatching body patient), so these rights hold by construction and `route`, `dose`
 *    and `time` are the live ones.
 *  - route: the supplied route, else the order's own (an absent route is not a wrong route).
 *  - dose: enforced whenever the order states a positive discrete dose, whether or not the body carries an
 *    amount -- an administration that omits the amount is refused (422), never waved through. An order with no
 *    stated dose has nothing to compare, and a continuous infusion (`discreteDose: false`) has no
 *    per-administration dose -- its rate is bounded by the IV-session gate instead.
 *  - time: an `administeredAt` beyond the clock-skew tolerance in the future fails; the past is a late entry.
 *
 * Throws `FIVE_RIGHTS_VIOLATION` (422).
 */
export function assertOrderFiveRights(args: {
  readonly order: OrderSafetyFacts;
  readonly medicationOrderId: string;
  readonly patientId: string;
  readonly given: GivenDose;
  readonly administeredAt: string;
  readonly nowIso: string;
  readonly discreteDose: boolean;
}): void {
  const { order, given } = args;
  const checksDose = args.discreteDose && (order.doseAmount ?? 0) > 0;
  const orderContext: FiveRightsOrderContext = {
    patientId: order.patientId,
    medicationOrderId: args.medicationOrderId,
    route: order.route,
    doseAmount: checksDose ? (order.doseAmount ?? null) : null,
    doseUnit: checksDose ? (order.doseUnit ?? null) : null,
  };
  const request: FiveRightsRequest = {
    patientId: args.patientId,
    medicationOrderId: args.medicationOrderId,
    route: given.route ?? order.route,
    doseAmount: given.doseAmount ?? null,
    doseUnit: given.doseUnit ?? null,
    administeredAt: args.administeredAt,
  };
  assertFiveRights(request, orderContext, args.nowIso);
}

/** §2.9 -- the REAL order/patient context for a BCMA scan (the scan used to be checked against an empty one). */
export function barcodeContextsOf(order: OrderSafetyFacts): {
  readonly order: BarcodeOrderContext;
  readonly patient: BarcodePatientContext;
} {
  return {
    order: {
      orderActive: order.allowAdministration,
      rxnormRxcui: order.rxnormRxcui ?? null,
      ndc: order.ndc ?? null,
    },
    patient: { wristbandPayloadDigest: order.patientWristbandPayloadDigest ?? null },
  };
}
