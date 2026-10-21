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
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
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
 * GAP-093 §4.1 — the auditor-engagement gate. The engagement id comes from the ROUTE (what the auditor
 * asks for) and the SESSION's own engagement from `context.attributes.engagementId` (server-stamped);
 * `portal_engagement_scope` requires an auditor session on an ACTIVE engagement that is the one named.
 * Not break-glass-satisfiable: an emergency PHI grant is not an engagement.
 */
export const ABAC_ENGAGEMENT_SCOPE = (action: string, idParam = "engagementId"): PreHandler =>
  requireAbac(action, "portal_engagement_scope", {
    getTarget: ((r: TargetRequest & FastifyRequest) => ({
      engagementId: param(r, idParam),
      sessionEngagementId: sessionAttr(r, "engagementId"),
    })) as never,
    notFoundOnDeny: false,
    breakGlassBypassable: false,
  }) as PreHandler;

/**
 * The ORG-SCOPED staff cells — M3's intrinsic `inOrg` (the M20 `org_scope ≡ inOrg` decision).
 *
 * Used where NO patient is nameable from the request: the org-wide rosters, the account lifecycle
 * (suspend / reinstate — an account is not one patient's), the invitation list/revoke stubs, and the
 * telehealth admin reads. RLS is the row-level control there. The per-patient staff surfaces do NOT use
 * it: the telehealth join/leave/record/end routes are scoped to the visit's patient
 * (`./staff-visit-scope`) and the invitation issue / invite-bereaved routes to the invited patient
 * (`./invitation-scope`), both via `caseload_or_scope` semantics (M5 registers `CaseloadProvider`, M7 the
 * shared predicate — the earlier "no live producer" premise was false, GAP-093).
 */
export const ABAC_IN_ORG = (action: string): PreHandler =>
  requireAbac(action, "inOrg", { getTarget: () => ({}), notFoundOnDeny: false }) as PreHandler;
