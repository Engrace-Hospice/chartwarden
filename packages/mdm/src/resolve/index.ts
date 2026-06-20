// @wardenx/mdm — the resolution & merge-redirect engine (M40-T04, spec §2.1, §7.1–7.2).
// Pure, DB-agnostic core: the transparent merge-redirect chase (§7.2) + the canonical+overlay
// join (§2.3). The DB-backed `MdmEntityProvider` (T05) composes these over per-kind Drizzle
// queries; the unit tests drive them over an in-memory row set.

export {
  resolveRedirect,
  followMerge,
  MergeRedirectError,
  MAX_REDIRECT_DEPTH,
  type CanonicalRedirectRow,
  type CanonicalRowLoader,
  type MergeRedirect,
  type ResolvedStatus,
} from "./follow-merge";

export { joinOverlay, type ResolvedEntity } from "./overlay-join";
