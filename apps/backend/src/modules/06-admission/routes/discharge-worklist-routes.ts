// apps/backend/src/modules/06-admission/routes/discharge-worklist-routes.ts — the end-of-episode worklist read
// behind the web "Discharge / transfer" hub:
//
//   GET /api/v1/discharges/worklist?bucket=ready|needs_details|awaiting_cosign|recently_discharged|qio_review_open|nomnc_no_deadline&cursor=&limit=
//
// AUTHORIZATION: `admission.read` for every bucket (the rows are admission facts), plus
// `discharge.cosign_for_cause` for the awaiting-cosign bucket (only a medical director acts on it). The rows are
// narrowed to the caller's caseload exactly like the admission census (GAP-020, `readScope`) — except
// `recently_discharged` (the Readmit list), which an `admission.create` holder also sees at their own site / org-wide
// (`readmissionScope`, admission-routes.ts), mirroring the readmission routes' ABAC.
import { requirePermission } from "@chartwarden/auth";
import { DegradedError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parse } from "./admission-typebox";
import type { DischargeWorklistService } from "./discharge-worklist-service";
import { DischargeWorklistQuerySchema } from "./discharge-worklist-typebox";
import type { AdmissionReadScope } from "./service";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface DischargeWorklistRouteDeps {
  readonly service: DischargeWorklistService | undefined;
  /** The census read scope (caseload narrowing) — shared with GET /admissions. */
  readonly readScope: (request: FastifyRequest) => Promise<AdmissionReadScope>;
  /** `bucket=recently_discharged` (the Readmit list): the census scope widened to what the readmission routes allow. */
  readonly readmissionScope?: (request: FastifyRequest) => Promise<AdmissionReadScope>;
}

const ADMISSION_READ = requirePermission("admission.read") as PreHandler;
const COSIGN = requirePermission("discharge.cosign_for_cause") as PreHandler;
const NOMNC_READ = requirePermission("nomnc.read") as PreHandler;

/** The awaiting-cosign bucket additionally needs the cosign key, the two NOMNC buckets `nomnc.read`; others pass. */
const bucketPermission: PreHandler = async (request, reply) => {
  const bucket = (request.query as { bucket?: unknown } | undefined)?.bucket;
  if (bucket === "awaiting_cosign") await COSIGN(request, reply);
  if (bucket === "qio_review_open" || bucket === "nomnc_no_deadline") await NOMNC_READ(request, reply);
};

export function registerDischargeWorklistRoutes(
  app: FastifyInstance,
  deps: DischargeWorklistRouteDeps,
): void {
  app.get(
    "/api/v1/discharges/worklist",
    {
      preHandler: [ADMISSION_READ, bucketPermission],
      config: { auditRead: { resourceKind: "admission", list: true } },
    },
    async (request) => {
      const organizationId = request.context?.organizationId;
      if (!organizationId || !request.context.userId) throw new UnauthorizedError();
      const query = parse(DischargeWorklistQuerySchema, request.query);
      if (!deps.service) {
        throw new DegradedError("m6.discharge-worklist", "the discharge worklist is not bound");
      }
      const scope =
        query.bucket === "recently_discharged" && deps.readmissionScope
          ? await deps.readmissionScope(request)
          : await deps.readScope(request);
      return deps.service.list(organizationId, query, scope);
    },
  );
}
