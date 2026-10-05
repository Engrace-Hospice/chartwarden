// @wardenx/auth · identity — GAP-002: server-side session timeouts (M2 §2.2.4, D1; HIPAA
// §164.312(a)(2)(iii) automatic logoff).
//
// `SESSION_POLICY` declared every class's idle/absolute bound but nothing on the server read it — only
// the client screen-lock did — so Better Auth's 7-day rolling default was the real lifetime of a staff
// session. This module is the server reader: a PURE decision over the session row's timestamps, plus a
// DB enforcer the authenticate hook calls on every request. An expired session row is deleted, so it is
// terminal (`expired_idle` / `expired_absolute` → [*] in the §2.2.4 state machine) and cannot be revived
// by a later request inside some other window.
//
// Staff carries two absolutes ("8 hr work / 24 hr hard"). The 8-h work window runs from the most recent
// authentication — sign-in (`created_at`) or a step-up re-authentication (`last_step_up_at`) — and the
// 24-h hard cap from `created_at` alone, so re-authenticating can keep a shift going but never past 24 h.
//
// Every other class carries ONE absolute, measured from `created_at` — a re-authentication does not
// extend it (M31 §6.4: "8-hour hard cap since minted_at, idle or not").
//
// The M31 portal and M19 triage classes share this Better Auth instance and this hook (M31 binds its class
// onto the Better-Auth-minted row, portal-session-binder.ts), but `SESSION_POLICY.byClass` (packages/types)
// lists only M2's four classes. Their floors are declared here (`EXTENDED_CLASS_POLICY`), so no session
// class is left without a server-side idle timeout; a class with no policy at all fails CLOSED.
//
// AUDITOR vs. THE OUTER CAP. M2 §2.2.4 bounds an auditor session "by engagement_end", and that is what
// this decision enforces. Better Auth's fixed `expiresIn` (SESSION_MAX_ABSOLUTE_SEC, 72 h) is a second,
// outer bound on every row, so an auditor session lasts until min(engagement_end, created_at + 72 h).
// That is deliberate, not an oversight: "bounded by engagement_end" is an upper bound, not a promised
// lifetime; with a 10-min idle the 72-h cap is reachable only by uninterrupted activity for three days;
// and engagement access is per-session (a new magic-link sign-in inside the window starts a new session,
// §7.7), so an engagement longer than 72 h is served by several sessions, never cut short of its window.
import { type DbClient, schema } from "@wardenx/db";
import { SESSION_POLICY, type SessionClassName, type SessionClassTimeout } from "@wardenx/types";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { PORTAL_SESSION_CLASSES, VENDOR_SESSION_CLASSES } from "./session-classes";

/** `revoked`: the row vanished between the snapshot read and this check (sign-out, offboard). */
export type SessionTimeoutState = "active" | "expired_idle" | "expired_absolute" | "revoked";

/** The session-row facts the decision reads. */
export interface SessionTimeoutFacts {
  readonly sessionClass: string;
  readonly createdAt: Date;
  /** Throttled last-request stamp; null until the first touch (falls back to `createdAt`). */
  readonly lastActivityAt: Date | null;
  readonly lastStepUpAt: Date | null;
  readonly engagementEnd: Date | null;
}

const SEC = 1000;
const MIN_SEC = 60;
const HR_SEC = 60 * MIN_SEC;

/** M31 §6.4 / §8.1 D3 portal floor: 30-min idle, 8-h hard from mint (= M31 `PORTAL_SESSION_POLICY_FLOOR`). */
const PORTAL_TIMEOUT: SessionClassTimeout = Object.freeze({
  idleSec: 30 * MIN_SEC,
  absoluteSec: 8 * HR_SEC,
});

/**
 * M19 answering-service sessions. The M19 spec names no timeout, so this takes the conservative floor:
 * Security Hardening §5.1.4's 15-min idle for clinical sessions, and its 8-h work session as a SINGLE
 * absolute (no step-up renewal toward the staff 24-h hard cap — an external operator gets the tighter rule).
 */
const VENDOR_TIMEOUT: SessionClassTimeout = Object.freeze({
  idleSec: 15 * MIN_SEC,
  absoluteSec: 8 * HR_SEC,
});

/** Floors for the session classes `SESSION_POLICY.byClass` does not list (see the header). */
export const EXTENDED_CLASS_POLICY: Readonly<Record<string, SessionClassTimeout>> = Object.freeze(
  Object.fromEntries([
    ...PORTAL_SESSION_CLASSES.map((c) => [c, PORTAL_TIMEOUT] as const),
    ...VENDOR_SESSION_CLASSES.map((c) => [c, VENDOR_TIMEOUT] as const),
  ]),
);

