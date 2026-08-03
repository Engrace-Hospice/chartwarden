// apps/backend/src/modules/37-ipu/routes/ipu.routes.ts — M37 §4.1 route handlers (T11b core spine). Reads
// gate on the `*.read` keys (inOrg base); mutations compose the RBAC key + the §4.7 RN-coverage ABAC gate
// (except unit-CRUD admin + arranged remote-IPU, exempt per §2.3) + §D14 step-up where the catalog marks it.
// Org/actor/membership are always server-assembled (actorOf/writeActorOf), never read off the wire.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { P, RN_COVERAGE, STEP_UP } from "./guards";
import {
  ApplyRestraintBodySchema,
  AssignBedBodySchema,
  BedCleaningBodySchema,
  CreateUnitBodySchema,
  DateParamsSchema,
  DischargeBodySchema,
  IdParamsSchema,
  OpenAdmissionBodySchema,
  ReassessRestraintBodySchema,
  RequestBedBodySchema,
  parse,
} from "./ipu-typebox";
import type { IpuRouteService } from "./service";

export interface IpuRouteDeps {
  readonly service: IpuRouteService;
}

/** Register the §4.1 core IPU routes over the injected route service. */
export function registerIpuRoutes(app: FastifyInstance, deps: IpuRouteDeps): void {
  const { service } = deps;

  // 1. GET /inpatient-units — list units for org. §4.1.
  app.get("/api/v1/inpatient-units", { preHandler: [P("m37.unit.read")] }, async (request) => ({
    items: await service.listUnits(actorOf(request)),
  }));

  // 2. POST /inpatient-units — create unit (org admin; step-up). §4.1. Unit-CRUD is RN-coverage-exempt (§2.3).
  app.post(
    "/api/v1/inpatient-units",
    { preHandler: [P("m37.unit.create"), STEP_UP("m37.unit.create")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CreateUnitBodySchema, request.body);
      return reply.code(201).send(await service.createUnit(actor, body));
    },
  );

  // 10. GET /ipu-admissions — list admissions. §4.1.
  app.get("/api/v1/ipu-admissions", { preHandler: [P("m37.ipu_admission.read")] }, async (request) => ({
    items: await service.listAdmissions(actorOf(request)),
  }));

  // 11. POST /ipu-admissions — open admission (GIP/IRC compose the RN-coverage gate). §4.1.
  app.post(
    "/api/v1/ipu-admissions",
    { preHandler: [P("m37.ipu_admission.create"), RN_COVERAGE("m37.ipu_admission.create")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(OpenAdmissionBodySchema, request.body);
      return reply.code(201).send(await service.openAdmission(actor, body));
    },
  );

  // 12. GET /ipu-admissions/:id — read admission detail. §4.1.
  app.get("/api/v1/ipu-admissions/:id", { preHandler: [P("m37.ipu_admission.read")] }, async (request, reply) => {
    const { id } = parse(IdParamsSchema, request.params);
    const view = await service.getAdmission(actorOf(request), id);
    if (!view) return reply.code(404).send({ code: "NOT_FOUND", message: "ipu_admission not found" });
    return view;
  });

  // 13. POST /ipu-admissions/:id/request-bed — transition to bed_pending. §4.1.
  app.post(
    "/api/v1/ipu-admissions/:id/request-bed",
    { preHandler: [P("m37.bed.assign"), RN_COVERAGE("m37.bed.assign")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const body = parse(RequestBedBodySchema, request.body);
      return service.requestBed(actor, id, body);
    },
  );

  // 14. POST /ipu-admissions/:id/assign-bed — assign a specific bed (bed_assigned). §4.1.
  app.post(
    "/api/v1/ipu-admissions/:id/assign-bed",
    { preHandler: [P("m37.bed.assign"), RN_COVERAGE("m37.bed.assign")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const body = parse(AssignBedBodySchema, request.body);
      return service.assignBed(actor, id, body);
    },
  );

  // 18. POST /ipu-admissions/:id/discharge — discharge the admission. §4.1.
  app.post(
    "/api/v1/ipu-admissions/:id/discharge",
    { preHandler: [P("m37.ipu_admission.discharge")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const body = parse(DischargeBodySchema, request.body);
      return service.discharge(actor, id, body);
    },
  );

  // 9. POST /ipu-beds/:id/cleaning-status — transition bed cleaning state. §4.1.
  app.post(
    "/api/v1/ipu-beds/:id/cleaning-status",
    { preHandler: [P("m37.bed.cleaning_status_update")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const body = parse(BedCleaningBodySchema, request.body);
      return service.transitionBed(actor, id, body);
    },
  );

  // 22. POST /ipu-admissions/:id/restraint — apply restraint (step-up + RN coverage). §4.1.
  app.post(
    "/api/v1/ipu-admissions/:id/restraint",
    { preHandler: [P("m37.restraint.apply"), STEP_UP("m37.restraint.apply"), RN_COVERAGE("m37.restraint.apply")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const body = parse(ApplyRestraintBodySchema, request.body);
      return reply.code(201).send(await service.applyRestraint(actor, id, body));
    },
  );

  // 23. POST /ipu-restraint/:id/reassess — record a restraint reassessment. §4.1.
  app.post(
    "/api/v1/ipu-restraint/:id/reassess",
    { preHandler: [P("m37.restraint.reassess")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const body = parse(ReassessRestraintBodySchema, request.body);
      return service.reassessRestraint(actor, id, body);
    },
  );

  // 24. POST /ipu-restraint/:id/release — release a restraint. §4.1.
  app.post("/api/v1/ipu-restraint/:id/release", { preHandler: [P("m37.restraint.release")] }, async (request) => {
    const actor = writeActorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    return service.releaseRestraint(actor, id);
  });

  // 38. GET /ipu-census/:date — read census snapshot for a date. §4.1.
  app.get("/api/v1/ipu-census/:date", { preHandler: [P("m37.census.read")] }, async (request) => {
    const { date } = parse(DateParamsSchema, request.params);
    return service.getCensus(actorOf(request), date);
  });
}
