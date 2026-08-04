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

/**
 * A Fastify framework error (malformed JSON, an oversized body, an unsupported content-type) — built
 * via `@fastify/error`, which stamps `code`/`statusCode` onto a plain `Error` rather than a distinct
 * class, so `instanceof` can't identify one; a runtime shape check is the only option. `setErrorHandler`
 * types its `error` argument as `unknown` (Fastify's default `TError`), hence the guard.
 */
function asFrameworkError(
  err: unknown,
): { statusCode: number; code: string; message: string } | null {
  if (!(err instanceof Error)) return null;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (typeof statusCode !== "number" || statusCode < 400 || statusCode >= 500) return null;
  const code = (err as { code?: unknown }).code;
  return {
    statusCode,
    code: typeof code === "string" ? code : "BAD_REQUEST",
    message: err.message,
  };
}

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

    // These messages are designed to be shown to the caller, unlike a genuinely unexpected internal
    // error, so pass the real status through instead of collapsing every non-WardenXError into a
    // blanket 500 (API-009).
    const frameworkErr = asFrameworkError(err);
    if (frameworkErr) {
      request.log.info(
        { errCode: frameworkErr.code, statusCode: frameworkErr.statusCode },
        "handled framework error",
      );
      return reply.code(frameworkErr.statusCode).send({
        error: {
          code: frameworkErr.code,
          message: frameworkErr.message,
          correlationId,
          documentationUrl: `${DOCS_BASE}/${frameworkErr.code}`,
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
