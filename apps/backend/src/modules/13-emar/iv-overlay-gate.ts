// apps/backend/src/modules/13-emar/iv-overlay-gate.ts — M13's consult of M37's IV-continuous safety overlay
// (M37 §2.6 / D7, GAP-107). Before an `iv_continuous_start` or `iv_continuous_rate_change` is written, the
// overlay of the order's IPU admission (if the patient is on one) must pass: rate inside the titration window,
// dual witness for a sedation-class drip, max continuous duration not exceeded, bedside check not overdue
// (a rate change/titration is exempt from the last: the clinician at the bedside must always be able to adjust
// the drip, and the watchdog pages an overdue check).
// M13 had no caller for `getOverlayForOrder`, so none of those four checks ran.
//
// M13 depends on M37 only through the `IpuIvSafetyOverlayProvider` seam interface (a `@chartwarden/types` leaf,
// resolved per call by the composition root) — no compile edge, no schema import. The overlay's decision logic
// is M37's (`evaluateIvPreAdministration`); this file only assembles the facts M13 owns (the session's
// segments, the proposed rate) and turns a refusal into the §2.6 412 the caller sees.
//
// DUAL WITNESS is enforced in two halves: the overlay refuses (412 IV_DUAL_WITNESS_REQUIRED) a sedation-class
// administration that carries NO witness token, and `dualWitnessRequired` is returned so the caller folds it into
// `requiresWitness` — which routes a token that IS present through the full D7 verification (HMAC, scope,
// expiry, single-use burn, witness-eligibility ABAC). Without that second half a non-controlled sedation drip
// would be "witnessed" by any string in the header.
//
// FAIL CLOSED: if the seam is unregistered/throws, the error propagates and the administration is NOT written —
// an IV infusion is the last place to treat "could not check" as "checked".
import { AdministrationStateError, type IvSegment } from "@chartwarden/emar";
import type { IpuIvPreAdministrationInput, IpuIvPreAdministrationVerdict } from "@chartwarden/types";

export type EmarIvOverlayPort = {
  evaluatePreAdministration(
    organizationId: string,
    input: IpuIvPreAdministrationInput,
  ): Promise<IpuIvPreAdministrationVerdict>;
};

/** No overlay seam bound (slice/unit harnesses): no overlay applies, M13's own checks stand alone. */
export const UNBOUND_IV_OVERLAY: EmarIvOverlayPort = {
  async evaluatePreAdministration() {
    return { overlayApplies: false, pass: true, dualWitnessRequired: false };
  },
};

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

const REFUSAL_MESSAGES = {
  IV_RATE_OUTSIDE_TITRATION_WINDOW:
    "the infusion rate is outside the IPU safety overlay's titration window for this medication",
  IV_DUAL_WITNESS_REQUIRED:
    "this sedation-class infusion requires a second-clinician witness attestation",
  IV_MAX_CONTINUOUS_DURATION_REACHED:
    "the infusion has reached its maximum continuous duration; a new order or a stop is required",
  IV_BEDSIDE_CHECK_OVERDUE:
    "the infusion's bedside check is overdue; check the patient and record a pause/resume before continuing",
} as const;

/** The rate + unit the gated segment states. `iv_continuous_start` carries `infusionRate`, a rate change `newRate`. */
function proposedRateOf(mode: string, data: unknown): { rate: number | null; unit: string | null } {
  const d = (data ?? {}) as Record<string, unknown>;
  const raw = mode === "iv_continuous_start" ? d.infusionRate : d.newRate;
  const unit = [d.rateUnit, d.infusionRateUnit].find((v) => typeof v === "string");
  return {
    rate: typeof raw === "number" && Number.isFinite(raw) ? raw : null,
    unit: typeof unit === "string" ? unit : null,
  };
}

export interface IvOverlayGateInput {
  readonly organizationId: string;
  readonly medicationOrderId: string;
  readonly mode: string;
  /** The clinical instant of THIS segment (ISO). */
  readonly administeredAt: string;
  /** The session's prior non-voided segments, oldest first (empty for a start). */
  readonly priorSegments: readonly IvSegment[];
  readonly data: unknown;
  readonly witnessTokenPresent: boolean;
}

/**
 * Run the overlay for a gated segment. Returns whether the overlay demands a dual witness (so the caller
 * verifies the token); throws the §2.6 412 `AdministrationStateError` when the overlay refuses.
 */
export async function evaluateIvOverlayGate(
  port: EmarIvOverlayPort,
  input: IvOverlayGateInput,
): Promise<{ readonly dualWitnessRequired: boolean }> {
  if (input.mode !== "iv_continuous_start" && input.mode !== "iv_continuous_rate_change") {
    return { dualWitnessRequired: false };
  }
  const first = input.priorSegments[0];
  const last = input.priorSegments[input.priorSegments.length - 1];
  const at = Date.parse(input.administeredAt);
  const hoursSinceStart = first
    ? Math.max(0, (at - Date.parse(first.administeredAt)) / MS_PER_HOUR)
    : 0;
  const minutesSinceCheck = last
    ? Math.max(0, (at - Date.parse(last.administeredAt)) / MS_PER_MINUTE)
    : 0;
  const { rate, unit } = proposedRateOf(input.mode, input.data);

  const verdict = await port.evaluatePreAdministration(input.organizationId, {
    orderId: input.medicationOrderId,
    proposedRate: rate,
    proposedRateUnit: unit,
    witnessTokenPresent: input.witnessTokenPresent,
    hoursSinceContinuousStart: hoursSinceStart,
    minutesSinceLastBedsideCheck: minutesSinceCheck,
    isTitration: input.mode === "iv_continuous_rate_change",
  });
  if (!verdict.pass) {
    const code = verdict.failureCode ?? "IV_RATE_OUTSIDE_TITRATION_WINDOW";
    throw new AdministrationStateError(code, REFUSAL_MESSAGES[code]);
  }
  return { dualWitnessRequired: verdict.overlayApplies && verdict.dualWitnessRequired };
}
