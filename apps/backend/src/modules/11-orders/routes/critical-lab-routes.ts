import {
  BREAK_GLASS_ATTRIBUTE,
  hasOrgWideScope,
  requireAbac,
  requirePermission,
} from "@chartwarden/auth";
// apps/backend/src/modules/11-orders/routes/critical-lab-routes.ts — the quarantined critical-lab queue and its
// resolve workflow (#1136 / CW-CS-01).
//
//   GET  /api/v1/orders/critical-lab-results              the OPEN queue (quarantined, no resolution), soonest deadline first
//   GET  /api/v1/orders/critical-lab-results/:id          one result and its resolution (read-audited by id)
//   POST /api/v1/orders/critical-lab-results/:id/resolve  matched to an order / reviewed, no action (append-only)
//
// A critical result with no matching order is paged and escalated once; it used to stay in the database until someone
// edited it. Resolving appends one immutable row (who, when, why) and emits `m11.order.critical_lab_resolved`; a cleared
// result cannot be re-opened (see `critical-lab-resolution.ts`).
//
// AUTHORIZATION: reads need `orders.read`; the resolve needs `orders.complete` (the existing "Mark reviewed" grant, D17) AND
// a prescriber discipline (the service, 403) AND the patient on the caller's caseload (`caseload_or_scope`, 404 on a miss so
// existence is never confirmed). Break-glass opens reads only; the resolve guard is non-bypassable. An `ai_*` principal is
// refused (D13). The queue narrows to the caller's caseload (`readScopeOf`); org-wide scope roles see the whole org.
// Static `critical-lab-results` segments sit beside the `/api/v1/orders/:id` parameter routes; Fastify matches the static
// segment first, so it is never read as an order id.
//
// NO PHI beyond what the order lists already expose (`patientId`); a result value is never stored here. The free-text
// `reason` is returned only on the by-id read, which is audited.
import {
  type PreHandler,
  membershipActorOf,
  orgOf,
  rejectAiActor,
} from "@chartwarden/shared/route-kit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  type CriticalLabResolutionDeps,
  criticalLabPatientId,
  getCriticalLabResult,
  listOpenQuarantinedCriticalLabs,
  resolveCriticalLabResult,
} from "../critical-lab-resolution";
import {
  CriticalLabQueueQuerySchema,
  CriticalLabResultParamsSchema,
  ResolveCriticalLabRequest,
} from "./critical-lab-typebox";
import { type OrderRouteDeps, defaultCaseloadPatientIds, readScopeOf } from "./orders-routes";
import { parse } from "./orders-typebox";
import { assertPatientInActorScope } from "./service-actor-guards";

const READ = requirePermission("orders.read") as PreHandler;
const RESOLVE = requirePermission("orders.complete") as PreHandler;

/** Sentinel patient for a result that cannot be resolved: it is on no caseload, so the scope guard denies (404). */
const UNRESOLVED_PATIENT = "00000000-0000-0000-0000-000000000000";
/** Break-glass is READ-ONLY: a grant opens the queue for reading, never lets an off-caseload actor resolve. */
const WRITE_ONLY = { breakGlassBypassable: false } as const;

export interface CriticalLabRouteDeps extends CriticalLabResolutionDeps {
  /** The caller's caseload (GAP-030); defaults to M5's `CaseloadProvider` seam, as the order routes do. */
  readonly caseloadPatientIds?: OrderRouteDeps["caseloadPatientIds"];
}

