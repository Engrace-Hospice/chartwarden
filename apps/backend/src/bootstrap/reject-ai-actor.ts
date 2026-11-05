// apps/backend/src/bootstrap/reject-ai-actor.ts — the billing AI-actor block, shared by M23 (every write route) and
// M35 (the claims-billing add-on grant/cancel), which may not import each other.
import { ForbiddenError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * §D13 AI-BLOCK preHandler — refuse any request whose server-assembled `actor_kind` is an `ai_*` principal
 * BEFORE it reaches a mutating handler. Composed on every M23 write route and the M35 add-on writes. Fail-closed: an unknown/missing
 * actor kind is treated as a user (the kind is only ever `ai_*` when M32 set it), but any `ai_` prefix is
 * rejected with a structured 403. `message` names what the caller is refused (the default is the billing wording).
 */
export function rejectAiActor(
  message = "AI principals cannot create or modify billing records (D13)",
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request) => {
    const kind = request.context?.attributes?.actorKind;
    if (typeof kind === "string" && kind.startsWith("ai_")) {
      throw new ForbiddenError(message);
    }
  };
}
