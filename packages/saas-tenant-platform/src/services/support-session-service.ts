// @wardenx/saas-tenant-platform · services — the support-session service (M34 §3.6, §7.4; D8/D16/D21).
//
// The WITH-consent break-glass *variant* (M34-F01 / D21): a tenant compliance_officer files a
// `support_consent_grant` (scope + ≤72h expiry — the repo + the §3.6 CHECK enforce that); a DISTINCT
// platform-ops actor opens a `support_session` against it (`expires_at = LEAST(grant.expires_at,
// started_at + 8h)`, §7.4 step 3); a PHI write window is opened by a fresh step-up (`elevate`, §7.4
// step 5); and the close-sweep (or grant revocation / manual close) ends the session at `expires_at`
// (§7.4 step 6). The without-consent EMERGENCY path stays in M2/M3 break-glass — this service is the
// consent-on-file half (D21): even WITH a session, every PHI access still traverses M2/M3 break-glass
// and audits at `severity=critical` with `actor_kind='platform_ops_via_support_session'` (the audit
// middleware reads `TenantSupportSessionProvider.isActorInSupportSession` at every PHI read/write; this
// service never relaxes that — it only records the consent envelope the surveyor query joins through).
//
// PURE ORCHESTRATION over injected ports (the M40 `runNppesNightlyDelta` / M11 lifecycle precedent):
// the repository is one port; the outbox publish, the M4 severity=critical audit emit, the M36 alert
// fan-out, and the clock are ports the SERVICE/route/worker layer binds at boot (no schema/cross-module
// import edge from this package — M34 `dependsOn` stays `[1,2,3,4,36]`). The DISTINCT-ACTOR rule (D16)
// is enforced HERE as defense-in-depth ALONGSIDE the §4.5 `support_session_actor_distinct_from_grantor`
// ABAC predicate (apps/backend/…/abac-predicates.ts) — the grantor lives in a different row than the
// session actor, so it cannot be a DB CHECK; two independent layers must both deny a self-grant.
//
// The three `m34.support_session.*` outbox names are pinned as constants until the backend wiring phase
// adopts the §4.9 `M34EventName` catalog verbatim (events-by-m34.ts already declares the three payloads).
import { ChartWardenError } from "@wardenx/types";
import type { SupportRepository } from "../repositories/support";

/** The §7.4 hard ceiling on a support-session window: a session never outlives `started_at + 8h`, even
 *  if the grant's own ≤72h expiry is further out (`expires_at = LEAST(grant.expires_at, +8h)`, step 3). */
export const SUPPORT_SESSION_MAX_DURATION_MS = 8 * 60 * 60 * 1000;

/** The §7.4 step-5 PHI-write elevation window (passkey-recent-2min step-up opens a short write window). */
export const SUPPORT_SESSION_ELEVATION_WINDOW_MS = 2 * 60 * 1000;

/** The `actor_kind` every PHI access inside a support session is audited under (§7.4 step 4 / §7.4 acc.). */
export const SUPPORT_SESSION_ACTOR_KIND = "platform_ops_via_support_session" as const;

/** The three `m34.support_session.*` outbox event names this service emits (§4.9 catalog, pinned here
 *  until the backend `M34EventName` type lands — adopt verbatim there; events-by-m34.ts has the payloads). */
export const M34_SUPPORT_SESSION_EVENTS = [
  "m34.support_session.started",
  "m34.support_session.elevated",
  "m34.support_session.expired",
] as const;

/** One `m34.support_session.*` outbox event name. */
export type M34SupportSessionEvent = (typeof M34_SUPPORT_SESSION_EVENTS)[number];

/** How a support session ended (`support_session.close_reason`, §3.6). `expired` is the close-sweep's. */
export type SupportSessionCloseReason =
  | "manual"
  | "expired"
  | "grant_revoked"
  | "forced_terminated";

// ── failure-code catalog (the M34 lifecycle-errors precedent — ChartWardenError envelope, precise codes) ──

