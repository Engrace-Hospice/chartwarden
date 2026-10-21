// @chartwarden/inpatient — M37-T05, §2.4 D4/D5. Pure validators for the GIP admission criteria + the
// per-encounter reassessment staleness clock. IO-free — the M8 `encounter.signed` consumer (M37-T10)
// injects the timestamps; the route (M37-T11) validates the payload before persisting the row.
import { Value } from "@sinclair/typebox/value";
import { IpuStateError, requireIpu } from "../../errors";
import { GipCriteriaPayload, type GipCriteriaPayloadType } from "./schema";

/** §2.4 D5 — the reassessment-staleness platform floor: an encounter >24h past the last reassessment is due. */
export const GIP_REASSESSMENT_STALENESS_FLOOR_HOURS = 24;
/** §2.4 D5 — the lowest a tenant may tighten the reassessment window to (4 hours). */
export const GIP_REASSESSMENT_MIN_HOURS = 4;

/**
 * Validate a `gip_admission_criteria.data` payload against the §2.4 discriminated union. Throws
 * {@link IpuStateError} `GIP_CRITERIA_INVALID_PAYLOAD` (422) with the first schema error path on mismatch.
 * Returns the narrowed payload on success (the DB `data jsonb` column is untyped; this is the type gate).
 */
export function validateGipCriteriaPayload(payload: unknown): GipCriteriaPayloadType {
  if (!Value.Check(GipCriteriaPayload, payload)) {
    const first = [...Value.Errors(GipCriteriaPayload, payload)][0];
    throw new IpuStateError(
      "GIP_CRITERIA_INVALID_PAYLOAD",
      `Invalid GIP criteria payload${first ? ` at '${first.path}': ${first.message}` : ""}.`,
    );
  }
  return payload as GipCriteriaPayloadType;
}

/**
 * §2.4 D5 — normalize a tenant's configured reassessment-staleness hours. The floor is 24 hours; tenants may
 * tighten to as little as 4 hours but never loosen above the floor. Throws `GIP_REASSESSMENT_NOT_TIGHTENING`
 * on a loosening attempt.
 */
export function normalizeReassessmentStalenessHours(configuredHours: number): number {
  requireIpu(
    configuredHours <= GIP_REASSESSMENT_STALENESS_FLOOR_HOURS,
    "GIP_REASSESSMENT_NOT_TIGHTENING",
    `A GIP reassessment window may not loosen above the ${GIP_REASSESSMENT_STALENESS_FLOOR_HOURS}h floor.`,
  );
  return Math.max(GIP_REASSESSMENT_MIN_HOURS, configuredHours);
}

/**
 * §2.4 D5 — is a GIP reassessment due? The `m8.encounter.signed` consumer calls this: a signed encounter
 * whose `signed_at` is more than `stalenessHours` past the admission's last `gip_criteria_reassessment`
 * (or, for a never-reassessed admission, past the admission's activation) means `m37.gip_criteria.reassessment_due`.
 */
export function isReassessmentDue(
  lastReassessedAtMs: number,
  encounterSignedAtMs: number,
  stalenessHours: number = GIP_REASSESSMENT_STALENESS_FLOOR_HOURS,
): boolean {
  return encounterSignedAtMs - lastReassessedAtMs > stalenessHours * 3_600_000;
}
