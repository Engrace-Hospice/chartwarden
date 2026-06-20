// @wardenx/terminology — value-set expansion engine (M38-T07, §7.5).
// Materialized expansion + the B-tree membership lookup + the §2.5 freshness invariant.

export {
  computeExpansion,
  expansionIncludesAsOf,
  memberRowAtAsOf,
  isMemberAtAsOf,
  staleIncludedSystems,
  isExpansionStale,
  toExpansionMember,
  type ValueSetMemberRow,
  type ExpansionRow,
  type SystemVersionLoad,
} from "./expansion";