/** The support-session failure-code catalog → canonical HTTP status (the route reuses these verbatim). */
export const M34_SUPPORT_SESSION_ERROR_STATUS = {
  /** §7.4 step 3 — the grant id resolves to no row (or a cross-tenant row RLS hid). */
  SUPPORT_GRANT_NOT_FOUND: 404,
  /** §7.4 step 3 — the grant is revoked or already past `expires_at`; no session may open against it. */
  SUPPORT_GRANT_INACTIVE: 409,
  /** §7.4 step 3 / D16 — the session-start actor IS the grantor; a self-grant is refused (defense in depth). */
  SUPPORT_SESSION_ACTOR_NOT_DISTINCT: 403,
  /** §7.4 step 5 — the session is already closed (or expired); it cannot be elevated. */
  SUPPORT_SESSION_NOT_OPEN: 409,
  /** §7.4 step 4a / M34-F13 — elevation is refused for a Part 2-heightened session (read-only regardless). */
  SUPPORT_SESSION_PART_TWO_READ_ONLY: 403,
} as const;

/** A machine-readable support-session failure code (§7.4). */
export type M34SupportSessionErrorCode = keyof typeof M34_SUPPORT_SESSION_ERROR_STATUS;

/** A guard/validation failure in the support-session domain — carries the precise `code` for the UI;
 *  the M1 Fastify error handler maps `statusCode` to the HTTP response (the `TenantLifecycleError` shape). */
export class SupportSessionError extends ChartWardenError {
  constructor(code: M34SupportSessionErrorCode, message: string) {
    super(code, message, M34_SUPPORT_SESSION_ERROR_STATUS[code]);
    this.name = "SupportSessionError";
  }
}

function require_(
  condition: boolean,
  code: M34SupportSessionErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new SupportSessionError(code, message);
}

// ── ports the service composes (bound by the backend service/worker layer at boot) ───────────────────

/** A `severity=critical` M4 audit emit (§7.4 / §8.2). The service hands the audit row's shape; the M4
 *  audit adapter persists it on the chain. `actorKind='platform_ops_via_support_session'` always —
 *  this is the consent-on-file break-glass marker the surveyor query (§7.4 acc.) selects on. */
export interface SupportSessionAuditPort {
  emitCriticalAudit(entry: {
    readonly action: string;
    readonly organizationId: string;
    readonly actorMembershipId: string;
    readonly actorKind: typeof SUPPORT_SESSION_ACTOR_KIND;
    readonly supportSessionId: string;
    readonly supportConsentGrantId: string;
    readonly patientId?: string | null;
    readonly context?: Record<string, unknown>;
  }): Promise<void>;
}

/** The in-transaction outbox publish (§2.6 — the mutation + the event commit atomically; "DB updated but
 *  the event never went out" is closed structurally). The dispatcher validates the payload against
 *  events-by-m34.ts. The service names the event + payload; the port writes the outbox row in the tx. */
export interface SupportSessionOutboxPort {
  publish(event: M34SupportSessionEvent, payload: Record<string, unknown>): Promise<void>;
}

/** The M36 alert fan-out (PHI-sanitized) the §7.4 grantor-notification rules consume. The audience/
 *  PHI-sanitization wrapper is M36's; the service names the rule key + the grantor membership to notify. */
export interface SupportSessionAlertPort {
  emitAlert(input: {
    readonly alertKey: string;
    readonly organizationId: string;
    readonly tenantAccountId: string;
    readonly grantorMembershipId: string;
    readonly context?: Record<string, unknown>;
  }): Promise<void>;
}

/** Injected clock (deterministic effects — the `+8h` ceiling, the elevation window, the sweep cutoff).
 *  Mirrors the `now()` port in `runNppesNightlyDelta` so a run is reproducible/assertable. */
export type NowPort = () => Date;

/** The dependency bundle the support-session service composes (repository + the four side-effect ports). */
export interface SupportSessionServiceDeps {
  readonly repo: SupportRepository;
  readonly audit: SupportSessionAuditPort;
  readonly outbox: SupportSessionOutboxPort;
  readonly alerts: SupportSessionAlertPort;
  readonly now: NowPort;
}

// ── start (§7.4 step 3): distinct-actor (D16) + LEAST(grant.expires_at, +8h) + critical audit + alert ──

