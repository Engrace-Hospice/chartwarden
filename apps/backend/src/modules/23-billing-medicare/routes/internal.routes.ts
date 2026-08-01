// apps/backend/src/modules/23-billing-medicare/routes/internal.routes.ts — M23 (§4.1 internal seam plane).
//
// The two SERVICE-TO-SERVICE seam HTTP endpoints (routes #39/#40) other modules call with a SYSTEM principal
// (never an interactive user): the ClaimDayProjectionProvider (#39, consumed by M26 cap + M27 cost-report)
// and the ClaimSubmissionReader.acceptedSubmissionsInWindow (#40, consumed by M25 remittance 835→claim
// matching). Both are aggregate / id-keyed (no PHI) and gated by {@link requireSystemPrincipal} — the §2.2
// existence/authorization posture for an internal seam is "system-only, fail-closed".
//
// FAIL-CLOSED-UNBOUND (RULE 4): the backing provider is a typed PORT the composition root binds at boot; the
// default {@link denyStubInternalSeamProvider} throws `SEAM_UNBOUND` (503) only when a request actually runs,
// so boot stays green before the real M23 day-projection / submission-reader providers land. The org binding
// comes from the SERVER-ASSEMBLED request context (`actorOf`), never from the query — see `tenantOf` below
// for why the previous "the calling module names the tenant it is acting for" contract was a cross-tenant
// read primitive. The bound provider opens `withOrgContext` over (context org, system userId) so RLS scopes
// every downstream read.
import {
  type AcceptedSubmissionsQuery as AcceptedSubmissionsQueryType,
  type AcceptedSubmissionsResponse,
  AcceptedSubmissionsQuery,
  type ClaimDayProjectionQuery as ClaimDayProjectionQueryType,
  type ClaimDayProjectionResponse,
  ClaimDayProjectionQuery,
} from "@wardenx/billing";
import { ForbiddenError, WardenXError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { actorOf } from "./actor";
import { requireSystemPrincipal } from "./guards";
import { parse } from "./billing-typebox";

/** The org + acting principal the bound provider scopes its `withOrgContext` reads to. */
export interface InternalSeamContext {
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * The internal-seam backing PORT (§4.3 ClaimDayProjectionProvider + ClaimSubmissionReader, projected over
 * HTTP). The composition root binds the real Drizzle-backed provider; the default deny-stub fails closed.
 */
export interface M23InternalSeamProvider {
  claimDayProjection(
    ctx: InternalSeamContext,
    query: ClaimDayProjectionQueryType,
  ): Promise<ClaimDayProjectionResponse>;
  acceptedSubmissionsInWindow(
    ctx: InternalSeamContext,
    query: AcceptedSubmissionsQueryType,
  ): Promise<AcceptedSubmissionsResponse>;
}

/** Fail-closed default — every internal seam read 503s until the composition root binds the real provider. */
export const denyStubInternalSeamProvider: M23InternalSeamProvider = {
  async claimDayProjection() {
    throw new WardenXError("SEAM_UNBOUND", "the M23 claim-day-projection provider is not bound", 503);
  },
  async acceptedSubmissionsInWindow() {
    throw new WardenXError("SEAM_UNBOUND", "the M23 claim-submission reader is not bound", 503);
  },
};

export interface InternalSeamRouteDeps {
  /** The §4.3 seam provider; defaults to the fail-closed deny-stub (RULE 4) until the composition root binds. */
  readonly internalSeam?: M23InternalSeamProvider;
}

/** Register the §4.1 internal service-to-service seam routes (#39/#40; system-principal only). */
export function registerInternalSeamRoutes(app: FastifyInstance, deps: InternalSeamRouteDeps = {}): void {
  const provider = deps.internalSeam ?? denyStubInternalSeamProvider;
  const SYSTEM = requireSystemPrincipal();

  // GET /internal/billing/claim-day-projection — per-patient / org day rollups by LOC (M26/M27). §4.1 #39.
  app.get(
    "/api/v1/internal/billing/claim-day-projection",
    { preHandler: [SYSTEM], config: { auditRead: { resourceKind: "claim", list: true } } },
    async (request) => {
      const actor = actorOf(request);
      const query = parse(ClaimDayProjectionQuery, request.query);
      return provider.claimDayProjection(
        { organizationId: tenantOf(actor, query.organizationId), userId: actor.userId },
        query,
      );
    },
  );

  // GET /internal/billing/submissions — accepted submissions in a window (M25 835 matching). §4.1 #40.
  app.get("/api/v1/internal/billing/submissions", { preHandler: [SYSTEM], config: { auditRead: { resourceKind: "claim_submission", list: true } } }, async (request) => {
    const actor = actorOf(request);
    const query = parse(AcceptedSubmissionsQuery, request.query);
    return provider.acceptedSubmissionsInWindow(
      { organizationId: tenantOf(actor, query.organizationId), userId: actor.userId },
      query,
    );
  });
}

/**
 * The tenant these internal seam reads run under — taken from the SERVER-ASSEMBLED request context,
 * never from the caller.
 *
 * These two routes used to pass `query.organizationId` straight through to `withOrgContext`, and the
 * module header described that as the contract ("the calling module names the tenant it is acting
 * for"). That is a cross-tenant read primitive: one system credential could name ANY organization and
 * receive its per-patient billing day-rollups, unaudited. Every sibling internal seam — M25's
 * `/internal/denials/metrics` and `/internal/patient-responsibility`, M15's `/internal/discipline-plans`
 * — binds the org from `actorOf(request)` instead, and so does this now.
 *
 * The wire schema still ACCEPTS `organizationId` (it is required by `ClaimDayProjectionQuery` /
 * `AcceptedSubmissionsQuery`, and changing that is a published-contract break for M25/M26/M27), so a
 * value that disagrees with the caller's own scope is refused rather than silently ignored: silently
 * ignoring it would let a caller believe it had read tenant B while it actually read tenant A.
 *
 * This mattered NOW rather than later because `requireSystemPrincipal()` reads
 * `context.attributes.actorKind`, which nothing assembles — so both routes 403 for everyone today and
 * the hole is latent. Assembling `actorKind` without this fix would switch it on in the same commit.
 *
 * FOLLOW-UP (not done here): these are the only internal seam routes pairing `SYSTEM` with no
 * permission key. M25 pairs it with `P("denial.read_internal")`. M23 contributes no `*.read_internal`
 * key yet, and adding one touches the permission catalog, the role templates and the seed.
 */
function tenantOf(actor: { organizationId: string }, requested: string): string {
  if (requested !== actor.organizationId) {
    throw new ForbiddenError(
      "the requested organization does not match the calling principal's scope",
    );
  }
  return actor.organizationId;
}
