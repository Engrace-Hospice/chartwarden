// apps/backend/src/modules/31-portal/lifecycle/session.ts — M31-T03 (§2.2.1, §2.3, §8.1).
//
// The portal session class (`SESSION_POLICY.portal`, §8.1 D3) as a PURE evaluator: the platform-floor
// timeouts (§6.4), the session-mint scope check (§2.3 — the requested patient must be reachable via an
// active grant on the CURRENT account), idle / hard expiry, the TOTP step-up window, the one-active-patient
// scoping (§8.1 multi-account-same-person), and the no-org-switch invariant.
//
// M2 owns the canonical `SESSION_POLICY` + the session ROW; M31 does not own a `portal_session_context`
// table (the manifest owns exactly three tables — [[m31-portal-telehealth]]). So this is the M31-side
// session *policy + evaluator* the route layer (M31-T07) binds onto the live M2 session per request: facts
// in (minted-at, last-active-at, step-up-at, the account status, the reachable grants), a decision out. No
// clock is captured here — the caller passes `nowMs`, so every decision is reproducible in a unit test.
import type { PatientId, PortalAccessGrantKind, PortalAccountStatus } from "@wardenx/types";
import { requirePortal } from "./errors";

/**
 * §6.4 / §8.1 `SESSION_POLICY.portal` platform-floor timeouts. Tenants may TIGHTEN (shorten) but never
 * loosen — `resolvePortalSessionPolicy` enforces that. Milliseconds so the evaluator does integer math.
 */
export const PORTAL_SESSION_POLICY_FLOOR = {
  /** §6.4 — 30-minute idle window since `last_active_at`. */
  idleTimeoutMs: 30 * 60_000,
  /** §6.4 — 8-hour hard cap since `minted_at`, idle or not. */
  hardTimeoutMs: 8 * 60 * 60_000,
  /** §6.4 / D3 — TOTP step-up is valid for 15 minutes after it is satisfied. */
  stepUpWindowMs: 15 * 60_000,
  /** §8.1 — a portal session may never switch organizations. */
  allowOrgSwitch: false,
} as const;

export type PortalSessionPolicy = {
  readonly idleTimeoutMs: number;
  readonly hardTimeoutMs: number;
  readonly stepUpWindowMs: number;
  readonly allowOrgSwitch: false;
};

/**
 * §6.4 boot-floor resolution: a tenant policy row may only TIGHTEN the three windows (shorter = tighter)
 * and may never turn org-switch on. A loosening value is clamped to the floor rather than accepted — the
 * §6.4 `validatePolicyFloors()` boot check refuses the row outright, but the evaluator is defense-in-depth
 * and never runs a looser window than the floor even if a bad row slipped through.
 */
export function resolvePortalSessionPolicy(tenant?: {
  idleTimeoutMs?: number;
  hardTimeoutMs?: number;
  stepUpWindowMs?: number;
}): PortalSessionPolicy {
  const floor = PORTAL_SESSION_POLICY_FLOOR;
  const tighten = (want: number | undefined, floorMs: number): number =>
    want === undefined ? floorMs : Math.min(want, floorMs);
  return {
    idleTimeoutMs: tighten(tenant?.idleTimeoutMs, floor.idleTimeoutMs),
    hardTimeoutMs: tighten(tenant?.hardTimeoutMs, floor.hardTimeoutMs),
    stepUpWindowMs: tighten(tenant?.stepUpWindowMs, floor.stepUpWindowMs),
    allowOrgSwitch: false,
  };
}

/** An active grant on the current account, as the session evaluator reads it (the reachable-patient set). */
export interface SessionReachableGrant {
  readonly patientId: PatientId;
  readonly grantKind: PortalAccessGrantKind;
  /** True once the grant is revoked — a revoked grant makes its patient unreachable mid-session (§2.3 D5). */
  readonly revoked: boolean;
}

/** The facts a session-mint decision reads. */
export interface SessionMintInput {
  readonly accountStatus: PortalAccountStatus;
  readonly requestedPatientId: PatientId;
  readonly reachableGrants: readonly SessionReachableGrant[];
}

/** A minted portal session context (the runtime shape the route layer pins onto the M2 session, M31-T07). */
export interface PortalSessionContext {
  readonly orgId: string;
  readonly portalAccountId: string;
  readonly activePatientId: PatientId;
  readonly activeGrantKind: PortalAccessGrantKind;
  readonly mintedAtMs: number;
  readonly lastActiveAtMs: number;
  /** Ms of the last satisfied TOTP step-up, or null if none this session (§8.1 D3). */
  readonly stepUpAtMs: number | null;
}

/**
 * §2.3 — mint a portal session context scoped to exactly one patient. The account must be usable
 * (`active`/`bereaved`) and the requested patient must be reachable via a NON-revoked grant on this
 * account (§8.1: one M2 user holds N accounts, one per relationship; a session reaches only the current
 * account's patients). Fails CLOSED — an unreachable patient is a 403, indistinguishable from "no such
 * grant", so a caregiver cannot probe which patients another account can reach.
 */
