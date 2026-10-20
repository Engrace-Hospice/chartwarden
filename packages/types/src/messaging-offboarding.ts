// M36 WP 5.9 (ADR-0084) - workforce offboarding. One idempotent, resumable operation for a person who is no longer active: a dry-run preview
// and an execute step report, per item, what M36 did and what still needs a human. Counts and ids only: never a message, a name or a patient.

/** Lets a security officer preview and run the offboarding of a departed user in the organisation (granted like messaging.sessions.manage). */
export const OFFBOARDING_MANAGE_PERMISSION = "messaging.offboarding.manage";

/** The fresh-step-up operation key the execute step demands (platform floor policy: webauthn or totp within the default window). */
export const OFFBOARDING_EXECUTE_STEP_UP_KEY = "messaging.offboarding.execute";

/** In execution order: access is cut first, then owned work is moved, then personal leftovers are swept. */
export const OFFBOARDING_ITEM_KEYS = [
  "sessions_devices",
  "channel_memberships",
  "tasks",
  "handoffs",
  "ack_assigned",
  "ack_sent",
  "urgent_untracked",
  "oncall_seats",
  "scheduled_sends",
  "reminders_snoozes",
  "drafts",
] as const;
export type OffboardingItemKey = (typeof OFFBOARDING_ITEM_KEYS)[number];

/**
 * done          nothing left for M36 to do (or it did it).
 * pending       preview only: execute will do it.
 * needs_person  execute could not finish it: a supervisor must decide (never silently dropped).
 * kept          attribution is kept on purpose; the count is informational.
 * advisory      M36 cannot see it (the on-call roster is M19's): somebody must look.
 * failed        a step threw or left work behind; run execute again.
 */
export const OFFBOARDING_ITEM_STATES = [
  "done",
  "pending",
  "needs_person",
  "kept",
  "advisory",
  "failed",
] as const;
export type OffboardingItemState = (typeof OFFBOARDING_ITEM_STATES)[number];

export interface OffboardingItemDto {
  readonly key: OffboardingItemKey;
  readonly state: OffboardingItemState;
  /** What is left (preview), what is left after the run (execute), or the kept count. */
  readonly count: number;
  /** Execute only: how many things this run changed. Zero on a re-run. */
  readonly acted: number;
  /** Of `count`, how many cannot be moved by M36 and need a person. */
  readonly needs_person: number;
}

export interface OffboardingDto {
  readonly user_id: string;
  readonly items: readonly OffboardingItemDto[];
  /** Items that are done or kept, out of all items. */
  readonly done: number;
  readonly total: number;
  /** No item is pending, needs a person or failed. The advisory on-call item never blocks. */
  readonly complete: boolean;
  /** Keys of the items that keep it from being complete. */
  readonly blocked_by: readonly OffboardingItemKey[];
}
