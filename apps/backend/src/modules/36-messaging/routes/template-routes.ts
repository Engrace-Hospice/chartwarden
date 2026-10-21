// apps/backend/src/modules/36-messaging/routes/template-routes.ts - M36 WP 2.8 message templates and saved replies.
//
//   GET    /api/v1/messaging/templates                       the caller's picker: platform (overlay applied) + the org's
//                                                            shared + the caller's own           (messaging.send)
//   GET    /api/v1/messaging/templates/:id                   one of those                         (messaging.send)
//   POST   /api/v1/messaging/templates/personal              save a personal reply                (messaging.send)
//   PATCH  /api/v1/messaging/templates/personal/:id          owner only
//   DELETE /api/v1/messaging/templates/personal/:id          owner only
//   GET    /api/v1/messaging/template-admin                  floor + overlay + shared             (messaging.template.manage)
//   POST   /api/v1/messaging/template-admin/shared           author a shared template             (messaging.template.manage)
//   PATCH  /api/v1/messaging/template-admin/shared/:id
//   DELETE /api/v1/messaging/template-admin/shared/:id
//   PUT    /api/v1/messaging/template-admin/platform/:id/overlay     re-word or disable a platform template for this org
//   DELETE /api/v1/messaging/template-admin/platform/:id/overlay     drop the overlay (back to the platform text)
//
// Inserting a template is a client action: the web copies `body` into the composer, the user may edit it, and the message
// is sent through the ordinary send route. Nothing server-side links a message to the template it came from.
// Org and actor are always the server-side request context. A PHI-lint or platform-floor refusal is a 422 that names the
// field and the reason code, never the text.
import { requirePermission } from "@chartwarden/auth";
import type { TemplateService } from "@chartwarden/messaging";
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { REQUIRE_IDEMPOTENCY_KEY } from "./messaging-routes";
import { parse } from "./messaging-typebox";
import {
  CreateTemplateBodySchema,
  PutOverlayBodySchema,
  TemplateParamsSchema,
  UpdateTemplateBodySchema,
} from "./template-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const TEMPLATE_MANAGE_KEY = "messaging.template.manage";
const SEND = requirePermission("messaging.send") as PreHandler;
const MANAGE = requirePermission(TEMPLATE_MANAGE_KEY) as PreHandler;

export interface TemplateRouteDeps {
  readonly service: TemplateService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

export function registerTemplateRoutes(app: FastifyInstance, deps: TemplateRouteDeps): void {
  const { service } = deps;

  app.get(
    "/api/v1/messaging/templates",
    {
      preHandler: [SEND],
      config: {
        auditRead: {
          none: "message templates are plain non-clinical text held to a PHI lint; they never describe a patient",
        },
      },
    },
    async (request) => ({ items: await service.list(actorOf(request)) }),
  );

  app.get(
    "/api/v1/messaging/templates/:id",
    {
      preHandler: [SEND],
      // A resourceIdParam is required, or the read event's resource id is empty and the audit insert is swallowed.
      config: { auditRead: { resourceKind: "message_template", resourceIdParam: "id" } },
    },
    async (request) => {
      const { id } = parse(TemplateParamsSchema, request.params);
      return service.get(actorOf(request), id);
    },
  );

  app.post(
    "/api/v1/messaging/templates/personal",
    { preHandler: [SEND, REQUIRE_IDEMPOTENCY_KEY] },
    async (request, reply) => {
      const body = parse(CreateTemplateBodySchema, request.body);
      return reply.code(201).send(await service.createPersonal(actorOf(request), body));
    },
  );

  app.patch("/api/v1/messaging/templates/personal/:id", { preHandler: [SEND] }, async (request) => {
    const { id } = parse(TemplateParamsSchema, request.params);
    const patch = parse(UpdateTemplateBodySchema, request.body);
    return service.updatePersonal(actorOf(request), id, patch);
  });

  app.delete(
    "/api/v1/messaging/templates/personal/:id",
    { preHandler: [SEND] },
    async (request, reply) => {
      const { id } = parse(TemplateParamsSchema, request.params);
      await service.deletePersonal(actorOf(request), id);
      return reply.code(204).send();
    },
  );

  // ── administration (messaging.template.manage) ──────────────────────────────────────────────────────────────

  app.get(
    "/api/v1/messaging/template-admin",
    {
      preHandler: [MANAGE],
      config: {
        auditRead: {
          none: "template administration view: platform wording, this organisation's overlays and shared templates (non-clinical text)",
        },
      },
    },
    async (request) => service.adminList(actorOf(request)),
  );

  app.post(
    "/api/v1/messaging/template-admin/shared",
    { preHandler: [MANAGE, REQUIRE_IDEMPOTENCY_KEY] },
    async (request, reply) => {
      const body = parse(CreateTemplateBodySchema, request.body);
      return reply.code(201).send(await service.createShared(actorOf(request), body));
    },
  );

  app.patch(
    "/api/v1/messaging/template-admin/shared/:id",
    { preHandler: [MANAGE] },
    async (request) => {
      const { id } = parse(TemplateParamsSchema, request.params);
      const patch = parse(UpdateTemplateBodySchema, request.body);
      return service.updateShared(actorOf(request), id, patch);
    },
  );

  app.delete(
    "/api/v1/messaging/template-admin/shared/:id",
    { preHandler: [MANAGE] },
    async (request, reply) => {
      const { id } = parse(TemplateParamsSchema, request.params);
      await service.deleteShared(actorOf(request), id);
      return reply.code(204).send();
    },
  );

  app.put(
    "/api/v1/messaging/template-admin/platform/:id/overlay",
    { preHandler: [MANAGE] },
    async (request, reply) => {
      const { id } = parse(TemplateParamsSchema, request.params);
      const overlay = parse(PutOverlayBodySchema, request.body);
      await service.putOverlay(actorOf(request), id, overlay);
      return reply.code(204).send();
    },
  );

  app.delete(
    "/api/v1/messaging/template-admin/platform/:id/overlay",
    { preHandler: [MANAGE] },
    async (request, reply) => {
      const { id } = parse(TemplateParamsSchema, request.params);
      await service.deleteOverlay(actorOf(request), id);
      return reply.code(204).send();
    },
  );
}
