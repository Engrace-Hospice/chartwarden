// @chartwarden/audit — action-catalog entry shape (M4-T10; M4 spec §4.6.1).
//
// The action taxonomy is a typed, queryable catalog consolidated from every owner module's
// registration. It makes provenance unambiguous, enables grep-friendly debugging, and lets M4
// enforce module-ownership of action names at boot (§4.6.7). The spec's §4.6.1 file layout puts
// the per-module catalog files under `packages/foundation/src/audit-actions/`; foundation is a
// banned package in this repo (ADR-0005 D4), so the canonical home is `@chartwarden/audit/actions`
// (M4 owns `packages/audit`) — the only behavioral difference is the import path.
import type { RetentionClass } from "../retention";
import type { DenylistCategory } from "../triggers/scrub";

/**
 * One auditable action. `action` is the canonical event-type name; `moduleOwner` is the `mN`
 * (or `m0` for un-prefixed system actions) that owns it. `defaultRetentionClass` is the class an
 * event of this action files under unless a row overrides it; `denylistCategories` are the scrub
 * categories the action implies; `isPartTwoEligible` flags actions that MAY be tagged
 * `compliance_42cfr_part2` per-row at runtime (§5.3).
 */
export interface ActionCatalogEntry {
  /** Canonical action name; `mN.*` (or `sud.*`) module actions or an un-prefixed system action. */
  readonly action: string;
  /** Owning module identifier: `mN`, or `m0` for un-prefixed system (`audit.*`/`data.*`) actions. */
  readonly moduleOwner: string;
  /** Retention class events of this action file under by default (§3.2). */
  readonly defaultRetentionClass: RetentionClass;
  /** Human-readable description (the Compliance reporting surface, §4.6). */
  readonly description: string;
  /** Denylist categories the action's payload is scrubbed for (§5.1). */
  readonly denylistCategories: readonly DenylistCategory[];
  /** May this action be tagged `compliance_42cfr_part2` per-row at runtime (§5.3)? */
  readonly isPartTwoEligible: boolean;
}

/** A per-module slice of the action catalog (one exported const per owner module). */
export type ModuleActionCatalog = ReadonlyArray<ActionCatalogEntry>;
