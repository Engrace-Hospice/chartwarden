// @chartwarden/saas-tenant-platform · services — the support-session service (M34 §3.6, §7.4; D8/D16/D21).
//
// The WITH-consent break-glass *variant* (M34-F01 / D21): a tenant member files a
// `support_consent_grant` (scope + ≤72h expiry — the repo + the §3.6 CHECK enforce that); a DISTINCT
// platform-ops actor opens a `support_session` against it (`expires_at = LEAST(grant.expires_at,
// started_at + 8h)`, §7.4 step 3); a PHI write window is opened by a fresh step-up (`elevate`, §7.4
// step 5; refused on the non-PHI `assist` scope); and the close-sweep, a manual close or a grant
// revocation ends the session (§7.4 step 6). The without-consent EMERGENCY path stays in M2/M3
// break-glass — this service is the consent-on-file half (D21): it only records the consent envelope the
// surveyor query joins through; a session authorizes nothing in the platform lane (CW-AC-12 stays the control).
//
// THE ORGANIZATION IS THE GRANT'S, EVERYWHERE (slice 7). A support session is the TENANT's record: its row, its ledger and
// its critical audit are written in the organization of the consent grant it rests on, never in the organization of the
// operator who opened it (an operator's own session organization is the platform's, so a row recorded there could never be
// read by the tenant under row-level security). No function here accepts an organization from its caller.
//
// PURE ORCHESTRATION over injected ports (the M40 `runNppesNightlyDelta` / M11 lifecycle precedent): the repository is one
// port; the outbox publish, the M4 severity=critical audit emit, the M36 alert fan-out, the member-to-user lookup and the
// clock are ports the SERVICE/route/worker layer binds per transaction (no schema/cross-module import edge from this
// package — M34 `dependsOn` stays `[1,2,3,4,36]`). The DISTINCT-ACTOR rule (D16) is enforced HERE as defense-in-depth
// ALONGSIDE the §4.5 `support_session_actor_distinct_from_grantor` ABAC predicate, and at the PERSON level (user id): an
// operator's membership always differs from the tenant member's, so a membership comparison alone could never fail.
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import type { SupportRepository } from "../repositories/support";

/** The §7.4 hard ceiling on a support-session window: a session never outlives `started_at + 8h`, even
 *  if the grant's own ≤72h expiry is further out (`expires_at = LEAST(grant.expires_at, +8h)`, step 3). */
export const SUPPORT_SESSION_MAX_DURATION_MS = 8 * 60 * 60 * 1000;

/** The §7.4 step-5 PHI-write elevation window (passkey-recent-2min step-up opens a short write window). */
export const SUPPORT_SESSION_ELEVATION_WINDOW_MS = 2 * 60 * 1000;

/** Maximum candidates processed by one expiry-sweep transaction. */
export const SUPPORT_SESSION_SWEEP_BATCH_SIZE = 200;

/** The `actor_kind` every PHI access inside a support session is audited under (§7.4 step 4 / §7.4 acc.). */
export const SUPPORT_SESSION_ACTOR_KIND = "platform_ops_via_support_session" as const;

/** The `m34.support_session.*` outbox event names this service emits (§4.9 catalog; events-by-m34.ts has the payloads). */
export const M34_SUPPORT_SESSION_EVENTS = [
  "m34.support_session.started",
  "m34.support_session.elevated",
  "m34.support_session.expired",
] as const;

/** One `m34.support_session.*` outbox event name. */
export type M34SupportSessionEvent = (typeof M34_SUPPORT_SESSION_EVENTS)[number];

/** The `m34.support_consent_grant.*` outbox event names (slice 7: a grant issued, a grant revoked). */
export const M34_SUPPORT_CONSENT_EVENTS = [
  "m34.support_consent_grant.issued",
  "m34.support_consent_grant.revoked",
] as const;

