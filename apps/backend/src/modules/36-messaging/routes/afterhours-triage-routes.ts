// apps/backend/src/modules/36-messaging/routes/afterhours-triage-routes.ts - ADR-0082 slices S4/S5 (PROPOSED, flag `messaging.afterhours_triage`):
//
//   GET /api/v1/messaging/channels/:id/afterhours-triage?message_ids=<uuid,uuid,...>
//        the fixed-text triage line of those messages that asked M19 for a triage call (messaging.read + channel_visibility).
//
// Read only, no PHI beyond a closed state and a fixed sentence: the line is chosen from the recorded outcome through a closed map and is
// withheld in a restricted channel. Flag off is the uniform 404 (decided in the service). Org and actor come from the request context.
import {
  AFTERHOURS_LINES_MAX_MESSAGES,
  type AfterHoursLinesService,
} from "../afterhours-triage/afterhours-lines";
import { NotFoundError, UnauthorizedError, ValidationError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AfterHoursLinesQuerySchema, AfterHoursLinesResponseSchema } from "./role-send-typebox";
import { ChannelParamsSchema, parse } from "./messaging-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The comma-separated ids as a bounded list of uuids (any other shape is a 422, before a uuid cast can fail in SQL). */
export function parseMessageIds(raw: string): readonly string[] {
  const ids = raw.split(",").map((s) => s.trim());
  if (ids.length > AFTERHOURS_LINES_MAX_MESSAGES || ids.some((id) => !UUID.test(id))) {
    throw new ValidationError("request validation failed", [
      { field: "message_ids", code: "INVALID", message: "up to 50 comma-separated message ids" },
    ]);
  }
  return ids.map((id) => id.toLowerCase());
}

export interface AfterHoursTriageRouteDeps {
  readonly service: AfterHoursLinesService;
  /** Per-user / per-org budget (an availability control); absent = unlimited (tests). */
  readonly rateLimit?: PreHandler | undefined;
}

/** Used when the boot supplies none: the uniform 404. */
export const DISABLED_AFTERHOURS_TRIAGE: AfterHoursTriageRouteDeps = {
  service: {
    forChannel: async () => {
      throw new NotFoundError("channel");
    },
  },
};

export function registerAfterHoursTriageRoutes(
  app: FastifyInstance,
  deps: AfterHoursTriageRouteDeps,
  guards: { readonly read: PreHandler; readonly viewChannel: PreHandler },
): void {
  app.get(
    "/api/v1/messaging/channels/:id/afterhours-triage",
    {
      preHandler: [
        requireUuidParams("id"),
        guards.read,
        guards.viewChannel,
        ...(deps.rateLimit ? [deps.rateLimit] : []),
      ],
      schema: { response: { 200: AfterHoursLinesResponseSchema } },
      config: {
        auditRead: {
          none: "a closed state and a fixed sentence per message; no patient identifier, call content or message text",
        },
      },
    },
    async (request, reply) => {
      const ctx = request.context;
      if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
      const { id } = parse(ChannelParamsSchema, request.params);
      const q = parse(AfterHoursLinesQuerySchema, request.query);
      const out = await deps.service.forChannel(ctx.organizationId, id, parseMessageIds(q.message_ids));
      return reply.header("Cache-Control", "no-store").send(out);
    },
  );
}
