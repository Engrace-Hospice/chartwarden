// apps/backend/src/bootstrap/plugins/logger.ts — PHI-safe Fastify/Pino logger config (M1 §4.6.1).
//
// The default Fastify request log line includes `req.url` VERBATIM — and patient/global search
// carries the needle in the query string (`/api/v1/patients?q=<name|MRN>`). That would persist PHI
// into application logs (and any log shipper / proxy access log downstream). This module builds the
// logger options that:
//   • log the URL PATH ONLY (query string stripped) so a `?q=…` needle never reaches the logs, and
//   • censor the auth-bearing request headers + the response Set-Cookie (Pino `redact`), and
//   • rebuild a DATABASE error from an allowlist, dropping its bound parameters (F-027 / #65).
// Request BODIES are not serialized by Fastify's default logging, so no body field is emitted to redact.
//
// The third one closes a hole in the first: `log.error({ err }, "unhandled error")` on the catch-all
// path emitted a Drizzle wrapper whose own message embeds the bound parameters, so the needle this
// module had just stripped out of `req.url` was sitting in the field beside it.
import type { FastifyRequest } from "fastify";
import { stdSerializers } from "pino";
import { hasDatabaseErrorInChain, redactDatabaseError } from "../redact-database-error";

/** Auth material + cookies are censored wholesale — never logged raw (defense in depth). */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
] as const;

/** Strip the query string from a URL so PHI carried in `?q=…` never reaches logs/history/proxies. */
export function stripQuery(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Build the Pino options for the Fastify host: PHI-safe request serializer (path-only URL) + a
 * redaction denylist for auth headers/cookies. Pure (reads only `LOG_LEVEL`), so the redaction
 * behavior is unit-testable without standing up a server.
 */
export function buildLoggerOptions() {
  return {
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: [...REDACT_PATHS], censor: "[redacted]" },
    serializers: {
      /**
       * PHI-safe error serializer. A database error — or an ordinary error with one on its `cause`
       * chain — is rebuilt from `redact-database-error.ts`'s allowlist. Everything else keeps Pino's
       * standard shape exactly, so existing log consumers see no change for the ordinary case.
       */
      err(error: Error) {
        return hasDatabaseErrorInChain(error)
          ? (redactDatabaseError(error) ?? stdSerializers.err(error))
          : stdSerializers.err(error);
      },
      req(request: FastifyRequest) {
        return {
          method: request.method,
          // PHI-safe: the path only — the query string can carry a patient name/MRN (search).
          url: typeof request.url === "string" ? stripQuery(request.url) : request.url,
          host: request.headers?.host,
          remoteAddress: request.ip,
        };
      },
    },
  };
}
