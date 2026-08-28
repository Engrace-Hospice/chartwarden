// apps/backend/src/modules/37-ipu/routes/ipu-typebox.ts — M37 §4.2 request/response DTOs for the T11b core
// route spine (unit list/create, admission list/read/open, bed cleaning-status, census read). PHI-lean:
// ids + enum lifecycle codes + counts. The route layer validates the body against these before the service
// touches Drizzle; the enrichment registry points at the same schemas so openapi.json carries the contract.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { GipCriteriaPayload } from "@wardenx/inpatient";
import { ValidationError } from "@wardenx/types";

const id = Type.String({ minLength: 1 });

/** Parse+validate a request body/params against a TypeBox schema, raising a 422 ValidationError on mismatch. */
export function parse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) {
    const first = [...Value.Errors(schema, value)][0];
    throw new ValidationError(
      `Invalid request${first ? ` at '${first.path}': ${first.message}` : ""}`,
      [],
    );
  }
  return value as Static<T>;
}

// ── units (§4.1 routes 1–2) ──────────────────────────────────────────────────────────────────────────
export const CreateUnitBodySchema = Type.Object({
  facilityId: id,
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  bedCount: Type.Integer({ minimum: 0, maximum: 512 }),
  rnCoverageHorizonHours: Type.Optional(Type.Integer({ minimum: 8, maximum: 168 })),
  turnoverSlaMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
});
export type CreateUnitBody = Static<typeof CreateUnitBodySchema>;

export const UnitViewSchema = Type.Object({
  id,
  facilityId: id,
  displayName: Type.String(),
  bedCount: Type.Integer(),
  isActive: Type.Boolean(),
  rnCoverageHorizonHours: Type.Integer(),
  turnoverSlaMinutes: Type.Integer(),
  version: Type.Integer(),
});
export const UnitListSchema = Type.Object({ items: Type.Array(UnitViewSchema) });

// ── admissions (§4.1 routes 10–12) ───────────────────────────────────────────────────────────────────
export const OpenAdmissionBodySchema = Type.Object({
  patientId: id,
  admissionId: id,
  levelOfCarePeriodId: id,
  providerEntityId: id,
  locationId: Type.Optional(id),
  unitId: Type.Optional(id),
  remoteFacilityId: Type.Optional(id),
  kind: Type.Union([Type.Literal("gip"), Type.Literal("irc"), Type.Literal("arranged")]),
});
export type OpenAdmissionBody = Static<typeof OpenAdmissionBodySchema>;

export const AdmissionViewSchema = Type.Object({
  id,
  patientId: id,
  kind: Type.String(),
  state: Type.String(),
  unitId: Type.Union([id, Type.Null()]),
  remoteFacilityId: Type.Union([id, Type.Null()]),
  openedAt: Type.String(),
  version: Type.Integer(),
});
export const AdmissionListSchema = Type.Object({ items: Type.Array(AdmissionViewSchema) });

// ── unit update / rooms / beds (§4.1 routes 3–8) ───────────────────────────────────────────────────────
export const UpdateUnitBodySchema = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  rnCoverageHorizonHours: Type.Optional(Type.Integer({ minimum: 8, maximum: 168 })),
  turnoverSlaMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
  gipReassessmentIntervalHours: Type.Optional(Type.Integer({ minimum: 4, maximum: 24 })),
  ircCapOverrideMaxDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
});
export type UpdateUnitBody = Static<typeof UpdateUnitBodySchema>;

const roomKind = Type.Union([
  Type.Literal("private"),
  Type.Literal("semi_private"),
  Type.Literal("family"),
  Type.Literal("shared_overflow"),
]);
export const CreateRoomBodySchema = Type.Object({
  roomNumber: Type.String({ minLength: 1, maxLength: 40 }),
  kind: roomKind,
  bedCount: Type.Integer({ minimum: 0, maximum: 16 }),
  hasWindow: Type.Optional(Type.Boolean()),
  hasPrivateBathroom: Type.Optional(Type.Boolean()),
  familyAmenitiesPresent: Type.Optional(Type.Boolean()),
});
export type CreateRoomBody = Static<typeof CreateRoomBodySchema>;
export const UpdateRoomBodySchema = Type.Object({
  roomNumber: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  kind: Type.Optional(roomKind),
  hasWindow: Type.Optional(Type.Boolean()),
  hasPrivateBathroom: Type.Optional(Type.Boolean()),
  familyAmenitiesPresent: Type.Optional(Type.Boolean()),
  isActive: Type.Optional(Type.Boolean()),
});
export type UpdateRoomBody = Static<typeof UpdateRoomBodySchema>;
export const RoomViewSchema = Type.Object({
  id,
  unitId: id,
  roomNumber: Type.String(),
  kind: Type.String(),
  bedCount: Type.Integer(),
  isActive: Type.Boolean(),
  version: Type.Integer(),
});
export const RoomListSchema = Type.Object({ items: Type.Array(RoomViewSchema) });

