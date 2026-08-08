// @wardenx/audit — Module 4 (Audit & Compliance Log) own action catalog (M4-T10; §4.6.1 `m4.ts`).
//
// M4's own audit-of-audit and read-capture events are emitted under the un-prefixed system
// (`audit.*` / `data.*` / `disclosure.*`) namespace — those live in `system.ts` (m0). Read-side
// capture (`auditRead()`) emits dynamic per-resource `<kind>.viewed/.disclosed/.list_viewed`
// actions that are resolved at the consuming PHI module's route, not statically catalogued here.
// This file holds the `m4.*`-prefixed actions M4 emits in its own right — the destruction-
// certificate state-machine transitions and the export-request lifecycle (GAP-003), which are
// M4-specific resources (not system/audit-of-audit events, so they take the `m4.` prefix per D9
// rather than joining `system.ts`'s un-prefixed set).
import type { ModuleActionCatalog } from "./types";

/** `m4` Audit module actions (GAP-003: the destruction-certificate + export-request lifecycle). */
export const M4_ACTION_CATALOG: ModuleActionCatalog = [
  {
    action: "m4.destruction_certificate.approved",
    moduleOwner: "m4",
    defaultRetentionClass: "compliance",
    description: "Compliance approved a pending destruction certificate (§6, §10.5).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m4.destruction_certificate.held",
    moduleOwner: "m4",
    defaultRetentionClass: "compliance",
    description: "A pending/approved destruction certificate was deferred (litigation hold, §6).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m4.audit_export.requested",
    moduleOwner: "m4",
    defaultRetentionClass: "compliance",
    description: "A watermarked compliance export was requested (§4.3, M04-F04 / SEC-052).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
];
