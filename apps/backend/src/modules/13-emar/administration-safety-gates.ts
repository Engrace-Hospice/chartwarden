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
  type BarcodeScanInput,
  type FiveRightsOrderContext,
  type FiveRightsRequest,
  assertFiveRights,
} from "@wardenx/emar";
import {
  type ErrorDetailType,
  type PatientWristbandVerifier,
  ChartWardenError,
  type WristbandVerdict,
  type WristbandVerdictStatus,
} from "@wardenx/types";

/** The slice of the M12 order identity the gates read (all optional: an unbound port states nothing). */
export interface OrderSafetyFacts {
  readonly patientId: string;
  readonly route: string;
  readonly allowAdministration: boolean;
  readonly doseAmount?: number | null;
  readonly doseUnit?: string | null;
  readonly rxnormRxcui?: string | null;
  readonly ndc?: string | null;
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
export function barcodeContextsOf(
  order: OrderSafetyFacts,
  wristband: BarcodePatientContext["wristband"],
): {
  readonly order: BarcodeOrderContext;
  readonly patient: BarcodePatientContext;
} {
  return {
    order: {
      orderActive: order.allowAdministration,
      rxnormRxcui: order.rxnormRxcui ?? null,
      ndc: order.ndc ?? null,
    },
    patient: { wristband },
  };
}

/** What `barcode_scan_event.wristband_check` records: M5's verdict, or that the policy let a bandless scan by. */
export type WristbandCheckOutcome = WristbandVerdictStatus | "skipped_policy_off";

export interface BedsideWristbandCheck {
  readonly context: BarcodePatientContext;
  readonly verdict: WristbandVerdict;
  readonly check: WristbandCheckOutcome;
  /** The instant the band was (claimed to be) scanned: server time online; the clamped device time offline. */
  readonly asOf: string;
}

const NO_VERDICT: Omit<WristbandVerdict, "status"> = {
  generation: null,
  scannedDigest: null,
  matchedPatientId: null,
};

function offlineAsOf(
  scannedAt: string | null | undefined,
  capturedAt: string | null | undefined,
  nowIso: string,
): string {
  const nowMs = Date.parse(nowIso);
  for (const candidate of [scannedAt, capturedAt]) {
    const ms = candidate ? Date.parse(candidate) : Number.NaN;
    if (Number.isFinite(ms)) return new Date(Math.min(ms, nowMs)).toISOString();
  }
  return nowIso;
}

/**
 * GAP-020 -- ask M5 whether the scanned wristband is THIS patient's, for BOTH write paths (clinician and
 * caregiver-attested) so they cannot drift.
 *
 *  - The patient is the ORDER's, never the body's; the raw payload goes to M5 only, which hashes it.
 *  - `asOf` is SERVER time online, so a client cannot backdate a scan to resurrect a superseded band. Only the
 *    offline-sync replay (`mode: "offline_sync"`, set by the service, never by the request) uses the device's
 *    scan time, clamped to <= now.
 *  - With the policy off and no band presented there is nothing to verify: M5 is not asked (an M5 outage must not
 *    block a tenant that does not use wristbands) and the scan records `skipped_policy_off`.
 *  - A verifier that throws (deny-stub, outage) is a 503, NEVER a pass: an unanswerable identity question
 *    refuses the scan. The underlying error text is not echoed (it may carry connection detail).
 */
export async function verifyBedsideWristband(args: {
  readonly verifier: PatientWristbandVerifier;
  readonly organizationId: string;
  readonly patientId: string;
  readonly scan: BarcodeScanInput;
  readonly required: boolean;
  readonly mode: "online" | "offline_sync";
  readonly nowIso: string;
  /** `offlineCapture.capturedAt`: the fallback scan time when an offline row carries no `wristbandScannedAt`. */
  readonly capturedAt?: string | null;
}): Promise<BedsideWristbandCheck> {
  const payload = args.scan.patientWristbandPayload?.trim() || null;
  const asOf =
    args.mode === "offline_sync"
      ? offlineAsOf(args.scan.wristbandScannedAt, args.capturedAt, args.nowIso)
      : args.nowIso;

  if (payload === null && !args.required) {
    return {
      context: { wristband: { required: false, status: "not_presented" } },
      verdict: { status: "not_presented", ...NO_VERDICT },
      check: "skipped_policy_off",
      asOf,
    };
  }

  let verdict: WristbandVerdict;
  try {
    verdict = await args.verifier.verify({
      organizationId: args.organizationId,
      patientId: args.patientId,
      payload,
      asOf,
      mode: args.mode,
    });
  } catch {
    throw new ChartWardenError(
      "WRISTBAND_VERIFIER_UNAVAILABLE",
      "the patient wristband could not be verified right now; the scan was not accepted",
      503,
    );
  }
  return {
    context: { wristband: { required: args.required, status: verdict.status } },
    verdict,
    check: verdict.status,
    asOf,
  };
}

const WRISTBAND_REFUSAL_TEXT: Readonly<
  Record<Exclude<WristbandVerdictStatus, "verified">, string>
> = {
  mismatch: "the scanned wristband is not this patient's",
  not_presented: "no patient wristband was scanned",
  not_on_file: "no wristband is on file for this patient; print one",
  superseded: "that wristband was replaced by a newer one; scan the new band",
  voided: "that wristband was voided; print a new one",
  malformed: "the wristband could not be read; rescan",
};

/** The machine-readable `details` for a wristband-driven BCMA refusal, so the UI can say what to DO. */
export function wristbandRefusalDetails(status: WristbandVerdictStatus): ErrorDetailType[] {
  if (status === "verified") return [];
  return [
    {
      field: "barcodeScan.patientWristbandPayload",
      code: `WRISTBAND_${status.toUpperCase()}`,
      message: WRISTBAND_REFUSAL_TEXT[status],
    },
  ];
}
