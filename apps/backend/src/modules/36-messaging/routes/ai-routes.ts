// apps/backend/src/modules/36-messaging/routes/ai-routes.ts - WP 6.5 (ADR-0095, PROPOSED, flag `messaging.ai.enabled`, absent = off):
//
//   GET  /api/v1/messaging/ai/status                       {enabled}: tenant flag AND the caller's `messaging.ai.use` (the web hides the panel when false)
//   POST /api/v1/messaging/channels/:id/summaries          [{thread_root_message_id?}]  an AI summary of what the caller can read   (messaging.ai.use + messaging.read + channel_visibility)
//   POST /api/v1/messaging/channels/:id/draft-replies      [{thread_root_message_id?}]  up to two draft replies for the COMPOSER    (messaging.ai.use + messaging.send + channel_visibility)
//   POST /api/v1/messaging/channels/:id/ai-outcomes        {invocation_id, invoked_at, outcome}  the human decision, accepted | edited | rejected
//
// Nothing here sends, stores or queues anything: a summary or draft is the response body and nothing else. The channel guards are the MEMBERSHIP
// predicate (`channel_visibility`), never the break-glass read variant: a break-glass grant does not open AI. Flag off => typed AI_NOT_ENABLED (404),
// decided in the service after the guards. Responses are `no-store`. No Idempotency-Key is required or honoured: a replayed cached body would be a
// server-side copy of a summary, which ADR-0095 section 7 forbids.
import { NotFoundError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AiService } from "../ai/ai-service";
import {
  AiDraftResponseSchema,
  AiOutcomeBodySchema,
  AiRequestBodySchema,
  AiStatusResponseSchema,
  AiSummaryResponseSchema,
} from "./ai-typebox";
import { ChannelParamsSchema, parse } from "./messaging-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AiRouteDeps {
  readonly service: AiService;
  /** Per-user / per-org budget (an availability control; the quotas that matter are in the service); absent = unlimited (tests). */
  readonly rateLimit?: PreHandler | undefined;
}

/** Used when the boot supplies none: the panel is absent and every call is the uniform 404. */
export const DISABLED_AI: AiRouteDeps = {
  service: {
    enabledFor: async () => false,
    summarize: async () => {
      throw new NotFoundError("channel");
    },
    draftReply: async () => {
      throw new NotFoundError("channel");
    },
    recordOutcome: async () => {
      throw new NotFoundError("channel");
    },
  },
};

export function registerAiRoutes(
  app: FastifyInstance,
  deps: AiRouteDeps,
  guards: {
    readonly read: PreHandler;
    readonly viewChannel: PreHandler;
    readonly sendToChannel: PreHandler;
    readonly useAi: PreHandler;
  },
): void {
  const limited: PreHandler[] = deps.rateLimit ? [deps.rateLimit] : [];
  const actorOf = (request: FastifyRequest) => {
    const ctx = request.context;
    if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
    return { orgId: ctx.organizationId, userId: ctx.userId };
  };
  const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store");

  app.get(
    "/api/v1/messaging/ai/status",
    {
      preHandler: [guards.read, ...limited],
      schema: { response: { 200: AiStatusResponseSchema } },
      config: {
        auditRead: {
          none: "a single boolean about the tenant flag and the caller's own permission; no patient, channel or message",
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const enabled = await deps.service.enabledFor(actor.orgId, actor.userId);
      return noStore(reply).send({ enabled });
    },
  );

  app.post(
    "/api/v1/messaging/channels/:id/summaries",
    {
      preHandler: [requireUuidParams("id"), guards.useAi, guards.viewChannel, ...limited],
      schema: { response: { 200: AiSummaryResponseSchema } },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const body = parse(AiRequestBodySchema, request.body ?? {});
      return noStore(reply).send(
        await deps.service.summarize(actor, id, body.thread_root_message_id ?? null),
      );
    },
  );

  app.post(
    "/api/v1/messaging/channels/:id/draft-replies",
    {
      preHandler: [requireUuidParams("id"), guards.useAi, guards.sendToChannel, ...limited],
      schema: { response: { 200: AiDraftResponseSchema } },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const body = parse(AiRequestBodySchema, request.body ?? {});
      return noStore(reply).send(
        await deps.service.draftReply(actor, id, body.thread_root_message_id ?? null),
      );
    },
  );

  app.post(
    "/api/v1/messaging/channels/:id/ai-outcomes",
    {
      preHandler: [requireUuidParams("id"), guards.useAi, guards.viewChannel, ...limited],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const body = parse(AiOutcomeBodySchema, request.body);
      await deps.service.recordOutcome(actor, id, {
        invocationId: body.invocation_id,
        invokedAt: body.invoked_at,
        outcome: body.outcome,
      });
      return noStore(reply).code(204).send();
    },
  );
}
