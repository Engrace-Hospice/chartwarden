// apps/backend/src/modules/36-messaging/routes/medication-question-routes.ts - WP 3.10 "Ask a nurse about a medication"
// (ADR-0067).
//
//   POST /api/v1/messaging/channels/:id/medication-questions          send the question + optional read-only medication link
//                                                                     + the nurse's task, atomically   (messaging.send + channel_visibility + Idempotency-Key)
//   GET  /api/v1/messaging/channels/:id/medication-questions/options  who it would go to; flag state   (messaging.read + channel_visibility)
//
// This is never an order path: no order or prescribing permission is read here, and the question text is only handed to
// the service (it is never inspected). The medication link is authorised by the SAME validateRichBodyLinks the send route
// uses (passed in as a closure over the request), so a server-built body widens nothing. Flag off (`messaging.medication_questions`
// AND `messaging.tasks`): POST is the uniform 404; the options read answers 200 `{enabled:false}`. Org and actor are
// always the request context. The Idempotency-Key header is enforced by the shared guard and replayed by the M1 middleware.
import { NotFoundError, UnauthorizedError } from "@wardenx/types";
import type { RichBody } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  MedicationQuestionActorRef,
  MedicationQuestionService,
  ValidateLinks,
} from "../medication-questions/medication-question-service";
import { AskMedicationQuestionBodySchema } from "./medication-question-typebox";
import { ChannelParamsSchema, parse } from "./messaging-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface MedicationQuestionRouteDeps {
  readonly service: MedicationQuestionService;
}

/** The guards and link validator `registerMessagingRoutes` already built (passed in to avoid an import cycle). */
export interface MedicationQuestionRouteGuards {
  readonly read: PreHandler;
  readonly viewChannel: PreHandler;
  readonly send: PreHandler;
  readonly sendToChannel: PreHandler;
  readonly requireIdempotencyKey: PreHandler;
  /** validateRichBodyLinks bound to this request's caller (3.2's exact authorisation). */
  readonly validateLinks: (
    request: FastifyRequest,
    richBody: RichBody | undefined,
  ) => ReturnType<ValidateLinks>;
}

/** Used when the boot supplies none: POST is the uniform 404 and the options read answers disabled. */
export const DISABLED_MEDICATION_QUESTIONS: MedicationQuestionRouteDeps = {
  service: {
    ask: async () => {
      throw new NotFoundError("channel");
    },
    options: async () => ({ enabled: false }),
  },
};

function actorOf(request: FastifyRequest): MedicationQuestionActorRef {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { orgId: ctx.organizationId, userId: ctx.userId };
}

export function registerMedicationQuestionRoutes(
  app: FastifyInstance,
  deps: MedicationQuestionRouteDeps,
  guards: MedicationQuestionRouteGuards,
): void {
  const { service } = deps;

  app.post(
    "/api/v1/messaging/channels/:id/medication-questions",
    {
      preHandler: [
        requireUuidParams("id"),
        guards.send,
        guards.sendToChannel,
        guards.requireIdempotencyKey,
      ],
      config: {
        auditRead: {
          resourceKind: "message",
          resourceIdPayloadPath: "message_id",
          patientIdPayloadPath: "patient_id",
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const body = parse(AskMedicationQuestionBodySchema, request.body);
      const result = await service.ask(
        actor,
        {
          channelId: id,
          text: body.text,
          medicationId: body.medication_id,
          assigneeUserId: body.assignee_user_id,
          allowUnrouted: body.allow_unrouted === true,
          clientMessageId: body.client_message_id,
          correlationId: request.context.correlationId,
        },
        (richBody) => guards.validateLinks(request, richBody),
      );
      return reply.code(result.created ? 201 : 200).send(result);
    },
  );

  app.get(
    "/api/v1/messaging/channels/:id/medication-questions/options",
    {
      preHandler: [requireUuidParams("id"), guards.read, guards.viewChannel],
      config: {
        auditRead: {
          resourceKind: "channel",
          resourceIdParam: "id",
          patientIdPayloadPath: "patient_id",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      return service.options(actor, id);
    },
  );
}
