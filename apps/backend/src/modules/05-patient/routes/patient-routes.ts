// apps/backend/src/modules/05-patient/routes/patient-routes.ts — M5-T09 the patient route inventory
// (§4.2; the §4.7 permission handshake; §7.1 admit-no-dup / §7.4 address cascade / §7.7 right-to-amend).
//
// Every route is gated by the REAL Authorization Contract (`requirePermission` from @wardenx/auth,
// M3) on the §4.7 keys M5 registers into M3's catalog (M5_CONTRIBUTED_PERMISSIONS). Org binding is
// server-side (`request.context`, never the body). Handlers compose over the injected
// `PatientRouteService` (in-memory slice; Drizzle in prod under withOrgContext so RLS backstops).
// §7.1: admit runs the T06 matcher — a hard duplicate returns 409 with the existing id, no row
// created; a soft match returns 201 + matchReviewIds. §7.4: an address change emits the cascade
// event. §7.7: an amendment opens with a 60-day SLA; accept/deny decides it (deny needs a reason).
import { requirePermission } from "@wardenx/auth";
import { UnauthorizedError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PatientRouteService } from "./service";
import {
  AddressBodySchema,
  AdmitBodySchema,
  AmendmentBodySchema,
  DenyBodySchema,
  LooseIdParamsSchema,
  PatientListQuerySchema,
  parse,
} from "./patient-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface PatientRouteDeps {
  service: PatientRouteService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

const READ = requirePermission("patient.read") as PreHandler;
const CREATE = requirePermission("patient.create") as PreHandler;
const EDIT = requirePermission("patient.edit") as PreHandler;
const AMEND_RECORD = requirePermission("patient.amend_request_record") as PreHandler;
const AMEND_REVIEW = requirePermission("patient.amend_review") as PreHandler;

const notFound = (what: string) => new WardenXError("NOT_FOUND", `${what} not found`, 404);

export function registerPatientRoutes(app: FastifyInstance, deps: PatientRouteDeps): void {
  const { service } = deps;

  // --- §4.2 census / list (cursor-paginated; org-scoped server-side) ---------------------------
  app.get("/api/v1/patients", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const query = parse(PatientListQuerySchema, request.query);
    return service.list(organizationId, query);
  });

  // --- §4.2 resolve one ------------------------------------------------------------------------
  app.get("/api/v1/patients/:id", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(LooseIdParamsSchema, request.params);
    const p = await service.getPatient(organizationId, id);
    if (p === null) throw notFound("patient"); // §7.5: a non-caseload/other-org patient is 404, no leak
    return p;
  });

  // --- §4.2 admit (runs the §7.1 match pipeline; hard dup → 409) --------------------------------
  app.post("/api/v1/patients", { preHandler: [CREATE] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const body = parse(AdmitBodySchema, request.body);
    const result = await service.admit(organizationId, body, userId);
    if (result.outcome === "hard_block") {
      // §7.1: no patient row created; surface the existing chart for "Open existing patient".
      throw new WardenXError(
        "DUPLICATE_OF",
        `duplicate of ${result.existingPatientId} (matched on ${result.matchedOn})`,
        409,
        [{ field: "existingPatientId", code: "DUPLICATE_OF", message: result.existingPatientId }],
      );
    }
    return reply.code(201).send(result);
  });

  // --- §4.2 add address (§7.4 cascade) ---------------------------------------------------------
  app.post("/api/v1/patients/:id/addresses", { preHandler: [EDIT] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(LooseIdParamsSchema, request.params);
    const body = parse(AddressBodySchema, request.body);
    const out = await service.addAddress(organizationId, id, body, userId);
    return reply.code(201).send(out);
  });

  // --- §4.2 submit amendment (§7.7 60-day SLA) -------------------------------------------------
  app.post("/api/v1/patients/:id/amendments", { preHandler: [AMEND_RECORD] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(LooseIdParamsSchema, request.params);
    const body = parse(AmendmentBodySchema, request.body);
    const out = await service.submitAmendment(organizationId, id, body, userId);
    return reply.code(201).send(out);
  });

  // --- §4.2 accept / deny an amendment (§7.7) --------------------------------------------------
  app.post("/api/v1/amendments/:id/accept", { preHandler: [AMEND_REVIEW] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(LooseIdParamsSchema, request.params);
    return service.decideAmendment(organizationId, id, { accept: true }, userId);
  });

  app.post("/api/v1/amendments/:id/deny", { preHandler: [AMEND_REVIEW] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(LooseIdParamsSchema, request.params);
    const { denialReason } = parse(DenyBodySchema, request.body);
    return service.decideAmendment(organizationId, id, { accept: false, denialReason }, userId);
  });
}
