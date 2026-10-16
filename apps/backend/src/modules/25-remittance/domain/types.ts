// M25 Remittance & Denials — pure-domain shared types. These mirror the DB enum unions (packages/db
// schema/remittance/enums.ts) but are declared locally so the domain layer stays PURE — no drizzle, no
// DB, no adapter import. The DB-touching services (Phase 3) map rows ↔ these and the parsed-835 structure
// ↔ the match inputs here.

export type CasGroupCode = "CO" | "CR" | "OA" | "PI" | "PR";
export type DenialCategory = "denial" | "reduction" | "informational" | "recoupment" | "unmapped";
export type TaxonomyStatus = "mapped" | "unmapped";
export type PostAction = "auto_posted" | "ledger_recorded" | "flagged_review" | "denial_seeded";
export type MatchStrategy = "payer_icn" | "patient_control" | "heuristic" | "manual";
export type MatchState = "unmatched" | "auto_matched" | "manual_matched" | "reversed" | "posted";

export type DenialState = "open" | "in_progress" | "escalated" | "appealed" | "resolved" | "closed";

export type AppealTier =
  | "redetermination"
  | "reconsideration"
  | "alj"
  | "council"
  | "federal_court";
export type AppealState =
  | "draft"
  | "submitted"
  | "under_review"
  | "decided"
  | "escalated"
  | "withdrawn"
  | "closed";
export type AppealDecisionOutcome = "favorable" | "partial" | "unfavorable";

/** The six denial-worklist aging buckets (§1.1). */
export type AgingBucketLabel = "0-7" | "8-15" | "16-30" | "31-60" | "61-90" | "91+";

/** The posting outcome a remittance line resolves to — drives the M23 claim-state event (§2.4). */
export type PostingOutcome = "paid" | "partial_paid" | "denied" | "recouped";

/** What kind of additional documentation request a MAC sent: the first ADR, or a re-ADR after a signature/other defect. */
export type AdrReviewType = "adr" | "re_adr";
export type AdrState =
  | "received"
  | "in_assembly"
  | "in_review"
  | "submitted"
  | "denied_no_response"
  | "withdrawn"
  | "closed";
