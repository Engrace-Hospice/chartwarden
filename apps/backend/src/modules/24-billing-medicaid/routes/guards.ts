// apps/backend/src/modules/24-billing-medicaid/routes/guards.ts — M24 (§4.7 / §4.8) route-guard builders.
//
// The shared `requirePermission` / `requireAbac` / `requireStepUp` preHandler factories every M24 route
// plugin composes (the M23/M26 routes/guards.ts precedent). The §4.8 predicates resolve their facts
// server-side from the route's path param / body field (mapped onto the ABAC target). The §D12 step-up gate
// composes on submit / replace / void / arrangement activate-terminate / override / credential upsert (the
// operation key is the permission key so M3 resolves the per-op freshness policy).
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import { type PreHandler } from "./actor";

type TargetRequest = { readonly params?: unknown; readonly body?: unknown; readonly query?: unknown };

const param = (request: TargetRequest, key: string): string =>
  (request.params as Record<string, string> | undefined)?.[key] ?? "";
const bodyField = (request: TargetRequest, key: string): string => {
  const v = (request.body as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" ? v : "";
};
const queryField = (request: TargetRequest, key: string): string => {
  const v = (request.query as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" ? v : "";
};

/** RBAC gate — `requirePermission(key)` from M3 (the §4.7 key catalog M24 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/** §4.8 ABAC over the route's `:id` claim (resolver loads the claim's PE + patient, fail-closed). */
export const ABAC_CLAIM = (key: string, predicate: string): PreHandler =>
  requireAbac(key, predicate, {
    getTarget: (r) => ({ medicaidClaimId: param(r, "id") }),
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.8 ABAC over the route's `:id` R&B arrangement. */
export const ABAC_ARRANGEMENT = (key: string, predicate: string): PreHandler =>
  requireAbac(key, predicate, {
    getTarget: (r) => ({ rbArrangementId: param(r, "id") }),
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.8 ABAC over the route's `:id` validation result (override-role eligibility). */
export const ABAC_RESULT = (key: string, predicate: string): PreHandler =>
  requireAbac(key, predicate, {
    getTarget: (r) => ({ medicaidValidationResultId: param(r, "id") }),
    notFoundOnDeny: true,
  }) as PreHandler;

/** §4.8 ABAC over the route's `:ruleKey` rule-config (regulatory-protection). */
export const ABAC_RULE = (key: string, predicate: string): PreHandler =>
  requireAbac(key, predicate, {
    getTarget: (r) => ({ ruleKey: param(r, "ruleKey") }),
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.8 ABAC over the `providerEntityId` carried in the request body (assemble / eligibility / credential). */
export const ABAC_BODY_PE = (key: string, predicate: string): PreHandler =>
  requireAbac(key, predicate, {
    getTarget: (r) => ({ providerEntityId: bodyField(r, "providerEntityId") }),
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.8 ABAC over the `providerEntityId` carried in the query string (list / dashboard / metrics). */
export const ABAC_QUERY_PE = (key: string, predicate: string): PreHandler =>
  requireAbac(key, predicate, {
    getTarget: (r) => ({ providerEntityId: queryField(r, "providerEntityId") }),
    notFoundOnDeny: false,
  }) as PreHandler;

/** §D12 step-up gate — `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate. */
export const STEP_UP = (operationKey: string): PreHandler => requireStepUp(operationKey) as PreHandler;