/** What a caller must supply to open a session (the route binds these off the verified request). */
export interface StartSupportSessionInput {
  /** The tenant org the session opens into (`support_session.organization_id`, the RLS spine). */
  readonly organizationId: string;
  /** The `support_consent_grant` the platform-ops actor opens against (§7.4 step 3 `grant_id`). */
  readonly supportConsentGrantId: string;
  /** The platform-ops actor (M1 membership). MUST differ from the grant's grantor (D16). */
  readonly actorMembershipId: string;
  /** Optional client IP recorded on the opening `support_session_event` (forensics, §7.4 acc.). */
  readonly actorIp?: string | null;
}

/**
 * Open a support session against a consent grant (§7.4 step 3). Enforces:
 *   - the grant exists and is ACTIVE (unrevoked, `expires_at > now`) — else `SUPPORT_GRANT_*`;
 *   - the DISTINCT-ACTOR rule (D16) — the session actor MUST differ from the grant's grantor
 *     (defense-in-depth alongside the §4.5 `support_session_actor_distinct_from_grantor` ABAC predicate);
 *   - the §7.4-step-3 window ceiling `expires_at = LEAST(grant.expires_at, started_at + 8h)`.
 * On success: inserts the session, appends the `session.start` ledger event, emits the critical M4 audit
 * (`actor_kind='platform_ops_via_support_session'`), publishes `m34.support_session.started`, and fires the
 * M36 grantor alert. The caller runs this inside the org-context tx the route opened (`withOrgContext`).
 */
export async function startSupportSession(
  deps: SupportSessionServiceDeps,
  input: StartSupportSessionInput,
): Promise<{ sessionId: string; expiresAt: Date }> {
  const grant = await deps.repo.findConsentGrantById(input.supportConsentGrantId);
  require_(grant !== null, "SUPPORT_GRANT_NOT_FOUND", "support_consent_grant not found");

  const now = deps.now();
  const grantActive = grant.revokedAt === null && grant.expiresAt.getTime() > now.getTime();
  require_(grantActive, "SUPPORT_GRANT_INACTIVE", "the consent grant is revoked or expired");

  // D16 — defense-in-depth: the consenting tenant admin cannot be the platform-ops actor (the §4.5 ABAC
  // predicate is the first line; this is the second, so a route that bypassed ABAC still cannot self-grant).
  require_(
    grant.grantorMembershipId !== input.actorMembershipId,
    "SUPPORT_SESSION_ACTOR_NOT_DISTINCT",
    "the support-session actor must differ from the consent-grant grantor (D16)",
  );

  // §7.4 step 3 — `expires_at = LEAST(grant.expires_at, started_at + 8h)`. The session never outlives the
  // 8h ceiling even when the grant's ≤72h window is further out.
  const ceiling = new Date(now.getTime() + SUPPORT_SESSION_MAX_DURATION_MS);
  const expiresAt = grant.expiresAt.getTime() < ceiling.getTime() ? grant.expiresAt : ceiling;

  const session = await deps.repo.createSession({
    organizationId: input.organizationId,
    supportConsentGrantId: grant.id,
    actorMembershipId: input.actorMembershipId,
    startedAt: now,
    expiresAt,
  });

  // The opening ledger row (one `support_session_event` per session action; the surveyor trail, §7.4 acc.).
  await deps.repo.appendSessionEvent({
    organizationId: input.organizationId,
    supportSessionId: session.id,
    eventKind: "session.start",
    occurredAt: now,
    actorIp: input.actorIp ?? null,
    context: { scope: grant.scope },
  });

  // Every support-session action is audited at severity=critical with the break-glass actor_kind (D21).
  await deps.audit.emitCriticalAudit({
    action: "support_session.started",
    organizationId: input.organizationId,
    actorMembershipId: input.actorMembershipId,
    actorKind: SUPPORT_SESSION_ACTOR_KIND,
    supportSessionId: session.id,
    supportConsentGrantId: grant.id,
    context: { scope: grant.scope, expiresAt: expiresAt.toISOString() },
  });

  await deps.outbox.publish("m34.support_session.started", {
    sessionId: session.id,
    grantId: grant.id,
    tenantAccountId: grant.tenantAccountId,
    actorMembershipId: input.actorMembershipId,
    scope: grant.scope,
    startedAt: now.toISOString(),
  });

  // §7.4 step 2/3 — M36 warns the grantor compliance officer that a break-glass session is now open.
  await deps.alerts.emitAlert({
    alertKey: "support_session.started",
    organizationId: input.organizationId,
    tenantAccountId: grant.tenantAccountId,
    grantorMembershipId: grant.grantorMembershipId,
    context: { sessionId: session.id, actorMembershipId: input.actorMembershipId },
  });

  return { sessionId: session.id, expiresAt };
}

