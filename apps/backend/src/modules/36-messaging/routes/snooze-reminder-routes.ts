// apps/backend/src/modules/36-messaging/routes/snooze-reminder-routes.ts - WP 4.10 (ADR-0077).
//
//   GET    /api/v1/messaging/channels/:id/snooze     the caller's snooze of a conversation + whether it can be snoozed now
//   PUT    /api/v1/messaging/channels/:id/snooze     snooze for 5 minutes to 24 hours (Idempotency-Key required);
//                                                    409 SNOOZE_URGENT_NOT_ALLOWED while an acknowledgment request is open;
//                                                    an invisible conversation is the uniform 404 (decided in the service)
//   DELETE /api/v1/messaging/channels/:id/snooze     end the snooze (idempotent)
//   GET    /api/v1/messaging/reminders               the caller's own pending reminders
//   PUT    /api/v1/messaging/messages/:id/reminder   remind me at an instant, 1 minute to 30 days ahead (Idempotency-Key required);
//                                                    409 REMINDER_URGENT_NOT_ALLOWED / REMINDER_LIMIT_REACHED
//   DELETE /api/v1/messaging/messages/:id/reminder   cancel (idempotent)
//
// All of it is the caller's OWN preference: messaging.read, and the conversation must be visible to the caller to create one (a
// withdraw needs only the flag, so someone who lost access can still undo). Org and actor come from the request context. The tenant
// flag `messaging.notification_policy` off is the uniform 404. Responses are never cached.
import { requirePermission } from "@chartwarden/auth";
import { NotFoundError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Actor, SnoozeReminderService } from "../snooze-reminders/snooze-reminder-service";
import { ChannelParamsSchema, parse } from "./messaging-typebox";
import {
  MessageParamsSchema,
  ReminderBodySchema,
  SnoozeBodySchema,
} from "./snooze-reminder-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface SnoozeReminderRouteDeps {
  readonly service: SnoozeReminderService;
}

const OFF = async (): Promise<never> => {
  throw new NotFoundError("snooze");
};

/** Used when the boot supplies none: every route answers the uniform 404. */
export const DISABLED_SNOOZE_REMINDER: SnoozeReminderRouteDeps = {
  service: {
    getSnooze: OFF,
    snooze: OFF,
    clearSnooze: OFF,
    setReminder: OFF,
    clearReminder: OFF,
    listReminders: OFF,
  },
};

export interface SnoozeReminderRouteGuards {
  readonly read: PreHandler;
  readonly requireIdempotencyKey: PreHandler;
}

function actorOf(request: FastifyRequest): Actor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { orgId: ctx.organizationId, userId: ctx.userId };
}

const NO_STORE = "no-store";

export function registerSnoozeReminderRoutes(
  app: FastifyInstance,
  deps: SnoozeReminderRouteDeps,
  guards: SnoozeReminderRouteGuards,
): void {
  const { service } = deps;
  const channelId = requireUuidParams("id");
  const messageId = requireUuidParams("id");

  app.get(
    "/api/v1/messaging/channels/:id/snooze",
    {
      preHandler: [channelId, guards.read],
      config: { auditRead: { resourceKind: "channel", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const { id } = parse(ChannelParamsSchema, request.params);
      return reply
        .header("Cache-Control", NO_STORE)
        .send(await service.getSnooze(actorOf(request), id));
    },
  );

  app.put(
    "/api/v1/messaging/channels/:id/snooze",
    { preHandler: [channelId, guards.read, guards.requireIdempotencyKey] },
    async (request, reply) => {
      const { id } = parse(ChannelParamsSchema, request.params);
      const body = parse(SnoozeBodySchema, request.body);
      const view = await service.snooze(actorOf(request), id, body.duration_minutes);
      return reply.header("Cache-Control", NO_STORE).send(view);
    },
  );

  app.delete(
    "/api/v1/messaging/channels/:id/snooze",
    { preHandler: [channelId, guards.read] },
    async (request, reply) => {
      const { id } = parse(ChannelParamsSchema, request.params);
      return reply
        .header("Cache-Control", NO_STORE)
        .send(await service.clearSnooze(actorOf(request), id));
    },
  );

  app.get(
    "/api/v1/messaging/reminders",
    {
      preHandler: [guards.read],
      config: { auditRead: { resourceKind: "message_reminder", list: true } },
    },
    async (request, reply) =>
      reply.header("Cache-Control", NO_STORE).send(await service.listReminders(actorOf(request))),
  );

  app.put(
    "/api/v1/messaging/messages/:id/reminder",
    { preHandler: [messageId, guards.read, guards.requireIdempotencyKey] },
    async (request, reply) => {
      const { id } = parse(MessageParamsSchema, request.params);
      const body = parse(ReminderBodySchema, request.body);
      const view = await service.setReminder(actorOf(request), id, body.remind_at);
      return reply.header("Cache-Control", NO_STORE).send(view);
    },
  );

  app.delete(
    "/api/v1/messaging/messages/:id/reminder",
    { preHandler: [messageId, guards.read] },
    async (request, reply) => {
      const { id } = parse(MessageParamsSchema, request.params);
      return reply
        .header("Cache-Control", NO_STORE)
        .send(await service.clearReminder(actorOf(request), id));
    },
  );
}
