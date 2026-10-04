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
// Classes absent from `SESSION_POLICY.byClass` (the M31 portal and M19 triage classes) are decided by
// their own module's policy; for them this returns `active` and Better Auth's fixed expiry is the bound.
import { type DbClient, schema } from "@wardenx/db";
import { SESSION_POLICY, type SessionClassName } from "@wardenx/types";
import { and, eq, isNull, lt, or } from "drizzle-orm";

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

function policyFor(sessionClass: string) {
  return Object.hasOwn(SESSION_POLICY.byClass, sessionClass)
    ? SESSION_POLICY.byClass[sessionClass as SessionClassName]
    : null;
}

/** Latest of the timestamps given, ignoring nulls. */
function latest(...dates: (Date | null)[]): number {
  return Math.max(...dates.filter((d): d is Date => d !== null).map((d) => d.getTime()));
}

/** Decide whether a session is still live at `now`. Pure; numbers come only from SESSION_POLICY. */
export function evaluateSessionTimeout(facts: SessionTimeoutFacts, now: Date): SessionTimeoutState {
  const policy = policyFor(facts.sessionClass);
  if (!policy) return "active";
  const nowMs = now.getTime();
  const created = facts.createdAt.getTime();

  if (policy.absoluteSec === null) {
    // Auditor: bounded by its engagement window. No window is not "unbounded" — fail closed.
    if (!facts.engagementEnd || nowMs >= facts.engagementEnd.getTime()) return "expired_absolute";
  } else {
    const workStart = latest(facts.createdAt, facts.lastStepUpAt);
    if (nowMs - workStart > policy.absoluteSec * SEC) return "expired_absolute";
    if (policy.absoluteHardSec !== undefined && nowMs - created > policy.absoluteHardSec * SEC) {
      return "expired_absolute";
    }
  }

  const lastSeen = latest(facts.createdAt, facts.lastActivityAt);
  if (nowMs - lastSeen > policy.idleSec * SEC) return "expired_idle";
  return "active";
}

/** The longest fixed absolute across the policy — the Better Auth cookie/row lifetime must cover it. */
export const SESSION_MAX_ABSOLUTE_SEC = Math.max(
  ...Object.values(SESSION_POLICY.byClass).flatMap((p) =>
    [p.absoluteSec, p.absoluteHardSec].filter((v): v is number => typeof v === "number"),
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
