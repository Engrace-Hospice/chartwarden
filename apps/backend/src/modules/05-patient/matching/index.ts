// apps/backend/src/modules/05-patient/matching — the M5 patient-matching pipeline (M5-T06, §2.3).
// Pure engine the create/import/proposal services compose over: normalize → deterministic →
// probabilistic → classify (hard_block / soft_review / quiet_create). Auto-merge forbidden.
export { jaroWinkler, levenshtein } from "./similarity";
export {
  runMatch,
  probabilisticScore,
  clampThresholds,
  DEFAULT_THRESHOLDS,
  type MatchSubject,
  type MatchCandidate,
  type MatchAddress,
  type MatchResult,
  type MatchThresholds,
  type ScoredCandidate,
  type DeterministicRule,
} from "./matcher";
export {
  normalizeSubject,
  normName,
  normIdentifier,
  phoneLast7,
  normEmail,
  type RawSubject,
} from "./normalize";
export {
  stripForbiddenProposalFields,
  FORBIDDEN_PROPOSAL_FIELDS,
  type ProposalStripResult,
} from "./proposal-policy";
