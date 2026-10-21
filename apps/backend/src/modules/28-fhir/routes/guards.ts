// apps/backend/src/modules/28-fhir/routes/guards.ts — M28-T08 (§4.1 / §4.7) route-guard builders.
//
// The shared `requirePermission` / `requireAbac` / `requireStepUp` preHandler factories every M28 admin
// route plugin composes (the M32/M15/M16/M19/M20/M21 routes/guards.ts precedent). Every §4.7 predicate
// resolves its subject facts server-side from the route's PATH PARAM or the SESSION — never from a
// caller-supplied org or actor claim.
//
// Each ABAC name below is a COMPILE-TIME STRING LITERAL passed straight to `requireAbac`, so
// `arch:abac-predicates` sees it (the gate scans for the literal second argument; a `names: string[]`
// loop would make every name invisible — the M30 finding it was built for).
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";

import type { PreHandler } from "./actor";

type TargetRequest = {
  readonly params?: unknown;
  readonly body?: unknown;
  readonly query?: unknown;
};

const param = (request: TargetRequest, key: string): string =>
  (request.params as Record<string, string> | undefined)?.[key] ?? "";

/** RBAC gate — `requirePermission(key)` from M3 (the §4.6 key catalog M28 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/** §4.1 R39 — `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate. */
export const STEP_UP = (operationKey: string): PreHandler =>
  requireStepUp(operationKey) as PreHandler;

/**
 * §4.1's baseline cell — `wardenx.organization.member`, which IS M3's intrinsic `inOrg`.
 *
 * Bound explicitly so "this route is org-scoped" is a DECLARED fact rather than an absence (the M20/M32
 * rule-5 precedent — M28 registers no second name for M3's intrinsic org-scope rule).
 */
export const ABAC_IN_ORG = (action: string): PreHandler =>
  requireAbac(action, "inOrg", { getTarget: () => ({}), notFoundOnDeny: false }) as PreHandler;

/**
 * §4.1 R25-R30 — a per-client admin route: `fhir_client_organization_scope`, 404 on deny.
 *
 * A `fhir_client` id is 1:1 with a named external integration in ONE agency; a denied cross-tenant probe
 * answers 404 so the registry stays unenumerable (§8.2).
 */
export const ABAC_CLIENT_ORG = (action: string, idParam = "id"): PreHandler =>
  requireAbac(action, "fhir_client_organization_scope", {
    getTarget: (r) => ({ clientId: param(r as TargetRequest, idParam) }),
    notFoundOnDeny: true,
  }) as PreHandler;

/**
 * §4.1 R35/R36 — accept/reject a staged proposal: `fhir_inbound_owner_module_match`, 404 on deny.
 *
 * The predicate resolves the proposal's owner module and checks the reviewer holds THAT module's native
 * write permission (D8). A reviewer who lacks it gets a 404, not a 403 — a staged proposal in a module the
 * caller cannot write is not theirs to know exists.
 */
export const ABAC_INBOUND_OWNER_MATCH = (action: string, idParam = "id"): PreHandler =>
  requireAbac(action, "fhir_inbound_owner_module_match", {
    getTarget: (r) => ({ proposalId: param(r as TargetRequest, idParam) }),
    notFoundOnDeny: true,
  }) as PreHandler;

/**
 * §4.1 R33 — cancel a bulk-export job: `bulk_export_initiator_or_admin`, 404 on deny.
 *
 * The predicate ORs the initiator, the bearer client, and a cancel-permitted operator INSIDE itself, so
 * this is a single `requireAbac` — the disjunction lives where the row read happens once.
 */
export const ABAC_BULK_EXPORT_CANCEL = (action: string, idParam = "id"): PreHandler =>
  requireAbac(action, "bulk_export_initiator_or_admin", {
    getTarget: (r) => ({ jobId: param(r as TargetRequest, idParam) }),
    notFoundOnDeny: true,
  }) as PreHandler;
