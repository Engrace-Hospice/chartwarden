// apps/backend/src/modules/33-reporting/routes/schedules.routes.ts — M33 (§4.1 #22–#31).
//
// The scheduled-delivery pipeline surface (D7): list/create/read/edit a `report_schedule`, pause / resume
// / cancel it, bulk-delete its run history, and read the run ledger. Create + edit enforce the §2.3 domain
// rules in the service (CRON_TOO_FREQUENT ≥ 5-min cadence, RECIPIENT_NOT_IN_ORG, PDF_ROW_LIMIT_EXCEEDED).
// Every route is gated by the REAL Authorization Contract (`requirePermission` from @wardenx/auth, M3) on
// the §4.6 `report.schedule.*` keys — all carry `abac:"none"` in the catalog, so `requirePermission` is the
// authoritative gate (the route-table's `dashboard_visibility` / `org_admin_scope` intent is carried by the
// M3 role assignment + the service's ownership check; M33 owns only `reportable_scope` +
// `dashboard_visibility` as named predicates — the admin/definitions precedent).
//
// #29 delete_all_runs is the narrowest sensitive surface (bulk run-history / recipient-PII cleanup): it
// additionally requires a recent M2 SESSION_POLICY STEP-UP (`requireStepUp`, the M34 D10 precedent) on top
// of `report.schedule.delete_all_runs` (org-admin-carried). MUTATIONS run through the injected service →
// ONE `withOrgContext` tx on the PRIMARY (RLS scopes to `app.org_id`); each carries `requireIdempotencyKey`.
// READS disclose the actor's own org schedules / runs; the M4 write-audit trigger on the `withOrgContext`
// path is the §164.312(b) anchor. Org/actor binding is ALWAYS server-side (request.context, never the body).
import { requirePermission, requireStepUp } from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { parse } from "./reporting-typebox";
import type { M33WriteRouteService } from "./write-service";
import {
  ScheduleIdParams,
  ScheduleListQuery,
  ScheduleRunIdParams,
  ScheduleRunListQuery,
  ScheduledReportCreate,
  UpdateScheduleRequest,
} from "./write-typebox";

export interface ScheduleRouteDeps {
  readonly service: M33WriteRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const SCH_LIST = P("report.schedule.list");
const SCH_WRITE = P("report.schedule.write");
const SCH_READ = P("report.schedule.read");
const SCH_CANCEL = P("report.schedule.cancel");
const SCH_DELETE_RUNS = P("report.schedule.delete_all_runs");
// §6/D10 step-up: the bulk run-history/PII cleanup requires a recent step-up (the op key drives M3-T07's
// per-operation freshness policy).
const STEPUP_DELETE_RUNS = requireStepUp("report.schedule.delete_all_runs") as PreHandler;
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 scheduled-report routes (#22–#31). */
export function registerScheduleRoutes(app: FastifyInstance, deps: ScheduleRouteDeps): void {
  const { service } = deps;

  // 22 — list schedules (filter status; cursor-paginated). §4.1.
  app.get("/api/v1/reporting/schedules", { preHandler: [SCH_LIST] }, async (request) => {
    const actor = writeActorOf(request);
    const q = parse(ScheduleListQuery, request.query);
    return service.listSchedules(actor, { status: q.status }, q.cursor, q.limit);
  });

  // 23 — create a schedule (§2.3 CRON_TOO_FREQUENT / RECIPIENT_NOT_IN_ORG / PDF_ROW_LIMIT_EXCEEDED). §4.1.
  app.post(
    "/api/v1/reporting/schedules",
    { preHandler: [SCH_WRITE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(ScheduledReportCreate, request.body);
      const res = await service.createSchedule(actor, {
        reportViewId: body.reportViewId,
        cronExpression: body.cronExpression,
        tenantTimezone: body.tenantTimezone,
        format: body.format,
        recipientMembershipIds: body.recipientMembershipIds,
      });
      return reply.code(201).send(res);
    },
  );

  // 24 — read one schedule. §4.1.
  app.get("/api/v1/reporting/schedules/:id", { preHandler: [SCH_READ] }, async (request) => {
    const actor = writeActorOf(request);
    const { id } = parse(ScheduleIdParams, request.params);
    return service.getSchedule(actor, id);
  });

  // 25 — edit a schedule (re-validates the §2.3 rules on the changed fields). §4.1/§4.2.
  app.patch(
    "/api/v1/reporting/schedules/:id",
    { preHandler: [SCH_WRITE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ScheduleIdParams, request.params);
      const body = parse(UpdateScheduleRequest, request.body);
      const res = await service.updateSchedule(actor, id, {
        cronExpression: body.cronExpression,
        tenantTimezone: body.tenantTimezone,
        format: body.format,
        recipientMembershipIds: body.recipientMembershipIds,
      });
      return reply.code(200).send(res);
    },
  );

  // 26 — pause a schedule (clears next_run_at). §4.1.
  app.post(
    "/api/v1/reporting/schedules/:id/pause",
    { preHandler: [SCH_WRITE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ScheduleIdParams, request.params);
      const res = await service.pauseSchedule(actor, id);
      return reply.code(201).send(res);
    },
  );

  // 27 — resume a paused schedule (recomputes next_run_at). §4.1.
  app.post(
    "/api/v1/reporting/schedules/:id/resume",
    { preHandler: [SCH_WRITE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ScheduleIdParams, request.params);
      const res = await service.resumeSchedule(actor, id);
      return reply.code(201).send(res);
    },
  );

  // 28 — cancel a schedule (terminal). §4.1.
  app.post(
    "/api/v1/reporting/schedules/:id/cancel",
    { preHandler: [SCH_CANCEL, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ScheduleIdParams, request.params);
      const res = await service.cancelSchedule(actor, id);
      return reply.code(201).send(res);
    },
  );

  // 29 — bulk-delete the schedule's run history (STEP-UP + org-admin; D11/§12.4). §4.1.
  app.post(
    "/api/v1/reporting/schedules/:id/delete_all_runs",
    { preHandler: [SCH_DELETE_RUNS, STEPUP_DELETE_RUNS, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ScheduleIdParams, request.params);
      const res = await service.deleteAllRuns(actor, id);
      return reply.code(200).send(res);
    },
  );

  // 30 — read a schedule's run ledger (newest first; cursor-paginated). §4.1.
  app.get("/api/v1/reporting/schedules/:id/runs", { preHandler: [SCH_READ] }, async (request) => {
    const actor = writeActorOf(request);
    const { id } = parse(ScheduleIdParams, request.params);
    const q = parse(ScheduleRunListQuery, request.query);
    return service.listScheduleRuns(actor, id, q.cursor, q.limit);
  });

  // 31 — read one run by id (the M22 document back-ref + failure telemetry). §4.1.
  app.get(
    "/api/v1/reporting/schedules/runs/:runId",
    { preHandler: [SCH_READ] },
    async (request) => {
      const actor = writeActorOf(request);
      const { runId } = parse(ScheduleRunIdParams, request.params);
      return service.getScheduleRun(actor, runId);
    },
  );
}
