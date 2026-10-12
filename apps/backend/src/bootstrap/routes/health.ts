// apps/backend/src/bootstrap/routes/health.ts — M1 liveness/readiness/version probes
// (spec §4.1–4.2; M1-T10). Unauthenticated by design (§6 permissions matrix).
//
// `/ready` reports per-dependency reachability via an injected ReadinessProbe so M1 owns no
// direct client import; the boot default reports every dependency healthy until the real
// db/Valkey/MinIO clients are wired. 503 when any dependency is down (degraded readiness).
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

// GAP-114 — the published response contracts of the three unauthenticated probes (spec §4.1–4.2). They sit
// beside the handlers so the shape the route sends and the shape OpenAPI publishes cannot drift.
const CheckState = Type.Union([Type.Literal("ok"), Type.Literal("fail")]);

/** `GET /health` — liveness. */
export const HealthResponseSchema = Type.Object({ status: Type.Literal("ok") });

/** `GET /ready` — readiness; the same body is returned with 503 when any dependency is down. */
export const ReadyResponseSchema = Type.Object({
  status: Type.Union([Type.Literal("ready"), Type.Literal("not_ready")]),
  checks: Type.Object({
    db: CheckState,
    valkey: CheckState,
    minio: CheckState,
    outbox: CheckState,
    capabilities: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Union([Type.Literal("ready"), Type.Literal("disabled"), Type.Literal("degraded")]),
      ),
    ),
  }),
});

/** `GET /version` — build identity (`dev` / `unknown` when the build did not stamp them). */
export const VersionResponseSchema = Type.Object({
  version: Type.String(),
  gitSha: Type.String(),
  buildTime: Type.String(),
});

export interface ReadinessChecks {
  readonly db: "ok" | "fail";
  readonly valkey: "ok" | "fail";
  readonly minio: "ok" | "fail";
  /** TASK-040B — pending-row backlog depth on `outbox_event`; "fail" past a configured ceiling. */
  readonly outbox: "ok" | "fail";
  /** Sanitized product capabilities; disabled is explicit but does not mean the host is unhealthy. */
  readonly capabilities?: Readonly<Record<string, "ready" | "disabled" | "degraded">>;
}

/** Probes each dependency; the boot default reports all-ok (no infra wired in the slice). */
export type ReadinessProbe = () => Promise<ReadinessChecks>;

export const defaultReadinessProbe: ReadinessProbe = async () => ({
  db: "ok",
  valkey: "ok",
  minio: "ok",
  outbox: "ok",
});

export function registerHealthRoutes(app: FastifyInstance, probe: ReadinessProbe): void {
  app.get("/health", async (_req, reply) => {
    return reply.code(200).send({ status: "ok" });
  });

  app.get("/ready", async (_req, reply) => {
    const checks = await probe();
    const allOk = [checks.db, checks.valkey, checks.minio, checks.outbox].every((v) => v === "ok");
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
