// apps/backend/src/modules/37-ipu/routes/service.ts — the M37 route-service interface the §4.1 handlers
// compose over. The Drizzle implementation (./service-drizzle) runs each op inside one withOrgContext tx
// under RLS and drives the pure @wardenx/inpatient machines; a test can substitute an in-memory backend.
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

export interface UnitView {
  readonly id: string;
  readonly facilityId: string;
  readonly displayName: string;
  readonly bedCount: number;
  readonly isActive: boolean;
  readonly rnCoverageHorizonHours: number;
  readonly turnoverSlaMinutes: number;
  readonly version: number;
}

export interface AdmissionView {
  readonly id: string;
  readonly patientId: string;
  readonly kind: string;
  readonly state: string;
  readonly unitId: string | null;
  readonly remoteFacilityId: string | null;
  readonly openedAt: string;
  readonly version: number;
}

export interface BedView {
  readonly id: string;
  readonly roomId: string;
  readonly unitId: string;
  readonly bedLabel: string;
  readonly cleaningStatus: string;
  readonly version: number;
}

export interface RoomView {
  readonly id: string;
  readonly unitId: string;
  readonly roomNumber: string;
  readonly kind: string;
  readonly bedCount: number;
  readonly isActive: boolean;
  readonly version: number;
}

export interface RestraintView {
  readonly id: string;
  readonly ipuAdmissionId: string;
  readonly restraintKind: string;
  readonly state: string;
  readonly reassessmentIntervalMinutes: number;
  readonly version: number;
}

export interface CensusRow {
  readonly unitId: string | null;
  readonly remoteFacilityId: string | null;
  readonly censusCountGip: number;
  readonly censusCountIrc: number;
  readonly bedDaysGip: number;
  readonly bedDaysIrc: number;
  readonly roomTurnoverCount: number;
  readonly restraintIncidentCount: number;
}
export interface CensusView {
  readonly serviceDate: string;
  readonly items: readonly CensusRow[];
}

/** The M37 route service (T11b core spine). */
export interface IpuRouteService {
  listUnits(actor: IpuReadActor): Promise<readonly UnitView[]>;
  createUnit(actor: IpuWriteActor, body: CreateUnitBody): Promise<UnitView>;
  updateUnit(actor: IpuWriteActor, unitId: string, body: UpdateUnitBody): Promise<UnitView>;
  deactivateUnit(actor: IpuWriteActor, unitId: string): Promise<UnitView>;
  listRooms(actor: IpuReadActor, unitId: string): Promise<readonly RoomView[]>;
  createRoom(actor: IpuWriteActor, unitId: string, body: CreateRoomBody): Promise<RoomView>;
  updateRoom(actor: IpuWriteActor, roomId: string, body: UpdateRoomBody): Promise<RoomView>;
  listBeds(actor: IpuReadActor, roomId: string): Promise<readonly BedView[]>;
  createBed(actor: IpuWriteActor, roomId: string, body: CreateBedBody): Promise<BedView>;
  updateBed(actor: IpuWriteActor, bedId: string, body: UpdateBedBody): Promise<BedView>;
  listAdmissions(actor: IpuReadActor): Promise<readonly AdmissionView[]>;
  getAdmission(actor: IpuReadActor, id: string): Promise<AdmissionView | null>;
  openAdmission(actor: IpuWriteActor, body: OpenAdmissionBody): Promise<AdmissionView>;
  requestBed(actor: IpuWriteActor, admissionId: string, body: RequestBedBody): Promise<AdmissionView>;
  assignBed(actor: IpuWriteActor, admissionId: string, body: AssignBedBody): Promise<AdmissionView>;
  discharge(actor: IpuWriteActor, admissionId: string, body: DischargeBody): Promise<AdmissionView>;
  transitionBed(actor: IpuWriteActor, bedId: string, body: BedCleaningBody): Promise<BedView>;
  getCensus(actor: IpuReadActor, serviceDate: string): Promise<CensusView>;
  applyRestraint(actor: IpuWriteActor, admissionId: string, body: ApplyRestraintBody): Promise<RestraintView>;
  reassessRestraint(actor: IpuWriteActor, restraintId: string, body: ReassessRestraintBody): Promise<RestraintView>;
  releaseRestraint(actor: IpuWriteActor, restraintId: string): Promise<RestraintView>;
}
