// apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/support-sessions.ts — M34, slice 7.
//
// The tenant's read-only view of the ChartWarden support sessions on its own organization, for the Administration screens (after
// go-live, and the grants screen): `GET /api/v1/tenant/support-sessions` and its `/:id/events` ledger. Gated on the
// support-consent-grant key (`support_consent_grant.list_own`): whoever may see the consent may see what was done under it. Both
// are declared list reads (a view of a session is a disclosure-accounting surface), and no view carries an operator id or address.
// The reads are piece 7S's; until it lands the injected service answers 501 NOT_IMPLEMENTED.
import { requirePermission } from "@chartwarden/auth";
import { type PreHandler, actorOf, parse } from "@chartwarden/shared/route-kit";
import type { FastifyInstance } from "fastify";
import type { TenantRouteService } from "./service";
import {
  TenantSupportSessionListQuerySchema,
  TenantSupportSessionParamsSchema,
} from "./tenant-typebox";

export interface SupportSessionReadRouteDeps {
  service: TenantRouteService;
}

const LIST = requirePermission("support_consent_grant.list_own") as PreHandler;

export function registerTenantSupportSessionRoutes(
  app: FastifyInstance,
  deps: SupportSessionReadRouteDeps,
): void {
  const { service } = deps;

  app.get(
    "/api/v1/tenant/support-sessions",
    {
      preHandler: [LIST],
      config: { auditRead: { resourceKind: "support_session", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(TenantSupportSessionListQuerySchema, request.query);
      return service.listSupportSessions(organizationId, q.cursor, q.limit);
    },
  );

  app.get(
    "/api/v1/tenant/support-sessions/:id/events",
    {
      preHandler: [LIST],
      config: { auditRead: { resourceKind: "support_session_event", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(TenantSupportSessionParamsSchema, request.params);
      const q = parse(TenantSupportSessionListQuerySchema, request.query);
      return service.listSupportSessionEvents(organizationId, id, q.cursor, q.limit);
    },
  );
}
