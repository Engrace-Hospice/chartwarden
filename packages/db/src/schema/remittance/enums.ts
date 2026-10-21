// @chartwarden/db — M25 Remittance & Denials: shared pgEnum declarations (spec §3.3). The enums live in
// this single home so the fan-out table files import them without ever redeclaring a pgEnum (check-
// ddl-legality rule 3). Filename intentionally avoids the substring "schema" (table-ownership/tenancy
// heuristic gotcha).
//
// CONVENTIONS (mirror @chartwarden/db billing M23 / cost-report M27 / quality M30 — the proven precedent):
//   * Every DB ENUM type name is `m25_`-prefixed so it can never collide with another module's enum;
//     the exported Drizzle const is camelCase `m25X`.
//   * Spec §3.3 wrote bare enum names (payer_kind, parse_status, …); the `m25_` prefix is the repo-wide
//     anti-collision posture and supersedes the spec's bare names (architecture/convention wins).
import { pgEnum } from "drizzle-orm/pg-core";

export const m25PayerKind = pgEnum("m25_payer_kind", ["medicare", "medicaid", "commercial"]);
export const m25PaymentMethodKind = pgEnum("m25_payment_method_kind", [
  "check",
  "eft",
  "non_payment_remit",
]);
export const m25ParseStatus = pgEnum("m25_parse_status", [
  "queued",
  "parsing",
  "parsed",
  "posted",
  "partial_posted",
  "failed",
]);
export const m25MatchState = pgEnum("m25_match_state", [
  "unmatched",
  "auto_matched",
  "manual_matched",
  "reversed",
  "posted",
]);
export const m25MatchStrategy = pgEnum("m25_match_strategy", [
  "payer_icn",
  "patient_control",
  "heuristic",
  "manual",
]);
export const m25CasGroupCode = pgEnum("m25_cas_group_code", ["CO", "CR", "OA", "PI", "PR"]);
export const m25TaxonomyStatus = pgEnum("m25_taxonomy_status", ["mapped", "unmapped"]);
export const m25PostAction = pgEnum("m25_post_action", [
  "auto_posted",
  "ledger_recorded",
  "flagged_review",
  "denial_seeded",
]);
export const m25RemarkKind = pgEnum("m25_remark_kind", ["LQ", "MIA", "MOA"]);
export const m25DenialCategory = pgEnum("m25_denial_category", [
  "denial",
  "reduction",
  "informational",
  "recoupment",
  "unmapped",
]);
export const m25DenialSource = pgEnum("m25_denial_source", [
  "remittance_adjustment",
  "claim_rejection_277ca",
  "evv_aggregator_rejection",
]);
export const m25DenialState = pgEnum("m25_denial_state", [
  "open",
  "in_progress",
  "escalated",
  "appealed",
  "resolved",
  "closed",
]);
export const m25DenialClosureOutcome = pgEnum("m25_denial_closure_outcome", [
  "resolved_no_appeal",
  "resolved_via_appeal",
  "written_off",
  "recouped",
  "reassigned_to_other_payer",
  "withdrawn",
]);
export const m25AppealTier = pgEnum("m25_appeal_tier", [
  "redetermination",
  "reconsideration",
  "alj",
  "council",
  "federal_court",
]);
export const m25AppealState = pgEnum("m25_appeal_state", [
  "draft",
  "submitted",
  "under_review",
  "decided",
  "withdrawn",
  "closed",
  "escalated", // milestone 4 (migration 1116): a late QIC reconsideration moved to OMHA
]);
export const m25AppealDecisionOutcome = pgEnum("m25_appeal_decision_outcome", [
  "favorable",
  "partial",
  "unfavorable",
]);
export const m25AppealEventKind = pgEnum("m25_appeal_event_kind", [
  "created",
  "attached_document",
  "submitted",
  "received_ack",
  "under_review",
  "decided",
  "withdrawn",
  "escalated_to_next_tier",
  "closed",
  // milestone 4 (migration 1116)
  "evidence_updated",
  "qic_clock_recorded",
  "escalation_requested",
]);
export const m25TaxonomyOwnerRole = pgEnum("m25_taxonomy_owner_role", [
  "billing_specialist",
  "billing_manager",
  "clinical_records",
  "compliance_officer",
  "md_or_np",
]);
export const m25TaxonomySeverity = pgEnum("m25_taxonomy_severity", ["info", "warn", "critical"]);
export const m25PrLedgerStatus = pgEnum("m25_pr_ledger_status", [
  "recorded",
  "invoiced",
  "paid",
  "written_off",
]);
