// apps/backend/src/modules/08-encounters/routes/closure-routes.ts — the visit-note closure routes (ADR-0113, slice 1).
//
//   GET  /api/v1/encounters/closure-status                       the caller's own clock position (the banner)       encounter.author
//   GET  /api/v1/encounters/overdue-notes                        the supervisor board (org / site scoped)           encounter.closure_override
//   POST /api/v1/encounters/closure-overrides                    grant a block override (step-up)                   encounter.closure_override
//   POST /api/v1/encounters/closure-overrides/:overrideId/revoke revoke it (step-up)                                encounter.closure_override
//   GET  /api/v1/encounters/closure-policy                       the tenant's mode + threshold                      encounter.closure_policy_admin
//   PUT  /api/v1/encounters/closure-policy                       set it; a move to block opens the grace window     encounter.closure_policy_admin
//
// Every path is a STATIC segment under `/api/v1/encounters/`, registered next to the `:encounterId` routes; the router prefers a
// static segment over a parameter, and closure-routes.test.ts proves none of them is swallowed. Org and actor come from the
// server-assembled `request.context`, never the body. Errors are typed ChartWardenError only (the services throw them). A PUT
// that moves the policy invalidates the gate's cache through the service.
import type { AuditContext } from "@chartwarden/audit";
import { hasOrgWideScope, requirePermission, requireStepUp } from "@chartwarden/auth";
import {
  type PreHandler,
  rejectAiActor,
  requireIdempotencyKey,
  writeActorOf,
} from "@chartwarden/shared/route-kit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ClosureActor, ClosureRouteService } from "../closure/closure-route-service";
import {
  ClosureOverrideParamsSchema,
  GrantClosureOverrideSchema,
  OVERDUE_NOTES_DEFAULT_LIMIT,
  OverdueNotesQuerySchema,
  PutClosurePolicySchema,
} from "./closure-typebox";
import { parse } from "./encounters-typebox";

export interface ClosureRouteDeps {
  readonly service: ClosureRouteService;
  /**
   * A per-actor limiter for the override grant and revoke routes (`createRouteRateLimit`, bound at the composition root). A refused
   * grant or revoke writes an immutable compliance-retention `m8.encounter.closure_override_denied` row per request, and fresh
   * Idempotency-Keys defeat the replay cache, so this bounds how many such rows one supervisor can add. It runs after the
   * permission and AI guards and before the step-up, so a caller those refuse never spends the budget.
   * REQUIRED, so a future mount cannot leave the routes unlimited by omission (a test that wants none passes a no-op).
   */
  readonly overrideRateLimit: PreHandler;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
// The same guard `GET /encounters/my-drafts` uses: the caller authors notes, so the clock is theirs to read.
const AUTHOR = P("encounter.author");
const CLOSURE_OVERRIDE = P("encounter.closure_override");
const CLOSURE_POLICY_ADMIN = P("encounter.closure_policy_admin");
const STEP_UP = (operationKey: string): PreHandler => requireStepUp(operationKey) as PreHandler;
// An AI principal may not lift a block or reconfigure the clock (D13).
const NO_AI = rejectAiActor(
  "AI principals cannot change the closure policy or grant overrides (D13)",
) as PreHandler;
// A retried grant must not insert a second override row: the key is required here (the shared client sends one on every write).
const IDEMPOTENT = requireIdempotencyKey() as PreHandler;

/** The override grant and revoke both ride this step-up operation key (a tenant can tighten its freshness window per key). */
export const CLOSURE_OVERRIDE_STEP_UP_KEY = "encounter.closure_override";
/** The policy write rides its own step-up operation key, so a tenant can tune it apart from the override grant. */
export const CLOSURE_POLICY_STEP_UP_KEY = "encounter.closure_policy_admin";

function closureActorOf(request: FastifyRequest): ClosureActor {
  const { organizationId, userId, membershipId } = writeActorOf(request);
  return { organizationId, userId, membershipId };
}

function auditContextOf(request: FastifyRequest): AuditContext {
  const ctx = request.context;
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    actorKind: "user",
    correlationId: ctx.correlationId,
    requestId: String(request.id),
    sourceIp: ctx.ip,
    userAgent: ctx.userAgent,
  };
}

