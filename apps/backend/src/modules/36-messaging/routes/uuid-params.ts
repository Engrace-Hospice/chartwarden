// apps/backend/src/modules/36-messaging/routes/uuid-params.ts - a first preHandler for routes whose path ids reach a
// Postgres uuid cast. A malformed id answers the same 404 a random id gets, BEFORE the channel_visibility predicate or
// a service query can raise a cast error (which would surface as a 500 and tell a prober the id shape matters).
import { NotFoundError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuidParams(
  ...names: readonly string[]
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request) => {
    const params = (request.params ?? {}) as Record<string, unknown>;
    for (const name of names) {
      const value = params[name];
      if (typeof value !== "string" || !UUID.test(value)) {
        throw new NotFoundError(name === "id" ? "channel" : "message", String(value));
      }
    }
  };
}