/** One `m34.support_consent_grant.*` outbox event name. */
export type M34SupportConsentEvent = (typeof M34_SUPPORT_CONSENT_EVENTS)[number];

/** Every outbox event name the support ports publish. */
export type M34SupportOutboxEvent = M34SupportSessionEvent | M34SupportConsentEvent;

/** How a support session ended (`support_session.close_reason`, §3.6). `expired` is the close-sweep's. */
export type SupportSessionCloseReason =
  | "manual"
  | "expired"
  | "grant_revoked"
  | "forced_terminated";

/**
 * `support_session.close_reason` is stored as the four values above, but the catalog's `m34.support_session.expired` payload
 * names a manual close `manual_close` (the wire name that was catalogued first). The mapping lives here, once.
 */
const OUTBOX_CLOSE_REASON: Readonly<Record<SupportSessionCloseReason, string>> = {
  manual: "manual_close",
  expired: "expired",
  grant_revoked: "grant_revoked",
  forced_terminated: "forced_terminated",
};

/** The critical audit action each way of ending a session is recorded under. */
const CLOSE_AUDIT_ACTION: Readonly<Record<SupportSessionCloseReason, string>> = {
  manual: "support_session.closed",
  expired: "support_session.expired",
  grant_revoked: "support_session.grant_revoked",
  forced_terminated: "support_session.forced_terminated",
};

/** The grant scope that is non-PHI by construction (an onboarding help request creates only this one). */
export const SUPPORT_ASSIST_SCOPE = "assist" as const;

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
  /** Slice 7 — a session on a non-PHI `assist` grant can never be elevated: it has no PHI to read or write. */
  SUPPORT_SESSION_NON_PHI: 403,
  /** Slice 7 — the grantor may not issue this scope: `assist` needs org_admin or compliance_officer; an organization that is not active may issue only `assist`. */
  SUPPORT_GRANT_SCOPE_NOT_ALLOWED: 403,
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

export function require_(
  condition: boolean,
  code: M34SupportSessionErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new SupportSessionError(code, message);
}

// ── ports the service composes (bound by the backend service/worker layer at boot, once per transaction) ──

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
 *  events-by-m34.ts. The service names the event, the payload and the TENANT's organization (the grant's); the port
 *  writes the outbox row in the transaction it is bound to. */
export interface SupportSessionOutboxPort {
  publish(
    event: M34SupportOutboxEvent,
    payload: Record<string, unknown>,
    organizationId: string,
  ): Promise<void>;
}

/** The M36 alert fan-out (PHI-sanitized). The audience/PHI-sanitization wrapper is M36's; the service names the
 *  `eventType` the seeded alert rules match (`m34.<resource>.<verb>`, alert-rules.ts) and the grantor to notify. Nothing in
 *  `context` names the operator: the alert is shown to tenant members. */
export interface SupportSessionAlertPort {
  emitAlert(input: {
    readonly alertKey: string;
    readonly organizationId: string;
    readonly tenantAccountId: string;
    readonly grantorMembershipId: string;
    readonly context?: Record<string, unknown>;
  }): Promise<void>;
}

/** The member-to-person lookup the person-level D16 check needs (the `membership` table is M2's, so it is a port). */
export interface SupportSessionMemberPort {
  /** The user a membership belongs to, or null when the membership does not exist. */
  userIdOf(membershipId: string): Promise<string | null>;
}

/** Tenant-bound patient existence check used before a patient-scoped consent envelope is stored. */
export interface SupportSessionPatientPort {
  /** True only when every requested id resolves inside `organizationId`; errors must fail closed. */
  allBelongToOrganization(organizationId: string, patientIds: readonly string[]): Promise<boolean>;
}

/** Injected clock (deterministic effects — the `+8h` ceiling, the elevation window, the sweep cutoff).
 *  Mirrors the `now()` port in `runNppesNightlyDelta` so a run is reproducible/assertable. */
export type NowPort = () => Date;

