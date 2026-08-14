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
import {
  AcknowledgeEventRequest,
  EventIdParams,
  LockMethodologyRequest,
  OpenCapPeriodRequest,
  PeriodIdParams,
  ReopenCapPeriodRequest,
  parse,
  validateParams,
} from "./m26-typebox";
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
  // A cap PERIOD is the agency's own aggregate window (CCN, dates, cap amount, methodology) — no
  // beneficiary is named, so both period reads carry a §2.5 waiver rather than an emission config.
  app.get(
    "/api/v1/cap/periods",
    {
      preHandler: [PERIOD_READ],
      config: {
        auditRead: {
          none: "agency-level cap-period config (CCN, window, cap amount); no patient is named",
        },
      },
    },
    async (request, reply) => reply.send(await readService.listPeriods(actorOf(request))),
  );

  app.post(
    "/api/v1/cap/periods",
    { preHandler: [PERIOD_MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(OpenCapPeriodRequest, request.body);
      const period = await writeService.openPeriod(writeActorOf(request), body);
      return reply.code(201).send(period);
    },
  );

  app.get(
    "/api/v1/cap/periods/:periodId",
    {
      preHandler: [PERIOD_READ],
      config: {
        auditRead: {
          none: "agency-level cap-period config (CCN, window, cap amount); no patient is named",
        },
      },
    },
    async (request, reply) => {
      const period = await readService.getPeriod(actorOf(request), pParam(request, "periodId"));
      if (!period) throw new NotFoundError("cap period not found");
      return reply.send(period);
    },
  );

  app.patch(
    "/api/v1/cap/periods/:periodId/close",
    {
      preHandler: [
        validateParams(PeriodIdParams),
        PERIOD_MANAGE,
        ABAC("cap.period.manage", "cap_period_open"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) =>
      reply.send(
        await writeService.closePeriod(
          writeActorOf(request),
          parse(PeriodIdParams, request.params).periodId,
        ),
      ),
  );

  app.patch(
    "/api/v1/cap/periods/:periodId/reopen",
    {
      preHandler: [
        validateParams(PeriodIdParams),
        PERIOD_MANAGE,
        ABAC("cap.period.manage", "cap_period_settled"),
        STEP_UP("cap.period.manage"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const { periodId } = parse(PeriodIdParams, request.params);
      const body = parse(ReopenCapPeriodRequest, request.body);
      return reply.send(await writeService.reopenPeriod(writeActorOf(request), periodId, body));
    },
  );

  app.post(
    "/api/v1/cap/periods/:periodId/methodology",
    {
      preHandler: [
        validateParams(PeriodIdParams),
        PERIOD_MANAGE,
        ABAC("cap.period.manage", "cap_period_methodology_unlocked"),
        STEP_UP("cap.period.manage"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const { periodId } = parse(PeriodIdParams, request.params);
      const body = parse(LockMethodologyRequest, request.body);
      return reply.send(await writeService.lockMethodology(writeActorOf(request), periodId, body));
    },
  );

  // ── projections ──
  // `ProjectionView.patientId` is nullable: a period's projection list mixes the agency/inpatient
  // aggregates with the PER-BENEFICIARY rows, so this is a §3.4 list read over PHI, not a waiver.
  app.get(
    "/api/v1/cap/projections",
    {
      preHandler: [PROJ_READ],
      config: { auditRead: { resourceKind: "cap_projection", list: true } },
    },
    async (request, reply) =>
      reply.send(
        await readService.listProjections(actorOf(request), qStr(request.query, "periodId") ?? ""),
      ),
  );
  app.get(
    "/api/v1/cap/projections/agency/:periodId",
    {
      preHandler: [PROJ_READ],
      config: {
        auditRead: {
          none: "agency-scope projection: cap totals + beneficiary COUNT; no patient is named",
        },
      },
    },
    async (request, reply) =>
      reply.send(
        await readService.getAgencyProjection(actorOf(request), pParam(request, "periodId")),
      ),
  );
  app.get(
    "/api/v1/cap/projections/patient/:periodId/:patientId",
    {
      preHandler: [PROJ_READ],
      config: {
        auditRead: {
          resourceKind: "cap_projection",
          patientIdParam: "patientId",
          fields: ["paidYtdCents", "projectedYearEndCents", "pctOfCap", "alertBand"],
        },
      },
    },
    async (request, reply) =>
      reply.send(
        await readService.getPatientProjection(
          actorOf(request),
          pParam(request, "periodId"),
          pParam(request, "patientId"),
        ),
      ),
  );
  app.get(
    "/api/v1/cap/projections/inpatient/:periodId",
    {
      preHandler: [PROJ_READ],
      config: {
        auditRead: {
          none: "inpatient-scope projection: aggregate GIP/IRC day counts + pct; no patient is named",
        },
      },
    },
    async (request, reply) =>
      reply.send(
        await readService.getInpatientProjection(actorOf(request), pParam(request, "periodId")),
      ),
  );
  app.post(
    "/api/v1/cap/projections/:periodId/recompute",
    {
      preHandler: [PROJ_RECOMPUTE, ABAC("cap.projection.recompute", "cap_period_open"), IDEMPOTENT],
    },
    async (request, reply) =>
      reply.send(
        await writeService.recompute(
          writeActorOf(request),
          parse(PeriodIdParams, request.params).periodId,
        ),
      ),
  );

  // ── accruals ──
  app.get(
    "/api/v1/cap/accruals/patient/:periodId/:patientId",
    {
      preHandler: [ACCRUAL_READ],
      config: {
        auditRead: {
          resourceKind: "cap_accrual",
          patientIdParam: "patientId",
          fields: [
            "paidCents",
            "outstandingBilledCents",
            "firstElectionInPeriod",
            "lastPaidThrough",
          ],
        },
      },
    },
    async (request, reply) => {
      const view = await readService.getPatientAccrual(
        actorOf(request),
        pParam(request, "periodId"),
        pParam(request, "patientId"),
      );
      if (!view) throw new NotFoundError("patient accrual not found");
      return reply.send(view);
    },
  );
  app.get(
    "/api/v1/cap/accruals/patient/:periodId/:patientId/lines",
    {
      preHandler: [ACCRUAL_READ],
      config: {
        auditRead: { resourceKind: "cap_accrual_line", patientIdParam: "patientId", list: true },
      },
    },
    async (request, reply) =>
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
  app.get(
    "/api/v1/cap/accruals/inpatient/:periodId",
    {
      preHandler: [ACCRUAL_READ],
      config: {
        auditRead: {
          none: "agency-level inpatient day totals for the §418.302(f) cap; no patient is named",
        },
      },
    },
    async (request, reply) =>
      reply.send(
        await readService.getInpatientAccrual(actorOf(request), pParam(request, "periodId")),
      ),
  );

  // ── threshold events ──
  // `ThresholdEventView.patientId` is nullable for the same reason as the projection list: the queue
  // mixes agency-scope band changes with per-beneficiary ones.
  app.get(
    "/api/v1/cap/threshold-events",
    {
      preHandler: [EVENT_READ],
      config: { auditRead: { resourceKind: "cap_threshold_event", list: true } },
    },
    async (request, reply) => {
      const q = request.query;
      return reply.send(
        await readService.listThresholdEvents(actorOf(request), {
          capPeriodId: qStr(q, "periodId"),
          scope: qStr(q, "scope"),
          band: qStr(q, "band"),
          unacknowledgedOnly: qStr(q, "unacknowledgedOnly") === "true",
        }),
      );
    },
  );
  app.patch(
    "/api/v1/cap/threshold-events/:eventId/acknowledge",
    { preHandler: [validateParams(EventIdParams), EVENT_ACK, IDEMPOTENT] },
    async (request, reply) => {
      const { eventId } = parse(EventIdParams, request.params);
      const body = parse(AcknowledgeEventRequest, request.body);
      await writeService.acknowledgeEvent(writeActorOf(request), eventId, body);
      return reply.code(204).send();
    },
  );

  // ── dashboard ──
  // The cap-watch composite embeds `topPatients` (per-beneficiary projections) and `recentEvents`,
  // so the landing screen itself is a PHI read — the one most likely to be opened casually.
  app.get(
    "/api/v1/cap/dashboard",
    {
      preHandler: [PROJ_READ],
      config: { auditRead: { resourceKind: "cap_dashboard", list: true } },
    },
    async (request, reply) => reply.send(await readService.getDashboard(actorOf(request))),
  );
}
