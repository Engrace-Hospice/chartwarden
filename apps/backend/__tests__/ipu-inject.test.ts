// apps/backend/__tests__/ipu-inject.test.ts — M37-T11 (§4.1) HTTP-layer smoke suite (TASK-050A / TEST-001).
//
// Module 37 (Inpatient Unit Management) shipped ZERO Fastify `.inject()` coverage before this file: the
// only existing M37 test that drives real code is `m37-ipu-write.live.test.ts`, which calls
// `buildDrizzleIpuRouteService` methods DIRECTLY against a live Postgres — it never goes through Fastify,
// so a mis-wired guard, a permission key that does not match the §4.6 catalog, an ABAC predicate name that
// does not resolve, or a TypeBox schema drifted from the body it guards would all be invisible. This file
// closes that gap the same way `cap-inject.test.ts` / `supplies-inject.test.ts` did: `buildServer()` mounts
// the M1 host, `mountM37Routes()` mounts the §4.1 route table (confirmed by reading its body first — it is
// a thin pass-through to `registerIpuRoutes`, with no eraser/seam side effects to route around), the REAL
// Authorization Contract gates every route on the real §4.6 permission keys, and the REAL
// `buildM37AbacPredicates` resolves the five §4.7 predicates M37 owns.
//
// M37 ships no `createInMemory*Backend` for the route surface, so — as with M15/M16/M19/M26 before it —
// the SERVICE half here is a small hand-rolled backend built directly against the real, exported
// `IpuRouteService` interface (`../src/modules/37-ipu/routes/service`), so the compiler still catches an
// interface drift; the harness half (header-auth shim, permission/ABAC registry wiring, beforeEach/afterEach
// reset) clones the `cap-inject.test.ts` precedent exactly.
//
// ── FIXED FINDING — was a universal-deny bug on 5 routes, now fixed at the source ──────────────────────
//
// This file originally found (and, per its own scope at the time, only documented — TASK-050A/TEST-001)
// that `RN_COVERAGE` (`routes/guards.ts`) composed §4.7's `m37.ipu.rn_coverage_active` predicate via
// `requireAbac(key, "m37.ipu.rn_coverage_active", { getTarget: () => ({}) })` — a CONSTANT closure that
// never read the request, so the predicate always saw an empty target and denied every caller
// unconditionally on 5 mutation routes (open admission, request-bed, assign-bed, initiate-transfer,
// apply-restraint) — nobody, including a fully-permissioned actor, could reach any of them. Root cause:
// `requireAbac`'s `getTarget` is synchronous and cannot query the materialized `ipu_rn_coverage_window`
// table the coverage fact actually lives in, so no synchronous `getTarget` could ever have implemented
// this correctly. Fixed by removing the guard (`routes/guards.ts`, `routes/ipu.routes.ts`) and enforcing
// coverage entirely in `routes/service-drizzle.ts`, where an async query inside the write transaction is
// legal — `openAdmission`/`requestBed`/`initiateTransfer` already did this independently;
// `applyRestraint` did not and has been given the same check. `arranged` (remote-IPU) admissions bypass
// per §2.3, matching the pure `packages/inpatient` machine's exemption; `assign-bed` never needed the
// check (the state machine gates coverage one step earlier, at request-bed). See the header comments on
// `routes/guards.ts` and `routes/ipu.routes.ts` for the full note.
//
// This file's hand-rolled in-memory `IpuRouteService` (below) does no RN-coverage enforcement of its own
// — it is a pure wiring/schema smoke test, and the domain rule is already covered by
// `m37-ipu-write.live.test.ts` (live Drizzle) and `@wardenx/inpatient`'s own pure-function suite — so
// every route below gets genuine 2xx coverage now, including the 5 that were previously blocked.
//
// No FormatRegistry gap here (unlike M25/M26's *-typebox.ts files): `ipu-typebox.ts`'s `id` alias is a
// plain `Type.String({ minLength: 1 })`, and the one date-shaped field (`DateParamsSchema.date`) is
// length-checked only — neither declares `format:`, so there is no unregistered-format trap to route around.
import { randomUUID } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { NotFoundError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildM37AbacPredicates } from "../src/modules/37-ipu/abac/predicates";
import { M37_CONTRIBUTED_PERMISSIONS, mountM37Routes } from "../src/modules/37-ipu/index";
import type { IpuReadActor, IpuWriteActor } from "../src/modules/37-ipu/routes/actor";
import type {
  AdmissionView,
  BedView,
  EquipmentView,
  GipCriteriaView,
  IpuRouteService,
  RestraintView,
  RoomView,
  ShiftView,
  StaffAssignmentView,
  UnitView,
  VisitorRestrictionDetailView,
} from "../src/modules/37-ipu/routes/service";

// ── the M11/M15/M19/M21/M26 header-auth shim, extended with `x-test-membership` (`writeActorOf` in
//    routes/actor.ts requires a server-assembled `context.attributes.membershipId`) and `x-test-step-up`
//    (the §D14 step-up flag `requireStepUp` gates on). ─────────────────────
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
  if (request.headers["x-test-step-up"] === "1") {
    request.context.attributes.stepUpRecent = true;
  }
}

const ORG = "org_a";
const MEMBERSHIP = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-04T12:00:00.000Z";

/** A server-assembled write actor for SEEDING fixtures directly through the real service interface (never
 *  through HTTP) — a convenience for tests that need a pre-existing admission/unit/room/bed, not a
 *  workaround for anything broken. */
const SEED_ACTOR: IpuWriteActor = {
  organizationId: ORG,
  userId: "seed_user",
  roles: [],
  membershipId: MEMBERSHIP,
  stepUpRecent: true,
};
const READ_ACTOR: IpuReadActor = { organizationId: ORG, userId: "seed_user", roles: [] };
void READ_ACTOR;

/** Build a minimal in-memory `IpuRouteService` this file exercises over HTTP (the M37 module ships no
 *  module-exported `createInMemory*Backend`, unlike M11/M14/M17/M18). Org-scoped Maps, keyed by id; the
 *  gip-criteria/irc-episode/body-release tables are keyed by admissionId (one active row per admission, as
 *  the real §4.1 route shapes assume). No business-rule enforcement beyond existence checks — this is a
 *  wiring/schema smoke test, not a domain-logic test (the pure §2 machines are already covered by
 *  `@wardenx/inpatient`'s own suite + `m37-ipu-write.live.test.ts`). */