/** The repository methods the support services use (a `Pick` so a unit test fakes exactly these, with no cast). */
export type SupportSessionRepository = Pick<
  SupportRepository,
  | "createConsentGrant"
  | "findConsentGrantById"
  | "findConsentGrantByIdForShare"
  | "markConsentGrantRevoked"
  | "createSession"
  | "findSessionById"
  | "findSessionByIdForUpdate"
  | "closeSessionIfOpen"
  | "listOpenSessionsByGrant"
  | "listSessionIdsClosedAs"
  | "findSummarySessionByGrant"
  | "opsWriteStats"
  | "appendSessionEvent"
>;

/** The dependency bundle the support-session service composes (repository + the side-effect ports). */
export interface SupportSessionServiceDeps {
  readonly repo: SupportSessionRepository;
  readonly audit: SupportSessionAuditPort;
  readonly outbox: SupportSessionOutboxPort;
  readonly alerts: SupportSessionAlertPort;
  readonly members: SupportSessionMemberPort;
  readonly patients: SupportSessionPatientPort;
  readonly now: NowPort;
}

/** An alert a state change owes the grantor, emitted by the caller AFTER its own database work (a rollback after an emit would otherwise leave an alert for something that never happened). */
export type PendingGrantorAlert = Parameters<SupportSessionAlertPort["emitAlert"]>[0];

// ── start (§7.4 step 3): distinct-actor (D16) + LEAST(grant.expires_at, +8h) + critical audit + alert ──

/** What a caller must supply to open a session (the route binds these off the verified request). */
export interface StartSupportSessionInput {
  /** The `support_consent_grant` the platform-ops actor opens against (§7.4 step 3 `grant_id`). The session is recorded in THIS grant's organization. */
  readonly supportConsentGrantId: string;
  /** The platform-ops actor (M1 membership). MUST differ from the grant's grantor (D16). */
  readonly actorMembershipId: string;
  /** The platform-ops actor's user. MUST differ from the grantor's user (the same person holding both a tenant and a platform seat). */
  readonly actorUserId: string;
  /** Optional client IP recorded on the opening `support_session_event` (forensics, §7.4 acc.). */
  readonly actorIp?: string | null;
}

/**
 * Open a support session against a consent grant (§7.4 step 3). Enforces:
 *   - the grant exists and is ACTIVE (unrevoked, `expires_at > now`) — else `SUPPORT_GRANT_*`; the grant row is SHARE-locked,
 *     so a revoke that is committing cannot slip between this check and the insert (the revoke then closes this session);
 *   - the DISTINCT-ACTOR rule (D16) — the session actor MUST differ from the grant's grantor, by membership and by person;
 *   - the §7.4-step-3 window ceiling `expires_at = LEAST(grant.expires_at, started_at + 8h)`.
 * On success: inserts the session in the GRANT's organization, appends the `session.start` ledger event, emits the critical M4
 * audit (`actor_kind='platform_ops_via_support_session'`), publishes `m34.support_session.started`, and fires the M36 grantor
 * alert. The caller runs this inside one transaction.
 */
