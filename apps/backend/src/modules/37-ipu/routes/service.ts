// apps/backend/src/modules/37-ipu/routes/service.ts — the M37 route-service interface the §4.1 handlers
// compose over. The Drizzle implementation (./service-drizzle) runs each op inside one withOrgContext tx
// under RLS and drives the pure @wardenx/inpatient machines; a test can substitute an in-memory backend.
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

export interface GipCriteriaView {
  readonly id: string;
  readonly ipuAdmissionId: string;
  readonly criterionKind: string;
  readonly attestedAt: string;
  readonly version: number;
}

export interface IrcEpisodeView {
  readonly id: string;
  readonly ipuAdmissionId: string;
  readonly state: string;
  readonly consecutiveDayCount: number;
  readonly capOverrideInvoked: boolean;
  readonly version: number;
}

export interface VisitorView {
  readonly id: string;
  readonly ipuAdmissionId: string;
  readonly relationship: string;
  readonly maskRequired: boolean;
  readonly checkedInAt: string;
  readonly checkedOutAt: string | null;
}
export interface VisitorRestrictionView {
  readonly id: string;
  readonly scope: string;
  readonly restrictionKind: string;
  readonly liftedAt: string | null;
}
export interface MealView {
  readonly id: string;
  readonly ipuAdmissionId: string;
  readonly serviceDate: string;
  readonly mealSlot: string;
}
export interface EquipmentView {
  readonly id: string;
  readonly serialNumber: string;
  readonly equipmentType: string;
  readonly currentStatus: string;
  readonly nextInspectionDueDate: string | null;
  readonly version: number;
}
export interface BodyReleaseView {
  readonly id: string;
  readonly ipuAdmissionId: string;
  readonly state: string;
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

export interface ShiftView {
  readonly id: string;
  readonly unitId: string;
  readonly shiftStartAt: string;
  readonly shiftEndAt: string;
  readonly displayLabel: string | null;
  readonly version: number;
}
export interface StaffAssignmentView {
  readonly id: string;
  readonly shiftId: string;
  readonly membershipId: string;
  readonly role: string;
  readonly state: string;
}
export interface RnCoverageView {
  readonly unitId: string;
  readonly items: ReadonlyArray<{ readonly hourStartAt: string; readonly isCovered: boolean }>;
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
  requestBed(
    actor: IpuWriteActor,
    admissionId: string,
    body: RequestBedBody,
  ): Promise<AdmissionView>;
  assignBed(actor: IpuWriteActor, admissionId: string, body: AssignBedBody): Promise<AdmissionView>;
  discharge(actor: IpuWriteActor, admissionId: string, body: DischargeBody): Promise<AdmissionView>;
  confirm(actor: IpuWriteActor, admissionId: string, body: ConfirmBody): Promise<AdmissionView>;
  initiateTransfer(
    actor: IpuWriteActor,
    admissionId: string,
    body: InitiateTransferBody,
  ): Promise<AdmissionView>;
  confirmTransfer(
    actor: IpuWriteActor,
    admissionId: string,
    body: ConfirmTransferBody,
  ): Promise<AdmissionView>;
  attestGip(
    actor: IpuWriteActor,
    admissionId: string,
    body: AttestGipBody,
  ): Promise<GipCriteriaView>;
  reassessGip(
    actor: IpuWriteActor,
    admissionId: string,
    body: ReassessGipBody,
  ): Promise<GipCriteriaView>;
  overrideIrcCap(
    actor: IpuWriteActor,
    admissionId: string,
    body: IrcOverrideBody,
  ): Promise<IrcEpisodeView>;
  listShifts(actor: IpuReadActor): Promise<readonly ShiftView[]>;
  createShift(actor: IpuWriteActor, body: CreateShiftBody): Promise<ShiftView>;
  assignStaff(
    actor: IpuWriteActor,
    shiftId: string,
    body: AssignStaffBody,
  ): Promise<StaffAssignmentView>;
  unassignStaff(
    actor: IpuWriteActor,
    shiftId: string,
    body: UnassignStaffBody,
  ): Promise<StaffAssignmentView>;
  getRnCoverage(actor: IpuReadActor, unitId: string): Promise<RnCoverageView>;
  invokeRnBreakGlass(
    actor: IpuWriteActor,
    unitId: string,
  ): Promise<{ unitId: string; invoked: boolean }>;
  transitionBed(actor: IpuWriteActor, bedId: string, body: BedCleaningBody): Promise<BedView>;
  getCensus(actor: IpuReadActor, serviceDate: string): Promise<CensusView>;
  applyRestraint(
    actor: IpuWriteActor,
    admissionId: string,
    body: ApplyRestraintBody,
  ): Promise<RestraintView>;
  reassessRestraint(
    actor: IpuWriteActor,
    restraintId: string,
    body: ReassessRestraintBody,
  ): Promise<RestraintView>;
  releaseRestraint(actor: IpuWriteActor, restraintId: string): Promise<RestraintView>;
  checkInVisitor(actor: IpuWriteActor, body: CheckInVisitorBody): Promise<VisitorView>;
  checkOutVisitor(actor: IpuWriteActor, visitorId: string): Promise<VisitorView>;
  applyVisitorRestriction(
    actor: IpuWriteActor,
    body: ApplyVisitorRestrictionBody,
  ): Promise<VisitorRestrictionView>;
  liftVisitorRestriction(
    actor: IpuWriteActor,
    body: LiftVisitorRestrictionBody,
  ): Promise<VisitorRestrictionView>;
  logMeal(actor: IpuWriteActor, body: LogMealBody): Promise<MealView>;
  listEquipment(actor: IpuReadActor): Promise<readonly EquipmentView[]>;
  createEquipment(actor: IpuWriteActor, body: CreateEquipmentBody): Promise<EquipmentView>;
  logMaintenance(
    actor: IpuWriteActor,
    equipmentId: string,
    body: LogMaintenanceBody,
  ): Promise<EquipmentView>;
  logInspection(
    actor: IpuWriteActor,
    equipmentId: string,
    body: LogInspectionBody,
  ): Promise<EquipmentView>;
  assignEquipmentBed(
    actor: IpuWriteActor,
    equipmentId: string,
    body: AssignEquipmentBedBody,
  ): Promise<EquipmentView>;
  getBodyRelease(actor: IpuReadActor, admissionId: string): Promise<BodyReleaseView | null>;
  advanceBodyRelease(
    actor: IpuWriteActor,
    admissionId: string,
    body: AdvanceBodyReleaseBody,
  ): Promise<BodyReleaseView>;
}
