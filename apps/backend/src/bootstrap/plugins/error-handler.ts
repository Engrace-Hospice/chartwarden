// apps/backend/src/bootstrap/plugins/error-handler.ts — M1 Fastify error handler
// (spec §4.4; M1-T10).
//
// Renders the ONE error envelope (spec §4.3) for every error path: a thrown WardenXError
// (or any subclass — ValidationError, ForbiddenError, RateLimitedError, DegradedError, …)
// maps to its declared code + statusCode; anything else is an unexpected 500 logged in
// full and returned as a generic INTERNAL_ERROR — internal details are NEVER leaked. The
// correlationId is read off request.context (applyRequestContext) so a client can quote it
// to support and ops can stitch the request across logs/audit/outbox.
import { WardenXError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";

const DOCS_BASE = "https://docs.wardenx.app/errors";

export function applyErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    const correlationId = request.context?.correlationId ?? "unknown";

    if (err instanceof WardenXError) {
      request.log.info({ errCode: err.code, statusCode: err.statusCode }, "handled error");
      return reply.code(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
          correlationId,
          documentationUrl: `${DOCS_BASE}/${err.code}`,
        },
      });
    }

    // Unknown error — log full details, return a generic 500 (no internal leakage).
    request.log.error({ err }, "unhandled error");
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        correlationId,
        documentationUrl: `${DOCS_BASE}/INTERNAL_ERROR`,
      },
    });
  });
}
