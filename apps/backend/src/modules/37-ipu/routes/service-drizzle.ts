// apps/backend/src/modules/37-ipu/routes/service-drizzle.ts — the production M37 route service (T11b core
// spine). Every op runs inside ONE `withOrgContext(db, {organizationId, userId}, …)` transaction as the
// NOBYPASSRLS `wardenx_app` role, so tenant isolation is the RLS backstop, not app logic. Writes drive the
// pure @wardenx/inpatient machines (transitionBedCleaning, planOpenAdmission) and emit `m37.*` through the
// injected WriteOutboxPort in the SAME unit of work (transactional outbox). `userId` is the M2 session user
// id (the audit actor); `membershipId` stamps the row's created_by / by_membership_id columns.
import { type DbClient, schema, todayForOrganization } from "@wardenx/db";
import {
  type AdmissionTransition,
  INITIAL_BED_CLEANING_STATUS,
  IpuStateError,
  RESTRAINT_REASSESS_FLOOR_MINUTES,
  type RoomOccupancyDecision,
  assertInspectionCurrent,
  computeIrcState,
  evaluateRoomOccupancy,
  evaluateVisitorCheckIn,
  isPrivateRoom,
  normalizeReassessmentInterval,
  planCapOverride,
  planOpenAdmission,
  planReassessmentOutcome,
  requireIpu,
  roomOccupancyDenyMessage,
  transitionAdmission,
  transitionBedCleaning,
  transitionBodyRelease,
  validateGipCriteriaPayload,
  validateRestraintApply,
  visitorConsentTypesFor,
} from "@wardenx/inpatient";
import { withOrgContext } from "@wardenx/tenancy";
import type { PatientPrivacyFlagReader, PatientRoomingFacts } from "@wardenx/types";
import { ConflictError, NotFoundError } from "@wardenx/types";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { IpuReadActor, IpuWriteActor } from "./actor";
import type {
  AdvanceBodyReleaseBody,
  ApplyRestraintBody,
  ApplyVisitorRestrictionBody,
  AssignBedBody,
  AssignEquipmentBedBody,
  AssignStaffBody,
  AttestGipBody,
  BedCleaningBody,
  CheckInVisitorBody,
  ConfirmBody,
  ConfirmTransferBody,
  CreateBedBody,
  CreateEquipmentBody,
  CreateRoomBody,
  CreateShiftBody,
  CreateUnitBody,
  DischargeBody,
  InitiateTransferBody,
  IrcOverrideBody,
  LiftVisitorRestrictionBody,
  LogInspectionBody,
  LogMaintenanceBody,
  LogMealBody,
  OpenAdmissionBody,
  ReassessGipBody,
  ReassessRestraintBody,
  RequestBedBody,
  UnassignStaffBody,
  UpdateBedBody,
  UpdateRoomBody,
  UpdateUnitBody,
} from "./ipu-typebox";
import type {
  AdmissionView,
  BedView,
  BodyReleaseView,
  CensusView,
  EquipmentView,
  GipCriteriaDetailView,
  GipCriteriaView,
  IpuRouteService,
  IrcEpisodeView,
  MealView,
  RestraintDetailView,
  RestraintView,
  RnCoverageView,
  RoomView,
  ShiftView,
  StaffAssignmentView,
  UnitView,
  VisitorRestrictionView,
  VisitorView,
} from "./service";

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

/**
 * The M5 §3.5 rooming read the §2.2 shared-room occupancy gate consults (GAP-061). Declared here as a
 * narrow PORT rather than resolved from the M1 registry inside the service, so the slice and the tests
 * can drive the gate without a boot; the composition root binds `getPatientPrivacyFlagReader()`.
 */
export type RoomingFactsPort = Pick<PatientPrivacyFlagReader, "roomingFactsFor">;

/** Unbound default: THROWS. `evaluateRoomOccupancyForBed` catches it and the pure gate refuses on
 *  absent facts — an unbound seam must never read as "the room is empty". */
const UNBOUND_ROOMING: RoomingFactsPort = {
  roomingFactsFor() {
    throw new Error("PatientPrivacyFlagReader is not bound");
  },
};

/**
 * The M39 `ConsentEvaluator` narrowed to the ONE method §2.7's visitor gate calls (GAP-062) — the M12
 * `DoseSpotConsentValidator` precedent. M39's rich interface lives in @wardenx/consent, which M37 does
 * not import; the seam is registered opaquely (`SeamContracts["ConsentEvaluator"] = unknown`) and this
 * subset is what M37 depends on, so no manifest edge appears.
 *
 * The spec asks for `ConsentEvaluator.evaluateForVisit(patientId, visitorRelationship)`. M39 publishes
 * no such method, and adding one would put IPU visitation vocabulary inside the consent module — so the
 * relationship → consent-type mapping stays in M37's pure core (`visitorConsentTypesFor`) and this calls
 * M39's real, general `evaluate` per candidate type.
 */
/**
 * The slice of M11's `OrderProvider` the restraint gate reads. Narrowed rather than imported whole for
 * the same reason `VisitorConsentGate` is: M37 consumes one method, and a narrow port is a smaller
 * thing for a test to fake honestly.
 */
export interface RestraintOrderReader {
  getOrder(input: { orderId: string }): Promise<{
    readonly orderId: string;
    readonly patientId: string;
    readonly status: string;
    readonly signedAt: string | null;
    readonly orderingPhysicianMdmId: string | null;
  } | null>;
}

export interface VisitorConsentGate {
  evaluate(args: {
    organizationId: string;
    patientId: string;
    consentType: string;
    sessionContext: { sessionClass: string; membershipId?: string };
    callerModule: string;
    callerRoute?: string;
  }): Promise<{
    allowed: boolean;
    consentRecordId?: string;
    consentVersionAtEval?: number;
    expiresAt?: string;
    denyReason?: string;
  }>;
}

/** Unbound default: THROWS, and the check-in gate turns that into the same 412 a denial produces. */
const UNBOUND_CONSENT: VisitorConsentGate = {
  evaluate() {
    throw new Error("ConsentEvaluator is not bound");
  },
};

/**
 * Unbound default: THROWS. A restraint applied while the order seam is unbound must fail, not proceed —
 * an unreadable order register is indistinguishable from an absent order, and CoP 418.110 does not have
 * a branch for "we could not check".
 */
const UNBOUND_ORDERS: RestraintOrderReader = {
  getOrder() {
    throw new Error("OrderProvider is not bound");
  },
};

export interface IpuRouteServiceDeps {
  readonly outbox?: WriteOutboxPort;
  /** M5 `PatientPrivacyFlagReader` (GAP-061). Bound lazily — the composition root passes a thunk so
   *  the seam is resolved per call, after `wireModuleSeams()` has run. */
  readonly rooming?: RoomingFactsPort | (() => RoomingFactsPort);
  /** M39 `ConsentEvaluator` (GAP-062), same lazy-thunk posture as `rooming`. */
  readonly consent?: VisitorConsentGate | (() => VisitorConsentGate);
  /** M11 `OrderProvider` (F-069) — the restraint gate's physician-order read, same thunk posture. */
  readonly orders?: RestraintOrderReader | (() => RestraintOrderReader);
}

