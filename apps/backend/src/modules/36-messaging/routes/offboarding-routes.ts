// apps/backend/src/modules/36-messaging/routes/offboarding-routes.ts - WP 5.9 (ADR-0084, PROPOSED): workforce offboarding.
//
//   GET  /api/v1/messaging/governance/offboarding/:userId           dry run: what is left for M36 to do for a departed user (counts only)
//        (messaging.offboarding.manage; audited as m36.offboarding.viewed)
//   POST /api/v1/messaging/governance/offboarding/:userId/execute   do it, then report per item what changed and what still needs a person
//        (messaging.offboarding.manage + messaging.read + messaging.review [the supervisor-reassign keys, ADR-0078] + a fresh step-up for
//         `messaging.offboarding.execute`; audited as m36.offboarding.executed; safe to repeat)
//
// Org, officer and session are the server-side request context. An unknown or another tenant's user is the same 404; a user who has not left
// is a 409. Nothing returned is a name, a message or a patient.
import { requirePermission, requireStepUp } from "@chartwarden/auth";
import {
  OFFBOARDING_EXECUTE_STEP_UP_KEY,
  OFFBOARDING_MANAGE_PERMISSION,
  UnauthorizedError,
} from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { OffboardingService } from "../offboarding/offboarding-service";
import type { OffboardingActor } from "../offboarding/offboarding-types";
import { parse } from "./messaging-typebox";
import { OffboardingParamsSchema, OffboardingResponseSchema } from "./offboarding-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const MANAGE = requirePermission(OFFBOARDING_MANAGE_PERMISSION) as PreHandler;
// The execute step moves acknowledgment requests through the supervisor reassign, whose own route demands these two keys.
const READ = requirePermission("messaging.read") as PreHandler;
const REVIEW = requirePermission("messaging.review") as PreHandler;
const STEP_UP = requireStepUp(OFFBOARDING_EXECUTE_STEP_UP_KEY) as PreHandler;

export interface OffboardingRouteDeps {
  readonly service: OffboardingService;
}

function actorOf(request: FastifyRequest): OffboardingActor {
  const ctx = request.context;
  const sessionId = ctx?.attributes?.sessionId;
  if (!ctx?.organizationId || !ctx.userId || typeof sessionId !== "string" || sessionId === "") {
    throw new UnauthorizedError();
  }
  return { organizationId: ctx.organizationId, userId: ctx.userId, sessionId };
}

export function registerOffboardingRoutes(app: FastifyInstance, deps: OffboardingRouteDeps): void {
  const { service } = deps;

  app.get(
    "/api/v1/messaging/governance/offboarding/:userId",
    {
      preHandler: [MANAGE],
      schema: { response: { 200: OffboardingResponseSchema } },
      config: {
        auditRead: {
          none: "a departed user's offboarding counts for a security officer (counts and fixed keys only); no patient data; the read is audited as m36.offboarding.viewed",
        },
      },
    },
    async (request, reply) => {
      const { userId } = parse(OffboardingParamsSchema, request.params);
      return reply
        .header("Cache-Control", "no-store")
        .send(await service.preview(actorOf(request), userId));
    },
  );

  app.post(
    "/api/v1/messaging/governance/offboarding/:userId/execute",
    {
      preHandler: [MANAGE, READ, REVIEW, STEP_UP],
      schema: { response: { 200: OffboardingResponseSchema } },
    },
    async (request, reply) => {
      const { userId } = parse(OffboardingParamsSchema, request.params);
      return reply
        .header("Cache-Control", "no-store")
        .send(await service.execute(actorOf(request), userId));
    },
  );
}
