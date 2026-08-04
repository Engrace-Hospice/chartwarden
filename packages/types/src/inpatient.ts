// @wardenx/types — Module 37 (Inpatient Unit / IPU Management) leaf contracts (M37-T01).
//
// Per ADR-0005 D1/D3 the cross-module CONTRACTS live in this leaf package: the M37 spec's references to
// `packages/inpatient/src/seams.ts` resolve their TYPE surface HERE, so downstream consumers (M23
// per-diem, M26 inpatient cap, M27 cost report, M30 quality) import them with NO `dependsOn` edge. The
// `@wardenx/inpatient` package IMPLEMENTS the domain kernels over these types; it takes a `@wardenx/types`
// edge for them and never re-declares the wire shapes.
//
// SCOPE (authority: architecture/module-manifest.ts wins over the spec ERD). The manifest owns 26 tables;
// this leaf ships the §3.2 pgEnum value mirrors (as union types the package's value tuples `satisfies`),
// the owned-table id aliases, and the §4.4 outbox event-name taxonomy foundation. The pure §2 domain
// kernels (XState machines, GIP validators, RN-coverage evaluator, census builder) live in the
// `@wardenx/inpatient` package; the §4.5/§4.11 seam interfaces are declared here in M37-T10.
//
// PHI boundary (D11/§3.6): every wire shape here is PHI-free by construction — ids are uuids, never a
// patient name / MRN / free-text justification. M37 is fully outbox-decoupled (D17).
//
// NAMING: exported symbols carry an IPU-domain prefix (`Ipu`/`Gip`/`Irc`/`M37`) so a bare `State`/`Kind`
// is never a TS2308 collision the day another module wants the word.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal seam use only so
// the package surface stays unambiguous under `export *`) ────────────────────────────────────────────────
import type { OrgId, PatientId } from "./admission";

// ── M37 §3.2 enum value unions (the package's enums.ts value tuples `as const satisfies readonly X[]`
// these; single definition site, mirrored 1:1 by packages/db/src/enums.ts pgEnums) ──────────────────────
export type IpuRoomKind = "private" | "semi_private" | "family" | "shared_overflow";
export type IpuBedCleaningStatus =
  | "ready"
  | "reserved"
  | "occupied"
  | "discharged_dirty"
  | "cleaning"
  | "retired";
export type IpuAdmissionKind = "gip" | "irc" | "arranged";
export type IpuAdmissionState =
  | "pending"
  | "bed_pending"
  | "bed_assigned"
  | "active"
  | "transferring"
  | "transferred"
  | "discharged"
  | "deceased"
  | "closed";
export type IpuAdmissionTransitionKind =
  | "to_unit"
  | "to_home"
  | "to_facility"
  | "to_other_hospice"
  | "revocation"
  | "expired_benefit";
export type IpuShiftRole =
  | "charge_rn"
  | "rn"
  | "np_in_rn_role"
  | "lpn"
  | "cna"
  | "unit_secretary"
  | "housekeeping"
  | "pharmacist"
  | "social_worker_in_unit"
  | "chaplain_in_unit"
  | "medical_director_in_unit";
export type IpuShiftAssignmentState =
  | "tentative"
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show";
export type GipCriterionKind =
  | "acute_symptom_management"
  | "imminent_death_terminal_care"
  | "medications_treatments_inpatient_only";
export type IrcEpisodeState = "active" | "approaching_cap" | "breached" | "closed";
export type IpuRestraintKind = "soft_limb" | "posey_vest" | "mitt" | "side_rail_4";
export type IpuRestraintEventState = "active" | "released";
export type IpuRestraintReassessmentOutcome = "continue" | "modify" | "release";
export type IpuVisitorRelationship =
  | "spouse"
  | "parent"
  | "child"
  | "sibling"
  | "grandparent"
  | "grandchild"
  | "in_law"
  | "aunt_uncle"
  | "cousin"
  | "friend"
  | "clergy"
  | "volunteer"
  | "caregiver_paid"
  | "legal_representative"
  | "other";