export const CreateBedBodySchema = Type.Object({
  bedLabel: Type.String({ minLength: 1, maxLength: 40 }),
  geofenceLat: Type.Optional(Type.Number()),
  geofenceLon: Type.Optional(Type.Number()),
  geofenceRadiusMeters: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
});
export type CreateBedBody = Static<typeof CreateBedBodySchema>;
export const UpdateBedBodySchema = Type.Object({
  bedLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  geofenceLat: Type.Optional(Type.Number()),
  geofenceLon: Type.Optional(Type.Number()),
  geofenceRadiusMeters: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  isActive: Type.Optional(Type.Boolean()),
});
export type UpdateBedBody = Static<typeof UpdateBedBodySchema>;

// ── admission transitions (§4.1 routes 13–14, 18) ──────────────────────────────────────────────────────
export const RequestBedBodySchema = Type.Object({ unitId: id });
export type RequestBedBody = Static<typeof RequestBedBodySchema>;

export const AssignBedBodySchema = Type.Object({ bedId: id });
export type AssignBedBody = Static<typeof AssignBedBodySchema>;

export const DischargeBodySchema = Type.Object({
  reason: Type.Union([
    Type.Literal("to_home"),
    Type.Literal("to_facility"),
    Type.Literal("to_other_hospice"),
    Type.Literal("revocation"),
    Type.Literal("expired_benefit"),
  ]),
  // No `dischargeEventExists` (F-070). The machine refuses a discharge whose M6 side has not happened,
  // and that boolean used to be supplied BY THE CALLER — the party the guard exists to gate, for whom
  // `true` was the only sensible value. The service now resolves it from M6's `AdmissionStatusReader`.
});
export type DischargeBody = Static<typeof DischargeBodySchema>;

export const ConfirmBodySchema = Type.Object({
  /** The M6 LCP confirmation was force-flagged past the 30s window by an Admissions Coordinator. */
  forceFlag: Type.Optional(Type.Boolean()),
});
export type ConfirmBody = Static<typeof ConfirmBodySchema>;

export const InitiateTransferBodySchema = Type.Object({
  targetKind: Type.Union([
    Type.Literal("to_unit"),
    Type.Literal("to_home"),
    Type.Literal("to_facility"),
  ]),
  destinationUnitId: Type.Optional(id),
  destinationFacilityId: Type.Optional(id),
  reason: Type.Optional(Type.String({ maxLength: 1000 })),
});
export type InitiateTransferBody = Static<typeof InitiateTransferBodySchema>;

export const ConfirmTransferBodySchema = Type.Object({ destinationAcknowledged: Type.Boolean() });
export type ConfirmTransferBody = Static<typeof ConfirmTransferBodySchema>;

// ── GIP criteria (§4.1 routes 19–20) ───────────────────────────────────────────────────────────────────
export const AttestGipBodySchema = Type.Object({
  attestingPhysicianId: id,
  data: GipCriteriaPayload,
});
export type AttestGipBody = Static<typeof AttestGipBodySchema>;

export const ReassessGipBodySchema = Type.Object({
  criterionStillMet: Type.Boolean(),
  rationale: Type.String({ minLength: 50, maxLength: 4000 }),
  triggeredByEncounterId: Type.Optional(id),
});
export type ReassessGipBody = Static<typeof ReassessGipBodySchema>;

export const GipCriteriaViewSchema = Type.Object({
  id,
  ipuAdmissionId: id,
  criterionKind: Type.String(),
  attestedAt: Type.String(),
  version: Type.Integer(),
});

