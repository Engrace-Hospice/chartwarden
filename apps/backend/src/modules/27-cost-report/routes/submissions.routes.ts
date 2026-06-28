// apps/backend/src/modules/27-cost-report/routes/submissions.routes.ts — M27 (§4.1 ECR submissions).
//
// The MCReF submission plane: list submission attempts, read a submission detail (surfacing the M22-stored
// ECR + PI + supporting-doc IDs as deep links), and RECORD the MAC acknowledgment (an acceptance number XOR
// a rejection code + detail — the DB CHECK is the source of truth; on a rejection the service runs the
// auto-rule-suggestion pipeline). Reads gate `cost_report.read`; recording an acknowledgment gates
// `cost_report.record_acknowledgment` (the §4.6 `inOrg` default — recording a MAC response is not a
// provider-scoped edit). The acknowledgment carries `Idempotency-Key` (§4.1). Org/actor binding server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { P } from "./guards";
import type { M27ReadRouteService } from "./read-service";
import type { M27WriteRouteService } from "./write-service";
import {
  CostReportIdParamsSchema,
  RecordAcknowledgmentBodySchema,
  SubmissionParamsSchema,
  parse,
} from "./cost-report-typebox";

export interface SubmissionRouteDeps {
  readonly readService: M27ReadRouteService;
  readonly writeService: M27WriteRouteService;
}

const READ = P("cost_report.read");
const RECORD_ACK = P("cost_report.record_acknowledgment");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 ECR-submission + acknowledgment routes. */
export function registerSubmissionRoutes(app: FastifyInstance, deps: SubmissionRouteDeps): void {
  const { readService, writeService } = deps;

  // GET /cost-reports/:id/ecr-submissions — list submission attempts. §4.1.
  app.get(
    "/api/v1/cost-reports/:id/ecr-submissions",
    { preHandler: [READ] },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(CostReportIdParamsSchema, request.params);
      return readService.listEcrSubmissions(actor, id);
    },
  );

  // GET /cost-reports/:id/ecr-submissions/:sid — submission detail (M22 artifact deep links). §4.1.
  app.get(
    "/api/v1/cost-reports/:id/ecr-submissions/:sid",
    { preHandler: [READ] },
    async (request) => {
      const actor = actorOf(request);
      const { id, sid } = parse(SubmissionParamsSchema, request.params);
      return readService.getEcrSubmission(actor, id, sid);
    },
  );

  // POST /cost-reports/:id/ecr-submissions/:sid/acknowledgments — record MAC acceptance / rejection. §4.1.
  app.post(
    "/api/v1/cost-reports/:id/ecr-submissions/:sid/acknowledgments",
    { preHandler: [RECORD_ACK, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id, sid } = parse(SubmissionParamsSchema, request.params);
      const body = parse(RecordAcknowledgmentBodySchema, request.body);
      const res = await writeService.recordAcknowledgment(actor, id, sid, {
        mcrefAcknowledgmentNumber: body.mcrefAcknowledgmentNumber,
        mcrefRejectionCode: body.mcrefRejectionCode,
        mcrefRejectionDetail: body.mcrefRejectionDetail,
      });
      return reply.code(200).send(res);
    },
  );
}
