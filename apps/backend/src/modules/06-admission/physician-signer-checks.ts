// apps/backend/src/modules/06-admission/physician-signer-checks.ts — the 42 CFR 418.26(b) discharge-order and
// 418.25(a) admission-recommendation validation BOTH admission route services (Drizzle + in-memory slice)
// share, so the rule cannot drift between them. Facts come from the injected PhysicianAuthorityPort (or, for
// the route-40 cosigner, the server-derived `request.context.roles`); a refusal is an AdmissionStateError.
import {
  type PhysicianAuthorityPort,
  type PhysicianSignerCapacity,
  admissionRecommendationCapacities,
  dischargeOrderCapacities,
  dischargeOrderRequiredAtFiling,
  dischargeOrderTimingValid,
  resolvePhysicianSigner,
} from "./physician-authority";
import { AdmissionStateError } from "./state-machines/errors";

/** The discharge order as captured on route 39 (`DischargeCreateSchema.dischargeOrder`). */
export interface DischargeOrderInput {
  readonly signedByUserId: string;
  readonly signedAt: string;
  readonly capacity?: PhysicianSignerCapacity;
  readonly orderText?: string;
  readonly orderReference?: string;
}

/** A validated order, ready to persist on `discharge_event`. */
export interface ValidatedDischargeOrder {
  readonly signedByUserId: string;
  readonly capacity: PhysicianSignerCapacity;
  readonly signedAt: Date;
  readonly orderText: string | null;
  readonly orderReference: string | null;
}

/**
 * Route 39 — validate (or require) the physician discharge order. Returns `null` when none was supplied and
 * none is required (death, for-cause, or a pre-2026-10-01 discharge under the legacy rule).
 */
export async function validateDischargeOrder(args: {
  readonly port: PhysicianAuthorityPort;
  readonly organizationId: string;
  readonly patientId: string;
  readonly reason: string;
  readonly dischargeDate: string;
  readonly order: DischargeOrderInput | undefined;
  readonly now: Date;
}): Promise<ValidatedDischargeOrder | null> {
  const { order, reason, dischargeDate } = args;
  if (!order) {
    if (dischargeOrderRequiredAtFiling(reason, dischargeDate))
      throw new AdmissionStateError(
        "DISCHARGE_ORDER_REQUIRED",
        "a live discharge on or after 2026-10-01 requires a written physician discharge order (42 CFR 418.26(b))",
      );
    return null;
  }
  if (reason === "death" || reason === "for_cause")
    throw new AdmissionStateError(
      "PHYSICIAN_SIGNER_INVALID",
      reason === "death"
        ? "a death discharge carries no physician discharge order"
        : "a for-cause discharge order is the medical-director cosign (route 40), not a filing field",
    );
  if (!dischargeOrderTimingValid(order.signedAt, dischargeDate, args.now))
    throw new AdmissionStateError(
      "DISCHARGE_ORDER_TIMING_INVALID",
      "the discharge order must be signed no later than the discharge date and not in the future",
    );
  const facts = await args.port.signerFacts(
    args.organizationId,
    order.signedByUserId,
    args.patientId,
  );
  const verdict = resolvePhysicianSigner({
    facts,
    allowed: dischargeOrderCapacities(dischargeDate),
    claimed: order.capacity,
  });
  if (!verdict.ok) throw new AdmissionStateError("PHYSICIAN_SIGNER_INVALID", verdict.message);
  return {
    signedByUserId: order.signedByUserId,
    capacity: verdict.capacity,
    signedAt: new Date(order.signedAt),
    orderText: order.orderText ?? null,
    orderReference: order.orderReference ?? null,
  };
}

/**
 * Route 40 — the cosigning physician (the request's actor) IS the for-cause discharge-order signer. Role
 * capacities come from the server-derived `actorRoleKeys`; only the IDG-membership fact needs the port.
 * An `hl7_external` death attestation stays medical-director-only (M6 §4.8.4 — not a 418.26 discharge).
 */
export async function resolveCosignerCapacity(args: {
  readonly port: PhysicianAuthorityPort;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorRoleKeys: readonly string[];
  readonly patientId: string | null;
  readonly dischargeDate: string;
  readonly externalDeath: boolean;
  readonly claimed?: PhysicianSignerCapacity;
}): Promise<PhysicianSignerCapacity> {
  const allowed: readonly PhysicianSignerCapacity[] = args.externalDeath
    ? ["medical_director"]
    : dischargeOrderCapacities(args.dischargeDate);
  const idgPhysicianOfPatient =
    allowed.includes("idg_physician_member") && args.patientId !== null
      ? (await args.port.signerFacts(args.organizationId, args.actorUserId, args.patientId))
          .idgPhysicianOfPatient
      : false;
  const verdict = resolvePhysicianSigner({
    facts: { roleKeys: args.actorRoleKeys, idgPhysicianOfPatient },
    allowed,
    claimed: args.claimed,
  });
  if (!verdict.ok) throw new AdmissionStateError("PHYSICIAN_SIGNER_INVALID", verdict.message);
  return verdict.capacity;
}

/** The admission recommendation as captured (`AdmissionRecommendationSchema`). */
export interface AdmissionRecommendationInput {
  readonly recommendedByUserId: string;
  readonly recommendedAt: string;
  readonly capacity?: PhysicianSignerCapacity;
  readonly attendingConsulted: boolean;
  readonly attendingConsultNote?: string;
}

/** Minimum length of the note explaining why an admission's attending physician was not consulted. */
export const ATTENDING_NOT_CONSULTED_NOTE_MIN = 10;

/**
 * 418.25(a) — validate a recommendation: not in the future, from the signer set in force on its date, and —
 * when the admission names an attending physician who was NOT consulted — with a note saying why.
 */
export async function validateAdmissionRecommendation(args: {
  readonly port: PhysicianAuthorityPort;
  readonly organizationId: string;
  readonly patientId: string;
  readonly hasAttendingPhysician: boolean;
  readonly input: AdmissionRecommendationInput;
  readonly now: Date;
}): Promise<PhysicianSignerCapacity> {
  const { input } = args;
  const at = Date.parse(input.recommendedAt);
  if (Number.isNaN(at) || at > args.now.getTime())
    throw new AdmissionStateError(
      "ADMISSION_RECOMMENDATION_INVALID",
      "the admission recommendation cannot be dated in the future",
    );
  if (
    args.hasAttendingPhysician &&
    !input.attendingConsulted &&
    (input.attendingConsultNote ?? "").trim().length < ATTENDING_NOT_CONSULTED_NOTE_MIN
  )
    throw new AdmissionStateError(
      "ATTENDING_CONSULT_NOTE_REQUIRED",
      "the patient has an attending physician; record why they were not consulted (42 CFR 418.25(a))",
    );
  const facts = await args.port.signerFacts(
    args.organizationId,
    input.recommendedByUserId,
    args.patientId,
  );
  const verdict = resolvePhysicianSigner({
    facts,
    allowed: admissionRecommendationCapacities(input.recommendedAt),
    claimed: input.capacity,
  });
  if (!verdict.ok) throw new AdmissionStateError("PHYSICIAN_SIGNER_INVALID", verdict.message);
  return verdict.capacity;
}
