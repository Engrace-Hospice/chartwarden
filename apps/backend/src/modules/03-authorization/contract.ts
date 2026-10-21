// apps/backend/src/modules/03-authorization/contract.ts — M3-T08 break-glass branch wiring.
//
// `require-abac.ts` (M3-T05) ships the §2.2 break-glass BRANCH as two fail-closed injected
// seams whose defaults keep the branch shut: `BreakGlassChecker` (returns null → no bypass)
// and `BreakGlassAuditHook` (no-op). This file registers the REAL implementations the route
// inventory backs them with, so that once a clinician has invoked break-glass (POST
// /api/v1/breakglass), any ABAC-denied access to the covered target opens the branch, is
// flagged on the request, and is INDIVIDUALLY AUDITED AT `critical` — the §7.4 guarantee
// ("every resource viewed under glass is logged at critical").
//
// Registration is driven from the composition root (apps/backend/src/index.ts) at boot,
// alongside the other module seam registrations, and reset between tests. The checker reads
// the active-grant lookup off M3's own `BreakGlassStore`; the audit hook routes the per-access
// row through the mandated audit() helper (the field denylist runs there).
import type { AuditContext, AuditExecutor } from "@chartwarden/audit";
import { setBreakGlassAuditHook, setBreakGlassChecker } from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { auditBreakGlassAccess } from "./audit/authz-audit";
import type { BreakGlassStore } from "./authz-ports";

/**
 * Injected dependencies for the break-glass branch wiring. Provide EITHER `db` (production — the
 * per-access critical row is written under `withOrgContext` so RLS scopes it) OR `audit` (a direct
 * executor for the slice/tests). `db` takes precedence when both are given.
 */
export interface BreakGlassContractDeps {
  /** M3's break-glass store — `findActiveGrant` powers the §2.2 branch. */
  store: BreakGlassStore;
  /** Production: the DB client; the per-access `m3.breakglass.access` row is written under withOrgContext. */
  db?: DbClient;
  /** Slice/test: a direct audit executor (no org-context wrapping). */
  audit?: AuditExecutor;
  /** Injected clock (epoch ms) so the active-window check is deterministic in tests. */
  now?: () => number;
}

/**
 * Register the real break-glass checker + critical-audit hook into the Authorization
 * Contract (M3-T05 seams). After this, `requireAbac(...)` on a denied predicate consults
 * M3's open break-glass events and, when one covers (actor, target), allows the request and
 * files an individual `m3.breakglass.access` audit at `critical`.
 */
export function registerBreakGlassContract(deps: BreakGlassContractDeps): void {
  const now = deps.now ?? Date.now;

  setBreakGlassChecker((context, _action, target) => {
    const targetPatientId = typeof target.patientId === "string" ? target.patientId : null;
    return deps.store.findActiveGrant(
      context.organizationId,
      context.userId,
      targetPatientId,
      now(),
    );
  });

  setBreakGlassAuditHook(async (access) => {
    const auditCtx: AuditContext = {
      organizationId: access.context.organizationId,
      userId: access.context.userId,
      actorKind: "user",
      // The per-access row is stitched to its invocation by the break-glass event id.
      correlationId: access.grant.eventId,
    };
    const resourceId =
      typeof access.target.patientId === "string" ? access.target.patientId : undefined;
    const write = (executor: AuditExecutor) =>
      auditBreakGlassAccess(executor, auditCtx, {
        eventId: access.grant.eventId,
        resourceType: access.action,
        resourceId,
      });
    // Production: write the critical row inside withOrgContext so RLS scopes it (the tx is the executor).
    // Slice/tests: write directly through the injected executor. `db` wins when both are present.
    if (deps.db) {
      await withOrgContext(
        deps.db,
        { organizationId: access.context.organizationId, userId: access.context.userId },
        (tx) => write(tx),
      );
    } else if (deps.audit) {
      await write(deps.audit);
    }
  });
}
