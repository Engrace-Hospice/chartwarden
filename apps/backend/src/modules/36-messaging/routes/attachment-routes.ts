// apps/backend/src/modules/36-messaging/routes/attachment-routes.ts — M36 WP 1.5 attachment routes.
//
//   POST /api/v1/messaging/attachments/uploads        authorize an upload (messaging.send; must be able to send in the
//                                                     channel) -> attachmentId + short-lived presigned PUT.
//                                                     429 TOO_MANY_OPEN_UPLOADS past 20 open uploads per user,
//                                                     TOO_MANY_QUARANTINED_UPLOADS past 20 flagged in 24 h, RATE_LIMITED;
//                                                     413 ATTACHMENT_QUOTA_EXCEEDED (per-user / per-org total bytes);
//                                                     409 TENANT_ERASURE_IN_PROGRESS once the org's erase has started.
//   POST /api/v1/messaging/attachments/:id/complete   uploader only; verifies the object landed, then scans
//                                                     (410 UPLOAD_EXPIRED after the upload TTL; 429 RATE_LIMITED)
//   GET  /api/v1/messaging/attachments/:id            uploader only; status (pending|clean|quarantined)
//   GET  /api/v1/messaging/attachments/:id/access     a CURRENT member of a visible channel, scan clean, message live
//                                                     -> a 120 s signed URL; one attachment_access_event per open
//
// Org and actor are always the server-side request context. The two POSTs require an Idempotency-Key (same guard as
// send). None of these routes use the `channel_visibility` ABAC predicate: it keys on a CHANNEL id in the path, and
// here the id is an attachment's (or a body field); the service applies the same rule itself and answers every
// refusal with the 404 a random id gets, so break-glass can never open a quarantined or foreign file.
import { requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AttachmentService } from "../attachments/attachment-service-db";
import { REQUIRE_IDEMPOTENCY_KEY } from "./messaging-routes";
import { AttachmentParamsSchema, AuthorizeAttachmentBodySchema, parse } from "./messaging-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const READ = requirePermission("messaging.read") as PreHandler;
const SEND = requirePermission("messaging.send") as PreHandler;

export interface AttachmentRouteDeps {
  readonly service: AttachmentService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

export function registerAttachmentRoutes(app: FastifyInstance, deps: AttachmentRouteDeps): void {
  const { service } = deps;

  app.post(
    "/api/v1/messaging/attachments/uploads",
    {
      preHandler: [SEND, REQUIRE_IDEMPOTENCY_KEY],
      // The response carries a presigned PUT URL (a bearer credential): it must not be persisted in idempotency_key and
      // replayed (a replay after the TTL would hand back a dead URL with 201). Retry safety is the service's: the same
      // open request re-signs its existing row instead of consuming another slot or quota.
      config: { noIdempotencyCapture: true },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(AuthorizeAttachmentBodySchema, request.body);
      const result = await service.authorize(organizationId, { userId, ...body });
      // The body carries a presigned PUT URL (a bearer credential): never cache it.
      return reply.code(201).header("Cache-Control", "no-store").send(result);
    },
  );

  app.post(
    "/api/v1/messaging/attachments/:id/complete",
    { preHandler: [SEND, REQUIRE_IDEMPOTENCY_KEY] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(AttachmentParamsSchema, request.params);
      const status = await service.complete(organizationId, { userId, attachmentId: id });
      return reply.header("Cache-Control", "no-store").send(status);
    },
  );

  app.get(
    "/api/v1/messaging/attachments/:id",
    {
      preHandler: [READ],
      // Uploader-only: the caller's own just-uploaded file (name, size, scan state). Nothing about any other user's file.
      config: {
        auditRead: {
          none: "uploader-only upload status: the caller's own file metadata and scan state",
        },
      },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(AttachmentParamsSchema, request.params);
      return service.status(organizationId, { userId, attachmentId: id });
    },
  );

  app.get(
    "/api/v1/messaging/attachments/:id/access",
    {
      preHandler: [READ],
      // A resourceIdParam is required, or the read event's resource id is empty and the audit insert is swallowed.
      // The attachment_access_event row (written in the service) is the per-open record; this is the standard read audit.
      config: {
        auditRead: {
          resourceKind: "message_attachment",
          resourceIdParam: "id",
          fields: ["file_download"],
        },
      },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(AttachmentParamsSchema, request.params);
      const access = await service.access(organizationId, { userId, attachmentId: id });
      // The body carries a bearer URL: never cache it.
      return reply.header("Cache-Control", "no-store").send(access);
    },
  );
}