function createIpuTestBackend(): IpuRouteService {
  const units = new Map<string, UnitView & { organizationId: string }>();
  const rooms = new Map<string, RoomView & { organizationId: string }>();
  const beds = new Map<string, BedView & { organizationId: string }>();
  const admissions = new Map<string, AdmissionView & { organizationId: string }>();
  const gipCriteria = new Map<string, GipCriteriaView & { organizationId: string }>(); // keyed by admissionId
  const ircEpisodes = new Map<
    string,
    {
      organizationId: string;
      id: string;
      ipuAdmissionId: string;
      state: string;
      consecutiveDayCount: number;
      capOverrideInvoked: boolean;
      version: number;
    }
  >(); // keyed by admissionId
  const shifts = new Map<string, ShiftView & { organizationId: string }>();
  const staffAssignments = new Map<string, StaffAssignmentView & { organizationId: string }>();
  /** F-071 — unitId → the override's expiry epoch ms. */
  const breakGlass = new Map<string, number>();
  const restraints = new Map<string, RestraintView & { organizationId: string }>();
  const visitors = new Map<
    string,
    {
      organizationId: string;
      id: string;
      ipuAdmissionId: string;
      relationship: string;
      maskRequired: boolean;
      checkedInAt: string;
      checkedOutAt: string | null;
    }
  >();
  // `VisitorRestrictionDetailView & { organizationId }` (the `equipment` map's idiom below): the
  // hand-written subset here named five of the view's thirteen fields, so the F-070 list read could not
  // filter on `unitId`/`patientId` — the two narrowings that route actually applies.
  const visitorRestrictions = new Map<
    string,
    VisitorRestrictionDetailView & { organizationId: string }
  >();
  const meals = new Map<
    string,
    {
      organizationId: string;
      id: string;
      ipuAdmissionId: string;
      serviceDate: string;
      mealSlot: string;
    }
  >();
  const equipment = new Map<string, EquipmentView & { organizationId: string }>();
  const bodyReleases = new Map<
    string,
    { organizationId: string; id: string; ipuAdmissionId: string; state: string; version: number }
  >(); // keyed by admissionId

  return {
    async listUnits(actor) {
      return [...units.values()].filter((u) => u.organizationId === actor.organizationId);
    },
    async createUnit(actor, body) {
      const id = randomUUID();
      const row = {
        organizationId: actor.organizationId,
        id,
        facilityId: body.facilityId,
        displayName: body.displayName,
        bedCount: body.bedCount,
        isActive: true,
        rnCoverageHorizonHours: body.rnCoverageHorizonHours ?? 24,
        turnoverSlaMinutes: body.turnoverSlaMinutes ?? 60,
        version: 1,
      };
      units.set(id, row);
      return row;
    },
    async updateUnit(actor, unitId, body) {
      const row = units.get(unitId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("inpatient_unit", unitId);
      const updated = {
        ...row,
        displayName: body.displayName ?? row.displayName,
        rnCoverageHorizonHours: body.rnCoverageHorizonHours ?? row.rnCoverageHorizonHours,
        turnoverSlaMinutes: body.turnoverSlaMinutes ?? row.turnoverSlaMinutes,
        version: row.version + 1,
      };
      units.set(unitId, updated);
      return updated;
    },
    async deactivateUnit(actor, unitId) {
      const row = units.get(unitId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("inpatient_unit", unitId);
      const updated = { ...row, isActive: false, version: row.version + 1 };
      units.set(unitId, updated);
      return updated;
    },
    async listRooms(actor, unitId) {
      return [...rooms.values()].filter(
        (r) => r.organizationId === actor.organizationId && r.unitId === unitId,
      );
    },
    async createRoom(actor, unitId, body) {
      const id = randomUUID();
      const row = {
        organizationId: actor.organizationId,
        id,
        unitId,
        roomNumber: body.roomNumber,
        kind: body.kind,
        bedCount: body.bedCount,
        isActive: true,
        version: 1,
      };
      rooms.set(id, row);
      return row;
    },
    async updateRoom(actor, roomId, body) {
      const row = rooms.get(roomId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("ipu_room", roomId);
      const updated = {
        ...row,
        roomNumber: body.roomNumber ?? row.roomNumber,
        kind: body.kind ?? row.kind,
        isActive: body.isActive ?? row.isActive,
        version: row.version + 1,
      };
      rooms.set(roomId, updated);
      return updated;
    },
    async listBeds(actor, roomId) {
      return [...beds.values()].filter(
        (b) => b.organizationId === actor.organizationId && b.roomId === roomId,
      );
    },
    async createBed(actor, roomId, body) {
      const id = randomUUID();
      const room = rooms.get(roomId);
      const row = {
        organizationId: actor.organizationId,
        id,
        roomId,
        unitId: room?.unitId ?? "",
        bedLabel: body.bedLabel,
        cleaningStatus: "ready",
        version: 1,
      };
      beds.set(id, row);
      return row;
    },
    async updateBed(actor, bedId, body) {
      const row = beds.get(bedId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("ipu_bed", bedId);
      const updated = { ...row, bedLabel: body.bedLabel ?? row.bedLabel, version: row.version + 1 };
      beds.set(bedId, updated);
      return updated;
    },
    async listAdmissions(actor) {
      return [...admissions.values()].filter((a) => a.organizationId === actor.organizationId);
    },
    async getAdmission(actor, id) {
      const row = admissions.get(id);
      return row && row.organizationId === actor.organizationId ? row : null;
    },
    async openAdmission(actor, body) {
      const id = body.admissionId;
      const row = {
        organizationId: actor.organizationId,
        id,
        patientId: body.patientId,
        kind: body.kind,
        state: "pending",
        unitId: body.unitId ?? null,
        remoteFacilityId: body.remoteFacilityId ?? null,
        openedAt: NOW,
        version: 1,
      };
      admissions.set(id, row);
      return row;
    },
    async requestBed(actor, admissionId, body) {
      const row = admissions.get(admissionId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("ipu_admission", admissionId);
      void body;
      const updated = { ...row, state: "bed_pending", version: row.version + 1 };
      admissions.set(admissionId, updated);
      return updated;
    },
    async assignBed(actor, admissionId, body) {
      const row = admissions.get(admissionId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("ipu_admission", admissionId);
      const bed = beds.get(body.bedId);
      if (bed) beds.set(body.bedId, { ...bed, cleaningStatus: "reserved" });
      const updated = { ...row, state: "bed_assigned", version: row.version + 1 };
      admissions.set(admissionId, updated);
      return updated;
    },
    async discharge(actor, admissionId, body) {
      void body;
      const row = admissions.get(admissionId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("ipu_admission", admissionId);
      const updated = { ...row, state: "discharged", version: row.version + 1 };
      admissions.set(admissionId, updated);
      return updated;
    },
    async confirm(actor, admissionId, body) {
      void body;
      const row = admissions.get(admissionId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("ipu_admission", admissionId);
      const updated = { ...row, state: "active", version: row.version + 1 };
      admissions.set(admissionId, updated);
      return updated;
    },
    async initiateTransfer(actor, admissionId, body) {
      void body;
      const row = admissions.get(admissionId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("ipu_admission", admissionId);
      const updated = { ...row, state: "transfer_pending", version: row.version + 1 };
      admissions.set(admissionId, updated);
      return updated;
    },
    async confirmTransfer(actor, admissionId, body) {
      void body;
      const row = admissions.get(admissionId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("ipu_admission", admissionId);
      const updated = { ...row, state: "transferred", version: row.version + 1 };
      admissions.set(admissionId, updated);
      return updated;
    },
    async attestGip(actor, admissionId, body) {
      const row = {
        organizationId: actor.organizationId,
        id: randomUUID(),
        ipuAdmissionId: admissionId,
        criterionKind: body.data.criterion_kind,
        attestedAt: NOW,
        version: 1,
      };
      gipCriteria.set(admissionId, row);
      return row;
    },
    async reassessGip(actor, admissionId, body) {
      void body;
      const row = gipCriteria.get(admissionId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("gip_admission_criteria", admissionId);
      const updated = { ...row, version: row.version + 1 };
      gipCriteria.set(admissionId, updated);
      return updated;
    },
    async overrideIrcCap(actor, admissionId, body) {
      void body;
      const existing = ircEpisodes.get(admissionId);
      const row = {
        organizationId: actor.organizationId,
        id: existing?.id ?? randomUUID(),
        ipuAdmissionId: admissionId,
        state: existing?.state ?? "active",
        consecutiveDayCount: existing?.consecutiveDayCount ?? 3,
        capOverrideInvoked: true,
        version: (existing?.version ?? 0) + 1,
      };
      ircEpisodes.set(admissionId, row);
      return row;
    },
    async listShifts(actor) {
      // F-070 — the list carries each shift's assignments, so an `assignmentId` is reachable by
      // somebody other than the session that created it.
      return [...shifts.values()]
        .filter((s) => s.organizationId === actor.organizationId)
        .map((s) => ({
          ...s,
          assignments: [...staffAssignments.values()]
            .filter((a) => a.shiftId === s.id && a.organizationId === actor.organizationId)
            .map(({ organizationId: _o, ...a }) => a),
        }));
    },
    async createShift(actor, body) {
      const id = randomUUID();
      const row = {
        organizationId: actor.organizationId,
        id,
        unitId: body.unitId,
        shiftStartAt: body.shiftStartAt,
        shiftEndAt: body.shiftEndAt,
        displayLabel: body.displayLabel ?? null,
        assignments: [],
        version: 1,
      };
      shifts.set(id, row);
      return row;
    },
    async assignStaff(actor, shiftId, body) {
      const id = randomUUID();
      const row = {
        organizationId: actor.organizationId,
        id,
        shiftId,
        membershipId: body.membershipId,
        role: body.role,
        state: "assigned",
      };
      staffAssignments.set(id, row);
      return row;
    },
    async unassignStaff(actor, shiftId, body) {
      const row = staffAssignments.get(body.assignmentId);
      // F-070 — the path's shift id is part of the identity of what is being cancelled.
      if (!row || row.organizationId !== actor.organizationId || row.shiftId !== shiftId) {
        throw new NotFoundError("ipu_staff_assignment", body.assignmentId);
      }
      const updated = { ...row, state: "unassigned" };
      staffAssignments.set(body.assignmentId, updated);
      return updated;
    },
    async confirmStaff(actor, shiftId, body) {
      const row = staffAssignments.get(body.assignmentId);
      if (!row || row.organizationId !== actor.organizationId || row.shiftId !== shiftId) {
        throw new NotFoundError("ipu_staff_assignment", body.assignmentId);
      }
      const updated = { ...row, state: "confirmed" };
      staffAssignments.set(body.assignmentId, updated);
      return updated;
    },
    async getRnCoverage(actor, unitId) {
      void actor;
      return { unitId, items: [{ hourStartAt: NOW, isCovered: true }] };
    },
    async invokeRnBreakGlass(actor, unitId, body) {
      void actor;
      // F-071 — the fake mirrors the production shape: an override has a bounded window and reports
      // whether one was already live rather than stacking a second.
      const existing = breakGlass.get(unitId);
      if (existing && existing > Date.now()) {
        return {
          unitId,
          invoked: true,
          expiresAt: new Date(existing).toISOString(),
          alreadyActive: true,
        };
      }
      const expiresAt = Date.now() + body.durationMinutes * 60_000;
      breakGlass.set(unitId, expiresAt);
      return {
        unitId,
        invoked: true,
        expiresAt: new Date(expiresAt).toISOString(),
        alreadyActive: false,
      };
    },
    async transitionBed(actor, bedId, body) {
      const row = beds.get(bedId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("ipu_bed", bedId);
      const next: Record<string, string> = {
        reserve: "reserved",
        occupy: "occupied",
        dischargeDirty: "discharged_dirty",
        startCleaning: "cleaning_in_progress",
        completeCleaning: "ready",
        retire: "retired",
        expireReservation: "ready",
      };
      const updated = {
        ...row,
        cleaningStatus: next[body.event] ?? row.cleaningStatus,
        version: row.version + 1,
      };
      beds.set(bedId, updated);
      return updated;
    },
    async getCensus(actor, serviceDate) {
      void actor;
      return { serviceDate, items: [] };
    },
    // F-069 (read side) — the four bedside reads. `reassess`/`release`/`check-out` are keyed by ids no
    // read route returned, so the only way to hold one was to be the session that did the POST.
    async listRestraints(actor, admissionId) {
      return [...restraints.values()]
        .filter(
          (r) => r.organizationId === actor.organizationId && r.ipuAdmissionId === admissionId,
        )
        .map((r) => ({
          id: r.id,
          ipuAdmissionId: r.ipuAdmissionId,
          restraintKind: r.restraintKind,
          category: "behavioral" as const,
          state: r.state,
          reassessmentIntervalMinutes: r.reassessmentIntervalMinutes,
          appliedAt: "2026-08-27T09:00:00.000Z",
          appliedByMembershipId: MEMBERSHIP,
          orderingOrderId: randomUUID(),
          orderingPhysicianId: randomUUID(),
          releasedAt: null,
          nextDueAt: null,
          reassessmentCount: 0,
          version: r.version,
        }));
    },
    async listGipCriteria(actor, admissionId) {
      void actor;
      return [
        {
          id: randomUUID(),
          ipuAdmissionId: admissionId,
          criterionKind: "acute_symptom_management",
          attestedAt: "2026-08-27T09:00:00.000Z",
          attestingPhysicianId: randomUUID(),
          reassessments: [],
          version: 1,
        },
      ];
    },
    async listIrcEpisodes(actor, admissionId) {
      void actor;
      return [
        {
          id: randomUUID(),
          ipuAdmissionId: admissionId,
          state: "active",
          consecutiveDayCount: 3,
          capOverrideInvoked: false,
          version: 1,
        },
      ];
    },
    async listVisitors(actor, admissionId) {
      return [...visitors.values()]
        .filter(
          (v) => v.organizationId === actor.organizationId && v.ipuAdmissionId === admissionId,
        )
        .map(({ organizationId: _o, ...v }) => v);
    },
    async applyRestraint(actor, admissionId, body) {
      const id = randomUUID();
      const row = {
        organizationId: actor.organizationId,
        id,
        ipuAdmissionId: admissionId,
        restraintKind: body.restraintKind,
        state: "active",
        reassessmentIntervalMinutes: body.reassessmentIntervalMinutes,
        version: 1,
      };
      restraints.set(id, row);
      return row;
    },
    async reassessRestraint(actor, restraintId, body) {
      const row = restraints.get(restraintId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("ipu_restraint", restraintId);
      const state = body.outcome === "release" ? "released" : row.state;
      const updated = { ...row, state, version: row.version + 1 };
      restraints.set(restraintId, updated);
      return updated;
    },
    async releaseRestraint(actor, restraintId) {
      const row = restraints.get(restraintId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("ipu_restraint", restraintId);
      const updated = { ...row, state: "released", version: row.version + 1 };
      restraints.set(restraintId, updated);
      return updated;
    },
    async checkInVisitor(actor, body) {
      const id = randomUUID();
      const row = {
        organizationId: actor.organizationId,
        id,
        ipuAdmissionId: body.ipuAdmissionId,
        relationship: body.relationship,
        maskRequired: false,
        checkedInAt: NOW,
        checkedOutAt: null,
      };
      visitors.set(id, row);
      return row;
    },
    async checkOutVisitor(actor, visitorId) {
      const row = visitors.get(visitorId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("ipu_visitor", visitorId);
      const updated = { ...row, checkedOutAt: NOW };
      visitors.set(visitorId, updated);
      return updated;
    },
    async listVisitorRestrictions(actor, query) {
      // F-070 — the read that makes `restrictionId` obtainable. `active` defaults to true.
      return [...visitorRestrictions.values()]
        .filter((r) => r.organizationId === actor.organizationId)
        .filter((r) => (query.active === "false" ? true : r.liftedAt === null))
        .filter((r) => (query.unitId ? r.unitId === query.unitId : true))
        .filter((r) => (query.patientId ? r.patientId === query.patientId : true))
        .map(({ organizationId: _o, ...r }) => r);
    },
    async applyVisitorRestriction(actor, body) {
      const id = randomUUID();
      const row = {
        organizationId: actor.organizationId,
        id,
        scope: body.scope,
        unitId: body.unitId ?? null,
        patientId: body.patientId ?? null,
        restrictionKind: body.restrictionKind,
        rationale: body.rationale,
        sourceKind: body.sourceKind,
        appliedAt: NOW,
        appliedBy: actor.membershipId,
        appliedUntil: null,
        liftedAt: null as string | null,
        version: 1,
      };
      visitorRestrictions.set(id, row);
      return row;
    },
    async liftVisitorRestriction(actor, body) {
      const row = visitorRestrictions.get(body.restrictionId);
      if (!row || row.organizationId !== actor.organizationId) {
        throw new NotFoundError("ipu_visitor_restriction", body.restrictionId);
      }
      const updated = { ...row, liftedAt: NOW };
      visitorRestrictions.set(body.restrictionId, updated);
      return updated;
    },
    async logMeal(actor, body) {
      const id = randomUUID();
      const row = {
        organizationId: actor.organizationId,
        id,
        ipuAdmissionId: body.ipuAdmissionId,
        serviceDate: body.serviceDate,
        mealSlot: body.mealSlot,
      };
      meals.set(id, row);
      return row;
    },
    async listEquipment(actor) {
      return [...equipment.values()].filter((e) => e.organizationId === actor.organizationId);
    },
    async createEquipment(actor, body) {
      const id = randomUUID();
      const row = {
        organizationId: actor.organizationId,
        id,
        serialNumber: body.serialNumber,
        equipmentType: body.equipmentType,
        currentStatus: "in_service",
        nextInspectionDueDate: null,
        version: 1,
      };
      equipment.set(id, row);
      return row;
    },
    async logMaintenance(actor, equipmentId, body) {
      void body;
      const row = equipment.get(equipmentId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("ipu_equipment", equipmentId);
      const updated = { ...row, version: row.version + 1 };
      equipment.set(equipmentId, updated);
      return updated;
    },
    async logInspection(actor, equipmentId, body) {
      const row = equipment.get(equipmentId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("ipu_equipment", equipmentId);
      const updated = {
        ...row,
        nextInspectionDueDate: body.nextInspectionDueDate,
        version: row.version + 1,
      };
      equipment.set(equipmentId, updated);
      return updated;
    },
    async assignEquipmentBed(actor, equipmentId, body) {
      void body;
      const row = equipment.get(equipmentId);
      if (!row || row.organizationId !== actor.organizationId)
        throw new NotFoundError("ipu_equipment", equipmentId);
      const updated = { ...row, currentStatus: "in_use", version: row.version + 1 };
      equipment.set(equipmentId, updated);
      return updated;
    },
    async getBodyRelease(actor, admissionId) {
      const row = bodyReleases.get(admissionId);
      return row && row.organizationId === actor.organizationId ? row : null;
    },
    async advanceBodyRelease(actor, admissionId, body) {
      const existing = bodyReleases.get(admissionId);
      const row = {
        organizationId: actor.organizationId,
        id: existing?.id ?? randomUUID(),
        ipuAdmissionId: admissionId,
        state: body.action === "releaseBody" ? "released" : "pending",
        version: (existing?.version ?? 0) + 1,
      };
      bodyReleases.set(admissionId, row);
      return row;
    },
  };
}

const ALL_M37_PERMISSIONS = Object.keys(M37_CONTRIBUTED_PERMISSIONS);

function makeServer() {
  const service = createIpuTestBackend();

  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "super_1",
      grants: [
        { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ALL_M37_PERMISSIONS },
      ],
    },
    {
      orgId: ORG,
      userId: "nobody_1",
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [] }],
    },
  ]);
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server (the shared `abacRegistry` would otherwise persist a predicate
  // across tests — the `cap-inject.test.ts` precedent). M37's real five §4.7 predicates, plus the
  // test-local stand-in for `step_up_recent` (the M3 predicate M37 composes but does not own).
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(buildM37AbacPredicates())) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM37Routes(app, { service });
  return { app, service };
}

const SUPER = {
  "x-test-user": "super_1",
  "x-test-org": ORG,
  "x-test-roles": "administrator",
  "x-test-membership": MEMBERSHIP,
  "x-test-step-up": "1",
};
const NOBODY = { "x-test-user": "nobody_1", "x-test-org": ORG };

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

// ── auth/schema boundary: 401 / 403 / 422 ────────────────────────────────────────────────────────────

describe("M37-T11 auth + schema boundary", () => {
  it("no auth headers at all → 401", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/inpatient-units" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("an authenticated actor holding NO permissions → 403", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/inpatient-units",
      headers: NOBODY,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a correctly-permissioned actor posting an empty body → 422 (TypeBox VALIDATION_FAILED)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/inpatient-units",
      headers: SUPER,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

// ── routes 1-4, 5, 5b, 6, 7, 7b, 8 — unit + room + bed CRUD ─────────────────────────────────────────────

describe("M37-T11 §4.1 unit + room + bed CRUD (routes 1-8)", () => {
  it("creates a unit, a room, a bed; lists + updates each; deactivates the unit", async () => {
    const { app } = makeServer();

    // 2 — create unit (step-up)
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/inpatient-units",
      headers: SUPER,
      payload: { facilityId: randomUUID(), displayName: "IPU North", bedCount: 8 },
    });
    expect(created.statusCode).toBe(201);
    const unitId = created.json().id as string;

    // 1 — list
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/inpatient-units",
      headers: SUPER,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((u: { id: string }) => u.id)).toContain(unitId);

    // 3 — update
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/inpatient-units/${unitId}`,
      headers: SUPER,
      payload: { displayName: "IPU North Wing" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().displayName).toBe("IPU North Wing");

    // 5b — create room
    const room = await app.inject({
      method: "POST",
      url: `/api/v1/inpatient-units/${unitId}/rooms`,
      headers: SUPER,
      payload: { roomNumber: "101", kind: "private", bedCount: 1 },
    });
    expect(room.statusCode).toBe(201);
    const roomId = room.json().id as string;

    // 5 — list rooms
    const rooms = await app.inject({
      method: "GET",
      url: `/api/v1/inpatient-units/${unitId}/rooms`,
      headers: SUPER,
    });
    expect(rooms.statusCode).toBe(200);
    expect(rooms.json().items.map((r: { id: string }) => r.id)).toContain(roomId);

    // 6 — update room
    const roomUpdated = await app.inject({
      method: "PATCH",
      url: `/api/v1/ipu-rooms/${roomId}`,
      headers: SUPER,
      payload: { roomNumber: "101A" },
    });
    expect(roomUpdated.statusCode).toBe(200);
    expect(roomUpdated.json().roomNumber).toBe("101A");

    // 7b — create bed
    const bed = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-rooms/${roomId}/beds`,
      headers: SUPER,
      payload: { bedLabel: "A" },
    });
    expect(bed.statusCode).toBe(201);
    const bedId = bed.json().id as string;

    // 7 — list beds
    const beds = await app.inject({
      method: "GET",
      url: `/api/v1/ipu-rooms/${roomId}/beds`,
      headers: SUPER,
    });
    expect(beds.statusCode).toBe(200);
    expect(beds.json().items.map((b: { id: string }) => b.id)).toContain(bedId);

    // 8 — update bed
    const bedUpdated = await app.inject({
      method: "PATCH",
      url: `/api/v1/ipu-beds/${bedId}`,
      headers: SUPER,
      payload: { bedLabel: "A1" },
    });
    expect(bedUpdated.statusCode).toBe(200);
    expect(bedUpdated.json().bedLabel).toBe("A1");

    // 4 — deactivate unit (step-up)
    const deactivated = await app.inject({
      method: "POST",
      url: `/api/v1/inpatient-units/${unitId}/deactivate`,
      headers: SUPER,
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json().isActive).toBe(false);

    await app.close();
  });
});

// ── routes 11, 13, 14, 16, 22 — open admission → request-bed → assign-bed → initiate-transfer → restraint
//    (previously the RN_COVERAGE universal-deny bug — see file header; now genuine 2xx coverage) ────────

describe("M37-T11 §4.1 admission open → bed → transfer → restraint (routes 11, 13, 14, 16, 22)", () => {
  it("POST /ipu-admissions (open admission) succeeds for a fully-permissioned, step-up-satisfied actor", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ipu-admissions",
      headers: SUPER,
      payload: {
        patientId: randomUUID(),
        admissionId: randomUUID(),
        levelOfCarePeriodId: randomUUID(),
        providerEntityId: randomUUID(),
        kind: "gip",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().state).toBe("pending");
    await app.close();
  });

  it("... including an 'arranged' admission — the §2.3 domain exemption applies", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ipu-admissions",
      headers: SUPER,
      payload: {
        patientId: randomUUID(),
        admissionId: randomUUID(),
        levelOfCarePeriodId: randomUUID(),
        providerEntityId: randomUUID(),
        remoteFacilityId: randomUUID(),
        kind: "arranged",
      },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("POST .../request-bed, .../assign-bed, .../initiate-transfer, .../restraint all succeed in sequence", async () => {
    const { app, service } = makeServer();
    // Seed an admission directly through the service (a setup convenience, not a workaround).
    const admission = await service.openAdmission(SEED_ACTOR, {
      patientId: randomUUID(),
      admissionId: randomUUID(),
      levelOfCarePeriodId: randomUUID(),
      providerEntityId: randomUUID(),
      kind: "gip",
    });

    const requestBed = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${admission.id}/request-bed`,
      headers: SUPER,
      payload: { unitId: randomUUID() },
    });
    expect(requestBed.statusCode).toBe(200);
    expect(requestBed.json().state).toBe("bed_pending");

    const assignBed = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${admission.id}/assign-bed`,
      headers: SUPER,
      payload: { bedId: randomUUID() },
    });
    expect(assignBed.statusCode).toBe(200);
    expect(assignBed.json().state).toBe("bed_assigned");

    const initiateTransfer = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${admission.id}/initiate-transfer`,
      headers: SUPER,
      payload: { targetKind: "to_home" },
    });
    expect(initiateTransfer.statusCode).toBe(200);
    expect(initiateTransfer.json().state).toBe("transfer_pending");

    const restraint = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${admission.id}/restraint`,
      headers: SUPER,
      payload: {
        restraintKind: "soft_limb",
        restraintJustificationText: "x".repeat(110),
        orderingOrderId: randomUUID(),
        category: "medical",
        reassessmentIntervalMinutes: 15,
      },
    });
    expect(restraint.statusCode).toBe(201);
    expect(restraint.json().state).toBe("active");

    await app.close();
  });
});

// ── routes 9, 10, 12, 15, 17-21 — admission-adjacent routes, reachable once an admission exists (seeded
//    directly through the service as a setup convenience) ─────────────────────────────────────────────

describe("M37-T11 §4.1 admission-adjacent routes (routes 9, 10, 12, 15, 17-21)", () => {
  it("reads/transitions a directly-seeded admission: list, get, confirm, confirm-transfer, discharge, gip-criteria attest+reassess, irc-cap-override; a seeded bed's cleaning-status also transitions", async () => {
    const { app, service } = makeServer();
    const admission = await service.openAdmission(SEED_ACTOR, {
      patientId: randomUUID(),
      admissionId: randomUUID(),
      levelOfCarePeriodId: randomUUID(),
      providerEntityId: randomUUID(),
      kind: "gip",
    });
    const unit = await service.createUnit(SEED_ACTOR, {
      facilityId: randomUUID(),
      displayName: "Seed Unit",
      bedCount: 2,
    });
    const room = await service.createRoom(SEED_ACTOR, unit.id, {
      roomNumber: "1",
      kind: "private",
      bedCount: 1,
    });
    const bed = await service.createBed(SEED_ACTOR, room.id, { bedLabel: "A" });

    // 10 — list
    const list = await app.inject({ method: "GET", url: "/api/v1/ipu-admissions", headers: SUPER });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((a: { id: string }) => a.id)).toContain(admission.id);

    // 12 — get
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/ipu-admissions/${admission.id}`,
      headers: SUPER,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().id).toBe(admission.id);

    // 15 — confirm (system-internal M6-ack handler)
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${admission.id}/confirm`,
      headers: SUPER,
      payload: {},
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().state).toBe("active");

    // 17 — confirm-transfer
    const confirmedTransfer = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${admission.id}/confirm-transfer`,
      headers: SUPER,
      payload: { destinationAcknowledged: true },
    });
    expect(confirmedTransfer.statusCode).toBe(200);
    expect(confirmedTransfer.json().state).toBe("transferred");

    // 19 — gip-criteria attest (step-up)
    const attested = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${admission.id}/gip-criteria`,
      headers: SUPER,
      payload: {
        attestingPhysicianId: randomUUID(),
        data: {
          criterion_kind: "imminent_death_terminal_care",
          clinical_estimate_days_to_death: 3,
          signs_of_imminent_death: ["mottling"],
          rationale_for_inpatient_setting: "x".repeat(110),
          home_environment_assessment_text: "y".repeat(60),
        },
      },
    });
    expect(attested.statusCode).toBe(201);

    // 20 — gip-criteria reassess
    const reassessed = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${admission.id}/gip-criteria/reassess`,
      headers: SUPER,
      payload: { criterionStillMet: true, rationale: "x".repeat(60) },
    });
    expect(reassessed.statusCode).toBe(200);

    // 21 — irc-cap-override (step-up)
    const ircOverride = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${admission.id}/irc-cap-override`,
      headers: SUPER,
      payload: { reason: "x".repeat(120), extensionDays: 1 },
    });
    expect(ircOverride.statusCode).toBe(200);
    expect(ircOverride.json().capOverrideInvoked).toBe(true);

    // 9 — bed cleaning-status transition
    const cleaning = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-beds/${bed.id}/cleaning-status`,
      headers: SUPER,
      payload: { event: "occupy" },
    });
    expect(cleaning.statusCode).toBe(200);
    expect(cleaning.json().cleaningStatus).toBe("occupied");

    // 18 — discharge
    const discharged = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${admission.id}/discharge`,
      headers: SUPER,
      payload: { reason: "to_home" },
    });
    expect(discharged.statusCode).toBe(200);
    expect(discharged.json().state).toBe("discharged");

    await app.close();
  });
});

