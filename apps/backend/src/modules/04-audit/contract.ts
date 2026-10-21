// apps/backend/src/modules/04-audit/contract.ts — M4-T06 the Audit Capture Contract
// (M4 spec §4.1 "consumed by ALL PHI modules").
//
// Like M3's authorization contract, M4 ships OBLIGATIONS every other module fulfills so the audit
// log stays complete. This file is the single import surface for those obligations:
//
//   1. WRITE capture — every PHI table's migration calls `generateAuditTrigger(...)` (M4-T02), so
//      no clinical mutation escapes the log even if a code path forgets the helper (§10.1).
//   2. READ capture — every PHI resource route emits a read event (`auditPhiRead`/`auditListRead`)
//      or declares a justified `auditRead: "none"` waiver via `declarePhiReadRoute`; the §2.5
//      completeness check (`assertReadAuditDeclared`) refuses an undeclared PHI read route.
//   3. ACTION registration — every module registers its audit actions under its own `mN.` prefix;
//      M4 boot-validates the namespace. (The action catalog + boot validation land in M4-T10, §4.6;
//      the read/write obligations above are live now.)
//
// Importing the obligations THROUGH this module (rather than reaching into @chartwarden/audit
// directly) keeps "the capture contract" a single, documented seam — the same shape M3 uses.
import {
  type PhiListReadInput,
  type PhiReadInput,
  type ReadAuditMode,
  assertReadAuditDeclared,
  auditListRead,
  auditPhiRead,
  declareReadAudit,
  generateAuditTrigger,
} from "@chartwarden/audit";

// Re-export the write- + read-capture obligations as the contract surface.
export {
  generateAuditTrigger,
  auditPhiRead,
  auditListRead,
  assertReadAuditDeclared,
  type PhiReadInput,
  type PhiListReadInput,
};

/**
 * The per-route read-capture declaration a PHI resource route carries (§4.1 `config.auditRead`).
 * `resourceKind` drives the `<kind>.viewed`/`.disclosed` event_type; `patientIdParam` names the
 * route param holding the patient id so the read joins to the §164.528 accounting query (§7).
 */
export interface AuditReadConfig {
  readonly resourceKind: string;
  /** Route param holding the touched patient's id (enables the accounting-of-disclosures join). */
  readonly patientIdParam?: string;
  /** Field names the route surfaces (recorded in `context` — names only, never values, §2.3). */
  readonly fields?: readonly string[];
}

/**
 * Declare a PHI read route's read-capture intent so the §2.5 completeness check can verify it.
 * Pass an `AuditReadConfig` to assert the route emits a read event, or a justified
 * `{ auditRead: "none", justification }` waiver. `routeId` is the stable `METHOD /path` id.
 */
export function declarePhiReadRoute(
  routeId: string,
  intent: AuditReadConfig | ReadAuditMode,
): void {
  const mode: ReadAuditMode = "auditRead" in intent ? intent : { auditRead: true };
  declareReadAudit(routeId, mode);
}
