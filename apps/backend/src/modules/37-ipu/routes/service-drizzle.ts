// apps/backend/src/modules/37-ipu/routes/service-drizzle.ts — the production M37 route service (T11b core
// spine). Every op runs inside ONE `withOrgContext(db, {organizationId, userId}, …)` transaction as the
// NOBYPASSRLS `wardenx_app` role, so tenant isolation is the RLS backstop, not app logic. Writes drive the
// pure @wardenx/inpatient machines (transitionBedCleaning, planOpenAdmission) and emit `m37.*` through the
// injected WriteOutboxPort in the SAME unit of work (transactional outbox). `userId` is the M2 session user
// id (the audit actor); `membershipId` stamps the row's created_by / by_membership_id columns.
import { type DbClient, schema } from "@wardenx/db";
import {
  type AdmissionTransition,
  INITIAL_BED_CLEANING_STATUS,
  normalizeReassessmentInterval,
  planReassessmentOutcome,
  planOpenAdmission,
  transitionAdmission,
  transitionBedCleaning,
  validateRestraintApply,
} from "@wardenx/inpatient";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, NotFoundError } from "@wardenx/types";
import { and, desc, eq } from "drizzle-orm";
import type { IpuReadActor, IpuWriteActor } from "./actor";
import type {
  ApplyRestraintBody,
  AssignBedBody,
  BedCleaningBody,
  CreateBedBody,
  CreateRoomBody,
  CreateUnitBody,
  DischargeBody,
  OpenAdmissionBody,
  ReassessRestraintBody,
  RequestBedBody,
  UpdateBedBody,
  UpdateRoomBody,
  UpdateUnitBody,
} from "./ipu-typebox";
import type { AdmissionView, BedView, CensusView, IpuRouteService, RestraintView, RoomView, UnitView } from "./service";