// ── elevate (§7.4 step 5): open a PHI-write window; refuse for Part 2-heightened sessions (step 4a) ──

/** What a caller supplies to elevate a session for PHI write (the route binds these post step-up). */
export interface ElevateSupportSessionInput {
  readonly organizationId: string;
  readonly supportSessionId: string;
  /** The platform-ops actor performing the fresh step-up (must own the session — route-enforced). */
  readonly actorMembershipId: string;
  /** §7.4 step 4a / M34-F13 — true when the session touches an M39 Part 2 patient; elevation is REFUSED
   *  (those sessions are read-only regardless of step-up). Resolved upstream by the route (M39 designation). */
  readonly isPartTwoHeightened?: boolean;
  readonly actorIp?: string | null;
}

/**
 * Elevate an open support session for PHI write (§7.4 step 5 — passkey-recent-2min step-up already
 * verified upstream). Refuses if the session is not open (`SUPPORT_SESSION_NOT_OPEN`) or is Part
 * 2-heightened (`SUPPORT_SESSION_PART_TWO_READ_ONLY`, §7.4 step 4a — Part 2 support is read-only). On
 * success: appends the `session.elevate` ledger event, emits the critical M4 audit, publishes
 * `m34.support_session.elevated`, and M36-alerts the grantor that a write window opened. Returns the
 * window's `elevationExpiresAt` (the route enforces PHI-write only within it).
 */
export async function elevateSupportSession(
  deps: SupportSessionServiceDeps,
  input: ElevateSupportSessionInput,
): Promise<{ elevationExpiresAt: Date }> {
  const session = await deps.repo.findSessionById(input.supportSessionId);
  require_(session !== null, "SUPPORT_SESSION_NOT_OPEN", "support_session not found");

  const now = deps.now();
  const open = session.closedAt === null && session.expiresAt.getTime() > now.getTime();
  require_(open, "SUPPORT_SESSION_NOT_OPEN", "the support session is closed or expired");

  // §7.4 step 4a / M34-F13 — elevation is refused outright for Part 2-heightened sessions (read-only).
  require_(
    input.isPartTwoHeightened !== true,
    "SUPPORT_SESSION_PART_TWO_READ_ONLY",
    "elevation is refused for Part 2-heightened support sessions (read-only, §7.4 step 4a)",
  );

  const elevationExpiresAt = new Date(now.getTime() + SUPPORT_SESSION_ELEVATION_WINDOW_MS);

  await deps.repo.appendSessionEvent({
    organizationId: input.organizationId,
    supportSessionId: session.id,
    eventKind: "session.elevate",
    occurredAt: now,
    actorIp: input.actorIp ?? null,
    context: { elevationExpiresAt: elevationExpiresAt.toISOString() },
  });

  const grant = await deps.repo.findConsentGrantById(session.supportConsentGrantId);

  await deps.audit.emitCriticalAudit({
    action: "support_session.elevated",
    organizationId: input.organizationId,
    actorMembershipId: input.actorMembershipId,
    actorKind: SUPPORT_SESSION_ACTOR_KIND,
    supportSessionId: session.id,
    supportConsentGrantId: session.supportConsentGrantId,
    context: { elevationExpiresAt: elevationExpiresAt.toISOString() },
  });

  await deps.outbox.publish("m34.support_session.elevated", {
    sessionId: session.id,
    grantId: session.supportConsentGrantId,
    tenantAccountId: grant?.tenantAccountId ?? null,
    actorMembershipId: input.actorMembershipId,
    elevatedAt: now.toISOString(),
    elevationExpiresAt: elevationExpiresAt.toISOString(),
  });

  // §7.4 step 5 — M36 alerts the grantor that a break-glass PHI write window is now open.
  if (grant) {
    await deps.alerts.emitAlert({
      alertKey: "support_session.elevated",
      organizationId: input.organizationId,
      tenantAccountId: grant.tenantAccountId,
      grantorMembershipId: grant.grantorMembershipId,
      context: { sessionId: session.id, elevationExpiresAt: elevationExpiresAt.toISOString() },
    });
  }

  return { elevationExpiresAt };
}