// ── routes 23-24 — restraint reassess/release, using a directly-seeded restraint (apply is covered in the
//    admission lifecycle test above) ─────────────────────────────────────────────────────────────────────

describe("M37-T11 §4.1 restraint reassess/release (routes 23-24)", () => {
  it("reassesses then releases a directly-seeded restraint", async () => {
    const { app, service } = makeServer();
    const admissionId = randomUUID();
    const restraint = await service.applyRestraint(SEED_ACTOR, admissionId, {
      restraintKind: "mitt",
      restraintJustificationText: "x".repeat(110),
      orderingOrderId: randomUUID(),
      category: "medical",
      reassessmentIntervalMinutes: 30,
    });

    // 23
    const reassessed = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-restraint/${restraint.id}/reassess`,
      headers: SUPER,
      payload: { outcome: "continue", nextDueAt: NOW },
    });
    expect(reassessed.statusCode).toBe(200);

    // 24
    const released = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-restraint/${restraint.id}/release`,
      headers: SUPER,
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().state).toBe("released");

    await app.close();
  });
});

// ── routes 25-28 — shifts + staff + RN coverage read/break-glass ─────────────────────────────────────────

describe("M37-T11 §4.1 shifts + staff + RN coverage (routes 25-28)", () => {
  it("creates a shift, lists shifts, assigns + unassigns staff, reads coverage, invokes break-glass", async () => {
    const { app } = makeServer();

    // 25b — create shift
    const shift = await app.inject({
      method: "POST",
      url: "/api/v1/ipu-shifts",
      headers: SUPER,
      payload: {
        unitId: randomUUID(),
        shiftStartAt: "2026-08-04T07:00:00.000Z",
        shiftEndAt: "2026-08-04T19:00:00.000Z",
      },
    });
    expect(shift.statusCode).toBe(201);
    const shiftId = shift.json().id as string;

    // 25 — list shifts
    const list = await app.inject({ method: "GET", url: "/api/v1/ipu-shifts", headers: SUPER });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((s: { id: string }) => s.id)).toContain(shiftId);

    // 26 — assign staff
    const assigned = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-shifts/${shiftId}/staff`,
      headers: SUPER,
      payload: { membershipId: MEMBERSHIP, role: "rn" },
    });
    expect(assigned.statusCode).toBe(201);
    const assignmentId = assigned.json().id as string;

    // 26 (DELETE) — unassign staff
    const unassigned = await app.inject({
      method: "DELETE",
      url: `/api/v1/ipu-shifts/${shiftId}/staff`,
      headers: SUPER,
      payload: { assignmentId },
    });
    expect(unassigned.statusCode).toBe(200);
    expect(unassigned.json().state).toBe("unassigned");

    // 27 — read RN coverage
    const unitId = randomUUID();
    const coverage = await app.inject({
      method: "GET",
      url: `/api/v1/ipu-units/${unitId}/rn-coverage`,
      headers: SUPER,
    });
    expect(coverage.statusCode).toBe(200);
    expect(coverage.json().unitId).toBe(unitId);

    // 28 — break-glass override (step-up). F-071 — a reason and a bounded window are REQUIRED now.
    const breakGlassRes = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-units/${unitId}/rn-coverage/break-glass`,
      headers: SUPER,
      payload: {
        reason: "Night RN called out; charge nurse covering from the adjacent unit until 06:00.",
        durationMinutes: 120,
      },
    });
    expect(breakGlassRes.statusCode).toBe(200);
    expect(breakGlassRes.json().invoked).toBe(true);
    expect(breakGlassRes.json().alreadyActive).toBe(false);
    expect(typeof breakGlassRes.json().expiresAt).toBe("string");

    await app.close();
  });

  // ── F-071 ──────────────────────────────────────────────────────────────────────────────────────────

  it("break-glass REFUSES a bare POST — it used to take no body because it did nothing", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-units/${randomUUID()}/rn-coverage/break-glass`,
      headers: SUPER,
    });
    // Before F-071 this was a 200. The route now writes the row the coverage gate reads, so a caller
    // overriding the CoP 418.110(e) 24-hour-RN requirement has to say why and for how long.
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("break-glass refuses a reason below the 40-character floor and a window past 4 hours", async () => {
    const { app } = makeServer();
    const unitId = randomUUID();
    const short = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-units/${unitId}/rn-coverage/break-glass`,
      headers: SUPER,
      payload: { reason: "short", durationMinutes: 60 },
    });
    expect(short.statusCode).toBe(422);
    const tooLong = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-units/${unitId}/rn-coverage/break-glass`,
      headers: SUPER,
      payload: { reason: "x".repeat(60), durationMinutes: 300 },
    });
    expect(tooLong.statusCode).toBe(422);
    await app.close();
  });

  it("a second break-glass while one is live REPORTS it rather than stacking a second window", async () => {
    const { app } = makeServer();
    const unitId = randomUUID();
    const body = {
      reason: "Night RN called out; charge nurse covering from the adjacent unit until 06:00.",
      durationMinutes: 120,
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-units/${unitId}/rn-coverage/break-glass`,
      headers: SUPER,
      payload: body,
    });
    expect(first.json().alreadyActive).toBe(false);
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-units/${unitId}/rn-coverage/break-glass`,
      headers: SUPER,
      payload: { ...body, durationMinutes: 240 },
    });
    // "Break glass again" must not silently become an unbounded window — the 4-hour cap exists to deny
    // exactly that, and the DB's partial unique index makes a second live row impossible anyway.
    expect(second.json().alreadyActive).toBe(true);
    expect(second.json().expiresAt).toBe(first.json().expiresAt);
    await app.close();
  });
});

// ── routes 29-31 — visitors + visitor restrictions ────────────────────────────────────────────────────────

describe("M37-T11 §4.1 visitors + visitor restrictions (routes 29-31)", () => {
  it("checks a visitor in and out, applies then lifts a visitor restriction", async () => {
    const { app } = makeServer();

    // 29 — check in
    const checkedIn = await app.inject({
      method: "POST",
      url: "/api/v1/ipu-visitors",
      headers: SUPER,
      payload: {
        ipuAdmissionId: randomUUID(),
        visitorName: "Jordan Lee",
        relationship: "spouse",
        screeningOutcome: { feverFree: true },
      },
    });
    expect(checkedIn.statusCode).toBe(201);
    const visitorId = checkedIn.json().id as string;

    // 30 — check out
    const checkedOut = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-visitors/${visitorId}/check-out`,
      headers: SUPER,
    });
    expect(checkedOut.statusCode).toBe(200);
    expect(checkedOut.json().checkedOutAt).not.toBeNull();

    // 31 — apply restriction
    const applied = await app.inject({
      method: "POST",
      url: "/api/v1/ipu-visitor-restrictions",
      headers: SUPER,
      payload: {
        scope: "unit",
        unitId: randomUUID(),
        restrictionKind: "mask_required",
        rationale: "Local respiratory outbreak.",
        sourceKind: "infection_control",
      },
    });
    expect(applied.statusCode).toBe(201);
    const restrictionId = applied.json().id as string;

    // 31 (DELETE) — lift restriction
    const lifted = await app.inject({
      method: "DELETE",
      url: "/api/v1/ipu-visitor-restrictions",
      headers: SUPER,
      payload: { restrictionId },
    });
    expect(lifted.statusCode).toBe(200);
    expect(lifted.json().liftedAt).not.toBeNull();

    await app.close();
  });
});