export function registerCriticalLabRoutes(app: FastifyInstance, deps: CriticalLabRouteDeps): void {
  const caseloadPatientIds = deps.caseloadPatientIds ?? defaultCaseloadPatientIds;

  // The per-result caseload scope: resolve the row's patient (org-scoped, RLS-backstopped) into a per-request slot, then
  // run the shared `caseload_or_scope` predicate over it. An absent / cross-tenant id resolves to a patient nobody covers.
  const resolvedPatient = new WeakMap<object, string>();
  const RESOLVE_PATIENT: PreHandler = async (request) => {
    const { id } = parse(CriticalLabResultParamsSchema, request.params);
    const patientId = await criticalLabPatientId(deps, orgOf(request), id);
    resolvedPatient.set(request, patientId ?? UNRESOLVED_PATIENT);
  };
  const scopeGuard = (action: string, bypassable: boolean): PreHandler[] => [
    RESOLVE_PATIENT,
    requireAbac(action, "caseload_or_scope", {
      getTarget: (request) => ({ patientId: resolvedPatient.get(request) ?? UNRESOLVED_PATIENT }),
      notFoundOnDeny: true,
      ...(bypassable ? {} : WRITE_ONLY),
    }) as PreHandler,
  ];

  /** The actor facts the service's own scope + discipline checks read, from the authenticated request context. */
  const actorOf = (request: FastifyRequest) => {
    const { organizationId, userId: membershipId } = membershipActorOf(request);
    const ctx = request.context;
    const pinned = ctx.attributes.sessionPatientId;
    const actor = {
      membershipId,
      userId: ctx.userId,
      // Discipline derives from the session's role grants (#87), as the other M11 actions do.
      disciplines: ctx.roles,
      roles: ctx.roles,
      orgWide: hasOrgWideScope(ctx.roles),
      sessionPatientId: typeof pinned === "string" && pinned.length > 0 ? pinned : null,
    };
    return {
      organizationId,
      actor,
      assertInScope: (patientId: string) =>
        assertPatientInActorScope(actor, organizationId, patientId, caseloadPatientIds),
    };
  };

  app.get(
    "/api/v1/orders/critical-lab-results",
    {
      preHandler: [READ],
      // The queue returns `patientId` for every row, so it is a PHI read and is audited as one.
      config: { auditRead: { resourceKind: "critical_lab_result", list: true } },
    },
    async (request) => {
      const organizationId = orgOf(request);
      const q = parse(CriticalLabQueueQuerySchema, request.query);
      const scope = await readScopeOf(request, caseloadPatientIds);
      return listOpenQuarantinedCriticalLabs(deps, organizationId, {
        limit: q.limit ?? 50,
        cursor: q.cursor,
        patientIds: scope.patientIds,
      });
    },
  );

  app.get(
    "/api/v1/orders/critical-lab-results/:id",
    {
      preHandler: [READ, ...scopeGuard("orders.read", true)],
      // `resourceIdParam` is what puts the result's id on the read event; without it the event's resource id is empty.
      // `patientIdPayloadPath` attributes the read to the patient, which the §164.528 accounting query joins on.
      config: {
        auditRead: {
          resourceKind: "critical_lab_result",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request) => {
      const { id } = parse(CriticalLabResultParamsSchema, request.params);
      const { organizationId, assertInScope } = actorOf(request);
      // A break-glass grant the guard above honoured opens THIS read: the service's own scope re-check ignores grants and
      // would 404 an emergency read the guard just audited as granted. The resolve route never takes this path.
      const breakGlass = typeof request.context.attributes[BREAK_GLASS_ATTRIBUTE] === "string";
      return getCriticalLabResult(
        deps,
        organizationId,
        id,
        breakGlass ? async () => undefined : assertInScope,
      );
    },
  );

  app.post(
    "/api/v1/orders/critical-lab-results/:id/resolve",
    {
      preHandler: [rejectAiActor() as PreHandler, RESOLVE, ...scopeGuard("orders.complete", false)],
    },
    async (request) => {
      const { id } = parse(CriticalLabResultParamsSchema, request.params);
      const body = parse(ResolveCriticalLabRequest, request.body);
      const { organizationId, actor, assertInScope } = actorOf(request);
      return resolveCriticalLabResult(deps, organizationId, id, body, actor, assertInScope);
    },
  );
}
