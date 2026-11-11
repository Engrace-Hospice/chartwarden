import {
  type GuardRequest,
  requireAbac,
  requirePermission,
  requireStepUp,
} from "@chartwarden/auth";
// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/support-sessions.ts — M34 (§4.1
// platform-ops; §4.7/§6; F01/D8/D16). The tenant-consented break-glass *support session* route group:
// list (active + recent across tenants), read the event ledger (the surveyor trail), start (a DISTINCT
// platform-ops actor opens a session against a `support_consent_grant` — D16 distinct-actor + passkey-
// recent-5min step-up), elevate-phi-read (a fresh passkey-recent-2min step-up opens a short PHI-write
// window; refused for Part 2-heightened sessions, §7.4 step 4a), and close (reason='manual').
//
// Every route is gated by the REAL Authorization Contract (`requirePermission`/`requireAbac`/
// `requireStepUp` from @chartwarden/auth, M3) on the §4.5 keys M34 registers into M3's catalog
// (M34_CONTRIBUTED_PERMISSIONS) + the §4.6 predicates M34 owns (./abac-predicates). Cross-tenant reads
// run under `withPlatformContext` (M1 @chartwarden/tenancy — the separately-pooled, RLS-bypass, AUDITED
// platform-ops read path, F03/F09) in prod; org/actor binding is ALWAYS server-side (`request.context`,
// never the body). Mirrors the M22 routes/documents-routes.ts shape (+ the sibling tenants.ts).
//
// READ/LIST routes are fully live: the handlers compose over the injected TenantPlatformRouteService →
// `withPlatformContext` → typed response, and `auditRead()` records every PHI-adjacent surveyor read
// (HIPAA §164.312(b) + the F09 bypass-audit guarantee). The start/elevate/close COMMANDS are synchronous
// service calls that publish their own §4.9 `m34.support_session.*` outbox in-tx (no worker enqueue).
import { type PreHandler, writeActorOf } from "@chartwarden/shared/route-kit";
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CloseSessionRequest,
  ElevateSessionRequest,
  PlatformSupportConsentGrantListQuerySchema,
  SessionEventListQuerySchema,
  SessionParamsSchema,
  StartSessionRequest,
  SupportSessionListQuerySchema,
  parse,
} from "./platform-typebox";
import type { TenantPlatformRouteService } from "./service";

export interface SupportSessionRouteDeps {
  /** The §4.1 platform-ops route service (in-memory in the slice; Drizzle under `withPlatformContext`). */
  service: TenantPlatformRouteService;
}

const sessionIdOf = (request: FastifyRequest): string =>
  parse(SessionParamsSchema, request.params).id;

// §4.5 permission guards.
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const LIST = P("support_session.list_platform");
const START = P("support_session.start");
const ELEVATE = P("support_session.elevate_phi_read");
const CLOSE = P("support_session.close");

// §4.6 ABAC. The list/close routes gate on `tenant_lifecycle_platform_ops`; start gates on the
// `support_session_actor_distinct_from_grantor` predicate (D16 — the grant id is server-resolved, surfaced
// on the body so the predicate is exercisable end-to-end); elevate resolves the session id server-side
// through `tenant_consented_support_active`.
const startTarget = (request: GuardRequest): Record<string, unknown> => {
  const b = request.body as { supportConsentGrantId?: unknown } | undefined;
  return { supportConsentGrantId: b?.supportConsentGrantId };
};
const elevateTarget = (request: GuardRequest): Record<string, unknown> => {
  return { supportSessionId: (request.params as { id?: unknown } | undefined)?.id };
};
const ABAC_PLATFORM_OPS = requireAbac(
  "support_session.list_platform",
  "tenant_lifecycle_platform_ops",
) as PreHandler;
const ABAC_DISTINCT_ACTOR = requireAbac(
  "support_session.start",
  "support_session_actor_distinct_from_grantor",
  { getTarget: startTarget },
) as PreHandler;
const ABAC_SUPPORT_ACTIVE = requireAbac(
  "support_session.elevate_phi_read",
  "tenant_consented_support_active",
  { getTarget: elevateTarget },
) as PreHandler;
const ABAC_CLOSE = requireAbac(
  "support_session.close",
  "tenant_lifecycle_platform_ops",
) as PreHandler;

// §6/D10 step-up (the operation key drives M3-T07's per-operation freshness policy).
const STEPUP_START = requireStepUp("support_session.start") as PreHandler; // passkey_recent_5min
const STEPUP_ELEVATE = requireStepUp("support_session.elevate_phi_read") as PreHandler; // passkey_recent_2min