export async function startSupportSession(
  deps: SupportSessionServiceDeps,
  input: StartSupportSessionInput,
): Promise<{ sessionId: string; expiresAt: Date }> {
  const grant = await deps.repo.findConsentGrantByIdForShare(input.supportConsentGrantId);
  require_(grant !== null, "SUPPORT_GRANT_NOT_FOUND", "support_consent_grant not found");

  const now = deps.now();
  const grantActive = grant.revokedAt === null && grant.expiresAt.getTime() > now.getTime();
  require_(grantActive, "SUPPORT_GRANT_INACTIVE", "the consent grant is revoked or expired");

  // D16 — defense-in-depth: the consenting tenant member cannot be the platform-ops actor (the §4.5 ABAC predicate is the first
  // line; this is the second, so a route that bypassed ABAC still cannot self-grant). Compared by membership AND by person.
  require_(
    grant.grantorMembershipId !== input.actorMembershipId,
    "SUPPORT_SESSION_ACTOR_NOT_DISTINCT",
    "the support-session actor must differ from the consent-grant grantor (D16)",
  );
  const grantorUserId = await deps.members.userIdOf(grant.grantorMembershipId);
  require_(
    grantorUserId !== null && grantorUserId !== input.actorUserId,
    "SUPPORT_SESSION_ACTOR_NOT_DISTINCT",
    "the support-session actor must be a different person from the consent-grant grantor (D16)",
  );

  // §7.4 step 3 — `expires_at = LEAST(grant.expires_at, started_at + 8h)`. The session never outlives the
  // 8h ceiling even when the grant's ≤72h window is further out.
  const ceiling = new Date(now.getTime() + SUPPORT_SESSION_MAX_DURATION_MS);
  const expiresAt = grant.expiresAt.getTime() < ceiling.getTime() ? grant.expiresAt : ceiling;
  const organizationId = grant.organizationId;

  const session = await deps.repo.createSession({
    organizationId,
    supportConsentGrantId: grant.id,
    actorMembershipId: input.actorMembershipId,
    startedAt: now,
    expiresAt,
  });

  // The opening ledger row (one `support_session_event` per session action; the surveyor trail, §7.4 acc.).
  await deps.repo.appendSessionEvent({
    organizationId,
    supportSessionId: session.id,
    eventKind: "session.start",
    occurredAt: now,
    actorIp: input.actorIp ?? null,
    context: { scope: grant.scope },
  });

  // Every support-session action is audited at severity=critical with the break-glass actor_kind (D21).
  await deps.audit.emitCriticalAudit({
    action: "support_session.started",
    organizationId,
    actorMembershipId: input.actorMembershipId,
    actorKind: SUPPORT_SESSION_ACTOR_KIND,
    supportSessionId: session.id,
    supportConsentGrantId: grant.id,
    context: { scope: grant.scope, expiresAt: expiresAt.toISOString() },
  });

  await deps.outbox.publish(
    "m34.support_session.started",
    {
      sessionId: session.id,
      grantId: grant.id,
      tenantAccountId: grant.tenantAccountId,
      scope: grant.scope,
      startedAt: now.toISOString(),
    },
    organizationId,
  );

  // §7.4 step 2/3 — M36 warns the grantor (and the organization's admins) that a support session is now open.
  await deps.alerts.emitAlert({
    alertKey: "m34.support_session.started",
    organizationId,
    tenantAccountId: grant.tenantAccountId,
    grantorMembershipId: grant.grantorMembershipId,
    context: { sessionId: session.id, scope: grant.scope },
  });

  return { sessionId: session.id, expiresAt };
}

// ── elevate (§7.4 step 5): open a PHI-write window; refuse for assist (non-PHI) and Part 2-heightened sessions ──

/** What a caller supplies to elevate a session for PHI write (the route binds these post step-up). */
export interface ElevateSupportSessionInput {
  readonly supportSessionId: string;
  /** The platform-ops actor performing the fresh step-up (must own the session — route-enforced). */
  readonly actorMembershipId: string;
  /** §7.4 step 4a / M34-F13 — true when the session touches an M39 Part 2 patient; elevation is REFUSED
   *  (those sessions are read-only regardless of step-up). Resolved upstream by the route (M39 designation). */
  readonly isPartTwoHeightened?: boolean;
  readonly actorIp?: string | null;
}

/**
 * Elevate an open support session for PHI write (§7.4 step 5 — passkey-recent-2min step-up already verified upstream).
 * Refuses a session on a non-PHI `assist` grant (`SUPPORT_SESSION_NON_PHI`: it has no PHI to read or write), a session that
 * is not open (`SUPPORT_SESSION_NOT_OPEN`) and a Part 2-heightened one (`SUPPORT_SESSION_PART_TWO_READ_ONLY`, §7.4 step 4a).
 * On success: appends the `session.elevate` ledger event, emits the critical M4 audit, publishes `m34.support_session.elevated`,
 * and M36-alerts the grantor that a write window opened. Returns the window's `elevationExpiresAt`.
 */