const iso = (d: Date): string => d.toISOString();
const ctx = (actor: IpuReadActor) => ({
  organizationId: actor.organizationId,
  userId: actor.userId,
});

/** Build the production Drizzle-backed M37 route service. */
export function buildDrizzleIpuRouteService(
  db: DbClient,
  deps: IpuRouteServiceDeps = {},
): IpuRouteService {
  const outbox = deps.outbox ?? NOOP_OUTBOX;
  const roomingDep = deps.rooming ?? UNBOUND_ROOMING;
  const rooming = (): RoomingFactsPort =>
    typeof roomingDep === "function" ? roomingDep() : roomingDep;
  const consentDep = deps.consent ?? UNBOUND_CONSENT;
  const consentGate = (): VisitorConsentGate =>
    typeof consentDep === "function" ? consentDep() : consentDep;
  const ordersDep = deps.orders ?? UNBOUND_ORDERS;
  const orderReader = (): RestraintOrderReader =>
    typeof ordersDep === "function" ? ordersDep() : ordersDep;
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

  const GC = schema.gipAdmissionCriteria;
  const IE = schema.ircEpisode;
  const gipView = (r: typeof GC.$inferSelect): GipCriteriaView => ({
    id: r.id,
    ipuAdmissionId: r.ipuAdmissionId,
    criterionKind: r.criterionKind,
    attestedAt: iso(r.attestedAt),
    version: r.version,
  });
  const ircView = (r: typeof IE.$inferSelect): IrcEpisodeView => ({
    id: r.id,
    ipuAdmissionId: r.ipuAdmissionId,
    state: r.state,
    consecutiveDayCount: r.consecutiveDayCount,
    capOverrideInvoked: r.capOverrideInvoked,
    version: r.version,
  });

  /** Resolve the active bed for an admission (the un-ended bed_assignment's bed) + its cleaning status. */
  async function activeBedFor(
    t: DbClient,
    admissionId: string,
  ): Promise<{ id: string; status: string } | null> {
    const [ba] = await t
      .select()
      .from(schema.ipuBedAssignment)
      .where(eq(schema.ipuBedAssignment.ipuAdmissionId, admissionId))
      .limit(1);
    if (!ba) return null;
    const [bed] = await t.select().from(B).where(eq(B.id, ba.bedId)).limit(1);
    return bed ? { id: bed.id, status: bed.cleaningStatus ?? INITIAL_BED_CLEANING_STATUS } : null;
  }

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

  /**
   * §2.2 row 170 (GAP-061) — resolve the room, its current occupants and their M5 rooming facts, then
   * run the pure gate. Runs inside the caller's `withOrgContext` transaction, so both reads are
   * RLS-scoped; the M5 seam opens its own org-scoped read (it owns the patient tables, M37 does not).
   *
   * The seam is consulted ONLY when a shared room already holds someone else — a private room or an
   * empty room is decided from M37's own rows, so a private-room placement never depends on M5 being
   * reachable, and the common case costs no extra call.
   */
  async function evaluateRoomOccupancyForBed(
    t: DbClient,
    organizationId: string,
    target: { roomId: string; incomingPatientId: string },
  ): Promise<RoomOccupancyDecision> {
    // `FOR UPDATE` on the ROOM row is what makes this gate a gate rather than an advisory opinion.
    // The check is read-occupants-then-write-assignment, and the write lands on a BED, so bed-level
    // uniqueness cannot serialize two coordinators filling two different beds of the same semi-private
    // room: under READ COMMITTED each transaction's occupant read misses the other's uncommitted
    // assignment, both see `occupantPatientIds = []`, both take the `occupantCount === 0` allow path
    // without ever consulting M5, and both commit — producing exactly the mixed-sex placement this
    // gate exists to prevent. Locking the room serializes them, so the second transaction re-reads
    // the occupants only after the first has committed and sees the room as occupied.
    // The room row is the ONLY row locked here, and it is taken before any write, so there is no
    // lock-ordering cycle with the admission/bed reads in `assignBed`.
    const [room] = await t
      .select({ kind: schema.ipuRoom.kind })
      .from(schema.ipuRoom)
      .where(eq(schema.ipuRoom.id, target.roomId))
      .limit(1)
      .for("update");
    if (!room) throw new NotFoundError("ipu_room not found");

    // Everyone currently holding a bed in this room: an un-ended assignment on any bed of the room,
    // joined to its admission for the patient id.
    const occupantRows = await t
      .select({ patientId: A.patientId })
      .from(schema.ipuBedAssignment)
      .innerJoin(B, eq(B.id, schema.ipuBedAssignment.bedId))
      .innerJoin(A, eq(A.id, schema.ipuBedAssignment.ipuAdmissionId))
      .where(and(eq(B.roomId, target.roomId), isNull(schema.ipuBedAssignment.endedAt)));
    const occupantPatientIds = [
      ...new Set(
        occupantRows.map((r) => r.patientId).filter((id) => id !== target.incomingPatientId),
      ),
    ];

    if (isPrivateRoom(room.kind) || occupantPatientIds.length === 0) {
      return evaluateRoomOccupancy({
        roomKind: room.kind,
        incomingPatientId: target.incomingPatientId,
        occupantPatientIds,
        facts: [],
      });
    }

    // A shared room with company — M5 is the only source for the sex/privacy facts. A seam that
    // throws (unregistered, or a db-less boot) must NOT read as "nobody is in the room": catch it and
    // let the pure gate refuse on absent facts.
    let facts: readonly PatientRoomingFacts[] = [];
    try {
      facts = await rooming().roomingFactsFor({
        organizationId,
        patientIds: [target.incomingPatientId, ...occupantPatientIds],
      });
    } catch {
      facts = [];
    }
    return evaluateRoomOccupancy({
      roomKind: room.kind,
      incomingPatientId: target.incomingPatientId,
      occupantPatientIds,
      facts,
    });
  }

  /**
   * §2.7 (GAP-062) — the M39 consent gate on a non-immediate-family visitor. Returns the object
   * persisted verbatim into `ipu_visitor.consent_evaluator_result`: the evidence of WHAT was asked and
   * WHAT M39 answered, which is the artifact a surveyor reads. Structural only — no visitor name, no
   * patient identifier beyond the ids already on the row.
   *
   * Allowed when ANY candidate type is active. Denied → the caller raises `VISITOR_CONSENT_MISSING`;
   * an unreachable evaluator denies identically (`consent_evaluator_unavailable`), because "we could
   * not check" and "there is no consent" have the same correct answer at the front desk.
   */
  async function evaluateVisitorConsent(
    actor: IpuWriteActor,
    patientId: string,
    relationship: string,
    consentTypes: readonly string[],
  ): Promise<{ allowed: boolean; result: Record<string, unknown> }> {
    const evaluatedAt = iso(new Date());
    const attempts: Record<string, unknown>[] = [];
    for (const consentType of consentTypes) {
      let outcome: {
        allowed: boolean;
        consentRecordId?: string;
        consentVersionAtEval?: number;
        expiresAt?: string;
        denyReason?: string;
      };
      try {
        outcome = await consentGate().evaluate({
          organizationId: actor.organizationId,
          patientId,
          consentType,
          sessionContext: { sessionClass: "staff", membershipId: actor.membershipId },
          callerModule: "m37",
          callerRoute: "POST /api/v1/ipu-visitors",
        });
      } catch {
        return {
          allowed: false,
          result: {
            evaluated: true,
            relationship,
            consentTypesConsidered: [...consentTypes],
            allowed: false,
            denyReason: "consent_evaluator_unavailable",
            attempts,
            evaluatedAt,
          },
        };
      }
      attempts.push({
        consentType,
        allowed: outcome.allowed,
        ...(outcome.denyReason ? { denyReason: outcome.denyReason } : {}),
      });
      if (outcome.allowed) {
        return {
          allowed: true,
          result: {
            evaluated: true,
            relationship,
            consentTypesConsidered: [...consentTypes],
            allowed: true,
            satisfiedByConsentType: consentType,
            ...(outcome.consentRecordId ? { consentRecordId: outcome.consentRecordId } : {}),
            ...(outcome.consentVersionAtEval !== undefined
              ? { consentVersionAtEval: outcome.consentVersionAtEval }
              : {}),
            ...(outcome.expiresAt ? { expiresAt: outcome.expiresAt } : {}),
            attempts,
            evaluatedAt,
          },
        };
      }
    }
    // Report the most INFORMATIVE reason, not the last one tried. "There has never been a consent of
    // this type" is M39's default answer for every type the patient does not use, so a revoked or
    // expired record — the one the desk can act on — must not be buried behind it.
    const reasons = attempts
      .map((a) => a.denyReason)
      .filter((r): r is string => typeof r === "string");
    const denyReason =
      reasons.find((r) => r !== "no_active_consent_on_file") ??
      reasons[0] ??
      "no_active_consent_on_file";
    return {
      allowed: false,
      result: {
        evaluated: true,
        relationship,
        consentTypesConsidered: [...consentTypes],
        allowed: false,
        denyReason,
        attempts,
        evaluatedAt,
      },
    };
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
            gipReassessmentIntervalHours:
              body.gipReassessmentIntervalHours ?? cur.gipReassessmentIntervalHours,
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
              payload: {
                ipuAdmissionId: row.id,
                organizationId: actor.organizationId,
                levelOfCarePeriodId: row.levelOfCarePeriodId,
                kind: row.kind,
              },
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
          .where(
            and(
              eq(schema.ipuRnCoverageWindow.unitId, body.unitId),
              eq(schema.ipuRnCoverageWindow.hourStartAt, hourStart),
            ),
          )
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
        // §2.2 route-table row 170 (GAP-061) — the shared-room occupancy gate. Resolved HERE rather
        // than passed as a constant: the room's privacy classification and its current occupants are
        // M37 facts, the occupants' sex/privacy flags are M5's, and the policy joining them is M37's.
        const occupancy = await evaluateRoomOccupancyForBed(t, actor.organizationId, {
          roomId: bed.roomId,
          incomingPatientId: adm.patientId,
        });
        if (!occupancy.allowed) {
          // The machine's own guard (below) raises the same code from the boolean; raising here first
          // is what carries the REASON to the coordinator — "room holds a patient of a different
          // recorded sex" and "M5 could not be read" are different problems with different fixes.
          throw new IpuStateError(
            "IPU_ROOM_OCCUPANCY_CONFLICT",
            roomOccupancyDenyMessage(occupancy.denyReason ?? "rooming_facts_unavailable"),
          );
        }
        const transition = transitionAdmission(adm.state, adm.kind, {
          type: "assignBed",
          bedId: body.bedId,
          bedReady: (bed.cleaningStatus ?? INITIAL_BED_CLEANING_STATUS) === "ready",
          roomOccupancyAllowed: occupancy.allowed,
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
          await t
            .update(schema.ipuBedAssignment)
            .set({ endedAt: new Date(), unassignReason: body.reason })
            .where(eq(schema.ipuBedAssignment.id, ba.id));
        }
        const transition = transitionAdmission(adm.state, adm.kind, {
          type: "discharge",
          dischargeEventExists: body.dischargeEventExists,
        });
        await applyAdmissionTransition(t, actor, adm, transition, { sourceBedId, sourceBedStatus });
        const [updated] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        return admissionView(updated ?? adm);
      });
    },

    async confirm(actor: IpuWriteActor, admissionId: string, _body: ConfirmBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [adm] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        if (!adm) throw new NotFoundError("ipu_admission not found");
        const [gip] = await t
          .select({ id: GC.id })
          .from(GC)
          .where(eq(GC.ipuAdmissionId, admissionId))
          .limit(1);
        const bed = await activeBedFor(t, admissionId);
        // The route IS the M6 LCP ack handler (or force-flagged), so lcpConfirmed holds.
        const transition = transitionAdmission(adm.state, adm.kind, {
          type: "confirm",
          lcpConfirmed: true,
          gipCriteriaExists: gip !== undefined,
        });
        await applyAdmissionTransition(
          t,
          actor,
          adm,
          transition,
          bed ? { sourceBedId: bed.id, sourceBedStatus: bed.status } : {},
        );
        await t.update(A).set({ activatedAt: new Date() }).where(eq(A.id, admissionId));
        const [updated] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        return admissionView(updated ?? adm);
      });
    },

    async initiateTransfer(actor: IpuWriteActor, admissionId: string, body: InitiateTransferBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [adm] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        if (!adm) throw new NotFoundError("ipu_admission not found");
        // For a to_unit transfer, resolve the destination unit's RN coverage for the current hour.
        let destinationRnCoverage = true;
        if (body.targetKind === "to_unit" && body.destinationUnitId) {
          const hourStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
          const [cov] = await t
            .select()
            .from(schema.ipuRnCoverageWindow)
            .where(
              and(
                eq(schema.ipuRnCoverageWindow.unitId, body.destinationUnitId),
                eq(schema.ipuRnCoverageWindow.hourStartAt, hourStart),
              ),
            )
            .limit(1);
          destinationRnCoverage = cov?.isCovered === true;
        }
        const transition = transitionAdmission(adm.state, adm.kind, {
          type: "initiateTransfer",
          targetKind: body.targetKind,
          destinationRnCoverage,
        });
        // Persist the §2.2 transition ledger row + drive the machine's state/history/outbox effects.
        await t.insert(schema.ipuAdmissionTransition).values({
          organizationId: actor.organizationId,
          ipuAdmissionId: admissionId,
          kind: body.targetKind,
          destinationUnitId: body.destinationUnitId ?? null,
          destinationFacilityId: body.destinationFacilityId ?? null,
          reason: body.reason ?? null,
          initiatedBy: actor.membershipId,
        });
        await applyAdmissionTransition(t, actor, adm, transition);
        const [updated] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        return admissionView(updated ?? adm);
      });
    },

    async confirmTransfer(actor: IpuWriteActor, admissionId: string, body: ConfirmTransferBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [adm] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        if (!adm) throw new NotFoundError("ipu_admission not found");
        const bed = await activeBedFor(t, admissionId);
        const transition = transitionAdmission(adm.state, adm.kind, {
          type: "confirmTransfer",
          destinationAcknowledged: body.destinationAcknowledged,
        });
        await applyAdmissionTransition(
          t,
          actor,
          adm,
          transition,
          bed ? { sourceBedId: bed.id, sourceBedStatus: bed.status } : {},
        );
        if (bed) {
          await t
            .update(schema.ipuBedAssignment)
            .set({ endedAt: new Date(), unassignReason: "transfer" })
            .where(and(eq(schema.ipuBedAssignment.ipuAdmissionId, admissionId)));
        }
        const [updated] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        return admissionView(updated ?? adm);
      });
    },

    async attestGip(actor: IpuWriteActor, admissionId: string, body: AttestGipBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [adm] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        if (!adm) throw new NotFoundError("ipu_admission not found");
        const payload = validateGipCriteriaPayload(body.data); // 422 GIP_CRITERIA_INVALID_PAYLOAD on mismatch
        const [row] = await t
          .insert(GC)
          .values({
            organizationId: actor.organizationId,
            ipuAdmissionId: admissionId,
            criterionKind: payload.criterion_kind,
            data: payload,
            attestingPhysicianId: body.attestingPhysicianId,
            attestingMembershipId: actor.membershipId,
            stepUpAssertionId: actor.membershipId,
          })
          .returning();
        if (!row) throw new ConflictError("gip criteria insert failed");
        return gipView(row);
      });
    },

    async reassessGip(actor: IpuWriteActor, admissionId: string, body: ReassessGipBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [crit] = await t.select().from(GC).where(eq(GC.ipuAdmissionId, admissionId)).limit(1);
        if (!crit) throw new NotFoundError("gip_admission_criteria not found");
        await t.insert(schema.gipCriteriaReassessment).values({
          organizationId: actor.organizationId,
          gipAdmissionCriteriaId: crit.id,
          ipuAdmissionId: admissionId,
          triggeredByEncounterId: body.triggeredByEncounterId ?? null,
          reassessedByMembershipId: actor.membershipId,
          criterionStillMet: body.criterionStillMet,
          rationale: body.rationale,
          stepUpAssertionId: body.criterionStillMet ? null : actor.membershipId,
        });
        await outbox.publish(t, {
          eventName: "m37.gip_criteria.reassessment_completed",
          payload: {
            ipuAdmissionId: admissionId,
            organizationId: actor.organizationId,
            criterionStillMet: body.criterionStillMet,
          },
          organizationId: actor.organizationId,
          aggregateKind: "gip_admission_criteria",
          aggregateId: crit.id,
        });
        return gipView(crit);
      });
    },

    async overrideIrcCap(actor: IpuWriteActor, admissionId: string, body: IrcOverrideBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [ep] = await t.select().from(IE).where(eq(IE.ipuAdmissionId, admissionId)).limit(1);
        if (!ep) throw new NotFoundError("irc_episode not found");
        // §2.5 — break-glass: step-up + reason ≥100 + extension ≤2. Recompute the state under the new cap.
        const plan = planCapOverride({
          reason: body.reason,
          extensionDays: body.extensionDays,
          stepUpVerified: actor.stepUpRecent,
        });
        const nextState = computeIrcState(ep.consecutiveDayCount, plan.extensionDays);
        const [row] = await t
          .update(IE)
          .set({
            capOverrideInvoked: true,
            capOverrideInvokedBy: actor.membershipId,
            capOverrideReason: body.reason,
            capOverrideExtensionDays: plan.extensionDays,
            state: nextState,
            updatedAt: new Date(),
            version: ep.version + 1,
          })
          .where(eq(IE.id, ep.id))
          .returning();
        if (!row) throw new ConflictError("irc override failed");
        await outbox.publish(t, {
          eventName: "m37.irc_episode.cap_override_invoked",
          payload: {
            ipuAdmissionId: admissionId,
            organizationId: actor.organizationId,
            extensionDays: plan.extensionDays,
          },
          organizationId: actor.organizationId,
          aggregateKind: "irc_episode",
          aggregateId: ep.id,
        });
        return ircView(row);
      });
    },

    async listShifts(actor) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const S = schema.ipuShift;
        const rows = await (tx as DbClient).select().from(S).orderBy(desc(S.shiftStartAt));
        return rows.map(
          (r): ShiftView => ({
            id: r.id,
            unitId: r.unitId,
            shiftStartAt: iso(r.shiftStartAt),
            shiftEndAt: iso(r.shiftEndAt),
            displayLabel: r.displayLabel,
            version: r.version,
          }),
        );
      });
    },

    async createShift(actor: IpuWriteActor, body: CreateShiftBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const S = schema.ipuShift;
        const [row] = await (tx as DbClient)
          .insert(S)
          .values({
            organizationId: actor.organizationId,
            unitId: body.unitId,
            shiftStartAt: new Date(body.shiftStartAt),
            shiftEndAt: new Date(body.shiftEndAt),
            displayLabel: body.displayLabel ?? null,
            createdBy: actor.membershipId,
          })
          .returning();
        if (!row) throw new ConflictError("shift insert failed");
        return {
          id: row.id,
          unitId: row.unitId,
          shiftStartAt: iso(row.shiftStartAt),
          shiftEndAt: iso(row.shiftEndAt),
          displayLabel: row.displayLabel,
          version: row.version,
        };
      });
    },

    async assignStaff(actor: IpuWriteActor, shiftId: string, body: AssignStaffBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const SA = schema.ipuStaffAssignment;
        const [row] = await (tx as DbClient)
          .insert(SA)
          .values({
            organizationId: actor.organizationId,
            shiftId,
            membershipId: body.membershipId,
            role: body.role,
          })
          .returning();
        if (!row) throw new ConflictError("staff assignment insert failed");
        return {
          id: row.id,
          shiftId: row.shiftId,
          membershipId: row.membershipId,
          role: row.role,
          state: row.state,
        } satisfies StaffAssignmentView;
      });
    },

    async unassignStaff(actor: IpuWriteActor, _shiftId: string, body: UnassignStaffBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const SA = schema.ipuStaffAssignment;
        const t = tx as DbClient;
        const [cur] = await t.select().from(SA).where(eq(SA.id, body.assignmentId)).limit(1);
        if (!cur) throw new NotFoundError("ipu_staff_assignment not found");
        const [row] = await t
          .update(SA)
          .set({ state: "cancelled", cancelledAt: new Date(), version: cur.version + 1 })
          .where(eq(SA.id, body.assignmentId))
          .returning();
        if (!row) throw new ConflictError("unassign failed");
        return {
          id: row.id,
          shiftId: row.shiftId,
          membershipId: row.membershipId,
          role: row.role,
          state: row.state,
        } satisfies StaffAssignmentView;
      });
    },

    async getRnCoverage(actor, unitId: string): Promise<RnCoverageView> {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const W = schema.ipuRnCoverageWindow;
        const rows = await (tx as DbClient)
          .select()
          .from(W)
          .where(eq(W.unitId, unitId))
          .orderBy(W.hourStartAt);
        return {
          unitId,
          items: rows.map((r) => ({ hourStartAt: iso(r.hourStartAt), isCovered: r.isCovered })),
        };
      });
    },

    async invokeRnBreakGlass(actor: IpuWriteActor, unitId: string) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        // §2.3 — the break-glass override is a compliance signal; emit it (M36 critical + compliance log). The
        // override window semantics live in the @wardenx/inpatient break-glass kernel; there is no dedicated
        // persistence table, so the ABAC predicate reads the coverage window + this event stream.
        await outbox.publish(tx as DbClient, {
          eventName: "m37.rn_coverage.break_glass_invoked",
          payload: {
            unitId,
            organizationId: actor.organizationId,
            invokedAt: new Date().toISOString(),
          },
          organizationId: actor.organizationId,
          aggregateKind: "inpatient_unit",
          aggregateId: unitId,
        });
        return { unitId, invoked: true };
      });
    },

    async transitionBed(actor: IpuWriteActor, bedId: string, body: BedCleaningBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [bed] = await t.select().from(B).where(eq(B.id, bedId)).limit(1);
        if (!bed) throw new NotFoundError("ipu_bed not found");
        // Drive the pure §2.12 machine (throws ILLEGAL_BED_CLEANING_TRANSITION on an illegal edge).
        const result = transitionBedCleaning(
          bed.cleaningStatus ?? INITIAL_BED_CLEANING_STATUS,
          body.event,
        );
        const [updated] = await t
          .update(B)
          .set({
            cleaningStatus: result.to,
            cleaningStatusChangedAt: new Date(),
            version: bed.version + 1,
          })
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
        const evt =
          result.event === "startCleaning"
            ? "m37.bed.cleaning_started"
            : result.event === "completeCleaning"
              ? "m37.bed.ready"
              : null;
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

    // ── F-069 (read side) — the bedside reads ────────────────────────────────────────────────────────
    //
    // `reassessRestraint`, `releaseRestraint` and `checkOutVisitor` are keyed by ids that no read route
    // returned: the only way to hold one was to be the browser session that performed the POST. A
    // behavioral restraint is reassessed every 15 minutes and a visitor is checked out by a later
    // shift — both, by definition, by someone who did not do the create.
    async listRestraints(actor: IpuReadActor, admissionId: string) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const rows = await t
          .select()
          .from(RE)
          .where(eq(RE.ipuAdmissionId, admissionId))
          .orderBy(desc(RE.appliedAt));
        if (rows.length === 0) return [];
        const reassessments = await t
          .select()
          .from(RR)
          .where(
            inArray(
              RR.restraintEventId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(desc(RR.reassessedAt));
        return rows.map((r) => {
          const mine = reassessments.filter((x) => x.restraintEventId === r.id);
          return {
            id: r.id,
            ipuAdmissionId: r.ipuAdmissionId,
            restraintKind: r.restraintKind,
            // `category` is not a column: it is the interval FLOOR the application was normalized to,
            // and the two floors differ, so the interval recovers it. `normalizeReassessmentInterval`
            // is tighten-only, so a behavioral restraint can never exceed the behavioral floor.
            category: (r.reassessmentIntervalMinutes <= RESTRAINT_REASSESS_FLOOR_MINUTES.behavioral
              ? "behavioral"
              : "medical") as "behavioral" | "medical",
            state: r.state,
            reassessmentIntervalMinutes: r.reassessmentIntervalMinutes,
            appliedAt: iso(r.appliedAt),
            appliedByMembershipId: r.appliedByMembershipId,
            orderingOrderId: r.orderingOrderId,
            orderingPhysicianId: r.orderingPhysicianId,
            releasedAt: r.releasedAt ? iso(r.releasedAt) : null,
            nextDueAt: mine[0] ? iso(mine[0].nextDueAt) : null,
            reassessmentCount: mine.length,
            version: Number(r.version),
          } satisfies RestraintDetailView;
        });
      });
    },

    async listGipCriteria(actor: IpuReadActor, admissionId: string) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const rows = await t
          .select()
          .from(GC)
          .where(eq(GC.ipuAdmissionId, admissionId))
          .orderBy(desc(GC.attestedAt));
        if (rows.length === 0) return [];
        const GR = schema.gipCriteriaReassessment;
        const reassessments = await t
          .select()
          .from(GR)
          .where(
            inArray(
              GR.gipAdmissionCriteriaId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(desc(GR.assessedAt));
        return rows.map(
          (r) =>
            ({
              id: r.id,
              ipuAdmissionId: r.ipuAdmissionId,
              criterionKind: r.criterionKind,
              attestedAt: iso(r.attestedAt),
              attestingPhysicianId: r.attestingPhysicianId,
              // The `data` payload is deliberately NOT projected: it carries the §2.4 clinical
              // narrative (uncontrolled symptoms, signs of imminent death), which this read surface
              // does not publish. The M22 render is the readable document, with its own consent gate.
              reassessments: reassessments
                .filter((x) => x.gipAdmissionCriteriaId === r.id)
                .map((x) => ({
                  id: x.id,
                  reassessedAt: iso(x.assessedAt),
                  criterionStillMet: x.criterionStillMet,
                })),
              version: Number(r.version),
            }) satisfies GipCriteriaDetailView,
        );
      });
    },

    async listIrcEpisodes(actor: IpuReadActor, admissionId: string) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const rows = await t
          .select()
          .from(IE)
          .where(eq(IE.ipuAdmissionId, admissionId))
          .orderBy(desc(IE.startedAt));
        return rows.map(ircView);
      });
    },

    async listVisitors(actor: IpuReadActor, admissionId: string) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const rows = await t
          .select()
          .from(schema.ipuVisitor)
          .where(eq(schema.ipuVisitor.ipuAdmissionId, admissionId))
          .orderBy(desc(schema.ipuVisitor.checkedInAt));
        return rows.map(
          (r) =>
            ({
              id: r.id,
              ipuAdmissionId: r.ipuAdmissionId,
              relationship: r.relationship,
              maskRequired: r.maskRequired,
              checkedInAt: iso(r.checkedInAt),
              checkedOutAt: r.checkedOutAt ? iso(r.checkedOutAt) : null,
            }) satisfies VisitorView,
        );
      });
    },

    async applyRestraint(actor: IpuWriteActor, admissionId: string, body: ApplyRestraintBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [adm] = await t.select().from(A).where(eq(A.id, admissionId)).limit(1);
        if (!adm) throw new NotFoundError("ipu_admission not found");
        // §2.3 D3 — the same RN-coverage gate `openAdmission`/`requestBed`/`initiateTransfer` already
        // enforce server-side (mirrors their exact query — arranged admissions bypass; an unbuilt coverage
        // grid reads uncovered, fail-closed). This was previously ONLY gated by the `RN_COVERAGE` route
        // preHandler, which is unreachable-by-construction (requireAbac's `getTarget` is synchronous and
        // cannot query the materialized `ipu_rn_coverage_window` table, so it always saw an empty target
        // and denied every caller unconditionally — TASK-050A/TEST-003 finding). The preHandler is removed
        // (see routes/guards.ts, routes/ipu-routes.ts); this is now the sole enforcement point.
        if (adm.kind !== "arranged" && adm.unitId) {
          const hourStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
          const [cov] = await t
            .select()
            .from(schema.ipuRnCoverageWindow)
            .where(
              and(
                eq(schema.ipuRnCoverageWindow.unitId, adm.unitId),
                eq(schema.ipuRnCoverageWindow.hourStartAt, hourStart),
              ),
            )
            .limit(1);
          requireIpu(
            cov?.isCovered === true,
            "IPU_RN_COVERAGE_UNAVAILABLE",
            "The unit's 24/7 RN coverage is inactive; restraint application is blocked (D3).",
          );
        }
        // F-069 — RESOLVE the physician order before asking the machine about it.
        //
        // `hasOrderingOrder` used to be `body.orderingOrderId.length > 0`: whether the caller typed
        // anything into the field. `validateRestraintApply` refuses without it and quotes CoP 418.110
        // ("even in emergency"), so the one control the regulation is explicit about was satisfied by
        // any non-empty string, and the order the row claims to rest on was never looked for. M37 has
        // `dependsOn` 11 and `OrderProvider` has been registered the whole time.
        //
        // Three separate questions, because they have three different answers for the nurse standing at
        // the bedside: the order does not exist (wrong id), it is for someone else (wrong patient — the
        // one this check exists to catch), or it was never signed (an unsigned draft is not an order).
        const order = await orderReader().getOrder({ orderId: body.orderingOrderId });
        requireIpu(
          order !== null,
          "RESTRAINT_ORDER_REQUIRED",
          "No order with that id exists; a restraint cannot be applied without a physician order (CoP 418.110, even in emergency).",
        );
        requireIpu(
          order?.patientId === adm.patientId,
          "RESTRAINT_ORDER_REQUIRED",
          "That order belongs to a different patient; a restraint must rest on an order for THIS patient (CoP 418.110).",
        );
        requireIpu(
          order?.signedAt != null,
          "RESTRAINT_ORDER_REQUIRED",
          "That order has not been signed; an unsigned draft is not a physician order (CoP 418.110).",
        );
        // The ordering physician comes from the ORDER, not from a second uuid the caller supplies
        // alongside it. Two independent client assertions about one fact can name different people and
        // the record cannot say which is true. An order naming no ordering physician cannot authorise a
        // restraint, so that is a refusal rather than a null written into a NOT NULL column.
        const orderingPhysicianId = order?.orderingPhysicianMdmId ?? null;
        requireIpu(
          orderingPhysicianId !== null,
          "RESTRAINT_ORDER_REQUIRED",
          "That order names no ordering physician, so it cannot authorise a restraint (CoP 418.110).",
        );
        // §2.10 — validate the application (step-up + physician order + ≥100-char justification) and floor
        // the reassessment interval by category. The DB CHECK is the schema backstop.
        validateRestraintApply({
          justificationText: body.restraintJustificationText,
          hasOrderingOrder: true, // resolved above; the machine's fact is now the server's answer
          stepUpVerified: actor.stepUpRecent,
        });
        const interval = normalizeReassessmentInterval(
          body.reassessmentIntervalMinutes,
          body.category,
        );
        const [row] = await t
          .insert(RE)
          .values({
            organizationId: actor.organizationId,
            ipuAdmissionId: admissionId,
            restraintKind: body.restraintKind,
            restraintJustificationText: body.restraintJustificationText,
            orderingPhysicianId: orderingPhysicianId as string,
            orderingOrderId: body.orderingOrderId,
            appliedByMembershipId: actor.membershipId,
            // KNOWN GAP (F-069 §3, stated rather than papered over). This is NOT an assertion id — it is
            // the actor's membership, so every restraint the same nurse applies carries the same value
            // and the column cannot distinguish two applications. The platform has no uuid-identified
            // step-up assertion to put here: step-up state is `session.last_step_up_at` on a row whose
            // `id` is `text` (the same absence #165 found behind
            // `evv_missing_resolution.step_up_auth_ref_id`). Unlike that column this one is NOT NULL, so
            // it cannot be left empty until an M2 `step_up_session` exists. The step-up itself is real
            // and server-verified — `actor.stepUpRecent`, checked by the machine above.
            appliedStepUpAssertionId: actor.membershipId,
            reassessmentIntervalMinutes: interval,
          })
          .returning();
        if (!row) throw new ConflictError("restraint insert failed");
        await outbox.publish(t, {
          eventName: "m37.restraint.applied",
          payload: {
            ipuAdmissionId: admissionId,
            organizationId: actor.organizationId,
            restraintEventId: row.id,
            restraintKind: row.restraintKind,
          },
          organizationId: actor.organizationId,
          aggregateKind: "ipu_restraint_event",
          aggregateId: row.id,
        });
        return restraintView(row);
      });
    },

    async reassessRestraint(
      actor: IpuWriteActor,
      restraintId: string,
      body: ReassessRestraintBody,
    ) {
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
            .set({
              state: result.nextState,
              releasedAt: new Date(),
              releasedByMembershipId: actor.membershipId,
              version: ev.version + 1,
            })
            .where(eq(RE.id, restraintId))
            .returning();
          if (u) updated = u;
        }
        await outbox.publish(t, {
          eventName: result.outbox,
          payload: {
            organizationId: actor.organizationId,
            restraintEventId: restraintId,
            outcome: body.outcome,
          },
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
          .set({
            state: result.nextState,
            releasedAt: new Date(),
            releasedByMembershipId: actor.membershipId,
            version: ev.version + 1,
          })
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

    async checkInVisitor(actor: IpuWriteActor, body: CheckInVisitorBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [adm] = await t.select().from(A).where(eq(A.id, body.ipuAdmissionId)).limit(1);
        if (!adm) throw new NotFoundError("ipu_admission not found");
        // Resolve active restrictions: unit-scope (via the admission's unit) + patient-scope (via the patient).
        const VR = schema.ipuVisitorRestriction;
        const restrictions = await t.select().from(VR).where(isNull(VR.liftedAt));
        const applicable = restrictions
          .filter(
            (r) =>
              (r.scope === "unit" && r.unitId === adm.unitId) ||
              (r.scope === "patient" && r.patientId === adm.patientId),
          )
          .map((r) => ({ kind: r.restrictionKind }));
        // §2.7 — the machine throws VISITOR_RESTRICTION_FULL_BLOCK / VISITOR_IMMEDIATE_FAMILY_ONLY (412).
        const decision = evaluateVisitorCheckIn(body.relationship, applicable);
        // §2.7 (GAP-062) — the M39 consent gate. Immediate family needs no evaluation ("spouse visit is
        // consent-default-OK", W-IPU-07 step 5); everyone else needs an on-file authorization.
        const consentTypes = visitorConsentTypesFor(body.relationship);
        const consent =
          consentTypes === null
            ? {
                allowed: true,
                result: {
                  evaluated: false,
                  relationship: body.relationship,
                  reason: "immediate_family",
                  evaluatedAt: iso(new Date()),
                } as Record<string, unknown>,
              }
            : await evaluateVisitorConsent(actor, adm.patientId, body.relationship, consentTypes);
        if (!consent.allowed) {
          throw new IpuStateError(
            "VISITOR_CONSENT_MISSING",
            `A ${body.relationship} visitor needs the patient's (or representative's) consent on file; M39 returned ${String(consent.result.denyReason)}.`,
          );
        }
        const [row] = await t
          .insert(schema.ipuVisitor)
          .values({
            organizationId: actor.organizationId,
            ipuAdmissionId: body.ipuAdmissionId,
            visitorName: body.visitorName,
            relationship: body.relationship,
            screeningOutcome: body.screeningOutcome,
            consentEvaluatorResult: consent.result,
            checkedInBy: actor.membershipId,
            maskRequired: decision.maskRequired,
          })
          .returning();
        if (!row) throw new ConflictError("visitor insert failed");
        return {
          id: row.id,
          ipuAdmissionId: row.ipuAdmissionId,
          relationship: row.relationship,
          maskRequired: row.maskRequired,
          checkedInAt: iso(row.checkedInAt),
          checkedOutAt: row.checkedOutAt ? iso(row.checkedOutAt) : null,
        } satisfies VisitorView;
      });
    },

    async checkOutVisitor(actor: IpuWriteActor, visitorId: string) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [row] = await t
          .update(schema.ipuVisitor)
          .set({ checkedOutAt: new Date() })
          .where(eq(schema.ipuVisitor.id, visitorId))
          .returning();
        if (!row) throw new NotFoundError("ipu_visitor not found");
        return {
          id: row.id,
          ipuAdmissionId: row.ipuAdmissionId,
          relationship: row.relationship,
          maskRequired: row.maskRequired,
          checkedInAt: iso(row.checkedInAt),
          checkedOutAt: row.checkedOutAt ? iso(row.checkedOutAt) : null,
        } satisfies VisitorView;
      });
    },

    async applyVisitorRestriction(actor: IpuWriteActor, body: ApplyVisitorRestrictionBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const [row] = await (tx as DbClient)
          .insert(schema.ipuVisitorRestriction)
          .values({
            organizationId: actor.organizationId,
            scope: body.scope,
            unitId: body.unitId ?? null,
            patientId: body.patientId ?? null,
            restrictionKind: body.restrictionKind,
            rationale: body.rationale,
            appliedBy: actor.membershipId,
            sourceKind: body.sourceKind,
          })
          .returning();
        if (!row) throw new ConflictError("visitor restriction insert failed");
        await outbox.publish(tx as DbClient, {
          eventName: "m37.visitor_restriction.applied",
          payload: {
            organizationId: actor.organizationId,
            restrictionId: row.id,
            scope: row.scope,
            kind: row.restrictionKind,
          },
          organizationId: actor.organizationId,
          aggregateKind: "ipu_visitor_restriction",
          aggregateId: row.id,
        });
        return {
          id: row.id,
          scope: row.scope,
          restrictionKind: row.restrictionKind,
          liftedAt: null,
        } satisfies VisitorRestrictionView;
      });
    },

    async liftVisitorRestriction(actor: IpuWriteActor, body: LiftVisitorRestrictionBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [row] = await t
          .update(schema.ipuVisitorRestriction)
          .set({ liftedAt: new Date(), liftedBy: actor.membershipId })
          .where(eq(schema.ipuVisitorRestriction.id, body.restrictionId))
          .returning();
        if (!row) throw new NotFoundError("ipu_visitor_restriction not found");
        return {
          id: row.id,
          scope: row.scope,
          restrictionKind: row.restrictionKind,
          liftedAt: row.liftedAt ? iso(row.liftedAt) : null,
        } satisfies VisitorRestrictionView;
      });
    },

    async logMeal(actor: IpuWriteActor, body: LogMealBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const [row] = await (tx as DbClient)
          .insert(schema.ipuMealService)
          .values({
            organizationId: actor.organizationId,
            ipuAdmissionId: body.ipuAdmissionId,
            serviceDate: body.serviceDate,
            mealSlot: body.mealSlot,
            intakeFraction: body.intakeFraction != null ? String(body.intakeFraction) : null,
            refusalReason: body.refusalReason ?? null,
            caregiverAssistedFeeding: body.caregiverAssistedFeeding ?? false,
            oralCareCompleted: body.oralCareCompleted ?? false,
            recordedBy: actor.membershipId,
          })
          .returning();
        if (!row) throw new ConflictError("meal insert failed");
        return {
          id: row.id,
          ipuAdmissionId: row.ipuAdmissionId,
          serviceDate: row.serviceDate,
          mealSlot: row.mealSlot,
        } satisfies MealView;
      });
    },

    async listEquipment(actor) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const E = schema.ipuEquipment;
        const rows = await (tx as DbClient).select().from(E).orderBy(desc(E.createdAt));
        return rows.map(
          (r): EquipmentView => ({
            id: r.id,
            serialNumber: r.serialNumber,
            equipmentType: r.equipmentType,
            currentStatus: r.currentStatus,
            nextInspectionDueDate: r.nextInspectionDueDate,
            version: r.version,
          }),
        );
      });
    },

    async createEquipment(actor: IpuWriteActor, body: CreateEquipmentBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const [row] = await (tx as DbClient)
          .insert(schema.ipuEquipment)
          .values({
            organizationId: actor.organizationId,
            serialNumber: body.serialNumber,
            equipmentType: body.equipmentType,
            manufacturer: body.manufacturer,
            modelNumber: body.modelNumber,
            yearOfManufacture: body.yearOfManufacture ?? null,
          })
          .returning();
        if (!row) throw new ConflictError("equipment insert failed");
        return {
          id: row.id,
          serialNumber: row.serialNumber,
          equipmentType: row.equipmentType,
          currentStatus: row.currentStatus,
          nextInspectionDueDate: row.nextInspectionDueDate,
          version: row.version,
        } satisfies EquipmentView;
      });
    },

    async logMaintenance(actor: IpuWriteActor, equipmentId: string, body: LogMaintenanceBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [eq_] = await t
          .select()
          .from(schema.ipuEquipment)
          .where(eq(schema.ipuEquipment.id, equipmentId))
          .limit(1);
        if (!eq_) throw new NotFoundError("ipu_equipment not found");
        await t.insert(schema.ipuEquipmentMaintenance).values({
          organizationId: actor.organizationId,
          equipmentId,
          maintenanceKind: body.maintenanceKind,
          performedByMembershipId: actor.membershipId,
          notes: body.notes ?? null,
          vendorInvoiceReference: body.vendorInvoiceReference ?? null,
        });
        return {
          id: eq_.id,
          serialNumber: eq_.serialNumber,
          equipmentType: eq_.equipmentType,
          currentStatus: eq_.currentStatus,
          nextInspectionDueDate: eq_.nextInspectionDueDate,
          version: eq_.version,
        } satisfies EquipmentView;
      });
    },

    async logInspection(actor: IpuWriteActor, equipmentId: string, body: LogInspectionBody) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [eq_] = await t
          .select()
          .from(schema.ipuEquipment)
          .where(eq(schema.ipuEquipment.id, equipmentId))
          .limit(1);
        if (!eq_) throw new NotFoundError("ipu_equipment not found");
        await t.insert(schema.ipuEquipmentInspection).values({
          organizationId: actor.organizationId,
          equipmentId,
          inspectionKind: body.inspectionKind,
          inspectorMembershipId: actor.membershipId,
          outcome: body.outcome,
          notes: body.notes ?? null,
          nextInspectionDueDate: body.nextInspectionDueDate,
        });
        // Roll the equipment's next-due forward + record the last inspection date. PARAM-004: "the
        // date this inspection happened" is the ORG's operating calendar day, not a UTC-instant slice.
        const [row] = await t
          .update(schema.ipuEquipment)
          .set({
            nextInspectionDueDate: body.nextInspectionDueDate,
            lastInspectionDate: await todayForOrganization(t, actor.organizationId),
            updatedAt: new Date(),
            version: eq_.version + 1,
          })
          .where(eq(schema.ipuEquipment.id, equipmentId))
          .returning();
        if (!row) throw new ConflictError("inspection update failed");
        return {
          id: row.id,
          serialNumber: row.serialNumber,
          equipmentType: row.equipmentType,
          currentStatus: row.currentStatus,
          nextInspectionDueDate: row.nextInspectionDueDate,
          version: row.version,
        } satisfies EquipmentView;
      });
    },

    async assignEquipmentBed(
      actor: IpuWriteActor,
      equipmentId: string,
      body: AssignEquipmentBedBody,
    ) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [eq_] = await t
          .select()
          .from(schema.ipuEquipment)
          .where(eq(schema.ipuEquipment.id, equipmentId))
          .limit(1);
        if (!eq_) throw new NotFoundError("ipu_equipment not found");
        // §2.9 — an overdue biomed inspection blocks assignment (412 EQUIPMENT_INSPECTION_OVERDUE).
        const dueMs = eq_.nextInspectionDueDate ? new Date(eq_.nextInspectionDueDate).getTime() : 0;
        assertInspectionCurrent(dueMs, Date.now());
        const [row] = await t
          .update(schema.ipuEquipment)
          .set({
            currentLocationKind: "bed",
            currentBedId: body.bedId,
            currentAssignedPatientId: body.patientId,
            updatedAt: new Date(),
            version: eq_.version + 1,
          })
          .where(eq(schema.ipuEquipment.id, equipmentId))
          .returning();
        if (!row) throw new ConflictError("equipment assign failed");
        return {
          id: row.id,
          serialNumber: row.serialNumber,
          equipmentType: row.equipmentType,
          currentStatus: row.currentStatus,
          nextInspectionDueDate: row.nextInspectionDueDate,
          version: row.version,
        } satisfies EquipmentView;
      });
    },

    async getBodyRelease(actor, admissionId: string): Promise<BodyReleaseView | null> {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const [row] = await (tx as DbClient)
          .select()
          .from(schema.ipuBodyRelease)
          .where(eq(schema.ipuBodyRelease.ipuAdmissionId, admissionId))
          .limit(1);
        return row
          ? {
              id: row.id,
              ipuAdmissionId: row.ipuAdmissionId,
              state: row.state,
              version: row.version,
            }
          : null;
      });
    },

    async advanceBodyRelease(
      actor: IpuWriteActor,
      admissionId: string,
      body: AdvanceBodyReleaseBody,
    ) {
      return withOrgContext(db, ctx(actor), async (tx) => {
        const t = tx as DbClient;
        const [br] = await t
          .select()
          .from(schema.ipuBodyRelease)
          .where(eq(schema.ipuBodyRelease.ipuAdmissionId, admissionId))
          .limit(1);
        if (!br) throw new NotFoundError("ipu_body_release not found");
        const event =
          body.action === "identifyFuneralHome"
            ? {
                type: "identifyFuneralHome" as const,
                funeralHomeResolved: body.funeralHomeId !== undefined,
              }
            : body.action === "releaseBody"
              ? {
                  type: "releaseBody" as const,
                  hasReleaseDocument: body.releaseDocumentId !== undefined,
                }
              : { type: "postClose" as const, isSystemActor: true };
        const transition = transitionBodyRelease(br.state, event);
        const bed = body.action === "releaseBody" ? await activeBedFor(t, admissionId) : null;
        const patch: Record<string, unknown> = {
          state: transition.to,
          updatedAt: new Date(),
          version: br.version + 1,
        };
        if (body.action === "identifyFuneralHome" && body.funeralHomeId)
          patch.funeralHomeId = body.funeralHomeId;
        if (body.action === "releaseBody") {
          patch.releaseDocumentId = body.releaseDocumentId ?? br.releaseDocumentId;
          patch.releasedAt = new Date();
          patch.releasedByMembershipId = actor.membershipId;
          if (body.releasedToRepresentativeName)
            patch.releasedToRepresentativeName = body.releasedToRepresentativeName;
        }
        if (body.action === "postClose") patch.closedAt = new Date();
        for (const eff of transition.effects) {
          if (eff.kind === "outbox") {
            await outbox.publish(t, {
              eventName: eff.event,
              payload: {
                organizationId: actor.organizationId,
                bodyReleaseId: br.id,
                ...(eff.event === "m37.body_release.funeral_home_identified" && body.funeralHomeId
                  ? { funeralHomeId: body.funeralHomeId }
                  : {}),
              },
              organizationId: actor.organizationId,
              aggregateKind: "ipu_body_release",
              aggregateId: br.id,
            });
          } else if (eff.kind === "source_bed_cleaning" && bed) {
            const bedResult = transitionBedCleaning(bed.status as never, eff.event);
            await t
              .update(B)
              .set({ cleaningStatus: bedResult.to, cleaningStatusChangedAt: new Date() })
              .where(eq(B.id, bed.id));
            await t.insert(BCE).values({
              organizationId: actor.organizationId,
              bedId: bed.id,
              fromStatus: bedResult.from,
              toStatus: bedResult.to,
              byMembershipId: actor.membershipId,
            });
          }
        }
        const [row] = await t
          .update(schema.ipuBodyRelease)
          .set(patch)
          .where(eq(schema.ipuBodyRelease.id, br.id))
          .returning();
        if (!row) throw new ConflictError("body release update failed");
        return {
          id: row.id,
          ipuAdmissionId: row.ipuAdmissionId,
          state: row.state,
          version: row.version,
        };
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
