// @chartwarden/db — M25 Remittance & Denials schema barrel. Re-exports the shared
// enums plus all table modules; the central ../index.ts re-exports this barrel.
//
// Tenancy (ADR-0010, canonical): M25 tenant-domain tables carry organization_id NOT NULL → the canonical
// app.org_id RLS predicate applies. Account-wide Claim.MD capture/resolution tables are central protected
// tables with audited platform execution and dedicated role grants, not tenant-visible rows. The two child
// tables the spec §3.3 left org-less (denial_case_assignment, appeal_case_event) carry organization_id
// here per the three-column posture. denial_taxonomy_overlay is strictly org-scoped (M25-F09) — NO
// platform-default NULL-org rows; platform CARC/RARC defaults live in M38, resolved at read time.
//
// Partitioning: remittance_line / remittance_service_line / remittance_adjustment / remittance_remark
// are MONTHLY RANGE-partitioned on received_at (D11). Drizzle carries logical shape only — the composite
// PK (id, received_at), RANGE partition DDL, per-leaf unique backstops, RLS, grants, and M4 write-audit
// triggers land in the SQL migrations 0081+.
//
// CROSS-MODULE FK POLICY: cross-module FK constraints are FORBIDDEN. Only organization_id (core) +
// intra-M25 non-partitioned parents get real `.references(...)`. claim_id (M23), payer_id /
// provider_entity_id (M40/M2), patient_id (M5), source_evv_aggregator_submission_id (M18),
// appeal_packet_document_id (M22), *_membership_id (core), and all partitioned-table parent ids are
// LOGICAL uuid FKs. No MBI is ever stored or audit-captured (D13, §3.6).

// shared enums
export * from "./enums";

// 11 owned tables (§3.3)
export * from "./remittance"; // remittance_advice, remittance_line, remittance_service_line, remittance_adjustment, remittance_remark
export * from "./denial"; // denial_case, denial_case_assignment, denial_taxonomy_overlay
export * from "./appeal"; // appeal_case, appeal_case_event
export * from "./patient-responsibility"; // patient_responsibility_ledger
export * from "./adr"; // adr_case, adr_case_event, mac_rule (milestone 2a)
export * from "./reopening"; // denial_route_rule, reopening_case, reopening_case_event (milestone 3)
export * from "./tpe"; // tpe_mac_rule, tpe_program, tpe_round, tpe_round_claim (milestone 5)
export * from "./submission"; // submission_attempt (milestone 6a)
export * from "./audit-request"; // audit_request, audit_request_claim, audit_request_event (milestone 7a-1)
export * from "./later-tier"; // appeal_tier_detail, recorded_deadline (milestone 7a-1)
export * from "./adr-readiness"; // adr_readiness_review, adr_readiness_finding (milestone 8a-1)
export * from "./payer-appeal"; // payer_appeal_path, payer_appeal_path_level, payer_appeal_case, payer_appeal_case_event (milestone 12a-1)
export * from "./beneficiary-representative"; // representative_form_version, representative_appointment, beneficiary_appeal, beneficiary_appeal_document, beneficiary_appeal_event (milestone 13a)
export * from "./playbook"; // denial_playbook, denial_playbook_version, denial_playbook_case_step (milestone 9a-1)
export * from "./pull-cursor"; // remittance_pull_cursor (#717)
export * from "./pull-refusal"; // remittance_pull_refusal (#717 follow-up)
export * from "./claimmd-era"; // Claim.MD central capture/resolution/delivery + tenant M25 staging (BIL-1.4)
export * from "./claimmd-era-match"; // Append-only tenant match/review evidence (BIL-3.2; nonposting)
export * from "./claimmd-era-financial-review"; // Append-only nonposting financial-review dispositions (BIL-3.3)
export * from "./claimmd-era-posting"; // Immutable plans and append-only approval/execution history (BIL-3.4)
