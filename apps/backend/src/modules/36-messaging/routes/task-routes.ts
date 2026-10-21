// apps/backend/src/modules/36-messaging/routes/task-routes.ts - WP 3.4 communication tasks (ADR-0061).
//
//   POST /api/v1/messaging/channels/:id/messages/:messageId/tasks   convert a message into a task   (messaging.send + channel_visibility)
//   GET  /api/v1/messaging/tasks                                    my tasks (assigned | created)    (messaging.read)
//   GET  /api/v1/messaging/tasks/:taskId                            one task + its events            (messaging.read)
//   POST /api/v1/messaging/tasks/:taskId/{accept,complete,cancel,reassign}                          (messaging.send)
//
// The tenant flag `messaging.tasks` gates every route: off => 404 on every single-resource and write route, and the list
// answers 200 `{enabled:false,tasks:[]}` so the web can hide the UI. Org and actor are always the request context.
// Participant rules (creator or assignee only), channel re-visibility and the state machine live in the service; a missing
// task, a non-participant, a hidden channel and a deleted message are ONE 404. No `Idempotency-Key`: idempotency is the
// partial unique index (one active task per message and assignee), so no request header is read here.
import { NotFoundError, UnauthorizedError, ChartWardenError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TaskActorRef, TaskService } from "../tasks/task-service";
import { ThreadParamsSchema, parse } from "./messaging-typebox";
import {
  CloseTaskBodySchema,
  ConvertTaskBodySchema,
  ListTasksQuerySchema,
  ReassignTaskBodySchema,
  TaskParamsSchema,
} from "./task-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const TASK_LIST_DEFAULTS = { scope: "assigned", state: "active", limit: 50 } as const;

export interface TaskRouteDeps {
  /** The tenant flag `messaging.tasks`. A throw reads as off (fail closed). */
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly service: TaskService;
}

/** The channel guards `registerMessagingRoutes` already built (passed in to avoid an import cycle). */
export interface TaskRouteGuards {
  readonly read: PreHandler;
  readonly send: PreHandler;
  readonly sendToChannel: PreHandler;
}

const OFF = async (): Promise<never> => {
  throw new Error("tasks are not bound");
};

/** Used when the boot supplies none: flag off, so every route 404s and the list answers disabled. */
export const DISABLED_TASKS: TaskRouteDeps = {
  isEnabled: async () => false,
  service: {
    convert: OFF,
    get: OFF,
    list: OFF,
    accept: OFF,
    complete: OFF,
    cancel: OFF,
    reassign: OFF,
    openTaskCount: async () => 0,
  },
};

const notFound = (): NotFoundError => new NotFoundError("communication_task");

function actorOf(request: FastifyRequest): TaskActorRef {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { orgId: ctx.organizationId, userId: ctx.userId };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed task id is the same 404 a missing task gets (never a uuid-cast 500). */
const taskIdParam: PreHandler = async (request) => {
  const taskId = (request.params as { taskId?: unknown } | undefined)?.taskId;
  if (typeof taskId !== "string" || !UUID.test(taskId)) throw notFound();
};

function parseDue(raw: string | null | undefined): Date | null {
  if (raw === undefined || raw === null) return null;
  const due = new Date(raw);
  if (Number.isNaN(due.getTime())) {
    throw new ChartWardenError("TASK_DUE_INVALID", "due date is not a valid instant", 422);
  }
  return due;
}

export function registerTaskRoutes(
  app: FastifyInstance,
  deps: TaskRouteDeps,
  guards: TaskRouteGuards,
): void {
  const { service } = deps;
  const flagOn = (orgId: string): Promise<boolean> => deps.isEnabled(orgId).catch(() => false);
  const requireFlag = async (actor: TaskActorRef): Promise<void> => {
    if (!(await flagOn(actor.orgId))) throw notFound();
  };
  const readOne = [taskIdParam, guards.read];
  const writeOne = [taskIdParam, guards.send];

  app.post(
    "/api/v1/messaging/channels/:id/messages/:messageId/tasks",
    { preHandler: [requireUuidParams("id", "messageId"), guards.send, guards.sendToChannel] },
    async (request, reply) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const p = parse(ThreadParamsSchema, request.params);
      const body = parse(ConvertTaskBodySchema, request.body);
      const result = await service.convert(actor, {
        channelId: p.id,
        messageId: p.messageId,
        assigneeUserId: body.assignee_user_id,
        dueAt: parseDue(body.due_at),
        ...(body.clinical_concern === undefined ? {} : { clinicalConcern: body.clinical_concern }),
      });
      return reply.code(result.created ? 201 : 200).send(result);
    },
  );

  app.get(
    "/api/v1/messaging/tasks",
    {
      preHandler: [guards.read],
      config: { auditRead: { resourceKind: "communication_task", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      if (!(await flagOn(actor.orgId))) return { enabled: false, tasks: [] };
      const q = parse(ListTasksQuerySchema, request.query);
      const tasks = await service.list(actor, {
        scope: q.scope ?? TASK_LIST_DEFAULTS.scope,
        state: q.state ?? TASK_LIST_DEFAULTS.state,
        limit: q.limit ?? TASK_LIST_DEFAULTS.limit,
      });
      return { enabled: true, tasks };
    },
  );

  app.get(
    "/api/v1/messaging/tasks/:taskId",
    {
      preHandler: readOne,
      config: {
        auditRead: {
          resourceKind: "communication_task",
          resourceIdParam: "taskId",
          patientIdPayloadPath: "task.patient_id",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const { taskId } = parse(TaskParamsSchema, request.params);
      return service.get(actor, taskId);
    },
  );

  app.post("/api/v1/messaging/tasks/:taskId/accept", { preHandler: writeOne }, async (request) => {
    const actor = actorOf(request);
    await requireFlag(actor);
    const { taskId } = parse(TaskParamsSchema, request.params);
    return { task: await service.accept(actor, taskId) };
  });

  app.post(
    "/api/v1/messaging/tasks/:taskId/complete",
    { preHandler: writeOne },
    async (request) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const { taskId } = parse(TaskParamsSchema, request.params);
      const body = parse(CloseTaskBodySchema, request.body);
      return { task: await service.complete(actor, taskId, body.reason) };
    },
  );

  app.post("/api/v1/messaging/tasks/:taskId/cancel", { preHandler: writeOne }, async (request) => {
    const actor = actorOf(request);
    await requireFlag(actor);
    const { taskId } = parse(TaskParamsSchema, request.params);
    const body = parse(CloseTaskBodySchema, request.body);
    return { task: await service.cancel(actor, taskId, body.reason) };
  });

  app.post(
    "/api/v1/messaging/tasks/:taskId/reassign",
    { preHandler: writeOne },
    async (request) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const { taskId } = parse(TaskParamsSchema, request.params);
      const body = parse(ReassignTaskBodySchema, request.body);
      return { task: await service.reassign(actor, taskId, body.assignee_user_id) };
    },
  );
}
