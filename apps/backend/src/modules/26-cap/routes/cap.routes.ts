// apps/backend/src/modules/26-cap/routes/cap.routes.ts — M26 (§4.1) the operational + period-lifecycle
// surface: cap-period list/detail/open/close/reopen/methodology, projection reads + recompute, accrual
// reads, the threshold-event queue + acknowledge, and the cap-watch dashboard composite. Reads gate on the
// §4.6 key; the lifecycle mutations compose the §4.7 ABAC predicate over `:periodId` and the §D12 step-up
// on methodology-lock / reopen. Org/actor binding is server-side (actorOf/writeActorOf).
import { NotFoundError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { clampLimit, requireIdempotencyKey } from "./concurrency";
import { ABAC, P, STEP_UP } from "./guards";
import type { M26ReadService } from "./read-service";
import type { M26WriteService } from "./write-service";

export interface CapRouteDeps {
  readonly readService: M26ReadService;
  readonly writeService: M26WriteService;
}

const PERIOD_READ = P("cap.period.read");
const PERIOD_MANAGE = P("cap.period.manage");
const PROJ_READ = P("cap.projection.read");
const PROJ_RECOMPUTE = P("cap.projection.recompute");
const ACCRUAL_READ = P("cap.accrual.read");
const EVENT_READ = P("cap.event.read");
const EVENT_ACK = P("cap.event.acknowledge");
const IDEMPOTENT = requireIdempotencyKey();

const qStr = (q: unknown, key: string): string | undefined => {
  const v = (q as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};
const pParam = (request: { params: unknown }, key: string): string =>
  (request.params as Record<string, string>)[key] ?? "";

export function registerCapRoutes(app: FastifyInstance, deps: CapRouteDeps): void {
  const { readService, writeService } = deps;

  // ── cap periods ──
  app.get("/api/v1/cap/periods", { preHandler: [PERIOD_READ] }, async (request, reply) =>
    reply.send(await readService.listPeriods(actorOf(request))),
  );

  app.post(
    "/api/v1/cap/periods",
    { preHandler: [PERIOD_MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = request.body as { capYear: string; methodology?: "streamlined" | "proportional"; graceWindowDays?: number };
      const period = await writeService.openPeriod(writeActorOf(request), body);
      return reply.code(201).send(period);
    },
  );

  app.get("/api/v1/cap/periods/:periodId", { preHandler: [PERIOD_READ] }, async (request, reply) => {
    const period = await readService.getPeriod(actorOf(request), pParam(request, "periodId"));
    if (!period) throw new NotFoundError("cap period not found");
    return reply.send(period);
  });

  app.patch(
    "/api/v1/cap/periods/:periodId/close",
    { preHandler: [PERIOD_MANAGE, ABAC("cap.period.manage", "cap_period_open"), IDEMPOTENT] },
    async (request, reply) => reply.send(await writeService.closePeriod(writeActorOf(request), pParam(request, "periodId"))),
  );

  app.patch(
    "/api/v1/cap/periods/:periodId/reopen",
    { preHandler: [PERIOD_MANAGE, ABAC("cap.period.manage", "cap_period_settled"), STEP_UP("cap.period.manage"), IDEMPOTENT] },
    async (request, reply) => {
      const body = (request.body ?? {}) as { reason: string };
      return reply.send(await writeService.reopenPeriod(writeActorOf(request), pParam(request, "periodId"), body));
    },
  );

  app.post(
    "/api/v1/cap/periods/:periodId/methodology",
    { preHandler: [PERIOD_MANAGE, ABAC("cap.period.manage", "cap_period_methodology_unlocked"), STEP_UP("cap.period.manage"), IDEMPOTENT] },
    async (request, reply) => {
      const body = request.body as { methodology: "streamlined" | "proportional"; reason: string };
      return reply.send(await writeService.lockMethodology(writeActorOf(request), pParam(request, "periodId"), body));
    },
  );

  // ── projections ──
  app.get("/api/v1/cap/projections", { preHandler: [PROJ_READ] }, async (request, reply) =>
    reply.send(await readService.listProjections(actorOf(request), qStr(request.query, "periodId") ?? "")),
  );
  app.get("/api/v1/cap/projections/agency/:periodId", { preHandler: [PROJ_READ] }, async (request, reply) =>
    reply.send(await readService.getAgencyProjection(actorOf(request), pParam(request, "periodId"))),
  );
  app.get("/api/v1/cap/projections/patient/:periodId/:patientId", { preHandler: [PROJ_READ] }, async (request, reply) =>
    reply.send(
      await readService.getPatientProjection(actorOf(request), pParam(request, "periodId"), pParam(request, "patientId")),
    ),
  );
  app.get("/api/v1/cap/projections/inpatient/:periodId", { preHandler: [PROJ_READ] }, async (request, reply) =>
    reply.send(await readService.getInpatientProjection(actorOf(request), pParam(request, "periodId"))),
  );
  app.post(
    "/api/v1/cap/projections/:periodId/recompute",
    { preHandler: [PROJ_RECOMPUTE, ABAC("cap.projection.recompute", "cap_period_open"), IDEMPOTENT] },
    async (request, reply) => reply.send(await writeService.recompute(writeActorOf(request), pParam(request, "periodId"))),
  );

  // ── accruals ──
  app.get("/api/v1/cap/accruals/patient/:periodId/:patientId", { preHandler: [ACCRUAL_READ] }, async (request, reply) => {
    const view = await readService.getPatientAccrual(actorOf(request), pParam(request, "periodId"), pParam(request, "patientId"));
    if (!view) throw new NotFoundError("patient accrual not found");
    return reply.send(view);
  });
  app.get("/api/v1/cap/accruals/patient/:periodId/:patientId/lines", { preHandler: [ACCRUAL_READ] }, async (request, reply) =>
    reply.send(
      await readService.listAccrualLines(
        actorOf(request),
        pParam(request, "periodId"),
        pParam(request, "patientId"),
        qStr(request.query, "cursor"),
        clampLimit(qStr(request.query, "limit")),
      ),
    ),
  );
  app.get("/api/v1/cap/accruals/inpatient/:periodId", { preHandler: [ACCRUAL_READ] }, async (request, reply) =>
    reply.send(await readService.getInpatientAccrual(actorOf(request), pParam(request, "periodId"))),
  );

  // ── threshold events ──
  app.get("/api/v1/cap/threshold-events", { preHandler: [EVENT_READ] }, async (request, reply) => {
    const q = request.query;
    return reply.send(
      await readService.listThresholdEvents(actorOf(request), {
        capPeriodId: qStr(q, "periodId"),
        scope: qStr(q, "scope"),
        band: qStr(q, "band"),
        unacknowledgedOnly: qStr(q, "unacknowledgedOnly") === "true",
      }),
    );
  });
  app.patch(
    "/api/v1/cap/threshold-events/:eventId/acknowledge",
    { preHandler: [EVENT_ACK, IDEMPOTENT] },
    async (request, reply) => {
      const body = (request.body ?? {}) as { notes?: string };
      await writeService.acknowledgeEvent(writeActorOf(request), pParam(request, "eventId"), body);
      return reply.code(204).send();
    },
  );

  // ── dashboard ──
  app.get("/api/v1/cap/dashboard", { preHandler: [PROJ_READ] }, async (request, reply) =>
    reply.send(await readService.getDashboard(actorOf(request))),
  );
}
