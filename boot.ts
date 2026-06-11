/**
 * WardenX — Seam boot wiring (example)
 * REAL PATH: apps/backend/src/bootstrap/seams.ts  (Module 1 owns bootstrap)
 * ------------------------------------------------------------------
 * Each module's init registers the seams it implements. After ALL modules have
 * initialized and BEFORE the server listens, call validateSeams(). A missing
 * required seam aborts startup with an actionable message.
 */

import { validateSeams } from "./registry";
import { setCaseloadProvider } from "./caseload";
import { registerEraser } from "./eraser-registry";
import type { CaseloadProvider, DataEraser } from "./interfaces";

// These come from the owning feature modules at their init (shown inline for the example).
declare const realCaseloadProvider: CaseloadProvider;           // Module 5/17
declare const auditEraser: DataEraser;                          // Module 4
declare const clinicalRecordEraser: DataEraser;                 // Module 5/8
declare const documentEraser: DataEraser;                       // Module 22
declare const messageEraser: DataEraser;                        // Module 36
declare const consentEraser: DataEraser;                        // Module 39
declare const telehealthRecordingEraser: DataEraser;            // Module 31

export function wireSeams(): void {
  // Module 5/17 caseload source
  setCaseloadProvider(realCaseloadProvider);

  // Every PHI data class needs an eraser, or boot fails (decision D4)
  registerEraser("audit_event", auditEraser);
  registerEraser("clinical_record", clinicalRecordEraser);
  registerEraser("documents", documentEraser);
  registerEraser("messages", messageEraser);
  registerEraser("consent", consentEraser);
  registerEraser("telehealth_recording", telehealthRecordingEraser);
}

/** Call from the backend bootstrap before `server.listen()`. */
export function bootSeams(): void {
  wireSeams();
  validateSeams(); // throws SeamError listing anything unregistered — refuse to start
}
