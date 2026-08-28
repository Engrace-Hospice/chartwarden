// apps/backend/src/modules/37-ipu/routes/ipu.routes.ts — M37 §4.1 route handlers (T11b core spine). Reads
// gate on the `*.read` keys (inOrg base); mutations compose the RBAC key + §D14 step-up where the catalog
// marks it. Org/actor/membership are always server-assembled (actorOf/writeActorOf), never read off the wire.
//
// §2.3 D3 RN-coverage note (TASK-050A/TEST-003 finding, fixed): the §4.7 `m37.ipu.rn_coverage_active`
// predicate used to be composed here via a `RN_COVERAGE` preHandler, but `requireAbac`'s `getTarget` is
// synchronous and cannot query the materialized `ipu_rn_coverage_window` table — the guard's
// `getTarget: () => ({})` always saw an empty target and denied every caller unconditionally, on every
// mutation route that composed it (open admission, request-bed, assign-bed, initiate-transfer, restraint —
// nobody could reach any of them). Removed; the guard was redundant with (or, for restraint, has been made
// to match) the service layer's own coverage check, which runs inside the write transaction where an async
// query is legal: `service-drizzle.ts`'s `openAdmission`/`requestBed`/`initiateTransfer`/`applyRestraint`
// each independently resolve `ipu_rn_coverage_window` for the admission's unit and throw the real, tested
// `IPU_RN_COVERAGE_UNAVAILABLE` (412) — `arranged` (remote-IPU) admissions bypass per §2.3, matching the
// pure `packages/inpatient` machine's own exemption. `assign-bed` never needed the check (the state machine
// gates coverage one step earlier, at request-bed).
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { P, STEP_UP } from "./guards";
import {
  AdmissionIdParamsSchema,
  AdvanceBodyReleaseBodySchema,
  ApplyRestraintBodySchema,
  ApplyVisitorRestrictionBodySchema,
  AssignBedBodySchema,
  AssignEquipmentBedBodySchema,
  AssignStaffBodySchema,
  AttestGipBodySchema,
  BedCleaningBodySchema,
  CheckInVisitorBodySchema,
  ConfirmBodySchema,
  ConfirmTransferBodySchema,
  CreateBedBodySchema,
  CreateEquipmentBodySchema,
  CreateRoomBodySchema,
  CreateShiftBodySchema,
  CreateUnitBodySchema,
  DateParamsSchema,
  DischargeBodySchema,
  IdParamsSchema,
  InitiateTransferBodySchema,
  IrcOverrideBodySchema,
  LiftVisitorRestrictionBodySchema,
  LogInspectionBodySchema,
  LogMaintenanceBodySchema,
  LogMealBodySchema,
  OpenAdmissionBodySchema,
  ReassessGipBodySchema,
  ReassessRestraintBodySchema,
  RequestBedBodySchema,
  UnassignStaffBodySchema,
  UpdateBedBodySchema,
  UpdateRoomBodySchema,
  UpdateUnitBodySchema,
  VisitorListQuerySchema,
  VisitorRestrictionListQuerySchema,
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
  app.get(
    "/api/v1/inpatient-units",
    {
      preHandler: [P("m37.unit.read")],
      config: {
        auditRead: {
          none: "unit configuration (display name, bed count, coverage/SLA settings) — no patient data",
        },
      },
    },
    async (request) => ({
      items: await service.listUnits(actorOf(request)),
    }),
  );

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

  // 3. PATCH /inpatient-units/:id — update unit config. §4.1. RN-coverage-exempt admin route.
  app.patch(
    "/api/v1/inpatient-units/:id",
    { preHandler: [P("m37.unit.update")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.updateUnit(actor, id, parse(UpdateUnitBodySchema, request.body));
    },
  );

  // 4. POST /inpatient-units/:id/deactivate — deactivate unit (step-up). §4.1.
  app.post(
    "/api/v1/inpatient-units/:id/deactivate",
    { preHandler: [P("m37.unit.update"), STEP_UP("m37.unit.update")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.deactivateUnit(actor, id);
    },
  );

  // 5. GET/POST /inpatient-units/:id/rooms — list / create rooms. §4.1.
  app.get(
    "/api/v1/inpatient-units/:id/rooms",
    {
      preHandler: [P("m37.room.read")],
      config: {
        auditRead: { none: "room configuration (room number, kind, bed count) — no patient data" },
      },
    },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return { items: await service.listRooms(actorOf(request), id) };
    },
  );
  app.post(
    "/api/v1/inpatient-units/:id/rooms",
    { preHandler: [P("m37.room.create")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return reply
        .code(201)
        .send(await service.createRoom(actor, id, parse(CreateRoomBodySchema, request.body)));
    },
  );

  // 6. PATCH /ipu-rooms/:id — update room config. §4.1.
  app.patch("/api/v1/ipu-rooms/:id", { preHandler: [P("m37.room.update")] }, async (request) => {
    const actor = writeActorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    return service.updateRoom(actor, id, parse(UpdateRoomBodySchema, request.body));
  });

  // 7. GET/POST /ipu-rooms/:id/beds — list / create beds. §4.1.
  app.get(
    "/api/v1/ipu-rooms/:id/beds",
    {
      preHandler: [P("m37.bed.read")],
      config: {
        auditRead: { none: "bed configuration + cleaning status — no occupant/patient data" },
      },
    },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return { items: await service.listBeds(actorOf(request), id) };
    },
  );
  app.post(
    "/api/v1/ipu-rooms/:id/beds",
    { preHandler: [P("m37.bed.create")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return reply
        .code(201)
        .send(await service.createBed(actor, id, parse(CreateBedBodySchema, request.body)));
    },
  );

  // 8. PATCH /ipu-beds/:id — update bed (geofence, label). §4.1.
  app.patch("/api/v1/ipu-beds/:id", { preHandler: [P("m37.bed.update")] }, async (request) => {
    const actor = writeActorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    return service.updateBed(actor, id, parse(UpdateBedBodySchema, request.body));
  });

  // 10. GET /ipu-admissions — list admissions. §4.1.
  app.get(
    "/api/v1/ipu-admissions",
    {
      preHandler: [P("m37.ipu_admission.read")],
      config: { auditRead: { resourceKind: "ipu_admission", list: true } },
    },
    async (request) => ({
      items: await service.listAdmissions(actorOf(request)),
    }),
  );

  // 11. POST /ipu-admissions — open admission (GIP/IRC enforce RN-coverage service-side; §2.3 D3). §4.1.
  app.post(
    "/api/v1/ipu-admissions",
    { preHandler: [P("m37.ipu_admission.create")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(OpenAdmissionBodySchema, request.body);
      return reply.code(201).send(await service.openAdmission(actor, body));
    },
  );

  // 12. GET /ipu-admissions/:id — read admission detail. §4.1.
  app.get(
    "/api/v1/ipu-admissions/:id",
    {
      preHandler: [P("m37.ipu_admission.read")],
      config: { auditRead: { resourceKind: "ipu_admission", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const { id } = parse(IdParamsSchema, request.params);
      const view = await service.getAdmission(actorOf(request), id);
      if (!view)
        return reply.code(404).send({ code: "NOT_FOUND", message: "ipu_admission not found" });
      return view;
    },
  );

  // 13. POST /ipu-admissions/:id/request-bed — transition to bed_pending. §4.1.
  app.post(
    "/api/v1/ipu-admissions/:id/request-bed",
    { preHandler: [P("m37.bed.assign")] },
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
    { preHandler: [P("m37.bed.assign")] },
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

  // 15. POST /ipu-admissions/:id/confirm — M6 LCP-ack handler (system-internal). §4.1.
  app.post(
    "/api/v1/ipu-admissions/:id/confirm",
    { preHandler: [P("m37.ipu_admission.create")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.confirm(actor, id, parse(ConfirmBodySchema, request.body));
    },
  );

  // 16. POST /ipu-admissions/:id/initiate-transfer — begin a transfer. §4.1.
  app.post(
    "/api/v1/ipu-admissions/:id/initiate-transfer",
    { preHandler: [P("m37.ipu_admission.transfer")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.initiateTransfer(actor, id, parse(InitiateTransferBodySchema, request.body));
    },
  );

  // 17. POST /ipu-admissions/:id/confirm-transfer — complete a transfer. §4.1.
  app.post(
    "/api/v1/ipu-admissions/:id/confirm-transfer",
    { preHandler: [P("m37.ipu_admission.transfer")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.confirmTransfer(actor, id, parse(ConfirmTransferBodySchema, request.body));
    },
  );

  // 19. POST /ipu-admissions/:id/gip-criteria — attest GIP criteria (step-up). §4.1.
  app.post(
    "/api/v1/ipu-admissions/:id/gip-criteria",
    { preHandler: [P("m37.gip_criteria.attest"), STEP_UP("m37.gip_criteria.attest")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return reply
        .code(201)
        .send(await service.attestGip(actor, id, parse(AttestGipBodySchema, request.body)));
    },
  );

  // 20. POST /ipu-admissions/:id/gip-criteria/reassess — record a reassessment. §4.1.
  app.post(
    "/api/v1/ipu-admissions/:id/gip-criteria/reassess",
    { preHandler: [P("m37.gip_criteria.reassess")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.reassessGip(actor, id, parse(ReassessGipBodySchema, request.body));
    },
  );

  // 21. POST /ipu-admissions/:id/irc-cap-override — break-glass cap override (step-up). §4.1.
  app.post(
    "/api/v1/ipu-admissions/:id/irc-cap-override",
    {
      preHandler: [
        P("m37.irc_episode.extend_override"),
        STEP_UP("m37.irc_episode.extend_override"),
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.overrideIrcCap(actor, id, parse(IrcOverrideBodySchema, request.body));
    },
  );

  // 21b–21e. The bedside READS (F-069). `reassess`/`release`/`check-out` below are keyed by ids that no
  // read route returned, so the only way to hold one was to be the browser session that performed the
  // POST — and a behavioral restraint is reassessed every 15 minutes by whoever is on shift.
  //
  // All four gate on `m37.ipu_admission.read` rather than four new `m37.*.read` keys. They are
  // sub-resources of ONE admission, reached from its detail pane, and whoever may read the admission is
  // the staff standing at that bedside. Minting keys no role template grants would make every one of
  // these routes deny every caller — the fail-closed-invisible shape this whole audit is about — and
  // deciding which templates get them is a tenant policy call, not one to make silently here (the
  // `phi.full_read` precedent).
  app.get(
    "/api/v1/ipu-admissions/:id/restraints",
    {
      preHandler: [P("m37.ipu_admission.read")],
      config: { auditRead: { resourceKind: "ipu_restraint_event", resourceIdParam: "id" } },
    },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return { items: await service.listRestraints(actorOf(request), id) };
    },
  );
  app.get(
    "/api/v1/ipu-admissions/:id/gip-criteria",
    {
      preHandler: [P("m37.ipu_admission.read")],
      config: { auditRead: { resourceKind: "gip_admission_criteria", resourceIdParam: "id" } },
    },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return { items: await service.listGipCriteria(actorOf(request), id) };
    },
  );
  app.get(
    "/api/v1/ipu-admissions/:id/irc-episodes",
    {
      preHandler: [P("m37.ipu_admission.read")],
      config: { auditRead: { resourceKind: "irc_episode", resourceIdParam: "id" } },
    },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return { items: await service.listIrcEpisodes(actorOf(request), id) };
    },
  );
  app.get(
    "/api/v1/ipu-visitors",
    {
      preHandler: [P("m37.ipu_admission.read")],
      config: { auditRead: { resourceKind: "ipu_visitor", list: true } },
    },
    async (request) => {
      const q = parse(VisitorListQuerySchema, request.query);
      return { items: await service.listVisitors(actorOf(request), q.ipuAdmissionId) };
    },
  );

  // 22. POST /ipu-admissions/:id/restraint — apply restraint (step-up; RN coverage enforced service-side). §4.1.
  app.post(
    "/api/v1/ipu-admissions/:id/restraint",
    { preHandler: [P("m37.restraint.apply"), STEP_UP("m37.restraint.apply")] },
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
  app.post(
    "/api/v1/ipu-restraint/:id/release",
    { preHandler: [P("m37.restraint.release")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.releaseRestraint(actor, id);
    },
  );

  // 25. GET/POST /ipu-shifts — list / create shifts. §4.1.
  app.get(
    "/api/v1/ipu-shifts",
    {
      preHandler: [P("m37.shift.read")],
      config: {
        auditRead: {
          none: "unit shift schedule (start/end times, staff assignments by membership) — no patient data",
        },
      },
    },
    async (request) => ({
      items: await service.listShifts(actorOf(request)),
    }),
  );
  app.post(
    "/api/v1/ipu-shifts",
    { preHandler: [P("m37.shift.create")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      return reply
        .code(201)
        .send(await service.createShift(actor, parse(CreateShiftBodySchema, request.body)));
    },
  );

  // 26. POST/DELETE /ipu-shifts/:id/staff — assign / unassign staff. §4.1.
  app.post(
    "/api/v1/ipu-shifts/:id/staff",
    { preHandler: [P("m37.shift.assign_staff")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return reply
        .code(201)
        .send(await service.assignStaff(actor, id, parse(AssignStaffBodySchema, request.body)));
    },
  );
  app.delete(
    "/api/v1/ipu-shifts/:id/staff",
    { preHandler: [P("m37.shift.assign_staff")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.unassignStaff(actor, id, parse(UnassignStaffBodySchema, request.body));
    },
  );

  // 27. GET /ipu-units/:id/rn-coverage — read the coverage window. §4.1.
  app.get(
    "/api/v1/ipu-units/:id/rn-coverage",
    {
      preHandler: [P("m37.shift.read")],
      config: {
        auditRead: {
          none: "per-hour RN-coverage boolean for a unit — staffing state, no patient data",
        },
      },
    },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return service.getRnCoverage(actorOf(request), id);
    },
  );

  // 28. POST /ipu-units/:id/rn-coverage/break-glass — invoke override (step-up). §4.1.
  app.post(
    "/api/v1/ipu-units/:id/rn-coverage/break-glass",
    { preHandler: [P("m37.rn_coverage.break_glass"), STEP_UP("m37.rn_coverage.break_glass")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.invokeRnBreakGlass(actor, id);
    },
  );

  // 29. POST /ipu-visitors — check-in a visitor. §4.1.
  app.post(
    "/api/v1/ipu-visitors",
    { preHandler: [P("m37.visitor.check_in")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      return reply
        .code(201)
        .send(await service.checkInVisitor(actor, parse(CheckInVisitorBodySchema, request.body)));
    },
  );

  // 30. POST /ipu-visitors/:id/check-out — check-out a visitor. §4.1.
  app.post(
    "/api/v1/ipu-visitors/:id/check-out",
    { preHandler: [P("m37.visitor.check_out")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.checkOutVisitor(actor, id);
    },
  );

  // 31. GET/POST/DELETE /ipu-visitor-restrictions — list / apply / lift a restriction. §4.1.
  //
  // F-070 — the GET is new. `DELETE` lifts by `restrictionId` and nothing returned one, so a
  // `full_block` or `mask_required` restriction could be lifted only from the browser session that
  // applied it. Gated on `m37.visitor_restriction.apply` rather than a new `.read` key, for the F-069
  // reason: no template grants a key that does not exist yet, so minting one would make this route deny
  // every caller — the fail-closed invisibility this audit is about. `.apply` is the audience that
  // manages restrictions; a tenant that wants a read-only viewer role is a policy decision to take
  // deliberately, not one to take silently here.
  app.get(
    "/api/v1/ipu-visitor-restrictions",
    {
      preHandler: [P("m37.visitor_restriction.apply")],
      config: { auditRead: { resourceKind: "ipu_visitor_restriction", list: true } },
    },
    async (request) => ({
      items: await service.listVisitorRestrictions(
        actorOf(request),
        parse(VisitorRestrictionListQuerySchema, request.query ?? {}),
      ),
    }),
  );
  app.post(
    "/api/v1/ipu-visitor-restrictions",
    { preHandler: [P("m37.visitor_restriction.apply")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      return reply
        .code(201)
        .send(
          await service.applyVisitorRestriction(
            actor,
            parse(ApplyVisitorRestrictionBodySchema, request.body),
          ),
        );
    },
  );
  app.delete(
    "/api/v1/ipu-visitor-restrictions",
    { preHandler: [P("m37.visitor_restriction.lift")] },
    async (request) => {
      const actor = writeActorOf(request);
      return service.liftVisitorRestriction(
        actor,
        parse(LiftVisitorRestrictionBodySchema, request.body),
      );
    },
  );

  // 32. POST /ipu-meals — log a meal. §4.1.
  app.post("/api/v1/ipu-meals", { preHandler: [P("m37.meal.log")] }, async (request, reply) => {
    const actor = writeActorOf(request);
    return reply
      .code(201)
      .send(await service.logMeal(actor, parse(LogMealBodySchema, request.body)));
  });

  // 33. GET/POST /ipu-equipment — list / create equipment. §4.1.
  app.get(
    "/api/v1/ipu-equipment",
    {
      preHandler: [P("m37.equipment.read")],
      config: {
        auditRead: {
          none: "durable equipment inventory (serial, type, status, inspection due date) — no patient data",
        },
      },
    },
    async (request) => ({
      items: await service.listEquipment(actorOf(request)),
    }),
  );
  app.post(
    "/api/v1/ipu-equipment",
    { preHandler: [P("m37.equipment.create")] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      return reply
        .code(201)
        .send(await service.createEquipment(actor, parse(CreateEquipmentBodySchema, request.body)));
    },
  );

  // 34. POST /ipu-equipment/:id/maintenance — log maintenance. §4.1.
  app.post(
    "/api/v1/ipu-equipment/:id/maintenance",
    { preHandler: [P("m37.equipment.maintenance_log")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.logMaintenance(actor, id, parse(LogMaintenanceBodySchema, request.body));
    },
  );

  // 35. POST /ipu-equipment/:id/inspection — log a biomed inspection. §4.1.
  app.post(
    "/api/v1/ipu-equipment/:id/inspection",
    { preHandler: [P("m37.equipment.inspection_record")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.logInspection(actor, id, parse(LogInspectionBodySchema, request.body));
    },
  );

  // 36. POST /ipu-equipment/:id/assign-bed — assign equipment to a bed/patient (inspection-current gate). §4.1.
  app.post(
    "/api/v1/ipu-equipment/:id/assign-bed",
    { preHandler: [P("m37.equipment.assign_bed")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.assignEquipmentBed(
        actor,
        id,
        parse(AssignEquipmentBedBodySchema, request.body),
      );
    },
  );

  // 37. GET/POST /ipu-body-release/:admissionId — read / advance body-release state. §4.1.
  app.get(
    "/api/v1/ipu-body-release/:admissionId",
    {
      preHandler: [P("m37.body_release.coordinate")],
      config: { auditRead: { resourceKind: "ipu_body_release", resourceIdParam: "admissionId" } },
    },
    async (request, reply) => {
      const { admissionId } = parse(AdmissionIdParamsSchema, request.params);
      const view = await service.getBodyRelease(actorOf(request), admissionId);
      if (!view)
        return reply.code(404).send({ code: "NOT_FOUND", message: "ipu_body_release not found" });
      return view;
    },
  );
  app.post(
    "/api/v1/ipu-body-release/:admissionId",
    { preHandler: [P("m37.body_release.coordinate")] },
    async (request) => {
      const actor = writeActorOf(request);
      const { admissionId } = parse(AdmissionIdParamsSchema, request.params);
      return service.advanceBodyRelease(
        actor,
        admissionId,
        parse(AdvanceBodyReleaseBodySchema, request.body),
      );
    },
  );

  // 38. GET /ipu-census/:date — read census snapshot for a date. §4.1.
  app.get(
    "/api/v1/ipu-census/:date",
    {
      preHandler: [P("m37.census.read")],
      config: {
        auditRead: {
          none: "per-unit census snapshot — aggregate bed/day/turnover counts for a service date, no patient identity",
        },
      },
    },
    async (request) => {
      const { date } = parse(DateParamsSchema, request.params);
      return service.getCensus(actorOf(request), date);
    },
  );
}
