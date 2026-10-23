// apps/backend/src/modules/36-messaging/routes/message-redaction-routes.ts - WP 5.6 (ADR-0055 item 7, ADR-0086, PROPOSED): redact a message.
//
//   POST /api/v1/messaging/governance/redactions                 request (messaging.redact.request; message_id + reason >= 10)
//   GET  /api/v1/messaging/governance/redactions                 list (either permission)
//   POST /api/v1/messaging/governance/redactions/:id/approve     approve (messaging.redact.approve + fresh step-up; never the requester)
//   POST /api/v1/messaging/governance/redactions/:id/self-approve   single-officer fallback (PROVISIONAL, off by default per tenant): the sole
//                                                                 eligible officer approves their own request; masks nothing yet
//   POST /api/v1/messaging/governance/redactions/:id/countersign   a SECOND role (messaging.redact.countersign + fresh step-up) makes it final within 72 h
//
// A redaction masks the message for every reader once approved and never destroys the cipher, so an active legal hold does not block it.
// Org, officer and session are the server-side request context; an unknown or another tenant's message or redaction is the same 404. The
// responses carry ids, staff names, instants and a hold flag: never the message body or the reason text.
import { requirePermission, requireStepUp, resolveActorPermissions } from "@chartwarden/auth";
import {
  ForbiddenError,
  MESSAGE_REDACT_APPROVE_STEP_UP_KEY,
  MESSAGE_REDACT_COUNTERSIGN_STEP_UP_KEY,
  MESSAGE_REDACT_SELF_APPROVE_STEP_UP_KEY,
  MESSAGING_REDACT_APPROVE_PERMISSION,
  MESSAGING_REDACT_COUNTERSIGN_PERMISSION,
  MESSAGING_REDACT_REQUEST_PERMISSION,
  UnauthorizedError,
} from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { MessageRedactionService } from "../governance/message-redaction-service";
import type { GovernanceActor } from "../governance/retention-governance-service";
import { parse } from "./messaging-typebox";
import {
  RedactionListResponseSchema,
  RedactionParamsSchema,
  RedactionResponseSchema,
  RequestRedactionBodySchema,
} from "./retention-governance-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const REQUEST = requirePermission(MESSAGING_REDACT_REQUEST_PERMISSION) as PreHandler;
const APPROVE = requirePermission(MESSAGING_REDACT_APPROVE_PERMISSION) as PreHandler;
const APPROVE_STEP_UP = requireStepUp(MESSAGE_REDACT_APPROVE_STEP_UP_KEY) as PreHandler;
const SELF_APPROVE_STEP_UP = requireStepUp(MESSAGE_REDACT_SELF_APPROVE_STEP_UP_KEY) as PreHandler;
const COUNTERSIGN = requirePermission(MESSAGING_REDACT_COUNTERSIGN_PERMISSION) as PreHandler;
const COUNTERSIGN_STEP_UP = requireStepUp(MESSAGE_REDACT_COUNTERSIGN_STEP_UP_KEY) as PreHandler;

/** Any of the three permissions may read the list (a requester follows their own request; an approver works the queue; a countersigner finds what awaits them). */
const EITHER: PreHandler = async (request) => {
  const ctx = request.context;
  if (!ctx?.organizationId) throw new UnauthorizedError();
  const granted = await resolveActorPermissions(ctx);
  if (
    !granted.has(MESSAGING_REDACT_REQUEST_PERMISSION) &&
    !granted.has(MESSAGING_REDACT_APPROVE_PERMISSION) &&
    !granted.has(MESSAGING_REDACT_COUNTERSIGN_PERMISSION)
  ) {
    throw new ForbiddenError(
      `requires permission '${MESSAGING_REDACT_REQUEST_PERMISSION}', '${MESSAGING_REDACT_APPROVE_PERMISSION}' or '${MESSAGING_REDACT_COUNTERSIGN_PERMISSION}'`,
    );
  }
};

export interface MessageRedactionRouteDeps {
  readonly service: MessageRedactionService;
}

function actorOf(request: FastifyRequest): GovernanceActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    auditContext: {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      actorKind: "user",
      actorRole: ctx.roles[0],
      correlationId: ctx.correlationId,
      requestId: String(request.id),
      sourceIp: ctx.ip,
      userAgent: ctx.userAgent,
    },
  };
}

export function registerMessageRedactionRoutes(
  app: FastifyInstance,
  deps: MessageRedactionRouteDeps,
): void {
  const { service } = deps;
  const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store");

  app.post(
    "/api/v1/messaging/governance/redactions",
    { preHandler: [REQUEST], schema: { response: { 201: RedactionResponseSchema } } },
    async (request, reply) => {
      const body = parse(RequestRedactionBodySchema, request.body);
      return noStore(reply)
        .code(201)
        .send(await service.request(actorOf(request), body));
    },
  );

  app.get(
    "/api/v1/messaging/governance/redactions",
    {
      preHandler: [EITHER],
      schema: { response: { 200: RedactionListResponseSchema } },
      config: { auditRead: { resourceKind: "message_redaction", list: true } },
    },
    async (request, reply) => noStore(reply).send(await service.list(actorOf(request))),
  );

  app.post(
    "/api/v1/messaging/governance/redactions/:id/approve",
    {
      preHandler: [APPROVE, APPROVE_STEP_UP],
      schema: { response: { 200: RedactionResponseSchema } },
    },
    async (request, reply) => {
      const { id } = parse(RedactionParamsSchema, request.params);
      return noStore(reply).send(await service.approve(actorOf(request), id));
    },
  );

  app.post(
    "/api/v1/messaging/governance/redactions/:id/self-approve",
    {
      preHandler: [APPROVE, SELF_APPROVE_STEP_UP],
      schema: { response: { 200: RedactionResponseSchema } },
    },
    async (request, reply) => {
      const { id } = parse(RedactionParamsSchema, request.params);
      return noStore(reply).send(await service.selfApprove(actorOf(request), id));
    },
  );

  app.post(
    "/api/v1/messaging/governance/redactions/:id/countersign",
    {
      preHandler: [COUNTERSIGN, COUNTERSIGN_STEP_UP],
      schema: { response: { 200: RedactionResponseSchema } },
    },
    async (request, reply) => {
      const { id } = parse(RedactionParamsSchema, request.params);
      return noStore(reply).send(await service.countersign(actorOf(request), id));
    },
  );
}
