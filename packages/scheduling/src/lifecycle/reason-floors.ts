// @chartwarden/scheduling — §2.3 documented-reason length floors (M17-T03).
//
// The §2.2.1 / §2.3 minimum-length guards the visit + time_off machines enforce, repeated by the §2.3 DB
// CHECK constraints (M17-T02) as defense in depth. The EVV-missing self-attest floor (40 chars) is a
// stricter, distinct value and lives in `../policy` (`EVV_MISSING_SELF_ATTEST_MIN_REASON_LENGTH`).

/** §2.2.1 / §2.3 — `visit.cancellation_reason` minimum length (chars). */
export const VISIT_CANCEL_REASON_MIN_LENGTH = 20;

/** §2.2.1 / §2.3 — `visit.reschedule_reason` minimum length (chars). */
export const VISIT_RESCHEDULE_REASON_MIN_LENGTH = 20;

/** §2.2.6 — `time_off.denial_reason` minimum length (chars; route `/time-off/:id/deny` reason ≥ 20). */
export const TIME_OFF_DENIAL_REASON_MIN_LENGTH = 20;
