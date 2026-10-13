// apps/backend/src/modules/36-messaging/routes/global-search-settings-routes.ts - WP 2.7b C4 (ADR-0058 decisions 2-3).
//
//   GET /api/v1/messaging/global-search/settings   the switch, the go-live checklist and the rebuild progress
//                                                  (messaging.global_search.manage)
//   PUT /api/v1/messaging/global-search/settings   { enabled }  (messaging.global_search.manage + a fresh step-up for
//                                                  `messaging.global_search.configure`); ON needs the checklist (409
//                                                  GLOBAL_SEARCH_PREREQUISITES_UNMET with one detail per failing check)
//
// Org and actor are the server-side request context. The change is audited by the write-audit trigger on the table (who,
// when, old, new); there is no separate domain event. Registered but inert: with default wiring the rate-limit check is
// false, so ON is always refused until the composition root says the P2 limit is active.
import { requirePermission, requireStepUp } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GlobalSearchSettingsService } from "../global-search/settings-service";
import { PutGlobalSearchSettingsBodySchema } from "./global-search-settings-typebox";
import { parse } from "./messaging-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const GLOBAL_SEARCH_MANAGE_KEY = "messaging.global_search.manage";
export const GLOBAL_SEARCH_STEP_UP_KEY = "messaging.global_search.configure";
const MANAGE = requirePermission(GLOBAL_SEARCH_MANAGE_KEY) as PreHandler;
const STEP_UP = requireStepUp(GLOBAL_SEARCH_STEP_UP_KEY) as PreHandler;

export interface GlobalSearchSettingsRouteDeps {
  readonly service: GlobalSearchSettingsService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

export function registerGlobalSearchSettingsRoutes(
  app: FastifyInstance,
  deps: GlobalSearchSettingsRouteDeps,
): void {
  const { service } = deps;

  app.get(
    "/api/v1/messaging/global-search/settings",
    {
      preHandler: [MANAGE],
      config: {
        auditRead: {
          none: "organisation setting, the go-live checklist and rebuild counters: no patient data and no message content",
        },
      },
    },
    async (request) => service.get(actorOf(request).organizationId),
  );

  app.put(
    "/api/v1/messaging/global-search/settings",
    { preHandler: [MANAGE, STEP_UP] },
    async (request) => {
      const { enabled } = parse(PutGlobalSearchSettingsBodySchema, request.body);
      return service.set(actorOf(request), enabled);
    },
  );
}
