// @chartwarden/audit — Module 1 (Foundation) action catalog (M4-T10; M4 spec §4.6.1 `m1.ts`).
//
// M1 captures mutations through the DB write-audit triggers (per-table `<table>.<op>` events)
// and the transactional outbox, not through app-level `mN.*` audit() calls — so it contributes
// no fine-grained `m1.*` catalog action yet. The file exists to hold the per-module slice the
// moment M1 emits an app-level audit action (the §4.6.1 one-file-per-module structure).
import type { ModuleActionCatalog } from "./types";

/** `m1` Foundation actions (none yet — Foundation audits via triggers + the outbox). */
export const M1_ACTION_CATALOG: ModuleActionCatalog = [];
