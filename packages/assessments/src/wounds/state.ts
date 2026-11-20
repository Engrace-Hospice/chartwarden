// @chartwarden/assessments — wound lifecycle guards (pure): what may still be done to a wound or an observation.
// A correction reuses the M9 codes (`STALE_VERSION`, `CORRECTION_TARGET_NOT_ACTIVE`) so a client already handling an
// assessment correction handles this one.
import { ChartWardenError } from "@chartwarden/types";
import { AssessmentStateError } from "../errors";
import type { WoundObservationStatus, WoundStatus } from "./value-sets";

export const WOUND_STATE_STATUS = {
  /** An observation was recorded against a wound that is already healed or resolved. */
  WOUND_NOT_OPEN: 409,
} as const;
export type WoundStateCode = keyof typeof WOUND_STATE_STATUS;

export class WoundStateError extends ChartWardenError {
  constructor(code: WoundStateCode, message: string) {
    super(code, message, WOUND_STATE_STATUS[code]);
    this.name = "WoundStateError";
  }
}

/** A new observation, or a resolution, needs an open wound. */
export function assertWoundOpen(status: WoundStatus): void {
  if (status !== "open") {
    throw new WoundStateError("WOUND_NOT_OPEN", "the wound is already resolved");
  }
}

/**
 * A correction supersedes the observation it names: that observation must still be the active one, at the version the
 * caller read (`If-Match`). Not-active is reported first: a superseded row has also moved on in version.
 */
export function assertCorrectable(
  target: { readonly status: WoundObservationStatus; readonly version: number },
  expectedVersion: number,
): void {
  if (target.status !== "active") {
    throw new AssessmentStateError(
      "CORRECTION_TARGET_NOT_ACTIVE",
      "the observation was already corrected; read the current one",
    );
  }
  if (target.version !== expectedVersion) {
    throw new AssessmentStateError(
      "STALE_VERSION",
      "the observation changed since you read it; reload and try again",
    );
  }
}
