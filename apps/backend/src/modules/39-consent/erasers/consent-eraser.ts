// apps/backend/src/modules/39-consent/erasers/consent-eraser.ts — M39-T10 (spec §3.8, D20).
//
// M39's REAL `consent` DataEraser, registered over the Phase-0 deny-stub. The M4 destruction-cert
// workflow hands `subjectId` = the patient whose retention class reached eligible_for_destruction;
// the eraser deletes that patient's consent subtree EXCEPT rows it must retain (§3.8): an active
// legal hold (M4 §10.6) or a `42_cfr_part_2_release` while the patient is still alive (Part 2
// lifetime retention). consent_eval_audit is never touched here — its destruction is M4's certified
// audit-retention path (M39-F04). The decision engine is the pure `eraseConsentForSubject`
// (@wardenx/consent); this is the thin DataEraser shell over an injected store (in-memory by default).
import {
  type ConsentEraseStore,
  createInMemoryConsentEraseStore,
  eraseConsentForSubject,
} from "@wardenx/consent";
import type { DataEraser } from "@wardenx/types";
import { registerEraser } from "../../../bootstrap/index";

/** Injected adapter for M39's eraser (slice defaults to the in-memory erase store). */
export interface ConsentEraserDeps {
  /** The data port deletes run over (Drizzle-backed in production; in-memory by default). */
  store?: ConsentEraseStore;
}

/** Build M39's `consent` DataEraser. Returns the count actually deleted; rows retained under a legal
 *  hold or the Part 2 lifetime are NOT counted (mirrors M4's audit-eraser refusal accounting). */
export function createConsentEraser(store: ConsentEraseStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseConsentForSubject(scope.orgId, subjectId, store);
      return { erased };
    },
  };
}

/** Register M39's REAL `consent` eraser into the M1 destruction-cert registry over the Phase-0
 *  deny-stub (M39-T10). Called by the composition root's wireModuleErasers() before validateErasers(). */
export function registerConsentErasers(deps: ConsentEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryConsentEraseStore().store;
  registerEraser("consent", createConsentEraser(store));
}
