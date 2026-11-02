// apps/backend/src/modules/36-messaging/routes/death-notification-routes.ts - the death-notification cascade (builds on ADR-0098, PROPOSED).
//
//   GET  /api/v1/messaging/death-boards/:boardId/notifications       the board's notices and their state      (messaging.read + patient.read)
//   POST /api/v1/messaging/death-notifications/:notificationId/ack   the RECIPIENT explicitly acknowledges   (same guards; never a read receipt)
//   POST /api/v1/messaging/death-boards/:boardId/funeral-home        {funeral_home_entity_id, recipient_email}: staff SELECTS the funeral home
//                                                                    (funeral.invite); sent only when a BAA is on file, else blocked_no_baa
//
// The tenant flag `messaging.death_notifications` is checked right after the auth guards, before any param or body is parsed: off => the uniform 404 on
// everything but the list, which answers `200 {enabled:false, notifications:[]}`. Org and actor are always the request context. A missing, foreign,
// Part 2-restricted or flag-off board is ONE 404 (the board service's own visibility rule is reused). Typed ChartWardenError throughout; nothing is
// deleted; no request header is read. The recipient address is used once to send and is never stored or echoed.
import { requirePermission } from "@chartwarden/auth";
import { NotFoundError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DeathNotificationService } from "../death-notification/death-notification-service";
import { actorOf } from "./death-board-routes";
import {
  DeathNotificationBoardParamsSchema,
  DeathNotificationListResponseSchema,
  DeathNotificationParamsSchema,
  DeathNotificationResponseSchema,
  SendFuneralHomeBodySchema,
} from "./death-notification-typebox";
import { parse } from "./messaging-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface DeathNotificationRouteDeps {
  /** The tenant flag `messaging.death_notifications` (and `messaging.death_board`). A throw reads as off (fail closed). */
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly service: DeathNotificationService;
  readonly rateLimit?: PreHandler | undefined;
}

const READ = requirePermission("messaging.read") as PreHandler;
const PATIENT_READ = requirePermission("patient.read") as PreHandler;
const FUNERAL_INVITE = requirePermission("funeral.invite") as PreHandler;

export function registerDeathNotificationRoutes(
  app: FastifyInstance,
  deps: DeathNotificationRouteDeps,
): void {
  const { service } = deps;
  const limited: PreHandler[] = deps.rateLimit ? [deps.rateLimit] : [];
  const flagOn = (request: FastifyRequest): Promise<boolean> => {
    const orgId = request.context?.organizationId;
    if (!orgId) throw new UnauthorizedError();
    return deps.isEnabled(orgId).catch(() => false);
  };
  const FLAG_ON: PreHandler = async (request) => {
    if (!(await flagOn(request))) throw new NotFoundError("death_notification");
  };
  const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store");

  app.get(
    "/api/v1/messaging/death-boards/:boardId/notifications",
    {
      preHandler: [READ, PATIENT_READ, requireUuidParams("boardId"), ...limited],
      schema: { response: { 200: DeathNotificationListResponseSchema } },
      // patient_id is the board's patient (HIPAA 164.528 accounting); an id only, and only after the board's own visibility check.
      config: {
        auditRead: {
          resourceKind: "death_board",
          resourceIdParam: "boardId",
          patientIdPayloadPath: "patient_id",
        },
      },
    },
    async (request, reply) => {
      if (!(await flagOn(request))) return { enabled: false, notifications: [] };
      const { boardId } = parse(DeathNotificationBoardParamsSchema, request.params);
      const actor = await actorOf(request, reply);
      return noStore(reply).send({ enabled: true, ...(await service.list(actor, boardId)) });
    },
  );

  app.post(
    "/api/v1/messaging/death-notifications/:notificationId/ack",
    {
      preHandler: [READ, PATIENT_READ, FLAG_ON, requireUuidParams("notificationId"), ...limited],
      schema: { response: { 200: DeathNotificationResponseSchema } },
    },
    async (request, reply) => {
      const { notificationId } = parse(DeathNotificationParamsSchema, request.params);
      return noStore(reply).send({
        notification: await service.ack(await actorOf(request, reply), notificationId),
      });
    },
  );

  app.post(
    "/api/v1/messaging/death-boards/:boardId/funeral-home",
    {
      preHandler: [
        READ,
        PATIENT_READ,
        FUNERAL_INVITE,
        FLAG_ON,
        requireUuidParams("boardId"),
        ...limited,
      ],
      schema: { response: { 200: DeathNotificationResponseSchema } },
    },
    async (request, reply) => {
      const { boardId } = parse(DeathNotificationBoardParamsSchema, request.params);
      const body = parse(SendFuneralHomeBodySchema, request.body);
      return noStore(reply).send({
        notification: await service.sendFuneralHome(await actorOf(request, reply), boardId, {
          funeralHomeEntityId: body.funeral_home_entity_id,
          recipientEmail: body.recipient_email,
        }),
      });
    },
  );
}
