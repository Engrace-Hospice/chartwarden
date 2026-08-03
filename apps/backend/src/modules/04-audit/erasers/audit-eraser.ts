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
// in-memory default; production injects `createDrizzleAuditEraserStore` (row-group enumeration over
// the sanctioned @wardenx/audit query reader) + `createDrizzleAuditEraserPorts` (live legal-hold /
// patient-lifecycle guards). The `performErasure` leg is CONDITIONAL — see its note: `audit_event`
// is HELPER_ONLY and `wardenx_app` holds no DELETE grant, so the partitioned-DELETE adapter lives
// in packages/audit (`createDbAuditEraseExecutor`) and binds only when the composition root
// injects a destruction-granted client (`destructionDb`); until deployment provisions that
// credential the port THROWS, so a right-to-erasure against audit rows fails loudly instead of
// minting a certificate from nothing.
import {
  type EraseInput,
  type EraserPorts,
  createDbAuditEraseExecutor,
  createDbAuditQuery,
  createInMemoryEraserPorts,
  eraseAuditRows,
} from "@wardenx/audit";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DataEraser, OrgScope } from "@wardenx/types";
import { eq } from "drizzle-orm";
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
 * The right-to-erasure path enters through the DataEraser contract, which carries NO destruction
 * certificate id (the certificate is filed by the M4 workflow that invoked the registry). The
 * Drizzle store stamps enumerated row-groups with this marker so a certificate line produced from
 * them is distinguishable from a retention-scan-opened certificate's own id.
 */
export const RIGHT_TO_ERASURE_CERTIFICATE_ID = "right-to-erasure";

/**
 * The Drizzle-backed store (TASK-003 / ARCH-007): enumerate the subject's REAL `audit_event`
 * row-groups. `audit_event` is HELPER_ONLY (manifest HELPER_ONLY_TABLES) — packages/audit is its
 * only sanctioned reader — so this store does NOT touch the table itself: it pages the
 * `createDbAuditQuery` search surface (RLS-scoped, newest-first) with the subject as the patient
 * filter, and folds the rows into (retentionClass, resourceKind, resourceId) groups, newest cohort
 * first. Every group carries `patientId = subjectId` so the orchestrator's Part 2 lifetime guard
 * has its subject without a resolver round-trip.
 */
export function createDrizzleAuditEraserStore(db: DbClient): AuditEraserStore {
  const query = createDbAuditQuery(db);
  return {
    async rowsForSubject(scope, subjectId) {
      const groups = new Map<string, EraseInput>();
      let cursor: string | undefined;
      do {
        const page = await query.searchEvents(scope.orgId, {
          patientId: subjectId,
          limit: 200, // MAX_PAGE_LIMIT — fewest round trips the reader allows
          ...(cursor ? { cursor } : {}),
        });
        for (const r of page.items) {
          // A row with no resource id forms its own group keyed on the event id — grouping it
          // under a shared blank key would let one legal hold shadow unrelated events.
          const resourceId = r.resourceId ?? r.id;
          const key = `${r.retentionClass}|${r.resourceKind}|${resourceId}`;
          if (groups.has(key)) continue;
          groups.set(key, {
            retentionClass: r.retentionClass,
            resourceKind: r.resourceKind,
            resourceId,
            organizationId: scope.orgId,
            destructionCertificateId: RIGHT_TO_ERASURE_CERTIFICATE_ID,
            patientId: subjectId,
          });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return [...groups.values()];
    },
  };
}

/**
 * Options for {@link createDrizzleAuditEraserPorts} — the destruction credential, when deployment
 * has provisioned one.
 */
export interface DrizzleAuditEraserPortsOptions {
  /**
   * A DESTRUCTION-GRANTED DbClient (separately pooled credential holding DELETE on `audit_event`,
   * e.g. `wardenx_admin`) — NEVER the tenant pool: `wardenx_app` has no DELETE grant (migration
   * 0001 append-only). When supplied, `performErasure` binds to the packages/audit
   * `createDbAuditEraseExecutor` over it; when absent, the leg stays a typed UNBOUND throw.
   */
  destructionDb?: DbClient;
}

/**
 * The Drizzle-backed `EraserPorts` (TASK-003 / ARCH-007): the guards are LIVE; the erase leg binds
 * to the packages/audit executor only when a destruction-granted client is injected.
 *
 *   • `legalHoldFor` reads the org's ACTIVE `legal_hold` rows (M4-owned) and matches
 *     conservatively — a hold whose free-form `criteria` jsonb mentions the row-group's resource
 *     id or patient anywhere holds the group (the M39 consent-eraser precedent). Over-matching is
 *     the safe direction: a wrongly-held row is merely refused; a wrongly-released one is erased
 *     against a hold (§10.6 supremacy).
 *   • `loadPatient` reads the M5 `patient` status + deceased_date under org RLS for the §6
 *     lifetime window (the M39 "fail-closed deceased proof" read). Any non-deceased status maps
 *     to `active` — only a proven death date can open the 6-year window.
 *   • `performErasure` — `audit_event` is HELPER_ONLY and `wardenx_app` holds INSERT/SELECT only
 *     (migration 0001 — the append-only guarantee), so no code in this module may, and no tenant
 *     connection could, delete audit rows. The partitioned-DELETE adapter therefore lives in
 *     packages/audit (`createDbAuditEraseExecutor`) and runs ONLY over the injected
 *     `opts.destructionDb`. Until deployment provisions that credential and threads it here, the
 *     leg THROWS `M4_ERASER_PERFORM_ERASURE_UNBOUND` — an erase that reaches it fails loudly
 *     rather than reporting rows destroyed that still exist.
 */
export function createDrizzleAuditEraserPorts(
  db: DbClient,
  opts: DrizzleAuditEraserPortsOptions = {},
): EraserPorts {
  const HOLD = schema.legalHolds;
  const P = schema.patients;
  const executor = opts.destructionDb ? createDbAuditEraseExecutor(opts.destructionDb) : null;
  return {
    async legalHoldFor(input) {
      return withOrgContext(
        db,
        { organizationId: input.organizationId, userId: "" },
        async (tx) => {
          const holds = await tx
            .select({ id: HOLD.id, criteria: HOLD.criteria })
            .from(HOLD)
            .where(eq(HOLD.status, "active"));
          for (const h of holds) {
            const text = JSON.stringify(h.criteria ?? {});
            if (
              text.includes(input.resourceId) ||
              (input.patientId !== undefined && text.includes(input.patientId))
            ) {
              return h.id;
            }
          }
          return null;
        },
      );
    },

    async loadPatient(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({ status: P.status, deceasedDate: P.deceasedDate })
          .from(P)
          .where(eq(P.id, patientId))
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        return row.status === "deceased"
          ? { status: "deceased" as const, deceasedDate: row.deceasedDate }
          : { status: "active" as const };
      });
    },

    async performErasure(input) {
      if (executor) return executor.performErasure(input);
      throw new Error(
        "M4_ERASER_PERFORM_ERASURE_UNBOUND: audit_event is HELPER_ONLY and wardenx_app has no " +
          "DELETE grant (migration 0001 append-only guarantee); the packages/audit " +
          "createDbAuditEraseExecutor requires a destruction-granted client injected as " +
          "`destructionDb`, which deployment has not provisioned. Refusing to " +
          `report '${input.resourceKind}/${input.resourceId}' erased while its rows survive.`,
      );
    },

    now: () => new Date(),
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