export async function elevateSupportSession(
  deps: SupportSessionServiceDeps,
  input: ElevateSupportSessionInput,
): Promise<{ elevationExpiresAt: Date }> {
  // Resolve the grant id without taking the session lock, then lock in the same order as revoke:
  // grant first, session second. That avoids a session↔grant deadlock and makes consent revocation
  // serialize before the elevation decision and every effect it records.
  const candidate = await deps.repo.findSessionById(input.supportSessionId);
  require_(candidate !== null, "SUPPORT_SESSION_NOT_OPEN", "support_session not found");
  const grant = await deps.repo.findConsentGrantByIdForShare(candidate.supportConsentGrantId);
  require_(grant !== null, "SUPPORT_GRANT_NOT_FOUND", "support_consent_grant not found");
  const session = await deps.repo.findSessionByIdForUpdate(input.supportSessionId);
  require_(session !== null, "SUPPORT_SESSION_NOT_OPEN", "support_session not found");
  require_(
    session.supportConsentGrantId === grant.id,
    "SUPPORT_SESSION_NOT_OPEN",
    "the support session consent changed while elevation was being authorized",
  );
  require_(
    session.actorMembershipId === input.actorMembershipId,
    "SUPPORT_SESSION_NOT_OPEN",
    "the support session belongs to another operator",
  );

  // Slice 7 — an `assist` grant is non-PHI by construction: there is nothing to elevate for. Judged first, so the answer does not
  // depend on whether the session happens to be open.
  require_(
    grant.scope !== SUPPORT_ASSIST_SCOPE,
    "SUPPORT_SESSION_NON_PHI",
    "a session on an assist (non-PHI) grant cannot be elevated",
  );

  const now = deps.now();
  require_(
    grant.revokedAt === null && grant.expiresAt.getTime() > now.getTime(),
    "SUPPORT_GRANT_INACTIVE",
    "the consent grant is revoked or expired",
  );
  const open = session.closedAt === null && session.expiresAt.getTime() > now.getTime();
  require_(open, "SUPPORT_SESSION_NOT_OPEN", "the support session is closed or expired");

  // §7.4 step 4a / M34-F13 — elevation is refused outright for Part 2-heightened sessions (read-only).
  require_(
    input.isPartTwoHeightened !== true,
    "SUPPORT_SESSION_PART_TWO_READ_ONLY",
    "elevation is refused for Part 2-heightened support sessions (read-only, §7.4 step 4a)",
  );

  const elevationExpiresAt = new Date(now.getTime() + SUPPORT_SESSION_ELEVATION_WINDOW_MS);
  const organizationId = grant.organizationId;

  await deps.repo.appendSessionEvent({
    organizationId,
    supportSessionId: session.id,
    eventKind: "session.elevate",
    occurredAt: now,
    actorIp: input.actorIp ?? null,
    context: { elevationExpiresAt: elevationExpiresAt.toISOString() },
  });

  await deps.audit.emitCriticalAudit({
    action: "support_session.elevated",
    organizationId,
    actorMembershipId: input.actorMembershipId,
    actorKind: SUPPORT_SESSION_ACTOR_KIND,
    supportSessionId: session.id,
    supportConsentGrantId: session.supportConsentGrantId,
    context: { elevationExpiresAt: elevationExpiresAt.toISOString() },
  });

  await deps.outbox.publish(
    "m34.support_session.elevated",
    {
      sessionId: session.id,
      grantId: session.supportConsentGrantId,
      tenantAccountId: grant.tenantAccountId,
      elevatedAt: now.toISOString(),
      elevationExpiresAt: elevationExpiresAt.toISOString(),
    },
    organizationId,
  );

  // §7.4 step 5 — M36 alerts the grantor that a break-glass PHI write window is now open.
  await deps.alerts.emitAlert({
    alertKey: "m34.support_session.elevated",
    organizationId,
    tenantAccountId: grant.tenantAccountId,
    grantorMembershipId: grant.grantorMembershipId,
    context: { sessionId: session.id, elevationExpiresAt: elevationExpiresAt.toISOString() },
  });

  return { elevationExpiresAt };
}