/**
 * Register the §4.1 platform-ops support-session routes. Mounted by the composition root behind the same
 * authenticate/security/error chain when a DB client is present (the M36 `mountMessagingRoutes`
 * precedent). The auditRead marker on the read routes is the F09 platform-bypass audit anchor.
 */
export function registerSupportSessionRoutes(
  app: FastifyInstance,
  deps: SupportSessionRouteDeps,
): void {
  const { service } = deps;

  // 1 — list active + recent support sessions across tenants (cursor-paginated; tenant/status filters). §4.1.
  app.get(
    "/api/v1/platform/support-sessions",
    {
      preHandler: [LIST, ABAC_PLATFORM_OPS],
      config: { auditRead: { resourceKind: "support_session", list: true } },
    },
    async (request) => {
      writeActorOf(request);
      const q = parse(SupportSessionListQuerySchema, request.query);
      return service.listSessions(
        { tenantAccountId: q.tenantAccountId, status: q.status },
        q.cursor,
        q.limit,
      );
    },
  );

  // 2 — read a session's event ledger (the surveyor trail; cursor-paginated; audited read). §7.4 acc.
  app.get(
    "/api/v1/platform/support-sessions/:id/events",
    {
      preHandler: [LIST, ABAC_PLATFORM_OPS],
      config: {
        auditRead: {
          resourceKind: "support_session_event",
          list: true,
          listResourceId: true,
          resourceIdParam: "id",
        },
      },
    },
    async (request) => {
      writeActorOf(request);
      const q = parse(SessionEventListQuerySchema, request.query);
      return service.listSessionEvents(sessionIdOf(request), q.cursor, q.limit);
    },
  );

  // 3 — start a session against a consent grant (§7.4 step 3; D16 distinct-actor + passkey-5min step-up). §4.1.
  app.post(
    "/api/v1/platform/support-sessions",
    { preHandler: [START, ABAC_DISTINCT_ACTOR, STEPUP_START] },
    async (request, reply) => {
      // No organization here: the session is recorded in the organization of the consent GRANT (the tenant's), never in the
      // operator's own session organization.
      const { membershipId, userId } = writeActorOf(request);
      const actorIp = request.ip ?? null;
      const body = parse(StartSessionRequest, request.body);
      const res = await service.startSession({
        supportConsentGrantId: body.supportConsentGrantId,
        actorMembershipId: membershipId,
        actorUserId: userId,
        actorIp,
      });
      return reply.code(201).send(res);
    },
  );

  // 4 — elevate for the PHI write window (§7.4 step 5; fresh passkey-2min step-up; Part 2-heightened → 403). §4.1.
  app.post(
    "/api/v1/platform/support-sessions/:id/elevate",
    { preHandler: [ELEVATE, ABAC_SUPPORT_ACTIVE, STEPUP_ELEVATE] },
    async (request, reply) => {
      const { membershipId } = writeActorOf(request);
      const actorIp = request.ip ?? null;
      parse(ElevateSessionRequest, request.body);
      const res = await service.elevateSession({
        supportSessionId: sessionIdOf(request),
        actorMembershipId: membershipId,
        actorIp,
      });
      return reply.code(201).send(res);
    },
  );

  // The consent grants an operator may start a session against (slice 7; the Start picker and a help request's grant).
  // Cross-tenant, so an audited platform read like the session list; nothing in it names the grantor or the patients in scope.
  app.get(
    "/api/v1/platform/support-consent-grants",
    {
      preHandler: [LIST, ABAC_PLATFORM_OPS],
      config: { auditRead: { resourceKind: "support_consent_grant", list: true } },
    },
    async (request) => {
      writeActorOf(request);
      const q = parse(PlatformSupportConsentGrantListQuerySchema, request.query);
      return service.listConsentGrants(
        { tenantAccountId: q.tenantAccountId, active: q.active },
        q.cursor,
        q.limit,
      );
    },
  );

  // 5 — close a session with reason='manual' (§7.4; no step-up — closing is always permitted). §4.1.
  app.post(
    "/api/v1/platform/support-sessions/:id/close",
    { preHandler: [CLOSE, ABAC_CLOSE] },
    async (request) => {
      const { membershipId } = writeActorOf(request);
      const actorIp = request.ip ?? null;
      // `note` is accepted and DISCARDED: closeSession takes no note, and closing is always permitted, so a refusal here would only
      // block it. A change that stores the note must screen it (screenFreeText) first.
      parse(CloseSessionRequest, request.body);
      return service.closeSession({
        supportSessionId: sessionIdOf(request),
        actorMembershipId: membershipId,
        actorIp,
      });
    },
  );
}
