// M29 read-audit declarations (M4 §2.5 / 45 CFR 164.528). GAP-044/GAP-045: the lab and inbound-proposal
// GET routes surface PHI (patient id, LOINC result values, ADT demographics linkage) but were outside the
// enforced prefix list and declared nothing, so no read event was ever written. Names only, never values.
import type { RouteReadAudit } from "@chartwarden/audit";

const LAB_FIELDS = ["patient_id", "loinc_code", "value_rows", "abnormal_flag"] as const;

export const LAB_OBSERVATION_LIST_AUDIT: RouteReadAudit = {
  resourceKind: "lab_observation",
  list: true,
  patientIdQueryParam: "patientId",
  fields: LAB_FIELDS,
};

/** The unmatched queue is by definition not yet bound to a patient, so there is no patient to attribute. */
export const LAB_UNMATCHED_LIST_AUDIT: RouteReadAudit = {
  resourceKind: "lab_observation_unmatched",
  list: true,
  fields: ["sending_facility_raw_id", "loinc_code", "value_rows"],
};

export const LAB_OBSERVATION_AUDIT: RouteReadAudit = {
  resourceKind: "lab_observation",
  resourceIdParam: "observationId",
  patientIdPayloadPath: "observation.patientId",
  fields: LAB_FIELDS,
};

export const PROPOSAL_LIST_AUDIT: RouteReadAudit = {
  resourceKind: "hl7_inbound_proposal",
  list: true,
  patientIdQueryParam: "proposedForPatientId",
  fields: ["matched_patient_id", "match_candidate_ids"],
};

export const PROPOSAL_AUDIT: RouteReadAudit = {
  resourceKind: "hl7_inbound_proposal",
  resourceIdParam: "proposalId",
  patientIdPayloadPath: "proposal.matchedPatientId",
  fields: ["matched_patient_id", "match_candidate_ids", "decision_rationale"],
};

export const INBOUND_MESSAGE_LIST_AUDIT: RouteReadAudit = {
  resourceKind: "hl7_inbound_message",
  list: true,
  fields: ["matched_patient_id", "message_control_id"],
};

export const INBOUND_MESSAGE_AUDIT: RouteReadAudit = {
  resourceKind: "hl7_inbound_message",
  resourceIdParam: "messageId",
  patientIdPayloadPath: "message.matchedPatientId",
  fields: ["matched_patient_id", "message_control_id"],
};

export const OUTBOUND_MESSAGE_LIST_AUDIT: RouteReadAudit = {
  resourceKind: "hl7_outbound_message",
  list: true,
  fields: ["placer_order_number", "status"],
};

export const OUTBOUND_MESSAGE_AUDIT: RouteReadAudit = {
  resourceKind: "hl7_outbound_message",
  resourceIdParam: "messageId",
  fields: ["placer_order_number", "status", "ack_chain"],
};

export const FEED_CONFIG_NO_PHI: RouteReadAudit = {
  none: "Interface feed configuration (endpoints, cadence, status) — no patient data is surfaced.",
};
export const FEED_CREDENTIAL_NO_PHI: RouteReadAudit = {
  none: "Credential rotation metadata only (ids, timestamps) — never the secret and no patient data.",
};
export const FEED_HEALTH_NO_PHI: RouteReadAudit = {
  none: "Aggregate feed health counters and listener status — no patient-level data.",
};
export const NPPES_NO_PHI: RouteReadAudit = {
  none: "NPPES provider-directory data is public registry information, not patient PHI.",
};
