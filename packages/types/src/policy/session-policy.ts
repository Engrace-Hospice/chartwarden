// @chartwarden/types · policy — the single `SESSION_POLICY` timeout constant (M2-T04; M2
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
//
// `byClass` covers EVERY `session_class` member — M2's four plus the M31 portal and M19
// triage classes that share the same Better Auth instance and the same server enforcer
// (packages/auth `evaluateSessionTimeout`). A class missing here fails CLOSED there; the
// `Record<SessionClassName, …>` type plus an exhaustiveness test against the pgEnum keep
// the two in step.

/** Every session class — mirrors the `session_class` pgEnum / `SESSION_CLASSES`. */
export type SessionClassName =
  | "staff"
  | "auditor"
  | "external_collaborator"
  | "funeral_home"
  | "patient_portal"
  | "caregiver_portal"
  | "bereaved_portal"
  | "external_triage_vendor"
  | "external_triage_operator";

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
  /**
   * The session classes the UI screen-lock applies to (M2 §2.2.4 — `screenLockApplies`). Staff and
   * auditor work at a workstation that can be left unattended; external-collaborator / funeral-home
   * are short bounded magic-link windows with no screen-lock. Mirrors `SESSION_CLASS_DESCRIPTORS`
   * (packages/auth) so the browser can gate the lock without importing the auth package.
   */
  readonly screenLockClasses: readonly SessionClassName[];
  /** Per-class idle/absolute floors (M2 spec §2.2.4). */
  readonly byClass: Readonly<Record<SessionClassName, SessionClassTimeout>>;
}

const MIN = 60;
const HR = 60 * 60;

/**
 * M31 §6.4 / §8.1 D3 portal floor: 30-min idle, 8-h hard cap from mint — a step-up never
 * extends it. One floor for all three portal classes (they differ by relationship, not policy).
 */
const PORTAL_TIMEOUT: SessionClassTimeout = Object.freeze({
  idleSec: 30 * MIN,
  absoluteSec: 8 * HR,
});

/**
 * M19 answering-service sessions. The M19 spec names no timeout, so this takes the
 * conservative floor: Security Hardening §5.1.4's 15-min idle for clinical sessions and
 * its 8-h work session as a SINGLE absolute (no step-up renewal toward staff's 24-h hard
 * cap — an external operator gets the tighter rule).
 */
const TRIAGE_TIMEOUT: SessionClassTimeout = Object.freeze({
  idleSec: 15 * MIN,
  absoluteSec: 8 * HR,
});

/**
 * The platform session-timeout floor (M2 spec §2.2.4 / D1). External-collaborator and
 * funeral-home absolutes are the documented defaults (per-tenant configurable above this
 * floor); auditor's absolute is bounded by its engagement window, hence `null`. Only staff
 * declares `absoluteHardSec`, so only staff renews its work window by re-authentication.
 */
export const SESSION_POLICY: SessionPolicy = Object.freeze({
  screenLockSec: 5 * MIN,
  screenLockClasses: Object.freeze(["staff", "auditor"]) as readonly SessionClassName[],
  byClass: Object.freeze({
    staff: Object.freeze({ idleSec: 15 * MIN, absoluteSec: 8 * HR, absoluteHardSec: 24 * HR }),
    auditor: Object.freeze({ idleSec: 10 * MIN, absoluteSec: null }),
    external_collaborator: Object.freeze({ idleSec: 15 * MIN, absoluteSec: 8 * HR }),
    funeral_home: Object.freeze({ idleSec: 15 * MIN, absoluteSec: 72 * HR }),
    patient_portal: PORTAL_TIMEOUT,
    caregiver_portal: PORTAL_TIMEOUT,
    bereaved_portal: PORTAL_TIMEOUT,
    external_triage_vendor: TRIAGE_TIMEOUT,
    external_triage_operator: TRIAGE_TIMEOUT,
  }),
});
