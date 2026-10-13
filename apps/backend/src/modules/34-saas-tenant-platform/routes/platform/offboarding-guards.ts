// Offboarding chain helpers (M34 §2.2 / §2.5 r6-r7): completeExport opens the retention window, and
// scheduleDestruction needs that window elapsed and no legal hold before a tenant may reach `destruction_pending`.
/** HIPAA 45 CFR 164.316(b)(2)(i): documentation is retained six years. A longer tenant override would be a policy change. */
export const TENANT_RETENTION_YEARS = 6;

/** `retention_ends_at` for a tenant whose final export just completed (the `set_retention_window` effect). */
export function retentionEndsAtFrom(from: Date): Date {
  const ends = new Date(from);
  ends.setUTCFullYear(ends.getUTCFullYear() + TENANT_RETENTION_YEARS);
  return ends;
}

export interface DestructionGuardInput {
  readonly retentionEndsAt: Date | null;
  readonly now: Date;
  /** No active M4 legal hold references this organization. */
  readonly legalHoldClear: boolean;
}

/** The two guards of the `scheduleDestruction` event; an unrecorded retention window never counts as elapsed. */
export function evaluateDestructionGuards(input: DestructionGuardInput): {
  readonly retentionElapsed: boolean;
  readonly legalHoldClear: boolean;
} {
  return {
    retentionElapsed:
      input.retentionEndsAt !== null && input.retentionEndsAt.getTime() <= input.now.getTime(),
    legalHoldClear: input.legalHoldClear,
  };
}
