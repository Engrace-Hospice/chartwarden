// apps/backend/src/bootstrap/plugins/logger.ts — PHI-safe Fastify/Pino logger config (M1 §4.6.1).
//
// The default Fastify request log line includes `req.url` VERBATIM — and patient/global search
// carries the needle in the query string (`/api/v1/patients?q=<name|MRN>`). That would persist PHI
// into application logs (and any log shipper / proxy access log downstream). This module builds the
// logger options that:
//   • log the URL PATH ONLY (query string stripped) so a `?q=…` needle never reaches the logs, and
//   • censor the auth-bearing request headers + the response Set-Cookie (Pino `redact`).
// Request BODIES are not serialized by Fastify's default logging, so no body field is emitted to redact.
import type { FastifyRequest } from "fastify";

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