// ── IRC cap override (§4.1 route 21) ───────────────────────────────────────────────────────────────────
export const IrcOverrideBodySchema = Type.Object({
  reason: Type.String({ minLength: 100, maxLength: 4000 }),
  extensionDays: Type.Integer({ minimum: 1, maximum: 2 }),
});
export type IrcOverrideBody = Static<typeof IrcOverrideBodySchema>;

export const IrcEpisodeViewSchema = Type.Object({
  id,
  ipuAdmissionId: id,
  state: Type.String(),
  consecutiveDayCount: Type.Integer(),
  capOverrideInvoked: Type.Boolean(),
  version: Type.Integer(),
});

// ── bed cleaning-status (§4.1 route 9) ─────────────────────────────────────────────────────────────────
export const BedCleaningBodySchema = Type.Object({
  event: Type.Union([
    Type.Literal("reserve"),
    Type.Literal("occupy"),
    Type.Literal("dischargeDirty"),
    Type.Literal("startCleaning"),
    Type.Literal("completeCleaning"),
    Type.Literal("retire"),
    Type.Literal("expireReservation"),
  ]),
  notes: Type.Optional(Type.String({ maxLength: 1000 })),
});
export type BedCleaningBody = Static<typeof BedCleaningBodySchema>;

export const BedViewSchema = Type.Object({
  id,
  roomId: id,
  unitId: id,
  bedLabel: Type.String(),
  cleaningStatus: Type.String(),
  version: Type.Integer(),
});
export const BedListSchema = Type.Object({ items: Type.Array(BedViewSchema) });

// ── census (§4.1 route 38) ───────────────────────────────────────────────────────────────────────────
export const CensusListSchema = Type.Object({
  serviceDate: Type.String(),
  items: Type.Array(
    Type.Object({
      unitId: Type.Union([id, Type.Null()]),
      remoteFacilityId: Type.Union([id, Type.Null()]),
      censusCountGip: Type.Integer(),
      censusCountIrc: Type.Integer(),
      bedDaysGip: Type.Integer(),
      bedDaysIrc: Type.Integer(),
      roomTurnoverCount: Type.Integer(),
      restraintIncidentCount: Type.Integer(),
    }),
  ),
});

// ── shifts + RN coverage (§4.1 routes 25–28) ────────────────────────────────────────────────────────────
export const CreateShiftBodySchema = Type.Object({
  unitId: id,
  shiftStartAt: Type.String({ minLength: 1 }),
  shiftEndAt: Type.String({ minLength: 1 }),
  displayLabel: Type.Optional(Type.String({ maxLength: 80 })),
});
export type CreateShiftBody = Static<typeof CreateShiftBodySchema>;

export const AssignStaffBodySchema = Type.Object({
  membershipId: id,
  role: Type.Union([
    Type.Literal("charge_rn"),
    Type.Literal("rn"),
    Type.Literal("np_in_rn_role"),
    Type.Literal("lpn"),
    Type.Literal("cna"),
    Type.Literal("unit_secretary"),
    Type.Literal("housekeeping"),
    Type.Literal("pharmacist"),
    Type.Literal("social_worker_in_unit"),
    Type.Literal("chaplain_in_unit"),
    Type.Literal("medical_director_in_unit"),
  ]),
});
export type AssignStaffBody = Static<typeof AssignStaffBodySchema>;
export const StaffAssignmentViewSchema = Type.Object({
  id,
  shiftId: id,
  membershipId: id,
  role: Type.String(),
  state: Type.String(),
});

export const ShiftViewSchema = Type.Object({
  id,
  unitId: id,
  shiftStartAt: Type.String(),
  shiftEndAt: Type.String(),
  displayLabel: Type.Union([Type.String(), Type.Null()]),
  /**
   * F-070 — the shift's staff assignments. `DELETE /ipu-shifts/:id/staff` takes an `assignmentId`, and
   * before this the only place one existed was the 201 body of the POST that created it: unassigning
   * required BEING the browser session that assigned. Scheduling is not done in one sitting.
   *
   * This route's own `auditRead` config already described the response as carrying "staff assignments
   * by membership" — a claim about a payload no schema declared and no query built.
   */
  assignments: Type.Array(StaffAssignmentViewSchema),
  version: Type.Integer(),
});
export const ShiftListSchema = Type.Object({ items: Type.Array(ShiftViewSchema) });
export const UnassignStaffBodySchema = Type.Object({ assignmentId: id });
export type UnassignStaffBody = Static<typeof UnassignStaffBodySchema>;

