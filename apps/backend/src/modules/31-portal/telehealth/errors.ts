// apps/backend/src/modules/31-portal/telehealth/errors.ts — M31-T05 (§2.2.3, §2.3, §7.2, §7.3, §7.4, D8/D9/D14).
//
// The telehealth sub-domain's guard-failure codes, parallel to the portal `PortalStateError` catalog
// (../lifecycle/errors.ts). Kept separate because the telehealth visit/room state machine, the D14 audio-only
// fallback planner, and the D9 two-party recording-consent gate are a distinct concern from the portal
// account/session/grant lifecycle — but the same M1 `ChartWardenError` envelope base (packages/types, NOT the
// banned packages/foundation) so the M1 Fastify error handler renders the exact code + status with no
// cross-module import edge. Mirrors the M19 `TriageStateError` / M20 `SafetyStateError` precedent.
//
// FAIL DIRECTION IS PER GUARD. The recording-consent gate fails CLOSED (a missing/unreadable recording
// consent in a two-party state disables the Record button — never a default-allow, §7.4). An illegal
// lifecycle transition is a `409` conflict (the caller raced the state machine). The audio-only fallback is
// NEVER an error for the expected degrade — it returns a plan (§7.3 "the chart-writing path is NEVER blocked").
import { ChartWardenError } from "@wardenx/types";

/** The §7.2–§7.4 / D8 / D9 / D14 telehealth failure-code catalog → HTTP status. */
export const TELEHEALTH_ERROR_STATUS = {
  /** §2.2.3 / D8 — an illegal visit/room lifecycle transition (e.g. `reconciled` → `in_progress`). The state
   *  machine is append-forward; a request that names a transition not in `TELEHEALTH_TRANSITIONS` raced the
   *  live row and is refused rather than silently forcing the state. */
  TELEHEALTH_INVALID_TRANSITION: 409,
  /** §7.4 / D9 — the Record button was requested but not every participant in a two-party-consent state has an
   *  active M39 recording consent on file. Fails CLOSED: a missing OR unreadable consent both deny (§8.2 —
   *  a consent-read outage must not become a recording without consent). */
  TELEHEALTH_RECORDING_CONSENT_ABSENT: 403,
  /** §7.4 — recording was requested on a visit that is not in an active state (`room_minted` before anyone
   *  joined, or an already-ended visit). There is nothing to record. */
  TELEHEALTH_NOT_RECORDABLE: 409,
  /** F-220 (#248) — the lazy room mint (first clinician join of a `telephonic` visit) could not reach a vendor:
   *  no adapter is bound (production today — no per-tenant vendor key vault) or the vendor call failed. Fails
   *  CLOSED: no `telehealth_visit` row is written without a real room behind it. */
  TELEHEALTH_VENDOR_UNAVAILABLE: 503,
} as const;

/** A machine-readable telehealth failure code (§7.2–§7.4 / D8 / D9 / D14). */
export type TelehealthErrorCode = keyof typeof TELEHEALTH_ERROR_STATUS;

/**
 * A guard / validation failure in the M31 telehealth sub-domain. Carries the precise code so the §5 screens
 * render an exact message; the M1 error handler maps `statusCode` to the HTTP response.
 */
export class TelehealthStateError extends ChartWardenError {
  constructor(code: TelehealthErrorCode, message: string) {
    super(code, message, TELEHEALTH_ERROR_STATUS[code]);
    this.name = "TelehealthStateError";
  }
}

/**
 * Throw a {@link TelehealthStateError} when `condition` is false (guard helper). Declared `asserts condition`
 * — the M31 portal `requirePortal` precedent — so a proven fact stays proven for the compiler downstream.
 */
export function requireTelehealth(
  condition: boolean,
  code: TelehealthErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new TelehealthStateError(code, message);
}