export type IpuVisitorRestrictionScope = "unit" | "patient";
export type IpuVisitorRestrictionKind =
  | "full_block"
  | "immediate_family_only"
  | "mask_required"
  | "time_limited"
  | "no_overnight";
export type IpuMealSlot = "breakfast" | "lunch" | "dinner" | "snack";
export type IpuEquipmentType =
  | "hospital_bed"
  | "oxygen_concentrator"
  | "suction_machine"
  | "iv_pump"
  | "bipap"
  | "cpap"
  | "lift"
  | "scale"
  | "vitals_monitor"
  | "comfort_mattress"
  | "low_air_loss_mattress";
export type IpuEquipmentLocationKind =
  | "unit"
  | "room"
  | "bed"
  | "storage"
  | "sent_for_repair"
  | "retired";
export type IpuEquipmentStatus = "active" | "maintenance" | "retired" | "lost" | "sent_for_repair";
export type IpuEquipmentInspectionKind =
  | "annual_biomed"
  | "per_use_safety"
  | "post_repair_safety"
  | "recall_response";
export type IpuEquipmentInspectionOutcome = "pass" | "fail" | "conditional_pass" | "retired";
export type IpuBodyReleaseState = "pending" | "funeral_home_identified" | "released" | "closed";
export type IpuRemoteArrangementBillingBasis = "bundled" | "per_diem_passthrough";

// ── M37-owned id aliases (mirror the §3.3 uuid PKs of the 26 owned tables; packages/types cannot import
// @wardenx/db). Opaque uuid strings. ────────────────────────────────────────────────────────────────────
export type InpatientUnitId = string;
// `IpuRoomId` is already a leaf-shared alias defined by `./supplies` (M21 kit-inventory references IPU
// rooms) and re-exported wholesale from `./index`; redeclaring it here would be a TS2308 collision, so
// M37 reuses that single definition site (the subscription-billing `OrgId`/`PatientId` precedent).
export type IpuBedId = string;
export type IpuBedCleaningEventId = string;
export type IpuAdmissionId = string;
export type IpuAdmissionStateHistoryId = string;
export type IpuBedAssignmentId = string;
export type IpuAdmissionTransitionId = string;
export type GipAdmissionCriteriaId = string;
export type GipCriteriaReassessmentId = string;
export type IrcEpisodeId = string;
export type IpuShiftId = string;
export type IpuStaffAssignmentId = string;
export type IpuRnCoverageWindowId = string;
export type IpuIvSafetyOverlayId = string;
export type IpuRestraintEventId = string;
export type IpuRestraintReassessmentId = string;
export type IpuVisitorId = string;
export type IpuVisitorRestrictionId = string;
export type IpuMealServiceId = string;
export type IpuEquipmentId = string;
export type IpuEquipmentMaintenanceId = string;
export type IpuEquipmentInspectionId = string;
export type IpuBodyReleaseId = string;
export type IpuBedCleaningEventKey = string;
export type IpuCensusSnapshotId = string;
export type IpuRemoteInpatientEpisodeId = string;

/** The 26 M37-owned table names, for manifest/audit cross-checks. */
export const M37_OWNED_TABLES = [
  "inpatient_unit",
  "ipu_room",
  "ipu_bed",
  "ipu_admission",
  "ipu_admission_state_history",
  "ipu_bed_assignment",
  "ipu_admission_transition",
  "gip_admission_criteria",
  "gip_criteria_reassessment",
  "irc_episode",
  "ipu_shift",
  "ipu_staff_assignment",
  "ipu_rn_coverage_window",
  "ipu_iv_safety_overlay",
  "ipu_restraint_event",
  "ipu_restraint_reassessment",
  "ipu_visitor",
  "ipu_visitor_restriction",
  "ipu_meal_service",
  "ipu_equipment",
  "ipu_equipment_maintenance",
  "ipu_equipment_inspection",
  "ipu_body_release",
  "ipu_bed_cleaning_event",
  "ipu_census_snapshot",
  "ipu_remote_inpatient_episode",
] as const;
export type M37TableName = (typeof M37_OWNED_TABLES)[number];