/** The transactional-outbox port the composition root binds (the catalog-validating `m37` publisher). */
export interface WriteOutboxPort {
  publish(
    tx: unknown,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

const NOOP_OUTBOX: WriteOutboxPort = { async publish() {} };

export interface IpuRouteServiceDeps {
  readonly outbox?: WriteOutboxPort;
}

const iso = (d: Date): string => d.toISOString();
const ctx = (actor: IpuReadActor) => ({ organizationId: actor.organizationId, userId: actor.userId });

/** Build the production Drizzle-backed M37 route service. */
export function buildDrizzleIpuRouteService(db: DbClient, deps: IpuRouteServiceDeps = {}): IpuRouteService {
  const outbox = deps.outbox ?? NOOP_OUTBOX;
  const U = schema.inpatientUnit;
  const A = schema.ipuAdmission;
  const H = schema.ipuAdmissionStateHistory;
  const B = schema.ipuBed;
  const BCE = schema.ipuBedCleaningEvent;
  const C = schema.ipuCensusSnapshot;
  const RE = schema.ipuRestraintEvent;
  const RR = schema.ipuRestraintReassessment;
  const RM = schema.ipuRoom;

  const roomView = (r: typeof RM.$inferSelect): RoomView => ({
    id: r.id,
    unitId: r.unitId,
    roomNumber: r.roomNumber,
    kind: r.kind,
    bedCount: r.bedCount,
    isActive: r.isActive,
    version: r.version,
  });

  const restraintView = (r: typeof RE.$inferSelect): RestraintView => ({
    id: r.id,
    ipuAdmissionId: r.ipuAdmissionId,
    restraintKind: r.restraintKind,
    state: r.state,
    reassessmentIntervalMinutes: r.reassessmentIntervalMinutes,
    version: r.version,
  });

  const unitView = (r: typeof U.$inferSelect): UnitView => ({
    id: r.id,
    facilityId: r.facilityId,
    displayName: r.displayName,
    bedCount: r.bedCount,
    isActive: r.isActive,
    rnCoverageHorizonHours: r.rnCoverageHorizonHours,
    turnoverSlaMinutes: r.turnoverSlaMinutes,
    version: r.version,
  });
  const admissionView = (r: typeof A.$inferSelect): AdmissionView => ({
    id: r.id,
    patientId: r.patientId,
    kind: r.kind,
    state: r.state,
    unitId: r.unitId,
    remoteFacilityId: r.remoteFacilityId,
    openedAt: iso(r.openedAt),
    version: r.version,
  });
  const bedView = (r: typeof B.$inferSelect): BedView => ({
    id: r.id,
    roomId: r.roomId,
    unitId: r.unitId,
    bedLabel: r.bedLabel,
    cleaningStatus: r.cleaningStatus,
    version: r.version,
  });

  /**
   * Interpret an AdmissionTransition's declarative effects in the tx: the state-history row, a bed
   * assignment + source-bed cleaning transition, the IRC episode open/close, and the outbox emits. Then
   * bump the admission's state + version. `sourceBedId` is the bed whose cleaning cycle the transition drives
   * (the assigned bed on assignBed; the active-assignment bed on discharge/transfer).
   */
  async function applyAdmissionTransition(
    t: DbClient,
    actor: IpuWriteActor,
    admission: typeof A.$inferSelect,
    transition: AdmissionTransition,
    opts: { sourceBedId?: string; sourceBedStatus?: string } = {},
  ): Promise<void> {
    for (const eff of transition.effects) {
      if (eff.kind === "state_history") {
        await t.insert(H).values({
          organizationId: actor.organizationId,
          ipuAdmissionId: admission.id,
          fromState: transition.from,
          toState: eff.to,
          byMembershipId: actor.membershipId,
        });
      } else if (eff.kind === "persist_bed_assignment") {
        await t.insert(schema.ipuBedAssignment).values({
          organizationId: actor.organizationId,
          ipuAdmissionId: admission.id,
          bedId: eff.bedId,
          assignedBy: actor.membershipId,
        });
      } else if (eff.kind === "source_bed_cleaning" && opts.sourceBedId && opts.sourceBedStatus) {
        const bedResult = transitionBedCleaning(opts.sourceBedStatus as never, eff.event);
        await t
          .update(B)
          .set({ cleaningStatus: bedResult.to, cleaningStatusChangedAt: new Date() })
          .where(eq(B.id, opts.sourceBedId));
        await t.insert(BCE).values({
          organizationId: actor.organizationId,
          bedId: opts.sourceBedId,
          fromStatus: bedResult.from,
          toStatus: bedResult.to,
          byMembershipId: actor.membershipId,
        });
      } else if (eff.kind === "open_irc_episode") {
        await t.insert(schema.ircEpisode).values({
          organizationId: actor.organizationId,
          ipuAdmissionId: admission.id,
          providerEntityId: admission.providerEntityId,
          patientId: admission.patientId,
          expectedEndAt: new Date(Date.now() + 5 * 86_400_000),
        });
      } else if (eff.kind === "close_irc_episode") {
        await t
          .update(schema.ircEpisode)
          .set({ state: "closed", closedAt: new Date() })
          .where(eq(schema.ircEpisode.ipuAdmissionId, admission.id));
      } else if (eff.kind === "outbox") {
        await outbox.publish(t, {
          eventName: eff.event,
          payload: { ipuAdmissionId: admission.id, organizationId: actor.organizationId },
          organizationId: actor.organizationId,
          aggregateKind: "ipu_admission",
          aggregateId: admission.id,
        });
      }
    }
    await t
      .update(A)
      .set({ state: transition.to as never, updatedAt: new Date(), version: admission.version + 1 })
      .where(eq(A.id, admission.id));
  }

  return {
    async listUnits(actor) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const rows = await (tx as DbClient).select().from(U).orderBy(desc(U.createdAt));
        return rows.map(unitView);
      });
    },

