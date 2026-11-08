// apps/backend/src/modules/12-dosespot/jobs/hold.ts — what marks a transmission HELD, and how long a hold may wait unresolved.
//
// An order is HELD when DoseSpot accepted a NewRx call but its answer is not known (an unreadable 2xx, no prescription id, or a worker that
// died after the call began): the order stays `queued_for_transmission` / `in_flight`, never failed, never re-sent, and its transmission row
// carries this class. A held order leaves that state only by an administrator's resolution (`tenant-config/transmission-resolve.ts`).
// A tiny file of its own so the worker, the age reminder, the route service and the resolve service share one definition without an import cycle.

/** The transmission row's `last_error_class` while an order is HELD for an outcome DoseSpot left unconfirmed. */
export const UNCONFIRMED_OUTCOME_CLASS = "unconfirmed_outcome";
/** The classes an administrator's resolution leaves on the row (the marker is gone: the order is no longer held). */
export const RESOLVED_SENT_CLASS = "resolved_sent";
export const RESOLVED_NOT_SENT_CLASS = "resolved_not_sent";
/** A hold that has waited this long for an administrator raises a reminder (one per episode, through the degradation alert machinery). */
export const HELD_ORDER_REMINDER_AGE_MS = 24 * 60 * 60_000;
