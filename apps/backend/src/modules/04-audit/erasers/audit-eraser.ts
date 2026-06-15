// apps/backend/src/modules/04-audit/erasers/audit-eraser.ts — M4-T08 the `audit_event` data eraser.
//
// M4 owns the destruction path for the audit log, so it registers the REAL `audit_event` eraser
// over the Phase-0 deny-stub (bootstrap REQUIRED_ERASERS + wireErasers()); the composition root
// invokes registerAuditErasers() through buildServer's `registerModuleErasers` hook, which runs
// AFTER wireErasers() and before validateErasers(), so the real eraser stands and a right-to-erasure
// request hits a working eraser, not a silent no-op (mirrors the M2 identity eraser).
//
// Erasure is NOT unconditional: it runs the subject's audit rows through the @wardenx/audit
// destruction eraser, which enforces legal-hold supremacy (§10.6) and Part 2 lifetime retention
// (§6) row-by-row — so a right-to-erasure can never blow away SUD audit history a patient is still
// entitled to (W-M4-09). Like the rest of the slice it runs over an injected store + ports with an
// in-memory default; the production Drizzle adapter (the partitioned crypto-erase) is a follow-up.
import {
  type EraseInput,
  type EraserPorts,
  createInMemoryEraserPorts,
  eraseAuditRows,
} from "@wardenx/audit";
import type { DataEraser, OrgScope } from "@wardenx/types";
import { registerEraser } from "../../../bootstrap/index";

/** Enumerates the `audit_event` row-groups a right-to-erasure for a subject would target. */
export interface AuditEraserStore {
  /** The audit row-groups concerning `subjectId` within the org scope (newest cohort first). */
  rowsForSubject(scope: OrgScope, subjectId: string): EraseInput[] | Promise<EraseInput[]>;
}

/** Injected adapters for the M4 audit eraser (slice defaults to in-memory store + ports). */
export interface AuditEraserDeps {
  store?: AuditEraserStore;
  ports?: EraserPorts;
}

/**
 * Build the M4 `audit_event` DataEraser. It runs each of the subject's row-groups through
 * `eraseAuditRows` and reports the faithful count actually erased — rows refused for legal hold
 * or Part 2 retention are NOT counted (they were not, and must not be, erased).
 */
export function createAuditEraser(store: AuditEraserStore, ports: EraserPorts): DataEraser {
  return {
    async erase(scope, subjectId) {
      const rows = await store.rowsForSubject(scope, subjectId);
      let erased = 0;
      for (const row of rows) {
        const outcome = await eraseAuditRows(row, ports);
        if (outcome.kind === "erased") erased += outcome.rowsErased;
      }
      return { erased };
    },
  };
}

/** In-memory `audit_event` eraser store (slice/test): the subject's seeded row-groups. */
export function createInMemoryAuditEraserStore(
  seed: Readonly<Record<string, EraseInput[]>> = {},
): AuditEraserStore {
  return {
    rowsForSubject: (_scope, subjectId) => seed[subjectId] ?? [],
  };
}

/**
 * Register M4's REAL `audit_event` eraser into the M1 destruction-cert registry over the Phase-0
 * deny-stub (M4-T08). Called by the composition root's wireModuleErasers() AFTER wireErasers() and
 * before validateErasers(), so the real eraser stands.
 */
export function registerAuditErasers(deps: AuditEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryAuditEraserStore();
  const ports = deps.ports ?? createInMemoryEraserPorts().ports;
  registerEraser("audit_event", createAuditEraser(store, ports));
}
