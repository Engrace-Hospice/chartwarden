// @wardenx/types · policy — the single `SESSION_POLICY` timeout constant (M2-T04; M2
// spec §2.2.4, §11 D1).
//
// Re-homed from the banned `packages/foundation/src/policy` per ADR-0005 D3 / M02-F03.
// Every session timeout in the platform derives from THIS constant (D1) — there is no
// other source of idle/absolute/screen-lock numbers. The session-class *definitions*
// (scope, concurrency, screen-lock applicability, lifecycle) live in
// `packages/auth/src/identity/session-classes.ts` (M2-T03); the *numbers* live here so
// any layer (auth, M3 authorization, UI screen-lock) reads one floor with no dependsOn
// edge.
//
// `SessionClassName` mirrors the M1-owned `session_class` pgEnum
// (packages/db/src/enums.ts) and `SESSION_CLASSES` in M2-T03. It is declared here as a
// literal union (not imported) because `packages/types` is a leaf with no app-specific
// dependencies.
//
// Authority (M2 spec §2.2.4 table + D1): architecture §7's 15-min idle governs over
// Security Hardening §5.1.4's 30-min; screen-lock (soft re-auth, session stays alive) and
// idle (terminal) are distinct layers.

/** The four session classes — mirrors the `session_class` pgEnum / `SESSION_CLASSES`. */
export type SessionClassName = "staff" | "auditor" | "external_collaborator" | "funeral_home";

/** Per-class timeout floor. All values are seconds. */
export interface SessionClassTimeout {
  /** Inactivity timeout → `expired_idle` (terminal). */
  readonly idleSec: number;
  /**
   * Fixed absolute lifetime → `expired_absolute`. `null` when the absolute bound is an
   * external window rather than a fixed number (auditor → bounded by `engagement_end`).
   */
  readonly absoluteSec: number | null;
  /**
   * Hard cap distinct from the work-session absolute, where the class declares two
   * (staff: 8 hr work / 24 hr hard). Absent when the class has a single absolute bound.
   */
  readonly absoluteHardSec?: number;
}

export interface SessionPolicy {
  /** UI screen-lock interval (soft re-auth; session stays alive) — staff/auditor only. */
  readonly screenLockSec: number;
  /** Per-class idle/absolute floors (M2 spec §2.2.4). */
  readonly byClass: Readonly<Record<SessionClassName, SessionClassTimeout>>;
}

const MIN = 60;
const HR = 60 * 60;

/**
 * The platform session-timeout floor (M2 spec §2.2.4 / D1). External-collaborator and
 * funeral-home absolutes are the documented defaults (per-tenant configurable above this
 * floor); auditor's absolute is bounded by its engagement window, hence `null`.
 */
export const SESSION_POLICY: SessionPolicy = Object.freeze({
  screenLockSec: 5 * MIN,
  byClass: Object.freeze({
    staff: Object.freeze({ idleSec: 15 * MIN, absoluteSec: 8 * HR, absoluteHardSec: 24 * HR }),
    auditor: Object.freeze({ idleSec: 10 * MIN, absoluteSec: null }),
    external_collaborator: Object.freeze({ idleSec: 15 * MIN, absoluteSec: 8 * HR }),
    funeral_home: Object.freeze({ idleSec: 15 * MIN, absoluteSec: 72 * HR }),
  }),
});