// ── ending a session: the one place a close is written (manual close, the sweep and the revoke cascade share it) ──

/** Everything an ended session's records need; the organization is the GRANT's. */
export interface EndSessionInput {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly supportConsentGrantId: string;
  readonly tenantAccountId: string;
  readonly grantorMembershipId: string;
  /** The operator who owns the session (the critical audit of an expiry or a revoke names them: the break-glass actor). */
  readonly sessionActorMembershipId: string;
  /** Who ended it: the operator on a manual close, otherwise the session's own actor. */
  readonly closedByMembershipId: string;
  readonly reason: SupportSessionCloseReason;
  readonly now: Date;
  readonly actorIp?: string | null;
  /** Extra audit context (ids and codes only). */
  readonly auditContext?: Record<string, unknown>;
}

/**
 * Close one session if it is still open and record it: the `closed_at`/`close_reason` stamp (a guarded UPDATE, so a session
 * already closed is never overwritten), the `session.close` ledger row, the critical audit and `m34.support_session.expired`
 * (closeReason mapped to the catalog's name). Returns the grantor alert it owes, for the caller to emit after its own database
 * work, or `null` when the session was already closed (nothing is written).
 */
export async function endSupportSession(
  deps: SupportSessionServiceDeps,
  input: EndSessionInput,
): Promise<PendingGrantorAlert | null> {
  const closed = await deps.repo.closeSessionIfOpen(input.sessionId, {
    closedAt: input.now,
    closeReason: input.reason,
  });
  if (closed === null) return null;

  // A grant-revoked close is written by the database transition trigger. Tenant callers have no
  // INSERT privilege on the ledger, so the evidence cannot be supplied or forged by request data.
  if (input.reason !== "grant_revoked") {
    await deps.repo.appendSessionEvent({
      organizationId: input.organizationId,
      supportSessionId: input.sessionId,
      eventKind: "session.close",
      occurredAt: input.now,
      actorIp: input.actorIp ?? null,
      context: { closeReason: input.reason },
    });
  }

  await deps.audit.emitCriticalAudit({
    action: CLOSE_AUDIT_ACTION[input.reason],
    organizationId: input.organizationId,
    actorMembershipId: input.closedByMembershipId,
    actorKind: SUPPORT_SESSION_ACTOR_KIND,
    supportSessionId: input.sessionId,
    supportConsentGrantId: input.supportConsentGrantId,
    context: { closeReason: input.reason, ...(input.auditContext ?? {}) },
  });

  await deps.outbox.publish(
    "m34.support_session.expired",
    {
      sessionId: input.sessionId,
      grantId: input.supportConsentGrantId,
      tenantAccountId: input.tenantAccountId,
      closeReason: OUTBOX_CLOSE_REASON[input.reason],
      closedAt: input.now.toISOString(),
    },
    input.organizationId,
  );

  return {
    alertKey: "m34.support_session.expired",
    organizationId: input.organizationId,
    tenantAccountId: input.tenantAccountId,
    grantorMembershipId: input.grantorMembershipId,
    context: { sessionId: input.sessionId, closeReason: input.reason },
  };
}

// ── manual close (§7.4): the operator ends a session ──────────────────────────────────────────────────

