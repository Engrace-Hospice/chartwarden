// apps/backend/src/modules/24-billing-medicaid/routes/admin.routes.ts — M24 (§4.1) the platform-only admin
// surface (routes 37–38). Both gate on the platform-admin permission + §D12 step-up + the §8.6 AI reject +
// §F08 Idempotency-Key. The rule registry is the FROZEN code-defined DEFAULT_MEDICAID_RULES (register is a
// no-op until a dynamic platform-rule store lands); the rate-schedule load delegates to the M40 loader
// (queued no-op until M40 binds) — the M26 platform-constant deferral posture.
import type { FastifyInstance } from "fastify";
import { rejectAiActor, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { P, STEP_UP } from "./guards";
import type { M24WriteService } from "./write-service";

export interface AdminRouteDeps {
  readonly writeService: M24WriteService;
}

const AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  const { writeService } = deps;

  // 37 — register a platform-default Medicaid rule
  app.post(
    "/api/v1/admin/platform-medicaid-rules",
    { preHandler: [P("medicaid.rule_config.platform_admin"), STEP_UP("medicaid.rule_config.platform_admin"), AI, IDEMPOTENT] },
    async (request, reply) => {
      await writeService.registerPlatformRule(writeActorOf(request), request.body as never);
      return reply.code(202).send({ accepted: true });
    },
  );

  // 38 — trigger annual per-state rate-schedule load (delegates to M40)
  app.post(
    "/api/v1/admin/state-rate-schedule-load",
    { preHandler: [P("medicaid.rate_schedule.platform_admin"), STEP_UP("medicaid.rate_schedule.platform_admin"), AI, IDEMPOTENT] },
    async (request, reply) => reply.code(202).send(await writeService.loadRateSchedule(writeActorOf(request), request.body as never)),
  );
}
