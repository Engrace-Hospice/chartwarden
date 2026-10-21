// apps/backend/src/modules/22-documents/access-log/minio-access-log-routes.ts — `POST /api/v1/webhooks/minio/access-log`
// (GAP-141): the MinIO audit-webhook receiver. MinIO posts its API audit records here (configured through
// `MINIO_AUDIT_WEBHOOK_*` on the minio service in production compose).
//
// AUTH. Server-to-server, no session: the shared bearer token MinIO is configured with
// (`MINIO_AUDIT_WEBHOOK_AUTH_TOKEN_*`) is compared in CONSTANT TIME against `MINIO_ACCESS_LOG_WEBHOOK_TOKEN`
// before the body is read. Unset token => 503 (never "open"). The path sits under `/api/v1/webhooks/`, which is
// exempt from the browser CSRF check by design.
//
// RESPONSES. 200 with counts once the batch is processed (including when every record was dropped as
// unattributed — that is an accepted audit gap, not a delivery failure); 401 on a bad/missing token; 503 when
// unconfigured OR when the database is unavailable (MinIO retries a non-2xx delivery from its own queue).
import { timingSafeEqual } from "node:crypto";
import type { DbClient } from "@wardenx/db";
import { ChartWardenError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { ingestConsumptions, parseConsumptions } from "./minio-access-log";

export interface MinioAccessLogRouteDeps {
  readonly db: DbClient;
  /** `MINIO_ACCESS_LOG_WEBHOOK_TOKEN`; undefined/empty => the route answers 503. */
  readonly token: string | undefined;
  readonly now?: () => Date;
}

/** Constant-time bearer compare that never throws on a length mismatch. */
export function bearerMatches(header: unknown, expected: string): boolean {
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const presented = match?.[1];
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerMinioAccessLogRoute(
  app: FastifyInstance,
  deps: MinioAccessLogRouteDeps,
): void {
  const token = deps.token?.trim();
  if (!token) {
    app.log.warn(
      { event: "m22.minio_access_log.unconfigured" },
      "MINIO_ACCESS_LOG_WEBHOOK_TOKEN is not set: the MinIO access-log webhook answers 503 and records nothing.",
    );
  }
  app.post("/api/v1/webhooks/minio/access-log", async (request, reply) => {
    if (!token) {
      throw new ChartWardenError(
        "WEBHOOK_UNCONFIGURED",
        "the MinIO access-log webhook is not configured",
        503,
      );
    }
    if (!bearerMatches(request.headers.authorization, token)) {
      throw new ChartWardenError("UNAUTHENTICATED", "invalid webhook credentials", 401);
    }
    const consumptions = parseConsumptions(request.body, (deps.now ?? (() => new Date()))());
    const result = await ingestConsumptions(deps.db, consumptions);
    return reply.code(200).send({ received: consumptions.length, ...result });
  });
}