export const RnCoverageViewSchema = Type.Object({
  unitId: id,
  items: Type.Array(Type.Object({ hourStartAt: Type.String(), isCovered: Type.Boolean() })),
});
export const RnBreakGlassViewSchema = Type.Object({ unitId: id, invoked: Type.Boolean() });

// ── restraint (§4.1 routes 22–24) ──────────────────────────────────────────────────────────────────────
// No `orderingPhysicianId` (F-069). It was a SECOND client-supplied uuid for a fact the order already
// carries, so the two could name different people and the record could not say which was true. The
// server now derives it from the resolved M11 order's `orderingPhysicianMdmId`; an order that names no
// ordering physician cannot authorise a restraint, which is a refusal rather than a null.
export const ApplyRestraintBodySchema = Type.Object({
  restraintKind: Type.Union([
    Type.Literal("soft_limb"),
    Type.Literal("posey_vest"),
    Type.Literal("mitt"),
    Type.Literal("side_rail_4"),
  ]),
  restraintJustificationText: Type.String({ minLength: 100, maxLength: 4000 }),
  /** The M11 order authorising the restraint. RESOLVED through `OrderProvider` — it must exist, be for
   *  this admission's patient, and be signed. Not merely non-empty (F-069). */
  orderingOrderId: id,
  category: Type.Union([Type.Literal("behavioral"), Type.Literal("medical")]),
  reassessmentIntervalMinutes: Type.Integer({ minimum: 1, maximum: 240 }),
});
export type ApplyRestraintBody = Static<typeof ApplyRestraintBodySchema>;

export const ReassessRestraintBodySchema = Type.Object({
  outcome: Type.Union([Type.Literal("continue"), Type.Literal("modify"), Type.Literal("release")]),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
  nextDueAt: Type.String({ minLength: 1 }),
});
export type ReassessRestraintBody = Static<typeof ReassessRestraintBodySchema>;

export const RestraintViewSchema = Type.Object({
  id,
  ipuAdmissionId: id,
  restraintKind: Type.String(),
  state: Type.String(),
  reassessmentIntervalMinutes: Type.Integer(),
  version: Type.Integer(),
});

// F-069 (read side) — the three POST-only surfaces below had NO read route, so the id each of them
// needs was obtainable only from the response of the POST that created it, inside one browser session.
// A behavioral restraint is reassessed every 15 minutes and a visitor is checked out by a later shift:
// both are, by definition, done by someone who did not perform the create. The lists close that.
export const RestraintDetailViewSchema = Type.Object({
  id,
  ipuAdmissionId: id,
  restraintKind: Type.String(),
  category: Type.Union([Type.Literal("behavioral"), Type.Literal("medical")]),
  state: Type.String(),
  reassessmentIntervalMinutes: Type.Integer(),
  appliedAt: Type.String(),
  appliedByMembershipId: id,
  orderingOrderId: id,
  orderingPhysicianId: id,
  releasedAt: Type.Union([Type.String(), Type.Null()]),
  /** The most recent reassessment's `next_due_at` — what a bedside board counts down to. Null until
   *  the first reassessment, when the interval from `appliedAt` is the clock instead. */
  nextDueAt: Type.Union([Type.String(), Type.Null()]),
  reassessmentCount: Type.Integer(),
  version: Type.Integer(),
});
export const RestraintListSchema = Type.Object({
  items: Type.Array(RestraintDetailViewSchema),
});

export const GipCriteriaDetailViewSchema = Type.Object({
  id,
  ipuAdmissionId: id,
  criterionKind: Type.String(),
  attestedAt: Type.String(),
  attestingPhysicianId: id,
  /** Reassessments recorded against this attestation, newest first (§2.4 — GIP is reassessed daily). */
  reassessments: Type.Array(
    Type.Object({
      id,
      reassessedAt: Type.String(),
      criterionStillMet: Type.Boolean(),
    }),
  ),
  version: Type.Integer(),
});
export const GipCriteriaListSchema = Type.Object({
  items: Type.Array(GipCriteriaDetailViewSchema),
});

export const IrcEpisodeListSchema = Type.Object({
  items: Type.Array(IrcEpisodeViewSchema),
});