// ── §4.4 outbox event taxonomy (M37-T10) ────────────────────────────────────────────────────────────────
// The full `m37.*` publication surface. The pure machines (T03–T09) emit these string literals; the
// transactional-outbox publisher (M37-T11) Value.Checks each against its payload schema and binds the
// caller module "m37". Cross-module consumers key their subscriptions off these names.
export const M37_OUTBOX_EVENT_NAMES = [
  // ipu_admission lifecycle (§2.2)
  "m37.ipu_admission.opened",
  "m37.ipu_admission.bed_requested",
  "m37.ipu_admission.bed_assigned",
  "m37.ipu_admission.activated",
  "m37.ipu_admission.transferring",
  "m37.ipu_admission.transferred",
  "m37.ipu_admission.discharged",
  "m37.ipu_admission.death_recorded",
  "m37.ipu_admission.closed",
  // bed cleaning (§2.12)
  "m37.bed.cleaning_started",
  "m37.bed.ready",
  "m37.bed.cleaning_overdue",
  // RN coverage (§2.3)
  "m37.shift.coverage_gap_projected",
  "m37.shift.rn_uncovered",
  "m37.rn_coverage.break_glass_invoked",
  // GIP criteria (§2.4)
  "m37.gip_criteria.reassessment_due",
  "m37.gip_criteria.reassessment_completed",
  // IRC cap (§2.5)
  "m37.irc_episode.cap_approaching",
  "m37.irc_episode.cap_breached",
  "m37.irc_episode.cap_override_invoked",
  // IV safety overlay (§2.6)
  "m37.iv_safety_overlay.required",
  "m37.iv_safety_overlay.bedside_check_overdue",
  // visitor (§2.7)
  "m37.visitor_restriction.applied",
  // equipment (§2.9)
  "m37.equipment.inspection_due",
  "m37.equipment.inspection_overdue",
  // restraint (§2.10)
  "m37.restraint.applied",
  "m37.restraint.reassessment_due",
  "m37.restraint.reassessment_completed",
  "m37.restraint.released",
  // body release (§2.11)
  "m37.body_release.pending",
  "m37.body_release.funeral_home_identified",
  "m37.body_release.document_requested",
  "m37.body_release.completed",
  // census (§2.13)
  "m37.census.snapshot_taken",
  // nursing-note shift coverage (§5.14)
  "m37.nursing_note.shift_overdue",
] as const;
export type M37OutboxEventName = (typeof M37_OUTBOX_EVENT_NAMES)[number];

// ── §2.13 census snapshot payload (m37.census.snapshot_taken) ────────────────────────────────────────────
/** The typed `m37.census.snapshot_taken` payload M23 (per-diem), M26 (inpatient cap), M27 (S-3), M33 (MV) consume. */
export interface IpuCensusSnapshotPayload {
  readonly organizationId: OrgId;
  readonly providerEntityId: string;
  readonly serviceDate: string; // ISO date
  readonly unitId: InpatientUnitId | null;
  readonly remoteFacilityId: string | null;
  readonly censusCountGip: number;
  readonly censusCountIrc: number;
  readonly censusCountArrangedGip: number;
  readonly censusCountArrangedIrc: number;
  readonly bedDaysGip: number;
  readonly bedDaysIrc: number;
  readonly bedDaysArrangedGip: number;
  readonly bedDaysArrangedIrc: number;
  readonly roomTurnoverCount: number;
  readonly restraintIncidentCount: number;
  readonly fallIncidentCount: number;
  readonly infectionSurveillanceEventCount: number;
}

