// apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/help-requests.ts — M34, slice 7: help during onboarding.
//
// Any ACTIVE member of the organization may ask ChartWarden for help; an org_admin or the compliance officer may consent to it
// (creating a non-PHI `assist` grant) and anyone concerned may end it. There is deliberately no permission key on the file, read and
// close routes: a tenant may hold custom or cloned roles that no key can be guaranteed to reach, so the routes require a session and
// the SERVICE judges the member (`help/help-request-contract.ts`: active membership of THIS organization, `staff` session class,
// not an AI principal, not ChartWarden staff; approve and close are role-checked there). The guard chain per route:
//   GET  /api/v1/tenant/help-requests               session                                       un-audited, pollable
//   POST /api/v1/tenant/help-requests               session, AI block, Idempotency-Key, rate limit (3/member, 10/org an hour)
//   POST /api/v1/tenant/help-requests/:id/approve   `support_consent_grant.issue`, fresh step-up (the grant-issue key), AI block, Idempotency-Key
//   POST /api/v1/tenant/help-requests/:id/close     session, AI block, Idempotency-Key (no step-up: ending help is frictionless)
// The service behind them is `help/help-request-service.ts`, which judges the member.
import { requirePermission, requireSession, requireStepUp } from "@chartwarden/auth";
import {
  type PreHandler,
  parse,
  rejectAiActor,
  requireIdempotencyKey,
  writeActorOf,
} from "@chartwarden/shared/route-kit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { HelpRequestService } from "../../help/help-request-contract";
import {
  ApproveHelpRequestRequest,
  CloseHelpRequestRequest,
  FileHelpRequestRequest,
  HelpRequestParamsSchema,
  TenantHelpRequestListQuerySchema,
} from "../help-request-typebox";

/** The per-member and per-organization cap on filing, built at the composition root (`createRouteRateLimit`); absent in tests. */
export type HelpRequestRateLimit = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface TenantHelpRequestRouteDeps {
  readonly service: HelpRequestService;
  readonly fileRateLimit?: HelpRequestRateLimit;
}

const SESSION = requireSession() as PreHandler;
const ISSUE = requirePermission("support_consent_grant.issue") as PreHandler;
// Approving IS granting consent, so it takes the same fresh step-up as issuing a grant directly.
const STEP_UP_ISSUE = requireStepUp("support_consent_grant.issue") as PreHandler;
const NO_AI = rejectAiActor("AI principals cannot ask for or answer help requests") as PreHandler;
const IDEMPOTENT = requireIdempotencyKey() as PreHandler;

export function registerTenantHelpRequestRoutes(
  app: FastifyInstance,
  deps: TenantHelpRequestRouteDeps,
): void {
  const { service, fileRateLimit } = deps;

  app.get("/api/v1/tenant/help-requests", { preHandler: [SESSION] }, async (request) => {
    const actor = writeActorOf(request);
    const q = parse(TenantHelpRequestListQuerySchema, request.query);
    return service.listForTenant(actor, q.cursor, q.limit);
  });

  app.post(
    "/api/v1/tenant/help-requests",
    {
      config: { noIdempotencyCapture: true },
      preHandler: [
        SESSION,
        NO_AI,
        IDEMPOTENT,
        ...(fileRateLimit ? [fileRateLimit as PreHandler] : []),
      ],
    },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(FileHelpRequestRequest, request.body);
      const view = await service.file(actor, body);
      return reply.code(201).send(view);
    },
  );

  app.post(
    "/api/v1/tenant/help-requests/:id/approve",
    {
      config: { noIdempotencyCapture: true },
      preHandler: [ISSUE, STEP_UP_ISSUE, NO_AI, IDEMPOTENT],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(HelpRequestParamsSchema, request.params);
      const body = parse(ApproveHelpRequestRequest, request.body);
      return service.approve(actor, id, body);
    },
  );

  app.post(
    "/api/v1/tenant/help-requests/:id/close",
    {
      config: { noIdempotencyCapture: true },
      preHandler: [SESSION, NO_AI, IDEMPOTENT],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(HelpRequestParamsSchema, request.params);
      parse(CloseHelpRequestRequest, request.body ?? {});
      return service.close(actor, id);
    },
  );
}
