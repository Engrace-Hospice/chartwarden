import { composeGuards, requireAbac, requirePermission } from "@chartwarden/auth";
import { NotFoundError, type OnCallDirectoryRole, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
import type { AfterHoursLinesService } from "../afterhours-triage/afterhours-lines";
import type { OnCallCoverageService } from "../oncall-directory/oncall-coverage-service";
import type { RoleSendPorts } from "../oncall-directory/role-send-service";
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
  /** ADR-0081: the ports of the role-based send (the urgent service is added where the routes are mounted). Absent => the uniform 404. */
  readonly roleSend?: RoleSendPorts;
  /** ADR-0082 S4/S5: the after-hours triage thread-line read. Absent => the uniform 404. */
  readonly afterHoursLines?: AfterHoursLinesService;
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

/**
 * The chart-read gate of a route that names a patient (`patient.read` + `caseload_or_scope`, no break-glass), then the org-scoped
 * existence check, both throwing the same `NotFoundError("resource")`. `patientIdOf` says where the route carries the id (the query for
 * the directory, the body for a role-based send). A malformed id must be refused (422) BEFORE these run: the predicate never sees a non-uuid.
 */
export function buildPatientGate(
  patientIdOf: (request: { readonly query?: unknown; readonly body?: unknown }) => unknown,
  patientExists: OnCallRouteDeps["patientExists"],
): readonly [PreHandler, PreHandler] {
  const scope = composeGuards(
    requirePermission("patient.read"),
    requireAbac("patient.read", "caseload_or_scope", {
      getTarget: (request) => ({ patientId: patientIdOf(request) }),
      notFoundOnDeny: true,
      breakGlassBypassable: false,
    }),
  ) as PreHandler;
  // The scope gate's own deny is NotFoundError("resource"); a missing / other-org patient throws the identical error.
  const exists: PreHandler = async (request) => {
    const orgId = request.context?.organizationId;
    if (!orgId) throw new UnauthorizedError();
    if (!(await patientExists(orgId, String(patientIdOf(request))))) {
      throw new NotFoundError("resource");
    }
  };
  return [scope, exists];
}

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
  const [PATIENT_SCOPE, PATIENT_EXISTS] = buildPatientGate(
    (request) => (request.query as { patient_id?: unknown } | undefined)?.patient_id,
    deps.patientExists,
  );
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