/** What a caller supplies to end a session by hand (the platform route binds these off the verified request). */
export interface CloseSupportSessionInput {
  readonly supportSessionId: string;
  /** The platform-ops actor closing the session. */
  readonly actorMembershipId: string;
  readonly actorIp?: string | null;
}

/**
 * End a session by hand (`close_reason = manual`): the close stamp, the `session.close` ledger row, the critical audit,
 * `m34.support_session.expired` (closeReason `manual_close`) and the grantor alert. Idempotent: a session already closed
 * answers the reason it was closed with and writes nothing. 404 for a session that does not exist.
 */
export async function closeSupportSession(
  deps: SupportSessionServiceDeps,
  input: CloseSupportSessionInput,
): Promise<{ sessionId: string; closeReason: SupportSessionCloseReason; alreadyClosed: boolean }> {
  const session = await deps.repo.findSessionById(input.supportSessionId);
  if (!session) throw new NotFoundError("support session");
  if (session.closedAt !== null) {
    return {
      sessionId: session.id,
      closeReason: (session.closeReason as SupportSessionCloseReason | null) ?? "manual",
      alreadyClosed: true,
    };
  }
  const grant = await deps.repo.findConsentGrantById(session.supportConsentGrantId);
  require_(grant !== null, "SUPPORT_GRANT_NOT_FOUND", "support_consent_grant not found");

  const alert = await endSupportSession(deps, {
    sessionId: session.id,
    organizationId: grant.organizationId,
    supportConsentGrantId: grant.id,
    tenantAccountId: grant.tenantAccountId,
    grantorMembershipId: grant.grantorMembershipId,
    sessionActorMembershipId: session.actorMembershipId,
    closedByMembershipId: input.actorMembershipId,
    reason: "manual",
    now: deps.now(),
    actorIp: input.actorIp ?? null,
  });
  if (alert) await deps.alerts.emitAlert(alert);
  if (alert) return { sessionId: session.id, closeReason: "manual", alreadyClosed: false };
  const winner = await deps.repo.findSessionById(session.id);
  return {
    sessionId: session.id,
    closeReason: (winner?.closeReason as SupportSessionCloseReason | null) ?? "manual",
    alreadyClosed: true,
  };
}

// ── close-sweep (§7.4 step 6): close expired open sessions; emit m34.support_session.expired ──────────

/** One open-session candidate the close-sweep evaluates. The caller (worker) loads these under
 *  `withPlatformContext` — the sweep runs platform-wide (RLS-bypassed) and is a system actor, so the
 *  candidate set is supplied as data (keeping this orchestration pure + cross-tenant capable). `organizationId`
 *  is the GRANT's organization. */
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
 * Close every support session whose `expires_at <= now` and that is still open (§7.4 step 6). For each: close it with
 * `close_reason='expired'`, append the `session.close` ledger event, emit the critical M4 audit, publish
 * `m34.support_session.expired`, and M36-alert the grantor that the window shut. The candidate set is supplied by the worker
 * (loaded under `withPlatformContext`); this orchestration is pure + deterministic (sorted by `sessionId` so a partial failure
 * is reproducible). A candidate already closed by a manual close or a revoke is skipped (the guarded close writes nothing).
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
    .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
    .slice(0, SUPPORT_SESSION_SWEEP_BATCH_SIZE);

  for (const candidate of due) {
    const alert = await endSupportSession(deps, {
      sessionId: candidate.sessionId,
      organizationId: candidate.organizationId,
      supportConsentGrantId: candidate.supportConsentGrantId,
      tenantAccountId: candidate.tenantAccountId,
      grantorMembershipId: candidate.grantorMembershipId,
      sessionActorMembershipId: candidate.actorMembershipId,
      closedByMembershipId: candidate.actorMembershipId,
      reason: "expired",
      now,
    });
    if (alert === null) continue;
    await deps.alerts.emitAlert(alert);
    closedSessionIds.push(candidate.sessionId);
  }

  return { closed: closedSessionIds.length, closedSessionIds };
}
