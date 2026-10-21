// apps/backend/src/bootstrap/plugins/error-handler.ts — M1 Fastify error handler
// (spec §4.4; M1-T10).
//
// Renders the ONE error envelope (spec §4.3) for every error path: a thrown ChartWardenError
// (or any subclass — ValidationError, ForbiddenError, RateLimitedError, DegradedError, …)
// maps to its declared code + statusCode; a Postgres `23505` on a constraint whose meaning is
// registered beside its index (`businessRule()` in @chartwarden/db) maps to 409 carrying that meaning;
// anything else is an unexpected 500 logged in
// full and returned as a generic INTERNAL_ERROR — internal details are NEVER leaked. The
// correlationId is read off request.context (applyRequestContext) so a client can quote it
// to support and ops can stitch the request across logs/audit/outbox.
import { classifyDatabaseError } from "@chartwarden/db";
import { ConflictError, ChartWardenError } from "@chartwarden/types";
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

    if (err instanceof ChartWardenError) {
      // GAP-002 — a request whose session the authenticate hook just expired is anonymous, so its
      // guards throw the ordinary UNAUTHORIZED. Say why, so the client can show "signed out for
      // inactivity" instead of a generic failure. Same 401; only the code and message differ.
      const expired = request.context?.attributes?.sessionExpired;
      if (err.code === "UNAUTHORIZED" && typeof expired === "string") {
        request.log.info({ errCode: "SESSION_EXPIRED", reason: expired }, "handled error");
        return reply.code(err.statusCode).send({
          error: {
            code: "SESSION_EXPIRED",
            message: `Session ended (${expired}); sign in again`,
            details: { reason: expired },
            correlationId,
            documentationUrl: `${DOCS_BASE}/SESSION_EXPIRED`,
          },
        });
      }
      // A 5xx ChartWardenError is a SERVER-side condition the platform declared on purpose — a fail-closed
      // unbound infra port answering DEGRADED, say. It is not a caller error and it is not an
      // unhandled fault, and it has to be readable as neither: `warn` with the full error keeps the
      // diagnosis (which dependency, which operation) in the log, while leaving `error` /
      // "unhandled error" to mean only what it says. A 4xx stays at `info` and carries no `err` —
      // the caller was told.
      if (err.statusCode >= 500) {
        request.log.warn(
          { err, errCode: err.code, statusCode: err.statusCode },
          "handled server error",
        );
      } else {
        request.log.info({ errCode: err.code, statusCode: err.statusCode }, "handled error");
      }
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

    // A UNIQUE index that encodes a business rule somebody wrote down (F-022 / #55). Postgres reports
    // `23505` with the constraint name, Drizzle wraps it, and nothing inspected either — so "you
    // already have an active license for this scale type" arrived as `500 INTERNAL_ERROR / An
    // unexpected error occurred`, and was logged as "unhandled error" beside the genuine faults.
    // Only a constraint whose meaning is REGISTERED beside its index is mapped; anything else falls
    // through to the 500 below unchanged, rather than being guessed at from its name.
    //
    // The raw error is deliberately NOT logged here: a DrizzleQueryError's message embeds the failed
    // query AND its bound parameters, which on most tables is PHI. The constraint name is the whole
    // of what an operator needs, and is safe on its own.
    const businessRule = classifyDatabaseError(err);
    if (businessRule) {
      const conflict = new ConflictError(businessRule.meaning);
      request.log.info(
        {
          errCode: conflict.code,
          statusCode: conflict.statusCode,
          constraint: businessRule.constraint,
        },
        "handled error",
      );
      return reply.code(conflict.statusCode).send({
        error: {
          code: conflict.code,
          message: conflict.message,
          ...(/^visit(?:_|$).*_no_overlap$/.test(businessRule.constraint)
            ? { reason: "CLINICIAN_SCHEDULE_CONFLICT" }
            : {}),
          correlationId,
          documentationUrl: `${DOCS_BASE}/${conflict.code}`,
        },
      });
    }

    // These messages are designed to be shown to the caller, unlike a genuinely unexpected internal
    // error, so pass the real status through instead of collapsing every non-ChartWardenError into a
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
