// apps/backend/src/modules/36-messaging/routes/retention-governance-routes.ts - WP 5.6 (ADR-0086, PROPOSED): message retention and legal hold.
//
//   GET  /api/v1/messaging/governance/retention                          periods (read-only), last scan counts, next scan, pending certificates
//   GET  /api/v1/messaging/governance/legal-holds                        holds with scope ids and held counts
//   POST /api/v1/messaging/governance/legal-holds                        apply (fresh step-up messaging.legal_hold.apply, reason >= 10)
//   GET  /api/v1/messaging/governance/legal-holds/:id/release-preview    what a release makes eligible
//   POST /api/v1/messaging/governance/legal-holds/:id/release            release (fresh step-up messaging.legal_hold.release, reason >= 10,
//                                                                         confirmed count; stale => 409 RELEASE_PREVIEW_STALE)
// All behind messaging.retention.manage. Org, officer and session are the server-side request context; an unknown or another tenant's hold is
// the same 404. Nothing returned is a message or a patient; the only person shown is the placing STAFF member's display name (`placed_by_name`).
import { requirePermission, requireStepUp } from "@chartwarden/auth";
import {
  MESSAGE_LEGAL_HOLD_APPLY_STEP_UP_KEY,
  MESSAGE_LEGAL_HOLD_RELEASE_STEP_UP_KEY,
  MESSAGING_RETENTION_MANAGE_PERMISSION,
  UnauthorizedError,
} from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  GovernanceActor,
  RetentionGovernanceService,
} from "../governance/retention-governance-service";
import { parse } from "./messaging-typebox";
import {
  ApplyHoldBodySchema,
  HoldListResponseSchema,
  HoldParamsSchema,
  HoldResponseSchema,
  ReleaseHoldBodySchema,
  ReleasePreviewResponseSchema,
  RetentionOverviewResponseSchema,
} from "./retention-governance-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const MANAGE = requirePermission(MESSAGING_RETENTION_MANAGE_PERMISSION) as PreHandler;
const APPLY_STEP_UP = requireStepUp(MESSAGE_LEGAL_HOLD_APPLY_STEP_UP_KEY) as PreHandler;
const RELEASE_STEP_UP = requireStepUp(MESSAGE_LEGAL_HOLD_RELEASE_STEP_UP_KEY) as PreHandler;

export interface RetentionGovernanceRouteDeps {
  readonly service: RetentionGovernanceService;
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

export function registerRetentionGovernanceRoutes(
  app: FastifyInstance,
  deps: RetentionGovernanceRouteDeps,
): void {
  const { service } = deps;
  const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store");

  app.get(
    "/api/v1/messaging/governance/retention",
    {
      preHandler: [MANAGE],
      schema: { response: { 200: RetentionOverviewResponseSchema } },
      config: { auditRead: { resourceKind: "message_retention", list: true } },
    },
    async (request, reply) => noStore(reply).send(await service.overview(actorOf(request))),
  );

  app.get(
    "/api/v1/messaging/governance/legal-holds",
    {
      preHandler: [MANAGE],
      schema: { response: { 200: HoldListResponseSchema } },
      config: { auditRead: { resourceKind: "legal_hold", list: true } },
    },
    async (request, reply) => noStore(reply).send(await service.list(actorOf(request))),
  );

  app.post(
    "/api/v1/messaging/governance/legal-holds",
    {
      preHandler: [MANAGE, APPLY_STEP_UP],
      schema: { response: { 201: HoldResponseSchema } },
    },
    async (request, reply) => {
      const body = parse(ApplyHoldBodySchema, request.body);
      return noStore(reply)
        .code(201)
        .send(await service.apply(actorOf(request), body));
    },
  );

  app.get(
    "/api/v1/messaging/governance/legal-holds/:id/release-preview",
    {
      preHandler: [MANAGE],
      schema: { response: { 200: ReleasePreviewResponseSchema } },
      config: { auditRead: { resourceKind: "legal_hold", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const { id } = parse(HoldParamsSchema, request.params);
      return noStore(reply).send(await service.releasePreview(actorOf(request), id));
    },
  );

  app.post(
    "/api/v1/messaging/governance/legal-holds/:id/release",
    {
      preHandler: [MANAGE, RELEASE_STEP_UP],
      schema: { response: { 200: HoldResponseSchema } },
    },
    async (request, reply) => {
      const { id } = parse(HoldParamsSchema, request.params);
      const body = parse(ReleaseHoldBodySchema, request.body);
      return noStore(reply).send(await service.release(actorOf(request), id, body));
    },
  );
}
