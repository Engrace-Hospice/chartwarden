// apps/backend/src/modules/27-cost-report/routes/compliance.routes.ts — M27 (§4.1 compliance window).
//
// The filing-deadline compliance window: read the window state (deadline, current effective deadline, the
// last-emitted alert tier) and RECORD a MAC-granted deadline extension (updates `current_effective_deadline_
// date`). The read gates `cost_report.read`; the extension composes `cost_report_editor_for_provider` (§4.7)
// over the `:id` (recording the MAC grant is a draft-surface edit). M27 carries NO PHI (D18). The extension
// carries `Idempotency-Key` (§4.1). Org/actor binding server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { EDITOR_FOR_PROVIDER, P } from "./guards";
import type { M27ReadRouteService } from "./read-service";
import type { M27WriteRouteService } from "./write-service";
import { CostReportIdParamsSchema, DeadlineExtensionBodySchema, parse } from "./cost-report-typebox";

export interface ComplianceRouteDeps {
  readonly readService: M27ReadRouteService;
  readonly writeService: M27WriteRouteService;
}

const READ = P("cost_report.read");
const EDIT = P("cost_report.edit");
const EDIT_ABAC = EDITOR_FOR_PROVIDER("cost_report.edit");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 compliance-window + deadline-extension routes. */
export function registerComplianceRoutes(app: FastifyInstance, deps: ComplianceRouteDeps): void {
  const { readService, writeService } = deps;

  // GET /cost-reports/:id/compliance-window — read the filing-deadline window state (or null). §4.1.
  app.get(
    "/api/v1/cost-reports/:id/compliance-window",
    { preHandler: [READ] },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      return readService.getComplianceWindow(actor, id);
    },
  );

  // POST /cost-reports/:id/deadline-extensions — record a MAC-granted extension. §4.1.
  app.post(
    "/api/v1/cost-reports/:id/deadline-extensions",
    { preHandler: [EDIT, EDIT_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      const body = parse(DeadlineExtensionBodySchema, request.body);
      const res = await writeService.recordDeadlineExtension(actor, id, {
        newEffectiveDeadlineDate: body.newEffectiveDeadlineDate,
      });
      return reply.code(201).send(res);
    },
  );
}
