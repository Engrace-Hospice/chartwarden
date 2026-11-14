// apps/backend/src/modules/22-documents/access-log/minio-access-log-routes.ts — object-store audit webhooks
// (GAP-141): the S3-compatible object-store audit receiver. SeaweedFS posts its API audit records here through
// Fluent Bit; the parser also accepts RustFS and legacy MinIO records.
//
// AUTH. Server-to-server, no session: the audit sink bearer is compared in CONSTANT TIME against
// `OBJECT_STORE_AUDIT_WEBHOOK_TOKEN`
// before the body is read. Unset token => 503 (never "open"). The path sits under `/api/v1/webhooks/`, which is
// exempt from the browser CSRF check by design.
//
// RESPONSES. 200 with counts once the batch is processed (including when every record was dropped as
// unattributed — that is an accepted audit gap, not a delivery failure); 401 on a bad/missing token; 503 when
// unconfigured OR when the database is unavailable (MinIO retries a non-2xx delivery from its own queue).
import { timingSafeEqual } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ingestConsumptions, parseConsumptions } from "./minio-access-log";

export interface MinioAccessLogRouteDeps {
  readonly db: DbClient;
  /** Object-store audit bearer; undefined/empty => the route answers 503. */
  readonly token: string | undefined;
  readonly now?: () => Date;
}

/** Prefer the vendor-neutral name while an old release can still roll back on MINIO_*. */
export function objectStoreAuditWebhookTokenFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return env.OBJECT_STORE_AUDIT_WEBHOOK_TOKEN ?? env.MINIO_ACCESS_LOG_WEBHOOK_TOKEN;
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
      "OBJECT_STORE_AUDIT_WEBHOOK_TOKEN is not set: the object-store access-log webhook answers 503 and records nothing.",
    );
  }
  const handleAccessLog = async (body: unknown, authorization: unknown, reply: FastifyReply) => {
    if (!token) {
      throw new ChartWardenError(
        "WEBHOOK_UNCONFIGURED",
        "the object-store access-log webhook is not configured",
        503,
      );
    }
    if (!bearerMatches(authorization, token)) {
      throw new ChartWardenError("UNAUTHENTICATED", "invalid webhook credentials", 401);
    }
    const consumptions = parseConsumptions(body, (deps.now ?? (() => new Date()))());
    const result = await ingestConsumptions(deps.db, consumptions);
    return reply.code(200).send({ received: consumptions.length, ...result });
  };

  // Literal registrations are deliberate: the route/OpenAPI fitness scanners treat these as the source of truth.
  app.post("/api/v1/webhooks/object-store/access-log", async (request, reply) =>
    handleAccessLog(request.body, request.headers.authorization, reply),
  );
  app.post("/api/v1/webhooks/minio/access-log", async (request, reply) =>
    handleAccessLog(request.body, request.headers.authorization, reply),
  );
}
