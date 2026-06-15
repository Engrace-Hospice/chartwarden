// @wardenx/audit — Module 4 (Audit & Compliance Log) own action catalog (M4-T10; §4.6.1 `m4.ts`).
//
// M4's own audit-of-audit and read-capture events are emitted under the un-prefixed system
// (`audit.*` / `data.*` / `disclosure.*`) namespace — those live in `system.ts` (m0). Read-side
// capture (`auditRead()`) emits dynamic per-resource `<kind>.viewed/.disclosed/.list_viewed`
// actions that are resolved at the consuming PHI module's route, not statically catalogued here.
// This file holds any future `m4.*`-prefixed actions M4 emits in its own right.
import type { ModuleActionCatalog } from "./types";

/** `m4` Audit module actions (none yet — M4's meta-events are un-prefixed system actions). */
export const M4_ACTION_CATALOG: ModuleActionCatalog = [];
