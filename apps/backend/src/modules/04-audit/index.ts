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
// GAP-003: the §6/§7/§10.4 compliance surfaces that were coded (domain logic) but never given an
// HTTP surface — legal holds, destruction certificates, compliance exports, the integrity report.
export {
  type LegalHoldsRouteDeps,
  type M4OutboxPort,
  type M4OutboxEmission,
  registerLegalHoldsRoutes,
} from "./routes/legal-holds";
export {
  type DestructionCertificatesRouteDeps,
  registerDestructionCertificatesRoutes,
} from "./routes/destruction-certificates";
export { type AuditExportsRouteDeps, registerAuditExportsRoutes } from "./routes/audit-exports";
export {
  type AuditIntegrityRouteDeps,
  registerAuditIntegrityRoutes,
} from "./routes/audit-integrity";
export { M4_OUTBOX_EVENTS } from "./events-by-m4";
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

import { type AuditExecutor, type NewAuditEvent, createDbAuditQuery } from "@wardenx/audit";
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { FastifyInstance } from "fastify";
import { registerAuditExportsRoutes as _registerAuditExportsRoutes } from "./routes/audit-exports";
import { registerAuditIntegrityRoutes as _registerAuditIntegrityRoutes } from "./routes/audit-integrity";
import { registerAuditRoutes as _registerAuditRoutes } from "./routes/audit-routes";
import { registerDestructionCertificatesRoutes as _registerDestructionCertificatesRoutes } from "./routes/destruction-certificates";
import type { M4OutboxPort } from "./routes/legal-holds";
import { registerLegalHoldsRoutes as _registerLegalHoldsRoutes } from "./routes/legal-holds";
import { registerPatientAccountingRoute as _registerPatientAccountingRoute } from "./routes/patient-accounting";

/** Optional composition-root ports `mountAuditRoutes` binds beyond the plain Drizzle handle. */
export interface MountAuditRoutesOptions {
  /** The `m4`-pinned transactional-outbox port (§7 M04-F03). Best-effort like every other
   *  module's outbox binding: absent ⇒ legal-hold mutations still commit, only the
   *  `m4.legal_hold.applied`/`released` notification is skipped. */
  readonly outbox?: M4OutboxPort;
}

/**
 * Mount the FULL M4 audit/compliance REST surface on the real Drizzle AuditQuery over
 * `audit_event` (RLS-scoped): event search + per-patient access history + the §164.528/§2.13
 * accounting route (GAP-002), and the §6/§7/§10.4 compliance surfaces (GAP-003) — legal holds,
 * destruction certificates, compliance exports, the integrity report. The composition root calls
 * this when a DB client is present. Every registrar shares the same `{ query, audit }` (or `{ db }`)
 * deps shape, so mounting them together here means a future route can't be exported-but-never-
 * called again the way the accounting route was (GAP-002's actual bug). The `audit.elevated_access`
 * meta-event sink is the DURABLE Drizzle path (`createTenantAuditExecutor(db)` — `AuditExecutor` is structurally
 * `insert(table).values(row)`, the M2 precedent; migration 0119 makes the `wardenx_app` INSERT
 * legal under RLS), so an auditor's elevated-access meta-event survives the process instead of
 * dying in a Map.
 */
/**
 * The meta-event sink must write inside the tenant's context. A bare pooled `db` insert runs with
 * whatever `app.org_id` the connection last held: unset on a fresh connection, but `''` on one that
 * earlier ran a `withOrgContext` transaction (Postgres keeps a custom GUC as an empty string once a
 * SET LOCAL ends). `audit_event_org_append` then casts `''::uuid` and the INSERT fails, so the audit
 * read 500s ("invalid input syntax for type uuid"). Same fix as M3's `createTenantAuditExecutor` and
 * M2's #205: set the org from the immutable row before writing. A platform event with no org keeps
 * the bare client (the `audit_writer_insert` policy).
 */
export function createTenantAuditExecutor(db: DbClient): AuditExecutor {
  return {
    insert(table) {
      return {
        values(row: NewAuditEvent) {
          const organizationId = row.organizationId;
          if (typeof organizationId !== "string") return db.insert(table).values(row);
          return withOrgContext(
            db,
            { organizationId, userId: typeof row.actorUserId === "string" ? row.actorUserId : "" },
            (tx) => tx.insert(table).values(row),
          );
        },
      };
    },
  };
}

export function mountAuditRoutes(
  app: FastifyInstance,
  db: DbClient,
  options: MountAuditRoutesOptions = {},
): void {
  const deps = { query: createDbAuditQuery(db), audit: createTenantAuditExecutor(db) };
  _registerAuditRoutes(app, deps);
  _registerPatientAccountingRoute(app, deps);
  _registerLegalHoldsRoutes(app, { db, query: deps.query, outbox: options.outbox });
  _registerDestructionCertificatesRoutes(app, { db });
  _registerAuditExportsRoutes(app, { db });
  _registerAuditIntegrityRoutes(app, { db });
}
