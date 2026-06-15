// apps/backend/src/modules/04-audit/audit/action-catalog.ts — M4-T10 action-catalog boot gate
// (M4 spec §4.6, §4.6.7).
//
// At M4 boot the consolidated action catalog (every owner module's slice, @wardenx/audit/actions)
// is validated for D9 namespacing + uniqueness and then UPSERTed into `audit_action_catalog`.
// This module owns the boot-side wiring; the catalog itself and its validator/projection live in
// @wardenx/audit so any module can read the taxonomy. The DB UPSERT (`actionCatalogRows()`) runs
// in the platform context against the live connection at deploy/boot — kept out of this pure boot
// gate so it stays runnable in tests without a database.
import { assertActionCatalogValid } from "@wardenx/audit";

/**
 * The M4 boot gate (§4.6.7 #1/#2): assert the consolidated action catalog is internally valid —
 * every entry's owner matches the namespace its action implies and no action is declared twice.
 * Throws (boot fails closed) on any violation; a violation is a registration bug, not a runtime
 * condition. The composition root calls this at startup before serving.
 */
export function assertAuditActionCatalog(): void {
  assertActionCatalogValid();
}
