// apps/backend/src/bootstrap/routes/health.ts — M1 liveness/readiness/version probes
// (spec §4.1–4.2; M1-T10). Unauthenticated by design (§6 permissions matrix).
//
// `/ready` reports per-dependency reachability via an injected ReadinessProbe so M1 owns no
// direct client import; the boot default reports every dependency healthy until the real
// db/Valkey/MinIO clients are wired. 503 when any dependency is down (degraded readiness).
import type { FastifyInstance } from "fastify";

export interface ReadinessChecks {
  readonly db: "ok" | "fail";
  readonly valkey: "ok" | "fail";
  readonly minio: "ok" | "fail";
}

/** Probes each dependency; the boot default reports all-ok (no infra wired in the slice). */
export type ReadinessProbe = () => Promise<ReadinessChecks>;

export const defaultReadinessProbe: ReadinessProbe = async () => ({
  db: "ok",
  valkey: "ok",
  minio: "ok",
});

export function registerHealthRoutes(app: FastifyInstance, probe: ReadinessProbe): void {
  app.get("/health", async (_req, reply) => {
    return reply.code(200).send({ status: "ok" });
  });

  app.get("/ready", async (_req, reply) => {
    const checks = await probe();
    const allOk = Object.values(checks).every((v) => v === "ok");
    return reply.code(allOk ? 200 : 503).send({ status: allOk ? "ready" : "not_ready", checks });
  });

  app.get("/version", async (_req, reply) => {
    return reply.send({
      version: process.env.APP_VERSION ?? "dev",
      gitSha: process.env.GIT_SHA ?? "unknown",
      buildTime: process.env.BUILD_TIME ?? "unknown",
    });
  });
}
