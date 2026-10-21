// apps/backend/src/modules/36-messaging/routes/export-routes.ts - WP 5.7 (ADR-0089, PROPOSED): restricted messaging export, a scoped export a
// SECOND person approves, built into one encrypted artefact with an expiring, requester-only download.
//
//   POST /api/v1/messaging/export               request   (messaging.export.request + a fresh step-up + the tenant flag)
//   GET  /api/v1/messaging/export/mine          my jobs   (messaging.export.request)
//   GET  /api/v1/messaging/export/pending       the approvers' queue, never one's own (messaging.export.approve)
//   GET  /api/v1/messaging/export/:id           one job   (the requester, or an approver; read-audited)
//   POST /api/v1/messaging/export/:id/approve   approve   (messaging.export.approve + a fresh step-up; never the requester)
//   POST /api/v1/messaging/export/:id/reject    reject    (same guards)
//   POST /api/v1/messaging/export/:id/cancel    cancel    (the requester, while pending)
//   GET  /api/v1/messaging/export/:id/download  the JSON artefact (messaging.export.download + a fresh step-up; requester only; read-audited)
//
// The tenant flag `messaging.export` gates ONLY the request (off => the uniform 404, before the step-up is asked for). Approve, reject, cancel
// and download never depend on it: a job that exists stays decidable and an expiring artefact stays reachable. Org and user are the server-side
// request context, never the body. The download streams the decrypted document (no presigned URL), never cached.
import { requirePermission, requireStepUp, resolveActorPermissions } from "@chartwarden/auth";
import {
  ForbiddenError,
  MESSAGING_EXPORT_APPROVE_PERMISSION,
  MESSAGING_EXPORT_APPROVE_STEP_UP_KEY,
  MESSAGING_EXPORT_DOWNLOAD_PERMISSION,
  MESSAGING_EXPORT_DOWNLOAD_STEP_UP_KEY,
  MESSAGING_EXPORT_REQUEST_PERMISSION,
  MESSAGING_EXPORT_REQUEST_STEP_UP_KEY,
  NotFoundError,
  UnauthorizedError,
} from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ExportService } from "../export/export-service";
import type { ExportActor } from "../export/export-store";
import {
  CreateExportBodySchema,
  DecideExportBodySchema,
  ExportDetailResponseSchema,
  ExportIdParamsSchema,
  ExportListResponseSchema,
} from "./export-typebox";
import { parse } from "./messaging-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const REQUEST = requirePermission(MESSAGING_EXPORT_REQUEST_PERMISSION) as PreHandler;
const APPROVE = requirePermission(MESSAGING_EXPORT_APPROVE_PERMISSION) as PreHandler;
const DOWNLOAD = requirePermission(MESSAGING_EXPORT_DOWNLOAD_PERMISSION) as PreHandler;
const REQUEST_STEP_UP = requireStepUp(MESSAGING_EXPORT_REQUEST_STEP_UP_KEY) as PreHandler;
const APPROVE_STEP_UP = requireStepUp(MESSAGING_EXPORT_APPROVE_STEP_UP_KEY) as PreHandler;
const DOWNLOAD_STEP_UP = requireStepUp(MESSAGING_EXPORT_DOWNLOAD_STEP_UP_KEY) as PreHandler;

export interface ExportRouteDeps {
  readonly service: ExportService;
}

function actorOf(request: FastifyRequest): ExportActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

