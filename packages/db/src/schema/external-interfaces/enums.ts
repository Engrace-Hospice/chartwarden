// @wardenx/db — Module 29 (External Interfaces) §3.2 Phase-A enum types (M29-T02).
//
// The 23 `CREATE TYPE ... AS ENUM` vocabularies the module's eleven owned tables bind their enum columns
// to. Their VALUE sets are kept in lock-step with the `@wardenx/types` `external-interfaces.ts` value
// mirror (M29-T01) — a consumer narrows/iterates against that leaf, the DB stores against these. The two
// are hand-maintained VERBATIM copies (the leaf `@wardenx/types` cannot import `@wardenx/db` and vice
// versa, so no runtime import ties them); any edit here must land identically in the leaf.
//
// The pgEnum names here match the `CREATE TYPE` statements the 0144 migration emits VERBATIM; Drizzle's
// generator would otherwise not resolve the column type. Placed in this per-module folder (the
// remittance / medicaid-billing / cap precedent, and the path M29-T01's leaf names as the lock-step
// target) rather than the flat `packages/db/src/enums.ts`.
import { pgEnum } from "drizzle-orm/pg-core";

// ── external_feed onboarding + transport ────────────────────────────────────────────────────────────────
export const externalFeedKind = pgEnum("external_feed_kind", [
  "adt_inbound",
  "lab_inbound",
  "orm_outbound",
]);
export const externalFeedProtocol = pgEnum("external_feed_protocol", ["mllp_tls", "mllp_plain"]);
export const externalFeedStatus = pgEnum("external_feed_status", [
  "proposed",
  "pending_approval",
  "active",
  "suspended",
  "revoked",
  "rejected",
]);
export const externalFeedCredentialKind = pgEnum("external_feed_credential_kind", [
  "mllp_client_cert",
  "mllp_channel_password",
]);
export const externalFeedCredentialStatus = pgEnum("external_feed_credential_status", [
  "active",
  "retired",
]);

// ── HL7 inbound parse / proposal / match ────────────────────────────────────────────────────────────────
export const hl7InboundParseStatus = pgEnum("hl7_inbound_parse_status", [
  "in_progress",
  "parsed",
  "parse_error",
  "rejected",
]);
export const hl7InboundProposalKind = pgEnum("hl7_inbound_proposal_kind", [
  "patient_demographic_update",
  "admission_event",
  "discharge_event",
  "cancel_admission",
  "new_patient",
]);
export const hl7InboundProposalStatus = pgEnum("hl7_inbound_proposal_status", [
  "pending",
  "accepted",
  "rejected",
  "expired",
]);
export const hl7InboundMatchOutcome = pgEnum("hl7_inbound_match_outcome", [
  "matched_single",
  "matched_ambiguous",
  "no_match",
  "merged_target",
]);
export const hl7InboundMatchLevel = pgEnum("hl7_inbound_match_level", [
  "L1_MRN_EXACT",
  "L2_EXTERNAL_MRN_EXACT",
  "L3_SSN_DOB",
  "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE",
  "L5_LOOSE_NAME_DOB_CANDIDATE",
  "NO_MATCH",
]);

// ── HL7 outbound (ORM) dispatch ─────────────────────────────────────────────────────────────────────────
export const hl7OutboundAckStatus = pgEnum("hl7_outbound_ack_status", [
  "aa",
  "ae",
  "ar",
  "timeout",
]);
export const hl7OutboundStatus = pgEnum("hl7_outbound_status", [
  "queued",
  "in_flight",
  "acked",
  "naked",
  "failed",
  "dlq",
]);

// ── Lab observation (ORU) ───────────────────────────────────────────────────────────────────────────────
export const labResultStatus = pgEnum("lab_result_status", [
  "preliminary",
  "final",
  "corrected",
  "cancelled",
]);
export const labAbnormalSummary = pgEnum("lab_abnormal_summary", [
  "any_critical",
  "any_abnormal",
  "all_normal",
  "no_flags",
]);
export const labAbnormalFlag = pgEnum("lab_abnormal_flag", ["H", "L", "HH", "LL", "A", "N"]);
export const labValueType = pgEnum("lab_value_type", ["NM", "ST", "CE", "SN", "TX", "DT"]);
export const labTerminologyValidation = pgEnum("lab_terminology_validation", [
  "valid",
  "unknown_code",
  "deprecated",
]);
export const labMatchMethod = pgEnum("lab_match_method", [
  "obr_placer_id",
  "patient_loinc_date",
  "manual",
  "unmatched",
]);

// ── NPPES directory sync (platform-shared) ──────────────────────────────────────────────────────────────
export const nppesEnumerationType = pgEnum("nppes_enumeration_type", ["NPI-1", "NPI-2"]);
export const nppesProviderStatus = pgEnum("nppes_provider_status", ["active", "deactivated"]);
export const nppesSyncKind = pgEnum("nppes_sync_kind", [
  "daily_incremental",
  "weekly_dissemination",
  "monthly_deactivation",
  "manual",
]);
export const nppesSyncTrigger = pgEnum("nppes_sync_trigger", ["platform_cron", "platform_admin"]);
export const nppesSyncStatus = pgEnum("nppes_sync_status", ["in_progress", "completed", "failed"]);