// ── visitor (§4.1 routes 29–31) ────────────────────────────────────────────────────────────────────────
const relationship = Type.Union([
  Type.Literal("spouse"),
  Type.Literal("parent"),
  Type.Literal("child"),
  Type.Literal("sibling"),
  Type.Literal("grandparent"),
  Type.Literal("grandchild"),
  Type.Literal("in_law"),
  Type.Literal("aunt_uncle"),
  Type.Literal("cousin"),
  Type.Literal("friend"),
  Type.Literal("clergy"),
  Type.Literal("volunteer"),
  Type.Literal("caregiver_paid"),
  Type.Literal("legal_representative"),
  Type.Literal("other"),
]);
export const CheckInVisitorBodySchema = Type.Object({
  ipuAdmissionId: id,
  visitorName: Type.String({ minLength: 1, maxLength: 200 }),
  relationship,
  screeningOutcome: Type.Record(Type.String(), Type.Unknown()),
});
export type CheckInVisitorBody = Static<typeof CheckInVisitorBodySchema>;
export const VisitorViewSchema = Type.Object({
  id,
  ipuAdmissionId: id,
  relationship: Type.String(),
  maskRequired: Type.Boolean(),
  checkedInAt: Type.String(),
  checkedOutAt: Type.Union([Type.String(), Type.Null()]),
});
export const VisitorListSchema = Type.Object({ items: Type.Array(VisitorViewSchema) });
export const VisitorListQuerySchema = Type.Object({ ipuAdmissionId: id });

export const ApplyVisitorRestrictionBodySchema = Type.Object({
  scope: Type.Union([Type.Literal("unit"), Type.Literal("patient")]),
  unitId: Type.Optional(id),
  patientId: Type.Optional(id),
  restrictionKind: Type.Union([
    Type.Literal("full_block"),
    Type.Literal("immediate_family_only"),
    Type.Literal("mask_required"),
    Type.Literal("time_limited"),
    Type.Literal("no_overnight"),
  ]),
  rationale: Type.String({ minLength: 1, maxLength: 2000 }),
  sourceKind: Type.String({ minLength: 1, maxLength: 60 }),
});
export type ApplyVisitorRestrictionBody = Static<typeof ApplyVisitorRestrictionBodySchema>;
export const VisitorRestrictionViewSchema = Type.Object({
  id,
  scope: Type.String(),
  restrictionKind: Type.String(),
  liftedAt: Type.Union([Type.String(), Type.Null()]),
});
export const LiftVisitorRestrictionBodySchema = Type.Object({ restrictionId: id });

// F-070 (read side) — `POST` applied a restriction and `DELETE` lifted one by `restrictionId`, and there
// was NO read route: the id existed only in the 201 of the POST. A `full_block` or `mask_required`
// restriction persists until lifted, so this made an infection-control block liftable only by whoever
// still had the tab that applied it. Same defect as the F-069 restraint/visitor ids, one module over.
export const VisitorRestrictionDetailViewSchema = Type.Object({
  id,
  scope: Type.String(),
  unitId: Type.Union([id, Type.Null()]),
  patientId: Type.Union([id, Type.Null()]),
  restrictionKind: Type.String(),
  rationale: Type.String(),
  sourceKind: Type.String(),
  appliedAt: Type.String(),
  appliedBy: id,
  appliedUntil: Type.Union([Type.String(), Type.Null()]),
  liftedAt: Type.Union([Type.String(), Type.Null()]),
  version: Type.Integer(),
});
export const VisitorRestrictionListSchema = Type.Object({
  items: Type.Array(VisitorRestrictionDetailViewSchema),
});
/** `active=true` (the default) hides lifted rows — a board of what is currently in force. */
export const VisitorRestrictionListQuerySchema = Type.Object({
  unitId: Type.Optional(id),
  patientId: Type.Optional(id),
  active: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
});
export type VisitorRestrictionListQuery = Static<typeof VisitorRestrictionListQuerySchema>;
export type LiftVisitorRestrictionBody = Static<typeof LiftVisitorRestrictionBodySchema>;