export function registerExportRoutes(app: FastifyInstance, deps: ExportRouteDeps): void {
  const { service } = deps;
  const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store");

  /** Off => the uniform 404 every other refusal to open a job gets, before the step-up is asked for. */
  const FLAG_ON: PreHandler = async (request) => {
    if (!(await service.isEnabled(actorOf(request).organizationId))) {
      throw new NotFoundError("export scope");
    }
  };
  /** Reading one job: the requester (request key) or an approver (approve key); the service scopes the row. */
  const READ_ONE: PreHandler = async (request) => {
    const ctx = request.context;
    if (!ctx?.organizationId) throw new UnauthorizedError();
    const granted = await resolveActorPermissions(ctx);
    if (
      !granted.has(MESSAGING_EXPORT_REQUEST_PERMISSION) &&
      !granted.has(MESSAGING_EXPORT_APPROVE_PERMISSION)
    ) {
      throw new ForbiddenError(
        `requires permission '${MESSAGING_EXPORT_REQUEST_PERMISSION}' or '${MESSAGING_EXPORT_APPROVE_PERMISSION}'`,
      );
    }
  };

  app.post(
    "/api/v1/messaging/export",
    {
      preHandler: [REQUEST, FLAG_ON, REQUEST_STEP_UP],
      schema: { response: { 201: ExportDetailResponseSchema } },
    },
    async (request, reply) => {
      const body = parse(CreateExportBodySchema, request.body);
      return noStore(reply)
        .code(201)
        .send(await service.create(actorOf(request), body));
    },
  );

  app.get(
    "/api/v1/messaging/export/mine",
    {
      preHandler: [REQUEST],
      schema: { response: { 200: ExportListResponseSchema } },
      config: {
        auditRead: {
          none: "The caller's own export jobs: ids, a closed status, scope ids, counts and instants. No justification, no message and no free text",
        },
      },
    },
    async (request, reply) =>
      noStore(reply).send({ jobs: await service.listMine(actorOf(request)) }),
  );

  app.get(
    "/api/v1/messaging/export/pending",
    {
      preHandler: [APPROVE],
      schema: { response: { 200: ExportListResponseSchema } },
      config: {
        auditRead: {
          none: "The approvers' queue: ids, a closed status, scope ids, the requester's name and instants. No justification, no message and no free text",
        },
      },
    },
    async (request, reply) =>
      noStore(reply).send({ jobs: await service.listPending(actorOf(request)) }),
  );

  app.get(
    "/api/v1/messaging/export/:id",
    {
      preHandler: [requireUuidParams("id"), READ_ONE],
      schema: { response: { 200: ExportDetailResponseSchema } },
      config: { auditRead: { resourceKind: "message_export_job", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const { id } = parse(ExportIdParamsSchema, request.params);
      const canApprove = (await resolveActorPermissions(request.context)).has(
        MESSAGING_EXPORT_APPROVE_PERMISSION,
      );
      return noStore(reply).send(await service.get(actorOf(request), id, { canApprove }));
    },
  );

  // Two literal registrations with the body read inline (not a loop, not a shared handler) so the static route and request-body gates see both.
  const decideOptions = {
    preHandler: [requireUuidParams("id"), APPROVE, APPROVE_STEP_UP],
    schema: { response: { 200: ExportDetailResponseSchema } },
  };
  app.post("/api/v1/messaging/export/:id/approve", decideOptions, async (request, reply) => {
    const { id } = parse(ExportIdParamsSchema, request.params);
    const body = parse(DecideExportBodySchema, request.body);
    return noStore(reply).send(await service.decide(actorOf(request), id, "approve", body));
  });
  app.post("/api/v1/messaging/export/:id/reject", decideOptions, async (request, reply) => {
    const { id } = parse(ExportIdParamsSchema, request.params);
    const body = parse(DecideExportBodySchema, request.body);
    return noStore(reply).send(await service.decide(actorOf(request), id, "reject", body));
  });

  app.post(
    "/api/v1/messaging/export/:id/cancel",
    {
      preHandler: [requireUuidParams("id"), REQUEST],
      schema: { response: { 200: ExportDetailResponseSchema } },
    },
    async (request, reply) => {
      const { id } = parse(ExportIdParamsSchema, request.params);
      return noStore(reply).send(await service.cancel(actorOf(request), id));
    },
  );

  app.get(
    "/api/v1/messaging/export/:id/download",
    {
      preHandler: [requireUuidParams("id"), DOWNLOAD, DOWNLOAD_STEP_UP],
      // The artefact holds message bodies: one read event per download, attributed to the job.
      config: { auditRead: { resourceKind: "message_export_job", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const { id } = parse(ExportIdParamsSchema, request.params);
      const file = await service.download(actorOf(request), id);
      return noStore(reply)
        .header("Content-Disposition", `attachment; filename="${file.filename}"`)
        .header("X-Content-Type-Options", "nosniff")
        .type("application/json; charset=utf-8")
        .send(file.bytes);
    },
  );
}
