// apps/backend/src/modules/37-ipu/routes/service-drizzle.ts — the production M37 route service (T11b core
// spine). Every op runs inside ONE `withOrgContext(db, {organizationId, userId}, …)` transaction as the
// NOBYPASSRLS `wardenx_app` role, so tenant isolation is the RLS backstop, not app logic. Writes drive the
// pure @wardenx/inpatient machines (transitionBedCleaning, planOpenAdmission) and emit `m37.*` through the
// injected WriteOutboxPort in the SAME unit of work (transactional outbox). `userId` is the M2 session user
// id (the audit actor); `membershipId` stamps the row's created_by / by_membership_id columns.
import { type DbClient, schema } from "@wardenx/db";
import {
  INITIAL_BED_CLEANING_STATUS,
  planOpenAdmission,
  transitionBedCleaning,
} from "@wardenx/inpatient";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, NotFoundError } from "@wardenx/types";
import { and, desc, eq } from "drizzle-orm";
import type { IpuReadActor, IpuWriteActor } from "./actor";
import type { BedCleaningBody, CreateUnitBody, OpenAdmissionBody } from "./ipu-typebox";
import type { AdmissionView, BedView, CensusView, IpuRouteService, UnitView } from "./service";

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
