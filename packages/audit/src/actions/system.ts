// @wardenx/audit — system (`m0`) action catalog (M4-T10; M4 spec §4.6.1 `system.ts`, §11.1).
//
// The un-prefixed `audit.*` / `data.*` / `disclosure.*` system actions M4 owns — including the
// audit-of-audit meta-events of §11.1 ("the watchers are watched"). Un-prefixed by D9 convention
// (system actions stay un-prefixed); the catalog validator assigns them `moduleOwner: 'm0'`.
import type { ModuleActionCatalog } from "./types";

/** `m0` system actions: audit-of-audit + compliance lifecycle events (§11.1, §4.6.1). */
export const SYSTEM_ACTION_CATALOG: ModuleActionCatalog = [
  {
    action: "audit.elevated_access",
    moduleOwner: "m0",
    defaultRetentionClass: "compliance",
    description:
      "An elevated / cross-tenant read of the audit log (§2.6, §10.4) — the audit-of-audit meta-event.",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "disclosure.accounting_generated",
    moduleOwner: "m0",
    defaultRetentionClass: "compliance",
    description:
      "A §164.528 / §2.13 patient accounting-of-disclosures report was generated (§11.1).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "data.legal_hold_applied",
    moduleOwner: "m0",
    defaultRetentionClass: "compliance",
    description: "A legal hold was applied; matching records flipped to legal_hold class (§10.6).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "data.legal_hold_released",
    moduleOwner: "m0",
    defaultRetentionClass: "compliance",
    description: "A legal hold was released; records returned to their prior class (§10.6).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "data.destruction_certified",
    moduleOwner: "m0",
    defaultRetentionClass: "compliance",
    description: "A signed Certificate of Destruction was filed for an erased partition (§10.5).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "audit.destruction_refused_part_two",
    moduleOwner: "m0",
    defaultRetentionClass: "compliance",
    description:
      "Destruction refused for Part 2 rows whose patient is alive / <6yr post-death (§6, §10.8).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "audit.integrity_mismatch",
    moduleOwner: "m0",
    defaultRetentionClass: "compliance",
    description: "Sample-vs-backup integrity check detected an out-of-band modification (§10.4).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "audit.export_generated",
    moduleOwner: "m0",
    defaultRetentionClass: "compliance",
    description: "A watermarked audit export was generated; the export itself is audited (§11.1).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
];
