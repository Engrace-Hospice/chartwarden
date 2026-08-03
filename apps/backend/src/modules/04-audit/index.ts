// apps/backend/src/modules/04-audit — Module 4 (Audit & Compliance Log) backend surface.
// Owned per module-manifest.ts codePath `apps/backend/src/modules/04-audit`.
//
// M4-T06 lands the capture contract (§4.1, the obligations every PHI module fulfills) and the
// audit query route inventory (§4.2–4.3): event search, single-event detail, and the §10.2
// "who touched this chart" per-patient access history — each gated by the REAL Authorization
// Contract (`requirePermission("audit.read")`) and emitting the `audit.elevated_access`
// meta-event on elevated/cross-tenant reads (§2.6). The query primitives + the in-memory adapter
// the route tests run against ship in @wardenx/audit (`createInMemoryAuditQuery`).
export {
  type AuditReadConfig,
  assertReadAuditDeclared,
  auditListRead,
  auditPhiRead,
  declarePhiReadRoute,
  generateAuditTrigger,
} from "./contract";
export {
  AUDIT_META_EVENTS,
  auditElevatedAccess,
  isElevatedAuditRead,
} from "./audit/audit-meta";
export { type AuditRouteDeps, registerAuditRoutes } from "./routes/audit-routes";
// M4-T09: the §164.528 / §2.13 patient accounting-of-disclosures route (scope differentiation)
// + the `audit_accounting_scope_allowed` ABAC predicate M4 registers into M3's registry (§7).
export {
  ACCOUNTING_ALL_SCOPE_PERMISSION,
  AUDIT_ACCOUNTING_SCOPE_PREDICATE,
  type AccountingPermissionProbe,
  createAccountingScopePredicate,
  registerAccountingScopePredicate,
} from "./abac/audit-accounting-predicate";
export {
  type PatientAccountingDeps,
  computeLookbackForScope,
  registerPatientAccountingRoute,
} from "./routes/patient-accounting";
// M4-T08: the destruction path — the REAL `audit_event` eraser (registered over the deny-stub by
// the composition root) enforcing legal-hold supremacy (§10.6) + Part 2 lifetime retention (§6).
// TASK-003/ARCH-007: the Drizzle store enumerates REAL row-groups via the sanctioned
// @wardenx/audit reader and the Drizzle ports carry live legal-hold + patient-lifecycle guards;
// `performErasure` binds to the packages/audit `createDbAuditEraseExecutor` when a
// destruction-granted client is injected, and stays a loud refusal until deployment provisions it.
export {
  type AuditEraserDeps,
  type AuditEraserStore,
  type DrizzleAuditEraserPortsOptions,
  RIGHT_TO_ERASURE_CERTIFICATE_ID,
  createAuditEraser,
  createDrizzleAuditEraserPorts,
  createDrizzleAuditEraserStore,
  createInMemoryAuditEraserStore,
  registerAuditErasers,
} from "./erasers/audit-eraser";
// M4-T10: the action catalog (§4.6) + its D9 namespace/uniqueness boot validation (§4.6.7).
// `assertAuditActionCatalog()` is the boot gate the composition root runs at startup — it fails
// closed before the catalog is UPSERTed into `audit_action_catalog`. The catalog primitives
// (ACTION_CATALOG / actionCatalogRows / isRegisteredAction) ship in @wardenx/audit.
export { assertAuditActionCatalog } from "./audit/action-catalog";
// M4-T11: the BullMQ wiring for the §4.4 audit jobs (retention scan, execute destruction,
// integrity sample, build export, Phase-2 seal). The job LOGIC + descriptors live in
// @wardenx/audit (unit-tested against in-memory ports); this is the thin Worker/Queue construction
// the composition root drives once a Redis/Valkey connection + the production adapters exist.
export {
  type AuditWorkerDeps,
  registerAuditWorkers,
  scheduleAuditJobs,
} from "./jobs/audit-jobs";

import { createDbAuditQuery } from "@wardenx/audit";
import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import { registerAuditRoutes as _registerAuditRoutes } from "./routes/audit-routes";

/**
 * Mount the M4 audit-log REST routes (GET /audit/events, /audit/events/:id, the per-patient
 * access history) on the real Drizzle AuditQuery over `audit_event` (RLS-scoped). The composition
 * root calls this when a DB client is present. The §164.528 accounting route (registerPatientAccounting
 * Route) is NOT mounted here yet. The `audit.elevated_access` meta-event sink is the DURABLE Drizzle
 * path (`audit: db` — `AuditExecutor` is structurally `insert(table).values(row)`, the M2 precedent;
 * migration 0119 makes the `wardenx_app` INSERT legal under RLS), so an auditor's elevated-access
 * meta-event survives the process instead of dying in a Map.
 */
export function mountAuditRoutes(app: FastifyInstance, db: DbClient): void {
  _registerAuditRoutes(app, {
    query: createDbAuditQuery(db),
    audit: db,
  });
}
