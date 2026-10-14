// apps/backend/src/modules/36-messaging/routes/presence-routes.ts - WP 2.12 ephemeral presence and typing.
//
//   POST /api/v1/messaging/channels/:id/presence   { typing? }  heartbeat / typing marker -> 204 (always cheap)
//   GET  /api/v1/messaging/channels/:id/presence                -> { present: string[], typing: string[] } (ids only)
//
// Heartbeat-and-poll over plain HTTP: no new transport. Nothing here touches Postgres; state is ids + a short TTL in the
// PresenceStore (Valkey in production). The channel's own guards (`messaging.read` + the `channel_visibility` predicate on
// `:id`) run BEFORE the flag is read, so a non-member, a removed member, an unknown id and another organisation all get the
// 403 a random id gets (the answer every channel route gives; a denied `channel_visibility` is a 403, never a 404, and the
// two are indistinguishable): presence is no access oracle and the tenant flag is not disclosed to a non-member. The predicate
// is the same one every message read uses, so Part 2 / patient-linked (care_team) gating is identical by construction.
//
// OFF BY A TENANT FLAG (`messaging.presence_enabled`, default off): a member of the channel gets a typed 403
// PRESENCE_DISABLED and nothing is written or read. A store outage never fails the caller: heartbeat answers 204 without
// writing, the read answers empty lists, both log a warning (ids only).
import { DegradedError, UnauthorizedError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type PresenceKind,
  type PresenceStore,
  createInMemoryPresenceStore,
} from "../presence/presence-store";
import { ChannelParamsSchema, parse } from "./messaging-typebox";
import { PresenceHeartbeatBodySchema } from "./presence-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The tenant feature flag that gates the whole feature (default OFF: an absent row reads false). */
export const PRESENCE_FLAG_KEY = "messaging.presence_enabled";

export interface PresenceRouteDeps {
  readonly store?: PresenceStore;
  /** True when the tenant has switched presence on. A throw answers 503 (not 403), so the client retries. */
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  /** Optional per-route rate limit (`createRouteRateLimit`), run after the channel guards. */
  readonly rateLimit?: PreHandler;
}

export interface PresenceGuards {
  readonly read: PreHandler;
  readonly viewChannel: PreHandler;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

async function requireEnabled(
  request: FastifyRequest,
  isEnabled: PresenceRouteDeps["isEnabled"],
  organizationId: string,
): Promise<void> {
  let enabled: boolean;
  try {
    enabled = await isEnabled(organizationId);
  } catch (err) {
    // An unreadable flag is NOT "off": 503 makes the client back off and retry instead of halting for good.
    request.log.warn({ err }, "presence flag unreadable; answering 503");
    throw new DegradedError("presence", "temporarily unavailable");
  }
  if (!enabled) {
    throw new WardenXError(
      "PRESENCE_DISABLED",
      "presence is not enabled for this organisation",
      403,
    );
  }
}

export function registerPresenceRoutes(
  app: FastifyInstance,
  deps: PresenceRouteDeps,
  guards: PresenceGuards,
): void {
  const store = deps.store ?? createInMemoryPresenceStore();
  const preHandler = [
    requireUuidParams("id"),
    guards.read,
    guards.viewChannel,
    ...(deps.rateLimit ? [deps.rateLimit] : []),
  ];

  // The shared web client puts an Idempotency-Key on every mutation and the idempotency middleware would copy each
  // heartbeat into `idempotency_key` (Postgres): opt out, presence must never reach the database.
  app.post(
    "/api/v1/messaging/channels/:id/presence",
    { preHandler, config: { noIdempotencyCapture: true } },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const body = parse(PresenceHeartbeatBodySchema, request.body);
      await requireEnabled(request, deps.isEnabled, organizationId);
      const kinds: PresenceKind[] = body.typing ? ["present", "typing"] : ["present"];
      try {
        for (const kind of kinds) {
          await store.mark({ organizationId, channelId: id }, userId, kind);
        }
      } catch (err) {
        request.log.warn({ err, channelId: id }, "presence store unavailable; heartbeat dropped");
      }
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/v1/messaging/channels/:id/presence",
    {
      preHandler,
      config: {
        auditRead: {
          none: "ephemeral presence: user ids of channel members only, no patient data and no message content",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      await requireEnabled(request, deps.isEnabled, organizationId);
      const scope = { organizationId, channelId: id };
      try {
        const [present, typing] = await Promise.all([
          store.list(scope, "present"),
          store.list(scope, "typing"),
        ]);
        return { present: [...present], typing: [...typing] };
      } catch (err) {
        request.log.warn({ err, channelId: id }, "presence store unavailable; answering empty");
        return { present: [], typing: [] };
      }
    },
  );
}
