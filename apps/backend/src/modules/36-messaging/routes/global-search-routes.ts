// apps/backend/src/modules/36-messaging/routes/global-search-routes.ts - WP 2.7b global message search (ADR-0058, Accepted).
//
//   GET /api/v1/messaging/search?q=&cursor=&limit=     every channel the caller may read: whole words, and a word beginning
//                                                      for the last word. Refused unless the tenant flag AND the platform flag
//                                                      are on, the index is ready and the ring key provider can derive a key.
//
// preHandlers, in this order (the first refusal wins): authentication (the global hook), `messaging.read`, the injected rate
// limit (default: fail closed 503 unless the composition root injects the WP 2.14 limiter, which it does only on a shared Valkey store), platform kill switch, tenant flag, serve gate (index
// ready, no purge pending), workforce role gate. Nothing in a refusal repeats the query.
// Read audit: one aggregate `message.list_viewed` from the hook (`q` and `cursor` omitted; no resourceIdParam, so the list
// branch) plus one attributed `message.viewed` per patient on the page, written by the service in its transaction.
import { requirePermission } from "@wardenx/auth";
import { UnauthorizedError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GlobalSearchService } from "../global-search/query-service";
import type { RoleGate } from "../global-search/role-gate";
import type { ServeGates } from "../global-search/serve-gate";
import { GlobalSearchQuerySchema } from "./global-search-typebox";
import { parse } from "./messaging-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export type GlobalSearchRateLimit = PreHandler;

const READ = requirePermission("messaging.read") as PreHandler;

/** The default limiter: with no real one injected the route refuses (ADR P2: the limiter is a probing control). */
export const failClosedRateLimit: GlobalSearchRateLimit = async () => {
  throw new WardenXError("DEGRADED", "global search rate limiting is not available", 503);
};

export interface GlobalSearchRouteDeps {
  readonly service: GlobalSearchService;
  readonly gates: ServeGates;
  readonly roleGate: RoleGate;
  readonly rateLimit?: GlobalSearchRateLimit;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

export function registerGlobalSearchRoutes(
  app: FastifyInstance,
  deps: GlobalSearchRouteDeps,
): void {
  const { service, gates, roleGate } = deps;
  const noStore: PreHandler = async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  };
  const role: PreHandler = async (request) => {
    const { organizationId, userId } = actorOf(request);
    let allowed: boolean;
    try {
      allowed = await roleGate.mayUse(organizationId, userId);
    } catch (error) {
      request.log.error(
        { reason: error instanceof Error ? error.name : "unknown" },
        "global search role gate failed closed",
      );
      throw new WardenXError("GLOBAL_SEARCH_UNAVAILABLE", "global search is unavailable", 503);
    }
    if (!allowed) {
      throw new WardenXError(
        "GLOBAL_SEARCH_ROLE_NOT_PERMITTED",
        "global search is not available to this account",
        403,
      );
    }
  };

  app.get(
    "/api/v1/messaging/search",
    {
      preHandler: [
        noStore,
        READ,
        deps.rateLimit ?? failClosedRateLimit,
        (request) => gates.platform(request),
        (request) => gates.tenant(request),
        (request) => gates.serve(request),
        role,
      ],
      config: {
        // No resourceIdParam: this is the aggregate list branch. `q` and `cursor` are blanked in the recorded filter.
        auditRead: { resourceKind: "message", list: true, filterOmit: ["q", "cursor"] },
      },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const ctx = request.context;
      const query = parse(GlobalSearchQuerySchema, request.query);
      return service.search({
        organizationId,
        userId,
        query: query.q,
        cursor: query.cursor,
        limit: query.limit,
        serve: gates.contextOf(request),
        audit: {
          organizationId,
          userId,
          correlationId: ctx.correlationId,
          requestId: request.id,
          sourceIp: ctx.ip,
          userAgent: ctx.userAgent,
        },
      });
    },
  );
}
