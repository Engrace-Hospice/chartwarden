// apps/backend/src/modules/31-portal/routes/guards.ts — M31-T07 (§4.1 / §4.7) route-guard builders.
//
// The shared `requirePermission` / `requireAbac` / `requireStepUp` preHandler factories every M31 route
// plugin composes (the M19/M20 routes/guards.ts precedent). Each §4.7 predicate resolves its subject facts
// server-side — from the portal SESSION (`portalAccountId` / `sessionPatientId`) or from the telehealth
// visit's own row — never from a caller-supplied org, account or patient claim.
//
// THE PORTAL TARGET IS THE SESSION, NOT THE QUERY. §8.3.1's threat (b) is a caregiver with a valid session
// naming another patient's id; every `portal.*` predicate below takes `portalAccountId` + `patientId` from
// `context.attributes`, so the mismatch is unrepresentable rather than merely refused. Each predicate name
// is a compile-time LITERAL in its own `requireAbac` call so `arch:abac-predicates` still resolves it (the
// gate scans that second argument — a helper that took `names: string[]` would hide them, the exact hole
// that let M30 ship 15 guards on an unregistered predicate).
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import type { PreHandler } from "./actor";

type TargetRequest = { readonly params?: unknown };

const param = (request: TargetRequest, key: string): string =>
  (request.params as Record<string, string> | undefined)?.[key] ?? "";

const sessionAttr = (request: FastifyRequest, key: string): string => {
  const value = request.context?.attributes?.[key];
  return typeof value === "string" ? value : "";
};

/** RBAC gate — `requirePermission(key)` from M3 (the §4.6 key catalog M31 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/** §4.1 — `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate (TOTP / re-auth window). */
export const STEP_UP = (operationKey: string): PreHandler =>
  requireStepUp(operationKey) as PreHandler;

/**
 * §4.7 `portal_grant_active_for_patient` — the per-patient read gate. Account + patient both from the
 * SESSION; deny is 403 (the portal never discloses whether an id exists, §8.3.1 fixes the answer at 403).
 */
export const ABAC_GRANT = (action: string): PreHandler =>
  requireAbac(action, "portal_grant_active_for_patient", {
    getTarget: ((r: FastifyRequest) => ({
      portalAccountId: sessionAttr(r, "portalAccountId"),
      patientId: sessionAttr(r, "sessionPatientId"),
    })) as never,
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.7 `portal_account_active` — the account is a live one. Account id from the SESSION. */
export const ABAC_ACCOUNT = (action: string): PreHandler =>
  requireAbac(action, "portal_account_active", {
    getTarget: ((r: FastifyRequest) => ({
      portalAccountId: sessionAttr(r, "portalAccountId"),
    })) as never,
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.7 `portal_caregiver_is_primary_or_dpoa` — the caregiver-attested-administration write gate. */
export const ABAC_CAREGIVER_ATTEST = (action: string): PreHandler =>
  requireAbac(action, "portal_caregiver_is_primary_or_dpoa", {
    getTarget: ((r: FastifyRequest) => ({
      portalAccountId: sessionAttr(r, "portalAccountId"),
      patientId: sessionAttr(r, "sessionPatientId"),
    })) as never,
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.7 `bereaved_portal_window_open` — the bereavement surface gate (13-month window). */
export const ABAC_BEREAVED = (action: string): PreHandler =>
  requireAbac(action, "bereaved_portal_window_open", {
    getTarget: ((r: FastifyRequest) => ({
      portalAccountId: sessionAttr(r, "portalAccountId"),
      patientId: sessionAttr(r, "sessionPatientId"),
    })) as never,
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.7 `telehealth_consent_active` — the join gate; patient resolved from the visit's own row. */
export const ABAC_TELEHEALTH_CONSENT = (action: string, idParam = "visitId"): PreHandler =>
  requireAbac(action, "telehealth_consent_active", {
    getTarget: ((r: TargetRequest & FastifyRequest) => ({
      telehealthVisitId: param(r, idParam),
      // GAP-094: the SESSION's patient, so a portal caller can never pass for another patient's visit.
      sessionPatientId: sessionAttr(r, "sessionPatientId"),
    })) as never,
    notFoundOnDeny: false,
  }) as PreHandler;

/** §4.7 / D9 `state_two_party_recording_consent_present` — the Record button gate. */
export const ABAC_RECORDING_STATE = (action: string, idParam = "visitId"): PreHandler =>
  requireAbac(action, "state_two_party_recording_consent_present", {
    getTarget: ((r: TargetRequest) => ({ telehealthVisitId: param(r, idParam) })) as never,
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * The ORG-SCOPED staff cells — M3's intrinsic `inOrg` (the M20 `org_scope ≡ inOrg` decision).
 *
 * The staff telehealth + invitation + account routes carry `caseload_membership` as their §4.6 catalog
 * DEFAULT (the intended per-patient narrowing), but the route binds `inOrg` because `caseload_membership`
 * has no live producer today — no module registers it (it is catalog metadata only), and binding an
 * unregistered name would be a permanently-dead 403 endpoint AND fail `arch:abac-predicates`. `inOrg` is
 * the honest floor: the route is org-scoped and RLS is the row-level control, exactly as the M20 org-scope
 * cells resolve. When M5/M17 register `caseload_membership`, these rows tighten to it with no route rename.
 */
export const ABAC_IN_ORG = (action: string): PreHandler =>
  requireAbac(action, "inOrg", { getTarget: () => ({}), notFoundOnDeny: false }) as PreHandler;
