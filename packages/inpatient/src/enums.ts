// @wardenx/inpatient — M37 §3.2 enum value tuples. Each is `as const satisfies readonly <LeafUnion>[]`
// so the two definition sites (this package's runtime tuples and the packages/db pgEnums, both mirroring
// the packages/types leaf unions) cannot silently drift — the M30 "wire enum as Type.String is a silent
// lie" lesson. These tuples are the runtime source for TypeBox/`Type.Union(...map(Type.Literal))` DTOs
// and for exhaustive state-machine guards in the domain kernels (T03–T10).
import type {
  GipCriterionKind,
  IpuAdmissionKind,
  IpuAdmissionState,
  IpuAdmissionTransitionKind,
  IpuBedCleaningStatus,
  IpuBodyReleaseState,
  IpuEquipmentInspectionKind,
  IpuEquipmentInspectionOutcome,
  IpuEquipmentLocationKind,
  IpuEquipmentStatus,
  IpuEquipmentType,
  IpuMealSlot,
  IpuRemoteArrangementBillingBasis,
  IpuRestraintEventState,
  IpuRestraintKind,
  IpuRestraintReassessmentOutcome,
  IpuRoomKind,
  IpuShiftAssignmentState,
  IpuShiftRole,
  IpuVisitorRelationship,
  IpuVisitorRestrictionKind,
  IpuVisitorRestrictionScope,
  IrcEpisodeState,
} from "@wardenx/types";

export const IPU_ROOM_KINDS = [
  "private",
  "semi_private",
  "family",
  "shared_overflow",
] as const satisfies readonly IpuRoomKind[];

export const IPU_BED_CLEANING_STATUSES = [
  "ready",
  "reserved",
  "occupied",
  "discharged_dirty",
  "cleaning",
  "retired",
] as const satisfies readonly IpuBedCleaningStatus[];

export const IPU_ADMISSION_KINDS = [
  "gip",
  "irc",
  "arranged",
] as const satisfies readonly IpuAdmissionKind[];

export const IPU_ADMISSION_STATES = [
  "pending",
  "bed_pending",
  "bed_assigned",
  "active",
  "transferring",
  "transferred",
  "discharged",
  "deceased",
  "closed",
] as const satisfies readonly IpuAdmissionState[];

export const IPU_ADMISSION_TRANSITION_KINDS = [
  "to_unit",
  "to_home",
  "to_facility",
  "to_other_hospice",
  "revocation",
  "expired_benefit",
] as const satisfies readonly IpuAdmissionTransitionKind[];

export const IPU_SHIFT_ROLES = [
  "charge_rn",
  "rn",
  "np_in_rn_role",
  "lpn",
  "cna",
  "unit_secretary",
  "housekeeping",
  "pharmacist",
  "social_worker_in_unit",
  "chaplain_in_unit",
  "medical_director_in_unit",
] as const satisfies readonly IpuShiftRole[];

export const IPU_SHIFT_ASSIGNMENT_STATES = [
  "tentative",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
] as const satisfies readonly IpuShiftAssignmentState[];

export const GIP_CRITERION_KINDS = [
  "acute_symptom_management",
  "imminent_death_terminal_care",
  "medications_treatments_inpatient_only",
] as const satisfies readonly GipCriterionKind[];

export const IRC_EPISODE_STATES = [
  "active",
  "approaching_cap",
  "breached",
  "closed",
] as const satisfies readonly IrcEpisodeState[];

export const IPU_RESTRAINT_KINDS = [
  "soft_limb",
  "posey_vest",
  "mitt",
  "side_rail_4",
] as const satisfies readonly IpuRestraintKind[];

export const IPU_RESTRAINT_EVENT_STATES = [
  "active",
  "released",
] as const satisfies readonly IpuRestraintEventState[];

export const IPU_RESTRAINT_REASSESSMENT_OUTCOMES = [
  "continue",
  "modify",
  "release",
] as const satisfies readonly IpuRestraintReassessmentOutcome[];

export const IPU_VISITOR_RELATIONSHIPS = [
  "spouse",
  "parent",
  "child",
  "sibling",
  "grandparent",
  "grandchild",
  "in_law",
  "aunt_uncle",
  "cousin",
  "friend",
  "clergy",
  "volunteer",
  "caregiver_paid",
  "legal_representative",
  "other",
] as const satisfies readonly IpuVisitorRelationship[];

export const IPU_VISITOR_RESTRICTION_SCOPES = [
  "unit",
  "patient",
] as const satisfies readonly IpuVisitorRestrictionScope[];

export const IPU_VISITOR_RESTRICTION_KINDS = [
  "full_block",
  "immediate_family_only",
  "mask_required",
  "time_limited",
  "no_overnight",
] as const satisfies readonly IpuVisitorRestrictionKind[];

export const IPU_MEAL_SLOTS = [
  "breakfast",
  "lunch",
  "dinner",
  "snack",
] as const satisfies readonly IpuMealSlot[];

export const IPU_EQUIPMENT_TYPES = [
  "hospital_bed",
  "oxygen_concentrator",
  "suction_machine",
  "iv_pump",
  "bipap",
  "cpap",
  "lift",
  "scale",
  "vitals_monitor",
  "comfort_mattress",
  "low_air_loss_mattress",
] as const satisfies readonly IpuEquipmentType[];

export const IPU_EQUIPMENT_LOCATION_KINDS = [
  "unit",
  "room",
  "bed",
  "storage",
  "sent_for_repair",
  "retired",
] as const satisfies readonly IpuEquipmentLocationKind[];

export const IPU_EQUIPMENT_STATUSES = [
  "active",
  "maintenance",
  "retired",
  "lost",
  "sent_for_repair",
] as const satisfies readonly IpuEquipmentStatus[];

export const IPU_EQUIPMENT_INSPECTION_KINDS = [
  "annual_biomed",
  "per_use_safety",
  "post_repair_safety",
  "recall_response",
] as const satisfies readonly IpuEquipmentInspectionKind[];

export const IPU_EQUIPMENT_INSPECTION_OUTCOMES = [
  "pass",
  "fail",
  "conditional_pass",
  "retired",
] as const satisfies readonly IpuEquipmentInspectionOutcome[];

export const IPU_BODY_RELEASE_STATES = [
  "pending",
  "funeral_home_identified",
  "released",
  "closed",
] as const satisfies readonly IpuBodyReleaseState[];

export const IPU_REMOTE_ARRANGEMENT_BILLING_BASES = [
  "bundled",
  "per_diem_passthrough",
] as const satisfies readonly IpuRemoteArrangementBillingBasis[];
