// @wardenx/scheduling — the §2.2.5 / §2.3 RRULE-subset grammar constants (M17-T01).
//
// M17 supports only the `FREQ ∈ {DAILY, WEEKLY}` subset of RFC 5545; `MONTHLY`/`YEARLY` are rejected with
// `RECURRENCE_FREQUENCY_NOT_SUPPORTED`. The validated parser (`RRULE_GRAMMAR_v1`) that consumes these
// constants lands in M17-T03 (recurrence-materializer); T01 ships the value sets it validates against.

/** The §2.2.5 supported `FREQ` values; any other frequency is rejected (`RECURRENCE_FREQUENCY_NOT_SUPPORTED`). */
export const SUPPORTED_RRULE_FREQ = ["DAILY", "WEEKLY"] as const;

/** A supported RRULE frequency. */
export type SupportedRruleFreq = (typeof SUPPORTED_RRULE_FREQ)[number];

/** The RFC 5545 weekday codes valid in a WEEKLY rule's `BYDAY`. */
export const RRULE_BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

/** A version tag for the locked RRULE-subset grammar (bumped on a coordinated grammar change). */
export const RRULE_GRAMMAR_VERSION = "RRULE_GRAMMAR_v1" as const;