function policyFor(sessionClass: string): SessionClassTimeout | null {
  if (Object.hasOwn(SESSION_POLICY.byClass, sessionClass)) {
    return SESSION_POLICY.byClass[sessionClass as SessionClassName];
  }
  return Object.hasOwn(EXTENDED_CLASS_POLICY, sessionClass)
    ? (EXTENDED_CLASS_POLICY[sessionClass] ?? null)
    : null;
}

/** Latest of the timestamps given, ignoring nulls. */
function latest(...dates: (Date | null)[]): number {
  return Math.max(...dates.filter((d): d is Date => d !== null).map((d) => d.getTime()));
}

/** Decide whether a session is still live at `now`. Pure; numbers come only from SESSION_POLICY. */
export function evaluateSessionTimeout(facts: SessionTimeoutFacts, now: Date): SessionTimeoutState {
  const policy = policyFor(facts.sessionClass);
  // A class with no timeout policy is not "unbounded" — fail closed (the enum is closed, so this is
  // reachable only by a class added to `session_class` without a policy entry).
  if (!policy) return "expired_absolute";
  const nowMs = now.getTime();
  const created = facts.createdAt.getTime();

  if (policy.absoluteSec === null) {
    // Auditor: bounded by its engagement window. No window is not "unbounded" — fail closed.
    if (!facts.engagementEnd || nowMs >= facts.engagementEnd.getTime()) return "expired_absolute";
  } else if (policy.absoluteHardSec !== undefined) {
    // Two absolutes (staff): the work window renews on re-authentication, the hard cap never does.
    const workStart = latest(facts.createdAt, facts.lastStepUpAt);
    if (nowMs - workStart > policy.absoluteSec * SEC) return "expired_absolute";
    if (nowMs - created > policy.absoluteHardSec * SEC) return "expired_absolute";
  } else if (nowMs - created > policy.absoluteSec * SEC) {
    return "expired_absolute";
  }

  const lastSeen = latest(facts.createdAt, facts.lastActivityAt);
  if (nowMs - lastSeen > policy.idleSec * SEC) return "expired_idle";
  return "active";
}

/**
 * The longest fixed absolute across every class — the Better Auth cookie/row lifetime must cover it.
 * Auditor (`absoluteSec: null`) contributes nothing; see the header for why the cap still bounds it.
 */
export const SESSION_MAX_ABSOLUTE_SEC = Math.max(
  ...[...Object.values(SESSION_POLICY.byClass), ...Object.values(EXTENDED_CLASS_POLICY)].flatMap(
    (p) => [p.absoluteSec, p.absoluteHardSec].filter((v): v is number => typeof v === "number"),
  ),
);

/** Write `last_activity_at` at most this often per session (one UPDATE per minute, not per request). */
export const SESSION_ACTIVITY_TOUCH_SEC = 60;

export interface SessionEnforceOptions {
  readonly now?: Date;
  /**
   * false for a request the user did not cause (a timer poll marked `x-wardenx-background: 1`): the
   * timeout is still checked, but the request does not count as activity. Default true.
   */
  readonly recordActivity?: boolean;
}

export interface SessionTimeoutEnforcer {
  /** Evaluate the session; on expiry delete it, otherwise record activity. Missing row → `revoked`. */
  enforce(sessionId: string, opts?: SessionEnforceOptions): Promise<SessionTimeoutState>;
}

/**
 * DB-backed enforcer over M1's `session` table (un-RLS'd, like the rest of this package's session
 * access). A missing row fails closed (`revoked`) rather than trusting a snapshot read a moment earlier.
 */
export function createDbSessionTimeoutEnforcer(db: DbClient): SessionTimeoutEnforcer {
  const S = schema.sessions;
  return {
    async enforce(sessionId, { now = new Date(), recordActivity = true } = {}) {
      const [row] = await db
        .select({
          sessionClass: S.sessionClass,
          createdAt: S.createdAt,
          lastActivityAt: S.lastActivityAt,
          lastStepUpAt: S.lastStepUpAt,
          engagementEnd: S.engagementEnd,
        })
        .from(S)
        .where(eq(S.id, sessionId))
        .limit(1);
      if (!row) return "revoked";
      const state = evaluateSessionTimeout(row, now);
      if (state !== "active") {
        await db.delete(S).where(eq(S.id, sessionId));
        return state;
      }
      if (!recordActivity) return "active";
      const touchBefore = new Date(now.getTime() - SESSION_ACTIVITY_TOUCH_SEC * SEC);
      await db
        .update(S)
        .set({ lastActivityAt: now })
        .where(
          and(eq(S.id, sessionId), or(isNull(S.lastActivityAt), lt(S.lastActivityAt, touchBefore))),
        );
      return "active";
    },
  };
}
