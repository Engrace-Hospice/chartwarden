// @wardenx/billing · repositories barrel (M23 §3.3).
//
// Drizzle data ports over the 17 M23-owned tables. Each repo is a thin reader/writer that takes the
// Drizzle client (`BillingDb` — the pooled client or a `withOrgContext` transaction handle) in its
// constructor and issues plain Drizzle queries; the read/write SERVICES (P3 apps/backend) wrap each call
// in `withOrgContext` so Postgres RLS scopes every statement to `app.org_id` — keeping tenant-scoping in
// one home. No Fastify, no outbox, no `withOrgContext` here: pure data access. No PHI / MBI (D13); money
// is integer cents (D8).
//
// The KERNEL conventions all repos build on live in `./db`:
//   * enum codecs (claimState/noticeState/levelOfCare/eligibilityOutcome) — the SINGLE home of the
//     domain↔DB enum case/value translation; repos call them at their read/write boundary.
//   * the `(created_at DESC, id DESC)` keyset cursor codec + `keysetBefore` + `buildCursorPage`.
//   * the §2.5 `VersionedUpdateResult` If-Match shape + `versionOk` / `versionConflict` constructors.
//
//   ClaimRepository         — claim (EXEMPLAR org-scoped: read/get/list-with-cursor + reducer-driven
//                             version-checked `transitionToState`; enum case mapping at the boundary)
//   ClaimLineRepository     — claim_line (INTERNAL-WRITE-ONLY: batch insert + read; no external mutator)
//   ValidationRunRepository — validation_run (EXEMPLAR APPEND-ONLY: idempotent insert + read; no
//                             update/delete surface)
//
// The full §3.3 fan-out (all 17 owned tables) is exported below; each repo mirrors one of the three
// exemplars above (org-scoped + versioned `claim`/`noe_record`/`notr_record`; internal-write `claim_line`;
// append-only `validation_run` family + submission/ack/calculation/eligibility ports; the reference-data
// ports `validation_rule_config` / `sequestration_policy` / `wage_index_factor` / `mac_submitter_credential`).
export {
  type BillingDb,
  type CursorKeyset,
  type CursorPage,
  type EnumCodec,
  type VersionedUpdateResult,
  buildCursorPage,
  claimStateCodec,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  eligibilityOutcomeCodec,
  encodeCursor,
  keysetBefore,
  levelOfCareCodec,
  makeBiCodec,
  makeCaseCodec,
  makeEnumCodec,
  MAX_PAGE_SIZE,
  noticeStateCodec,
  pageSizeOf,
  versionConflict,
  versionOk,
} from "./db";
export {
  ClaimRepository,
  type ClaimListFilter,
  type ClaimMatchCandidateRow,
  type ClaimRecord,
  type ClaimTransitionPatch,
  type NewClaimInput,
} from "./claim";
export {
  ClaimLineRepository,
  type ClaimLineRecord,
  type NewClaimLineInput,
} from "./claim-line";
export { ValidationRunRepository } from "./validation-run";
export {
  ClaimStateHistoryRepository,
  type ClaimStateHistoryRecord,
  type NewClaimStateHistoryInput,
} from "./claim-state-history";
export { ClaimSubmissionRepository } from "./claim-submission";
export { ClaimAcknowledgmentRepository } from "./claim-acknowledgment";
export {
  NoeRepository,
  type NoeListFilter,
  type NoeRecord,
  type NoeTransitionPatch,
  type NewNoeInput,
} from "./noe-record";
export {
  NotrRepository,
  type NotrListFilter,
  type NotrRecord,
  type NotrTransitionPatch,
  type NotrTriggerKind,
  type NewNotrInput,
} from "./notr-record";
export { ValidationResultRepository } from "./validation-result";
export { ValidationOverrideRepository } from "./validation-override";
export {
  ValidationRuleConfigRepository,
  type ValidationRuleConfigListFilter,
  type ValidationRuleConfigUpdatePatch,
} from "./validation-rule-config";
export {
  EligibilityCheckRepository,
  type EligibilityCheckRecord,
  type NewEligibilityCheckInput,
} from "./eligibility-check";
export { HippsCalculationRepository } from "./hipps-calculation";
export { SiaCalculationRepository } from "./sia-calculation";
export { SequestrationPolicyRepository } from "./sequestration-policy";
export { WageIndexFactorRepository } from "./wage-index-factor";
export {
  CostReportAggregateRepository,
  type BilledDaysAggregate,
  type BilledDaysByLevel,
  type ClaimLineRollup,
} from "./cost-report-aggregates";
export {
  MacSubmitterCredentialRepository,
  type MacSubmitterCredentialSafeRecord,
  type MacCredentialSecretMaterial,
  type MacCredentialUpdatePatch,
} from "./mac-submitter-credential";
