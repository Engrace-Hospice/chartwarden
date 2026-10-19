// apps/backend/src/modules/36-messaging/routes/oncall-routes.ts - WP 4.12 (ADR-0080).
//
//   GET /api/v1/messaging/oncall/coverage?role&patient_id   who is covering now for a role (read-only; messaging.read + messaging.oncall.read)
//
// `patient_id` selects a patient's care team (a patient-to-clinician association), so the caller must pass the same gate as the chart
// care_team tile: `patient.read` + `caseload_or_scope` on that patient, no break-glass. A patient the caller cannot see, or one outside
// the organisation, is the uniform 404 and the router is never asked. A patient that does not exist in the organisation gets the identical 404
// (`caseload_or_scope` is true for any well-formed id when the caller has an org-wide scope role, so existence is checked after it). Every
// check is a preHandler: a refusal never reaches the router or the read audit. The read is audited against the patient (`patientIdQueryParam`).
//
// Read-only: nothing is paged, sent or written. The org and the caller come from the request context, never the query. The tenant flag
// `messaging.oncall_directory` off is the uniform 404 (decided in the service, before any router call). Responses are never cached
// (who is covering changes at a shift boundary).
import { composeGuards, requireAbac, requirePermission } from "@wardenx/auth";
import { NotFoundError, type OnCallDirectoryRole, UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { OnCallCoverageService } from "../oncall-directory/oncall-coverage-service";
import { parse } from "./messaging-typebox";
import { OnCallCoverageQuerySchema, OnCallCoverageResponseSchema } from "./oncall-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface OnCallRouteDeps {
  readonly service: OnCallCoverageService;
  /**
   * Does this patient exist in the caller's organisation (org-scoped, RLS-backstopped)? `caseload_or_scope` is true for ANY
   * well-formed id when the caller holds an org-wide scope role, so existence is checked here, after the scope gate, with the SAME
   * 404 the gate gives (a missing patient must not be told apart from an invisible one) and before the router and the read audit.
   */
  readonly patientExists: (organizationId: string, patientId: string) => Promise<boolean>;
}

/** Used when the boot supplies none: the uniform 404. */
export const DISABLED_ONCALL: OnCallRouteDeps = {
  patientExists: async () => false,
  service: {
    get: async () => {
      throw new NotFoundError("oncall directory");
    },
  },
};

const PATIENT_SCOPE = composeGuards(
  requirePermission("patient.read"),
  requireAbac("patient.read", "caseload_or_scope", {
    getTarget: (request) => ({
      patientId: (request.query as { patient_id?: unknown } | undefined)?.patient_id,
    }),
    notFoundOnDeny: true,
    breakGlassBypassable: false,
  }),
) as PreHandler;

export function registerOnCallRoutes(
  app: FastifyInstance,
  deps: OnCallRouteDeps,
  guards: { readonly read: PreHandler },
): void {
  const ONCALL = requirePermission("messaging.oncall.read") as PreHandler;
  // A malformed query is a 422 BEFORE the patient gate sees it (the predicate must never get a non-uuid).
  const VALID_QUERY: PreHandler = async (request) => {
    parse(OnCallCoverageQuerySchema, request.query);
  };
  // The scope gate's own deny is NotFoundError("resource"); a missing / other-org patient throws the identical error.
  const PATIENT_EXISTS: PreHandler = async (request) => {
    const orgId = request.context?.organizationId;
    if (!orgId) throw new UnauthorizedError();
    const { patient_id: patientId } = request.query as { patient_id: string };
    if (!(await deps.patientExists(orgId, patientId))) throw new NotFoundError("resource");
  };
  app.get(
    "/api/v1/messaging/oncall/coverage",
    {
      preHandler: [guards.read, ONCALL, VALID_QUERY, PATIENT_SCOPE, PATIENT_EXISTS],
      schema: { response: { 200: OnCallCoverageResponseSchema } },
      config: {
        auditRead: {
          resourceKind: "oncall_coverage",
          patientIdQueryParam: "patient_id",
          fields: ["role", "care_team_coverage"],
        },
      },
    },
    async (request, reply) => {
      const ctx = request.context;
      if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
      const q = parse(OnCallCoverageQuerySchema, request.query);
      const out = await deps.service.get(
        { orgId: ctx.organizationId },
        { role: q.role as OnCallDirectoryRole, patientId: q.patient_id },
      );
      return reply.header("Cache-Control", "no-store").send(out);
    },
  );
}