// ── close-sweep (§7.4 step 6): close expired open sessions; emit m34.support_session.expired ──────────

/** One open-session candidate the close-sweep evaluates. The caller (worker) loads these under
 *  `withPlatformContext` — the sweep runs platform-wide (RLS-bypassed) and is a system actor, so the
 *  candidate set is supplied as data (keeping this orchestration pure + cross-tenant capable). */
export interface ExpiredSessionCandidate {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly supportConsentGrantId: string;
  readonly tenantAccountId: string;
  readonly grantorMembershipId: string;
  readonly actorMembershipId: string;
  readonly expiresAt: Date;
}

/** What one sweep run did (the deterministic result the worker logs / the test asserts). */
export interface SupportSessionSweepResult {
  readonly closed: number;
  readonly closedSessionIds: readonly string[];
}

/**
 * Close every support session whose `expires_at <= now` and that is still open (§7.4 step 6). For each:
 * close it with `close_reason='expired'`, append the `session.close` ledger event, emit the critical M4
 * audit, publish `m34.support_session.expired`, and M36-alert the grantor that the break-glass window
 * shut. The candidate set is supplied by the worker (loaded under `withPlatformContext` — the sweep is
 * platform-wide and a system actor); this orchestration is pure + deterministic (sorted by `sessionId`
 * so a partial failure is reproducible). Already-closed candidates are skipped idempotently (§2.6 replay).
 */
export async function closeExpiredSupportSessions(
  deps: SupportSessionServiceDeps,
  candidates: readonly ExpiredSessionCandidate[],
): Promise<SupportSessionSweepResult> {
  const now = deps.now();
  const closedSessionIds: string[] = [];

  // Deterministic order so a mid-sweep failure is reproducible (the M40 nightly-delta discipline).
  const due = candidates
    .filter((c) => c.expiresAt.getTime() <= now.getTime())
    .slice()
    .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));

  for (const candidate of due) {
    // Idempotent: re-fetch and skip if a prior sweep / manual close already closed it (replay-safe).
    const session = await deps.repo.findSessionById(candidate.sessionId);
    if (!session || session.closedAt !== null) continue;

    await deps.repo.closeSession(candidate.sessionId, {
      closedAt: now,
      closeReason: "expired",
    });

    await deps.repo.appendSessionEvent({
      organizationId: candidate.organizationId,
      supportSessionId: candidate.sessionId,
      eventKind: "session.close",
      occurredAt: now,
      context: { closeReason: "expired" },
    });

    await deps.audit.emitCriticalAudit({
      action: "support_session.expired",
      organizationId: candidate.organizationId,
      actorMembershipId: candidate.actorMembershipId,
      actorKind: SUPPORT_SESSION_ACTOR_KIND,
      supportSessionId: candidate.sessionId,
      supportConsentGrantId: candidate.supportConsentGrantId,
      context: { closeReason: "expired" },
    });

    await deps.outbox.publish("m34.support_session.expired", {
      sessionId: candidate.sessionId,
      grantId: candidate.supportConsentGrantId,
      tenantAccountId: candidate.tenantAccountId,
      closeReason: "expired",
      closedAt: now.toISOString(),
    });

    await deps.alerts.emitAlert({
      alertKey: "support_session.expired",
      organizationId: candidate.organizationId,
      tenantAccountId: candidate.tenantAccountId,
      grantorMembershipId: candidate.grantorMembershipId,
      context: { sessionId: candidate.sessionId, closeReason: "expired" },
    });

    closedSessionIds.push(candidate.sessionId);
  }

  return { closed: closedSessionIds.length, closedSessionIds };
}