// ── meal (§4.1 route 32) ───────────────────────────────────────────────────────────────────────────────
export const LogMealBodySchema = Type.Object({
  ipuAdmissionId: id,
  serviceDate: Type.String({ minLength: 8, maxLength: 10 }),
  mealSlot: Type.Union([
    Type.Literal("breakfast"),
    Type.Literal("lunch"),
    Type.Literal("dinner"),
    Type.Literal("snack"),
  ]),
  intakeFraction: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  refusalReason: Type.Optional(Type.String({ maxLength: 500 })),
  caregiverAssistedFeeding: Type.Optional(Type.Boolean()),
  oralCareCompleted: Type.Optional(Type.Boolean()),
});
export type LogMealBody = Static<typeof LogMealBodySchema>;
export const MealViewSchema = Type.Object({
  id,
  ipuAdmissionId: id,
  serviceDate: Type.String(),
  mealSlot: Type.String(),
});

// ── equipment (§4.1 routes 33–36) ──────────────────────────────────────────────────────────────────────
const equipmentType = Type.Union([
  Type.Literal("hospital_bed"),
  Type.Literal("oxygen_concentrator"),
  Type.Literal("suction_machine"),
  Type.Literal("iv_pump"),
  Type.Literal("bipap"),
  Type.Literal("cpap"),
  Type.Literal("lift"),
  Type.Literal("scale"),
  Type.Literal("vitals_monitor"),
  Type.Literal("comfort_mattress"),
  Type.Literal("low_air_loss_mattress"),
]);
export const CreateEquipmentBodySchema = Type.Object({
  serialNumber: Type.String({ minLength: 1, maxLength: 120 }),
  equipmentType,
  manufacturer: Type.String({ minLength: 1, maxLength: 120 }),
  modelNumber: Type.String({ minLength: 1, maxLength: 120 }),
  yearOfManufacture: Type.Optional(Type.Integer({ minimum: 1950, maximum: 2100 })),
});
export type CreateEquipmentBody = Static<typeof CreateEquipmentBodySchema>;
export const EquipmentViewSchema = Type.Object({
  id,
  serialNumber: Type.String(),
  equipmentType: Type.String(),
  currentStatus: Type.String(),
  nextInspectionDueDate: Type.Union([Type.String(), Type.Null()]),
  version: Type.Integer(),
});
export const EquipmentListSchema = Type.Object({ items: Type.Array(EquipmentViewSchema) });
export const LogMaintenanceBodySchema = Type.Object({
  maintenanceKind: Type.String({ minLength: 1, maxLength: 120 }),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
  vendorInvoiceReference: Type.Optional(Type.String({ maxLength: 120 })),
});
export type LogMaintenanceBody = Static<typeof LogMaintenanceBodySchema>;
export const LogInspectionBodySchema = Type.Object({
  inspectionKind: Type.Union([
    Type.Literal("annual_biomed"),
    Type.Literal("per_use_safety"),
    Type.Literal("post_repair_safety"),
    Type.Literal("recall_response"),
  ]),
  outcome: Type.Union([
    Type.Literal("pass"),
    Type.Literal("fail"),
    Type.Literal("conditional_pass"),
    Type.Literal("retired"),
  ]),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
  nextInspectionDueDate: Type.String({ minLength: 8, maxLength: 10 }),
});
export type LogInspectionBody = Static<typeof LogInspectionBodySchema>;
export const AssignEquipmentBedBodySchema = Type.Object({ bedId: id, patientId: id });
export type AssignEquipmentBedBody = Static<typeof AssignEquipmentBedBodySchema>;

// ── body release (§4.1 route 37) ───────────────────────────────────────────────────────────────────────
export const AdvanceBodyReleaseBodySchema = Type.Object({
  action: Type.Union([
    Type.Literal("identifyFuneralHome"),
    Type.Literal("releaseBody"),
    Type.Literal("postClose"),
  ]),
  funeralHomeId: Type.Optional(id),
  releaseDocumentId: Type.Optional(id),
  releasedToRepresentativeName: Type.Optional(Type.String({ maxLength: 200 })),
});
export type AdvanceBodyReleaseBody = Static<typeof AdvanceBodyReleaseBodySchema>;
export const BodyReleaseViewSchema = Type.Object({
  id,
  ipuAdmissionId: id,
  state: Type.String(),
  version: Type.Integer(),
});
export const AdmissionIdParamsSchema = Type.Object({ admissionId: id });

export const IdParamsSchema = Type.Object({ id });
export const DateParamsSchema = Type.Object({ date: Type.String({ minLength: 8, maxLength: 10 }) });
