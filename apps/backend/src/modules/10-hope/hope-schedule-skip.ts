// M10 — the rule for the reason a timepoint schedule is skipped. Shared by the DB backend and the in-memory slice, so the two
// cannot drift (the route's TypeBox schema carries the same closed list, as the first gate).
//
// The code lands in `hope_timepoint_schedule.skip_reason_code` and in the immutable write-audit before/after, so it is a
// CLOSED list (`HOPE_SCHEDULE_SKIP_REASON_CODES`): no free text, so no PHI. Rows written before the list existed keep
// whatever code they hold; only a NEW skip is judged.
import {
  HOPE_SCHEDULE_SKIP_REASON_CODES,
  type HopeScheduleSkipReasonCode,
  ValidationError,
} from "@chartwarden/types";

const ALLOWED: ReadonlySet<string> = new Set(HOPE_SCHEDULE_SKIP_REASON_CODES);

/**
 * The reason as one of the closed codes, or a 422. The refusal names the field and the list, never the value sent: a
 * rejected code can be anything a caller typed, and the error envelope is replayed from the idempotency cache.
 */
export function requireSkipReasonCode(reasonCode: string): HopeScheduleSkipReasonCode {
  if (!ALLOWED.has(reasonCode)) {
    throw new ValidationError("The skip reason is not one of the allowed codes.", [
      {
        field: "reasonCode",
        code: "M10_SKIP_REASON_NOT_ALLOWED",
        message: `reasonCode must be one of: ${HOPE_SCHEDULE_SKIP_REASON_CODES.join(", ")}.`,
      },
    ]);
  }
  return reasonCode as HopeScheduleSkipReasonCode;
}