/**
 * Org-wide roles see every site; everyone else sees only the locations their session carries (fail closed when empty), plus the notes
 * that have no location (see `closureLocationScope`). The board and the override grant read the same scope.
 */
function boardScopeOf(request: FastifyRequest): readonly string[] | null {
  const ctx = request.context;
  return hasOrgWideScope(ctx.roles) ? null : [...ctx.locationIds];
}

export function registerClosureRoutes(app: FastifyInstance, deps: ClosureRouteDeps): void {
  const { service } = deps;

  app.get(
    "/api/v1/encounters/closure-status",
    {
      preHandler: [AUTHOR],
      config: {
        auditRead: {
          none: "the caller's own clock position: the oldest open note's encounter id, patient id (an opaque uuid) and draft/finalized status, plus deadline instants; the caller authored that note and nothing here names or describes the patient (the web banner polls this instead of a read-audited encounter GET)",
        },
      },
    },
    async (request) => service.closureStatus(closureActorOf(request)),
  );

  app.get(
    "/api/v1/encounters/overdue-notes",
    {
      preHandler: [CLOSURE_OVERRIDE],
      // The board names a patient on every row, so it is audited as a MULTI-PATIENT read (the 36-messaging queue routes' convention):
      // one `encounter.viewed` event per distinct patient disclosed, all against the first row's encounter id, for the §164.528
      // accounting. `list: true` would record one aggregate event and ignore `patientIdsPayload`. An empty board discloses no
      // patient, so it writes no event.
      config: {
        auditRead: {
          resourceKind: "encounter",
          resourceIdPayloadPath: "items.0.encounterId",
          patientIdsPayload: { path: "items", key: "patientId" },
        },
      },
    },
    async (request) => {
      const actor = closureActorOf(request);
      const query = parse(OverdueNotesQuerySchema, request.query);
      return service.overdueNotes(actor, {
        limit: query.limit ?? OVERDUE_NOTES_DEFAULT_LIMIT,
        locationIds: boardScopeOf(request),
      });
    },
  );

  app.post(
    "/api/v1/encounters/closure-overrides",
    {
      preHandler: [
        CLOSURE_OVERRIDE,
        NO_AI,
        deps.overrideRateLimit,
        STEP_UP(CLOSURE_OVERRIDE_STEP_UP_KEY),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const actor = closureActorOf(request);
      const body = parse(GrantClosureOverrideSchema, request.body);
      const granted = await service.grantOverride(actor, {
        subjectMembershipId: body.subjectMembershipId,
        reason: body.reason,
        ...(body.hours === undefined ? {} : { hours: body.hours }),
        locationIds: boardScopeOf(request),
        audit: auditContextOf(request),
      });
      return reply.code(201).send(granted);
    },
  );

  app.post(
    "/api/v1/encounters/closure-overrides/:overrideId/revoke",
    {
      preHandler: [
        CLOSURE_OVERRIDE,
        NO_AI,
        deps.overrideRateLimit,
        STEP_UP(CLOSURE_OVERRIDE_STEP_UP_KEY),
      ],
    },
    async (request) => {
      const actor = closureActorOf(request);
      const { overrideId } = parse(ClosureOverrideParamsSchema, request.params);
      return service.revokeOverride(actor, overrideId, {
        locationIds: boardScopeOf(request),
        audit: auditContextOf(request),
      });
    },
  );

  app.get(
    "/api/v1/encounters/closure-policy",
    {
      preHandler: [CLOSURE_POLICY_ADMIN],
      config: {
        auditRead: { none: "organization-level closure policy configuration; no patient data" },
      },
    },
    async (request) => service.getPolicy(closureActorOf(request).organizationId),
  );

  // Step-up: one mistaken PUT (mode block, a short threshold) can lock every clinician of the tenant out, so it is as guarded as a grant.
  app.put(
    "/api/v1/encounters/closure-policy",
    { preHandler: [CLOSURE_POLICY_ADMIN, NO_AI, STEP_UP(CLOSURE_POLICY_STEP_UP_KEY)] },
    async (request) => {
      const actor = closureActorOf(request);
      const body = parse(PutClosurePolicySchema, request.body);
      return service.putPolicy(actor, body, auditContextOf(request));
    },
  );
}
