// apps/backend/src/modules/36-messaging/routes/inbox-routes.ts - WP 6.1 (ADR-0100): the smart work inbox.
//
//   GET /api/v1/messaging/inbox?limit   one ranked queue of the caller's own waiting work (messaging.read)
//
// Read-only: it acknowledges, accepts and completes nothing; each row names the surface that owns the item. Every source is the caller's
// own (assigned acks, assigned tasks, incoming handoffs, their conversations), so there is no org-wide read here and the supervisor
// permission is not involved. The tenant flag `messaging.smart_inbox` off answers 200 `{enabled:false}` so the web hides the screen.
// Responses are never cached. Org and actor come from the request context.
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SmartInboxService } from "../inbox/inbox-service";
import { InboxQuerySchema, InboxResponseSchema } from "./inbox-typebox";
import { parse } from "./messaging-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface InboxRouteDeps {
  readonly service: SmartInboxService;
}

/** Used when the boot supplies none: the feature reads as off. */
export const DISABLED_INBOX: InboxRouteDeps = {
  service: {
    list: async () => ({
      enabled: false,
      items: [],
      band_counts: {
        urgent_ack: 0,
        handoff_awaiting: 0,
        task_assigned: 0,
        mention: 0,
        care_team_unread: 0,
      },
      complete: true,
      urgent_complete: true,
      unavailable_sources: [],
    }),
  },
};

export function registerInboxRoutes(
  app: FastifyInstance,
  deps: InboxRouteDeps,
  guards: { readonly read: PreHandler },
): void {
  app.get(
    "/api/v1/messaging/inbox",
    {
      preHandler: [guards.read],
      schema: { response: { 200: InboxResponseSchema } },
      config: { auditRead: { resourceKind: "smart_inbox", list: true } },
    },
    async (request, reply) => {
      const ctx = request.context;
      if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
      const q = parse(InboxQuerySchema, request.query);
      const out = await deps.service.list(
        { orgId: ctx.organizationId, userId: ctx.userId },
        { limit: q.limit },
      );
      return reply.header("Cache-Control", "no-store").send(out);
    },
  );
}