    async createUnit(actor, body: CreateUnitBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const [row] = await (tx as DbClient)
          .insert(U)
          .values({
            organizationId: actor.organizationId,
            facilityId: body.facilityId,
            displayName: body.displayName,
            bedCount: body.bedCount,
            rnCoverageHorizonHours: body.rnCoverageHorizonHours ?? 8,
            turnoverSlaMinutes: body.turnoverSlaMinutes ?? 120,
          })
          .returning();
        if (!row) throw new ConflictError("unit insert failed");
        return unitView(row);
      });
    },

    async updateUnit(actor: IpuWriteActor, unitId: string, body: UpdateUnitBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [cur] = await t.select().from(U).where(eq(U.id, unitId)).limit(1);
        if (!cur) throw new NotFoundError("inpatient_unit not found");
        const [row] = await t
          .update(U)
          .set({
            displayName: body.displayName ?? cur.displayName,
            rnCoverageHorizonHours: body.rnCoverageHorizonHours ?? cur.rnCoverageHorizonHours,
            turnoverSlaMinutes: body.turnoverSlaMinutes ?? cur.turnoverSlaMinutes,
            gipReassessmentIntervalHours: body.gipReassessmentIntervalHours ?? cur.gipReassessmentIntervalHours,
            ircCapOverrideMaxDays: body.ircCapOverrideMaxDays ?? cur.ircCapOverrideMaxDays,
            updatedAt: new Date(),
            version: cur.version + 1,
          })
          .where(eq(U.id, unitId))
          .returning();
        if (!row) throw new ConflictError("unit update failed");
        return unitView(row);
      });
    },

    async deactivateUnit(actor: IpuWriteActor, unitId: string) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [cur] = await t.select().from(U).where(eq(U.id, unitId)).limit(1);
        if (!cur) throw new NotFoundError("inpatient_unit not found");
        const [row] = await t
          .update(U)
          .set({ isActive: false, updatedAt: new Date(), version: cur.version + 1 })
          .where(eq(U.id, unitId))
          .returning();
        if (!row) throw new ConflictError("unit deactivate failed");
        return unitView(row);
      });
    },

    async listRooms(actor, unitId: string) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const rows = await (tx as DbClient).select().from(RM).where(eq(RM.unitId, unitId));
        return rows.map(roomView);
      });
    },

    async createRoom(actor: IpuWriteActor, unitId: string, body: CreateRoomBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const [row] = await (tx as DbClient)
          .insert(RM)
          .values({
            organizationId: actor.organizationId,
            unitId,
            roomNumber: body.roomNumber,
            kind: body.kind,
            bedCount: body.bedCount,
            hasWindow: body.hasWindow ?? false,
            hasPrivateBathroom: body.hasPrivateBathroom ?? false,
            familyAmenitiesPresent: body.familyAmenitiesPresent ?? false,
          })
          .returning();
        if (!row) throw new ConflictError("room insert failed");
        return roomView(row);
      });
    },

    async updateRoom(actor: IpuWriteActor, roomId: string, body: UpdateRoomBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [cur] = await t.select().from(RM).where(eq(RM.id, roomId)).limit(1);
        if (!cur) throw new NotFoundError("ipu_room not found");
        const [row] = await t
          .update(RM)
          .set({
            roomNumber: body.roomNumber ?? cur.roomNumber,
            kind: body.kind ?? cur.kind,
            hasWindow: body.hasWindow ?? cur.hasWindow,
            hasPrivateBathroom: body.hasPrivateBathroom ?? cur.hasPrivateBathroom,
            familyAmenitiesPresent: body.familyAmenitiesPresent ?? cur.familyAmenitiesPresent,
            isActive: body.isActive ?? cur.isActive,
            updatedAt: new Date(),
            version: cur.version + 1,
          })
          .where(eq(RM.id, roomId))
          .returning();
        if (!row) throw new ConflictError("room update failed");
        return roomView(row);
      });
    },

    async listBeds(actor, roomId: string) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const rows = await (tx as DbClient).select().from(B).where(eq(B.roomId, roomId));
        return rows.map(bedView);
      });
    },

    async createBed(actor: IpuWriteActor, roomId: string, body: CreateBedBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [room] = await t.select().from(RM).where(eq(RM.id, roomId)).limit(1);
        if (!room) throw new NotFoundError("ipu_room not found");
        const [row] = await t
          .insert(B)
          .values({
            organizationId: actor.organizationId,
            roomId,
            unitId: room.unitId,
            bedLabel: body.bedLabel,
            geofenceLat: body.geofenceLat != null ? String(body.geofenceLat) : null,
            geofenceLon: body.geofenceLon != null ? String(body.geofenceLon) : null,
            geofenceRadiusMeters: body.geofenceRadiusMeters ?? 25,
          })
          .returning();
        if (!row) throw new ConflictError("bed insert failed");
        return bedView(row);
      });
    },

    async updateBed(actor: IpuWriteActor, bedId: string, body: UpdateBedBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [cur] = await t.select().from(B).where(eq(B.id, bedId)).limit(1);
        if (!cur) throw new NotFoundError("ipu_bed not found");
        const [row] = await t
          .update(B)
          .set({
            bedLabel: body.bedLabel ?? cur.bedLabel,
            geofenceLat: body.geofenceLat != null ? String(body.geofenceLat) : cur.geofenceLat,
            geofenceLon: body.geofenceLon != null ? String(body.geofenceLon) : cur.geofenceLon,
            geofenceRadiusMeters: body.geofenceRadiusMeters ?? cur.geofenceRadiusMeters,
            isActive: body.isActive ?? cur.isActive,
            updatedAt: new Date(),
            version: cur.version + 1,
          })
          .where(eq(B.id, bedId))
          .returning();
        if (!row) throw new ConflictError("bed update failed");
        return bedView(row);
      });
    },

    async listAdmissions(actor) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const rows = await (tx as DbClient).select().from(A).orderBy(desc(A.openedAt));
        return rows.map(admissionView);
      });
    },

    async getAdmission(actor, id) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const [row] = await (tx as DbClient).select().from(A).where(eq(A.id, id)).limit(1);
        return row ? admissionView(row) : null;
      });
    },

    async openAdmission(actor: IpuWriteActor, body: OpenAdmissionBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        // §2.3 D3 — resolve the unit's RN-coverage-active fact for the current hour (GIP/IRC gate; arranged
        // bypasses). Fail-closed: an unbuilt coverage grid reads uncovered. The machine re-asserts.
        let rnCoverageActive = false;
        if (body.kind !== "arranged" && body.unitId) {
          const hourStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
          const [cov] = await t
            .select()
            .from(schema.ipuRnCoverageWindow)
            .where(
              and(
                eq(schema.ipuRnCoverageWindow.unitId, body.unitId),
                eq(schema.ipuRnCoverageWindow.hourStartAt, hourStart),
              ),
            )
            .limit(1);
          rnCoverageActive = cov?.isCovered === true;
        }
        // Drive the pure machine (throws IPU_RN_COVERAGE_UNAVAILABLE when a GIP/IRC unit is uncovered).
        const plan = planOpenAdmission(body.kind, { rnCoverageActive });
        const [row] = await t
          .insert(A)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: body.providerEntityId,
            locationId: body.locationId ?? null,
            patientId: body.patientId,
            admissionId: body.admissionId,
            levelOfCarePeriodId: body.levelOfCarePeriodId,
            unitId: body.unitId ?? null,
            remoteFacilityId: body.remoteFacilityId ?? null,
            kind: body.kind,
            state: "pending",
            createdBy: actor.membershipId,
          })
          .returning();
        if (!row) throw new ConflictError("admission insert failed");
        // Persist the state-history row + emit the machine's outbox (opened).
        await t.insert(H).values({
          organizationId: actor.organizationId,
          ipuAdmissionId: row.id,
          fromState: null,
          toState: "pending",
          byMembershipId: actor.membershipId,
        });
        for (const eff of plan.effects) {
          if (eff.kind === "outbox") {
            await outbox.publish(t, {
              eventName: eff.event,
              payload: { ipuAdmissionId: row.id, organizationId: actor.organizationId, levelOfCarePeriodId: row.levelOfCarePeriodId, kind: row.kind },
              organizationId: actor.organizationId,
              aggregateKind: "ipu_admission",
              aggregateId: row.id,
            });
          }
        }
        return admissionView(row);
      });
    },

    async requestBed(actor: IpuWriteActor, admissionId: string, body: RequestBedBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [adm] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        if (!adm) throw new NotFoundError("ipu_admission not found");
        const [unit] = await t.select().from(U).where(eq(U.id, body.unitId)).limit(1);
        const hourStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
        const [cov] = await t
          .select()
          .from(schema.ipuRnCoverageWindow)
          .where(and(eq(schema.ipuRnCoverageWindow.unitId, body.unitId), eq(schema.ipuRnCoverageWindow.hourStartAt, hourStart)))
          .limit(1);
        const readyBeds = await t
          .select({ id: B.id })
          .from(B)
          .where(and(eq(B.unitId, body.unitId), eq(B.cleaningStatus, "ready")))
          .limit(1);
        const transition = transitionAdmission(adm.state, adm.kind, {
          type: "requestBed",
          unitActive: unit?.isActive === true,
          rnCoverageActive: cov?.isCovered === true,
          hasReadyBed: readyBeds.length > 0,
        });
        await applyAdmissionTransition(t, actor, adm, transition);
        const [updated] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        return admissionView(updated ?? adm);
      });
    },

    async assignBed(actor: IpuWriteActor, admissionId: string, body: AssignBedBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [adm] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        if (!adm) throw new NotFoundError("ipu_admission not found");
        const [bed] = await t.select().from(B).where(eq(B.id, body.bedId)).limit(1);
        if (!bed) throw new NotFoundError("ipu_bed not found");
        const transition = transitionAdmission(adm.state, adm.kind, {
          type: "assignBed",
          bedId: body.bedId,
          bedReady: (bed.cleaningStatus ?? INITIAL_BED_CLEANING_STATUS) === "ready",
          roomOccupancyAllowed: true, // M5 PrivacyFlagReader is a forward seam; default-allow until bound.
        });
        await applyAdmissionTransition(t, actor, adm, transition, {
          sourceBedId: body.bedId,
          sourceBedStatus: bed.cleaningStatus ?? INITIAL_BED_CLEANING_STATUS,
        });
        await t.update(A).set({ bedAssignedAt: new Date() }).where(eq(A.id, admissionId));
        const [updated] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        return admissionView(updated ?? adm);
      });
    },

    async discharge(actor: IpuWriteActor, admissionId: string, body: DischargeBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [adm] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        if (!adm) throw new NotFoundError("ipu_admission not found");
        // Resolve the active bed assignment (its bed goes discharged_dirty).
        const [ba] = await t
          .select()
          .from(schema.ipuBedAssignment)
          .where(and(eq(schema.ipuBedAssignment.ipuAdmissionId, admissionId)))
          .limit(1);
        let sourceBedId: string | undefined;
        let sourceBedStatus: string | undefined;
        if (ba) {
          const [bed] = await t.select().from(B).where(eq(B.id, ba.bedId)).limit(1);
          if (bed) {
            sourceBedId = bed.id;
            sourceBedStatus = bed.cleaningStatus ?? INITIAL_BED_CLEANING_STATUS;
          }
          await t.update(schema.ipuBedAssignment).set({ endedAt: new Date(), unassignReason: body.reason }).where(eq(schema.ipuBedAssignment.id, ba.id));
        }
        const transition = transitionAdmission(adm.state, adm.kind, { type: "discharge", dischargeEventExists: body.dischargeEventExists });
        await applyAdmissionTransition(t, actor, adm, transition, { sourceBedId, sourceBedStatus });
        const [updated] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        return admissionView(updated ?? adm);
      });
    },

    async transitionBed(actor: IpuWriteActor, bedId: string, body: BedCleaningBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [bed] = await t.select().from(B).where(eq(B.id, bedId)).limit(1);
        if (!bed) throw new NotFoundError("ipu_bed not found");
        // Drive the pure §2.12 machine (throws ILLEGAL_BED_CLEANING_TRANSITION on an illegal edge).
        const result = transitionBedCleaning(bed.cleaningStatus ?? INITIAL_BED_CLEANING_STATUS, body.event);
        const [updated] = await t
          .update(B)
          .set({ cleaningStatus: result.to, cleaningStatusChangedAt: new Date(), version: bed.version + 1 })
          .where(eq(B.id, bedId))
          .returning();
        if (!updated) throw new ConflictError("bed update failed");
        await t.insert(BCE).values({
          organizationId: actor.organizationId,
          bedId,
          fromStatus: result.from,
          toStatus: result.to,
          byMembershipId: actor.membershipId,
          notes: body.notes ?? null,
        });
        // Emit the bed lifecycle signal to M33/M36.
        const evt = result.event === "startCleaning" ? "m37.bed.cleaning_started" : result.event === "completeCleaning" ? "m37.bed.ready" : null;
        if (evt) {
          await outbox.publish(t, {
            eventName: evt,
            payload: { bedId, organizationId: actor.organizationId },
            organizationId: actor.organizationId,
            aggregateKind: "ipu_bed",
            aggregateId: bedId,
          });
        }
        return bedView(updated);
      });
    },

    async applyRestraint(actor: IpuWriteActor, admissionId: string, body: ApplyRestraintBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [adm] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        if (!adm) throw new NotFoundError("ipu_admission not found");
        // §2.10 — validate the application (step-up + physician order + ≥100-char justification) and floor
        // the reassessment interval by category. The DB CHECK is the schema backstop.
        validateRestraintApply({
          justificationText: body.restraintJustificationText,
          hasOrderingOrder: body.orderingOrderId.length > 0,
          stepUpVerified: actor.stepUpRecent,
        });
        const interval = normalizeReassessmentInterval(body.reassessmentIntervalMinutes, body.category);
        const [row] = await t
          .insert(RE)
          .values({
            organizationId: actor.organizationId,
            ipuAdmissionId: admissionId,
            restraintKind: body.restraintKind,
            restraintJustificationText: body.restraintJustificationText,
            orderingPhysicianId: body.orderingPhysicianId,
            orderingOrderId: body.orderingOrderId,
            appliedByMembershipId: actor.membershipId,
            appliedStepUpAssertionId: actor.membershipId, // the step-up assertion id (session-verified)
            reassessmentIntervalMinutes: interval,
          })
          .returning();
        if (!row) throw new ConflictError("restraint insert failed");
        await outbox.publish(t, {
          eventName: "m37.restraint.applied",
          payload: { ipuAdmissionId: admissionId, organizationId: actor.organizationId, restraintEventId: row.id, restraintKind: row.restraintKind },
          organizationId: actor.organizationId,
          aggregateKind: "ipu_restraint_event",
          aggregateId: row.id,
        });
        return restraintView(row);
      });
    },

    async reassessRestraint(actor: IpuWriteActor, restraintId: string, body: ReassessRestraintBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [ev] = await t.select().from(RE).where(eq(RE.id, restraintId)).limit(1);
        if (!ev) throw new NotFoundError("ipu_restraint_event not found");
        // §2.10 — the machine decides the disposition (continue keeps active; modify/release close it).
        const result = planReassessmentOutcome(ev.state, body.outcome);
        await t.insert(RR).values({
          organizationId: actor.organizationId,
          restraintEventId: restraintId,
          reassessedByMembershipId: actor.membershipId,
          outcome: body.outcome,
          notes: body.notes ?? null,
          nextDueAt: new Date(body.nextDueAt),
        });
        let updated = ev;
        if (result.closesEvent) {
          const [u] = await t
            .update(RE)
            .set({ state: result.nextState, releasedAt: new Date(), releasedByMembershipId: actor.membershipId, version: ev.version + 1 })
            .where(eq(RE.id, restraintId))
            .returning();
          if (u) updated = u;
        }
        await outbox.publish(t, {
          eventName: result.outbox,
          payload: { organizationId: actor.organizationId, restraintEventId: restraintId, outcome: body.outcome },
          organizationId: actor.organizationId,
          aggregateKind: "ipu_restraint_event",
          aggregateId: restraintId,
        });
        return restraintView(updated);
      });
    },

    async releaseRestraint(actor: IpuWriteActor, restraintId: string) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [ev] = await t.select().from(RE).where(eq(RE.id, restraintId)).limit(1);
        if (!ev) throw new NotFoundError("ipu_restraint_event not found");
        const result = planReassessmentOutcome(ev.state, "release");
        const [u] = await t
          .update(RE)
          .set({ state: result.nextState, releasedAt: new Date(), releasedByMembershipId: actor.membershipId, version: ev.version + 1 })
          .where(eq(RE.id, restraintId))
          .returning();
        if (!u) throw new ConflictError("restraint release failed");
        await outbox.publish(t, {
          eventName: "m37.restraint.released",
          payload: { organizationId: actor.organizationId, restraintEventId: restraintId },
          organizationId: actor.organizationId,
          aggregateKind: "ipu_restraint_event",
          aggregateId: restraintId,
        });
        return restraintView(u);
      });
    },

    async getCensus(actor, serviceDate): Promise<CensusView> {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const rows = await (tx as DbClient).select().from(C).where(eq(C.serviceDate, serviceDate));
        return {
          serviceDate,
          items: rows.map((r) => ({
            unitId: r.unitId,
            remoteFacilityId: r.remoteFacilityId,
            censusCountGip: r.censusCountGip,
            censusCountIrc: r.censusCountIrc,
            bedDaysGip: r.bedDaysGip,
            bedDaysIrc: r.bedDaysIrc,
            roomTurnoverCount: r.roomTurnoverCount,
            restraintIncidentCount: r.restraintIncidentCount,
          })),
        };
      });
    },
  };
}
