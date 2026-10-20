// apps/backend/src/modules/36-messaging/governance/under-hold.ts - ADR-0086 (PROPOSED): migration 1138's backstop trigger refuses to rewrite the
// body of a message an ACTIVE legal hold covers (SQLSTATE 23001). Turn that into a clear, typed 409 instead of a generic 500.
import { WardenXError } from "@wardenx/types";

const RESTRICT_VIOLATION = "23001";
export const MESSAGE_UNDER_LEGAL_HOLD_CODE = "MESSAGE_UNDER_LEGAL_HOLD";

/** True when `err` (or its driver cause) is the legal-hold backstop trigger's refusal. */
export function isLegalHoldViolation(err: unknown): boolean {
  const code = (e: unknown) => (e as { code?: unknown } | null | undefined)?.code;
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  return code(err) === RESTRICT_VIOLATION || code(cause) === RESTRICT_VIOLATION;
}

/** Run a message rewrite; a held message answers 409 MESSAGE_UNDER_LEGAL_HOLD (no hold name or reason is revealed). */
export async function rejectIfUnderLegalHold<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isLegalHoldViolation(err)) {
      throw new WardenXError(
        MESSAGE_UNDER_LEGAL_HOLD_CODE,
        "This message is under a legal hold and cannot be edited.",
        409,
      );
    }
    throw err;
  }
}
