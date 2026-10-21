// apps/backend/src/modules/29-external-interfaces/routes/guards.ts — M29-T08 (§4.1/§4.2/§4.8) route guards.
//
// The shared `requirePermission` / `requireAbac` / `requireStepUp` preHandler factories every M29 route
// composes (the M28/M32/M20 routes/guards.ts precedent). Every §4.8 predicate resolves its subject facts
// server-side from the route's PATH PARAM or the SESSION — never from a caller-supplied org or actor claim.
//
// Each ABAC name below is a COMPILE-TIME STRING LITERAL passed straight to `requireAbac`, so
// `arch:abac-predicates` sees it (the gate scans for the literal second argument; a `names: string[]` loop
// would make every name invisible — the M30 finding it was built for).
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

type TargetRequest = {
  readonly params?: unknown;
  readonly body?: unknown;
  readonly query?: unknown;
};

const param = (request: TargetRequest, key: string): string =>
  (request.params as Record<string, string> | undefined)?.[key] ?? "";

/** RBAC gate — `requirePermission(key)` from M3 (the §4.7 key catalog M29 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/** §4.1 (D18) — `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate. */
export const STEP_UP = (operationKey: string): PreHandler =>
  requireStepUp(operationKey) as PreHandler;

/**
 * §4.1/§4.2's baseline cell — `wardenx.organization.member`, which IS M3's intrinsic `inOrg`.
 *
 * Bound explicitly so "this route is org-scoped" is a DECLARED fact rather than an absence (the M20/M28
 * rule-5 precedent — M29 registers no second name for M3's intrinsic org-scope rule).
 */
export const ABAC_IN_ORG = (action: string): PreHandler =>
  requireAbac(action, "inOrg", { getTarget: () => ({}), notFoundOnDeny: false }) as PreHandler;

/**
 * §4.1.1 — a per-feed admin route: `external_feed_organization_scope`, 404 on deny.
 *
 * A feed id is 1:1 with a named partner integration in ONE agency; a denied cross-tenant probe answers 404
 * so the registry stays unenumerable (§8.2).
 */
export const ABAC_FEED_ORG = (action: string, idParam = "feedId"): PreHandler =>
  requireAbac(action, "external_feed_organization_scope", {
    getTarget: (r) => ({ feedId: param(r as TargetRequest, idParam) }),
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.1.1 / D16 — activate a feed: `external_feed_baa_satisfied`, 403 on deny (the feed IS visible). */
export const ABAC_FEED_BAA = (action: string, idParam = "feedId"): PreHandler =>
  requireAbac(action, "external_feed_baa_satisfied", {
    getTarget: (r) => ({ feedId: param(r as TargetRequest, idParam) }),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * §4.1.1 / D20 — revoke a feed: `external_feed_compliance_co_approver_distinct`, 403 on deny.
 *
 * The co-approver must differ from the first approver, which the predicate reads from the STORED feed row
 * (GAP-153) — never from the request body; the store re-checks the same stored value in its own transaction.
 */
export const ABAC_FEED_CO_APPROVER = (action: string): PreHandler =>
  requireAbac(action, "external_feed_compliance_co_approver_distinct", {
    getTarget: (r) => ({ feedId: param(r as TargetRequest, "feedId") }),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * §4.1.2 / D5 — accept/reject an ADT proposal: `hl7_inbound_proposal_owner_module_match`, 404 on deny.
 *
 * The predicate resolves the proposal's owner module and checks the reviewer holds THAT module's native
 * write permission. A reviewer who lacks it gets a 404, not a 403 — a proposal in a module the caller
 * cannot write is not theirs to know exists.
 */
export const ABAC_PROPOSAL_OWNER = (action: string, idParam = "proposalId"): PreHandler =>
  requireAbac(action, "hl7_inbound_proposal_owner_module_match", {
    getTarget: (r) => ({ proposalId: param(r as TargetRequest, idParam) }),
    notFoundOnDeny: true,
  }) as PreHandler;

/**
 * §4.2 — a caseload-scoped lab route: `lab_observation_patient_caseload_or_scope`, 404 on deny.
 *
 * The predicate ORs "patient in the actor's caseload" and "actor holds a wide-scope role" INSIDE itself, so
 * this is a single `requireAbac`. A caller with neither gets a 404 — a lab result for a patient off their
 * caseload is not theirs to know exists.
 */
export const ABAC_LAB_CASELOAD = (action: string, idParam = "observationId"): PreHandler =>
  requireAbac(action, "lab_observation_patient_caseload_or_scope", {
    getTarget: (r) => ({ observationId: param(r as TargetRequest, idParam) }),
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.1.4 / W-XI-12 — trigger a platform NPPES sync: `nppes_platform_job_caller`, 403 on deny. */
export const ABAC_NPPES_PLATFORM = (action: string): PreHandler =>
  requireAbac(action, "nppes_platform_job_caller", {
    getTarget: () => ({}),
    notFoundOnDeny: false,
  }) as PreHandler;