export function mintPortalSession(
  input: SessionMintInput,
  ctx: { orgId: string; portalAccountId: string; nowMs: number },
): PortalSessionContext {
  requirePortal(
    input.accountStatus === "active" || input.accountStatus === "bereaved",
    "SESSION_ACCOUNT_NOT_ACTIVE",
    `portal account is '${input.accountStatus}'; only an active or bereaved account may mint a session`,
  );
  const grant = input.reachableGrants.find(
    (g) => g.patientId === input.requestedPatientId && !g.revoked,
  );
  requirePortal(
    grant !== undefined,
    "SESSION_PATIENT_UNREACHABLE",
    "requested patient is not reachable via an active grant on this portal account",
  );
  return {
    orgId: ctx.orgId,
    portalAccountId: ctx.portalAccountId,
    activePatientId: input.requestedPatientId,
    activeGrantKind: grant.grantKind,
    mintedAtMs: ctx.nowMs,
    lastActiveAtMs: ctx.nowMs,
    stepUpAtMs: null,
  };
}

/** Why a session is no longer valid, or `null` if it still is. */
export type SessionExpiry = "idle_expired" | "hard_expired" | null;

/** §8.1 — the idle / hard-cap decision, PURE. Idle is checked from `last_active_at`, hard from `minted_at`. */
export function evaluateSessionExpiry(
  session: Pick<PortalSessionContext, "mintedAtMs" | "lastActiveAtMs">,
  policy: PortalSessionPolicy,
  nowMs: number,
): SessionExpiry {
  if (nowMs - session.mintedAtMs >= policy.hardTimeoutMs) return "hard_expired";
  if (nowMs - session.lastActiveAtMs >= policy.idleTimeoutMs) return "idle_expired";
  return null;
}

/** §8.1 — throwing form used on every request touch (route layer, M31-T07). */
export function assertSessionLive(
  session: Pick<PortalSessionContext, "mintedAtMs" | "lastActiveAtMs">,
  policy: PortalSessionPolicy,
  nowMs: number,
): void {
  const expiry = evaluateSessionExpiry(session, policy, nowMs);
  requirePortal(expiry !== "hard_expired", "SESSION_HARD_EXPIRED", "portal session hard-cap reached");
  requirePortal(expiry !== "idle_expired", "SESSION_IDLE_EXPIRED", "portal session idle-timed-out");
}

/** Advance `last_active_at` on a live request touch (the route layer persists this, M31-T07). */
export function touchSession(
  session: PortalSessionContext,
  nowMs: number,
): PortalSessionContext {
  return { ...session, lastActiveAtMs: nowMs };
}

/** §8.1 D3 — whether the session's TOTP step-up is fresh enough for a step-up-required action. */
export function isStepUpFresh(
  session: Pick<PortalSessionContext, "stepUpAtMs">,
  policy: PortalSessionPolicy,
  nowMs: number,
): boolean {
  return session.stepUpAtMs !== null && nowMs - session.stepUpAtMs < policy.stepUpWindowMs;
}

/** §8.1 D3 — throwing gate for a step-up-required route (email/phone change, recording playback). */
export function assertStepUpFresh(
  session: Pick<PortalSessionContext, "stepUpAtMs">,
  policy: PortalSessionPolicy,
  nowMs: number,
): void {
  requirePortal(
    isStepUpFresh(session, policy, nowMs),
    "SESSION_STEP_UP_REQUIRED",
    "this action requires a recent TOTP step-up",
  );
}

/**
 * §8.1 — switch the session's active patient. Same account, one patient at a time: the new patient must be
 * reachable via a non-revoked grant on the same account, and the org may NOT change (no org-switch). A
 * switch does NOT reset the hard cap or grant a fresh step-up — those stay bound to the original mint.
 */
export function switchActivePatient(
  session: PortalSessionContext,
  input: SessionMintInput,
  nowMs: number,
): PortalSessionContext {
  const grant = input.reachableGrants.find(
    (g) => g.patientId === input.requestedPatientId && !g.revoked,
  );
  requirePortal(
    grant !== undefined,
    "SESSION_PATIENT_UNREACHABLE",
    "requested patient is not reachable via an active grant on this portal account",
  );
  return {
    ...session,
    activePatientId: input.requestedPatientId,
    activeGrantKind: grant.grantKind,
    lastActiveAtMs: nowMs,
  };
}

/** §8.1 — refuse a request whose org differs from the session's pinned org (no org-switch). */
export function assertNoOrgSwitch(
  session: Pick<PortalSessionContext, "orgId">,
  requestOrgId: string,
): void {
  requirePortal(
    session.orgId === requestOrgId,
    "SESSION_ORG_SWITCH_FORBIDDEN",
    "a portal session may not switch organizations",
  );
}
