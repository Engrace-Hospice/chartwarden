// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/help-requests.ts — M34, slice 7: the operators' help inbox.
//
// What the ChartWarden operators see of the tenants' help requests, and how an operator ends one. Gated like every platform
// support route: `support_session.list_platform` and `tenant_lifecycle_platform_ops` for the inbox (a declared, audited cross-tenant
// read), `support_session.close` and the same ABAC for Resolve (no step-up, an AI principal refused, an Idempotency-Key required).
// Resolve is NOT a gate on the platform lane: it ends the consent and the session, not ChartWarden's contractual onboarding access
// (CW-AC-12). The service behind them is `help/help-request-service.ts`.
import { requireAbac, requirePermission } from "@chartwarden/auth";
import {
  type PreHandler,
  parse,
  rejectAiActor,
  requireIdempotencyKey,
  writeActorOf,
} from "@chartwarden/shared/route-kit";
import type { FastifyInstance } from "fastify";
import type { HelpRequestService, HelpRequestStatus } from "../../help/help-request-contract";
import {
  HelpRequestParamsSchema,
  PlatformHelpRequestListQuerySchema,
  ResolveHelpRequestRequest,
} from "../help-request-typebox";

export interface PlatformHelpRequestRouteDeps {
  readonly service: HelpRequestService;
}

const LIST = requirePermission("support_session.list_platform") as PreHandler;
const CLOSE = requirePermission("support_session.close") as PreHandler;
const ABAC_LIST = requireAbac(
  "support_session.list_platform",
  "tenant_lifecycle_platform_ops",
) as PreHandler;
const ABAC_CLOSE = requireAbac(
  "support_session.close",
  "tenant_lifecycle_platform_ops",
) as PreHandler;
const NO_AI = rejectAiActor("AI principals cannot resolve help requests") as PreHandler;
const IDEMPOTENT = requireIdempotencyKey() as PreHandler;

/** `?status=open,approved` -> the statuses; empty means the service's default, the live ones (the schema already refused anything else). */
const statusesOf = (raw: string | undefined): HelpRequestStatus[] =>
  raw ? (raw.split(",") as HelpRequestStatus[]) : [];

export function registerPlatformHelpRequestRoutes(
  app: FastifyInstance,
  deps: PlatformHelpRequestRouteDeps,
): void {
  const { service } = deps;

  app.get(
    "/api/v1/platform/help-requests",
    {
      preHandler: [LIST, ABAC_LIST],
      config: { auditRead: { resourceKind: "tenant_help_request", list: true } },
    },
    async (request) => {
      const actor = writeActorOf(request);
      const q = parse(PlatformHelpRequestListQuerySchema, request.query);
      return service.listForPlatform(
        actor,
        { statuses: statusesOf(q.status), tenantAccountId: q.tenantAccountId },
        q.cursor,
        q.limit,
      );
    },
  );

  app.post(
    "/api/v1/platform/help-requests/:id/resolve",
    { preHandler: [CLOSE, ABAC_CLOSE, NO_AI, IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(HelpRequestParamsSchema, request.params);
      const body = parse(ResolveHelpRequestRequest, request.body);
      return service.resolve(actor, id, body);
    },
  );
}
