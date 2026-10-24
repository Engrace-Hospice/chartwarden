// apps/backend/src/modules/36-messaging/routes/death-board-routes.ts - WP 6.9 (ADR-0098, PROPOSED): the death-event coordination board.
//
//   GET  /api/v1/messaging/death-boards?limit                             the boards the caller may see   (messaging.read + patient.read)
//   GET  /api/v1/messaging/death-boards/:boardId                          one board                       (same guards)
//   GET  /api/v1/messaging/death-board-items/:itemId/history              an item's owner/status history  (same guards)
//   POST /api/v1/messaging/death-board-items/:itemId/complete             the OWNER completes the item
//   POST /api/v1/messaging/death-board-items/:itemId/reassign             {to_user_id}  the owner or a supervisor (messaging.review)
//
// The tenant flag `messaging.death_board` is checked FIRST in every handler, before any query or body is parsed: off => the uniform 404 on
// everything but the list, which answers `200 {enabled:false, boards:[]}` so the web can hide the screen. Org and actor are always the request
// context. A missing, foreign, Part 2-restricted, not-your-patient or flag-off board is ONE 404. Nothing is deleted; no request header is read.
// READ AUDIT: every read names the patients it discloses (one event per distinct patient), so the Section 164.528 accounting is complete.
import { requirePermission } from "@chartwarden/auth";
import {
  DEATH_BOARD_LIST_DEFAULT,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DeathBoardActor, DeathBoardService } from "../death-board/death-board-service";
import {
  DeathBoardHistoryResponseSchema,
  DeathBoardItemParamsSchema,
  DeathBoardItemResponseSchema,
  DeathBoardListResponseSchema,
  DeathBoardParamsSchema,
  DeathBoardResponseSchema,
  ListDeathBoardsQuerySchema,
  ReassignDeathBoardItemBodySchema,
} from "./death-board-typebox";
import { parse } from "./messaging-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface DeathBoardRouteDeps {
  /** The tenant flag `messaging.death_board`. A throw reads as off (fail closed). */
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly service: DeathBoardService;
}

const READ = requirePermission("messaging.read") as PreHandler;
const PATIENT_READ = requirePermission("patient.read") as PreHandler;
const SUPERVISOR = requirePermission("messaging.review") as PreHandler;

async function actorOf(request: FastifyRequest, reply: FastifyReply): Promise<DeathBoardActor> {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  let supervisor = true;
  try {
    await SUPERVISOR(request, reply);
  } catch (err) {
    if (!(err instanceof ForbiddenError)) throw err;
    supervisor = false;
  }
  return { orgId: ctx.organizationId, userId: ctx.userId, supervisor };
}

export function registerDeathBoardRoutes(app: FastifyInstance, deps: DeathBoardRouteDeps): void {
  const { service } = deps;
  const flagOn = (request: FastifyRequest): Promise<boolean> => {
    const orgId = request.context?.organizationId;
    if (!orgId) throw new UnauthorizedError();
    return deps.isEnabled(orgId).catch(() => false);
  };
  /** Off => the uniform 404, before any param, query or body is parsed. */
  const FLAG_ON: PreHandler = async (request) => {
    if (!(await flagOn(request))) throw new NotFoundError("death_board");
  };
  const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store");
  app.get(
    "/api/v1/messaging/death-boards",
    {
      preHandler: [READ, PATIENT_READ],
      schema: { response: { 200: DeathBoardListResponseSchema } },
      config: {
        auditRead: {
          resourceKind: "death_board",
          resourceIdPayloadPath: "boards.0.id",
          patientIdsPayload: { path: "boards", key: "patient_id" },
        },
      },
    },
    async (request, reply) => {
      if (!(await flagOn(request))) return { enabled: false, boards: [] };
      const q = parse(ListDeathBoardsQuerySchema, request.query);
      const actor = await actorOf(request, reply);
      return noStore(reply).send({
        enabled: true,
        boards: await service.list(actor, q.limit ?? DEATH_BOARD_LIST_DEFAULT),
      });
    },
  );

  app.get(
    "/api/v1/messaging/death-boards/:boardId",
    {
      preHandler: [requireUuidParams("boardId"), READ, PATIENT_READ, FLAG_ON],
      schema: { response: { 200: DeathBoardResponseSchema } },
      config: {
        auditRead: {
          resourceKind: "death_board",
          resourceIdParam: "boardId",
          patientIdPayloadPath: "board.patient_id",
        },
      },
    },
    async (request, reply) => {
      const { boardId } = parse(DeathBoardParamsSchema, request.params);
      return noStore(reply).send({
        board: await service.get(await actorOf(request, reply), boardId),
      });
    },
  );

  app.get(
    "/api/v1/messaging/death-board-items/:itemId/history",
    {
      preHandler: [requireUuidParams("itemId"), READ, PATIENT_READ, FLAG_ON],
      schema: { response: { 200: DeathBoardHistoryResponseSchema } },
      config: {
        auditRead: {
          none: "Owner and status history of one item: ids, enums and instants. No patient, no text",
        },
      },
    },
    async (request, reply) => {
      const { itemId } = parse(DeathBoardItemParamsSchema, request.params);
      return noStore(reply).send({
        events: await service.history(await actorOf(request, reply), itemId),
      });
    },
  );

  app.post(
    "/api/v1/messaging/death-board-items/:itemId/complete",
    {
      preHandler: [requireUuidParams("itemId"), READ, PATIENT_READ, FLAG_ON],
      schema: { response: { 200: DeathBoardItemResponseSchema } },
    },
    async (request, reply) => {
      const { itemId } = parse(DeathBoardItemParamsSchema, request.params);
      return noStore(reply).send({
        item: await service.complete(await actorOf(request, reply), itemId),
      });
    },
  );

  app.post(
    "/api/v1/messaging/death-board-items/:itemId/reassign",
    {
      preHandler: [requireUuidParams("itemId"), READ, PATIENT_READ, FLAG_ON],
      schema: { response: { 200: DeathBoardItemResponseSchema } },
    },
    async (request, reply) => {
      const { itemId } = parse(DeathBoardItemParamsSchema, request.params);
      const body = parse(ReassignDeathBoardItemBodySchema, request.body);
      return noStore(reply).send({
        item: await service.reassign(await actorOf(request, reply), itemId, body.to_user_id),
      });
    },
  );
}
