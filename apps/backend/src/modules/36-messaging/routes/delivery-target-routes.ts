// apps/backend/src/modules/36-messaging/routes/delivery-target-routes.ts - WP 4.8 (ADR-0075).
//
//   GET /api/v1/messaging/deliveries/:id/target   resolve the opaque id of an out-of-band link to {channelId, messageId, ackRequestId}
//                                                 (messaging.read; the delivery must be the caller's own; the channel must still be visible)
//
// The id in `{origin}/n/{id}` is not an access grant. A missing, malformed, someone else's, other-tenant, no-longer-visible or
// deleted target is ONE 404 with one body (the id is never echoed). Read-only: opening a link never acknowledges anything. The
// response is three ids; it names no patient and no text. Read-audited against the delivery id.
import { NotFoundError, UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DeliveryTargetService } from "../delivery-target/delivery-target-service";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface DeliveryTargetRouteDeps {
  readonly service: DeliveryTargetService;
}

/** Used when the boot supplies none: the uniform 404. */
export const DISABLED_DELIVERY_TARGET: DeliveryTargetRouteDeps = {
  service: {
    resolve: async () => {
      throw new NotFoundError("notification");
    },
  },
};

export function registerDeliveryTargetRoutes(
  app: FastifyInstance,
  deps: DeliveryTargetRouteDeps,
  guards: { readonly read: PreHandler },
): void {
  app.get(
    "/api/v1/messaging/deliveries/:id/target",
    {
      preHandler: [guards.read],
      config: { auditRead: { resourceKind: "notification_delivery", resourceIdParam: "id" } },
    },
    async (request) => {
      const ctx = request.context;
      if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
      const id = (request.params as { id?: unknown }).id;
      const target = await deps.service.resolve(
        { orgId: ctx.organizationId, userId: ctx.userId },
        typeof id === "string" ? id : "",
      );
      return {
        channel_id: target.channelId,
        message_id: target.messageId,
        ack_request_id: target.ackRequestId,
      };
    },
  );
}