// ── route 32 — meal logging ────────────────────────────────────────────────────────────────────────────

describe("M37-T11 §4.1 meal logging (route 32)", () => {
  it("logs a meal", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ipu-meals",
      headers: SUPER,
      payload: {
        ipuAdmissionId: randomUUID(),
        serviceDate: "2026-08-04",
        mealSlot: "lunch",
        intakeFraction: 0.5,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().mealSlot).toBe("lunch");
    await app.close();
  });
});

// ── routes 33-36 — equipment lifecycle ──────────────────────────────────────────────────────────────────

describe("M37-T11 §4.1 equipment lifecycle (routes 33-36)", () => {
  it("creates equipment, lists it, logs maintenance + an inspection, assigns it to a bed", async () => {
    const { app, service } = makeServer();
    const unit = await service.createUnit(SEED_ACTOR, {
      facilityId: randomUUID(),
      displayName: "Equip Seed Unit",
      bedCount: 1,
    });
    const room = await service.createRoom(SEED_ACTOR, unit.id, {
      roomNumber: "1",
      kind: "private",
      bedCount: 1,
    });
    const bed = await service.createBed(SEED_ACTOR, room.id, { bedLabel: "A" });

    // 33b — create
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/ipu-equipment",
      headers: SUPER,
      payload: {
        serialNumber: "SN-001",
        equipmentType: "oxygen_concentrator",
        manufacturer: "Acme",
        modelNumber: "OC-9",
      },
    });
    expect(created.statusCode).toBe(201);
    const equipmentId = created.json().id as string;

    // 33 — list
    const list = await app.inject({ method: "GET", url: "/api/v1/ipu-equipment", headers: SUPER });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((e: { id: string }) => e.id)).toContain(equipmentId);

    // 34 — maintenance
    const maintained = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-equipment/${equipmentId}/maintenance`,
      headers: SUPER,
      payload: { maintenanceKind: "filter_replacement" },
    });
    expect(maintained.statusCode).toBe(200);

    // 35 — inspection
    const inspected = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-equipment/${equipmentId}/inspection`,
      headers: SUPER,
      payload: {
        inspectionKind: "annual_biomed",
        outcome: "pass",
        nextInspectionDueDate: "2027-08-04",
      },
    });
    expect(inspected.statusCode).toBe(200);

    // 36 — assign to bed
    const assigned = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-equipment/${equipmentId}/assign-bed`,
      headers: SUPER,
      payload: { bedId: bed.id, patientId: randomUUID() },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().currentStatus).toBe("in_use");

    await app.close();
  });
});

// ── route 37 — body release coordination ────────────────────────────────────────────────────────────────

describe("M37-T11 §4.1 body release (route 37)", () => {
  it("advances a body release then reads it back", async () => {
    const { app } = makeServer();
    const admissionId = randomUUID();

    // 37 (POST) — advance
    const advanced = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-body-release/${admissionId}`,
      headers: SUPER,
      payload: { action: "identifyFuneralHome", funeralHomeId: randomUUID() },
    });
    expect(advanced.statusCode).toBe(200);

    // 37 (GET) — read
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/ipu-body-release/${admissionId}`,
      headers: SUPER,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().ipuAdmissionId).toBe(admissionId);

    await app.close();
  });
});

// ── route 38 — census snapshot ──────────────────────────────────────────────────────────────────────────

describe("M37-T11 §4.1 census (route 38)", () => {
  it("reads a census snapshot for a service date", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/ipu-census/2026-08-04",
      headers: SUPER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().serviceDate).toBe("2026-08-04");
    await app.close();
  });
});

// ── F-069 · the bedside reads ─────────────────────────────────────────────────────────────────────────
//
// `POST /ipu-restraint/:id/reassess`, `/release` and `POST /ipu-visitors/:id/check-out` are keyed by ids
// that no read route returned. Holding one meant BEING the browser session that performed the create —
// and a behavioral restraint is reassessed every 15 minutes, by whoever is on shift.

describe("M37 §4.1 bedside reads (F-069)", () => {
  it("an applied restraint is reachable by a LATER caller through the admission's list", async () => {
    const { app } = makeServer();
    const admissionId = randomUUID();
    const applied = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${admissionId}/restraint`,
      headers: SUPER,
      payload: {
        restraintKind: "soft_limb",
        restraintJustificationText: "x".repeat(120),
        orderingOrderId: randomUUID(),
        category: "behavioral",
        reassessmentIntervalMinutes: 15,
      },
    });
    expect(applied.statusCode).toBe(201);
    const restraintId = applied.json().id as string;

    // The list is the ONLY other way to this id. Without it the 15-minute reassessment below could be
    // recorded by nobody but the caller that applied the restraint, for as long as they kept the tab.
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/ipu-admissions/${admissionId}/restraints`,
      headers: SUPER,
    });
    expect(listed.statusCode).toBe(200);
    const items = listed.json().items as { id: string; reassessmentIntervalMinutes: number }[];
    expect(items.map((r) => r.id)).toContain(restraintId);
    expect(items[0]?.reassessmentIntervalMinutes).toBe(15);

    const reassessed = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-restraint/${items[0]?.id}/reassess`,
      headers: SUPER,
      payload: { outcome: "continue", nextDueAt: "2026-08-27T10:00:00.000Z" },
    });
    expect(reassessed.statusCode).toBe(200);
    await app.close();
  });

  it("a checked-in visitor is reachable by a LATER shift through the admission's list", async () => {
    const { app } = makeServer();
    const ipuAdmissionId = randomUUID();
    const checkedIn = await app.inject({
      method: "POST",
      url: "/api/v1/ipu-visitors",
      headers: SUPER,
      payload: {
        ipuAdmissionId,
        visitorName: "Jordan Lee",
        relationship: "spouse",
        screeningOutcome: { feverFree: true },
      },
    });
    expect(checkedIn.statusCode).toBe(201);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/ipu-visitors?ipuAdmissionId=${ipuAdmissionId}`,
      headers: SUPER,
    });
    expect(listed.statusCode).toBe(200);
    const items = listed.json().items as { id: string; checkedOutAt: string | null }[];
    expect(items.map((v) => v.id)).toContain(checkedIn.json().id);

    const out = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-visitors/${items[0]?.id}/check-out`,
      headers: SUPER,
    });
    expect(out.statusCode).toBe(200);
    await app.close();
  });

  it("the GIP criteria and IRC episode lists are readable for the bedside pane", async () => {
    const { app } = makeServer();
    const admissionId = randomUUID();
    for (const path of ["gip-criteria", "irc-episodes"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/ipu-admissions/${admissionId}/${path}`,
        headers: SUPER,
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().items)).toBe(true);
    }
    await app.close();
  });

  // ── F-070 ────────────────────────────────────────────────────────────────────────────────────────

  it("discharge no longer asks the caller whether the M6 discharge happened", async () => {
    const { app } = makeServer();
    const open = async () =>
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/ipu-admissions",
          headers: SUPER,
          payload: {
            patientId: randomUUID(),
            admissionId: randomUUID(),
            levelOfCarePeriodId: randomUUID(),
            providerEntityId: randomUUID(),
            kind: "gip",
          },
        })
      ).json().id as string;

    // `dischargeEventExists` was a REQUIRED boolean, so this exact payload was a 422 before F-070.
    const withoutField = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${await open()}/discharge`,
      headers: SUPER,
      payload: { reason: "to_home" },
    });
    expect(withoutField.statusCode).toBe(200);

    // A stale client still sending it is IGNORED, not honoured — the schema is non-strict (the repo
    // convention), so the property is dropped rather than rejected. Either way it reaches no gate:
    // the real service resolves the fact from M6's `AdmissionStatusReader`, which is what
    // `m37-ipu-write.live.test.ts` proves against a database.
    const withField = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-admissions/${await open()}/discharge`,
      headers: SUPER,
      payload: { reason: "to_home", dischargeEventExists: false },
    });
    expect(withField.statusCode).toBe(200);
    await app.close();
  });

  it("a shift's staff assignments are listed, and unassign is scoped to the shift in the path", async () => {
    const { app } = makeServer();
    const unitId = randomUUID();
    const shift = await app.inject({
      method: "POST",
      url: "/api/v1/ipu-shifts",
      headers: SUPER,
      payload: { unitId, shiftStartAt: NOW, shiftEndAt: NOW },
    });
    expect(shift.statusCode).toBe(201);
    const shiftId = shift.json().id as string;
    const assigned = await app.inject({
      method: "POST",
      url: `/api/v1/ipu-shifts/${shiftId}/staff`,
      headers: SUPER,
      payload: { membershipId: randomUUID(), role: "charge_rn" },
    });
    expect(assigned.statusCode).toBe(201);

    // The assignment id is reachable WITHOUT the 201 body — this is the whole point.
    const listed = await app.inject({ method: "GET", url: "/api/v1/ipu-shifts", headers: SUPER });
    const row = (listed.json().items as { id: string; assignments: { id: string }[] }[]).find(
      (s) => s.id === shiftId,
    );
    expect(row?.assignments.map((a) => a.id)).toEqual([assigned.json().id]);

    // A different shift in the path must not cancel this shift's assignment.
    const wrongShift = await app.inject({
      method: "DELETE",
      url: `/api/v1/ipu-shifts/${randomUUID()}/staff`,
      headers: SUPER,
      payload: { assignmentId: assigned.json().id },
    });
    expect(wrongShift.statusCode).toBe(404);

    const ok = await app.inject({
      method: "DELETE",
      url: `/api/v1/ipu-shifts/${shiftId}/staff`,
      headers: SUPER,
      payload: { assignmentId: assigned.json().id },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().state).toBe("unassigned");
    await app.close();
  });

  it("an applied visitor restriction is listed, so it can be lifted by someone else's session", async () => {
    const { app } = makeServer();
    const unitId = randomUUID();
    const applied = await app.inject({
      method: "POST",
      url: "/api/v1/ipu-visitor-restrictions",
      headers: SUPER,
      payload: {
        scope: "unit",
        unitId,
        restrictionKind: "mask_required",
        rationale: "Respiratory outbreak on the unit.",
        sourceKind: "outbreak_surveillance",
      },
    });
    expect(applied.statusCode).toBe(201);

    const active = await app.inject({
      method: "GET",
      url: `/api/v1/ipu-visitor-restrictions?unitId=${unitId}`,
      headers: SUPER,
    });
    expect(active.statusCode).toBe(200);
    expect((active.json().items as { id: string }[]).map((r) => r.id)).toEqual([applied.json().id]);

    const lifted = await app.inject({
      method: "DELETE",
      url: "/api/v1/ipu-visitor-restrictions",
      headers: SUPER,
      payload: { restrictionId: applied.json().id },
    });
    expect(lifted.statusCode).toBe(200);

    // Lifted rows leave the default (in-force) board and are readable through `active=false`.
    const afterLift = await app.inject({
      method: "GET",
      url: `/api/v1/ipu-visitor-restrictions?unitId=${unitId}`,
      headers: SUPER,
    });
    expect(afterLift.json().items).toEqual([]);
    const all = await app.inject({
      method: "GET",
      url: `/api/v1/ipu-visitor-restrictions?unitId=${unitId}&active=false`,
      headers: SUPER,
    });
    expect((all.json().items as { id: string }[]).map((r) => r.id)).toEqual([applied.json().id]);
    await app.close();
  });
});