// ── §4.11 published seam contracts into M1 (the eight typed reader seams) ────────────────────────────────
// Declared here in the LEAF (edge-free) so downstream consumers import the TYPE with no dependsOn edge (the
// M28-T06 / M35-T05 pattern). The @wardenx/inpatient package + the M37 backend module IMPLEMENT these; the
// composition root registers them in M1's SeamRegistry (validateSeams) at M37-T11. Every shape is PHI-lean
// (ids + counts), never raw names/MRN.

/** M23/M26/M27/M28/M30/M34 — read paths onto IPU admissions. */
export interface IpuAdmissionReader {
  /** M23 pre-submission: the covering IPU bed assignment for a patient on a service date (Q-code source). */
  bedAssignmentForDate(
    organizationId: OrgId,
    patientId: PatientId,
    serviceDate: string,
  ): Promise<{ readonly bedId: IpuBedId; readonly unitFacilityId: string } | null>;
}

/** M23/M26/M27/M33 — the daily census + fiscal roll-ups. */
export interface IpuCensusProvider {
  /** M26 — inpatient days for the CCN's cap projection as of a fiscal date. */
  inpatientDaysForFiscalDate(
    organizationId: OrgId,
    providerEntityId: string,
    asOfDate: string,
  ): Promise<number>;
  /** M27 — Worksheet S-3 IPU service days for a fiscal year. */
  serviceDaysForFiscalYear(providerEntityId: string, fiscalYear: number): Promise<number>;
}

/** M6 — confirms the bed assignment in the §2.3.5 handshake. */
export interface IpuBedAssignmentProvider {
  hasActiveBedAssignment(organizationId: OrgId, ipuAdmissionId: IpuAdmissionId): Promise<boolean>;
}

/** M17 cross-check / M19 after-hours — is the unit's RN coverage active at an instant? */
export interface IpuShiftCoverageReader {
  coverageActiveForUnit(
    organizationId: OrgId,
    unitId: InpatientUnitId,
    atIso: string,
  ): Promise<boolean>;
}

/** M13 pre-administration gate — the IV-safety overlay for a signed IV-continuous order. */
export interface IpuIvSafetyOverlayView {
  readonly titrationMinRate: number;
  readonly titrationMaxRate: number;
  readonly rateUnit: string;
  readonly dualWitnessRequired: boolean;
  readonly maxContinuousDurationHours: number;
  readonly bedsideCheckIntervalMinutes: number;
  readonly isSedationClass: boolean;
}
export interface IpuIvSafetyOverlayProvider {
  getOverlayForOrder(
    organizationId: OrgId,
    orderId: string,
  ): Promise<IpuIvSafetyOverlayView | null>;
}

/** M31 portal — the visit-policy for a patient (active restrictions folded in). */
export interface IpuVisitorReader {
  visitsAllowedForPatient(
    organizationId: OrgId,
    patientId: PatientId,
  ): Promise<{
    readonly allowed: boolean;
    readonly maskRequired: boolean;
    readonly reason: string | null;
  }>;
}

/** M30 measure-detail — the IPU quality reader family (deterministic scoring today; M32 augments acuity later). */
export interface IpuQualityReader {
  acuityForAdmission(organizationId: OrgId, ipuAdmissionId: IpuAdmissionId): Promise<number | null>;
  restraintIncidentsForDate(
    organizationId: OrgId,
    unitId: InpatientUnitId,
    serviceDate: string,
  ): Promise<number>;
  mortalityCountForDate(
    organizationId: OrgId,
    unitId: InpatientUnitId,
    serviceDate: string,
  ): Promise<number>;
}

/** M34 platform-ops — tenant IPU configuration posture + the offboarding gate. */
export interface IpuTenantPostureReader {
  unitsForOrg(
    organizationId: OrgId,
  ): Promise<ReadonlyArray<{ readonly unitId: InpatientUnitId; readonly isActive: boolean }>>;
  /** M34 offboarding gate — a tenant cannot offboard while any IPU admission is `active`. */
  openIpuAdmissionsForOrg(organizationId: OrgId): Promise<number>;
}
