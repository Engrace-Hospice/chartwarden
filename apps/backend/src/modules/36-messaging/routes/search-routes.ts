// apps/backend/src/modules/36-messaging/routes/search-routes.ts - WP 2.7a in-conversation search.
//
// One channel, members only: the channel's own guards run (`messaging.read` + `channel_visibility` on `:id`), so a
// non-member, a removed member and another organisation get the 404 a random id gets; the service re-checks. It is a
// decrypted-body read, so every page is read-audited as one aggregate list event attributed to the care_team
// channel's patient. The audit row records the channel and the FILTER SHAPE only: `filterOmit: ["q"]` keeps the
// search text out of it (a term is message content).
import type { MessagingRouteService } from "@chartwarden/messaging";
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ChannelParamsSchema, parse } from "./messaging-typebox";
import type { ChannelGuards } from "./reaction-pin-routes";
import { SearchMessagesQuerySchema } from "./search-typebox";
import { requireUuidParams } from "./uuid-params";

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

export function registerMessageSearchRoutes(
  app: FastifyInstance,
  service: MessagingRouteService,
  guards: ChannelGuards,
): void {
  app.get(
    "/api/v1/messaging/channels/:id/search",
    {
      preHandler: [requireUuidParams("id"), guards.read, guards.viewChannel],
      config: {
        auditRead: {
          resourceKind: "message",
          list: true,
          resourceIdParam: "id",
          listResourceId: true,
          patientIdPayloadPath: "patientId",
          filterOmit: ["q"],
        },
      },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const q = parse(SearchMessagesQuerySchema, request.query);
      return service.searchMessages(organizationId, {
        userId,
        channelId: id,
        query: q.q,
        senderUserId: q.senderUserId,
        from: q.from,
        to: q.to,
        hasAttachment: q.hasAttachment,
        cursor: q.cursor,
        limit: q.limit,
      });
    },
  );
}
